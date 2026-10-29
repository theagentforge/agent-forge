import { and, count, countDistinct, eq, gte, inArray, isNull, like, lt, lte, ne, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { agentFunnel, outsidePeople } from "./agent-funnel";
import { HARD3_2_TASKS, HARD3_TASKS, HARD_TASKS, PRIVATE_FAMILIES, PRIVATE_TASK_IDS, TASKS } from "@forge/arena";
import { getDb } from "./db";
import { ownerFunnel } from "./owner-funnel";
import { ownerActivity, ownersBySource } from "./owners";

// The growth KPIs (ADR 0039; ADR 0050 renamed the conversion KPI and added outside tool calls). Thirteen numbers, each with an exact
// definition, today's value and its two targets (a first and a second). Internal only: /admin/kpis, Forge
// Scout and the Monday digest. Never on public pages (Dinike, 23 Oct: no real-people numbers on the site).
//
// Privacy (Privacy Policy, the one-day code): an anonymous agent is a keyed hash that changes every UTC day, so it can
// be counted per day but never followed across days. The north star is therefore "agent-days": the sum over 7 days of
// each day's distinct agents that ran a check, scan, watch check-in or Gauntlet. Retention across days is measured
// only for signed-in agents (they have accounts), plus two anonymous proxies.

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Kinds of check source that are agents (web checks are people on the site). */
const AGENT_KINDS = ["mcp", "api", "plugin", "cli", "ci"] as const;

export type KpiStatus = "below" | "first" | "second" | "untracked";

export interface Kpi {
  id: string;
  name: string;
  value: number | null;
  /** Shown next to the value: "a week", "%", "per 100 people"... */
  unit: string;
  first: number | null;
  second: number | null;
  status: KpiStatus;
  definition: string;
  detail?: Record<string, unknown>;
}

/** Third-party listings (KPI 8). Statuses change as reviews land; review-watch keeps them current. */
export const DISTRIBUTION: { name: string; url: string; status: "live" | "pending" | "rejected" | "blocked" }[] = [
  { name: "Claude Code plugin (our marketplace)", url: "https://theagentforge.io/marketplace.json", status: "live" },
  { name: "npm CLI (@theagentforge/cli)", url: "https://www.npmjs.com/package/@theagentforge/cli", status: "live" },
  { name: "Agent Plugins package (forge-mcp)", url: "https://github.com/theagentforge/forge-mcp", status: "live" },
  { name: "OpenClaw skill repo (forge-check-before-install)", url: "https://github.com/theagentforge/forge-check-before-install", status: "live" },
  { name: "Docker MCP Catalog", url: "https://github.com/docker/mcp-registry/pull/5974", status: "pending" },
  { name: "Cline MCP Marketplace", url: "https://github.com/cline/mcp-marketplace/issues/3176", status: "pending" },
  { name: "GitHub MCP Registry", url: "https://github.com/github/github-mcp-server/discussions/1257", status: "pending" },
  { name: "Claude plugin directory", url: "https://claude.ai/directory", status: "pending" },
  { name: "Claude connector directory", url: "https://claude.ai/directory", status: "pending" },
  { name: "awesome-remote-mcp-servers", url: "https://github.com/punkpeye/awesome-remote-mcp-servers/pull/2630", status: "live" },
  { name: "Grok Build marketplace", url: "https://github.com/xai-org/plugin-marketplace/pull/1626", status: "pending" },
  { name: "Kiro powers", url: "https://kiro.dev/powers/", status: "pending" },
  { name: "Cursor Marketplace", url: "https://cursor.com/marketplace", status: "pending" },
  { name: "ClawHub", url: "https://clawhub.ai", status: "pending" },
  { name: "awesome-copilot", url: "https://github.com/github/awesome-copilot/issues/5306", status: "rejected" },
  { name: "PulseMCP (submissions paused)", url: "https://www.pulsemcp.com/submit", status: "blocked" },
];

/** KV lists kept by hand on /admin/kpis: citations (KPI 7) and partner conversations (KPI 11, organisations only). */
export const CITATIONS_KV = "kpi:citations";
export const PARTNERS_KV = "kpi:partners";
export interface Citation {
  url: string;
  title: string;
  date: string;
}
export const PARTNER_STAGES = ["researched", "contacted", "replied", "met", "using", "inbound"] as const;
export type PartnerStage = (typeof PARTNER_STAGES)[number];
export interface PartnerContact {
  org: string;
  stage: PartnerStage;
  date: string;
}
/** A partner counts as engaged once they've answered: replied, met, using our data, or came to us. */
export const ENGAGED: PartnerStage[] = ["replied", "met", "using", "inbound"];

function status(value: number | null, first: number | null, second: number | null, lowerIsBetter = false): KpiStatus {
  if (value === null || first === null || second === null) return "untracked";
  const ge = (a: number, b: number) => (lowerIsBetter ? a <= b : a >= b);
  return ge(value, second) ? "second" : ge(value, first) ? "first" : "below";
}

const kpi = (k: Omit<Kpi, "status">, lowerIsBetter = false): Kpi => ({ ...k, status: status(k.value, k.first, k.second, lowerIsBetter) });

/** Distinct agent sources per UTC day for the `days` full days before `now`'s day, oldest first. */
export async function agentDaysSeries(env: Env, now = Date.now(), days = 14) {
  const db = getDb(env);
  const first = day(now - days * DAY);
  const last = day(now - DAY);
  const rows = await db
    .select({ day: t.checkSources.day, n: countDistinct(t.checkSources.source) })
    .from(t.checkSources)
    .where(and(gte(t.checkSources.day, first), lte(t.checkSources.day, last), eq(t.checkSources.isHouse, false), inArray(t.checkSources.kind, [...AGENT_KINDS])))
    .groupBy(t.checkSources.day);
  return Array.from({ length: days }, (_, i) => {
    const d = day(now - (days - i) * DAY);
    return { day: d, agents: Number(rows.find((r) => r.day === d)?.n ?? 0) };
  });
}

/**
 * Retention for signed-in agents of people outside the project: of the agents created in the week that ended 28 days
 * ago, the share active (a check or a report) in the last 7 days. Null when that cohort is empty.
 */
async function signedInRetention(env: Env, now: number) {
  const db = getDb(env);
  const outside = outsidePeople(env);
  const cohort = await db
    .select({ id: t.agents.id })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, gte(t.agents.createdAt, now - 35 * DAY), lt(t.agents.createdAt, now - 28 * DAY)));
  if (!cohort.length) return { cohort: 0, active: 0, rate: null as number | null };
  const ids = cohort.map((c) => c.id);
  const checked = await db
    .select({ id: t.checkSources.source })
    .from(t.checkSources)
    .where(and(inArray(t.checkSources.source, ids), gte(t.checkSources.day, day(now - 7 * DAY))));
  const reported = await db
    .select({ id: t.reports.agentId })
    .from(t.reports)
    .where(and(inArray(t.reports.agentId, ids), gte(t.reports.createdAt, now - 7 * DAY)));
  const active = new Set([...checked.map((r) => r.id), ...reported.map((r) => r.id)]).size;
  return { cohort: ids.length, active, rate: Math.round((active / ids.length) * 1000) / 10 };
}

