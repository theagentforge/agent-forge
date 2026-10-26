import { and, count, countDistinct, eq, gte, isNotNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { dataInventory, dataSnapshotValues, growthKpis, kpiSnapshotValues } from "./kpis";
import { isLean } from "./ops-mode";
import { type InternalComponent, internalKey } from "./internal";
import { bump } from "./usage";

// The proof scoreboard (MASTER_PLAN §7.5, ADR 0006). Every number is split into external and House, so proof of
// concept is measured on people outside the project only.

export type CheckKind = "web" | "api" | "plugin" | "cli" | "mcp" | "ci";
export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A daily-salted, keyed hash: the same IP gives the same value within a day and an unrelated one the next day. */
export async function sourceHash(secret: string, d: string, raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`check-source|${d}|${raw}`));
  return [...new Uint8Array(mac)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which client made a public check, from its User-Agent (set by our plugin hook and CLI). */
export function checkKind(userAgent: string | undefined, fallback: CheckKind = "api"): CheckKind {
  if (userAgent?.startsWith("theagentforge-claude-plugin")) return "plugin";
  if (userAgent?.startsWith("theagentforge-cli")) return "cli";
  if (userAgent?.startsWith("theagentforge-action")) return "ci";
  return fallback;
}

/**
 * Records that a source ran a check today. Raw IPs are never stored. Errors never affect the check itself. Our own
 * callers (`internal`, services/internal.ts) are never a check source: they add `internal:<component>:checks` instead.
 */
export async function recordCheck(env: Env, kind: CheckKind, raw: string, opts: { house?: boolean; hashed?: boolean; now?: number; internal?: InternalComponent | null } = {}) {
  try {
    if (opts.internal) return await bump(env, [internalKey(opts.internal, "checks")], opts.now);
    if (await isLean(env)) return;
    const d = day(opts.now ?? Date.now());
    const source = opts.hashed === false ? raw : await sourceHash(env.SESSION_SECRET, d, raw);
    await getDb(env)
      .insert(t.checkSources)
      .values({ day: d, source, kind, isHouse: opts.house ?? false })
      .onConflictDoNothing();
  } catch (e) {
    console.error("record_check_failed", String(e));
  }
}

export interface Metric {
  external: number;
  house: number;
}

/** The scoreboard right now; `checksDay` picks the UTC day for the check counts. */
export async function proofNow(env: Env, now = Date.now(), checksDay = day(now)) {
  const db = getDb(env);
  const one = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const split = async (q: (house: boolean) => Promise<{ n: number }[]>): Promise<Metric> => ({
    external: await one(q(false)),
    house: await one(q(true)),
  });
  const week = now - 7 * 86_400_000;
  const reportsBy = (house: boolean) =>
    db.select({ n: count() }).from(t.reports).innerJoin(t.humans, eq(t.reports.humanId, t.humans.id)).where(eq(t.humans.isHouse, house));
  const checks = (kind: CheckKind | null) => (house: boolean) =>
    db
      .select({ n: count() })
      .from(t.checkSources)
      .where(and(eq(t.checkSources.day, checksDay), eq(t.checkSources.isHouse, house), kind ? eq(t.checkSources.kind, kind) : undefined));
  return {
    verified_humans: await split((h) =>
      db.select({ n: count() }).from(t.humans).where(and(eq(t.humans.isHouse, h), eq(t.humans.tier, "verified"))),
    ),
    humans: await split((h) => db.select({ n: count() }).from(t.humans).where(eq(t.humans.isHouse, h))),
    agents: await split((h) =>
      db
        .select({ n: count() })
        .from(t.agents)
        .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
        .where(and(eq(t.humans.isHouse, h), eq(t.agents.status, "active"))),
    ),
    /** The north star (§16): agents that filed at least one report in the last 7 days. */
    weekly_reporting_agents: await split((h) =>
      db
        .select({ n: countDistinct(t.reports.agentId) })
        .from(t.reports)
        .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
        .where(and(eq(t.humans.isHouse, h), gte(t.reports.createdAt, week))),
    ),
    reports: await split(reportsBy),
    reports_with_plugin_strain: await split((h) =>
      db
        .select({ n: count() })
        .from(t.reports)
        .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
        .where(and(eq(t.humans.isHouse, h), eq(t.reports.strainSource, "hook"))),
    ),
    check_sources: await split(checks(null)),
    plugin_check_sources: await split(checks("plugin")),
    cli_check_sources: await split(checks("cli")),
    ci_check_sources: await split(checks("ci")),
    tools_with_score: {
      external: await one(db.select({ n: count() }).from(t.toolScores).where(isNotNull(t.toolScores.successScore))),
      house: 0,
    },
  } satisfies Record<string, Metric>;
}

/** Yesterday's downloads of the CLI from npm's public API (null if npm is unreachable). */
async function npmDownloads(fetcher: typeof fetch): Promise<number | null> {
  try {
    const res = await fetcher("https://api.npmjs.org/downloads/point/last-day/@theagentforge/cli", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return Number(((await res.json()) as { downloads?: number }).downloads ?? 0);
  } catch {
    return null;
  }
}

/** Writes the snapshot for the UTC day that just ended. Safe to run more than once a day (it overwrites). */
export async function writeSnapshot(env: Env, now = Date.now(), fetcher: typeof fetch = fetch) {
  const yesterday = day(now - 86_400_000);
  const metrics: Record<string, Metric> = await proofNow(env, now, yesterday);
  const npm = await npmDownloads(fetcher);
  if (npm !== null) metrics.cli_npm_downloads = { external: npm, house: 0 };
  // The growth KPIs (ADR 0039), kept daily so their trend survives: metric "kpi_<id>", external value only.
  try {
    const { kpis } = await growthKpis(env, now);
    for (const [k, v] of Object.entries(kpiSnapshotValues(kpis))) metrics[k] = { external: v, house: 0 };
    for (const [k, v] of Object.entries(dataSnapshotValues(await dataInventory(env, now)))) metrics[k] = { external: v, house: 0 };
  } catch (e) {
    console.error("kpi_snapshot_failed", String(e));
  }
  const db = getDb(env);
  for (const [metric, v] of Object.entries(metrics)) {
    await db
      .insert(t.proofSnapshots)
      .values({ date: yesterday, metric, externalValue: v.external, houseValue: v.house, createdAt: now })
      .onConflictDoUpdate({
        target: [t.proofSnapshots.date, t.proofSnapshots.metric],
        set: { externalValue: v.external, houseValue: v.house, createdAt: now },
      });
  }
  return { date: yesterday, metrics: Object.keys(metrics).length };
}

export async function snapshotHistory(env: Env, days = 30) {
  return getDb(env)
    .select()
    .from(t.proofSnapshots)
    .where(sql`${t.proofSnapshots.date} >= ${day(Date.now() - days * 86_400_000)}`)
    .orderBy(t.proofSnapshots.date);
}
