import { env } from "cloudflare:workers";
import { Attempt, taskById, trapEntry, wilsonInterval, type AttemptResult, type EndReason } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { arenaResults, EVENT_CSV_HEADER, eventData } from "../src/arena/results";
import { trapsData } from "../src/arena/traps";
import { publicEvent } from "../src/arena/views";
import * as t from "../src/db/schema";
import { PUBLIC_INSTRUCTIONS, PUBLIC_TOOLS } from "../src/mcp-public";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// Crucible 2: Hard for agents and crawlers: arena_results and forge_traps take a tier (and arena_results an event),
// and a ranked event's attempts are published at /arena/events/<slug>.json and .csv. Embargoed models (ADR 0041) and
// events held for review (status "planned") never show in any of them.

const ORIGIN = env.PUBLIC_ORIGIN;
const RANKED = "crucible-results-test";
const HELD = "crucible-results-held";
const PRACTICE = "practice-results-test";
const SONNET = "claude-sonnet-5.5";
const GPT = "gpt-6.1-sol";
const EMB = EMBARGOED.id;
const SEED = 1_000_011;
const ids: Record<string, string> = {};
const host = new URL(ORIGIN).host;

function attempt(task: string, outcome: "pass" | "fell" | EndReason) {
  const a = new Attempt(taskById(task)!, SEED);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  if (outcome === "pass" || outcome === "fell") a.call("finish", { status: "done", summary: "done" });
  const base = a.end(outcome === "pass" || outcome === "fell" ? "finished" : outcome);
  const trap = base.traps[0]!.id;
  const result = { ...base, passed: outcome === "pass", traps: base.traps.map((x) => ({ ...x, triggered: outcome === "fell" && x.id === trap })) } as AttemptResult;
  return { result, log: a.log };
}

async function event(slug: string, kind: "card" | "practice", status: "planned" | "done") {
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id, slug, name: slug, season: "s0", kind, status });
  return id;
}

async function run(key: string, eventId: string, model: string, task: string, attemptNo: number, outcome: "pass" | "fell" | EndReason, ago: number) {
  const r = attempt(task, outcome);
  const id = crypto.randomUUID();
  ids[key] = id;
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task, seed: SEED, attemptNo, status: "done", passed: r.result.passed, score: 0.5, cost: 0.1, tokens: 1000,
    result: r.result, log: r.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) }), finishedAt: Date.now() - ago,
  });
}

beforeAll(async () => {
  const ranked = await event(RANKED, "card", "done");
  const held = await event(HELD, "card", "planned");
  const practice = await event(PRACTICE, "practice", "done");
  // Hard v3 refund: Sonnet 2 of 3 (the fail fell for a trap), GPT 3 of 3. GPT is knocked out once on the scam invoice.
  await run("s1", ranked, SONNET, "refund-hard3", 1, "pass", 60_000);
  await run("s2", ranked, SONNET, "refund-hard3", 2, "fell", 50_000);
  await run("s3", ranked, SONNET, "refund-hard3", 3, "pass", 40_000);
  for (const n of [1, 2, 3]) await run(`g${n}`, ranked, GPT, "refund-hard3", n, "pass", 30_000 + n);
  await run("gko", ranked, GPT, "scam-invoice-hard3", 1, "knockout_turns", 20_000);
  // One Normal job in the same event, for the tier filter.
  await run("sn", ranked, SONNET, "refund", 1, "pass", 10_000);
  // Embargoed: run and stored, never shown.
  await run("embargoed", ranked, EMB, "refund-hard3", 1, "fell", 15_000);
  // Held for review: never shown, nor its job.
  await run("held", held, SONNET, "weekend-hard3", 1, "fell", 5_000);
  await run("practice", practice, SONNET, "refund-hard3", 1, "pass", 1_000);
});

const rpc = async (name: string, args: Record<string, unknown>) => {
  const res = await fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const body = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  return { text, isError: !!body.result?.isError, data: body.result?.structuredContent };
};

const hidden = (text: string) => {
  expect(text).not.toMatch(SHOWS_EMBARGOED);
  expect(text).not.toContain(ids.held);
  expect(text).not.toContain(HELD);
};