/** Sum of usage counters with these exact keys or prefixes over the last `days` full days. */
async function counters(env: Env, now: number, days: number, keys: string[], prefixes: string[] = []) {
  const db = getDb(env);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, day(now - days * DAY)), lte(t.usageDaily.day, day(now - DAY)), or(inArray(t.usageDaily.key, keys), ...prefixes.map((p) => like(t.usageDaily.key, `${p}%`)))))
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  const pre = (p: string) => rows.filter((r) => r.key.startsWith(p)).reduce((a, r) => a + Number(r.n), 0);
  return { get, pre };
}

/** `AND <column> NOT IN (founder ids)`, or nothing when no founder ids are set. */
function founderClause(env: Pick<Env, "ADMIN_GITHUB_IDS">, column: ReturnType<typeof sql>) {
  const ids = (env.ADMIN_GITHUB_IDS ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
  return ids.length ? sql`AND ${column} NOT IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})` : sql``;
}

/** The twelve growth KPIs as of `now` (windows are full UTC days before today, so a re-run gives the same). */
export async function growthKpis(env: Env, now = Date.now()): Promise<{ as_of: string; kpis: Kpi[] }> {
  const db = getDb(env);
  const outside = outsidePeople(env);
  const series = await agentDaysSeries(env, now, 14);
  const agentDays = series.slice(-7).reduce((a, d) => a + d.agents, 0);
  const prevAgentDays = series.slice(0, 7).reduce((a, d) => a + d.agents, 0);

  const funnel = await agentFunnel(env, now - DAY, 7);
  const funnelYesterday = await agentFunnel(env, now - DAY, 1);
  const retention = await signedInRetention(env, now);

  const [verified] = await db
    .select({ agents: count(t.agents.id), humans: countDistinct(t.agents.humanId) })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, eq(t.agents.status, "active"), eq(t.humans.tier, "verified")));
  // KPI 3, new per week (K5): active agents of verified people outside the project, by the week they connected.
  const newRows = await db
    .select({ createdAt: t.agents.createdAt })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, eq(t.agents.status, "active"), eq(t.humans.tier, "verified"), gte(t.agents.createdAt, now - 28 * DAY)));
  const newByWeek = [3, 2, 1, 0].map((w) => ({
    week_from: day(now - (w + 1) * 7 * DAY),
    agents: newRows.filter((r) => r.createdAt >= now - (w + 1) * 7 * DAY && r.createdAt < now - w * 7 * DAY).length,
  }));
  // Every signed-in agent of people outside the project, sandbox included: verified agents are the subset above.
  const [signedIn] = await db
    .select({ n: count() })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, eq(t.agents.status, "active")));

  const c7 = await counters(env, now, 7, ["scan:api", "watch:calls", "a2a:requests", "visit:arrivals", "visit:all", "visit:crawler", "visit:human"], ["mcp:tool:", "visit:tag:", "visit:src:"]);
  const checksScans = c7.get("mcp:tool:forge_check") + c7.get("mcp:tool:forge_scan") + c7.get("mcp:tool:forge_watch") + c7.get("scan:api");
  const [apiChecks] = await db
    .select({ n: count() })
    .from(t.checkSources)
    .where(and(gte(t.checkSources.day, day(now - 7 * DAY)), lte(t.checkSources.day, day(now - DAY)), eq(t.checkSources.isHouse, false), inArray(t.checkSources.kind, ["api", "plugin", "cli", "ci"])));

  const [reports7] = await db
    .select({ n: count(), owners: countDistinct(t.reports.humanId) })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(outside, gte(t.reports.createdAt, now - 7 * DAY)));

  // V1 (ADR 0047): corroboration. Of shown reports from people outside the project in the last 30 days, the share
  // with at least one confirm from a different verified owner outside the project (whose own report isn't held).
  const recentReports = await db
    .select({ id: t.reports.id })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(outside, eq(t.reports.held, false), gte(t.reports.createdAt, now - 30 * DAY)));
  const verdictRows = recentReports.length
    ? await db.all<{ report_id: string; verdict: string; owners: number }>(sql`
        SELECT v.report_id AS report_id, v.verdict AS verdict, COUNT(DISTINCT v.human_id) AS owners
        FROM report_verdicts v
        JOIN humans h ON h.id = v.human_id
        JOIN reports r ON r.id = v.report_id
        JOIN reports b ON b.id = v.by_report_id
        WHERE h.tier = 'verified' AND h.is_house = 0 ${founderClause(env, sql`h.github_id`)} AND b.held = 0 AND v.human_id <> r.human_id
          AND r.held = 0 AND r.created_at >= ${now - 30 * DAY}
        GROUP BY v.report_id, v.verdict`)
    : [];
  const confirmedIds = new Set(verdictRows.filter((r) => r.verdict === "confirm").map((r) => r.report_id));
  const recentIds = new Set(recentReports.map((r) => r.id));
  const confirmed30 = [...confirmedIds].filter((id) => recentIds.has(id)).length;
  const corroborated30 = verdictRows.filter((r) => r.verdict === "confirm" && Number(r.owners) >= 2 && recentIds.has(r.report_id)).length;
  const c7v = await counters(env, now, 7, ["verdict:confirm", "verdict:dispute", "gauntlet:claim"]);
  // ADR 0048: opt-in claims of Gauntlet runs by owners outside the project (House and founders left out, as elsewhere).
  const [claims] = await db
    .select({ n: count(), recent: sql<number>`sum(case when ${t.gauntletClaims.claimedAt} >= ${now - 30 * DAY} then 1 else 0 end)` })
    .from(t.gauntletClaims)
    .innerJoin(t.humans, eq(t.gauntletClaims.humanId, t.humans.id))
    // Review (ADR 0084): six-job runs only; a Sprint claim isn't a Gauntlet run claim.
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .where(and(outside, eq(t.arenaGauntlets.mode, "full")));

  const [ranked30] = await db
    .select({ n: count() })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaRuns.eventId, t.arenaEvents.id))
    .where(and(inArray(t.arenaEvents.kind, ["card", "guest"]), eq(t.arenaRuns.status, "done"), gte(t.arenaRuns.finishedAt, now - 30 * DAY), isNull(t.arenaEvents.arm)));
  const [models] = await db
    .select({ n: countDistinct(t.arenaRuns.modelId) })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaRuns.eventId, t.arenaEvents.id))
    .where(and(inArray(t.arenaEvents.kind, ["card", "guest"]), eq(t.arenaRuns.status, "done"), isNull(t.arenaEvents.arm)));
  // ADR 0083: six-job runs only; Sprints are never counted as Gauntlet runs.
  const [gauntlets] = await db.select({ n: count() }).from(t.arenaGauntlets).where(and(gte(t.arenaGauntlets.startedAt, now - 30 * DAY), eq(t.arenaGauntlets.mode, "full")));
  const [gauntletsDone] = await db
    .select({ n: count() })
    .from(t.arenaGauntlets)
    .where(and(gte(t.arenaGauntlets.startedAt, now - 30 * DAY), ne(t.arenaGauntlets.status, "open"), eq(t.arenaGauntlets.mode, "full")));

  const citations = (await env.KV.get<Citation[]>(CITATIONS_KV, "json")) ?? [];
  const partners = (await env.KV.get<PartnerContact[]>(PARTNERS_KV, "json")) ?? [];
  const engagedOrgs = new Set(partners.filter((b) => ENGAGED.includes(b.stage)).map((b) => b.org.toLowerCase())).size;

  const people = c7.get("visit:human");
  const per100 = (x: number) => (people > 0 ? Math.round((x / people) * 1000) / 10 : null);
  // ADR 0050: the funnel's "connected" leaves monitors out; the old reading (monitors in) stays in the detail.
  const connections = funnel.stages.connected;
  const connectionsWithMonitors = connections + funnel.detail.monitor_sessions;
  const tagged = c7.pre("visit:tag:");

  const live = DISTRIBUTION.filter((d) => d.status === "live").length;
  // ADR 0055 (D11): owners first. The funnel from a finished Gauntlet run to a verified owner.
  const owners = await ownerFunnel(env, now);
  // ADR 0073 (OA-01): whether owners stay, and where they came from.
  const activity = await ownerActivity(env, now, 30);
  const sources = await ownersBySource(env, now, 30);
  const [pendingClaims] = await db.select({ n: count(), people: countDistinct(t.pendingClaims.humanId) }).from(t.pendingClaims);
  const [reviewsOpen] = await db.select({ n: count() }).from(t.ownerReviewRequests).where(isNull(t.ownerReviewRequests.decision));

  const kpis: Kpi[] = [
    kpi({
      id: "north_star",
      name: "Weekly active agent-days (north star)",
      value: agentDays,
      unit: "agent-days in 7 days",
      first: 500,
      second: 5000,
      definition:
        "For each of the last 7 full UTC days, distinct agents that ran a check, scan, watch check-in or Gauntlet (MCP, A2A, API, plugin, CLI, CI; one-day code), summed. House, our own probes (tagged, K7) and people on the website left out.",
      detail: {
        previous_7_days: prevAgentDays,
        change_pct: prevAgentDays ? Math.round(((agentDays - prevAgentDays) / prevAgentDays) * 1000) / 10 : null,
        daily: series,
        /** Requests by our own probes in the funnel's window, by component (K7): left out of every number above. */
        internal_left_out: funnel.detail.internal_by_component,
      },
    }),
    kpi({
      id: "retention",
      name: "4-week retention (signed-in agents)",
      value: retention.rate,
      unit: "%",
      first: 15,
      second: 25,
      definition: "Of signed-in agents (people outside the project) created 28–35 days ago, the share that ran a check or filed a report in the last 7 days.",
      detail: { cohort: retention.cohort, active: retention.active, proxy_client_apps_on_2plus_days: funnel.detail.mcp_client_apps_on_2plus_days, proxy_watch_checkins: funnel.stages.returned },
    }),
    kpi({
      id: "verified_agents",
      name: "Human-verified agents",
      value: Number(verified?.agents ?? 0),
      unit: "active agents",
      first: 1000,
      second: 10000,
      definition:
        "Active agents connected through GitHub sign-in whose owner is a verified person outside the project (not House, not a founder), cumulative; new per week by the week the agent connected.",
      detail: {
        humans: Number(verified?.humans ?? 0),
        agents_per_human: verified?.humans ? Math.round((Number(verified.agents) / Number(verified.humans)) * 10) / 10 : null,
        new_in_7_days: newByWeek.at(-1)!.agents,
        new_by_week: newByWeek,
        signed_in_agents_any_tier: Number(signedIn?.n ?? 0),
      },
    }),
    kpi({
      id: "checks",
      name: "Checks and scans a week",
      value: checksScans + Number(apiChecks?.n ?? 0),
      unit: "in 7 days",
      first: 5000,
      second: 50000,
      definition: "forge_check, forge_scan and forge_watch calls over MCP, API scans, and distinct API/plugin/CLI/CI checkers per day, in the last 7 full days.",
      detail: { mcp_and_api_calls: checksScans, api_plugin_cli_ci_checkers: Number(apiChecks?.n ?? 0) },
    }),
    kpi({
      id: "contributions",
      name: "Field reports a week (outside the project)",
      value: Number(reports7?.n ?? 0),
      unit: "in 7 days",
      first: 50,
      second: 500,
      definition: "Reports filed in the last 7 days by agents of people outside the project.",
      detail: {
        distinct_owners: Number(reports7?.owners ?? 0),
        /** V1: share of the last 30 days' reports (outside the project) confirmed by at least one other verified owner. */
        corroboration: {
          reports_30_days: recentReports.length,
          confirmed_by_another_owner: confirmed30,
          rate_pct: recentReports.length ? Math.round((confirmed30 / recentReports.length) * 1000) / 10 : null,
          corroborated_2plus_owners: corroborated30,
          verdicts_7_days: { confirm: c7v.get("verdict:confirm"), dispute: c7v.get("verdict:dispute") },
        },
      },
    }),
    kpi({
      id: "results",
      name: "Gauntlet runs (30 days)",
      value: Number(gauntlets?.n ?? 0),
      unit: "in 30 days",
      first: 100,
      second: 1000,
      definition: "Gauntlet runs started in the last 30 days (any agent; our install tests included, so read with the detail).",
      detail: {
        finished: Number(gauntletsDone?.n ?? 0),
        ranked_bouts_30_days: Number(ranked30?.n ?? 0),
        ranked_models_all_time: Number(models?.n ?? 0),
        /** ADR 0048: runs claimed by owners outside the project (all time, last 30 days) and the 7-day counter. */
        gauntlet_claims: { total: Number(claims?.n ?? 0), last_30_days: Number(claims?.recent ?? 0), counted_7_days: c7v.get("gauntlet:claim") },
      },
    }),
    kpi({
      id: "citations",
      name: "Independent citations",
      value: citations.length,
      unit: "in total",
      first: 3,
      second: 15,
      definition: "Articles, papers and lab or vendor posts by others that cite our results (logged on /admin/kpis; Forge Scout proposes new ones).",
      detail: { latest: citations.slice(-5) },
    }),
    kpi({
      id: "distribution",
      name: "Live listings",
      value: live,
      unit: "live",
      first: 12,
      second: 20,
      definition: "Places agents can install or find The Forge that are live now (our own marketplaces included).",
      detail: { pending: DISTRIBUTION.filter((d) => d.status === "pending").length, listings: DISTRIBUTION },
    }),
    kpi({
      id: "conversion_agents",
      name: "Agent connections per 100 people",
      value: per100(connections),
      unit: "per 100",
      first: 8,
      second: 12,
      definition:
        "MCP sessions from apps that use tools, plus A2A requests, per 100 real people on the site (browsers that ran site.js), last 7 days. Left out: directory health checks, our own probes, House, and monitors (client names with sessions but no tool call under their name in 7 days; agent apps whose calls can't carry their name, such as claude.ai, are never monitors). Replaced \"conversion\" on 26 Oct (ADR 0050).",
      detail: {
        connections,
        people,
        connect_tests_passed: funnel.detail.connect_tests_passed,
        monitors_and_catalogs: funnel.detail.monitors_and_catalogs,
        /** The retired "conversion" KPI's reading (connections with monitors), for comparison. */
        previous_definition: { id: "conversion", connections: connectionsWithMonitors, value: per100(connectionsWithMonitors) },
      },
    }),
    kpi({
      id: "outside_tool_calls",
      name: "Tool calls from outside clients",
      value: funnel.detail.outside_tool_calls,
      unit: "in 7 days",
      first: 350,
      second: 3500,
      definition:
        "MCP tool calls on our three endpoints plus A2A requests, last 7 full days. Left out: House, our own probes (tagged, K7), and calls made under the name of a directory, catalogue, checker or monitor. The honest demand number (ADR 0050); targets 50 and 500 a day, proposed.",
      detail: {
        yesterday: funnelYesterday.detail.outside_tool_calls,
        per_100_people: per100(funnel.detail.outside_tool_calls),
        mcp_tool_calls_all: funnel.detail.tool_calls,
        a2a_requests: funnel.detail.a2a_requests,
        monitors_and_catalogs: funnel.detail.monitors_and_catalogs,
        house_left_out: { sessions: funnel.detail.house_mcp_sessions },
        internal_left_out: funnel.detail.internal_by_component,
      },
    }),
    kpi({
      id: "virality",
      name: "Arrivals from shared links (7 days)",
      value: tagged,
      unit: "in 7 days",
      first: 2500,
      second: 25000,
      definition: "People arriving from a tagged link (?from=…: X, Moltbook, badges, embeds), last 7 days. Monthly targets: 10K and 100K.",
      detail: { all_arrivals: c7.get("visit:arrivals"), page_views: c7.get("visit:all"), crawler_page_views: c7.get("visit:crawler") },
    }),
    kpi({
      id: "partners",
      name: "Engaged partner organisations",
      value: engagedOrgs,
      unit: "organisations",
      first: 5,
      second: 15,
      definition: "Organisations on the partner list that replied, met, use our data or came to us (logged on /admin/kpis; organisations only, no personal names).",
      detail: { by_stage: Object.fromEntries(PARTNER_STAGES.map((s) => [s, partners.filter((b) => b.stage === s).length])) },
    }),
    kpi({
      id: "verified_owners",
      name: "Verified owners (D11)",
      value: owners.verified_owners,
      unit: "owners",
      first: 100,
      second: 1000,
      definition:
        "Verified people outside the project (not House, not a founder) with at least one active agent, cumulative. First target 100 by 31 Dec 2026 (D11); second proposed. Keep agents per owner close to 1. Detail: the owner funnel for the last 30 full days (runs finished, claim link shown, claim page opened, claimed, verified owners who claimed) and Season 1 entrants (ADR 0055).",
      detail: owners as unknown as Record<string, unknown>,
    }),
    kpi({
      id: "active_owners",
      name: "Active owners (30 days)",
      value: activity.active,
      unit: "owners",
      first: 25,
      second: 100,
      definition: `${activity.definition} Report it next to verified owners (D12, 28 Oct): it's the smaller, more honest number. Targets proposed.`,
      detail: { ...activity, pending_claims: Number(pendingClaims?.n ?? 0), pending_claim_people: Number(pendingClaims?.people ?? 0), review_requests_open: Number(reviewsOpen?.n ?? 0) },
    }),
    kpi({
      id: "owners_by_source",
      name: "New owners by source (30 days)",
      value: sources.total,
      unit: "new owners",
      first: 25,
      second: 100,
      definition:
        "People who became owners for the first time in the last 30 full UTC days, by the first `from` tag they arrived with (founding, connect, plugin, cli, action, clawhub, skills-sh, maintainer, badge, score, hackathon:<slug>; anything else or none is \"other\"). Daily counters owner:new:<from>, written once per person. House and founder accounts never count. A rough guide: one person may see several links before signing in.",
      detail: sources as unknown as Record<string, unknown>,
    }),
    kpi({
      id: "company_readiness",
      name: "Company readiness",
      value: null,
      unit: "",
      first: null,
      second: null,
      definition: "Company, IP, Terms licence, security record. Parked for now (Dinike, 23 Oct).",
    }),
  ];
  return { as_of: day(now - DAY), kpis };
}

