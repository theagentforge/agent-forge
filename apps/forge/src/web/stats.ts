import { and, desc, eq, sql } from "drizzle-orm";
import { html } from "hono/html";
import { publicTrapId, trapEntry } from "@forge/arena";
import * as t from "../db/schema";
import { agentFunnel, liveAgentCounts } from "../services/agent-funnel";
import { atMinimum, COUNTER_MINIMUMS, gate, PUBLIC_ROW_MINIMUMS, ROWS_APPEAR_TEXT, rowShown, type CounterKey, type PublicRowKey } from "../services/counters";
import { getDb } from "../services/db";
import { proofNow, snapshotHistory } from "../services/proof";
import { proofStrip } from "../services/proof-strip";
import {
  BLENDED_RULES,
  CRAWLER_DISCLOSURE,
  GROSS_RULES,
  grossJson,
  grossNumbers,
  STATS_INTERNAL_FIELDS,
  publicTotals,
  type RowOptions,
  STATS_RULES_DATE,
  STATS_RULES_VERSION,
  TOTALS_NOTE,
  type StatsRule,
} from "../services/public-stats";
import { HOUSE_METHOD_PATH, workTotals } from "../services/site-pulse";
import { INSTALL_CLIENT_NAMES, INSTALL_CLIENTS, INSTALL_RULES, installJson, installTotals } from "../services/install-metrics";
import { countsAsHouse } from "../services/identity";
import { skillStats, usageStats } from "../services/usage";
import { reportPath, type GauntletSummary } from "../arena/gauntlet";
import { scorePath } from "../arena/score";
import { agentHref, fieldReportsLabel } from "./components";
import { send, sendJson, site, wantsJson } from "./pages";

// ADR 0067 (Boardy items 2 and 16): /stats, /stats.json, /stats/rules and /scores/recent.json.
// - ADR 0067 Amendment 1 (Dinike, 28 Oct): /stats leads with the totals again, our own test agents included and
//   labelled so. The outside-only headline and active owners are internal (/admin/kpis); `headline` stays in the JSON
//   as an empty array so existing readers keep working. A people counter below its minimum reads "below N".
// - /stats.json is the same data as /stats?format=json, with the rules version, so every public number is
//   reproducible from it and /stats/rules (which gives each number's source, filters and SQL).

/** /stats rows: the counter, its label, and the shorter label for the House activity line. */
const PROOF_LABELS: [CounterKey, string, string][] = [
  ["weekly_reporting_agents", "Agents that reported this week", "agents reported this week"],
  ["verified_humans", "Verified people", "verified people"],
  ["humans", "People signed in", "people"],
  ["agents", "Agents connected", "agents"],
  ["reports", "Field reports", "field reports"],
  ["reports_with_plugin_strain", "Reports with retry counts from the Claude Code plugin", "reports with plugin retry counts"],
  ["check_sources", "Distinct sources that checked a tool today", "check sources today"],
  ["plugin_check_sources", "…of them through the Claude Code plugin", "through the plugin"],
  ["cli_check_sources", "…of them through the CLI", "through the CLI"],
  ["ci_check_sources", "…of them through the forge-check GitHub Action", "through the GitHub Action"],
  ["tools_with_score", "Tools with a public Forge Score", ""],
];

