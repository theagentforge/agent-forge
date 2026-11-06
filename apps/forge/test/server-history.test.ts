import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { REQUEST_TOOLS } from "../src/mcp-requests";
import { etagMatches } from "../src/server-history-api";
import { getDb, newId } from "../src/services/db";
import { HISTORY_CONTRACT, HISTORY_CONTRACT_VERSION, historyUrl, parseQuery, parseServer, serverHistory } from "../src/services/server-history";
import { driftTick } from "../src/services/tool-history";
import fixture from "../../../scripts/examples/history-fixture.json";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0141 (moat audit item 11): GET /api/v1/history/{server}, contract forge.server-history/v1.

const ms = (iso: string) => Date.parse(iso);
const SECRET_TEXT = "Q3-CANARY description text that must never leave the buyer tier";
const SECRET_NAME = "q3_canary_tool_name";
let ipN = 1;
const get = (server: string, query = "", headers: Record<string, string> = {}) =>
  fetchWorker(`/api/v1/history/${encodeURIComponent(server)}${query}`, { headers: { "CF-Connecting-IP": `198.51.100.${ipN++ % 250}`, ...headers } });
type Body = Record<string, any>;

/** A server with rows in all three families, two definition sets (one change) and its drift computed. */
async function seed(pkg: string) {
  const db = getDb(env);
  const server = `npm:${pkg}`;
  const toolId = newId();
  await db.insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: server, createdAt: ms("2026-10-01T00:00:00Z") });
  const house = (family: string, night: string, outcome: string, version: string, origin = "post") =>
    db.insert(t.houseResults).values({ family, night, server, version, outcome, rank: 3, downloads: 100, tools: outcome === "worked" ? 2 : null, ms: 2000, slow: false, probedAt: ms(`${night}T04:00:00Z`), origin });
  await house("top500_nightly", "2026-11-03", "worked", "2.0.0", "kv_copy");
  await house("top500_nightly", "2026-11-04", "worked", "2.0.0");
  await house("top500_nightly", "2026-11-05", "no_answer", "2.1.0");
  await house("weekly_sweep", "2026-11-02", "needs_config", "2.0.0");
  await db.insert(t.toolHistoryServers).values({ server, registry: "npm", package: pkg, toolId, source: "top500_nightly", rank: 3, status: "ok", enumeratedAt: ms("2026-11-05T11:20:00Z"), versionsListed: 4, addedAt: ms("2026-11-05T11:00:00Z") });
  const q = (version: string, published: string, status: string, extra: Partial<typeof t.toolHistoryQueue.$inferInsert> = {}) =>
    db.insert(t.toolHistoryQueue).values({ server, version, publishedAt: ms(published), status, enqueuedAt: ms("2026-11-05T11:20:00Z"), ...extra });
  await q("1.0.0", "2025-10-01T00:00:00Z", "done", { outcome: "worked", observedAt: ms("2026-11-05T11:40:00Z"), toolsCount: 1, descriptionSha256: "a".repeat(64) });
  await q("1.5.0", "2026-01-01T00:00:00Z", "failed", { outcome: "failed", reason: "install_failed", observedAt: ms("2026-11-05T11:41:00Z") });
  await q("2.0.0", "2026-03-01T00:00:00Z", "done", { outcome: "worked", observedAt: ms("2026-11-05T11:42:00Z"), toolsCount: 2, descriptionSha256: "b".repeat(64) });
  await q("2.1.0", "2026-10-30T00:00:00Z", "pending");
  await q("2.1.0-beta.1", "2026-10-20T00:00:00Z", "excluded", { reason: "prerelease" });
  const set = (tools: { name: string; description: string; schema: string | null }[], version: string, sha: string, origin: string, firstSeen: number, observedAt: number) =>
    db.insert(t.toolDescriptionHistory).values({
      id: newId(),
      toolId,
      server,
      version,
      descriptionSha256: sha,
      toolsCount: tools.length,
      descriptionsCount: tools.length,
      verdict: "clear",
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      findings: [{ rule: "R-test", excerpt: SECRET_TEXT }],
      rulesVersion: "test-1",
      toolList: tools,
      firstSeen,
      lastSeen: observedAt,
      observedAt,
      origin,
    });
  const v1 = [{ name: "read", description: "Reads a file.", schema: null }];
  const v2 = [...v1, { name: SECRET_NAME, description: SECRET_TEXT, schema: null }];
  await set(v1, "1.0.0", "a".repeat(64), "backfill", ms("2025-10-01T00:00:00Z"), ms("2026-11-05T11:40:00Z"));
  await set(v2, "2.0.0", "b".repeat(64), "backfill", ms("2026-03-01T00:00:00Z"), ms("2026-11-05T11:42:00Z"));
  await set(v2, "2.0.0", "b".repeat(64), "nightly", ms("2026-11-03T04:00:00Z"), ms("2026-11-03T04:00:00Z"));
  await driftTick(env, ms("2026-11-05T12:00:00Z"), 500);
  return { server, toolId };
}

