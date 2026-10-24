import { and, count, countDistinct, eq, gte, inArray, isNull, like, lt, lte, ne, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { agentFunnel, outsidePeople } from "./agent-funnel";
import { HARD3_TASKS, HARD_TASKS, TASKS } from "@forge/arena";
import { getDb } from "./db";

// The growth KPIs (ADR 0039). Twelve numbers, each with an exact
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
  { name: "Claude Code plugin (our marketplace)", url: "https://theagentforge.io/plugins", status: "live" },
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

/** The twelve growth KPIs as of `now` (windows are full UTC days before today, so a re-run gives the same). */
export async function growthKpis(env: Env, now = Date.now()): Promise<{ as_of: string; kpis: Kpi[] }> {
  const db = getDb(env);
  const outside = outsidePeople(env);
  const series = await agentDaysSeries(env, now, 14);
  const agentDays = series.slice(-7).reduce((a, d) => a + d.agents, 0);
  const prevAgentDays = series.slice(0, 7).reduce((a, d) => a + d.agents, 0);

  const funnel = await agentFunnel(env, now - DAY, 7);
  const retention = await signedInRetention(env, now);

  const [verified] = await db
    .select({ agents: count(t.agents.id), humans: countDistinct(t.agents.humanId) })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, eq(t.agents.status, "active"), eq(t.humans.tier, "verified")));
  const [newVerified] = await db
    .select({ n: count() })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, eq(t.humans.tier, "verified"), gte(t.agents.createdAt, now - 7 * DAY)));

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
  const [gauntlets] = await db.select({ n: count() }).from(t.arenaGauntlets).where(gte(t.arenaGauntlets.startedAt, now - 30 * DAY));
  const [gauntletsDone] = await db
    .select({ n: count() })
    .from(t.arenaGauntlets)
    .where(and(gte(t.arenaGauntlets.startedAt, now - 30 * DAY), ne(t.arenaGauntlets.status, "open")));

  const citations = (await env.KV.get<Citation[]>(CITATIONS_KV, "json")) ?? [];
  const partners = (await env.KV.get<PartnerContact[]>(PARTNERS_KV, "json")) ?? [];
  const engagedOrgs = new Set(partners.filter((b) => ENGAGED.includes(b.stage)).map((b) => b.org.toLowerCase())).size;

  const people = c7.get("visit:human");
  const connections = funnel.stages.connected;
  const conversion = people > 0 ? Math.round((connections / people) * 1000) / 10 : null;
  const tagged = c7.pre("visit:tag:");

  const live = DISTRIBUTION.filter((d) => d.status === "live").length;

  const kpis: Kpi[] = [
    kpi({
      id: "north_star",
      name: "Weekly active agent-days (north star)",
      value: agentDays,
      unit: "agent-days in 7 days",
      first: 500,
      second: 5000,
      definition:
        "For each of the last 7 full UTC days, distinct agents that ran a check, scan, watch check-in or Gauntlet (MCP, A2A, API, plugin, CLI, CI; one-day code), summed. House and people on the website left out.",
      detail: { previous_7_days: prevAgentDays, change_pct: prevAgentDays ? Math.round(((agentDays - prevAgentDays) / prevAgentDays) * 1000) / 10 : null, daily: series },
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
      definition: "Active agents whose owner is a GitHub-verified person outside the project (not House, not a founder).",
      detail: { humans: Number(verified?.humans ?? 0), agents_per_human: verified?.humans ? Math.round((Number(verified.agents) / Number(verified.humans)) * 10) / 10 : null, new_in_7_days: Number(newVerified?.n ?? 0) },
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
      detail: { distinct_owners: Number(reports7?.owners ?? 0) },
    }),
    kpi({
      id: "results",
      name: "Gauntlet runs (30 days)",
      value: Number(gauntlets?.n ?? 0),
      unit: "in 30 days",
      first: 100,
      second: 1000,
      definition: "Gauntlet runs started in the last 30 days (any agent; our install tests included, so read with the detail).",
      detail: { finished: Number(gauntletsDone?.n ?? 0), ranked_bouts_30_days: Number(ranked30?.n ?? 0), ranked_models_all_time: Number(models?.n ?? 0) },
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
      id: "conversion",
      name: "Connections per 100 people",
      value: conversion,
      unit: "per 100",
      first: 8,
      second: 12,
      definition: "MCP and A2A connections (directory checks left out) per 100 real people on the site (browsers that ran site.js), last 7 days.",
      detail: { connections, people, connect_tests_passed: funnel.detail.connect_tests_passed },
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
  /** A held-out seed split that is never published, scored apart from the public one. */
  private_holdout: false,
  /** A canary string in every published dataset file and replay, so training-set leaks can be detected. */
  canary_in_published_data: false,
  /** Referee tests in which an adversarial agent tries to game the end state (reward hacking). */
  verifier_hacking_tests: false,
  /** Personal fields (GitHub logins) pseudonymised in any exported dataset. */
  exports_pseudonymised: false,
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
  const [g] = await db.select({ n: count() }).from(t.arenaGauntlets).where(ne(t.arenaGauntlets.status, "open"));
  const [pg] = await db.select({ n: count() }).from(t.arenaPgAttempts).where(eq(t.arenaPgAttempts.status, "done"));
  const [reps] = await db.select({ n: count(), tools: countDistinct(t.reports.toolVersionId) }).from(t.reports);
  const [ext] = await db.select({ n: count() }).from(t.reports).innerJoin(t.humans, eq(t.reports.humanId, t.humans.id)).where(outside);
  const [sc] = await db.select({ n: count(), pub: sql<number>`sum(case when ${t.skillScans.public} then 1 else 0 end)` }).from(t.skillScans);
  const total = Number(all?.n ?? 0);
  return {
    environments: { task_families: TASKS.length, job_versions: TASKS.length + HARD_TASKS.length + HARD3_TASKS.length, tiers: ["Normal", "Hard v2", "Hard v3"] },
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