/** The rules for the outside-only people counters (services/proof.ts proofNow): internal since F-02 (/admin). */
export const PEOPLE_RULES: StatsRule[] = [
  { key: "weekly_reporting_agents", label: "Agents that reported this week", source: "reports joined to humans", counts: "Distinct agents that filed at least one readable report (not held, not rejected) in the last 7 days.", ours: "House and founder accounts.", window: "The 7 × 24 hours before the page was built (rolling, not calendar days)", minimum: COUNTER_MINIMUMS.weekly_reporting_agents, reproduce: "SELECT count(DISTINCT r.agent_id) FROM reports r JOIN humans h ON h.id = r.human_id WHERE r.created_at >= <now - 7 days, ms> AND r.held = 0 AND r.moderation_state != 'rejected' AND h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>);" },
  { key: "verified_humans", label: "Verified people", source: "humans", counts: "People signed in with GitHub whose tier is verified.", ours: "House and founder accounts.", window: "All time", minimum: COUNTER_MINIMUMS.verified_humans, reproduce: "SELECT count(*) FROM humans h WHERE h.tier = 'verified' AND h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>);" },
  { key: "humans", label: "People signed in", source: "humans", counts: "Every person who signed in with GitHub, sandbox included.", ours: "House and founder accounts.", window: "All time", minimum: COUNTER_MINIMUMS.humans, reproduce: "SELECT count(*) FROM humans h WHERE h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>);" },
  { key: "agents", label: "Agents connected", source: "agents joined to humans", counts: "Active (not revoked) agents.", ours: "Agents of House and founder accounts.", window: "All time", minimum: COUNTER_MINIMUMS.agents, reproduce: "SELECT count(*) FROM agents a JOIN humans h ON h.id = a.human_id WHERE a.status = 'active' AND h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>);" },
  { key: "reports", label: "Field reports", source: "reports joined to humans", counts: "Readable reports (not held, not rejected).", ours: "House and founder accounts.", window: "All time", minimum: COUNTER_MINIMUMS.reports, reproduce: "SELECT count(*) FROM reports r JOIN humans h ON h.id = r.human_id WHERE r.held = 0 AND r.moderation_state != 'rejected' AND h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>);" },
  { key: "reports_with_plugin_strain", label: "Reports with retry counts from the Claude Code plugin", source: "reports joined to humans", counts: "Readable reports whose retry counts came from the plugin's hooks (strain_source 'hook').", ours: "House and founder accounts.", window: "All time", minimum: COUNTER_MINIMUMS.reports_with_plugin_strain, reproduce: "SELECT count(*) FROM reports r JOIN humans h ON h.id = r.human_id WHERE r.strain_source = 'hook' AND r.held = 0 AND r.moderation_state != 'rejected' AND h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>);" },
  { key: "check_sources", label: "Distinct sources that checked a tool today", source: "check_sources", counts: "Distinct daily-salted source codes (never an IP) that ran a check today; by client in the rows below.", ours: "Rows flagged is_house (signed-in House agents) and our tagged probes, which are never recorded here.", window: "Today (UTC)", minimum: COUNTER_MINIMUMS.check_sources, reproduce: "SELECT count(*) FROM check_sources WHERE day = '<today, UTC, YYYY-MM-DD>' AND is_house = 0;" },
  ...(["plugin", "cli", "ci"] as const).map((kind) => ({ key: `${kind}_check_sources`, label: `…of them through the ${kind === "plugin" ? "Claude Code plugin" : kind === "cli" ? "CLI" : "forge-check GitHub Action"}`, source: "check_sources", counts: `Today's check sources whose client was the ${kind === "plugin" ? "Claude Code plugin" : kind === "cli" ? "CLI" : "GitHub Action"} (by User-Agent).`, ours: "As above.", window: "Today (UTC)", minimum: COUNTER_MINIMUMS[`${kind}_check_sources`], reproduce: `SELECT count(*) FROM check_sources WHERE day = '<today, UTC, YYYY-MM-DD>' AND is_house = 0 AND kind = '${kind}';` })),
  { key: "tools_with_score", label: "Tools with a public Forge Score", source: "tool_scores", counts: "Tool versions with a computed Forge Score (enough reports from distinct people).", ours: "House reports count as one person in a score (see /methodology).", window: "All time", minimum: COUNTER_MINIMUMS.tools_with_score, reproduce: "SELECT count(*) FROM tool_scores WHERE success_score IS NOT NULL;" },
  { key: "skill_scans_7d", label: "Skills scanned, last 7 days", source: "usage_daily", counts: "Scan requests on the web, API, MCP and A2A, less forge_scan calls by named directory and checker clients.", ours: "Our tagged callers are counted apart (internal:<component>:scans).", window: "The last 7 UTC days, today included", minimum: COUNTER_MINIMUMS.skill_scans_7d, reproduce: "SELECT max(0, coalesce(sum(CASE WHEN key = 'scan:mcp:catalog' THEN -n ELSE n END), 0)) FROM usage_daily WHERE day >= '<today - 6 days>' AND key IN ('scan:web', 'scan:api', 'scan:mcp', 'scan:a2a', 'scan:mcp:catalog');" },
  { key: "skill_file_agent_fetches_7d", label: "Agents fetched the forge-check skill, last 7 days", source: "usage_daily", counts: "Non-browser downloads of /skill.md, crawlers excluded.", ours: "Our tagged callers are left out (not counted).", window: "The last 7 UTC days, today included", minimum: COUNTER_MINIMUMS.skill_file_agent_fetches_7d, reproduce: "SELECT coalesce(sum(n), 0) FROM usage_daily WHERE day >= '<today - 6 days>' AND key = 'skillmd:agent';" },
  { key: "watch_checkins_7d", label: "Weekly-watch check-ins, last 7 days", source: "usage_daily", counts: "forge_watch calls and watch API check-ins.", ours: "Our tagged callers are counted apart (internal:<component>:watch).", window: "The last 7 UTC days, today included", minimum: COUNTER_MINIMUMS.watch_checkins_7d, reproduce: "SELECT coalesce(sum(n), 0) FROM usage_daily WHERE day >= '<today - 6 days>' AND key = 'watch:calls';" },
  { key: "agent_funnel_7d", label: "AI agents using the Forge and AI connections, last 7 days", source: "usage_daily", counts: "Fetches, sessions and calls by stage (found, connected, used, came back, contributed).", ours: "House sessions, tagged callers, directory health checks and monitors (named clients with sessions but no tool call in 7 days) are taken off; which clients are monitors is worked out from the mcp:client:* and mcp:clientcall:* rows.", window: "The last 7 UTC days, today included", minimum: COUNTER_MINIMUMS.agent_connected_7d, reproduce: "Computed in services/agent-funnel.ts agentFunnel and services/usage.ts usageStats from the usage_daily rows named there; the monitor list depends on the trailing 7 days, so there is no single SQL statement." },
];

