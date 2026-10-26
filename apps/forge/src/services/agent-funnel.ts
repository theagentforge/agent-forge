import { and, eq, gte, like, lte, notInArray, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { isInternalClient } from "./internal";

// The agent funnel (Dinike, 20 Oct 2026: "a metric on our site that shows the numbers of agents that have used our
// site... monitor this very clearly and actively"). From the daily counters, five stages over a window:
//   found us → connected → used a tool → came back → contributed.
// Daily totals only (Privacy Policy: "daily count"), so these count fetches, sessions and calls, not distinct agents;
// distinct agents are only known for signed-in agents. Directory health checks (Glama and the like connect to test
// the endpoint) are counted apart, never as agents. House activity is never in any stage.

/** MCP clients that are directory health checks, not agents doing work. */
export const DIRECTORY_CLIENTS = ["glama", "smithery", "pulsemcp", "mcp-registry", "mcp-inspector"];
// After the MCP Registry update on 23 Oct about 58 new client names arrived, nearly all catalogues and checkers that
// open a session and leave (agentrank-probe, talaria-catalog, mcpscore, verifymcp-probe...). They name themselves,
// so a name pattern catches them (forge-scout, our own collector, too).
const CHECKER_NAME = /probe|prober|catalog|index|crawl|scan|scrape|check|health|registry|inventory|score|rank|monitor|watch|triage|snapshot|research|collector|bench|tlog|spike|scout|(^|-)ping|(^|-)ci$/i;

/**
 * Our own callers' client names, never agents (K7): the names they used before they were tagged, plus the tagged
 * form `theagentforge-internal-<component>` (services/internal.ts). Tagged traffic is counted as `internal:*` and never
 * reaches `mcp:client:*`; this keeps older rows out of the agent counts too.
 */
export const OUR_CLIENTS = ["forge-scout", "theagentforge-house-tester"];
export const isOurClient = (name: string) => OUR_CLIENTS.includes(name) || isInternalClient(name);

/** True when an MCP client name is a directory, catalogue or checker, or one of ours, rather than an agent doing work. */
export const isDirectoryClient = (name: string) => isOurClient(name) || DIRECTORY_CLIENTS.includes(name) || CHECKER_NAME.test(name);

/**
 * Agent apps people use, by the name they report. Most of them (claude.ai among them) speak the 2025 protocol, whose
 * tool calls don't carry the client's name, so "no calls under its name" proves nothing: these are never monitors.
 */
export const AGENT_APPS =
  /^(anthropicclaudeai|claude-ai|claude|claude-code|claude-desktop|cursor|vscode|visual studio code|copilot|github-copilot|codex|gemini|gemini-cli|cline|clinecore|roo|roo-code|kilo|kilo-code|goose|lm studio|lmstudio|windsurf|zed|continue|openai-mcp|chatgpt|perplexity|mistral|le-chat|jetbrains|warp|amp|opencode|librechat|msty|raycast|cherry studio)([ ._-]|$)/;

/**
 * What a client name is, from its own name and the 7 days of counts ending on the day read (ADR 0050):
 * - ours: our own probes (K7), never counted;
 * - directory: a directory, catalogue or checker that names itself (glama, *-probe, *-scanner...);
 * - monitor: any other name with sessions but not one tool call under its name in those 7 days (mcpbeat, histor):
 *   catalog coverage, not demand. "unknown" (clients that give no name) and the AGENT_APPS are never monitors;
 * - agent: everything else, counted as demand.
 */
export type ClientKind = "ours" | "directory" | "monitor" | "agent";
export function clientKind(name: string, sessions7d: number, calls7d: number): ClientKind {
  if (isOurClient(name)) return "ours";
  if (isDirectoryClient(name)) return "directory";
  if (sessions7d > 0 && calls7d === 0 && name !== "unknown" && !AGENT_APPS.test(name)) return "monitor";
  return "agent";
}

/** Each client name's sessions and named calls among `mcp:client:<name>` and `mcp:clientcall:<name>` rows. */
export function clientTotals(rows: { key: string; n: number | string }[]) {
  const out = new Map<string, { sessions: number; calls: number }>();
  for (const r of rows) {
    const m = /^mcp:client(call)?:(.+)$/.exec(r.key);
    if (!m) continue;
    const c = out.get(m[2]!) ?? { sessions: 0, calls: 0 };
    if (m[1]) c.calls += Number(r.n);
    else c.sessions += Number(r.n);
    out.set(m[2]!, c);
  }
  return out;
}

/** Client kinds from rows that cover the 7 days to classify over. */
export function clientKinds(rows: { key: string; n: number | string }[]) {
  return new Map([...clientTotals(rows)].map(([name, c]) => [name, clientKind(name, c.sessions, c.calls)] as const));
}

/**
 * The parts of a window's connection and call counts that aren't demand, from its client rows and the kinds: sessions
 * of monitors (name-matched directories are directorySessions), sessions under our own older names, and tool calls
 * named by ours, directories and monitors (each is in `mcp:<endpoint>:calls` too, so these are subtracted).
 */
export function notDemand(rows: { key: string; n: number | string }[], kinds: Map<string, ClientKind>) {
  let monitorSessions = 0, ownSessions = 0, catalogSessions = 0, catalogCalls = 0;
  const names = new Set<string>();
  for (const [name, c] of clientTotals(rows)) {
    const kind = kinds.get(name) ?? clientKind(name, c.sessions, c.calls);
    if (kind === "agent") continue;
    catalogCalls += c.calls;
    if (kind === "monitor") monitorSessions += c.sessions;
    if (kind === "ours") ownSessions += c.sessions;
    else {
      catalogSessions += c.sessions;
      if (c.sessions + c.calls > 0) names.add(name);
    }
  }
  return { monitorSessions, ownSessions, catalogCalls, monitorsAndCatalogs: { clients: names.size, sessions: catalogSessions, calls: catalogCalls } };
}

/** The UTC day `n` days before day `d` (YYYY-MM-DD). */
export const daysBefore = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** For one day: the client kinds over the 7 days ending that day, and that day's counts that aren't demand. */
export function notDemandOn(rows: { day: string; key: string; n: number | string }[], d: string) {
  const from = daysBefore(d, 6);
  const kinds = clientKinds(rows.filter((r) => r.day >= from && r.day <= d));
  return notDemand(rows.filter((r) => r.day === d), kinds);
}

/** Sessions from directory and checker clients among `mcp:client:<name>` counter rows. */
export const directorySessions = (rows: { key: string; n: number | string }[]) =>
  rows.filter((r) => r.key.startsWith("mcp:client:") && isDirectoryClient(r.key.slice("mcp:client:".length))).reduce((a, r) => a + Number(r.n), 0);

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `internal:<component>:<what>` rows summed by component, e.g. { scout: 12, screens: 40 }. */
export function internalByComponent(rows: { key: string; n: number | string }[]) {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const m = /^internal:([a-z0-9-]+):/.exec(r.key);
    if (m) out[m[1]!] = (out[m[1]!] ?? 0) + Number(r.n);
  }
  return out;
}

