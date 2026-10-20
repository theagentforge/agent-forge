import { and, gte, like, sql } from "drizzle-orm";
import { isLean } from "./ops-mode";
import * as t from "../db/schema";
import { getDb } from "./db";

// Proof of use (Dinike, 16 Oct 2026): how many AI apps connect to the Forge's MCP endpoints, and what they call.
// Daily totals only, in the spirit of the Privacy Policy's "daily count": the request body is read for its JSON-RPC
// method, tool name and client app name, and nothing about the person, IP or session is kept.

/** "house" is a signed-in session by one of our own accounts (ADR 0023 §3): counted apart, never as usage. */
export type McpEndpoint = "public" | "gauntlet" | "signed_in" | "house";
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Client app names as the MCP client reports them ("claude-ai", "cursor"…), squeezed to a safe, short label. */
export const clientLabel = (name: unknown) => {
  const s = typeof name === "string" ? name.toLowerCase().replace(/[^a-z0-9 ._-]/g, "").trim().slice(0, 40) : "";
  return s || "unknown";
};

/** The counters one MCP request adds: a session per `initialize`, a call per `tools/call` (background traffic like tools/list isn't use). */
export function mcpCounters(endpoint: McpEndpoint, body: unknown): string[] {
  const msgs = (Array.isArray(body) ? body : [body]).slice(0, 10) as { method?: unknown; params?: { name?: unknown; clientInfo?: { name?: unknown } } }[];
  const keys: string[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    // House sessions add only their own totals, never the app or tool lists people outside the project make.
    const house = endpoint === "house";
    if (m.method === "initialize") keys.push(`mcp:${endpoint}:sessions`, ...(house ? [] : [`mcp:client:${clientLabel(m.params?.clientInfo?.name)}`]));
    if (m.method === "tools/call" && typeof m.params?.name === "string" && /^[a-z_]{1,40}$/.test(m.params.name)) {
      keys.push(`mcp:${endpoint}:calls`, ...(house ? [] : [`mcp:tool:${m.params.name}`]));
    }
  }
  return keys;
}

export async function bump(env: Env, keys: string[], now = Date.now()) {
  if (!keys.length || (await isLean(env))) return;
  const db = getDb(env);
  const d = day(now);
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  await db
    .insert(t.usageDaily)
    .values([...counts].map(([key, n]) => ({ day: d, key, n })))
    .onConflictDoUpdate({ target: [t.usageDaily.day, t.usageDaily.key], set: { n: sql`${t.usageDaily.n} + excluded.n` } });
}

/** Reads a POSTed MCP request's body (without consuming the original) and counts it. Never throws. */
export async function recordMcp(env: Env, endpoint: McpEndpoint, request: Request, now = Date.now()) {
  try {
    if (request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > 65_536) return;
    await bump(env, mcpCounters(endpoint, JSON.parse(await request.text())), now);
  } catch {
    // Not JSON, or the database is busy: usage counts must never break the endpoint.
  }
}

/** Totals over the last `days` days (today included) for /stats and the ops digest. */
export async function usageStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), like(t.usageDaily.key, "mcp:%")))
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  const top = (prefix: string) =>
    rows
      .filter((r) => r.key.startsWith(prefix))
      .map((r) => ({ name: r.key.slice(prefix.length), n: Number(r.n) }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, 5);
  return {
    days,
    mcp_sessions: get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions"),
    mcp_sessions_public: get("mcp:public:sessions"),
    mcp_sessions_gauntlet: get("mcp:gauntlet:sessions"),
    mcp_sessions_signed_in: get("mcp:signed_in:sessions"),
    mcp_tool_calls: get("mcp:public:calls") + get("mcp:gauntlet:calls") + get("mcp:signed_in:calls"),
    /** Our own signed-in sessions (House and founder accounts), never part of the totals above. */
    house_mcp_sessions: get("mcp:house:sessions"),
    house_mcp_tool_calls: get("mcp:house:calls"),
    top_clients: top("mcp:client:"),
    top_tools: top("mcp:tool:"),
  };
}