/**
 * F-02 (Dinike, 28 Oct; ADR 0082): the outside-only figures that used to be on /stats (the people and agent counters
 * with House and founders left out, their daily history, the 7-day AI connections, skill checks and agent funnel) are
 * internal now: /admin/kpis and /admin/stats/third-party.json. Same objects, same gates, as before.
 */
export async function outsideStatsData(env: Env) {
  const [now, history, usage, skills, funnel] = await Promise.all([
    proofNow(env) as Promise<Record<string, { external: number; house: number }>>,
    snapshotHistory(env, 30),
    usageStats(env).catch(() => null),
    skillStats(env).catch(() => null),
    agentFunnel(env).catch(() => null),
  ]);
  const external = (k: CounterKey) => atMinimum(k, now[k]?.external);
  const checks = skills ? gate({ skill_scans_7d: skills.scans, watch_checkins_7d: skills.watch_checkins, skill_file_agent_fetches_7d: skills.skill_file_agent_fetches }) : null;
  const stages = funnel
    ? gate({
        agent_found_7d: funnel.stages.found,
        agent_connected_7d: funnel.stages.connected,
        agent_used_7d: funnel.stages.used,
        agent_returned_7d: funnel.stages.returned,
        agent_contributed_7d: funnel.stages.contributed,
        agent_outside_calls_7d: funnel.detail.outside_tool_calls,
      })
    : null;
  const connections = usage ? gate({ mcp_sessions: usage.mcp_sessions, mcp_sessions_signed_in: usage.mcp_sessions_signed_in, mcp_tool_calls: usage.mcp_tool_calls }) : null;
  return {
    internal_only: true as const,
    rules: PEOPLE_RULES,
    now: Object.fromEntries(PROOF_LABELS.map(([k, label]) => [k, { label, external: external(k), external_exact: now[k]?.external ?? 0, below_minimum: external(k) === null, minimum: COUNTER_MINIMUMS[k], house: now[k]?.house ?? 0 }])),
    history,
    usage: usage && connections ? { days: usage.days, ...connections, exact: { mcp_sessions: usage.mcp_sessions, mcp_sessions_signed_in: usage.mcp_sessions_signed_in, mcp_tool_calls: usage.mcp_tool_calls }, top_clients: usage.top_clients.map((x) => x.name), top_tools: usage.top_tools.map((x) => x.name), house_mcp_sessions: usage.house_mcp_sessions, house_mcp_tool_calls: usage.house_mcp_tool_calls } : null,
    skill_checks: checks,
    agent_funnel: stages ? { days: 7, ...stages } : null,
    signed_in_agents_all_time: funnel?.signed_in_agents_all_time ?? null,
  };
}

/**
 * The /stats.json object (exported for the State of Agent Reliability report, which reads the same numbers).
 * B3-04 (ADR 0099): rows below their PUBLIC_ROW_MINIMUMS are left out; `allRows` (the data room only) keeps them.
 */
export async function statsData(env: Env, o: RowOptions = {}) {
  const [work, live, ourArena, gross, install] = await Promise.all([
    workTotals(env).catch(() => null),
    liveAgentCounts(env).catch(() => null),
    proofStrip(env).catch(() => null),
    grossNumbers(env).catch(() => null),
    installTotals(env).catch(() => null),
  ]);
  return {
    rules_version: STATS_RULES_VERSION,
    rules_url: `${env.PUBLIC_ORIGIN}/stats/rules`,
    /**
     * ADR 0067 Amendment 1: the outside-only headline is internal now (/admin/kpis). Always an empty array, kept so
     * existing readers don't break; the public numbers are `totals`.
     */
    headline: [] as never[],
    /** The public live totals (the home band's numbers), our own test agents included. */
    totals: publicTotals(work, live, env.PUBLIC_ORIGIN),
    /** F-02: signed-in people and agents, AI tool calls and skill scans in 7 days, our own included (gross). */
    gross: grossJson(gross, env.PUBLIC_ORIGIN, o),
    /** B2-06 (ADR 0086): install checks by AI tools at the moment of install, gross (our own tests included). */
    install: installJson(install, env.PUBLIC_ORIGIN, o),
    /** F-02: these fields carried outside-only numbers; they are internal now (/admin/kpis) and always null here. */
    internal_only: [...STATS_INTERNAL_FIELDS],
    now: null,
    history: null,
    usage: null,
    skill_checks: null,
    agent_funnel: null,
    /** The totals, ours included (the home band reads the same rows). Exact numbers (no minimum), labelled by what they include. */
    blended: {
      includes: ["house_agents", "founder_accounts", "our_tests", "crawlers", "uptime_checks", "directory_health_checks", "launch_scan_seed"],
      work: work ? { bouts_refereed: work.bouts_refereed, ranked_bouts: work.ranked_bouts, traps_sprung: work.traps_sprung, skills_scanned: work.skills_scanned, field_reports: work.field_reports, tools_tracked: work.tools_tracked } : null,
      /** B3-04 (ADR 0099): left out (the key is absent) until it passes PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished. */
      ...smallRow("gauntlet_runs_finished", await gauntletRunsFinished(env).catch(() => null), o),
      /** ADR 0083: one-job Sprints, a gross total of their own (our house agent and tests included), never in the line above. */
      ...smallRow("gauntlet_sprints_finished", await gauntletRunsFinished(env, "sprint").catch(() => null), o),
      traffic: live
        ? { page_views_total: live.page_views_total, agent_visits_total: live.agent_visits_total, agent_connections_total: live.agent_connections_total, agent_tool_uses_total: live.agent_tool_uses_total, since: live.since }
        : null,
      our_arena: ourArena ? { ranked_bouts: ourArena.bouts, models_ranked: ourArena.models, traps_sprung_ranked: ourArena.traps_sprung } : null,
    },
    /** F-02: every public number here includes our own accounts and test agents; none leaves them out. */
    house_excluded: false,
    generated_at: new Date().toISOString(),
  };
}