/** The numeric KPIs, for the daily snapshot (proof_snapshots, metric "kpi_<id>"). */
export function kpiSnapshotValues(kpis: Kpi[]) {
  return Object.fromEntries(kpis.filter((k) => k.value !== null).map((k) => [`kpi_${k.id}`, k.value as number]));
}

// --- Dataset inventory (ADR 0040) ------------------------------------------------------------------------------------
// What we hold that's hard to recreate: refereed task environments, calibrated across models, and the trajectories,
// failures, field reports and scans they produced. Internal (/admin/kpis, Scout, the daily snapshot).

/** Contamination and rights controls (ADR 0040 §3). Flip each to true in the change that builds it. */
export const DATA_CONTROLS = {
  /** A held-out seed split that is never published, scored apart from the public one (ADR 0058). */
  private_holdout: true,
  /** A canary string in every published dataset file and replay, so training-set leaks can be detected (ADR 0058). */
  canary_in_published_data: true,
  /** Referee tests in which an adversarial agent tries to game the end state (reward hacking). */
  verifier_hacking_tests: true, // ADR 0049 suite, run in CI on every push; why it counts: ADR 0054
  /** Personal fields (GitHub logins) pseudonymised in any exported dataset: the AQ-03 bulk export (ADR 0095). */
  exports_pseudonymised: true,
};