// Where visitors come from (Dinike, 17 Oct 2026: "are our X posts working?"). Daily totals only, like the MCP counts:
// the referring site is reduced to a fixed source label and a link's own `?from=`/`?ref=`/`utm_source` tag to a short
// label. No IP, no path, no cookie, nothing about the person. Bots and link-preview fetchers aren't counted.

const SOURCES: [RegExp, string][] = [
  [/(^|\.)(t\.co|x\.com|twitter\.com)$/, "x"],
  [/(^|\.)news\.ycombinator\.com$/, "hn"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, "linkedin"],
  [/(^|\.)bsky\.app$/, "bluesky"],
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave)\.[a-z.]+$|(^|\.)search\.brave\.com$/, "search"],
  [/(^|\.)(chatgpt\.com|claude\.ai|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com)$/, "ai-chat"],
];
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|go-http|headless|lighthouse|monitor/i;

/** Source label for a Referer header: "direct" when there is none, "internal" for our own pages, "other" otherwise. */
export function sourceLabel(referer: string | null | undefined, origin: string) {
  if (!referer) return "direct";
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === new URL(origin).hostname || host.endsWith(".theagentforge.io")) return "internal";
  return SOURCES.find(([re]) => re.test(host))?.[1] ?? "other";
}

/** The counters one page view adds, or none for bots, non-GET and our own internal navigation. */
export function visitCounters(req: { method: string; url: string; headers: Headers }, origin: string): string[] {
  if (req.method !== "GET" || BOT_UA.test(req.headers.get("user-agent") ?? "")) return [];
  const source = sourceLabel(req.headers.get("referer"), origin);
  if (source === "internal") return [];
  const q = new URL(req.url).searchParams;
  const tag = (q.get("from") ?? q.get("ref") ?? q.get("utm_source") ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return ["visit:arrivals", `visit:src:${source}`, ...(tag ? [`visit:tag:${tag}`] : [])];
}

/** Arrivals by source and by link tag over the last `days` days, for the ops digest and /api/v1/growth. */
export async function visitStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), like(t.usageDaily.key, "visit:%")))
    .groupBy(t.usageDaily.key);
  const list = (prefix: string) =>
    rows
      .filter((r) => r.key.startsWith(prefix))
      .map((r) => ({ name: r.key.slice(prefix.length), n: Number(r.n) }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return { days, arrivals: Number(rows.find((r) => r.key === "visit:arrivals")?.n ?? 0), by_source: list("visit:src:"), by_tag: list("visit:tag:").slice(0, 10) };
}

// AI agent traffic (docs/launch/agent-channels.md §4.5): AI user agents are dropped from visit counts as bots, so
// they're counted here instead, in three groups. Indexers build AI search; live fetches happen while a person waits for
// an answer; coding agents are tools like Claude Code. Daily totals by group, agent and kind of page; nothing else.
const AI_AGENTS: [RegExp, "indexer" | "live" | "coding", string][] = [
  [/OAI-SearchBot/i, "indexer", "openai"],
  [/Claude-SearchBot/i, "indexer", "anthropic"],
  [/PerplexityBot/i, "indexer", "perplexity"],
  [/ChatGPT-User/i, "live", "openai"],
  [/Claude-User/i, "live", "anthropic"],
  [/Perplexity-User/i, "live", "perplexity"],
  [/claude-code|claude-cli/i, "coding", "claude-code"],
  [/\bcursor\b/i, "coding", "cursor"],
  [/\bcodex\b/i, "coding", "codex"],
  [/windsurf|codeium/i, "coding", "windsurf"],
];

/** The kind of page an AI agent fetched, for the counters. */
export const aiPageKind = (path: string) =>
  path.startsWith("/tools/") ? "tools" : path === "/llms.txt" ? "llms" : path === "/skill.md" || path.startsWith("/.well-known/agent-skills/") || path.startsWith("/.well-known/skills/") ? "skills" : path.startsWith("/scan/") ? "scan" : path.startsWith("/.well-known/") ? "discovery" : "other";

export function aiAgentCounters(req: { method: string; url: string; headers: Headers }): string[] {
  if (req.method !== "GET") return [];
  const ua = req.headers.get("user-agent") ?? "";
  const hit = AI_AGENTS.find(([re]) => re.test(ua));
  if (!hit) return [];
  const [, group, name] = hit;
  return [`ai:${group}`, `ai:${group}:${name}`, `ai:${group}:page:${aiPageKind(new URL(req.url).pathname)}`];
}

/** AI agent traffic over the last `days` days, for the ops digest and /api/v1/growth. */
export async function aiAgentStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), like(t.usageDaily.key, "ai:%")))
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  const group = (g: string) => ({
    total: get(`ai:${g}`),
    by_agent: Object.fromEntries(rows.filter((r) => r.key.startsWith(`ai:${g}:`) && !r.key.includes(":page:")).map((r) => [r.key.slice(`ai:${g}:`.length), Number(r.n)])),
    by_page: Object.fromEntries(rows.filter((r) => r.key.startsWith(`ai:${g}:page:`)).map((r) => [r.key.slice(`ai:${g}:page:`.length), Number(r.n)])),
  });
  return { days, indexers: group("indexer"), live_fetches: group("live"), coding_agents: group("coding") };
}