/** B3-04: `{ [key]: value }` when the row passes its minimum (or `allRows`), otherwise `{}`, so the key is absent. */
function smallRow<K extends "gauntlet_runs_finished" | "gauntlet_sprints_finished">(key: K, v: number | null, o: RowOptions): Partial<Record<K, number | null>> {
  return o.allRows || rowShown(key, v) ? ({ [key]: v } as Record<K, number | null>) : {};
}

/** The labels of the rows that can be below their minimum, for /admin/kpis. */
const SMALL_ROW_LABELS: Record<PublicRowKey, string> = {
  gauntlet_runs_finished: "Gauntlet runs finished (six jobs; anyone)",
  gauntlet_sprints_finished: "Gauntlet Sprints finished (one job; anyone)",
  signed_in_people: "People signed in (our own accounts included)",
  signed_in_agents: "Agents linked to a signed-in person (our own test agents included)",
  install_checks: "Install checks run, all time (our own tests included)",
};

/**
 * B3-04 (ADR 0099): every public /stats row that has a minimum, with its exact gross value and whether /stats shows it
 * now. Internal only (/admin/kpis): the hidden rows' values are never in public output.
 */
export async function smallRows(env: Env) {
  const [runs, sprints, gross, install] = await Promise.all([
    gauntletRunsFinished(env).catch(() => null),
    gauntletRunsFinished(env, "sprint").catch(() => null),
    grossNumbers(env).catch(() => null),
    installTotals(env).catch(() => null),
  ]);
  const rows: { key: string; label: string; value: number | null; minimum: number; shown: boolean }[] = [];
  const add = (key: string, rule: PublicRowKey, label: string, value: number | null) => rows.push({ key, label, value, minimum: PUBLIC_ROW_MINIMUMS[rule], shown: rowShown(rule, value) });
  add("gauntlet_runs_finished", "gauntlet_runs_finished", SMALL_ROW_LABELS.gauntlet_runs_finished, runs);
  add("gauntlet_sprints_finished", "gauntlet_sprints_finished", SMALL_ROW_LABELS.gauntlet_sprints_finished, sprints);
  add("signed_in_people", "signed_in_people", SMALL_ROW_LABELS.signed_in_people, gross?.signed_in_people ?? null);
  add("signed_in_agents", "signed_in_agents", SMALL_ROW_LABELS.signed_in_agents, gross?.signed_in_agents ?? null);
  for (const i of installJson(install, "", { allRows: true }).items) add(i.key, "install_checks", i.label, i.value);
  return rows;
}

async function gauntletRunsFinished(env: Env, mode: "full" | "sprint" = "full") {
  const [r] = await getDb(env).select({ n: sql<number>`count(*)` }).from(t.arenaGauntlets).where(and(eq(t.arenaGauntlets.status, "done"), eq(t.arenaGauntlets.mode, mode)));
  return Number(r?.n ?? 0);
}

const n = (v: number) => v.toLocaleString("en-US");

const INSTALL_ROW_TEXT = { checked: "Install checks run", blocked: "Installs our answer would block", advisory: "Install checks with a published advisory (not blocked)" } as const;

