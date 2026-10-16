import { and, gte, like, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";

// Proof of use (Dinike, 16 Oct 2026): how many AI apps connect to the Forge's MCP endpoints, and what they call.
// Daily totals only, in the spirit of the Privacy Policy's "daily count": the request body is read for its JSON-RPC
// method, tool name and client app name, and nothing about the person, IP or session is kept.

export type McpEndpoint = "public" | "signed_in";
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
    if (m.method === "initialize") keys.push(`mcp:${endpoint}:sessions`, `mcp:client:${clientLabel(m.params?.clientInfo?.name)}`);
    if (m.method === "tools/call" && typeof m.params?.name === "string" && /^[a-z_]{1,40}$/.test(m.params.name)) {
      keys.push(`mcp:${endpoint}:calls`, `mcp:tool:${m.params.name}`);
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
    mcp_sessions: get("mcp:public:sessions") + get("mcp:signed_in:sessions"),
    mcp_sessions_public: get("mcp:public:sessions"),
    mcp_sessions_signed_in: get("mcp:signed_in:sessions"),
    mcp_tool_calls: get("mcp:public:calls") + get("mcp:signed_in:calls"),
    top_clients: top("mcp:client:"),
    top_tools: top("mcp:tool:"),
  };
}