afterEach(() => vi.restoreAllMocks());

describe("parsing (pure)", () => {
  it("takes npm and PyPI ids without a version, canonicalised; refuses versions and other ids", () => {
    expect(parseServer(" npm:@Scope/Name ")).toMatchObject({ ok: true, id: "npm:@scope/name" });
    expect(parseServer("pypi:MCP_Server.Git")).toMatchObject({ ok: true, id: "pypi:mcp-server-git" });
    for (const bad of ["npm:x@1.2.3", "npm:@s/x@1.0.0", "pypi:x==1.0", "github.com/a/b", "", "https://evil.example"]) expect(parseServer(bad).ok, bad).toBe(false);
    expect(parseQuery({})).toEqual({ ok: true, query: { section: "all", offset: 0, limit: 100 } });
    expect(parseQuery({ section: "changes", offset: "10", limit: "5" })).toEqual({ ok: true, query: { section: "changes", offset: 10, limit: 5 } });
    for (const bad of [{ section: "x" }, { limit: "0" }, { limit: "201" }, { offset: "-1" }, { offset: "5" }, { limit: "1e3" }]) expect(parseQuery(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(historyUrl("https://x.test", "npm:@a/b", { section: "all", offset: 0, limit: 100 })).toBe("https://x.test/api/v1/history/npm%3A%40a%2Fb");
    expect(etagMatches('W/"abc", "def"', '"def"')).toBe(true);
    expect(etagMatches('"abc"', '"def"')).toBe(false);
  });
});

describe("GET /api/v1/history/{server}", () => {
  it("answers the v1 contract: outcomes per family and origin, definitions with publish vs observed dates, change events", async () => {
    const { server } = await seed("@hist-test/shape");
    const res = await get(server);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Forge-Contract")).toBe(HISTORY_CONTRACT);
    const b = (await res.json()) as Body;
    expect(b).toMatchObject({ contract: HISTORY_CONTRACT, contract_version: HISTORY_CONTRACT_VERSION, data_kind: "server_history", server, status: "measured" });
    expect(b.data_as_of).toBe("2026-11-05T12:00:00.000Z");
    expect(b.tool_url).toContain("/t/npm%3A%40hist-test%2Fshape");

    // Families are labelled and counted apart (never added together).
    const io = b.install_outcomes;
    expect(io.families.top500_nightly).toMatchObject({ status: "measured", tested: 3, installed: 2, failed: 1, first_date: "2026-11-03", last_date: "2026-11-05" });
    expect(io.families.top500_nightly.failed_by_class.no_handshake).toBe(1);
    expect(io.families.weekly_sweep).toMatchObject({ tested: 1, installed: 0 });
    expect(io.families.weekly_sweep.failed_by_class.needs_config).toBe(1);
    expect(io.families.backfill).toMatchObject({ tested: 3, installed: 2, pending: 1, excluded_by_reason: { prerelease: 1 } });
    expect(io.families.backfill.failed_by_class.install_failed).toBe(1);
    expect(io.total).toBe(7);
    expect(io).not.toHaveProperty("tested");
    for (const it of io.items) expect(["top500_nightly", "weekly_sweep", "backfill"]).toContain(it.family);
    expect(io.items[0]).toMatchObject({ date: "2026-11-05" });
    const kv = io.items.find((x: Body) => x.date === "2026-11-03");
    expect(kv).toMatchObject({ family: "top500_nightly", origin: "kv_copy", version: "2.0.0", installed: true });
    const bf = io.items.find((x: Body) => x.family === "backfill" && x.version === "1.5.0");
    expect(bf).toMatchObject({ origin: "backfill", outcome: "failed", installed: false, failure_class: "install_failed", published_at: "2026-01-01T00:00:00.000Z", observed_at: "2026-11-05T11:41:00.000Z" });

    // Definitions: the backfill row's first_seen is its publish date; the nightly row keeps its first sighting.
    const d = b.definitions;
    expect(d).toMatchObject({ status: "measured", total: 3, versions: 2, by_origin: { backfill: { sets: 2, versions: 2 }, nightly: { sets: 1, versions: 1 } } });
    const bf2 = d.items.find((x: Body) => x.origin === "backfill" && x.version === "2.0.0");
    expect(bf2).toMatchObject({ description_sha256: "b".repeat(64), tools_count: 2, first_seen: "2026-03-01T00:00:00.000Z", published_at: "2026-03-01T00:00:00.000Z", observed_at: "2026-11-05T11:42:00.000Z" });
    const nightly = d.items.find((x: Body) => x.origin === "nightly");
    expect(nightly).toMatchObject({ first_seen: "2026-11-03T04:00:00.000Z", published_at: "2026-03-01T00:00:00.000Z", observed_at: "2026-11-03T04:00:00.000Z" });

    // Changes: one pair, tool added, no major bump would be 1 -> 2 (a major bump), rule ids only.
    const c = b.changes;
    expect(c).toMatchObject({ status: "measured", pairs: 1, changed: 1, changed_without_major_bump: 0, computed_at: "2026-11-05T12:00:00.000Z" });
    expect(c.items[0]).toMatchObject({ seq: 1, from_version: "1.0.0", to_version: "2.0.0", change_classes: ["tool_added"], tools_added: 1, major_bump: true, zero_major: false, same_version: false, untested_between: 1 });
    expect(Array.isArray(c.items[0].new_rule_ids)).toBe(true);
    expect(c.items[0].new_rule_ids.every((r: unknown) => typeof r === "string")).toBe(true);
    expect(b.notes.counts_never_added_across_families).toBe(true);
  });

  it("never leaks tool text, tool names or matched text (hashes and counts only)", async () => {
    const { server } = await seed("@hist-test/leak");
    const text = await (await get(server)).text();
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain("Reads a file.");
    expect(text).not.toMatch(/"(tool_list|tools|findings|excerpt|description)":/);
    const mcp = JSON.stringify(await rpc("tools/call", { name: "forge_server_history", arguments: { server } }));
    expect(mcp).not.toContain(SECRET_TEXT);
    expect(mcp).not.toContain(SECRET_NAME);
  });

  it("pages each section with next URLs that walk every row exactly once", async () => {
    const { server } = await seed("@hist-test/pages");
    const first = (await (await get(server, "?limit=2")).json()) as Body;
    expect(first.install_outcomes.items).toHaveLength(2);
    expect(first.install_outcomes.next).toContain("section=install_outcomes");
    expect(first.definitions.next).toContain("section=definitions");
    expect(first.changes.next).toBeNull();
    const seen = [...first.install_outcomes.items];
    let next: string | null = first.install_outcomes.next;
    while (next) {
      const u = new URL(next);
      const p = (await (await get(server, u.search)).json()) as Body;
      expect(p).not.toHaveProperty("definitions");
      seen.push(...p.install_outcomes.items);
      next = p.install_outcomes.next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((x) => `${x.family}|${x.date}|${x.version}`)).size).toBe(7);
    expect((await get(server, "?offset=2")).status).toBe(400);
    expect((await get(server, "?limit=999")).status).toBe(400);
  });

  it("an unknown server answers 200 with not_yet_measured everywhere; a bad id is 400", async () => {
    const res = await get("pypi:never-seen-q3-server");
    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    expect(b).toMatchObject({ status: "not_yet_measured", data_as_of: null, tool_url: null });
    expect(b.install_outcomes).toMatchObject({ status: "not_yet_measured", total: 0, items: [], next: null });
    expect(b.install_outcomes.families.top500_nightly.status).toBe("not_yet_measured");
    expect(b.definitions.status).toBe("not_yet_measured");
    expect(b.changes.status).toBe("not_yet_measured");
    const bad = await get("npm:x@1.0.0");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Body).error).toBe("invalid_server");
  });

  it("answers from the canonical id alone, so every spelling (and the cache key) gives the same rows", async () => {
    const db = getDb(env);
    // A row filed under an unnormalised spelling (the House schema allows "_" and "."), with no tool page yet.
    await db.insert(t.houseResults).values({ family: "weekly_sweep", night: "2026-11-01", server: "pypi:q3_odd.name", version: "0.2.0", outcome: "worked", tools: 3, probedAt: ms("2026-11-01T06:00:00Z"), origin: "post", slow: false });
    // Straight from the service (no edge cache in the way): the typed spelling must not change the answer.
    const body = async (s: string) => {
      const p = parseServer(s);
      if (!p.ok) throw new Error(s);
      return JSON.stringify(await serverHistory(env, p, { section: "all", offset: 0, limit: 100 }));
    };
    const typed = await body("pypi:q3_odd.name");
    expect(typed).toBe(await body("pypi:Q3-Odd-Name"));
    expect(JSON.parse(typed).install_outcomes.families.weekly_sweep.status).toBe("not_yet_measured");
    // Once the backfill set ties that spelling to the tool page, every spelling finds it.
    const toolId = newId();
    await db.insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: "pypi:q3-odd-name", createdAt: ms("2026-10-01T00:00:00Z") });
    await db.insert(t.toolHistoryServers).values({ server: "pypi:q3_odd.name", registry: "pypi", package: "q3_odd.name", toolId, source: "weekly_sweep_pypi", rank: 1000, addedAt: ms("2026-11-05T11:00:00Z") });
    for (const s of ["pypi:q3-odd-name", "pypi:Q3_Odd.Name"]) {
      const b = (await (await get(s, "?limit=7")).json()) as Body;
      expect(b.server).toBe("pypi:q3-odd-name");
      expect(b.install_outcomes.families.weekly_sweep, s).toMatchObject({ tested: 1, installed: 1 });
    }
  });

  it("keeps another package on the same tool page out of this server's install outcomes, and labels definition rows", async () => {
    const db = getDb(env);
    const toolId = newId();
    // One MCP Registry entry with an npm and a PyPI package: one tool page, the PyPI id an alias (seed/mcp-registry.ts).
    await db.insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: "npm:@hist-test/both", createdAt: ms("2026-10-01T00:00:00Z") });
    await db.insert(t.toolAliases).values({ alias: "pypi:hist-test-both", toolId });
    for (const server of ["npm:@hist-test/both", "pypi:hist-test-both"])
      await db.insert(t.houseResults).values({ family: "weekly_sweep", night: "2026-11-02", server, version: server.startsWith("npm") ? "3.0.0" : "0.4.0", outcome: server.startsWith("npm") ? "worked" : "no_answer", tools: 1, probedAt: ms("2026-11-02T06:00:00Z"), origin: "post", slow: false });
    await db.insert(t.toolDescriptionHistory).values({ id: newId(), toolId, server: "pypi:hist-test-both", version: "0.4.0", descriptionSha256: "c".repeat(64), toolsCount: 1, descriptionsCount: 1, verdict: "clear", counts: {}, findings: [], rulesVersion: "test-1", toolList: [], firstSeen: ms("2026-11-02T06:00:00Z"), lastSeen: ms("2026-11-02T06:00:00Z"), observedAt: ms("2026-11-02T06:00:00Z"), origin: "nightly" });
    const npm = (await (await get("npm:@hist-test/both")).json()) as Body;
    expect(npm.install_outcomes.families.weekly_sweep).toMatchObject({ tested: 1, installed: 1 });
    expect(npm.install_outcomes.items.map((x: Body) => x.version)).toEqual(["3.0.0"]);
    expect(npm.definitions.items[0]).toMatchObject({ server: "pypi:hist-test-both", version: "0.4.0" });
    const pypi = (await (await get("pypi:hist-test-both")).json()) as Body;
    expect(pypi.install_outcomes.families.weekly_sweep).toMatchObject({ tested: 1, installed: 0 });
    expect(pypi.tool_url).toContain("/t/npm%3A%40hist-test%2Fboth");
  });

  it("is rate limited per address with the shared limiter (429, Retry-After, not cached)", async () => {
    const spy = vi.spyOn(env.CHECK_LIMITER, "limit").mockResolvedValue({ success: false });
    const res = await get("npm:@hist-test/limited");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res.json()) as Body).error).toBe("rate_limited");
    expect(spy.mock.calls[0]![0].key).toMatch(/^history:/);
  });

  it("is edge-cacheable with a strong ETag, and answers If-None-Match with 304", async () => {
    const { server } = await seed("@hist-test/cache");
    const a = await get(server, "?utm_source=x");
    expect(a.headers.get("Cache-Control")).toBe("public, max-age=900");
    const etag = a.headers.get("ETag")!;
    expect(etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
    expect(a.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(a.headers.get("X-Data-As-Of")).toBe("2026-11-05T12:00:00.000Z");
    const body = await a.text();
    await new Promise((r) => setTimeout(r, 50));
    const b = await get(server);
    expect(b.headers.get("ETag")).toBe(etag);
    expect(await b.text()).toBe(body);
    const nm = await get(server, "", { "If-None-Match": etag });
    expect(nm.status).toBe(304);
    expect(nm.headers.get("ETag")).toBe(etag);
    expect(await nm.text()).toBe("");
    expect((await get(server, "", { "If-None-Match": '"sha256-other"' })).status).toBe(200);
  });

  it("matches the sample consumer's fixture field for field (the contract the script is tested against)", async () => {
    const { server } = await seed("@hist-test/fixture");
    const live = (await (await get(server)).json()) as Body;
    const keys = (o: Body | undefined) => Object.keys(o ?? {}).sort();
    const f = fixture as Body;
    expect(f.contract).toBe(live.contract);
    expect(f.contract_version).toBe(live.contract_version);
    expect(keys(f).filter((k) => k !== "_fixture")).toEqual(keys(live));
    for (const s of ["install_outcomes", "definitions", "changes"]) {
      expect(keys(f[s]), s).toEqual(keys(live[s]));
      expect(keys(f[s].items[0]), `${s} item`).toEqual(keys(live[s].items[0]));
    }
    expect(keys(f.install_outcomes.families.top500_nightly)).toEqual(keys(live.install_outcomes.families.top500_nightly));
  });
});