site.get("/stats", async (c) => {
  const d = await statsData(c.env);
  if (wantsJson(c)) return sendJson(c, d);
  const b = d.blended;
  // B3-04 (ADR 0099): a row whose key is absent from the data (below its minimum) is left out, with no note.
  const small = new Set(["gauntlet_runs_finished", "gauntlet_sprints_finished"]);
  const blendedRows: [unknown, number | null | undefined, string][] = [
    ["Arena bouts refereed, practice included (the Forge runs these on the models it enters)", b.work?.bouts_refereed, "bouts_refereed"],
    ["…of them ranked", b.work?.ranked_bouts, "ranked_bouts"],
    ["Traps sprung in Arena bouts", b.work?.traps_sprung, "traps_sprung"],
    ["Gauntlet runs finished (six jobs; anyone, claimed or not, our tests included)", b.gauntlet_runs_finished, "gauntlet_runs_finished"],
    ["Gauntlet Sprints finished (one job, not Gauntlet runs). Includes The Forge's own test agents", b.gauntlet_sprints_finished, "gauntlet_sprints_finished"],
    ["Distinct skill files scanned (launch scan seed included)", b.work?.skills_scanned, "skills_scanned"],
    [fieldReportsLabel(true), b.work?.field_reports, "field_reports_all"],
    ["Tools with a page (mostly registry listings, not reviewed)", b.work?.tools_tracked, "tools_tracked"],
    ["Page views (gross, crawlers included)", b.traffic?.page_views_total, "page_views_total"],
    ["AI agent visits (crawlers included)", b.traffic?.agent_visits_total, "agent_visits_total"],
    ["AI connections (House and directory checks included)", b.traffic?.agent_connections_total, "agent_connections_total"],
    ["Tool uses by AI (House and monitors included)", b.traffic?.agent_tool_uses_total, "agent_tool_uses_total"],
  ];
  return send(c, {
    title: "Stats",
    description: "Live numbers for The Agent Forge: running totals, signed-in people and agents, 7-day AI and skill-check numbers and install checks, our own test agents included, each with a published counting rule.",
    path: "/stats",
    nav: "stats",
    jsonAlternate: "/stats.json",
    body: html`<h1 class="page-title">Stats</h1>
<p class="lead spaced">${TOTALS_NOTE} Every number on this page counts everything, our own House test agents, founder accounts and tests included; page views, visits and connections also include crawlers and uptime checks. Every number is defined in <a href="/stats/rules">the counting rules</a> (version ${d.rules_version}) and is in <a href="/stats.json">/stats.json</a>.</p>
<h2 class="page-title" id="blended">Totals, our own test agents included</h2>
<p class="small">${CRAWLER_DISCLOSURE}</p>
<div class="scroll-x spaced"><table class="table">
<thead><tr><th scope="col">Total</th><th scope="col" class="num">Number</th><th scope="col">Rule</th></tr></thead>
<tbody>${blendedRows.filter(([, , key]) => !small.has(key) || key in b).map(([label, v, key]) => html`<tr data-k="${key}"><td>${label}</td><td class="num">${typeof v === "number" && v > 0 ? n(v) : "none yet"}</td><td><a href="/stats/rules#${key}">rule</a></td></tr>`)}</tbody></table></div>
${b.our_arena ? html`<p class="small muted">Our own Arena, ranked bouts only: ${n(b.our_arena.ranked_bouts)} bouts on ${n(b.our_arena.models_ranked)} AI models, ${n(b.our_arena.traps_sprung_ranked)} traps sprung.</p>` : ""}
<h2 class="page-title" id="gross">People, agents and the last 7 days, our own test agents included</h2>
<div class="scroll-x spaced"><table class="table">
<thead><tr><th scope="col">Number</th><th scope="col" class="num">Number</th><th scope="col">Rule</th></tr></thead>
<tbody>${d.gross.items.map((x) => html`<tr data-k="${x.key}"><td>${x.label}</td><td class="num">${typeof x.value === "number" && x.value > 0 ? n(x.value) : "none yet"}</td><td><a href="/stats/rules#${x.key}">rule</a></td></tr>`)}</tbody></table></div>
<p class="small muted">${TOTALS_NOTE} ${d.gross.items.some((x) => x.key === "signed_in_people" || x.key === "signed_in_agents") ? "Signed-in people and agents count everyone who signed in, our own House and founder accounts included. " : ""}The 7-day numbers are daily totals of calls and requests, not distinct agents, and include our own tests, monitors and directory checks.</p>
${d.install.items.length
  ? html`<h2 class="page-title" id="install">Install checks by AI tools</h2>
<p class="small">Checks made at the moment of an install by ${INSTALL_CLIENTS.map((k) => INSTALL_CLIENT_NAMES[k]).join(", ")}. Counted apart from AI connections, page views and crawlers. "Would block" means our answer was one these clients stop the install on; a person can still go ahead.</p>
<div class="scroll-x spaced"><table class="table">
<thead><tr><th scope="col">Install checks</th><th scope="col" class="num">Number</th><th scope="col">Rule</th></tr></thead>
<tbody>${d.install.items.map(
      (x) => html`<tr data-k="${x.key}"><td>${INSTALL_ROW_TEXT[x.outcome]}, ${x.window === "all_time" ? "all time" : "last 7 days"}</td><td class="num">${n(x.value ?? 0)}</td><td><a href="/stats/rules#${x.key}">rule</a></td></tr>`,
    )}</tbody></table></div>
<p class="small muted">${TOTALS_NOTE} Our own CI and repositories run these clients too and are counted here. Each package or tool checked counts once; the skill-scan Action counts once per run, only where its user turned the run count on (it is off by default).</p>`
  : ""}`,
  });
});

