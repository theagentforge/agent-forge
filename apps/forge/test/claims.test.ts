import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acceptLlmAnswer,
  checkBody,
  compareValue,
  extractClaims,
  extractNumbers,
  findNumber,
  GENESIS,
  impliedComparator,
  parseNumber,
  readPath,
  rowHash,
  verifyChain,
} from "../src/services/claims-core";
import {
  appendCheck,
  chainStatus,
  CLAIMS_JSON_PATH,
  CLAIMS_LLM_FALLBACK,
  CLAIMS_LLM_MODEL,
  CLAIMS_PATH,
  checkClaim,
  type ClaimRow,
  claimsTransport,
  ensureSeed,
  llmModelFor,
  runClaimChecks,
} from "../src/services/claims";
import { PRIVATE_HEADERS } from "../src/services/data-room";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, ORIGIN, profile } from "./helpers";
import "../src/index";

// ADR 0120: the claim verifier. Four verdicts; fail-closed on errors and timeouts; the append-only, hash-chained log;
// the LLM quote-match rule; the tolerance rules for live counters.

const ctx = createExecutionContext();
const offline = claimsTransport.fetch;
afterEach(() => {
  claimsTransport.fetch = offline;
});
const serve = (status: number, body: string) => {
  claimsTransport.fetch = (async () => new Response(body, { status })) as typeof claimsTransport.fetch;
};

const claim = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  id: "T1",
  text: "Downloads were 468 on 26 Oct",
  url: "https://api.example.test/downloads",
  anchor_kind: "json",
  anchor_path: "downloads[day=2026-10-26].downloads",
  expected: "468",
  comparator: "eq",
  tolerance: null,
  counter: false,
  author: "claude",
  author_model: "claude-opus",
  appears_in: "email:2026-10-29",
  made_at: Date.parse("2026-10-29T00:00:00Z"),
  retired_at: null,
  ...over,
});
const NPM = JSON.stringify({ downloads: [{ day: "2026-10-26", downloads: 468 }, { day: "2026-10-27", downloads: 28 }], as_of: "2026-10-29T11:00:00Z" });

describe("tolerance rules and paths (core)", () => {
  it("parses numbers as people write them", () => {
    expect(parseNumber("10,633")).toBe(10633);
    expect(parseNumber("57k")).toBe(57000);
    expect(parseNumber("1.2M")).toBe(1_200_000);
    expect(parseNumber("29.5%")).toBe(29.5);
    expect(parseNumber("about")).toBeNull();
  });
  it("reads a.b, list[*].x and list[key=value].x", () => {
    const d = { a: { b: 3 }, v: [{ k: "frozen" }, { k: "reconstructed" }], dl: [{ day: "x", n: 1 }] };
    expect(readPath(d, "a.b").values).toEqual([3]);
    expect(readPath(d, "v[*].k").values).toEqual(["frozen", "reconstructed"]);
    expect(readPath(d, "dl[day=x].n").values).toEqual([1]);
    expect(readPath(d, "a.c").found).toBe(false);
  });
  it("eq on a counter: a higher live value is stale, a lower one is a mismatch", () => {
    expect(compareValue({ kind: "json", expected: "9946", comparator: "eq", counter: true }, 10633)).toEqual({ ok: false, reason: "stale_value" });
    expect(compareValue({ kind: "json", expected: "9946", comparator: "eq", counter: true }, 9000)).toEqual({ ok: false, reason: "value_mismatch" });
    expect(compareValue({ kind: "json", expected: "9946", comparator: "eq", counter: false }, 10633)).toEqual({ ok: false, reason: "value_mismatch" });
  });
  it("'at least N' passes as the counter grows; 'about N' allows 5% unless told otherwise", () => {
    expect(compareValue({ kind: "json", expected: "9946", comparator: "gte" }, 10633).ok).toBe(true);
    expect(compareValue({ kind: "json", expected: "9946", comparator: "gte" }, 9945).ok).toBe(false);
    expect(compareValue({ kind: "json", expected: "57000", comparator: "approx" }, 10633)).toEqual({ ok: false, reason: "value_mismatch" });
    expect(compareValue({ kind: "json", expected: "57000", comparator: "approx" }, 55000).ok).toBe(true);
    expect(compareValue({ kind: "json", expected: "57000", comparator: "approx", tolerance: 0.01 }, 55000).ok).toBe(false);
    expect(compareValue({ kind: "json", expected: "100", comparator: "eq", tolerance: 0.02 }, 101)).toEqual({ ok: true, reason: "within_tolerance" });
  });
});

