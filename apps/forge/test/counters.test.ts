import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { atMinimum, COUNTER_MINIMUMS, gate, PUBLIC_ROW_MINIMUMS, reached, type CounterKey } from "../src/services/counters";
import { getDb } from "../src/services/db";
import { publicCounts } from "../src/services/forge";
import { countsAsHouse } from "../src/services/identity";
import { day } from "../src/services/proof";
import { gatedProofStrip, proofStrip } from "../src/services/proof-strip";
import { mcpCounters, recordMcp, usageStats } from "../src/services/usage";
import { proofStripList } from "../src/web/proof-strip";
import { connectAgent, fetchWorker, fp, postReport, report } from "./helpers";
import "../src/index";

// ADR 0023 §3: no public zeros; counters hidden below their minimums; House and test activity never counted as usage.

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const clearStrip = () => env.KV.delete("proof-strip:v2");
const text = async (h: unknown) => String(await h);
const init = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } } });
const mcpPost = (body: unknown) => new Request("https://x/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** Every number a JSON twin shows is null exactly when it's listed as below its minimum, and never 0. */
function expectGated(o: Record<string, unknown> & { below_minimum: string[]; minimums: Record<string, number> }) {
  for (const [k, min] of Object.entries(o.minimums)) {
    expect(COUNTER_MINIMUMS[k as CounterKey]).toBe(min);
    if (o.below_minimum.includes(k)) expect(o[k], k).toBeNull();
    else expect(o[k] as number, k).toBeGreaterThanOrEqual(min);
  }
}

async function insertOutsideHumans(n: number) {
  const db = getDb(env);
  for (let i = 0; i < n; i++)
    await db.insert(t.humans).values({ id: uid("h"), githubId: 900_000_000 + Math.floor(Math.random() * 99_999_999), githubLogin: uid("outside"), githubCreatedAt: 0, tier: "sandbox" });
}

async function makeHouse(humanId: string) {
  await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, humanId));
}

describe("the minimums table (ADR 0023 §3)", () => {
  it("has the ADR's minimums, and every minimum is above zero so a zero never shows", () => {
    expect(COUNTER_MINIMUMS.tools_checked).toBe(25);
    expect(COUNTER_MINIMUMS.bouts).toBe(10);
    expect(COUNTER_MINIMUMS.agents).toBe(10);
    expect(COUNTER_MINIMUMS.reports).toBe(10);
    expect(COUNTER_MINIMUMS.mcp_sessions).toBe(25);
    expect(COUNTER_MINIMUMS.trap_card_copies).toBe(25);
    for (const k of Object.keys(COUNTER_MINIMUMS) as CounterKey[]) {
      expect(COUNTER_MINIMUMS[k]).toBeGreaterThan(0);
      expect(reached(k, 0)).toBe(false);
      expect(atMinimum(k, COUNTER_MINIMUMS[k] - 1)).toBeNull();
      expect(atMinimum(k, COUNTER_MINIMUMS[k])).toBe(COUNTER_MINIMUMS[k]);
    }
  });

  it("JSON twins get null plus a below_minimum list, never the small number", () => {
    const g = gate({ bouts: 9, tools_checked: 25, agents: 0 });
    expect(g).toEqual({ bouts: null, tools_checked: 25, agents: null, below_minimum: ["bouts", "agents"], minimums: { bouts: 10, tools_checked: 25, agents: 10 } });
  });
});

