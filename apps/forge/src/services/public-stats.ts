import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { SPRINT_DAILY_PER_SOURCE } from "../arena/sprint";
import * as t from "../db/schema";
import { getDb } from "./db";
import { PUBLIC_ROW_MINIMUMS, rowShown, type PublicRowKey } from "./counters";
import { FIELD_REPORTS_LABEL, HOUSE_METHOD_PATH } from "./site-pulse";
import { outsidePeople } from "./agent-funnel";
import { SEEDED_AT } from "./skill-seed";
import { CATALOG_SCAN_KEY } from "./usage";
import type { WorkTotals } from "./site-pulse";
import type { liveAgentCounts } from "./agent-funnel";

// ADR 0067 Amendment 1 (Dinike, 28 Oct): public pages and APIs show the totals again (`PUBLIC_TOTALS`, below), our
// own House test agents included and labelled neutrally. The third-party split in this file (`headline`,
// `headlineSplits`, `HEADLINE_RULES`) is kept intact but is internal only: /admin/kpis and /admin/stats/third-party.json.
//
// ADR 0067 (Boardy item 2): every public counter separates third-party activity from our own. "Ours" is House
// accounts, founder accounts (ADMIN_GITHUB_IDS), our tagged tests and probes (services/internal.ts), the launch-scan
// seed and the Arena bouts the Forge runs itself. Headline numbers are third-party only. Below the minimum a number
// reads "below 10": never hidden, never rounded up, and the small number is never stated (it can still be worked
// out from our own and blended totals, which are exact: the minimum is about what a headline claims, not secrecy). Every rule is written down once,
// here, and the same objects render /stats/rules and go into /stats.json, so a number can always be reproduced.

export const STATS_RULES_VERSION = "2.4";
export const STATS_RULES_DATE = "2026-10-29";
/** The one minimum for headline third-party numbers (ADR 0067). */
export const THIRD_PARTY_MINIMUM = 10;
export const BELOW_MINIMUM_TEXT = `below ${THIRD_PARTY_MINIMUM}`;

/** Our own people: House accounts or founder accounts. The exact complement of `outsidePeople`. */
export function ourPeople(env: Pick<Env, "ADMIN_GITHUB_IDS">) {
  const founders = founderIds(env);
  return founders.length ? or(eq(t.humans.isHouse, true), inArray(t.humans.githubId, founders)) : eq(t.humans.isHouse, true);
}

export const founderIds = (env: Pick<Env, "ADMIN_GITHUB_IDS">) =>
  (env.ADMIN_GITHUB_IDS ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);

/** The usage_daily keys that count skill scans requested by people and agents outside the project. */
export const OUTSIDE_SCAN_KEYS = ["scan:web", "scan:api", "scan:mcp", "scan:a2a"] as const;

export type HeadlineKey = "arena_bouts" | "gauntlet_runs" | "field_reports" | "skill_scans";

export interface StatsRule {
  key: string;
  label: string;
  /** Where the number comes from. */
  source: string;
  /** What is counted. */
  counts: string;
  /** What counts as ours, and is left out of the third-party number. */
  ours: string;
  window: string;
  minimum: number | null;
  /** SQL that reproduces the number on the D1 database (the founder ids come from ADMIN_GITHUB_IDS). */
  reproduce: string;
}

const OUTSIDE_SQL = "h.is_house = 0 AND h.github_id NOT IN (<ADMIN_GITHUB_IDS>)";