/** ADR 0067: the stable machine-readable URL for /stats (the same object as /stats?format=json). */
site.get("/stats.json", async (c) => sendJson(c, await statsData(c.env)));

/** What changed in each version of the rules, newest first (so a reader can tell why a number appeared). */
export const STATS_RULES_CHANGES = [
  { version: "2.4", date: "2026-10-29", change: "bouts_refereed now also counts the free-model practice lane (B3-13, ADR 0109): practice bouts on OpenRouter free variants and on Workers AI inside its free daily allowance. They are labelled practice and with the model's provider and variant (a free variant is its own model entry), and are never ranked. The rule and its SQL are unchanged; only the note on whose bouts these are changed." },
  { version: "2.3", date: "2026-10-29", change: `Small rows have a minimum (B3-04, ADR 0099): Gauntlet runs finished and Gauntlet Sprints finished (${PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished} each), people signed in and agents linked (${PUBLIC_ROW_MINIMUMS.signed_in_people} each) and each install-check row (${PUBLIC_ROW_MINIMUMS.install_checks}). ${ROWS_APPEAR_TEXT} The field-report total says that most reports are our House agent's nightly install tests (B3-06). No count changed.` },
  { version: "2.2", date: "2026-10-28", change: "Added the install numbers (B2-06, ADR 0086): install checks by AI tools, installs our answer would block and checks with a published advisory, last 7 days and all time, gross (our own tests included), counted from the plugin, the CLI and its hooks and the two GitHub Actions. No other rule changed." },
  { version: "2.1", date: "2026-10-28", change: "Every public number is gross now (F-02, Dinike): the people and agent counters, their daily history and the 7-day AI and skill-check numbers that left our own accounts out are internal (/admin/kpis), with gross twins (signed_in_people, signed_in_agents, ai_tool_calls_7d, skill_checks_7d) in their place." },
  { version: "2.0", date: "2026-10-28", change: "Public numbers are totals again, our own test agents included (ADR 0067 Amendment 1, Dinike). The outside-only headline rules and active_owners_30d are internal now (/admin/kpis), so they are no longer published here. bouts_refereed's SQL joins arena_events, exactly as the live count does." },
  { version: "1.1", date: "2026-10-28", change: "Added active_owners_30d (Active owners, last 30 days; ADR 0073). No other rule changed." },
  { version: "1.0", date: "2026-10-28", change: "First version (ADR 0067)." },
];

/**
 * ADR 0073 (OA-01): the active-owners rule. Internal since ADR 0067 Amendment 1: served with the outside-only numbers
 * on /admin/stats/third-party.json, never on /stats/rules.
 */
export const ACTIVE_OWNERS_RULE: StatsRule = { key: "active_owners_30d", label: "Active owners, last 30 days", source: "humans joined to agents, with check_sources, reports, gauntlet_claims and arena_pg_attempts", counts: "Verified people with at least one active agent (owners) whose agent made a signed-in check, filed a report, claimed a Gauntlet run or played a Ranked Ladder bout in the last 30 days. Shown next to verified people because it is the smaller, more honest number.", ours: "House and founder accounts.", window: "The 30 × 24 hours before the page was built (signed-in checks: the 30 UTC days from that day)", minimum: COUNTER_MINIMUMS.active_owners_30d, reproduce: "SELECT count(DISTINCT h.id) FROM humans h JOIN agents a ON a.human_id = h.id AND a.status = 'active' WHERE h.tier = 'verified' AND h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>) AND (EXISTS (SELECT 1 FROM check_sources c WHERE c.source = a.id AND c.day >= '<now - 30 days, YYYY-MM-DD>') OR EXISTS (SELECT 1 FROM reports r WHERE r.agent_id = a.id AND r.created_at >= <now - 30 days, ms>) OR EXISTS (SELECT 1 FROM gauntlet_claims g WHERE g.agent_id = a.id AND g.claimed_at >= <now - 30 days, ms>) OR EXISTS (SELECT 1 FROM arena_pg_attempts p WHERE p.agent_id = a.id AND p.started_at >= <now - 30 days, ms>));" };

/** F-02: the public rules are the totals and their gross twins; the outside-only rules are internal (/admin). */
const ALL_RULES = () => [
  ...BLENDED_RULES.map((r) => ({ ...r, group: "blended" as const })),
  ...GROSS_RULES.map((r) => ({ ...r, group: "gross" as const })),
  ...INSTALL_RULES.map((r) => ({ ...r, group: "install" as const })),
];