let rpcId = 1;
async function rpc(method: string, params: unknown = {}) {
  const res = await fetchWorker("/mcp/requests", {
    method: "POST",
    headers: { Host: new URL(env.PUBLIC_ORIGIN).host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", "CF-Connecting-IP": "198.51.100.251" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const text = await res.text();
  const body = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as Body;
  if (!body.result) throw new Error(`no result: ${text.slice(0, 200)}`);
  return body;
}

describe("forge_server_history on /mcp/requests", () => {
  it("is listed read only, answers the same contract, and refuses bad ids as data", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((x: Body) => x.name === "forge_server_history");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.description).toBe(REQUEST_TOOLS.forge_server_history.description);
    const { server } = await seed("@hist-test/mcp");
    const r = await rpc("tools/call", { name: "forge_server_history", arguments: { server, section: "changes" } });
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent).toMatchObject({ contract: HISTORY_CONTRACT, server, changes: { pairs: 1 } });
    expect(r.result.structuredContent).not.toHaveProperty("install_outcomes");
    const bad = await rpc("tools/call", { name: "forge_server_history", arguments: { server: "npm:x@1.0.0" } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.structuredContent.error).toBe("invalid_server");
  });

  it("does not touch /mcp/public's pinned tool list", async () => {
    const res = await fetchWorker("/mcp/public", {
      method: "POST",
      headers: { Host: new URL(env.PUBLIC_ORIGIN).host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    expect(text).toContain("forge_check");
    expect(text).not.toContain("forge_server_history");
  });
});

describe("docs page", () => {
  it("documents the contract on /history-api, with a JSON twin", async () => {
    const page = await (await fetchWorker("/history-api")).text();
    expect(page).toContain(HISTORY_CONTRACT);
    expect(page).toContain("scripts/examples/history-consumer.mjs");
    // The page's own text (the site footer carries a "not certification" caveat of its own).
    const prose = page.slice(page.indexOf('<div class="prose">'), page.indexOf("</main>"));
    expect(prose).not.toMatch(/\bsafe\b|certif|malicious/i);
    const j = (await (await fetchWorker("/history-api?format=json")).json()) as Body;
    expect(j).toMatchObject({ contract: HISTORY_CONTRACT, auth: "none", mcp: { tool: "forge_server_history" } });
  });
});