/** The headline counters, in the order the home page shows them. */
export const HEADLINE_RULES: (StatsRule & { key: HeadlineKey; short: string })[] = [
  {
    key: "arena_bouts",
    label: "Arena bouts by outside agents",
    short: "Arena bouts by outside agents",
    source: "arena_pg_attempts (Ranked Ladder bouts an owner's own agent plays through /mcp) joined to humans",
    counts: "Finished bouts (status 'done') whose owner is outside the project.",
    ours: "Ladder bouts by House or founder accounts, plus every bout in arena_runs: those are the models the Forge itself enters and pays for, so none of them is third-party.",
    window: "All time",
    minimum: THIRD_PARTY_MINIMUM,
    reproduce: `SELECT count(*) FROM arena_pg_attempts a JOIN humans h ON h.id = a.human_id WHERE a.status = 'done' AND ${OUTSIDE_SQL};`,
  },
  {
    key: "gauntlet_runs",
    label: "Gauntlet runs claimed by outside owners",
    short: "Gauntlet runs by outside owners",
    source: "gauntlet_claims joined to arena_gauntlets and humans",
    counts: "Finished Gauntlet runs (status 'done') that a verified owner outside the project claimed for one of their agents, shown or hidden.",
    ours: "Runs claimed by House or founder accounts. Unclaimed runs are anonymous (no account needed), so we can't tell whose they are: they are counted as unattributed on /stats, never as third-party.",
    window: "All time",
    minimum: THIRD_PARTY_MINIMUM,
    reproduce: `SELECT count(*) FROM gauntlet_claims c JOIN arena_gauntlets g ON g.id = c.gauntlet_id JOIN humans h ON h.id = c.human_id WHERE g.status = 'done' AND g.mode = 'full' AND ${OUTSIDE_SQL};`,
  },
  {
    key: "field_reports",
    label: "Field reports by outside agents",
    short: "field reports by outside agents",
    source: "reports joined to humans",
    counts: "Field reports people can read (not held for review, not rejected) filed by agents whose owner is outside the project.",
    ours: "Reports by House agents (labelled \"house\") and founder accounts.",
    window: "All time",
    minimum: THIRD_PARTY_MINIMUM,
    reproduce: `SELECT count(*) FROM reports r JOIN humans h ON h.id = r.human_id WHERE r.held = 0 AND r.moderation_state != 'rejected' AND ${OUTSIDE_SQL};`,
  },
  {
    key: "skill_scans",
    label: "Skill scans requested by outsiders",
    short: "skill scans requested by outsiders",
    source: "usage_daily (daily counters; no IP, account or session is stored)",
    counts: "Scans requested on the web form, the API, MCP (forge_scan) and A2A (scan-skill), less forge_scan calls by MCP clients that name themselves as a directory, catalogue or checker (usage_daily key scan:mcp:catalog). Each request counts once, so a skill scanned twice counts twice. Directory checkers that don't name their client on the call, and Agentverse messages (unsigned, so their sender can't be checked), can't be told apart and stay in.",
    ours: "The launch scan seed (rows in skill_scans first seen at 2026-10-19T12:00:00Z, the 19 Oct dataset) and scans by our own tagged callers on the web, API, MCP and A2A (usage_daily keys internal:<component>:scans). Before 28 Oct, tagged web-form and A2A scans were not yet split out.",
    window: "All time (the counters started when skill scans launched, 19 Oct 2026)",
    minimum: THIRD_PARTY_MINIMUM,
    reproduce: `SELECT max(0, coalesce(sum(CASE WHEN key = 'scan:mcp:catalog' THEN -n ELSE n END), 0)) FROM usage_daily WHERE key IN ('scan:web', 'scan:api', 'scan:mcp', 'scan:a2a', 'scan:mcp:catalog');`,
  },
];

