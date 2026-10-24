import { and, eq, gte, like, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { agentFunnel, directorySessions, isDirectoryClient } from "./agent-funnel";
import { getDb } from "./db";
import { dataInventory, growthKpis } from "./kpis";
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
  const conversion = await conversionDaily(env, now);
  // The growth KPIs (ADR 0039): Scout reports the north star and flags any KPI that fell for 2 weeks running.
  const kpis = await growthKpis(env, now).catch((e) => ({ as_of: yesterday, kpis: [], error: String(e) }));
  const data_inventory = await dataInventory(env, now).catch((e) => ({ error: String(e) }));

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
    .map((c) => ({ ...c, directory: isDirectoryClient(c.name) }))
    .sort((a, b) => b.sessions_7d + b.calls_7d - (a.sessions_7d + a.calls_7d) || a.name.localeCompare(b.name))
    .slice(0, 50);

  return {
    data_kind: "scout_signals",
    day: yesterday,
    kpis,
    data_inventory,
    misses: { yesterday: missesDay, last_7_days: missesWeek },
    mcp_clients: list,
    new_clients: [...clients.values()].filter((c) => c.first_seen === yesterday).map((c) => c.name).sort(),
    discovery_fetches: Object.fromEntries(discRows.map((r) => [r.key.slice(5), Number(r.n)])),
    funnel_7d: funnel,
    conversion,
    excludes: ["house", "crawlers (misses)", "founder accounts (funnel contributions)"],
  };
}

/**
 * The conversion KPI (Dinike, 23 Oct): page visits → AI agents connected, per day for the last 14 full days, oldest
 * first. Internal only (OIDC): it holds the people-only numbers the public site doesn't show.
 * - page_views: every page view, crawlers included (visit:all); people: arrivals from outside, crawlers left out;
 * - connect_page: people opening /connect; connect_tests_passed: people whose AI checked the /connect test code;
 * - connections: MCP sessions on our three endpoints (directory health checks and House left out) plus A2A requests;
 * - humans: browsers that ran site.js (the honest people count; `people` is inflated by crawlers posing as browsers);
 * - per_1k_page_views, per_100_people and per_100_humans: connections per 1,000 page views, per 100 people and per
 *   100 humans (null when 0).
 */
export async function conversionDaily(env: Env, now = Date.now(), days = 14) {
  const db = getDb(env);
  const first = day(now - days * 86_400_000), last = day(now - 86_400_000);
  const rows = await db
    .select({ day: t.usageDaily.day, key: t.usageDaily.key, n: t.usageDaily.n })
    .from(t.usageDaily)
    .where(
      and(
        gte(t.usageDaily.day, first),
        sql`${t.usageDaily.day} <= ${last}`,
        sql`(${t.usageDaily.key} in ('visit:all', 'visit:crawler', 'visit:arrivals', 'visit:human', 'scan:web', 'contribute:report-page', 'contribute:web-filed', 'visit:connect', 'connect:test-passed', 'a2a:requests', 'mcp:public:sessions', 'mcp:gauntlet:sessions', 'mcp:signed_in:sessions', 'mcp:public:calls', 'mcp:gauntlet:calls', 'mcp:signed_in:calls') or ${t.usageDaily.key} like 'mcp:client:%')`,
      ),
    );
  const rate = (x: number, of: number, per: number) => (of > 0 ? Math.round((x / of) * per * 10) / 10 : null);
  return Array.from({ length: days }, (_, i) => {
    const d = day(now - (days - i) * 86_400_000);
    const r = rows.filter((x) => x.day === d);
    const get = (k: string) => r.filter((x) => x.key === k).reduce((a, x) => a + x.n, 0);
    const directory = directorySessions(r);
    const connections = Math.max(0, get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions") - directory) + get("a2a:requests");
    const pageViews = get("visit:all"), people = get("visit:arrivals");
    return {
      day: d,
      page_views: pageViews,
      crawler_page_views: get("visit:crawler"),
      people,
      /** Real people: browsers that ran site.js and sent its beacon (visit:human), the honest count. */
      humans: get("visit:human"),
      web_scans: get("scan:web"),
      /** ADR 0038: views of the pre-filled /report page, and reports people filed there. */
      report_page_views: get("contribute:report-page"),
      web_reports: get("contribute:web-filed"),
      connect_page: get("visit:connect"),
      connect_tests_passed: get("connect:test-passed"),
      connections,
      tool_uses: get("mcp:public:calls") + get("mcp:gauntlet:calls") + get("mcp:signed_in:calls") + get("a2a:requests"),
      per_1k_page_views: rate(connections, pageViews, 1000),
      per_100_people: rate(connections, people, 100),
      per_100_humans: rate(connections, get("visit:human"), 100),
    };
  });
}