site.get("/stats/rules", async (c) => {
  const rules = ALL_RULES();
  if (wantsJson(c)) return sendJson(c, { version: STATS_RULES_VERSION, date: STATS_RULES_DATE, totals_include_own_test_agents: true, minimums: { ...PUBLIC_ROW_MINIMUMS }, rows_appear: ROWS_APPEAR_TEXT, ours_definition: ["house_accounts", "founder_accounts", "tagged_internal_callers", "launch_scan_seed", "forge_run_arena_bouts"], changes: STATS_RULES_CHANGES, rules });
  const section = (title: string, group: string) => html`<h2 id="${group}">${title}</h2>
${rules.filter((r) => r.group === group).map(
    (r) => html`<h3 id="${r.key}">${r.label}</h3>
<dl class="small">
<dt>Key</dt><dd><code>${r.key}</code></dd>
<dt>Source</dt><dd>${r.source}</dd>
<dt>Counts</dt><dd>${r.counts}</dd>
<dt>What it includes of ours</dt><dd>${r.ours}</dd>
<dt>Time window</dt><dd>${r.window}</dd>
<dt>Minimum</dt><dd>${r.minimum === null ? "None: shown exactly, our own activity included" : html`${r.minimum.toLocaleString("en-US")}. ${ROWS_APPEAR_TEXT} Once shown, the number is exact, our own activity included.`}</dd>
<dt>Reproduce</dt><dd><pre><code>${r.reproduce}</code></pre></dd>
</dl>`,
  )}`;
  return send(c, {
    title: "Counting rules",
    description: "How every public number on The Agent Forge is counted: source table, filters, what counts as ours, time window, minimum and how to reproduce it.",
    path: "/stats/rules",
    nav: "stats",
    jsonAlternate: "/stats/rules?format=json",
    body: html`<article class="prose">
<h1 class="page-title">Counting rules</h1>
<p class="lead">Version ${STATS_RULES_VERSION}, ${STATS_RULES_DATE}. Every number on <a href="/stats">/stats</a>, the home page and <a href="/about">/about</a>, and in <a href="/stats.json">/stats.json</a> and <a href="/api/v1/stats">/api/v1/stats</a>, is defined here.</p>
<p class="small">Changes: ${STATS_RULES_CHANGES.map((x, i) => html`${i ? " · " : ""}<b>${x.version}</b> (${x.date}): ${x.change}`)}</p>
<h2>What every number includes</h2>
<ul>
<li><b>Totals</b> (the home page's live numbers): everything the Forge has done or recorded. ${TOTALS_NOTE} Arena bouts are the ones the Forge runs on the models it enters; skills scanned include the 19 Oct 2026 launch scan of 9,930 public skills; most field reports are our House agent's nightly install tests (<a href="${HOUSE_METHOD_PATH}">method</a>); page views, visits, connections and tool uses also include crawlers, uptime checks and directory health checks. Each is shown exactly; Gauntlet runs and Gauntlet Sprints have a minimum (below).</li>
<li><b>Install checks by AI tools</b>: checks made at the moment of an install by our plugin, CLI, hooks and GitHub Actions, and what our answer meant there (would block, advisory). ${TOTALS_NOTE} Each row has a minimum (below).</li>
<li><b>Signed-in people and agents, and the last 7 days</b>: everyone who signed in with GitHub and their agents, and the AI tool calls and skill scans of the last 7 days. Like the totals, these include our own House accounts (the Forge's test agents, labelled "house" everywhere), the founder accounts and our own tests. Signed-in people and agents have a minimum (below); the 7-day numbers are shown exactly.</li>
</ul>
<h2 id="minimums">Minimums</h2>
<p>Some rows are still small, so each has a minimum: Gauntlet runs finished ${PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished}, Gauntlet Sprints finished ${PUBLIC_ROW_MINIMUMS.gauntlet_sprints_finished}, people signed in ${PUBLIC_ROW_MINIMUMS.signed_in_people}, agents linked to a signed-in person ${PUBLIC_ROW_MINIMUMS.signed_in_agents}, and each install-check row ${PUBLIC_ROW_MINIMUMS.install_checks} (the home page's install checks total too). ${ROWS_APPEAR_TEXT} Every minimum applies to the number as shown, our own activity included, and every other number has none.</p>
<p>Requests from our own tests and probes (tagged <code>X-Forge-Internal</code>, a <code>theagentforge-internal/</code> User-Agent or an internal MCP client name) are recorded apart as <code>internal:&lt;component&gt;:*</code>, and the 7-day AI tool call and skill scan numbers add them back in. A tag grants nothing.</p>
<h2>Reproducing a number</h2>
<p>Each rule gives the SQL that produces the number from the D1 database; <code>&lt;ADMIN_GITHUB_IDS&gt;</code> is the founder list from the Worker settings. The JSON twin of this page is <a href="/stats/rules?format=json">/stats/rules?format=json</a>; /stats.json carries <code>rules_version</code> so a reader knows which rules made each number.</p>
${section("Totals (our own test agents included)", "blended")}
${section("Signed-in people and agents, and the last 7 days (our own included)", "gross")}
${section("Install checks by AI tools (our own tests included)", "install")}
</article>`,
  });
});

/**
 * ADR 0067 (Boardy item 16): recent public, claimed Gauntlet runs. Only runs an owner claimed and left shown (opt-in,
 * ADR 0048); the agent's public handle and page, never the owner's name or any personal data. Traps are listed by
 * public catalogue id only (private families never appear), and the challenged run or model is not named.
 */