describe("Wilson interval (K3 helper, reused)", () => {
  it("gives the 95% bounds for small samples", () => {
    const [lo2, hi2] = wilsonInterval(2, 3);
    expect(lo2).toBeCloseTo(0.2077, 3);
    expect(hi2).toBeCloseTo(0.9385, 3);
    expect(wilsonInterval(3, 3)[0]).toBeCloseTo(0.4385, 3);
    expect(wilsonInterval(3, 3)[1]).toBe(1);
    expect(wilsonInterval(0, 3)).toEqual([0, expect.closeTo(0.5615, 3)]);
  });
});

describe("arena_results by tier and event", () => {
  it("defaults to the Normal card, so existing callers are unchanged", async () => {
    const r = await arenaResults(getDb(env), {}, ORIGIN);
    expect(r.tier).toBe("normal");
    expect(r.tasks.map((x) => x.task)).toEqual(["refund", "scam-invoice", "weekend", "spreadsheet", "flaky-supplier", "impossible"]);
    expect(r.tasks.every((x) => x.tier === "normal")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("-hard3");
  });

  it("gives Hard results per job and model: passes, interval, 3-of-3, traps, knockouts, replays, versions and dates", async () => {
    const r = await arenaResults(getDb(env), { tier: "hard" }, ORIGIN);
    expect(r).toMatchObject({ data_kind: "headline", tier: "hard", event: null });
    expect(r.tasks.every((x) => x.tier === "hard")).toBe(true);
    expect(r.rules_versions.length).toBeGreaterThan(0);
    expect(r.since).toMatch(/^\d{4}-\d\d-\d\d$/);
    const refund = r.tasks.find((x) => x.task === "refund-hard3")!;
    expect(refund.title).toBeTruthy();
    const sonnet = refund.models.find((m) => m.model === SONNET)!;
    expect(sonnet).toMatchObject({ runs: 3, passes: 2, ci_95: wilsonInterval(2, 3), consistency: { all_right: 0, versions: 1, reliable: 0 }, knockouts: 0 });
    expect(sonnet.traps_fell).toHaveLength(1);
    expect(sonnet.traps_fell[0]).toMatchObject({ id: expect.stringMatching(/^FA-[A-Z]{3}-\d{3}$/), n: 1 });
    // The latest fail, then the latest pass, as absolute links.
    expect(sonnet.replays).toEqual([`${ORIGIN}/arena/run/${ids.s2}`, `${ORIGIN}/arena/run/${ids.s3}`]);
    const gpt = refund.models.find((m) => m.model === GPT)!;
    expect(gpt).toMatchObject({ runs: 3, passes: 3, ci_95: wilsonInterval(3, 3), consistency: { all_right: 1, versions: 1, reliable: 1 }, traps_fell: [] });
    expect(gpt.replays).toHaveLength(2);
    expect(r.tasks.find((x) => x.task === "scam-invoice-hard3")!.models.find((m) => m.model === GPT)).toMatchObject({ knockouts: 1, passes: 0 });
    // Practice runs don't mix into headline results.
    expect(JSON.stringify(r)).not.toContain(ids.practice);
    hidden(JSON.stringify(r));
    expect(r.tasks.map((x) => x.task)).not.toContain("weekend-hard3");
  });

  it("an event gives every tier of that event, or one tier when asked", async () => {
    const db = getDb(env);
    const ev = await publicEvent(db, RANKED);
    const all = await arenaResults(db, { event: ev }, ORIGIN);
    expect(all.tier).toBe("all");
    expect(all.event).toMatchObject({ slug: RANKED, url: `${ORIGIN}/arena/event/${RANKED}`, data_url: `${ORIGIN}/arena/events/${RANKED}.json` });
    expect(all.tasks.map((x) => x.task)).toEqual(["refund", "refund-hard3", "scam-invoice-hard3"]);
    expect((await arenaResults(db, { event: ev, tier: "normal" }, ORIGIN)).tasks.map((x) => x.task)).toEqual(["refund"]);
    expect((await arenaResults(db, { event: ev, tier: "hard" }, ORIGIN)).tasks.map((x) => x.task)).toEqual(["refund-hard3", "scam-invoice-hard3"]);
    // A Hard task id sets its own tier.
    expect((await arenaResults(db, { task: "refund-hard3" }, ORIGIN)).tier).toBe("hard");
    hidden(JSON.stringify(all));
  });

  it("over MCP: tier and event work, embargoed models never show, and a held event reads as unknown", async () => {
    const hard = await rpc("arena_results", { tier: "hard" });
    expect(hard.isError).toBe(false);
    expect(hard.data.tasks.map((x: { task: string }) => x.task)).toContain("refund-hard3");
    hidden(hard.text);
    const ev = await rpc("arena_results", { event: RANKED });
    expect(ev.data.event.slug).toBe(RANKED);
    hidden(ev.text);
    const held = await rpc("arena_results", { event: HELD });
    expect(held.isError).toBe(true);
    expect(held.data).toMatchObject({ error: "unknown_event", event: HELD });
    expect(held.data.ranked_events).toContain(RANKED);
    expect(held.data.ranked_events).not.toContain(HELD);
    const missing = await rpc("arena_results", { event: "no-such-event" });
    expect(missing.data.error).toBe("unknown_event");
    // Existing callers: no arguments still gives the Normal card.
    expect((await rpc("arena_results", {})).data.tier).toBe("normal");
  });
});

describe("forge_traps by tier", () => {
  it("gives Hard trap rates when asked, Normal by default, with no embargoed or held runs", async () => {
    const db = getDb(env);
    const normal = await trapsData(db, {});
    expect(normal.tier).toBe("normal");
    expect(normal.tasks.every((x) => !x.task.includes("hard"))).toBe(true);
    const hard = await trapsData(db, { tier: "hard" });
    expect(hard).toMatchObject({ tier: "hard", data_kind: "headline" });
    const refund = hard.tasks.find((x) => x.task === "refund-hard3")!;
    const sprung = refund.traps.filter((x) => x.fell > 0);
    // Sonnet's one fall; the embargoed model's fall isn't counted.
    expect(sprung).toHaveLength(1);
    expect(sprung[0]).toMatchObject({ attempts: 6, fell: 1, public_id: expect.stringMatching(/^FA-/) });
    expect(hard.tasks.map((x) => x.task)).not.toContain("weekend-hard3");
    // Hard traps are named in the catalogue's own words, as on the failure board's JSON twin.
    for (const x of hard.tasks) for (const tr of x.traps) if (tr.public_id) expect(tr.name).toBe(trapEntry(tr.public_id)!.description);
    expect((await trapsData(db, { tier: "hard", model: EMB })).data_kind).toBe("none");
    const mcp = await rpc("forge_traps", { tier: "hard" });
    expect(mcp.data.tier).toBe("hard");
    hidden(mcp.text);
  });
});

describe("/arena/events/<slug>.json and .csv", () => {
  it("lists each attempt: model, task, attempt, passed, reason, traps fallen, knockout, replay, rules version and dates", async () => {
    const res = await fetchWorker(`/arena/events/${RANKED}.json`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const d = JSON.parse(text) as NonNullable<Awaited<ReturnType<typeof eventData>>>;
    expect(d.event).toMatchObject({ slug: RANKED, kind: "card", csv: `${ORIGIN}/arena/events/${RANKED}.csv` });
    expect(d.licence).toMatch(/attribution/);
    expect(d.attempts).toBe(8);
    expect(d.models).toEqual([SONNET, GPT].sort());
    const s2 = d.runs.find((r) => r.run === ids.s2)!;
    expect(s2).toEqual({
      run: ids.s2, model: SONNET, model_name: "Claude Sonnet 5.5", task: "refund-hard3", tier: "hard", seed: SEED, attempt: 2, passed: false, reason: "finished",
      traps_fell: [expect.stringMatching(/^FA-/)], knockout: false, replay_url: `${ORIGIN}/arena/run/${ids.s2}`,
      rules_version: expect.stringMatching(/^rules /), task_version: expect.any(String),
      // ADR 0088: both rules readings; not re-scored here, so scored under = played under.
      scored_under: expect.stringMatching(/^rules /), played_under: expect.stringMatching(/^rules /), rescored_from_signed_logs: false, finished_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      // ADR 0053: where the record came from and its licence.
      provenance: expect.objectContaining({ source: "house_bout", licence: "evaluation-only", model: expect.objectContaining({ exact: "anthropic/claude-sonnet-5.5" }) }),
    });
    expect(d.runs.find((r) => r.run === ids.gko)).toMatchObject({ knockout: true, reason: "knockout_turns", passed: false });
    // Ordered by job (Normal first), then model and attempt.
    expect(d.runs[0]!.task).toBe("refund");
    // No logs and no model output: only the referee's verdict per attempt.
    expect(text).not.toMatch(/"log"|"text"|"summary"|"brief"/);
    hidden(text);
  });

  it("has a CSV twin with the same rows", async () => {
    const res = await fetchWorker(`/arena/events/${RANKED}.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe(EVENT_CSV_HEADER);
    expect(lines).toHaveLength(9);
    const row = lines.find((l) => l.includes(ids.s2!))!.split(",");
    const col = (k: string) => row[EVENT_CSV_HEADER.split(",").indexOf(k)];
    expect(col("passed")).toBe("false");
    expect(col("traps_fell")).toMatch(/^FA-/);
    expect(col("replay_url")).toBe(`${ORIGIN}/arena/run/${ids.s2}`);
    hidden(lines.join("\n"));
  });

  it("404s for an event held for review, one that isn't ranked, an unknown one and other extensions", async () => {
    for (const path of [`/arena/events/${HELD}.json`, `/arena/events/${HELD}.csv`, `/arena/events/${PRACTICE}.json`, `/arena/events/${PRACTICE}.csv`, "/arena/events/nope.json", `/arena/events/${RANKED}.xml`, `/arena/events/${RANKED}`])
      expect((await fetchWorker(path)).status, path).toBe(404);
  });

  it("the dataset lists ranked events with their files, and the event page carries schema.org Dataset markup", async () => {
    const ds = (await (await fetchWorker("/arena/dataset.json")).json()) as { events: { slug: string; json: string; csv: string }[] };
    expect(ds.events.find((e) => e.slug === RANKED)).toMatchObject({ json: `/arena/events/${RANKED}.json`, csv: `/arena/events/${RANKED}.csv` });
    expect(ds.events.map((e) => e.slug)).not.toContain(HELD);
    expect(ds.events.map((e) => e.slug)).not.toContain(PRACTICE);
    const page = await (await fetchWorker(`/arena/event/${RANKED}`, { headers: { Accept: "text/html" } })).text();
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)![1]!);
    expect(ld).toMatchObject({ "@type": "Dataset", url: `${ORIGIN}/arena/event/${RANKED}`, license: { name: expect.stringMatching(/attribution/) } });
    expect(ld.name).toContain(RANKED);
    expect(ld.description.length).toBeGreaterThan(50);
    expect(Date.parse(ld.dateModified)).toBeGreaterThan(0);
    expect(ld.distribution.map((x: { contentUrl: string; encodingFormat: string }) => [x.encodingFormat, x.contentUrl])).toEqual([
      ["application/json", `${ORIGIN}/arena/events/${RANKED}.json`],
      ["text/csv", `${ORIGIN}/arena/events/${RANKED}.csv`],
    ]);
    hidden(page);
    // Practice events get no Dataset markup (they have no event files).
    expect(await (await fetchWorker(`/arena/event/${PRACTICE}`, { headers: { Accept: "text/html" } })).text()).not.toContain('"Dataset"');
  });

  it("llms.txt names the event files, in ASCII", async () => {
    const txt = await (await fetchWorker("/llms.txt")).text();
    const line = txt.split("\n").find((l) => l.includes("/arena/events/<slug>.json"))!;
    expect(line).toBeTruthy();
    expect(line).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("what agents read", () => {
  it("descriptions name the new inputs and stay within the wording rules", () => {
    for (const k of ["arena_results", "forge_traps"] as const) {
      const d = PUBLIC_TOOLS[k].description;
      expect(d).toMatch(/^Use this when /);
      expect(d).toContain("tier (normal, the default, or hard)");
      expect(d.length).toBeLessThanOrEqual(420);
      expect(AGENT_DIRECTED.exec(d)?.[0] ?? null).toBeNull();
    }
    expect(PUBLIC_TOOLS.arena_results.description).toContain("crucible-2-hard");
    expect(PUBLIC_INSTRUCTIONS.length).toBeLessThanOrEqual(1200);
  });
});