/** The blended numbers on /stats: everything, ours included, labelled as such. Never a headline. */
export const BLENDED_RULES: StatsRule[] = [
  { key: "bouts_refereed", label: "Arena bouts refereed (all, practice included)", source: "arena_runs joined to arena_events", counts: "Every finished bout the Forge ran on the models it enters, practice included.", ours: "All of them: the Forge picks the models and runs these bouts. Most are paid for; free-model practice bouts (OpenRouter free variants and Workers AI inside its free daily allowance, ADR 0109) cost nothing and are labelled practice, with the model's provider and variant.", window: "All time", minimum: null, reproduce: "SELECT count(*) FROM arena_runs r JOIN arena_events e ON e.id = r.event_id WHERE r.status = 'done';" },
  { key: "ranked_bouts", label: "…of them ranked", source: "arena_runs joined to arena_events", counts: "Finished bouts in a non-practice event.", ours: "All of them.", window: "All time", minimum: null, reproduce: "SELECT count(*) FROM arena_runs r JOIN arena_events e ON e.id = r.event_id WHERE r.status = 'done' AND e.kind != 'practice';" },
  { key: "traps_sprung", label: "Traps sprung in Arena bouts", source: "arena_runs.result traps", counts: "Traps a model fell for in a finished bout (practice included).", ours: "All of them.", window: "All time", minimum: null, reproduce: "SELECT count(*) FROM arena_runs r, json_each(json_extract(r.result, '$.traps')) t WHERE r.status = 'done' AND json_extract(t.value, '$.triggered') = 1;" },
  { key: "gauntlet_runs_finished", label: "Gauntlet runs finished (anyone)", source: "arena_gauntlets", counts: "Every finished six-job Gauntlet run, measured re-runs included, claimed or not. Gauntlet Sprints (one job) are not in this number.", ours: "Includes our own tests and unclaimed runs whose owner we can't know.", window: "All time", minimum: PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished, reproduce: "SELECT count(*) FROM arena_gauntlets WHERE status = 'done' AND mode = 'full';" },
  { key: "gauntlet_sprints_finished", label: "Gauntlet Sprints finished (anyone)", source: "arena_gauntlets", counts: `Every finished Gauntlet Sprint (one job, one planted trap; ADR 0083), claimed or not. Never counted as a Gauntlet run. It counts runs, not agents or people: one source may start up to ${SPRINT_DAILY_PER_SOURCE} a day.`, ours: "Includes The Forge's own test agents: the house agent's daily Sprint (labelled house) and our tests, and unclaimed Sprints whose owner we can't know.", window: "All time (Sprints began 28 Oct 2026)", minimum: PUBLIC_ROW_MINIMUMS.gauntlet_sprints_finished, reproduce: "SELECT count(*) FROM arena_gauntlets WHERE status = 'done' AND mode = 'sprint';" },
  { key: "skills_scanned", label: "Distinct skill files scanned (seed included)", source: "skill_scans", counts: "Distinct text fingerprints ever scanned, including the 19 Oct launch scan and the weekly bulk scan of public skill directories (ADR 0107; rows with origin bulk:clawhub or bulk:github).", ours: "The launch scan seed, the bulk scan, and any file only we scanned.", window: "All time", minimum: null, reproduce: "SELECT count(*) FROM skill_scans;" },
  { key: "field_reports_all", label: `Field reports filed (most are our House agent's nightly install tests)`, source: "reports", counts: `Every report people can read, House and founder reports included. Most are the House agent's nightly install tests: a real npx install of an MCP server in a clean folder, no credentials, then initialize and tools/list (method: ${HOUSE_METHOD_PATH}).`, ours: "House and founder reports are in this number.", window: "All time", minimum: null, reproduce: "SELECT count(*) FROM reports WHERE held = 0 AND moderation_state != 'rejected';" },
  { key: "tools_tracked", label: "Tools with a page", source: "tools", counts: "Every MCP server, skill, package and API with a page. Most are added hourly from public listings, not reviewed: the official MCP Registry; PyPI's sitemap, where a project counts if \"mcp\" is a whole word in its name (a name match, so it takes in MCP clients, SDKs and adapters as well as servers, and a name alone doesn't show what a package is); and Smithery's registry once its key is set. One page per tool: a package listed in two places is one page with an alias (ADR 0108).", ours: "A registry fact, not use.", window: "All time", minimum: null, reproduce: "SELECT count(*) FROM tools;" },
  { key: "page_views_total", label: "Page views (gross, crawlers included)", source: "usage_daily key visit:all (plus, on production, Cloudflare's HTML request counts from 15 Oct to 23 Oct 03:12 UTC, before the Worker counted page views)", counts: "Every HTML page view, people, AI agents and crawlers alike. On production the SQL below gives the Worker's count; add the fixed backfill in services/agent-funnel.ts PAGE_VIEWS_BACKFILL (72,176 views, 15 Oct to 23 Oct 03:12 UTC).", ours: "Includes our own visits, uptime checks and crawlers.", window: "Since 15 Oct 2026", minimum: null, reproduce: "SELECT coalesce(sum(n), 0) FROM usage_daily WHERE key = 'visit:all' AND day >= '2026-10-15';" },
  { key: "agent_visits_total", label: "AI agent visits", source: "usage_daily keys ai:*, disc:*, skillmd:agent, skills:*", counts: "Fetches by AI agents and indexers: pages, discovery files, skill files.", ours: "Includes search and AI crawlers.", window: "Since 20 Oct 2026", minimum: null, reproduce: "SELECT coalesce(sum(n), 0) FROM usage_daily WHERE day >= '2026-10-20' AND (key IN ('ai:indexer', 'ai:live', 'ai:coding', 'skillmd:agent', 'skills:index') OR key LIKE 'disc:%' OR key LIKE 'skills:file:%');" },
  { key: "agent_connections_total", label: "AI connections", source: "usage_daily keys mcp:*:sessions, a2a:requests", counts: "MCP sessions and A2A requests.", ours: "Includes our House sessions, directory health checks and monitors.", window: "Since 20 Oct 2026", minimum: null, reproduce: "SELECT coalesce(sum(n), 0) FROM usage_daily WHERE day >= '2026-10-20' AND key IN ('mcp:public:sessions', 'mcp:gauntlet:sessions', 'mcp:signed_in:sessions', 'mcp:house:sessions', 'a2a:requests');" },
  { key: "agent_tool_uses_total", label: "Tool uses by AI", source: "usage_daily keys mcp:*:calls, a2a:requests, scan:api, mcp:house:calls", counts: "MCP tool calls, A2A skill calls and API scans.", ours: "Includes House calls, monitors and catalogues.", window: "Since 20 Oct 2026", minimum: null, reproduce: "SELECT coalesce(sum(n), 0) FROM usage_daily WHERE (day >= '2026-10-20' AND key IN ('mcp:public:calls', 'mcp:gauntlet:calls', 'mcp:signed_in:calls', 'a2a:requests', 'scan:api')) OR key = 'mcp:house:calls';" },
];

