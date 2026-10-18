import { and, gte, like, sql } from "drizzle-orm";
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
  if (!keys.length) return;
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