// Skill checks (ADR 0026), the launch metric: scans by where they came from, weekly-watch check-ins (agents coming
// back by themselves) and fetches of /skill.md by agents (the nearest thing to an install count). Daily totals only.

export type ScanChannel = "web" | "api" | "mcp" | "a2a";
export const scanCounters = (channel: ScanChannel, verdict: string) => [`scan:${channel}`, `scan:verdict:${verdict.replace(/[^a-z]/g, "")}`];
export const watchCounters = (fingerprints: number) => ["watch:calls", ...Array<string>(Math.min(Math.max(fingerprints, 0), 100)).fill("watch:fingerprints")];

const CRAWLER_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|lighthouse|monitor/i;
/** A fetch of the agent skill file: a browser (someone reading it), an agent (curl, fetch tools, MCP clients), or a crawler (not counted). */
export function skillFileCounters(req: { method: string; headers: Headers }): string[] {
  if (req.method !== "GET" || CRAWLER_UA.test(req.headers.get("user-agent") ?? "")) return [];
  return [/text\/html/.test(req.headers.get("accept") ?? "") ? "skillmd:browser" : "skillmd:agent"];
}

/** Skill-check totals over the last `days` days, for /stats, /api/v1/growth and the ops digest. */
export async function skillStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), sql`(${t.usageDaily.key} like 'scan:%' or ${t.usageDaily.key} like 'watch:%' or ${t.usageDaily.key} like 'skillmd:%' or ${t.usageDaily.key} like 'a2a:%')`))
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  return {
    days,
    scans: get("scan:web") + get("scan:api") + get("scan:mcp") + get("scan:a2a"),
    scans_by_channel: { web: get("scan:web"), api: get("scan:api"), mcp: get("scan:mcp"), a2a: get("scan:a2a") },
    scans_flagged: get("scan:verdict:flagged"),
    watch_checkins: get("watch:calls"),
    watch_fingerprints: get("watch:fingerprints"),
    skill_file_agent_fetches: get("skillmd:agent"),
    skill_file_browser_views: get("skillmd:browser"),
    /** Requests from other agents over A2A (/a2a), and how many asked for each skill. */
    a2a_requests: get("a2a:requests"),
    a2a_by_skill: { check_tool: get("a2a:skill:check-tool"), scan_skill: get("a2a:skill:scan-skill"), trap_card: get("a2a:skill:trap-card") },
  };
}