describe("the proof strip", () => {
  it("leaves out each item below its minimum, and the whole strip when nothing has reached one", async () => {
    expect(proofStripList(gate({ bouts: 0, models: 0, traps_sprung: 0, tools_checked: 0 }))).toBeNull();
    expect(proofStripList(gate({ bouts: 9, models: 4, traps_sprung: 9, tools_checked: 24 }))).toBeNull();
    const html = await text(proofStripList(gate({ bouts: 12, models: 2, traps_sprung: 10, tools_checked: 24 }), { links: true }));
    expect(html).toContain('<a href="/arena"><b>12</b> ranked bouts refereed</a>');
    expect(html).toContain("<b>10</b> traps sprung in ranked bouts");
    expect(html).not.toContain("models ranked");
    expect(html).not.toContain("tools checked");
    expect(html).not.toMatch(/<b>0<\/b>/);
  });

  it("counts refereed headline bouts only (practice and dry runs are tests) and shows them from 10", async () => {
    const db = getDb(env);
    await clearStrip();
    const before = (await proofStrip(env)).bouts;
    const run = (eventId: string, i: number) => ({ id: uid("run"), eventId, modelId: "test/model", task: "counter-test", seed: i, attemptNo: 1, status: "done" as const, result: { traps: [{ triggered: true }] } });
    const practice = uid("ev");
    await db.insert(t.arenaEvents).values({ id: practice, slug: practice, name: "Dry run", season: "s1", kind: "practice", status: "done" });
    for (let i = 0; i < 12; i++) await db.insert(t.arenaRuns).values(run(practice, i));
    await clearStrip();
    expect((await proofStrip(env)).bouts).toBe(before);
    expect((await gatedProofStrip(env)).bouts).toBe(atMinimum("bouts", before));

    const card = uid("ev");
    await db.insert(t.arenaEvents).values({ id: card, slug: card, name: "Card", season: "s1", kind: "card", status: "done" });
    const add = Math.max(1, COUNTER_MINIMUMS.bouts - before);
    for (let i = 0; i < add; i++) await db.insert(t.arenaRuns).values(run(card, i));
    await clearStrip();
    const g = await gatedProofStrip(env);
    expect(g.bouts).toBe(before + add);
    expect(g.bouts).toBeGreaterThanOrEqual(10);
    expectGated(g);
  });

  it("shows tools checked from 25 distinct tools", async () => {
    const db = getDb(env);
    await clearStrip();
    const before = (await proofStrip(env)).tools_checked;
    if (before < COUNTER_MINIMUMS.tools_checked) expect((await gatedProofStrip(env)).tools_checked).toBeNull();
    for (let i = 0; i < Math.max(1, COUNTER_MINIMUMS.tools_checked - before); i++) {
      const id = uid("tool");
      await db.insert(t.tools).values({ id, kind: "mcp_server", canonicalId: `npm:${id}` });
      await db.insert(t.toolChecks).values({ toolId: id, day: day(Date.now()), n: 1 });
    }
    await clearStrip();
    expect((await gatedProofStrip(env)).tools_checked).toBeGreaterThanOrEqual(25);
  });

  it("the home page and its JSON twin never show a number below its minimum", async () => {
    const page = await (await fetchWorker(`/?u=${uid("x")}`)).text();
    expect(page).not.toMatch(/<b>0<\/b>/);
    const json = (await (await fetchWorker(`/?format=json&u=${uid("x")}`)).json()) as { third_party: unknown[]; stats: Parameters<typeof expectGated>[0] & { totals: { items: { value: number | null }[] } } };
    // ADR 0067 Amendment 1: the outside-only headline is internal (an empty array here); totals are never a zero.
    expect(json.third_party).toEqual([]);
    for (const i of json.stats.totals.items) expect(i.value === null || i.value > 0).toBe(true);
    expectGated(json.stats);
  });
});

describe("House and our own testing are never counted as usage", () => {
  it("a House account's agent and reports don't change the public counts; someone outside does", async () => {
    const house = await connectAgent();
    await makeHouse(house.human.id);
    const before = await publicCounts(env);
    expect((await postReport(house.token, report({ tool: { kind: "skill", id: "github.com/house/only", version: "1", fingerprint: fp("7") } }))).status).toBe(201);
    const afterHouse = await publicCounts(env);
    expect(afterHouse).toMatchObject({ humans: before.humans, agents: before.agents, reports: before.reports, tool_versions_reported: before.tool_versions_reported });

    const outside = await connectAgent();
    expect((await postReport(outside.token, report({ tool: { kind: "skill", id: "github.com/outside/one", version: "1", fingerprint: fp("8") } }))).status).toBe(201);
    const afterOutside = await publicCounts(env);
    expect(afterOutside.humans).toBe(before.humans + 1);
    expect(afterOutside.reports).toBe(before.reports + 1);
  });

  it("the founder's own account counts as House, like House accounts", () => {
    const e = { ADMIN_GITHUB_IDS: "42, 7" } as unknown as Pick<Env, "ADMIN_GITHUB_IDS">;
    expect(countsAsHouse(e, { isHouse: false, githubId: 42 })).toBe(true);
    expect(countsAsHouse(e, { isHouse: true, githubId: 1 })).toBe(true);
    expect(countsAsHouse(e, { isHouse: false, githubId: 1 })).toBe(false);
  });

  it("/api/v1/stats shows no outside-only number (F-02): those fields are null, and the gross twins include ours", async () => {
    const s = (await (await fetchWorker("/api/v1/stats")).json()) as Parameters<typeof expectGated>[0] & { house_excluded: boolean; tools: number; gross: { includes_own_test_agents: boolean } };
    expect(s.house_excluded).toBe(false);
    for (const k of ["humans", "verified_humans", "agents", "reports", "reports_last_24h", "tool_versions_reported"]) expect(s[k], k).toBeNull();
    expect(s.gross.includes_own_test_agents).toBe(true);
    expect(typeof s.tools).toBe("number"); // a registry fact (tools with a page), not usage
    expectGated(s);
  });

  it("signed-in MCP sessions from our own accounts are counted apart and never in the totals or app lists", async () => {
    expect(mcpCounters("house", init("claude-ai"))).toEqual(["mcp:house:sessions"]);
    expect(mcpCounters("house", { method: "tools/call", params: { name: "forge_check" } })).toEqual(["mcp:house:calls"]);
    const at = Date.UTC(2031, 0, 5, 12);
    for (let i = 0; i < 30; i++) await recordMcp(env, "house", mcpPost(init("house-client")), at);
    await recordMcp(env, "signed_in", mcpPost(init("cursor")), at);
    const u = await usageStats(env, at);
    expect(u.mcp_sessions).toBe(1);
    expect(u.house_mcp_sessions).toBe(30);
    expect(u.top_clients.map((c) => c.name)).toEqual(["cursor"]);
  });
});