/** People outside the project: not House, not a founder account (ADMIN_GITHUB_IDS). A condition on `humans`. */
export function outsidePeople(env: Pick<Env, "ADMIN_GITHUB_IDS">) {
  const founders = (env.ADMIN_GITHUB_IDS ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
  return and(eq(t.humans.isHouse, false), founders.length ? notInArray(t.humans.githubId, founders) : sql`1 = 1`);
}

export async function agentFunnel(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  // Whole UTC days up to `now`'s day: a window that ends yesterday doesn't take in today's partial counts.
  const until = day(now);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(
      and(
        gte(t.usageDaily.day, since),
        lte(t.usageDaily.day, until),
        sql`(${t.usageDaily.key} like 'mcp:%' or ${t.usageDaily.key} like 'a2a:%' or ${t.usageDaily.key} like 'ai:%' or ${t.usageDaily.key} like 'disc:%' or ${t.usageDaily.key} like 'skills:%' or ${t.usageDaily.key} like 'skillmd:%' or ${t.usageDaily.key} like 'scan:%' or ${t.usageDaily.key} like 'watch:%' or ${t.usageDaily.key} like 'connect:%' or ${t.usageDaily.key} like 'internal:%')`,
      ),
    )
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  const sum = (prefix: string, skip: (k: string) => boolean = () => false) => rows.filter((r) => r.key.startsWith(prefix) && !skip(r.key)).reduce((a, r) => a + Number(r.n), 0);

  // Found us: AI agents fetching any page, discovery files, skill files and the skills index.
  const aiFetches = get("ai:indexer") + get("ai:live") + get("ai:coding");
  const discovery = sum("disc:");
  const skillFiles = get("skillmd:agent") + get("skills:index") + sum("skills:file:");
  const found = aiFetches + discovery + skillFiles;

  // Which client names are monitors: the 7 days ending on `now`'s day, whatever the window (ADR 0050).
  const trailing = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, day(now - 6 * 86_400_000)), lte(t.usageDaily.day, until), or(like(t.usageDaily.key, "mcp:client:%"), like(t.usageDaily.key, "mcp:clientcall:%"))))
    .groupBy(t.usageDaily.key);
  const away = notDemand(rows, clientKinds(trailing));

  // Connected: MCP sessions on our three endpoints, less directory health checks and monitors, plus A2A requests.
  const directoryChecks = directorySessions(rows);
  const mcpSessions = Math.max(0, get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions") - directoryChecks - away.monitorSessions);
  const a2a = get("a2a:requests");
  const connected = mcpSessions + a2a;

  // Used a tool: MCP tool calls from outside clients, A2A skill calls and API scans. (Each A2A request runs one skill,
  // counted once.) Calls that a directory, a monitor or one of ours made under its own name are left out.
  const toolCalls = get("mcp:public:calls") + get("mcp:gauntlet:calls") + get("mcp:signed_in:calls");
  const outsideMcpCalls = Math.max(0, toolCalls - away.catalogCalls);
  const apiScans = get("scan:api");
  const used = outsideMcpCalls + a2a + apiScans;

  // Came back: weekly-watch check-ins (an agent re-checking what it installed, by itself).
  const returned = get("watch:calls");

  // Contributed: field reports filed by agents of people outside the project (House and founder accounts left out).
  const outside = outsidePeople(env);
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(outside, gte(t.reports.createdAt, now - days * 86_400_000)));
  const contributed = Number(r?.n ?? 0);
  // Signed-in agents of people outside the project: the one count of distinct agents we have.
  const [a] = await db.select({ n: sql<number>`count(*)` }).from(t.agents).innerJoin(t.humans, eq(t.agents.humanId, t.humans.id)).where(outside);

  // Two sharper reads of the soft stages (research 23 Oct): "found" without search crawlers and bare discovery-file
  // fetches (often scanners), and MCP client apps (by name, not agents) seen on 2+ days of the window. Detail only.
  const foundWithIntent = get("ai:live") + get("ai:coding") + skillFiles;
  const clientDays = await db
    .select({ key: t.usageDaily.key, days: sql<number>`count(distinct ${t.usageDaily.day})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), sql`${t.usageDaily.key} like 'mcp:client:%'`))
    .groupBy(t.usageDaily.key);
  const repeatClients = clientDays.filter((c) => Number(c.days) >= 2 && !isDirectoryClient(c.key.slice("mcp:client:".length))).length;

  const rate = (x: number, of: number) => (of > 0 ? Math.round((x / of) * 1000) / 10 : null);
  return {
    days,
    stages: { found, connected, used, returned, contributed },
    /** Percent of the stage before (null when the stage before is 0). */
    rates: { connected: rate(connected, found), used: rate(used, connected), returned: rate(returned, used), contributed: rate(contributed, used) },
    detail: {
      ai_fetches: aiFetches,
      discovery_file_fetches: discovery,
      skill_file_fetches: skillFiles,
      mcp_sessions: mcpSessions,
      a2a_requests: a2a,
      tool_calls: toolCalls,
      api_scans: apiScans,
      directory_health_checks: directoryChecks,
      /** Sessions from names with no tool call under their name in 7 days (ADR 0050), in no stage. */
      monitor_sessions: away.monitorSessions,
      /** Directories, catalogues, checkers and monitors together: catalog coverage, not demand (ADR 0050). */
      monitors_and_catalogs: away.monitorsAndCatalogs,
      /** Sessions under our own older client names (forge-scout...); they are inside directory_health_checks. */
      own_client_sessions: away.ownSessions,
      /** MCP tool calls from outside clients (House, ours, directories and monitors left out) plus A2A requests. */
      outside_tool_calls: outsideMcpCalls + a2a,
      house_mcp_sessions: get("mcp:house:sessions"),
      found_with_intent: foundWithIntent,
      mcp_client_apps_on_2plus_days: repeatClients,
      /** People who finished /connect: their AI checked the page's one-time test code. */
      connect_tests_passed: get("connect:test-passed"),
      /** The /connect steps before it (ADR 0050): tile chosen, install link or command copied, test code shown. */
      connect_tiles_chosen: sum("connect:tile:"),
      connect_copied: sum("connect:copied:") - get("connect:copied:test-prompt"),
      connect_test_prompt_copied: get("connect:copied:test-prompt"),
      connect_code_shown: get("connect:code-shown"),
      /** Our own probes (K7: Scout, CI install tests, House, screens, our Action), in no stage above. */
      internal_requests: sum("internal:"),
      internal_by_component: internalByComponent(rows),
    },
    signed_in_agents_all_time: Number(a?.n ?? 0),
  };
}

/** Daily totals of the first three stages for the last `days` days, oldest first, in one query. */
export async function agentFunnelDaily(env: Env, now = Date.now(), days = 14) {
  const db = getDb(env);
  // Six days more than shown, so each day's monitors are read over the 7 days ending that day.
  const since = day(now - (days - 1 + 6) * 86_400_000);
  const rows = await db
    .select({ day: t.usageDaily.day, key: t.usageDaily.key, n: t.usageDaily.n })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), lte(t.usageDaily.day, day(now)), sql`(${t.usageDaily.key} like 'mcp:%' or ${t.usageDaily.key} like 'a2a:%' or ${t.usageDaily.key} like 'ai:%' or ${t.usageDaily.key} like 'disc:%' or ${t.usageDaily.key} like 'skills:%' or ${t.usageDaily.key} = 'skillmd:agent' or ${t.usageDaily.key} = 'scan:api')`));
  return Array.from({ length: days }, (_, i) => {
    const d = day(now - (days - 1 - i) * 86_400_000);
    const r = rows.filter((x) => x.day === d);
    const get = (k: string) => r.filter((x) => x.key === k).reduce((a, x) => a + x.n, 0);
    const pre = (p: string) => r.filter((x) => x.key.startsWith(p)).reduce((a, x) => a + x.n, 0);
    const dir = directorySessions(r);
    const away = notDemandOn(rows, d);
    const found = get("ai:indexer") + get("ai:live") + get("ai:coding") + pre("disc:") + get("skillmd:agent") + get("skills:index") + pre("skills:file:");
    const connected = Math.max(0, get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions") - dir - away.monitorSessions) + get("a2a:requests");
    const used = Math.max(0, get("mcp:public:calls") + get("mcp:gauntlet:calls") + get("mcp:signed_in:calls") - away.catalogCalls) + get("a2a:requests") + get("scan:api");
    return { day: d, found, connected, used };
  });
}

/** The five stages in order, with their plain-English labels. */
export const FUNNEL_STAGES = [
  ["found", "found us", "AI agents fetched our pages, discovery files or skill files"],
  ["connected", "connected", "AI apps opened an MCP session or sent an A2A request (directory health checks and monitors left out)"],
  ["used", "used a tool", "tool calls from outside apps, A2A skill calls and API scans"],
  ["returned", "came back", "weekly-watch check-ins: an agent re-checking what it installed, by itself"],
  ["contributed", "contributed", "field reports from agents of people outside the project"],
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number][0];

/** The first day of the gross page-view count. */
export const PAGE_VIEWS_SINCE = "2026-10-15";

/**
 * Page views before the Worker counted them (released 23 Oct, 03:12 UTC): Cloudflare's count of HTML responses on
 * theagentforge.io, crawlers included, read through the zone analytics API on 23 Oct. Added to visit:all.
 */
export const PAGE_VIEWS_BACKFILL: Record<string, number> = {
  "2026-10-15": 2171,
  "2026-10-16": 2423,
  "2026-10-17": 1319,
  "2026-10-18": 8222,
  "2026-10-19": 6566,
  "2026-10-20": 25889,
  "2026-10-21": 10129,
  "2026-10-22": 14958,
  "2026-10-23": 499, // 00:00–03:12 UTC
};

/** The day the agent counters started (the first day in usage_daily for these keys). */
export const COUNTING_SINCE = "2026-10-20";

/**
 * The home page's live agent numbers (ADR 0030): running totals since counting started, everything included. Unlike
 * the funnel above, our own House sessions and directory health checks (Glama and the like) count too, and the
 * label on the page says so. Each is null at zero, so the page never shows a zero.
 */
export async function liveAgentCounts(env: Env, now = Date.now()) {
  const allDays = Math.ceil((now - Date.parse(`${COUNTING_SINCE}T00:00:00Z`)) / 86_400_000) + 1;
  const f = await agentFunnel(env, now, Math.max(1, allDays));
  const d = f.detail;
  const [h] = await getDb(env)
    .select({ n: sql<number>`coalesce(sum(${t.usageDaily.n}), 0)` })
    .from(t.usageDaily)
    .where(eq(t.usageDaily.key, "mcp:house:calls"));
  const houseCalls = Number(h?.n ?? 0);
  // Gross page views, crawlers included (Dinike, 23 Oct: "the full gross large number"), since 15 Oct. 15–22 Oct come
  // from Cloudflare's HTML request counts (PAGE_VIEWS_BACKFILL, production only); later views are counted as they happen.
  const [pv] = await getDb(env)
    .select({ n: sql<number>`coalesce(sum(${t.usageDaily.n}), 0)` })
    .from(t.usageDaily)
    .where(and(eq(t.usageDaily.key, "visit:all"), gte(t.usageDaily.day, PAGE_VIEWS_SINCE)));
  const all = {
    found: f.stages.found,
    connected: d.mcp_sessions + d.directory_health_checks + d.monitor_sessions + d.house_mcp_sessions + d.a2a_requests,
    used: f.stages.used + d.monitors_and_catalogs.calls + houseCalls,
  };
  const shown = (v: number) => (v > 0 ? v : null);
  return {
    page_views_total: shown(Number(pv?.n ?? 0) + (env.ENVIRONMENT === "production" ? Object.values(PAGE_VIEWS_BACKFILL).reduce((a, b) => a + b, 0) : 0)),
    agent_visits_total: shown(all.found),
    agent_connections_total: shown(all.connected),
    agent_tool_uses_total: shown(all.used),
    since: COUNTING_SINCE,
    includes_house_and_directory_checks: true,
  };
}

/** Labels for the home page's live agent numbers (running totals). */
export const LIVE_AGENT_LABELS = [
  ["page_views_total", "page views"],
  ["agent_visits_total", "AI agent visits"],
  ["agent_connections_total", "AI connections"],
  ["agent_tool_uses_total", "tool uses by AI"],
] as const;