export interface DataInventory {
  environments: { task_families: number; job_versions: number; tiers: string[] };
  refereed_runs: { total: number; ranked: number; models: number; with_trap_fall: number; last_30_days: number; freshness_pct: number | null };
  calibration: { tasks_measured: number; tasks_in_band: number; band: string; per_task: { task: string; n: number; pass_rate: number }[] };
  external_runs: { gauntlet_finished: number; proving_ground_finished: number };
  field_reports: { total: number; external: number; tools_covered: number };
  scans: { unique_skills: number; public: number };
  controls: typeof DATA_CONTROLS;
}

/** Counts of the dataset we hold now. Calibration: ranked tasks with at least 6 runs and a pass rate inside 3–97%. */
export async function dataInventory(env: Env, now = Date.now()): Promise<DataInventory> {
  const db = getDb(env);
  const outside = outsidePeople(env);
  const ranked = and(inArray(t.arenaEvents.kind, ["card", "guest"]), eq(t.arenaRuns.status, "done"), isNull(t.arenaEvents.arm));
  const [all] = await db.select({ n: count() }).from(t.arenaRuns).where(eq(t.arenaRuns.status, "done"));
  const [recent] = await db.select({ n: count() }).from(t.arenaRuns).where(and(eq(t.arenaRuns.status, "done"), gte(t.arenaRuns.finishedAt, now - 30 * DAY)));
  const [r] = await db
    .select({ n: count(), models: countDistinct(t.arenaRuns.modelId) })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaRuns.eventId, t.arenaEvents.id))
    .where(ranked);
  const [falls] = await db
    .select({ n: count() })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaRuns.eventId, t.arenaEvents.id))
    .where(and(ranked, sql`exists (select 1 from json_each(${t.arenaRuns.result}, '$.traps') where json_extract(value, '$.triggered') = 1)`));
  const perTask = await db
    .select({ task: t.arenaRuns.task, n: count(), passed: sql<number>`sum(case when ${t.arenaRuns.passed} then 1 else 0 end)` })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaRuns.eventId, t.arenaEvents.id))
    .where(ranked)
    .groupBy(t.arenaRuns.task);
  const measured = perTask.filter((x) => Number(x.n) >= 6).map((x) => ({ task: x.task, n: Number(x.n), pass_rate: Math.round((Number(x.passed) / Number(x.n)) * 1000) / 10 }));
  const [g] = await db.select({ n: count() }).from(t.arenaGauntlets).where(and(ne(t.arenaGauntlets.status, "open"), eq(t.arenaGauntlets.mode, "full")));
  const [pg] = await db.select({ n: count() }).from(t.arenaPgAttempts).where(eq(t.arenaPgAttempts.status, "done"));
  const [reps] = await db.select({ n: count(), tools: countDistinct(t.reports.toolVersionId) }).from(t.reports);
  const [ext] = await db.select({ n: count() }).from(t.reports).innerJoin(t.humans, eq(t.reports.humanId, t.humans.id)).where(outside);
  const [sc] = await db.select({ n: count(), pub: sql<number>`sum(case when ${t.skillScans.public} then 1 else 0 end)` }).from(t.skillScans);
  const total = Number(all?.n ?? 0);
  return {
    // Private families (ADR 0057) count here (admin only) and stay off every public page.
    environments: {
      task_families: TASKS.length + Object.keys(PRIVATE_FAMILIES).length,
      job_versions: TASKS.length + HARD_TASKS.length + HARD3_TASKS.length + HARD3_2_TASKS.length + PRIVATE_TASK_IDS.length,
      tiers: ["Normal", "Hard v2", "Hard v3", "Hard v3.2", ...(PRIVATE_TASK_IDS.length ? ["Private 1.0"] : [])],
    },
    refereed_runs: {
      total,
      ranked: Number(r?.n ?? 0),
      models: Number(r?.models ?? 0),
      with_trap_fall: Number(falls?.n ?? 0),
      last_30_days: Number(recent?.n ?? 0),
      freshness_pct: total ? Math.round((Number(recent?.n ?? 0) / total) * 1000) / 10 : null,
    },
    calibration: { tasks_measured: measured.length, tasks_in_band: measured.filter((x) => x.pass_rate >= 3 && x.pass_rate <= 97).length, band: "3–97% pass", per_task: measured },
    external_runs: { gauntlet_finished: Number(g?.n ?? 0), proving_ground_finished: Number(pg?.n ?? 0) },
    field_reports: { total: Number(reps?.n ?? 0), external: Number(ext?.n ?? 0), tools_covered: Number(reps?.tools ?? 0) },
    scans: { unique_skills: Number(sc?.n ?? 0), public: Number(sc?.pub ?? 0) },
    controls: DATA_CONTROLS,
  };
}

/** The numbers worth keeping daily (proof_snapshots, metric "data_<name>"). */
export function dataSnapshotValues(d: DataInventory): Record<string, number> {
  return {
    data_refereed_runs: d.refereed_runs.total,
    data_ranked_runs: d.refereed_runs.ranked,
    data_trap_falls: d.refereed_runs.with_trap_fall,
    data_models: d.refereed_runs.models,
    data_tasks_in_band: d.calibration.tasks_in_band,
    data_field_reports: d.field_reports.total,
    data_unique_skills: d.scans.unique_skills,
    data_controls_on: Object.values(d.controls).filter(Boolean).length,
  };
}
