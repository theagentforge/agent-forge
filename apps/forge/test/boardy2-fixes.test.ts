import { env } from "cloudflare:workers";
import { Attempt, publicTrapId, RULES_VERSION, taskById, type AttemptResult } from "@forge/arena";
import { describe, expect, it, beforeAll } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { EMPTY_BOARD, gullibilityBoard } from "../src/arena/board";
import { boardCaption } from "../src/web/home-wire";
import { rulesSpan, rulesText, tallyRules } from "../src/arena/rules-label";
import { failureCardLines } from "../src/web/og";
import { trapBoard } from "../src/arena/failures";
import { EXPERIMENTS } from "../src/web/experiments";
import { trapCardExperimentsData } from "../src/web/security";
import { formatSlot, nextHeadlineSlot } from "../src/arena/headline-slot";
import { proofNow } from "../src/services/proof";
import { GROSS_RULES, TOTALS_NOTE } from "../src/services/public-stats";
import { adoptionClaims, jsonText, pageText } from "../src/services/adoption-wording";
import { FOUNDING_LIST_OPENS_AT } from "../src/web/founding";
import { BUSINESS_REPORT_PATH } from "../src/web/arena-business";
import { internalStatsCaller, internalStatsData } from "../src/web/admin-kpis";
import { HOUSE_REPOS, type OidcClaims } from "../src/services/house";
import { crossed, metricValues, MILESTONE_WINDOW_MS } from "../src/social/milestones";
import { fetchWorker } from "./helpers";
import "../src/index";

