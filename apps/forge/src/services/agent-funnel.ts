import { and, eq, gte, notInArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";

// The agent funnel (Dinike, 20 Oct 2026: "a metric on our site that shows the numbers of agents that have used our
// site... monitor this very clearly and actively"). From the daily counters, five stages over a window:
//   found us → connected → used a tool → came back → contributed.
// Daily totals only (Privacy Policy: "daily count"), so these count fetches, sessions and calls, not distinct agents;
// distinct agents are only known for signed-in agents. Directory health checks (Glama and the like connect to test
// the endpoint) are counted apart, never as agents. House activity is never in any stage.

/** MCP clients that are directory health checks, not agents doing work. */
export const DIRECTORY_CLIENTS = ["glama", "smithery", "pulsemcp", "mcp-registry", "mcp-inspector"];

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function agentFunnel(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(
      and(
        gte(t.usageDaily.day, since),
        sql`(${t.usageDaily.key} like 'mcp:%' or ${t.usageDaily.key} like 'a2a:%' or ${t.usageDaily.key} like 'ai:%' or ${t.usageDaily.key} like 'disc:%' or ${t.usageDaily.key} like 'skills:%' or ${t.usageDaily.key} like 'skillmd:%' or ${t.usageDaily.key} like 'scan:%' or ${t.usageDaily.key} like 'watch:%')`,
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

  // Connected: MCP sessions on our three endpoints, less directory health checks, plus A2A requests.
  const directoryChecks = DIRECTORY_CLIENTS.reduce((a, c) => a + get(`mcp:client:${c}`), 0);
  const mcpSessions = Math.max(0, get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions") - directoryChecks);
  const a2a = get("a2a:requests");
  const connected = mcpSessions + a2a;

  // Used a tool: MCP tool calls, A2A skill calls and API scans. (Each A2A request runs one skill, counted once.)
  const toolCalls = get("mcp:public:calls") + get("mcp:gauntlet:calls") + get("mcp:signed_in:calls");
  const apiScans = get("scan:api");
  const used = toolCalls + a2a + apiScans;

  // Came back: weekly-watch check-ins (an agent re-checking what it installed, by itself).
  const returned = get("watch:calls");

  // Contributed: field reports filed by agents of people outside the project (House and founder accounts left out).
  const founders = (env.ADMIN_GITHUB_IDS ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
  const outside = and(eq(t.humans.isHouse, false), founders.length ? notInArray(t.humans.githubId, founders) : sql`1 = 1`);
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(outside, gte(t.reports.createdAt, now - days * 86_400_000)));
  const contributed = Number(r?.n ?? 0);
  // Signed-in agents of people outside the project: the one count of distinct agents we have.
  const [a] = await db.select({ n: sql<number>`count(*)` }).from(t.agents).innerJoin(t.humans, eq(t.agents.humanId, t.humans.id)).where(outside);

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
      house_mcp_sessions: get("mcp:house:sessions"),
    },
    signed_in_agents_all_time: Number(a?.n ?? 0),
  };
}

/** Daily totals of the first three stages for the last `days` days, oldest first, in one query. */
export async function agentFunnelDaily(env: Env, now = Date.now(), days = 14) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ day: t.usageDaily.day, key: t.usageDaily.key, n: t.usageDaily.n })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), sql`(${t.usageDaily.key} like 'mcp:%' or ${t.usageDaily.key} like 'a2a:%' or ${t.usageDaily.key} like 'ai:%' or ${t.usageDaily.key} like 'disc:%' or ${t.usageDaily.key} like 'skills:%' or ${t.usageDaily.key} = 'skillmd:agent' or ${t.usageDaily.key} = 'scan:api')`));
  return Array.from({ length: days }, (_, i) => {
    const d = day(now - (days - 1 - i) * 86_400_000);
    const r = rows.filter((x) => x.day === d);
    const get = (k: string) => r.filter((x) => x.key === k).reduce((a, x) => a + x.n, 0);
    const pre = (p: string) => r.filter((x) => x.key.startsWith(p)).reduce((a, x) => a + x.n, 0);
    const dir = DIRECTORY_CLIENTS.reduce((a, c) => a + get(`mcp:client:${c}`), 0);
    const found = get("ai:indexer") + get("ai:live") + get("ai:coding") + pre("disc:") + get("skillmd:agent") + get("skills:index") + pre("skills:file:");
    const connected = Math.max(0, get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions") - dir) + get("a2a:requests");
    const used = get("mcp:public:calls") + get("mcp:gauntlet:calls") + get("mcp:signed_in:calls") + get("a2a:requests") + get("scan:api");
    return { day: d, found, connected, used };
  });
}

/** The five stages in order, with their plain-English labels. */
export const FUNNEL_STAGES = [
  ["found", "found us", "AI agents fetched our pages, discovery files or skill files"],
  ["connected", "connected", "AI apps opened an MCP session or sent an A2A request (directory health checks left out)"],
  ["used", "used a tool", "tool calls, A2A skill calls and API scans"],
  ["returned", "came back", "weekly-watch check-ins: an agent re-checking what it installed, by itself"],
  ["contributed", "contributed", "field reports from agents of people outside the project"],
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number][0];

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
  const all = {
    found: f.stages.found,
    connected: d.mcp_sessions + d.directory_health_checks + d.house_mcp_sessions + d.a2a_requests,
    used: f.stages.used + houseCalls,
  };
  const shown = (v: number) => (v > 0 ? v : null);
  return {
    agent_visits_total: shown(all.found),
    agent_connections_total: shown(all.connected),
    agent_tool_uses_total: shown(all.used),
    since: COUNTING_SINCE,
    includes_house_and_directory_checks: true,
  };
}

/** Labels for the home page's live agent numbers (running totals). */
export const LIVE_AGENT_LABELS = [
  ["agent_visits_total", "AI agent visits"],
  ["agent_connections_total", "AI connections"],
  ["agent_tool_uses_total", "tool uses by AI"],
] as const;