/** What the crawler disclosure on /stats says, kept with the rules. */
export const CRAWLER_DISCLOSURE =
  "Page views, AI agent visits, connections and tool uses are gross counts: they include search and AI crawlers, uptime checks, directory health checks and our own House agents and tests. Every page that shows them says so.";

export interface Split {
  third_party: number;
  ours: number;
  /** Activity we can't attribute either way (only Gauntlet runs, which need no account). */
  unattributed?: number;
}

/** The raw third-party and own counts behind each headline. Pages and JSON use `headline()`, never these directly. */
export async function headlineSplits(env: Env): Promise<Record<HeadlineKey, Split>> {
  const db = getDb(env);
  const one = async (q: Promise<{ n: number | null }[]>) => Number((await q)[0]?.n ?? 0);
  const outside = outsidePeople(env);
  const ours = ourPeople(env);
  const ladder = (who: ReturnType<typeof ourPeople>) =>
    one(db.select({ n: sql<number>`count(*)` }).from(t.arenaPgAttempts).innerJoin(t.humans, eq(t.humans.id, t.arenaPgAttempts.humanId)).where(and(eq(t.arenaPgAttempts.status, "done"), who)));
  const claimed = (who: ReturnType<typeof ourPeople>) =>
    one(
      db
        .select({ n: sql<number>`count(*)` })
        .from(t.gauntletClaims)
        .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
        .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
        .where(and(eq(t.arenaGauntlets.status, "done"), eq(t.arenaGauntlets.mode, "full"), who)),
    );
  const readable = and(eq(t.reports.held, false), ne(t.reports.moderationState, "rejected"));
  const reportsBy = (who: ReturnType<typeof ourPeople>) =>
    one(db.select({ n: sql<number>`count(*)` }).from(t.reports).innerJoin(t.humans, eq(t.humans.id, t.reports.humanId)).where(and(readable, who)));
  const usageSum = (where: ReturnType<typeof sql>) => one(db.select({ n: sql<number>`coalesce(sum(${t.usageDaily.n}), 0)` }).from(t.usageDaily).where(where));
  const [ladderOut, ladderOurs, ourArena, claimedOut, claimedOurs, unclaimed, reportsOut, reportsOurs, scansAll, scansCatalog, seed, scansInternal] = await Promise.all([
    ladder(outside),
    ladder(ours),
    one(db.select({ n: sql<number>`count(*)` }).from(t.arenaRuns).where(eq(t.arenaRuns.status, "done"))),
    claimed(outside),
    claimed(ours),
    one(
      db
        .select({ n: sql<number>`count(*)` })
        .from(t.arenaGauntlets)
        .leftJoin(t.gauntletClaims, eq(t.gauntletClaims.gauntletId, t.arenaGauntlets.id))
        .where(and(eq(t.arenaGauntlets.status, "done"), eq(t.arenaGauntlets.mode, "full"), sql`${t.gauntletClaims.gauntletId} is null`)),
    ),
    reportsBy(outside),
    reportsBy(ours),
    usageSum(inArray(t.usageDaily.key, [...OUTSIDE_SCAN_KEYS])),
    usageSum(eq(t.usageDaily.key, CATALOG_SCAN_KEY)),
    one(db.select({ n: sql<number>`count(*)` }).from(t.skillScans).where(eq(t.skillScans.firstSeen, SEEDED_AT))),
    usageSum(sql`${t.usageDaily.key} like 'internal:%:scans'`),
  ]);
  return {
    arena_bouts: { third_party: ladderOut, ours: ladderOurs + ourArena },
    gauntlet_runs: { third_party: claimedOut, ours: claimedOurs, unattributed: unclaimed },
    field_reports: { third_party: reportsOut, ours: reportsOurs },
    skill_scans: { third_party: Math.max(0, scansAll - scansCatalog), ours: seed + scansInternal },
  };
}