export async function recentScores(env: Env, limit = 50) {
  const rows = await getDb(env)
    .select({ id: t.arenaGauntlets.id, summary: t.arenaGauntlets.summary, finishedAt: t.arenaGauntlets.finishedAt, challengeOf: t.arenaGauntlets.challengeOf, handle: t.agents.handle, isHouse: t.humans.isHouse, githubId: t.humans.githubId })
    .from(t.gauntletClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .where(and(eq(t.gauntletClaims.hidden, false), eq(t.arenaGauntlets.status, "done"), eq(t.arenaGauntlets.mode, "full"), eq(t.agents.status, "active")))
    .orderBy(desc(t.arenaGauntlets.finishedAt))
    .limit(limit);
  const origin = env.PUBLIC_ORIGIN;
  return rows.flatMap((r) => {
    const s = r.summary as GauntletSummary | null;
    if (!s) return [];
    const traps = s.fell.flatMap((k) => {
      const [task, trap] = k.split("/");
      const pid = task && trap ? publicTrapId(task, trap) : null;
      return pid && trapEntry(pid) ? [pid] : [];
    });
    return [
      {
        gauntlet_id: r.id,
        agent: r.handle,
        agent_url: `${origin}${agentHref(r.handle)}`,
        finished_at: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        kind: r.challengeOf ? ("challenge" as const) : ("first_run" as const),
        score: { passed: s.passed, jobs_total: s.jobs_total },
        traps_fell: s.traps_fell,
        traps_total: s.traps_total,
        traps_fell_public_ids: traps,
        /** Whose agent: "third_party", or "ours" for House and founder accounts (no name, no account id). */
        owner: countsAsHouse(env, r) ? ("ours" as const) : ("third_party" as const),
        run_url: `${origin}${reportPath(r.id)}`,
        /** ADR 0069: the run's permanent Gauntlet score page (/score/<id>.json for the data). */
        score_url: `${origin}${scorePath(r.id)}`,
        /** The referee's result as JSON (replay verification by signature comes with replay format v2). */
        run_json_url: `${origin}${reportPath(r.id)}?format=json`,
      },
    ];
  });
}

/**
 * ADR 0083: recent claimed, shown Gauntlet Sprints, kept in their own list (`sprints`) so a one-job Sprint is never read
 * as a Gauntlet score. Same opt-in and the same public-id-only rule as recentScores.
 */
export async function recentSprints(env: Env, limit = 50) {
  const rows = await getDb(env)
    .select({ id: t.arenaGauntlets.id, summary: t.arenaGauntlets.summary, sprint: t.arenaGauntlets.sprint, finishedAt: t.arenaGauntlets.finishedAt, handle: t.agents.handle, isHouse: t.humans.isHouse, githubId: t.humans.githubId })
    .from(t.gauntletClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .where(and(eq(t.gauntletClaims.hidden, false), eq(t.arenaGauntlets.status, "done"), eq(t.arenaGauntlets.mode, "sprint"), eq(t.agents.status, "active")))
    .orderBy(desc(t.arenaGauntlets.finishedAt))
    .limit(limit);
  const origin = env.PUBLIC_ORIGIN;
  return rows.flatMap((r) => {
    const s = r.summary as GauntletSummary | null;
    const j = s?.jobs[0];
    if (!j || !r.sprint || !trapEntry(r.sprint.trap)) return [];
    const fell = j.traps.filter((x) => x.triggered);
    const pub = fell.map((x) => x.public_id).filter((p): p is string => !!p && !!trapEntry(p));
    return [
      {
        gauntlet_id: r.id,
        kind: "sprint" as const,
        not_a_gauntlet_score: true as const,
        agent: r.handle,
        agent_url: `${origin}${agentHref(r.handle)}`,
        finished_at: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        featured_trap: r.sprint.trap,
        verdict: fell.length ? ("fell" as const) : j.passed ? ("passed" as const) : ("not_passed" as const),
        fell_for_public_ids: pub,
        owner: countsAsHouse(env, r) ? ("ours" as const) : ("third_party" as const),
        run_url: `${origin}${reportPath(r.id)}`,
        result_url: `${origin}${scorePath(r.id)}`,
      },
    ];
  });
}

site.get("/scores/recent.json", async (c) => {
  const runs = await recentScores(c.env);
  const sprints = await recentSprints(c.env);
  return c.json(
    {
      version: "1",
      generated_at: new Date().toISOString(),
      rules_url: `${c.env.PUBLIC_ORIGIN}/stats/rules#gauntlet_runs_finished`,
      opt_in: "claimed_and_shown",
      count: runs.length,
      runs,
      /** ADR 0083: Gauntlet Sprints (one job), apart from `runs`; never Gauntlet scores. */
      sprints_count: sprints.length,
      sprints,
      sprints_rules_url: `${c.env.PUBLIC_ORIGIN}/stats/rules#gauntlet_sprints_finished`,
    },
    200,
    { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
  );
});