// Build plan after Boardy's second audit (docs/strategy/build-plan-2026-10-28-boardy2.md; ADR 0082):
// F-01 a rules label on every chart and rate; F-02 no public outside-only number, with a wording guard; B2-04 the
// Lab #4 null result on /security. (F-03's freeze gates are tested on the script: integrations/ops/test.)

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const db = () => getDb(env);
let n = 0;
const get = async (path: string, accept = "text/html") => (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}n=b2${++n}`, { headers: { Accept: accept } })).text();
const json = async (path: string) => JSON.parse(await get(path, "application/json")) as Record<string, unknown>;

const REFUND = ["out_of_policy", "over_refund"];
const REFUND_TRAP = publicTrapId("refund", "out_of_policy")!;
function made(sprung: boolean, stamped: boolean) {
  const a = new Attempt(taskById("refund")!, 5_100_001);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "Refunds done" });
  a.call("finish", { status: "done", summary: "Refunds done" });
  const base = a.end("finished");
  return { ...base, passed: !sprung, traps: REFUND.map((id) => ({ id, label: id, triggered: sprung && id === "out_of_policy" })), ...(stamped ? { rules: RULES_VERSION } : {}) } as AttemptResult;
}

// Three models, 30 bouts each on a Normal job: 10 ranked under rules 0.2 and 10 ranked under rules 0.4 (unstamped, so
// read from their finish time), and 10 practice bouts stamped with the current rules. No ranked current-rules bout.
const MODELS = ["claude-sonnet-5.5", "gpt-6.1-sol", "kimi-k2.6"];
const AT_0_2 = Date.parse("2026-10-16T12:00:00Z");
const AT_0_4 = Date.parse("2026-10-20T12:00:00Z");
beforeAll(async () => {
  const ids = { card: crypto.randomUUID(), practice: crypto.randomUUID() };
  await db().insert(t.arenaEvents).values([
    { id: ids.card, slug: "b2-card", name: "B2 ranked", season: "s0", kind: "card", status: "done" },
    { id: ids.practice, slug: "b2-practice", name: "B2 practice", season: "s0", kind: "practice", status: "done" },
  ]);
  let k = 0;
  const rows: (typeof t.arenaRuns.$inferInsert)[] = [];
  for (const model of MODELS)
    for (const [eventId, when, stamped] of [[ids.card, AT_0_2, false], [ids.card, AT_0_4, false], [ids.practice, Date.now() - 60_000, true]] as const)
      for (let i = 0; i < 10; i++) {
        const result = made(i % 3 === 0, stamped);
        rows.push({ id: crypto.randomUUID(), eventId, modelId: model, task: "refund", seed: 5_100_001 + i, attemptNo: 1, status: "done", passed: result.passed, score: 0.5, cost: 0.01, tokens: 1000, result, log: [], finishedAt: when + ++k });
      }
  for (let i = 0; i < rows.length; i += 3) await db().insert(t.arenaRuns).values(rows.slice(i, i + 3));
});

describe("F-01: every chart and rate names its rules", () => {
  it("the home chart's caption states its ranked/practice mix and every rules version, computed from its bouts", async () => {
    const b = await gullibilityBoard(env, db());
    expect(b.rows.map((r) => r.model).sort()).toEqual([...MODELS].sort());
    expect([b.runs, b.ranked, b.practice]).toEqual([90, 60, 30]);
    expect(b.rules_versions).toEqual([{ version: "rules 0.2", n: 30 }, { version: "rules 0.4", n: 30 }, { version: RULES_VERSION, n: 30 }]);
    const caption = boardCaption(b);
    expect(caption).toContain("30 practice and 60 ranked bouts");
    expect(caption).toContain(`scored under rules 0.2–${RULES_VERSION.replace("rules ", "")} (0.2: 30; 0.4: 30; ${RULES_VERSION.replace("rules ", "")}: 30)`);
    const page = await get("/");
    const block = page.slice(page.indexOf('id="board-title"'), page.indexOf("</section>", page.indexOf('id="board-title"')));
    expect(block).toContain("rules");
    for (const v of b.rules_versions) expect(block).toContain(v.version.replace("rules ", ""));
    expect(block).toMatch(/30 practice and 60 ranked bouts/);
    expect(block).toContain('href="/security#arena"');
    expect(block).toContain(`Current rules (${RULES_VERSION.replace("rules ", "")}) results`);
  });

  it("the chart's JSON twin has rules_versions summing to its bouts, and the practice and ranked counts", async () => {
    const home = (await json("/?format=json")) as { which_ai_falls_for_it: { runs: number; ranked: number; practice: number; rules_versions: Record<string, number>; current_rules: string; current_rules_results: string } };
    const w = home.which_ai_falls_for_it;
    expect(Object.values(w.rules_versions).reduce((a, x) => a + x, 0)).toBe(w.runs);
    expect(w.ranked + w.practice).toBe(w.runs);
    expect(w.rules_versions).toEqual({ "rules 0.2": 30, "rules 0.4": 30, [RULES_VERSION]: 30 });
    expect(w.current_rules).toBe(RULES_VERSION);
    expect(w.current_rules_results).toMatch(/\/security#arena$/);
    expect(EMPTY_BOARD.rules_versions).toEqual([]);
  });

  it("/security with no current-rules ranked attempts names the next weekly bout and links the older-rules results", async () => {
    const page = await get("/security");
    const empty = page.slice(page.indexOf("data-current-rules-empty"), page.indexOf("</p>", page.indexOf("data-current-rules-empty")));
    expect(empty).toContain(`No ranked attempts under ${RULES_VERSION} yet`);
    expect(empty).toContain(formatSlot(nextHeadlineSlot(Date.now())));
    expect(empty).toContain("60 ranked attempts scored under older rules");
    expect(empty).toContain('href="/benchmark#results"');
    expect(empty).not.toContain("not yet measured");
    const sj = (await json("/security?format=json")) as { arena: { next_weekly_bout: { at: string } } };
    expect(Date.parse(sj.arena.next_weekly_bout.at)).toBe(nextHeadlineSlot(Date.now()));
  });

  it("every route that prints a fall rate names its rules or links to the current-rules results", async () => {
    const LABEL = /\brules 0\.\d|href="\/security#arena"/;
    const routes = ["/", "/security", "/arena/business", "/arena/business?tier=normal", BUSINESS_REPORT_PATH, "/arena/failures", `/arena/failures/${REFUND_TRAP}`, "/trap-card", "/benchmark"];
    for (const r of routes) expect(await get(r), r).toMatch(LABEL);
    // Pooled pages say which versions they pool.
    for (const r of ["/arena/business", BUSINESS_REPORT_PATH, "/arena/failures"]) expect(await get(r), r).toMatch(/Scored under rules 0\.2–/);
    // JSON twins carry the versions.
    expect(((await json("/arena/business?format=json")) as { rules_versions: Record<string, number> }).rules_versions).toMatchObject({ "rules 0.2": expect.any(Number), "rules 0.4": expect.any(Number) });
    expect(((await json("/arena/failures?format=json")) as { rules_versions: Record<string, number> }).rules_versions).toMatchObject({ "rules 0.2": expect.any(Number) });
    // The share card for a trap names its rules; the trap card experiments name theirs.
    const tb = await trapBoard(db(), REFUND_TRAP);
    if (tb?.overall) expect(failureCardLines(tb).rules).toMatch(/^rules 0\.\d/);
    for (const e of EXPERIMENTS) {
      expect(e.rules).toBe("rules 0.4");
      expect(e.rules).toBe(tallyRules([{ finishedAt: Date.parse(e.run.from), result: null }])[0]!.version);
    }
  });

  it("rules labels read the same everywhere", () => {
    expect(rulesSpan([{ version: "rules 0.6" }])).toBe("rules 0.6");
    expect(rulesSpan([{ version: "rules 0.6" }, { version: "rules 0.2" }, { version: "rules 0.4" }])).toBe("rules 0.2–0.6");
    expect(rulesText([{ version: "rules 0.6", n: 1200 }])).toBe("rules 0.6");
    expect(rulesText([{ version: "rules 0.2", n: 1200 }, { version: "rules 0.6", n: 3 }])).toBe("rules 0.2–0.6 (0.2: 1,200; 0.6: 3)");
    expect(rulesSpan([])).toBeNull();
  });
});

describe("B2-04: the Lab #4 null result on /security", () => {
  it("renders Lab #4's n, interval and p from EXPERIMENTS, in the pre-registration's words, with Lab #3 beside it", async () => {
    const page = await get("/security");
    const at = page.indexOf('id="null-result"');
    expect(at).toBeGreaterThan(0);
    const block = page.slice(at, page.indexOf("<h2", at + 10));
    const [e3, e4] = EXPERIMENTS;
    const [d4, d3] = trapCardExperimentsData("");
    expect(d4!.lab).toBe(4);
    expect(d3!.lab).toBe(3);
    expect(e4.stats.significant).toBe(false);
    expect(block).toContain("the card didn't measurably reduce traps");
    expect(block).toContain(`${e4.stats.boutsTotal.toLocaleString("en-GB")} bouts in all`);
    expect(block).toContain(`with the card ${e4.stats.card.trapped} of ${e4.stats.card.n} bouts`);
    expect(block).toContain(`with no card ${e4.stats.none.trapped} of ${e4.stats.none.n}`);
    expect(block).toContain(`95% interval ${d4!.risk_ratio_ci95[0]!.toFixed(2)} to ${d4!.risk_ratio_ci95[1]!.toFixed(2)}`);
    expect(block).toContain(d4!.p_text);
    expect(block).toContain("Forge Lab #3");
    expect(block).toContain(`with a placebo text of the same length ${e3.stats.placebo!.trapped} of ${e3.stats.placebo!.n}`);
    expect(block).toContain(e4.rules);
    // The interval contains the point estimate and is rounded outwards; the JSON twin carries the same numbers.
    expect(d4!.risk_ratio_ci95[0]!).toBeLessThanOrEqual(1 - e4.stats.fewerHi);
    expect(d4!.risk_ratio_ci95[1]!).toBeGreaterThanOrEqual(1 - e4.stats.fewerLo);
    expect(d4!.risk_ratio_ci95[0]!).toBeLessThan(1);
    expect(d4!.risk_ratio_ci95[1]!).toBeGreaterThan(1);
    const sj = (await json("/security?format=json")) as { trap_card_experiments: { lab: number; result: string; bouts: number }[] };
    expect(sj.trap_card_experiments[0]).toMatchObject({ lab: 4, result: "did_not_measurably_reduce_traps", bouts: e4.stats.boutsTotal });
  });
});

// F-02 seed: outside-only values chosen so they can't be mistaken for anything else on the pages.
const OUTSIDE = { people: 113, agents: 97, calls: 4111 };
// Ours are distinctive too: a public "ours" figure beside a gross one would give the outside one by subtraction.
const OURS = { people: 67, agents: 61, calls: 7_919 };
let peopleBefore = 0;
let agentsBefore = 0;

let seeded = false;
async function seedPeople() {
  seeded = true;
  peopleBefore = Number((await env.DB.prepare("SELECT count(*) AS n FROM humans").first<{ n: number }>())!.n);
  agentsBefore = Number((await env.DB.prepare("SELECT count(*) AS n FROM agents WHERE status = 'active'").first<{ n: number }>())!.n);
  const people: (typeof t.humans.$inferInsert)[] = [];
  const agents: (typeof t.agents.$inferInsert)[] = [];
  for (const [isHouse, count, withAgents] of [[false, OUTSIDE.people, OUTSIDE.agents], [true, OURS.people, OURS.agents]] as const)
    for (let i = 0; i < count; i++) {
      const id = uid(isHouse ? "hh" : "oh");
      people.push({ id, githubId: 800_000_000 + people.length, githubLogin: uid("login"), githubCreatedAt: 0, tier: "verified", isHouse });
      if (i < withAgents) agents.push({ id: uid("ag"), humanId: id, handle: uid(isHouse ? "house" : "out"), framework: "claude-code", oauthClientId: uid("c") });
    }
  for (let i = 0; i < people.length; i += 5) await db().insert(t.humans).values(people.slice(i, i + 5));
  for (let i = 0; i < agents.length; i += 5) await db().insert(t.agents).values(agents.slice(i, i + 5));
  const day = new Date().toISOString().slice(0, 10);
  await db().insert(t.usageDaily).values([
    { day, key: "mcp:public:calls", n: OUTSIDE.calls },
    { day, key: "mcp:house:calls", n: OURS.calls },
  ]);
}

/** Every public page and JSON twin that showed, or could show, people, agent or usage numbers. */
const PUBLIC_HTML = ["/", "/stats", "/stats/rules", "/about", "/connect", "/founding", "/security", "/benchmark", "/benchmark/changelog", "/benchmark/licence", "/gauntlet", "/trap-card", "/teams", "/arena", "/agents"];
/** The next Tuesday, Wednesday and Thursday (the milestone slots), as US Eastern dates for /api/v1/social/drafts. */
const MILESTONE_DAYS = [2, 3, 4].map((dow) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((dow - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
});
const PUBLIC_JSON = [
  "/?format=json", "/stats.json", "/stats?format=json", "/stats/rules?format=json", "/api/v1/stats", "/api/v1/growth", "/founding?format=json", "/security?format=json", "/agents/live.json", "/agents.json",
  "/api/v1/arena/status", "/benchmark/v1.json", "/benchmark/v1/traps.json", "/benchmark/changelog.json", "/benchmark/licence?format=json", "/.well-known/agent-card.json", ...MILESTONE_DAYS.map((d) => `/api/v1/social/drafts?date=${d}`),
];

function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => numbersIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => numbersIn(x, out));
  return out;
}

describe("F-02: no public outside-only number", () => {
  it("public pages and JSON show gross numbers only: the outside-only values never appear, and the internal ones still exist", async () => {
    await seedPeople();
    // The seed really is there, outside-only, for the admin pages.
    const p = await proofNow(env);
    expect(p.humans.external).toBeGreaterThanOrEqual(OUTSIDE.people);
    const outsidePeople = p.humans.external;
    const outsideAgents = p.agents.external;
    // Gross twins: everyone, ours included.
    const stats = (await json("/stats.json")) as { gross: { includes_own_test_agents: boolean; caveat: string; items: { key: string; value: number | null }[] } };
    const g = Object.fromEntries(stats.gross.items.map((i) => [i.key, i.value]));
    expect(g.signed_in_people).toBe(peopleBefore + OUTSIDE.people + OURS.people);
    expect(g.signed_in_agents).toBe(agentsBefore + OUTSIDE.agents + OURS.agents);
    expect(g.ai_tool_calls_7d).toBeGreaterThanOrEqual(OUTSIDE.calls + OURS.calls);
    expect(stats.gross.includes_own_test_agents).toBe(true);
    expect(stats.gross.caveat).toBe(TOTALS_NOTE);
    // The House-only figures too (gross − ours = outside). Each must be distinctive, or this test would prove nothing.
    expect(p.humans.house).toBeGreaterThanOrEqual(OURS.people);
    expect(p.agents.house).toBeGreaterThanOrEqual(OURS.agents);
    const forbidden = new Set([outsidePeople, outsideAgents, OUTSIDE.calls, p.humans.house, p.agents.house, OURS.calls]);
    for (const x of forbidden) expect(x, "a forbidden value too small to be distinctive").toBeGreaterThan(9);
    expect(forbidden.size).toBe(6);
    for (const path of PUBLIC_JSON) {
      const nums = numbersIn(await json(path));
      for (const x of forbidden) expect(nums, `${path} has ${x}`).not.toContain(x);
    }
    for (const path of PUBLIC_HTML) {
      const text = pageText(await get(path));
      for (const x of forbidden) expect(text, `${path} has ${x}`).not.toMatch(new RegExp(`(^|[^\\d,.])${x.toLocaleString("en-US").replace(",", ",?")}([^\\d,.]|$)`));
      expect(text, path).not.toMatch(/People outside the project|tool calls from outside apps|different people and agents checked a tool today|Signed-in agents of people outside/);
    }
    // The internal endpoint for the digest and Scout has them, and refuses anyone without the workflow's token.
    const internal = await internalStatsData(env);
    expect(numbersIn(internal)).toEqual(expect.arrayContaining([outsidePeople, outsideAgents]));
    expect(internal.growth.mcp_tool_calls_7d).toBeGreaterThanOrEqual(OUTSIDE.calls);
    for (const auth of [undefined, "Bearer a.b.c"]) {
      const res = await fetchWorker("/api/v1/ops/internal-stats", { headers: auth ? { Authorization: auth } : {} });
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(numbersIn(await res.json())).toEqual([]);
    }
  });

  it("milestone posts, which quote outside-only numbers, are not drafted on the public drafts API", async () => {
    // The seed above crossed outside thresholds in the last 7 days (agents 1 and 10), which used to draft a milestone.
    if (!seeded) await seedPeople();
    expect(crossed(await metricValues(env, db(), Date.now(), Date.now() - MILESTONE_WINDOW_MS)).length).toBeGreaterThan(0);
    for (const d of MILESTONE_DAYS) {
      const r = (await json(`/api/v1/social/drafts?date=${d}`)) as { drafts: { type: string; texts: string[] }[] };
      expect(r.drafts.map((x) => x.type), d).not.toContain("milestone");
      for (const x of r.drafts) for (const text of x.texts) expect(text).not.toMatch(/outside our team|from outside|outside agents/i);
    }
    // F-01: Tuesday's board post (no longer replaced) says what its rates pool, in every wording.
    const tue = (await json(`/api/v1/social/drafts?date=${MILESTONE_DAYS[0]}`)) as { drafts: { type: string; texts: string[]; facts: { numbers: number[] } }[] };
    const board = tue.drafts.find((x) => x.type === "board-change");
    expect(board?.texts.length).toBe(4);
    for (const text of board!.texts) expect(text).toMatch(/\d[\d,]* practice and \d[\d,]* ranked bouts, rules 0\.2–0\.\d\./);
    expect(board!.facts.numbers).toEqual(expect.arrayContaining([0.2, 0.4]));
  });

  it("the private callers are exactly the digest and Scout workflows on main in the private repo", () => {
    const claims = (file: string, over: Record<string, unknown> = {}) =>
      ({ repository: "theagentforge/forge", repository_id: HOUSE_REPOS["theagentforge/forge"], job_workflow_ref: `theagentforge/forge/.github/workflows/${file}@refs/heads/main`, ref: "refs/heads/main", ...over }) as unknown as OidcClaims;
    expect(internalStatsCaller(claims("ops-digest.yml"))).toBe(true);
    expect(internalStatsCaller(claims("scout-collect.yml"))).toBe(true);
    expect(internalStatsCaller(claims("moltbook.yml"))).toBe(false);
    expect(internalStatsCaller(claims("ops-digest.yml", { ref: "refs/heads/feature" }))).toBe(false);
    expect(internalStatsCaller(claims("ops-digest.yml", { repository: "theagentforge/agent-forge" }))).toBe(false);
  });

  it("every gross label says it includes our own; old JSON fields stay, null, and are listed as internal", async () => {
    for (const r of GROSS_RULES) {
      expect(r.label, r.key).toMatch(/included/);
      expect(r.label, r.key).not.toMatch(/outside|independent|third[- ]party|by other agents/i);
      // ADR 0099: the people and agent rows have a published minimum; the 7-day numbers have none.
      expect(r.minimum).toBe(r.key === "signed_in_people" || r.key === "signed_in_agents" ? 50 : null);
    }
    const stats = (await json("/stats.json")) as Record<string, unknown> & { internal_only: string[] };
    for (const k of ["now", "history", "usage", "skill_checks", "agent_funnel"]) {
      expect(stats).toHaveProperty(k, null);
      expect(stats.internal_only).toContain(k);
    }
    const api = (await json("/api/v1/stats")) as Record<string, unknown> & { internal_only: string[] };
    for (const k of ["humans", "verified_humans", "agents", "reports", "reports_last_24h", "tool_versions_reported"]) {
      expect(api).toHaveProperty(k, null);
      expect(api.internal_only).toContain(k);
    }
    const growth = (await json("/api/v1/growth")) as Record<string, unknown> & { internal_only: string[] };
    for (const k of ["mcp_tool_calls_7d", "agent_funnel_7d", "gauntlet_claims_7d", "badge_sites_7d", "skill_scans_7d"]) {
      expect(growth).toHaveProperty(k, null);
      expect(growth.internal_only).toContain(k);
    }
    expect(typeof growth.claims).toBe("number");
    const about = await get("/about");
    expect(about).toContain("with every number's counting rule");
    expect(about).not.toContain("outside and in-house activity counted separately");
  });

  it("the wording guard catches an adoption claim next to a number, and no public page or JSON makes one", async () => {
    expect(adoptionClaims("Trusted by 40 agents")).toHaveLength(1);
    expect(adoptionClaims("join 1,200 owners today")).toHaveLength(1);
    expect(adoptionClaims("A community of 300 builders")).toHaveLength(1);
    expect(adoptionClaims("12 outside agents checked a tool")).toHaveLength(1);
    expect(adoptionClaims("Join the list")).toEqual([]);
    expect(adoptionClaims("Join the list Numbers go 1 to 100")).toEqual([]);
    expect(adoptionClaims("used by your agent before an install")).toEqual([]);
    for (const path of PUBLIC_HTML) expect(adoptionClaims(pageText(await get(path))), path).toEqual([]);
    for (const path of PUBLIC_JSON) expect(adoptionClaims(jsonText(await json(path))), path).toEqual([]);
  });

  it(`/founding shows no list and no number until ${FOUNDING_LIST_OPENS_AT} owners have opted in, then shows it`, async () => {
    const owners: string[] = [];
    const handles: string[] = [];
    const add = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const id = uid("fo");
        const login = uid("founder-login");
        await db().insert(t.humans).values({ id, githubId: 900_000_000 + owners.length, githubLogin: login, githubCreatedAt: 0, tier: "verified", ownerSince: Date.now(), ownerNumber: owners.length + 1, foundingAt: Date.now() });
        const handle = uid("fagent");
        await db().insert(t.agents).values({ id: uid("fa"), humanId: id, handle, framework: "claude-code", oauthClientId: uid("c") });
        owners.push(login);
        handles.push(handle);
      }
    };
    await add(3);
    const closed = await get("/founding");
    const list = closed.slice(closed.indexOf('id="list-h"'));
    expect(list).toContain("Founding owners will be listed here");
    // ADR 0104: "opening soon", never the threshold (it would be a count of outside owners).
    expect(list).toContain("The list is opening soon.");
    expect(closed).not.toMatch(/opens at \d+/);
    for (const l of owners) expect(closed).not.toContain(`@${l}`);
    expect(list).not.toContain("<table");
    expect(list).not.toMatch(/\b3\b/);
    const cj = (await json("/founding?format=json")) as { owners: unknown; list_open: boolean; list_status: string; internal_only: string[] };
    expect(cj.owners).toBeNull();
    expect(cj.list_status).toBe("opening_soon");
    expect(cj).not.toHaveProperty("list_opens_at");
    expect(cj.list_open).toBe(false);
    expect(cj.internal_only).toEqual(["owners"]);
    // The "Founding owner #n" number is a rank among outside owners: hidden on the agent page, its JSON, the owner
    // share page and its card text until the list opens; a plain "Founding owner" badge shows instead.
    for (const h of handles) {
      const page = await get(`/a/${h}`);
      expect(page).toContain(">Founding owner</a>");
      expect(page).not.toMatch(/Founding owner #\d/);
      const aj = (await json(`/a/${h}`)) as { founding_owner: { number: number | null; label: string } };
      expect(aj.founding_owner).toMatchObject({ number: null, label: "Founding owner" });
      expect(await get(`/owner/${h}`)).not.toMatch(/Founding owner #\d/);
    }
    await add(FOUNDING_LIST_OPENS_AT - 3);
    // Once the list is open, the numbers show.
    expect(await get(`/a/${handles[0]}`)).toContain(">Founding owner #1</a>");
    expect(((await json(`/a/${handles[1]}`)) as { founding_owner: { number: number } }).founding_owner.number).toBe(2);
    const open = await get("/founding");
    for (const l of owners) expect(open).toContain(`@${l}`);
    const oj = (await json("/founding?format=json")) as { owners: { github: string }[]; list_open: boolean };
    expect(oj.list_open).toBe(true);
    expect((oj as unknown as { list_status: string }).list_status).toBe("open");
    expect(oj.owners.map((o) => o.github)).toEqual(owners);
  });
});