export interface HeadlineItem {
  key: HeadlineKey;
  /** Same as `value`: the third-party number, or null below the minimum (the small number is never sent). */
  third_party: number | null;
  ours: number;
  unattributed?: number;
  label: string;
  /** The third-party number, or null below the minimum. */
  value: number | null;
  /** What a page shows: the number, or "below 10". */
  display: string;
  below_minimum: boolean;
  minimum: number;
  rule_url: string;
}

/** A third-party value as shown: the number from the minimum, otherwise "below 10". Never rounded. */
export const thirdPartyDisplay = (v: number) => (v >= THIRD_PARTY_MINIMUM ? v.toLocaleString("en-US") : BELOW_MINIMUM_TEXT);

/** The headline numbers, gated: below the minimum the third-party value is null and reads "below 10". */
export function gateHeadline(splits: Record<HeadlineKey, Split>, origin = ""): HeadlineItem[] {
  return HEADLINE_RULES.map((r) => {
    const s = splits[r.key];
    const below = s.third_party < THIRD_PARTY_MINIMUM;
    return {
      key: r.key,
      label: r.label,
      value: below ? null : s.third_party,
      display: thirdPartyDisplay(s.third_party),
      below_minimum: below,
      minimum: THIRD_PARTY_MINIMUM,
      third_party: below ? null : s.third_party,
      ours: s.ours,
      ...(s.unattributed !== undefined ? { unattributed: s.unattributed } : {}),
      rule_url: `${origin}/stats/rules#${r.key}`,
    };
  });
}

export async function headline(env: Env): Promise<HeadlineItem[]> {
  return gateHeadline(await headlineSplits(env), env.PUBLIC_ORIGIN);
}

/**
 * ADR 0067 Amendment 1: the public live totals, in the order the home band shows them. Every one includes our own
 * House test agents (and the traffic ones crawlers and uptime checks), so a label never says or implies "outside",
 * "independent" or "by other agents". `rule` is the anchor on /stats/rules.
 */
export const PUBLIC_TOTALS = [
  { key: "bouts_refereed", label: "Arena bouts refereed", rule: "bouts_refereed" },
  { key: "traps_sprung", label: "traps sprung", rule: "traps_sprung" },
  { key: "skills_scanned", label: "skill files scanned", rule: "skills_scanned" },
  { key: "field_reports", label: FIELD_REPORTS_LABEL, rule: "field_reports_all" },
  { key: "tools_tracked", label: "tools tracked", rule: "tools_tracked" },
  { key: "page_views_total", label: "page views", rule: "page_views_total" },
  { key: "agent_visits_total", label: "AI agent visits", rule: "agent_visits_total" },
  { key: "agent_connections_total", label: "AI connections", rule: "agent_connections_total" },
  { key: "agent_tool_uses_total", label: "tool uses by AI", rule: "agent_tool_uses_total" },
  { key: "install_checks_total", label: "install checks", rule: "install_checked_all" },
] as const;

