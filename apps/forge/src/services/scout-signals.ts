import { and, eq, gte, like, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { agentFunnel, DIRECTORY_CLIENTS } from "./agent-funnel";
import { getDb } from "./db";
import { topMisses } from "./misses";

// Our own signals for Forge Scout (ADR 0031 step 1, ADR 0032 item 2), read once a day by scout-collect.yml in the
// private repo (GitHub OIDC). Aggregate daily counts only, the same rows /stats is built from: no IPs, no people.

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Yesterday (UTC) in full, plus the last 7 days for context:
 * - misses: checks of tools we know nothing about, and scan links on hosts we don't read (most asked first);
 * - clients: MCP client names with their first day in our counts, so a name first seen yesterday is a new surface;
 * - discovery: fetches of our discovery files (agent card, ai-catalog, server cards, llms.txt...);
 * - funnel: the agent funnel's 7-day stages (services/agent-funnel.ts).
 */
export async function scoutSignals(env: Env, now = Date.now()) {
  const db = getDb(env);
  const yesterday = day(now - 86_400_000);
  const weekStart = day(now - 7 * 86_400_000);

  const clientKey = or(like(t.usageDaily.key, "mcp:client:%"), like(t.usageDaily.key, "mcp:clientcall:%"));
  const [clientRows, recentClients, discRows, missesDay, missesWeek, funnel] = await Promise.all([
    db
      .select({ key: t.usageDaily.key, first: sql<string>`min(${t.usageDaily.day})` })
      .from(t.usageDaily)
      .where(clientKey)
      .groupBy(t.usageDaily.key),
    db
      .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})`, yday: sql<number>`sum(case when ${t.usageDaily.day} = ${yesterday} then ${t.usageDaily.n} else 0 end)` })
      .from(t.usageDaily)
      .where(and(gte(t.usageDaily.day, weekStart), sql`${t.usageDaily.day} <= ${yesterday}`, clientKey))
      .groupBy(t.usageDaily.key),
    db
      .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
      .from(t.usageDaily)
      .where(and(eq(t.usageDaily.day, yesterday), like(t.usageDaily.key, "disc:%")))
      .groupBy(t.usageDaily.key),
    topMisses(env, yesterday, yesterday, 50),
    topMisses(env, weekStart, yesterday, 50),
    agentFunnel(env, now - 86_400_000, 7),
  ]);

  // One entry per client name, whether it said hello with `initialize` or named itself in a call's `_meta`.
  const name = (key: string) => key.replace(/^mcp:client(call)?:/, "");
  const clients = new Map<string, { name: string; first_seen: string; sessions_7d: number; calls_7d: number; yesterday: number }>();
  for (const r of clientRows) {
    const n = name(r.key);
    const c = clients.get(n) ?? { name: n, first_seen: r.first, sessions_7d: 0, calls_7d: 0, yesterday: 0 };
    if (r.first < c.first_seen) c.first_seen = r.first;
    clients.set(n, c);
  }
  for (const r of recentClients) {
    const c = clients.get(name(r.key));
    if (!c) continue;
    if (r.key.startsWith("mcp:clientcall:")) c.calls_7d += Number(r.n);
    else c.sessions_7d += Number(r.n);
    c.yesterday += Number(r.yday);
  }
  const list = [...clients.values()]
    .filter((c) => c.sessions_7d + c.calls_7d > 0 || c.first_seen === yesterday)
    .map((c) => ({ ...c, directory: DIRECTORY_CLIENTS.includes(c.name) }))
    .sort((a, b) => b.sessions_7d + b.calls_7d - (a.sessions_7d + a.calls_7d) || a.name.localeCompare(b.name))
    .slice(0, 50);

  return {
    data_kind: "scout_signals",
    day: yesterday,
    misses: { yesterday: missesDay, last_7_days: missesWeek },
    mcp_clients: list,
    new_clients: [...clients.values()].filter((c) => c.first_seen === yesterday).map((c) => c.name).sort(),
    discovery_fetches: Object.fromEntries(discRows.map((r) => [r.key.slice(5), Number(r.n)])),
    funnel_7d: funnel,
    excludes: ["house", "crawlers (misses)", "founder accounts (funnel contributions)"],
  };
}
