import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { publicCounts } from "../src/services/forge";
import { internalKey } from "../src/services/internal";
import {
  BELOW_MINIMUM_TEXT,
  BLENDED_RULES,
  gateHeadline,
  HEADLINE_RULES,
  headlineSplits,
  PUBLIC_TOTALS,
  publicTotals,
  THIRD_PARTY_MINIMUM,
  TOTALS_NOTE,
  TRAFFIC_NOTE,
  type HeadlineItem,
  type Split,
} from "../src/services/public-stats";
import { SEEDED_AT } from "../src/services/skill-seed";
import { grossNumbers } from "../src/services/public-stats";
import { PEOPLE_RULES } from "../src/web/stats";
import { bump, CATALOG_SCAN_KEY, mcpCounters } from "../src/services/usage";
import { proofNow } from "../src/services/proof";
import { INSTALL_RULES } from "../src/services/install-metrics";
import { LIVE_AGENT_LABELS, liveAgentCounts, PAGE_VIEWS_BACKFILL } from "../src/services/agent-funnel";
import { WORK_LABELS, workTotals } from "../src/services/site-pulse";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { TRAP_PUBLIC_IDS } from "@forge/arena";
import { PRIVATE_TRAP_CATALOG } from "../../../packages/arena/src/private";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0067 (Boardy items 2 and 16): the third-party split, its "below 10" gate and its SQL (internal since ADR 0067
// Amendment 1, on /admin/kpis). Amendment 1 (Dinike, 28 Oct): public pages and APIs show the totals again, labelled
// as including our own test agents, and every public number is reproducible from /stats/rules.

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const db = () => getDb(env);
const FOUNDER = Number(env.ADMIN_GITHUB_IDS.split(",")[0]);

type Who = "outside" | "house" | "founder";
async function person(who: Who) {
  const humanId = uid("h");
  const githubId = who === "founder" ? FOUNDER : 700_000_000 + Math.floor(Math.random() * 99_999_999);
  // One founder row per test file: reuse it if an earlier test made it.
  if (who === "founder") {
    const [f] = await db().select().from(t.humans).where(eq(t.humans.githubId, FOUNDER));
    if (f) {
      const [a] = await db().select().from(t.agents).where(eq(t.agents.humanId, f.id));
      return { humanId: f.id, agentId: a!.id, handle: a!.handle };
    }
  }
  await db().insert(t.humans).values({ id: humanId, githubId, githubLogin: uid("login"), githubCreatedAt: 0, tier: "verified", isHouse: who === "house" });
  const agentId = uid("a");
  const handle = uid(`${who}-agent`);
  await db().insert(t.agents).values({ id: agentId, humanId, handle, framework: "claude-code", oauthClientId: uid("c") });
  return { humanId, agentId, handle };
}

let toolVersionId: string | null = null;
async function addReport(p: { humanId: string; agentId: string }, over: Partial<typeof t.reports.$inferInsert> = {}) {
  if (!toolVersionId) {
    const toolId = uid("tool");
    await db().insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: `npm:${toolId}` });
    toolVersionId = uid("tv");
    await db().insert(t.toolVersions).values({ id: toolVersionId, toolId, version: "1.0.0", fingerprint: `sha256:${"e".repeat(64)}`, firstSeenAt: Date.now() });
  }
  await db().insert(t.reports).values({ id: uid("r"), agentId: p.agentId, humanId: p.humanId, toolVersionId, taskCategory: "other", framework: "claude-code", outcome: "worked", issues: [], moderationState: "none", serverSignature: "x", createdAt: Date.now(), ...over });
}

async function addLadderBout(p: { humanId: string; agentId: string }, status: "done" | "open" = "done") {
  await db().insert(t.arenaPgAttempts).values({ id: uid("pg"), agentId: p.agentId, humanId: p.humanId, task: "invoice", seed: 1, calls: [], status, startedAt: Date.now(), finishedAt: status === "done" ? Date.now() : null });
}

// One real public trap and one private-family trap (ADR 0057), as a run's `fell` keys ("task/trap").
const [PUBLIC_KEY, PUBLIC_ID] = Object.entries(TRAP_PUBLIC_IDS)[0]!;
// The public mirror's stub has no private families; there the private key is simply one the catalogue doesn't know.
const PRIVATE_ENTRY = PRIVATE_TRAP_CATALOG[0] ?? { id: "FA-XXX-101", traps: ["private-job/private-trap"] };
const PRIVATE_KEY = PRIVATE_ENTRY.traps[0]!;
const SUMMARY = { jobs: [], passed: 4, jobs_total: 6, traps_fell: 2, traps_total: 6, fell: [PUBLIC_KEY, PRIVATE_KEY] };
async function addGauntlet(claim: { humanId: string; agentId: string; hidden?: boolean } | null, status: "done" | "open" = "done") {
  const id = `g${crypto.randomUUID().replace(/-/g, "")}`;
  await db().insert(t.arenaGauntlets).values({ id, status, summary: status === "done" ? SUMMARY : null, startedAt: Date.now() - 1000, finishedAt: status === "done" ? Date.now() : null });
  if (claim) await db().insert(t.gauntletClaims).values({ gauntletId: id, agentId: claim.agentId, humanId: claim.humanId, hidden: claim.hidden ?? false, claimedAt: Date.now() });
  return id;
}