export type PublicTotalKey = (typeof PUBLIC_TOTALS)[number]["key"];

/** Totals with a minimum (ADR 0099): absent from public output while below it, never null. */
const HIDDEN_WHEN_NULL: Partial<Record<PublicTotalKey, true>> = { install_checks_total: true };

/** The one honest line under every public total. */
export const TOTALS_NOTE = "Includes The Forge's own test agents.";

/** The crawler note that goes with the traffic totals wherever they appear. */
export const TRAFFIC_NOTE = "Page views, AI agent visits, AI connections and tool uses by AI also include crawlers, uptime checks and directory health checks.";

/** The public totals as data (home JSON twin, /stats.json, /api/v1/stats). A zero or missing total is null. */
export function publicTotals(w: WorkTotals | null, live: Awaited<ReturnType<typeof liveAgentCounts>> | null, origin = "") {
  const v = (k: PublicTotalKey): number | null => {
    const x = k in (w ?? {}) ? (w as Record<string, number | null>)[k] : live ? (live as unknown as Record<string, number | null>)[k] : null;
    return typeof x === "number" && x > 0 ? x : null;
  };
  return {
    includes_own_test_agents: true as const,
    includes: ["house_agents", "founder_accounts", "our_tests", "crawlers", "uptime_checks", "directory_health_checks", "launch_scan_seed"],
    // Not `note`: sendJson strips keys named `note` (free text from people) from every JSON twin.
    caveat: TOTALS_NOTE,
    traffic_caveat: TRAFFIC_NOTE,
    rules_url: `${origin}/stats/rules`,
    items: PUBLIC_TOTALS.map((t) => ({
      key: t.key,
      label: t.label,
      value: v(t.key),
      rule_url: `${origin}/stats/rules#${t.rule}`,
      // B3-06 (ADR 0099): the field-report total says what most of it is, and links to the House method.
      ...(t.key === "field_reports" ? { method_url: `${origin}${HOUSE_METHOD_PATH}` } : {}),
    }))
      // Review of B3-04 (ADR 0105): the install-checks total has a minimum (liveAgentCounts gives null below it). Below
      // it the item is left out, never a null, so nothing marks a small row as hidden.
      .filter((i) => !(i.key in HIDDEN_WHEN_NULL) || i.value !== null),
  };
}

// F-02 (Dinike, 28 Oct: "do not show external only numbers anywhere on the site, only privately for our internal
// evaluation"; ADR 0082). The signed-in people and agents and the 7-day AI and skill-check numbers are public only as
// gross twins, our own test agents and tests included. No public page shows a House-only count next to them either,
// because a gross number minus a House number is the outside-only number.

/** The 7 UTC days (today included) the gross 7-day numbers cover. */
export const GROSS_DAYS = 7;
const GROSS_TOOL_CALL_KEYS = ["mcp:public:calls", "mcp:gauntlet:calls", "mcp:signed_in:calls", "mcp:house:calls"] as const;