describe("the four verdicts", () => {
  it("SUPPORTED, with the exact quoted value, the response hash and the source's as-of time", async () => {
    serve(200, NPM);
    const [r] = await checkClaim(env, ctx, claim());
    expect(r).toMatchObject({ verdict: "SUPPORTED", reason: "exact", quote: '"downloads":468', observed_value: "468", via: "network", http_status: 200, observed_as_of: "2026-10-29T11:00:00Z", checker: "det" });
    expect(NPM.slice(r!.quote_offset!, r!.quote_offset! + r!.quote!.length)).toBe(r!.quote);
    expect(r!.response_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("CONTRADICTED: the spike was not on 27 Oct", async () => {
    serve(200, NPM);
    const [r] = await checkClaim(env, ctx, claim({ anchor_path: "downloads[day=2026-10-27].downloads", comparator: "gte" }));
    expect(r).toMatchObject({ verdict: "CONTRADICTED", reason: "value_mismatch", observed_value: "28" });
  });
  it("CONTRADICTED with all_eq: one version reconstructed, not frozen", () => {
    const o = checkBody({ kind: "json", path: "versions[*].kind", expected: "frozen", comparator: "all_eq" }, 200, JSON.stringify({ versions: [{ kind: "reconstructed" }, { kind: "frozen" }] }));
    expect(o).toMatchObject({ verdict: "CONTRADICTED", quote: '"kind":"reconstructed"' });
  });
  it("NOT_PRESENT: the field isn't there, or the phrase isn't on the page", async () => {
    serve(200, NPM);
    expect((await checkClaim(env, ctx, claim({ anchor_path: "downloads[day=2026-10-25].downloads" })))[0]).toMatchObject({ verdict: "NOT_PRESENT", reason: "path_absent" });
    const page = `<html><body><p>${"Every night we start the 500 most-downloaded servers. ".repeat(6)}</p></body></html>`;
    serve(200, page);
    expect((await checkClaim(env, ctx, claim({ anchor_kind: "text", expected: "every no-setup server nightly" })))[0]).toMatchObject({ verdict: "NOT_PRESENT", reason: "phrase_absent" });
    expect((await checkClaim(env, ctx, claim({ anchor_kind: "text", expected: "start the 500 most-downloaded" })))[0]).toMatchObject({ verdict: "SUPPORTED", reason: "phrase_found", quote: "start the 500 most-downloaded" });
  });
  it("UNREACHABLE (fail closed): 5xx, 404, a redirect, an empty page, not JSON, a thrown fetch", async () => {
    for (const [status, body, reason] of [
      [503, NPM, "http_503"],
      [500, "", "http_500"],
      [404, "not found", "http_404"],
      [302, "", "http_302"],
      [200, "   ", "empty_page"],
      [200, "<html>login</html>", "not_json"],
    ] as const) {
      serve(status, body);
      expect((await checkClaim(env, ctx, claim()))[0], reason).toMatchObject({ verdict: "UNREACHABLE", reason, quote: null });
    }
    claimsTransport.fetch = (async () => {
      throw new Error("network down");
    }) as typeof claimsTransport.fetch;
    expect((await checkClaim(env, ctx, claim()))[0]!.verdict).toBe("UNREACHABLE");
  });
  it("UNREACHABLE on a timeout, never a guess", async () => {
    claimsTransport.fetch = (() => new Promise<Response>(() => {})) as typeof claimsTransport.fetch;
    const [r] = await checkClaim(env, ctx, claim(), Date.now(), 50);
    expect(r).toMatchObject({ verdict: "UNREACHABLE", reason: "timeout", response_sha256: null });
  });
  it("a short text page is empty (UNREACHABLE), not NOT_PRESENT", async () => {
    serve(200, "<html><script>app()</script></html>");
    expect((await checkClaim(env, ctx, claim({ anchor_kind: "text", expected: "anything" })))[0]).toMatchObject({ verdict: "UNREACHABLE", reason: "empty_page" });
  });
});

describe("own-site sources", () => {
  it("our own JSON is read from the Worker's data function, not the network", async () => {
    claimsTransport.fetch = (async () => {
      throw new Error("must not fetch");
    }) as typeof claimsTransport.fetch;
    const [r] = await checkClaim(env, ctx, claim({ url: "/dataset.json", anchor_path: "contents.trap_set.traps", expected: "1", comparator: "gte" }));
    expect(r).toMatchObject({ verdict: "SUPPORTED", via: "data_fn", reason: "at_least" });
  });
  it("other pages on this site are read in-process (a text phrase on /dataset)", async () => {
    const [r] = await checkClaim(env, ctx, claim({ url: "/dataset", anchor_kind: "text", anchor_path: null, expected: "scored by a referee from the sandbox's end state and call log" }));
    expect(r).toMatchObject({ verdict: "SUPPORTED", via: "in_process", http_status: 200 });
  });
  it("a missing page on this site is UNREACHABLE", async () => {
    const [r] = await checkClaim(env, ctx, claim({ url: "/no-such-page-for-claims", anchor_kind: "text", expected: "x" }));
    expect(r).toMatchObject({ verdict: "UNREACHABLE", reason: "http_404", via: "in_process" });
  });
});

describe("the LLM pass: off by default, different family, quotes checked word for word", () => {
  const page = `<html><body><p>${"Filler about the dataset. ".repeat(10)}40 records (19 with replay format v2, 21 with replay format v1).</p></body></html>`;
  const fakeAi = (answer: unknown) => ({ run: async () => ({ response: answer, usage: { prompt_tokens: 500, completion_tokens: 40 } }) }) as unknown as Ai;
  const prose = claim({ anchor_kind: "none", anchor_path: null, expected: null, comparator: null, text: "Every refereed run is signed" });

  it("off: no LLM row; the prose claim is NOT_PRESENT (no anchor)", async () => {
    serve(200, page);
    const rows = await checkClaim({ ...env, AI: fakeAi({ verdict: "supported", quote: "40 records" }) } as Env, ctx, prose);
    expect(rows.map((r) => r.checker)).toEqual(["det"]);
    expect(rows[0]).toMatchObject({ verdict: "NOT_PRESENT", reason: "no_anchor" });
  });
  it("on: a verbatim quote stands; a paraphrased quote is NOT_PRESENT whatever the model said", async () => {
    serve(200, page);
    const ok = await checkClaim({ ...env, CLAIMS_LLM: "on", AI: fakeAi({ verdict: "contradicted", quote: "21 with replay format v1" }) } as Env, ctx, prose);
    expect(ok[1]).toMatchObject({ checker: `llm:${CLAIMS_LLM_MODEL}`, verdict: "CONTRADICTED", quote: "21 with replay format v1" });
    const bad = await checkClaim({ ...env, CLAIMS_LLM: "on", AI: fakeAi({ verdict: "supported", quote: "every run has an Ed25519 signature" }) } as Env, ctx, prose);
    expect(bad[1]).toMatchObject({ verdict: "NOT_PRESENT", reason: "quote_not_verbatim" });
  });
  it("never upgrades UNREACHABLE: the model isn't asked when the page can't be read", async () => {
    serve(503, page);
    const rows = await checkClaim({ ...env, CLAIMS_LLM: "on", AI: fakeAi({ verdict: "supported", quote: "21 with replay format v1" }) } as Env, ctx, prose);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("UNREACHABLE");
  });
  it("quote rule in code: verbatim only, and not a bare fragment", () => {
    expect(acceptLlmAnswer({ verdict: "supported", quote: "21 with replay  format v1" }, page).verdict).toBe("SUPPORTED");
    expect(acceptLlmAnswer({ verdict: "supported", quote: "40" }, page)).toMatchObject({ verdict: "NOT_PRESENT", reason: "quote_not_verbatim" });
    expect(acceptLlmAnswer({ verdict: "supported" }, page)).toMatchObject({ verdict: "NOT_PRESENT", reason: "quote_not_verbatim" });
    expect(acceptLlmAnswer({ verdict: "unreachable", quote: "21 with replay format v1" }, page).verdict).toBe("NOT_PRESENT");
  });
  it("a different family from the author", () => {
    expect(llmModelFor("claude-opus")).toBe(CLAIMS_LLM_MODEL);
    expect(llmModelFor("qwen3-30b")).toBe(CLAIMS_LLM_FALLBACK);
  });
});

describe("the log: append-only and hash-chained", () => {
  it("each check appends one row; the database refuses UPDATE and DELETE; the chain verifies", async () => {
    serve(200, NPM);
    const before = (await chainStatus(env)).rows;
    await env.DB.prepare("INSERT OR IGNORE INTO claims (id, text, url, anchor_kind, anchor_path, expected, comparator, author, appears_in, made_at) VALUES ('LOG1', 'x', 'https://api.example.test/d', 'json', 'downloads[day=2026-10-26].downloads', '468', 'eq', 'claude', 'test', 0)").run();
    const r = await runClaimChecks(env, ctx, { trigger: "api", ids: ["LOG1"] });
    expect(r.rows).toHaveLength(1);
    expect(r.counts.SUPPORTED).toBe(1);
    const c = await chainStatus(env);
    expect(c.rows).toBe(before + 1);
    expect(c.ok).toBe(true);
    await expect(env.DB.prepare("UPDATE claim_checks SET verdict = 'SUPPORTED'").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM claim_checks").run()).rejects.toThrow(/append-only/);
    expect((await chainStatus(env)).rows).toBe(before + 1);
  });
  it("the first row links to genesis; each next row to the one before", async () => {
    const row = { claim_id: "LOG2", run_id: "r", trigger: "api", checked_at: 1, fetched_url: "u", via: "network", http_status: 200, response_sha256: null, verdict: "SUPPORTED" as const, reason: "exact", quote: null, quote_offset: null, observed_value: null, observed_as_of: null, checker: "det" };
    const a = await appendCheck(env, row);
    const b = await appendCheck(env, { ...row, checked_at: 2 });
    expect(b.prev_hash).toBe(a.row_hash);
    expect(b.row_hash).toBe(await rowHash(a.row_hash, { ...row, checked_at: 2, prev_hash: a.row_hash }));
  });
  it("two appends at once don't fork the chain", async () => {
    const row = { claim_id: "LOG3", run_id: "r", trigger: "api", checked_at: 3, fetched_url: "u", via: "network", http_status: 200, response_sha256: null, verdict: "SUPPORTED" as const, reason: "exact", quote: null, quote_offset: null, observed_value: null, observed_as_of: null, checker: "det" };
    await Promise.all([appendCheck(env, row), appendCheck(env, { ...row, checked_at: 4 }), appendCheck(env, { ...row, checked_at: 5 })]);
    expect((await chainStatus(env)).ok).toBe(true);
  });
  it("any edit to a stored row breaks the chain (verifyChain)", async () => {
    const r1 = { a: 1, prev_hash: GENESIS };
    const h1 = await rowHash(GENESIS, r1);
    const r2 = { a: 2, prev_hash: h1 };
    const rows = [{ ...r1, row_hash: h1 }, { ...r2, row_hash: await rowHash(h1, r2) }];
    expect(await verifyChain(rows)).toEqual({ ok: true, broken_at: null });
    expect(await verifyChain([rows[0]!, { ...rows[1]!, a: 3 }])).toEqual({ ok: false, broken_at: 1 });
  });
  it("claims are never edited or deleted; retiring is once only", async () => {
    await ensureSeed(env, [{ id: "SEED1", text: "t", url: "/stats.json", anchor_kind: "json", anchor_path: "x", expected: "1", comparator: "eq", author: "claude", appears_in: "test", made_at: "2026-10-29T00:00:00Z" }]);
    await expect(env.DB.prepare("UPDATE claims SET text = 'changed' WHERE id = 'SEED1'").run()).rejects.toThrow(/never edited/);
    await expect(env.DB.prepare("DELETE FROM claims WHERE id = 'SEED1'").run()).rejects.toThrow(/never deleted/);
    await ensureSeed(env, [{ id: "SEED1", text: "t2", url: "/stats.json", anchor_kind: "json", author: "claude", appears_in: "test", made_at: "2026-10-29T00:00:00Z", retired_at: "2026-10-30T00:00:00Z" }]);
    const row = await env.DB.prepare("SELECT text, retired_at FROM claims WHERE id = 'SEED1'").first<{ text: string; retired_at: number }>();
    expect(row).toEqual({ text: "t", retired_at: Date.parse("2026-10-30T00:00:00Z") });
    await expect(env.DB.prepare("UPDATE claims SET retired_at = NULL WHERE id = 'SEED1'").run()).rejects.toThrow(/stays retired/);
  });
});

describe("the brief gate's extraction", () => {
  it("keeps claim numbers and drops dates, times, versions, ADR numbers, hashes and URLs", () => {
    const s = "On 29 Oct at 11:09 UTC, /stats.json showed 10,633 skills (CLI 0.6.0, ADR 0113, Lab #4, sha af38c75b, 2026-10-29) and about 57k tools, 29.5%.";
    expect(extractNumbers(s).map((n) => n.raw)).toEqual(["10,633", "57k", "29.5%"]);
  });
  it("splits a draft into sentences with numbers and their URLs", () => {
    const c = extractClaims("Hello Don.\n\nWe scanned 10,633 skills (https://theagentforge.io/stats.json). No number here.\n- 41 traps in 9 kinds, /dataset.json");
    expect(c.map((x) => x.numbers.map((n) => n.value))).toEqual([[10633], [41, 9]]);
    expect(c[0]!.urls).toEqual(["https://theagentforge.io/stats.json"]);
    expect(c[1]!.urls).toEqual(["/dataset.json"]);
  });
  it("reads the comparator from the wording", () => {
    const s = "at least 9,946 skills, about 57,000, under 10";
    expect(impliedComparator(s, s.indexOf("9,946"))).toBe("gte");
    expect(impliedComparator(s, s.indexOf("57,000"))).toBe("approx");
    expect(impliedComparator(s, s.indexOf("10"))).toBe("lte");
  });
  it("finds the field paths that hold a number", () => {
    expect(findNumber({ a: { b: 41 }, c: [1, 41] }, 41)).toEqual(["a.b", "c[1]"]);
  });
});

describe("/admin/claims: founder-only, no-store", () => {
  let adminCookie = "";
  let userCookie = "";
  const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
  beforeAll(async () => {
    const db = getDb(env);
    const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
    adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
    const someone = await upsertHuman(db, profile(), Date.now());
    userCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, someone.id)}`;
  });
  it("redirects or refuses everyone else; the JSON twin too", async () => {
    expect((await fetchWorker(CLAIMS_PATH, { redirect: "manual" })).status).toBe(302);
    expect((await fetchWorker(CLAIMS_PATH, { headers: { Cookie: userCookie }, redirect: "manual" })).status).toBe(302);
    expect((await fetchWorker(CLAIMS_JSON_PATH, { headers: { Cookie: userCookie } })).status).toBe(403);
    expect((await fetchWorker(CLAIMS_JSON_PATH)).status).toBe(403);
  });
  it("shows a founder the page and JSON with private headers; Check now appends to the log", async () => {
    const res = await fetchWorker(CLAIMS_PATH, { headers: { Cookie: adminCookie, Accept: "text/html" } });
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) expect(res.headers.get(k)).toBe(v);
    const page = await res.text();
    expect(page).toContain("Check now");
    const before = (await chainStatus(env)).rows;
    const post = (cookie: string, csrf: string) =>
      fetchWorker(`${CLAIMS_PATH}/check`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect((await post(adminCookie, "wrong")).status).toBe(403);
    expect((await post(userCookie, "x")).status).toBe(403);
    const ran = await post(adminCookie, csrfOf(page));
    expect(ran.status).toBe(303);
    expect(ran.headers.get("Location")).toMatch(/^\/admin\/claims\?ran=/);
    const after = await chainStatus(env);
    expect(after.ok).toBe(true);
    expect(after.rows).toBeGreaterThan(before);
    const j = await fetchWorker(CLAIMS_JSON_PATH, { headers: { Cookie: adminCookie } });
    expect(j.headers.get("Cache-Control")).toBe(PRIVATE_HEADERS["Cache-Control"]);
    const d = (await j.json()) as { chain: { ok: boolean }; llm_pass: string; log: unknown[] };
    expect(d.chain.ok).toBe(true);
    expect(d.llm_pass).toBe("off");
    expect(d.log.length).toBeGreaterThan(0);
  });
});