describe("/stats", () => {
  it("has no zeros, keeps House on its own line and shows a number once it reaches its minimum", async () => {
    const house = await connectAgent();
    await makeHouse(house.human.id);
    await postReport(house.token, report({ tool: { kind: "skill", id: "github.com/house/stats", version: "1", fingerprint: fp("9") } }));
    const db = getDb(env);
    const today = day(Date.now());
    for (let i = 0; i < 12; i++) await db.insert(t.checkSources).values({ day: today, source: uid("house-src"), kind: "api", isHouse: true });

    // F-02 (ADR 0082): the outside-only counters, gated as before, are internal now (/admin).
    const { outsideStatsData } = await import("../src/web/stats");
    const json = await outsideStatsData(env);
    for (const [k, v] of Object.entries(json.now)) {
      expect(v.below_minimum, k).toBe(v.external === null);
      if (v.external !== null) expect(v.external).toBeGreaterThanOrEqual(v.minimum);
    }
    expect(json.now.reports!.house).toBeGreaterThan(0);
    expect(json.now.check_sources!.house).toBeGreaterThanOrEqual(12);
    if (json.usage) expect(json.usage.mcp_sessions === null).toBe(json.usage.below_minimum.includes("mcp_sessions"));

    // /stats: gross numbers only, no zeros, no House-only line (a gross number minus a House number is the outside one).
    const page = await (await fetchWorker(`/stats?u=${uid("x")}`)).text();
    expect(page).not.toMatch(/<(b|td class="num")>0<\//);
    expect(page).not.toContain('id="house"');
    // ADR 0099: the gross row appears once it passes its minimum (50 people, our own included).
    const n = Number((await env.DB.prepare("SELECT count(*) AS n FROM humans").first<{ n: number }>())!.n);
    await insertOutsideHumans(Math.max(0, PUBLIC_ROW_MINIMUMS.signed_in_people - n));
    const all = Number((await env.DB.prepare("SELECT count(*) AS n FROM humans").first<{ n: number }>())!.n);
    const after = await (await fetchWorker(`/stats?u=${uid("x")}`)).text();
    expect(after).not.toContain("<td>People signed in</td>");
    expect(after).toMatch(new RegExp(`<tr data-k="signed_in_people"><td>[^<]*</td><td class="num">${all.toLocaleString("en-US")}</td>`));
  });

  it("/connect never shows today's outside-only check count (F-02); /admin has it", async () => {
    const db = getDb(env);
    const today = day(Date.now());
    const outside = async () =>
      (await db.select().from(t.checkSources).where(eq(t.checkSources.day, today))).filter((r) => !r.isHouse).length;
    for (let i = 0; i < 15; i++) await db.insert(t.checkSources).values({ day: today, source: uid("house-src"), kind: "web", isHouse: true });
    const ext = await outside();
    const page = await (await fetchWorker(`/connect?u=${uid("x")}`)).text();
    expect(page).not.toContain("checked a tool today");
    for (let i = ext; i < COUNTER_MINIMUMS.check_sources; i++) await db.insert(t.checkSources).values({ day: today, source: uid("src"), kind: "web" });
    const shown = await (await fetchWorker(`/connect?u=${uid("x")}`)).text();
    expect(shown).not.toContain("checked a tool today");
    const { connectChecksToday } = await import("../src/web/connect");
    expect(await connectChecksToday(env)).toBe(await outside());
  });
});