export const GROSS_RULES: StatsRule[] = [
  { key: "signed_in_people", label: "People signed in (our own accounts included)", source: "humans", counts: "Every person who signed in with GitHub, sandbox included.", ours: "House and founder accounts are in this number.", window: "All time", minimum: PUBLIC_ROW_MINIMUMS.signed_in_people, reproduce: "SELECT count(*) FROM humans;" },
  { key: "signed_in_agents", label: "Agents linked to a signed-in person (our own test agents included)", source: "agents", counts: "Active (not revoked) agents.", ours: "House test agents and the founder's agents are in this number.", window: "All time", minimum: PUBLIC_ROW_MINIMUMS.signed_in_agents, reproduce: "SELECT count(*) FROM agents WHERE status = 'active';" },
  { key: "ai_tool_calls_7d", label: "AI tool calls, last 7 days (ours included)", source: "usage_daily", counts: "Tool calls on the Forge's MCP servers (public, Gauntlet and signed-in), House calls and our own tagged tests included.", ours: "House calls and our tagged tests are in this number; so are monitors and catalogues.", window: "The last 7 UTC days, today included", minimum: null, reproduce: `SELECT coalesce(sum(n), 0) FROM usage_daily WHERE day >= '<today - 6 days>' AND (key IN (${GROSS_TOOL_CALL_KEYS.map((k) => `'${k}'`).join(", ")}) OR key LIKE 'internal:%:calls');` },
  { key: "skill_checks_7d", label: "Skill scans, last 7 days (ours included)", source: "usage_daily", counts: "Scan requests on the web, API, MCP and A2A, directory and checker clients and our own tagged tests included. Each request counts once.", ours: "Our tagged tests and directory checkers are in this number.", window: "The last 7 UTC days, today included", minimum: null, reproduce: `SELECT coalesce(sum(n), 0) FROM usage_daily WHERE day >= '<today - 6 days>' AND (key IN (${OUTSIDE_SCAN_KEYS.map((k) => `'${k}'`).join(", ")}) OR key LIKE 'internal:%:scans');` },
];

export type GrossKey = "signed_in_people" | "signed_in_agents" | "ai_tool_calls_7d" | "skill_checks_7d";

/** The gross twins of the people, agent and 7-day numbers: exact, no minimum, our own included and labelled so. */
export async function grossNumbers(env: Env, now = Date.now()) {
  const db = getDb(env);
  const since = new Date(now - (GROSS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const one = async (q: Promise<{ n: number | null }[]>) => Number((await q)[0]?.n ?? 0);
  const usage = (keys: readonly string[], like: string) =>
    one(
      db
        .select({ n: sql<number>`coalesce(sum(${t.usageDaily.n}), 0)` })
        .from(t.usageDaily)
        .where(and(sql`${t.usageDaily.day} >= ${since}`, or(inArray(t.usageDaily.key, [...keys]), sql`${t.usageDaily.key} like ${like}`))),
    );
  const [people, agents, calls, scans] = await Promise.all([
    one(db.select({ n: sql<number>`count(*)` }).from(t.humans)),
    one(db.select({ n: sql<number>`count(*)` }).from(t.agents).where(eq(t.agents.status, "active"))),
    usage(GROSS_TOOL_CALL_KEYS, "internal:%:calls"),
    usage(OUTSIDE_SCAN_KEYS, "internal:%:scans"),
  ]);
  const values: Record<GrossKey, number> = { signed_in_people: people, signed_in_agents: agents, ai_tool_calls_7d: calls, skill_checks_7d: scans };
  return values;
}

/** B3-04 (ADR 0099): the gross rows that are left out of public output until they pass their minimum. */
const GROSS_ROW_MINIMUM: Partial<Record<GrossKey, PublicRowKey>> = { signed_in_people: "signed_in_people", signed_in_agents: "signed_in_agents" };

/** Options for the public JSON builders: `allRows` (admin and data room only) keeps rows below their minimum. */
export interface RowOptions {
  allRows?: boolean;
}

/**
 * The gross numbers as data (/stats.json, /api/v1/stats, the home JSON twin). B3-04: a row with a minimum is left out
 * (not null, not flagged) until its value passes it, unless `allRows` (internal callers only).
 */
export function grossJson(values: Record<GrossKey, number> | null, origin = "", o: RowOptions = {}) {
  return {
    includes_own_test_agents: true as const,
    caveat: TOTALS_NOTE,
    days: GROSS_DAYS,
    rules_url: `${origin}/stats/rules#gross`,
    items: GROSS_RULES.filter((r) => {
      const m = GROSS_ROW_MINIMUM[r.key as GrossKey];
      return o.allRows || !m || (values !== null && rowShown(m, values[r.key as GrossKey]));
    }).map((r) => ({ key: r.key, label: r.label, value: values ? values[r.key as GrossKey] : null, rule_url: `${origin}/stats/rules#${r.key}` })),
  };
}

/** The JSON fields that used to carry outside-only numbers: kept for old readers, always null, listed in internal_only. */
export const STATS_INTERNAL_FIELDS = ["headline", "active_owners_30d", "now", "history", "usage", "skill_checks", "agent_funnel"] as const;