let arenaEventId: string | null = null;
async function addOurArenaBout() {
  if (!arenaEventId) {
    arenaEventId = uid("ev");
    await db().insert(t.arenaEvents).values({ id: arenaEventId, slug: arenaEventId, name: "test", season: "s1", kind: "card", status: "done" });
  }
  await db().insert(t.arenaRuns).values({ id: uid("run"), eventId: arenaEventId, modelId: "test-model", task: "invoice", seed: 1, attemptNo: 1, status: "done" });
}

async function usageKey(key: string) {
  const row = await env.DB.prepare("SELECT coalesce(sum(n), 0) AS n FROM usage_daily WHERE key = ?").bind(key).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

const diff = (a: Record<string, Split>, b: Record<string, Split>) =>
  Object.fromEntries(Object.keys(b).map((k) => [k, { third_party: b[k]!.third_party - a[k]!.third_party, ours: b[k]!.ours - a[k]!.ours, unattributed: (b[k]!.unattributed ?? 0) - (a[k]!.unattributed ?? 0) }]));

describe("own vs third-party split, per headline counter (ADR 0067)", () => {
  it("arena bouts: outside ladder bouts are third-party; House, founder and the Forge's own arena_runs are ours", async () => {
    const before = await headlineSplits(env);
    const out = await person("outside");
    await addLadderBout(out);
    await addLadderBout(out);
    await addLadderBout(out, "open"); // unfinished: not counted anywhere
    await addLadderBout(await person("house"));
    await addLadderBout(await person("founder"));
    await addOurArenaBout();
    const d = diff(before, await headlineSplits(env));
    expect(d.arena_bouts).toEqual({ third_party: 2, ours: 3, unattributed: 0 });
  });

  it("gauntlet runs: claims by outside owners are third-party, House and founder claims ours, unclaimed runs unattributed", async () => {
    const before = await headlineSplits(env);
    const out = await person("outside");
    await addGauntlet(out);
    await addGauntlet({ ...out, hidden: true }); // hidden from pages, still a third-party run in the count
    await addGauntlet(await person("house"));
    await addGauntlet(await person("founder"));
    await addGauntlet(null);
    await addGauntlet(null, "open");
    const d = diff(before, await headlineSplits(env));
    expect(d.gauntlet_runs).toEqual({ third_party: 2, ours: 2, unattributed: 1 });
  });

  it("field reports: readable reports by outside agents only; held and rejected reports never count", async () => {
    const before = await headlineSplits(env);
    const out = await person("outside");
    await addReport(out);
    await addReport(out, { held: true });
    await addReport(out, { moderationState: "rejected" });
    await addReport(await person("house"));
    await addReport(await person("founder"));
    const d = diff(before, await headlineSplits(env));
    expect(d.field_reports).toEqual({ third_party: 1, ours: 2, unattributed: 0 });
  });

  it("skill scans: outside requests are third-party; the launch-scan seed and our tagged callers are ours", async () => {
    const before = await headlineSplits(env);
    const at = Date.now();
    await bump(env, ["scan:web", "scan:api", "scan:mcp", "scan:a2a"], at);
    await bump(env, [internalKey("scout", "scans")], at);
    await db().insert(t.skillScans).values({ fingerprint: `sha256:${uid("seed")}`, verdict: "clear", findings: [], counts: {}, rulesVersion: "1", bytes: 1, firstSeen: SEEDED_AT, lastSeen: SEEDED_AT });
    const d = diff(before, await headlineSplits(env));
    expect(d.skill_scans).toEqual({ third_party: 4, ours: 2, unattributed: 0 });
  });

  it("a web-form scan from one of our tagged callers counts as ours, not as an outside request", async () => {
    const before = await headlineSplits(env);
    const body = new URLSearchParams({ text: "# A harmless skill\nSay hello." });
    const r = await fetchWorker("/scan", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forge-Internal": "screens", "CF-Connecting-IP": "203.0.113.66" } });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    const d = diff(before, await headlineSplits(env));
    expect(d.skill_scans!.third_party).toBe(0);
    expect(d.skill_scans!.ours).toBe(1);
  });

  it("an A2A request from one of our tagged callers counts as ours: no a2a:requests, no scan:a2a (review, 28 Oct)", async () => {
    const send = (headers: Record<string, string>, ip: string) =>
      fetchWorker("/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "data", data: { skill: "scan-skill", text: `# A harmless skill ${uid("a2a")}\nSay hello.` } }] } } }),
      });
    const before = await headlineSplits(env);
    const a2aBefore = await usageKey("a2a:requests");
    expect((await send({ "X-Forge-Internal": "ci" }, "203.0.113.81")).status).toBe(200);
    let d = diff(before, await headlineSplits(env));
    expect(d.skill_scans).toEqual({ third_party: 0, ours: 1, unattributed: 0 });
    expect(await usageKey("a2a:requests")).toBe(a2aBefore);
    // An untagged request is an outside one, as before.
    expect((await send({}, "203.0.113.82")).status).toBe(200);
    d = diff(before, await headlineSplits(env));
    expect(d.skill_scans!.third_party).toBe(1);
    expect(await usageKey("a2a:requests")).toBe(a2aBefore + 1);
  });

  it("forge_scan calls by named directory and checker clients are taken off the third-party skill scans (review, 28 Oct)", async () => {
    const call = (client: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forge_scan", arguments: { text: "x" }, _meta: { "io.modelcontextprotocol/clientInfo": { name: client, version: "1" } } } });
    const before = await headlineSplits(env);
    // A checker's scan: the MCP counters (CATALOG_SCAN_KEY) and the tool's own scan:mcp.
    await bump(env, [...mcpCounters("public", call("agentrank-probe")), "scan:mcp"]);
    let d = diff(before, await headlineSplits(env));
    expect(d.skill_scans!.third_party).toBe(0);
    // An agent app's scan is an outside one.
    await bump(env, [...mcpCounters("public", call("cursor")), "scan:mcp"]);
    d = diff(before, await headlineSplits(env));
    expect(d.skill_scans!.third_party).toBe(1);
    expect(mcpCounters("public", call("cursor"))).not.toContain(CATALOG_SCAN_KEY);
    expect(mcpCounters("house", call("agentrank-probe"))).not.toContain(CATALOG_SCAN_KEY);
  });

  it("weekly reporting agents and plugin retry-count reports count readable reports only (review, 28 Oct)", async () => {
    const before = await proofNow(env);
    const out = await person("outside");
    await addReport(out, { moderationState: "rejected", strainSource: "hook" });
    await addReport(await person("outside"), { held: true, strainSource: "hook" });
    const after = await proofNow(env);
    expect(after.weekly_reporting_agents.external).toBe(before.weekly_reporting_agents.external);
    expect(after.reports_with_plugin_strain.external).toBe(before.reports_with_plugin_strain.external);
    await addReport(out, { strainSource: "hook" });
    const last = await proofNow(env);
    expect(last.weekly_reporting_agents.external).toBe(before.weekly_reporting_agents.external + 1);
    expect(last.reports_with_plugin_strain.external).toBe(before.reports_with_plugin_strain.external + 1);
  });
});

describe("the headline gate (ADR 0067)", () => {
  const splits = (n: number): Record<(typeof HEADLINE_RULES)[number]["key"], Split> => ({
    arena_bouts: { third_party: n, ours: 500 },
    gauntlet_runs: { third_party: n, ours: 3, unattributed: 40 },
    field_reports: { third_party: n, ours: 900 },
    skill_scans: { third_party: n, ours: 9930 },
  });

  it("below the minimum: 'below 10' and null, never the small number and never rounded up", () => {
    for (const n of [0, 1, THIRD_PARTY_MINIMUM - 1]) {
      for (const h of gateHeadline(splits(n))) {
        expect(h.display).toBe(BELOW_MINIMUM_TEXT);
        expect(h.value).toBeNull();
        expect(h.third_party).toBeNull();
        expect(h.below_minimum).toBe(true);
        expect(JSON.stringify(h)).not.toMatch(new RegExp(`"(value|third_party)":${n}\\b`));
      }
    }
    expect(BELOW_MINIMUM_TEXT).toBe("below 10");
  });

  it("from the minimum: the exact number, with our own count beside it and a rule link", () => {
    const h = gateHeadline(splits(1234), "https://x");
    for (const i of h) {
      expect(i.value).toBe(1234);
      expect(i.display).toBe("1,234");
      expect(i.rule_url).toBe(`https://x/stats/rules#${i.key}`);
    }
    expect(h.find((i) => i.key === "skill_scans")!.ours).toBe(9930);
    expect(h.find((i) => i.key === "gauntlet_runs")!.unattributed).toBe(40);
  });
});

/** Wording that would claim a number is someone else's activity. Never on a total that includes our own agents. */
const OUTSIDE_CLAIM = /outside|independent|by other agents|third[- ]party/i;
/** The one honest line under the totals (HTML may escape the apostrophe). */
const HONEST_LINE = /Includes The Forge(&#39;|')s own test agents\./;

describe("pages and machine-readable numbers (ADR 0067 Amendment 1: public totals again)", () => {
  it("the home band shows the live totals, our own test agents included and said so, and never claims they are outside activity", async () => {
    const page = await (await fetchWorker(`/?u=${uid("home")}`, { headers: { Accept: "text/html" } })).text();
    // Site audit 29 Oct: the band is one stat strip; per-number qualifiers are footnotes under it, and one caption.
    const start = page.indexOf('<div class="stat-strip');
    const band = page.slice(start, page.indexOf("</div>\n</div>", start) + 13);
    expect(band).toContain("data-work-live");
    expect(band).toContain("data-agent-live");
    // B3-06: the House wording stays with the field-report total, as its footnote, linked to the method note.
    expect(band).toMatch(/<li data-k="field_reports"><b>[\d,]+<\/b><span>field reports filed<sup class="fn"><a href="#fn-reports"/);
    expect(band).toMatch(/<p class="fn-note" id="fn-reports">.*<a href="\/methodology#house-install-tests">Mostly our House install tests<\/a>/);
    expect(band).toContain("Includes the Forge's own test agents");
    expect(band).toContain('<a href="/stats/rules">How each is counted</a>');
    // The honesty rule (the critical bug the ADR 0067 review fixed): no outside claim on a number that includes ours.
    expect(band).not.toMatch(OUTSIDE_CLAIM);
    expect(page).not.toContain("Live, outside agents only");
    expect(page).not.toContain("data-headline-live");
    expect(page).not.toContain("below 10</b>");
    const json = (await (await fetchWorker(`/?format=json&u=${uid("home")}`)).json()) as { third_party: unknown[]; stats: { totals: ReturnType<typeof publicTotals> }; stats_json: string };
    expect(json.third_party).toEqual([]);
    expect(json.stats.totals.includes_own_test_agents).toBe(true);
    // ADR 0105: the install-checks total is below its minimum here, so it is left out (not a null item).
    expect(json.stats.totals.items.map((i) => i.key)).toEqual(PUBLIC_TOTALS.map((t) => t.key).filter((k) => k !== "install_checks_total"));
    // The caveats survive the JSON twin's free-text filter (it strips keys named "note").
    expect(json.stats.totals.caveat).toBe(TOTALS_NOTE);
    expect(json.stats.totals.traffic_caveat).toBe(TRAFFIC_NOTE);
    expect(json.stats_json).toMatch(/\/stats\.json$/);
  });

  it("no public total's label claims outside activity, and each links to a published rule", () => {
    for (const t of PUBLIC_TOTALS) {
      expect(t.label, t.key).not.toMatch(OUTSIDE_CLAIM);
      expect([...BLENDED_RULES, ...INSTALL_RULES].some((r) => r.key === t.rule), t.key).toBe(true);
    }
    for (const [, label] of WORK_LABELS) expect(label).not.toMatch(OUTSIDE_CLAIM);
    for (const [, label] of LIVE_AGENT_LABELS) expect(label).not.toMatch(OUTSIDE_CLAIM);
    for (const r of BLENDED_RULES) expect(r.label, r.key).not.toMatch(OUTSIDE_CLAIM);
    expect(TOTALS_NOTE).toBe("Includes The Forge's own test agents.");
    const d = publicTotals({ bouts_refereed: 5, ranked_bouts: 2, traps_sprung: null, skills_scanned: 9930, field_reports: 0, tools_tracked: 40, last_bout_at: null, last_report_at: null, last_tool_at: null, last_scan_at: null }, null, "https://x");
    expect(d.items.find((i) => i.key === "bouts_refereed")).toEqual({ key: "bouts_refereed", label: "Arena bouts refereed", value: 5, rule_url: "https://x/stats/rules#bouts_refereed" });
    // Never a zero: a missing or zero total is null.
    expect(d.items.find((i) => i.key === "field_reports")!.value).toBeNull();
    expect(d.items.find((i) => i.key === "page_views_total")!.value).toBeNull();
  });

  it("/about shows the live totals with the honest line, not the outside-only headline", async () => {
    const page = await (await fetchWorker(`/about?u=${uid("about")}`)).text();
    expect(page).not.toContain("Live numbers, outside the project");
    for (const r of HEADLINE_RULES) expect(page).not.toContain(`href="/stats/rules#${r.key}"`);
    if (page.includes("<h2>Live numbers</h2>")) {
      const block = page.slice(page.indexOf("<h2>Live numbers</h2>"), page.indexOf('<h2 id="investors">'));
      expect(block).toMatch(HONEST_LINE);
      // Site audit 29 Oct (§3.9): /about shows bouts and skills only (no traffic numbers), so no traffic note; /stats has it.
      expect(block).not.toMatch(/page views|AI agent visits/i);
      expect(block).not.toMatch(OUTSIDE_CLAIM);
    }
    // The same totals as the home band, each linked to a rule that /stats/rules publishes.
    await addOurArenaBout();
    const fresh = await (await fetchWorker(`/about?u=${uid("about")}`)).text();
    const block = fresh.slice(fresh.indexOf("<h2>Live numbers</h2>"), fresh.indexOf('<h2 id="investors">'));
    expect(block).toMatch(/<a href="\/stats\/rules#bouts_refereed"><b>[\d,]+<\/b> Arena bouts refereed<\/a>/);
    for (const m of block.matchAll(/href="\/stats\/rules#([a-z_0-9]+)"/g)) expect(BLENDED_RULES.some((r) => r.key === m[1]), m[1]).toBe(true);
    expect(block).not.toMatch(/models ranked|tools checked/);
  });

  it("/stats.json is /stats?format=json: totals, an empty headline kept for old readers, the rules version", async () => {
    const a = (await (await fetchWorker(`/stats.json?u=${uid("s")}`)).json()) as Record<string, unknown> & { headline: unknown[]; totals: ReturnType<typeof publicTotals>; now: Record<string, unknown>; blended: { includes: string[] }; internal_only: string[] };
    const b = (await (await fetchWorker(`/stats?format=json&u=${uid("s")}`)).json()) as typeof a;
    expect(a.rules_version).toBe("2.4");
    expect(a.rules_url).toMatch(/\/stats\/rules$/);
    expect(a.headline).toEqual([]);
    expect(b.headline).toEqual([]);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.totals.includes_own_test_agents).toBe(true);
    expect(a.totals.items.map((i) => i.key)).toEqual(PUBLIC_TOTALS.map((t) => t.key).filter((k) => k !== "install_checks_total"));
    expect(a.totals.caveat).toBe(TOTALS_NOTE);
    expect(a.totals.traffic_caveat).toMatch(/crawlers/);
    expect(a.blended.includes).toEqual(expect.arrayContaining(["house_agents", "founder_accounts", "crawlers"]));
    // F-02: the outside-only fields stay for old readers, always null, and are listed as internal.
    for (const k of ["now", "history", "usage", "skill_checks", "agent_funnel"]) expect(a[k], k).toBeNull();
    expect(a.internal_only).toEqual(expect.arrayContaining(["headline", "active_owners_30d", "now", "history", "usage", "skill_checks", "agent_funnel"]));
    expect(a.house_excluded).toBe(false);
  });

  it("/stats leads with the totals (our own test agents included) and shows no outside-only headline or active owners", async () => {
    const page = await (await fetchWorker(`/stats?u=${uid("s")}`)).text();
    expect(page).not.toContain('id="headline"');
    expect(page).not.toContain("Third-party");
    expect(page).not.toContain("Active owners");
    for (const r of HEADLINE_RULES) expect(page).not.toContain(`<tr data-k="${r.key}">`);
    // F-02: no outside-only table, 7-day counts or daily history; gross twins instead.
    expect(page).not.toContain("People outside the project");
    expect(page).not.toContain('id="agents"');
    expect(page).not.toContain("tool calls from outside apps");
    expect(page).not.toContain("Daily history");
    expect(page).not.toContain('id="house"');
    expect(page.indexOf('id="blended"')).toBeLessThan(page.indexOf('id="gross"'));
    // Site audit 29 Oct (§3.10): the disclosure is said once, under the H1, above the first table.
    expect(page).toContain('<h2 class="page-title" id="blended">Totals</h2>');
    expect(page).toMatch(HONEST_LINE);
    expect(page.match(/class="disclosure"/g)?.length).toBe(1);
    expect(page.indexOf('class="disclosure"')).toBeLessThan(page.indexOf("<table"));
    expect(page).toContain("Page views (gross, crawlers included)");
    expect(page).toContain("traffic numbers also include crawlers and uptime checks");
    const totals = page.slice(page.indexOf('id="blended"'));
    expect(totals).not.toMatch(/by outside|outside agents|independent|by other agents|third[- ]party/i);
    expect(page).not.toContain("<td>Verified people</td>");
    expect(page).not.toContain("below 10");
    expect(page).not.toMatch(/<(b|td class="num")>0<\//);
  });

  it("/api/v1/stats stays compatible: third_party kept but empty, active owners kept but null, totals added", async () => {
    const api = (await (await fetchWorker("/api/v1/stats")).json()) as Record<string, unknown> & { third_party: unknown[]; totals: ReturnType<typeof publicTotals>; reports: number | null; below_minimum: string[] };
    const stats = (await (await fetchWorker(`/stats.json?u=${uid("s")}`)).json()) as { totals: ReturnType<typeof publicTotals> };
    expect(api.house_excluded).toBe(false);
    expect(api.founders_excluded).toBe(false);
    expect(api.rules_version).toBe("2.4");
    expect(api.third_party).toEqual([]);
    expect(api).toHaveProperty("active_owners_30d", null);
    expect(api.below_minimum).not.toContain("active_owners_30d");
    expect(api.internal_only).toEqual(["third_party", "active_owners_30d", "humans", "verified_humans", "agents", "reports", "reports_last_24h", "tool_versions_reported"]);
    for (const k of ["humans", "verified_humans", "agents", "reports", "reports_last_24h", "tool_versions_reported"]) expect(api[k], k).toBeNull();
    expect(api.totals.items.map((i) => [i.key, i.label])).toEqual(stats.totals.items.map((i) => [i.key, i.label]));
    expect(api.totals.caveat).toBe(TOTALS_NOTE);
    expect(api.totals.traffic_caveat).toBe(TRAFFIC_NOTE);
    // The OpenAPI Stats schema describes what is sent: totals' and each item's required keys, third_party empty.
    const spec = (await (await fetchWorker("/openapi.json")).json()) as { components: { schemas: { Stats: { properties: Record<string, { required?: string[]; maxItems?: number; properties?: { items?: { items?: { required?: string[] } } } }> } } } };
    const props = spec.components.schemas.Stats.properties;
    expect(Object.keys(api.totals)).toEqual(expect.arrayContaining(props.totals!.required!));
    for (const i of api.totals.items) expect(Object.keys(i)).toEqual(expect.arrayContaining(props.totals!.properties!.items!.items!.required!));
    expect(api.third_party.length).toBeLessThanOrEqual(props.third_party!.maxItems!);
    // One internal field-report count: the raw counts and the internal split read the same rows (neither is public).
    const raw = await publicCounts(env);
    const head = (await headlineSplits(env)).field_reports.third_party;
    expect(raw.reports).toBe(head);
  });

  it("every internal outside-only number is still reproduced by the SQL its rule gives (kept for /admin/kpis)", async () => {
    const splits = await headlineSplits(env);
    for (const r of HEADLINE_RULES) {
      const q = r.reproduce.replace("<ADMIN_GITHUB_IDS>", env.ADMIN_GITHUB_IDS);
      const row = await env.DB.prepare(q).first<Record<string, number>>();
      expect(Number(Object.values(row!)[0]), r.key).toBe(splits[r.key].third_party);
    }
  });

  it("the outside-only numbers and active owners are on /admin/kpis and its JSON, for admins only", async () => {
    const anon = await fetchWorker("/admin/stats/third-party.json");
    expect(anon.status).toBe(403);
    expect(anon.headers.get("Cache-Control")).toContain("no-store");
    const outsider = await person("outside");
    const user = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, outsider.humanId)}`;
    expect((await fetchWorker("/admin/stats/third-party.json", { headers: { Cookie: user } })).status).toBe(403);
    for (const headers of [{}, { Cookie: user }] as Record<string, string>[]) {
      const k = await fetchWorker("/admin/kpis", { headers, redirect: "manual" });
      expect(k.status).not.toBe(200);
      expect(await k.text()).not.toContain('id="third-party"');
    }
    const founder = await person("founder");
    const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.humanId)}`;
    const res = await fetchWorker("/admin/stats/third-party.json", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    const j = (await res.json()) as { internal_only: boolean; splits: Record<string, Split>; headline: HeadlineItem[]; active_owners_30d: number };
    expect(j.internal_only).toBe(true);
    expect(j.splits).toEqual(await headlineSplits(env));
    expect(j.headline.map((h) => h.key)).toEqual(HEADLINE_RULES.map((r) => r.key));
    expect(typeof j.active_owners_30d).toBe("number");
    // F-02: what /stats, /connect and the dashboard used to show publicly, outside-only, is here now.
    const moved = j as unknown as { stats_page: { now: Record<string, { external_exact: number }>; rules: { key: string }[] }; connect_check_sources_today: number };
    expect(Object.keys(moved.stats_page.now)).toEqual(expect.arrayContaining(["humans", "agents", "verified_humans", "check_sources"]));
    expect(moved.stats_page.rules.map((r) => r.key)).toEqual(expect.arrayContaining(Object.keys(moved.stats_page.now)));
    expect(typeof moved.connect_check_sources_today).toBe("number");
    const page = await (await fetchWorker("/admin/kpis", { headers: { Cookie: cookie } })).text();
    expect(page).toContain('id="third-party"');
    expect(page).toContain("Active owners, last 30 days (outside the project)");
    for (const r of HEADLINE_RULES) expect(page).toContain(r.label);
  });

  it("the totals and people numbers are reproduced by the SQL their rules publish (review, 28 Oct)", async () => {
    // The public rules, and the internal people rules (F-02: on /admin only now).
    const rules = [...((await (await fetchWorker("/stats/rules?format=json")).json()) as { rules: { key: string; reproduce: string }[] }).rules, ...PEOPLE_RULES];
    const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const sqlFor = (k: string) => rules.find((r) => r.key === k)!.reproduce.replaceAll("<ADMIN_GITHUB_IDS>", env.ADMIN_GITHUB_IDS).replaceAll("<today - 6 days>", since);
    const run = async (k: string) => Number(Object.values((await env.DB.prepare(sqlFor(k)).first<Record<string, number>>())!)[0]);
    // Real rows behind every total, so no pair below can pass as 0 = 0: a bout with a sprung trap, a report, a scan,
    // and traffic on every key the totals read, directory and House sessions and a catalogue client's calls included.
    await addOurArenaBout();
    await db().insert(t.arenaRuns).values({ id: uid("run"), eventId: arenaEventId!, modelId: "test-model", task: "invoice", seed: 2, attemptNo: 1, status: "done", result: { traps: [{ id: "x", triggered: true }, { id: "y", triggered: false }] } as never });
    await addReport(await person("house"));
    await db().insert(t.skillScans).values({ fingerprint: `sha256:${uid("fp")}`, verdict: "clear", findings: [], counts: {}, rulesVersion: "test", bytes: 1, firstSeen: Date.now(), lastSeen: Date.now() });
    await bump(env, ["visit:all", "ai:live", "disc:agent-card", "skillmd:agent", "mcp:public:sessions", "mcp:public:sessions", "mcp:client:glama", "mcp:house:sessions", "a2a:requests", "mcp:public:calls", "mcp:clientcall:glama", "mcp:house:calls", "scan:api"]);
    const now = await proofNow(env);
    for (const k of ["verified_humans", "humans", "agents", "reports", "reports_with_plugin_strain", "tools_with_score"] as const) expect(await run(k), k).toBe(now[k].external);
    await bump(env, [internalKey("scout", "calls"), internalKey("scout", "scans")]);
    const gross = await grossNumbers(env);
    for (const k of ["signed_in_people", "signed_in_agents", "ai_tool_calls_7d", "skill_checks_7d"] as const) {
      expect(gross[k], k).toBeGreaterThan(0);
      expect(await run(k), k).toBe(gross[k]);
    }
    const work = await workTotals(env);
    const live = await liveAgentCounts(env);
    const pairs: [string, number | null][] = [
      ["bouts_refereed", work.bouts_refereed],
      ["ranked_bouts", work.ranked_bouts],
      ["traps_sprung", work.traps_sprung],
      ["skills_scanned", work.skills_scanned],
      ["field_reports_all", work.field_reports],
      ["tools_tracked", work.tools_tracked],
      // The rule's SQL is the Worker's own count; the fixed pre-23 Oct backfill is added on production (the rule says so).
      ["page_views_total", (live.page_views_total ?? 0) - (env.ENVIRONMENT === "production" ? Object.values(PAGE_VIEWS_BACKFILL).reduce((a, b) => a + b, 0) : 0)],
      ["agent_visits_total", live.agent_visits_total],
      ["agent_connections_total", live.agent_connections_total],
      ["agent_tool_uses_total", live.agent_tool_uses_total],
    ];
    for (const [k, v] of pairs) {
      expect(v, k).toBeGreaterThan(0);
      expect(await run(k), k).toBe(v);
    }
    const backfill = Object.values(PAGE_VIEWS_BACKFILL).reduce((a, b) => a + b, 0);
    expect(BLENDED_RULES.find((r) => r.key === "page_views_total")!.counts).toContain(`${backfill.toLocaleString("en-US")} views`);
  });

  it("/stats/rules has a rule for every gross number in /stats.json (F-02)", async () => {
    const rules = ((await (await fetchWorker("/stats/rules?format=json")).json()) as { rules: { key: string }[] }).rules.map((r) => r.key);
    const stats = (await (await fetchWorker(`/stats.json?u=${uid("s")}`)).json()) as { gross: { items: { key: string; rule_url: string }[] } };
    // ADR 0099: the people and agent rows appear once they pass 50; the 7-day numbers are always there.
    expect(stats.gross.items.map((i) => i.key)).toEqual(expect.arrayContaining(["ai_tool_calls_7d", "skill_checks_7d"]));
    for (const k of ["signed_in_people", "signed_in_agents"]) expect(rules, k).toContain(k);
    for (const i of stats.gross.items) {
      expect(rules, i.key).toContain(i.key);
      expect(i.rule_url).toMatch(new RegExp(`/stats/rules#${i.key}$`));
    }
    // The outside-only people rules are internal now.
    for (const k of ["humans", "verified_humans", "check_sources", "skill_scans_7d", "agent_funnel_7d"]) expect(rules).not.toContain(k);
  });

  it("/stats/rules defines every public number (totals and people counters) with SQL; no outside-only rules; JSON twin carries the version", async () => {
    const page = await (await fetchWorker("/stats/rules")).text();
    for (const k of ["bouts_refereed", "traps_sprung", "skills_scanned", "field_reports_all", "tools_tracked", "page_views_total", "agent_visits_total", "signed_in_people", "signed_in_agents", "ai_tool_calls_7d", "skill_checks_7d"]) expect(page).toContain(`id="${k}"`);
    for (const k of ["arena_bouts", "gauntlet_runs", "skill_scans", "active_owners_30d", "reports", "check_sources", "humans"]) expect(page).not.toContain(`id="${k}"`);
    expect(page).not.toContain("SELECT count(*) FROM gauntlet_claims");
    expect(page).not.toMatch(/third[- ]party/i);
    expect(page).toMatch(HONEST_LINE);
    const json = (await (await fetchWorker("/stats/rules?format=json")).json()) as { version: string; totals_include_own_test_agents: boolean; rules: { key: string; reproduce: string; minimum: number | null }[] };
    expect(json.version).toBe("2.4");
    expect(json.totals_include_own_test_agents).toBe(true);
    expect(json.rules.some((r) => HEADLINE_RULES.some((h) => h.key === r.key))).toBe(false);
    for (const t of PUBLIC_TOTALS) expect(json.rules.map((r) => r.key)).toContain(t.rule);
    expect(json.rules.every((r) => r.reproduce.length > 0)).toBe(true);
    // One anchor per number: no key is defined twice.
    expect(new Set(json.rules.map((r) => r.key)).size).toBe(json.rules.length);
  });

  it("llms.txt and /methodology document /stats.json, /scores/recent.json and the live /benchmark/v1.json", async () => {
    const llms = await (await fetchWorker("/llms.txt")).text();
    const meth = await (await fetchWorker("/methodology")).text();
    for (const s of [llms, meth]) {
      expect(s).toContain("/stats.json");
      expect(s).toContain("/scores/recent.json");
      expect(s).toMatch(/\[\/benchmark\/v1\.json\]\(\/benchmark\/v1\.json\)|<a href="\/benchmark\/v1\.json">/);
      expect(s).not.toMatch(/\/benchmark\/v1\.json(`|<\/code>)?:? coming/);
    }
  });
});

describe("/scores/recent.json (ADR 0067, Boardy item 16)", () => {
  it("lists claimed, shown runs only, with agent page, date, score and public trap ids; no personal data", async () => {
    const out = await person("outside");
    const shown = await addGauntlet(out);
    const hidden = await addGauntlet({ ...out, hidden: true });
    const unclaimed = await addGauntlet(null);
    const house = await person("house");
    const ours = await addGauntlet(house);
    const res = await fetchWorker(`/scores/recent.json?u=${uid("r")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const j = JSON.parse(body) as { opt_in: string; runs: { gauntlet_id: string; agent: string; agent_url: string; finished_at: string; score: { passed: number; jobs_total: number }; traps_fell: number; traps_fell_public_ids: string[]; owner: string; run_url: string; run_json_url: string }[] };
    expect(j.opt_in).toBe("claimed_and_shown");
    const ids = j.runs.map((r) => r.gauntlet_id);
    expect(ids).toContain(shown);
    expect(ids).toContain(ours);
    expect(ids).not.toContain(hidden);
    expect(ids).not.toContain(unclaimed);
    const r = j.runs.find((x) => x.gauntlet_id === shown)!;
    expect(r).toMatchObject({ agent: out.handle, owner: "third_party", score: { passed: 4, jobs_total: 6 }, traps_fell: 2 });
    expect(r.agent_url).toMatch(new RegExp(`/a/${out.handle}$`));
    expect(r.run_url).toMatch(new RegExp(`/gauntlet/r/${shown}$`));
    expect(r.run_json_url).toMatch(/\?format=json$/);
    expect(Date.parse(r.finished_at)).not.toBeNaN();
    expect(j.runs.find((x) => x.gauntlet_id === ours)!.owner).toBe("ours");
    // Private families never appear, not even as an id; no owner login, GitHub id or human id.
    expect(r.traps_fell_public_ids).toEqual([PUBLIC_ID]);
    expect(body).not.toContain(PRIVATE_ENTRY.id);
    expect(body).not.toContain(PRIVATE_KEY);
    expect(body).not.toMatch(/FA-[A-Z]+-1\d\d/);
    expect(body).not.toMatch(/github|login|human/i);
    expect(body).not.toMatch(SHOWS_EMBARGOED);
  });
});
