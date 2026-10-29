import { and, count, countDistinct, eq, gte, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { outsidePeople } from "./agent-funnel";
import { ourPeople } from "./public-stats";
import * as t from "../db/schema";
import { getDb } from "./db";
import { dataInventory, dataSnapshotValues, growthKpis, kpiSnapshotValues } from "./kpis";
import { isLean } from "./ops-mode";
import { type InternalComponent, internalKey } from "./internal";
import { bump } from "./usage";
import { ownerActivity } from "./owners";

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
  // ADR 0067: "house" here means ours: House accounts and founder accounts (ADMIN_GITHUB_IDS), the same split as
  // services/public-stats.ts. Check sources carry their own is_house flag (founders can't be told apart there).
  const ours = (house: boolean) => (house ? ourPeople(env) : outsidePeople(env));
  const week = now - 7 * 86_400_000;
  // ADR 0067: a report counts only while people can read it (not held for review, not rejected), in every counter.
  const readable = and(eq(t.reports.held, false), ne(t.reports.moderationState, "rejected"));
  const reportsBy = (house: boolean) =>
    db
      .select({ n: count() })
      .from(t.reports)
      .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
      .where(and(ours(house), readable));
  const checks = (kind: CheckKind | null) => (house: boolean) =>
    db
      .select({ n: count() })
      .from(t.checkSources)
      .where(and(eq(t.checkSources.day, checksDay), eq(t.checkSources.isHouse, house), kind ? eq(t.checkSources.kind, kind) : undefined));
  return {
    verified_humans: await split((h) =>
      db.select({ n: count() }).from(t.humans).where(and(ours(h), eq(t.humans.tier, "verified"))),
    ),
    /** ADR 0073 (D12): owners (verified, with an active agent) whose agent did something in the last 30 days. */
    active_owners_30d: { external: (await ownerActivity(env, now, 30, false)).active, house: (await ownerActivity(env, now, 30, true)).active },
    humans: await split((h) => db.select({ n: count() }).from(t.humans).where(ours(h))),
    agents: await split((h) =>
      db
        .select({ n: count() })
        .from(t.agents)
        .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
        .where(and(ours(h), eq(t.agents.status, "active"))),
    ),
    /** The north star (§16): agents that filed at least one report in the last 7 days. */
    weekly_reporting_agents: await split((h) =>
      db
        .select({ n: countDistinct(t.reports.agentId) })
        .from(t.reports)
        .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
        .where(and(ours(h), readable, gte(t.reports.createdAt, week))),
    ),
    reports: await split(reportsBy),
    reports_with_plugin_strain: await split((h) =>
      db
        .select({ n: count() })
        .from(t.reports)
        .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
        .where(and(ours(h), readable, eq(t.reports.strainSource, "hook"))),
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

/** Metrics no longer kept (ADR 0116): never written, never read back, and their old rows are deleted. */
export const RETIRED_METRICS = ["cli_npm_downloads"] as const;
export const isRetiredMetric = (metric: string) => (RETIRED_METRICS as readonly string[]).includes(metric);

/** Writes the snapshot for the UTC day that just ended. Safe to run more than once a day (it overwrites). */
export async function writeSnapshot(env: Env, now = Date.now()) {
  const yesterday = day(now - 86_400_000);
  const metrics: Record<string, Metric> = await proofNow(env, now, yesterday);
  // The growth KPIs (ADR 0039), kept daily so their trend survives: metric "kpi_<id>", external value only.
  try {
    const { kpis } = await growthKpis(env, now);
    for (const [k, v] of Object.entries(kpiSnapshotValues(kpis))) metrics[k] = { external: v, house: 0 };
    for (const [k, v] of Object.entries(dataSnapshotValues(await dataInventory(env, now)))) metrics[k] = { external: v, house: 0 };
  } catch (e) {
    console.error("kpi_snapshot_failed", String(e));
  }
  const db = getDb(env);
  await db.delete(t.proofSnapshots).where(inArray(t.proofSnapshots.metric, [...RETIRED_METRICS]));
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
    .where(and(sql`${t.proofSnapshots.date} >= ${day(Date.now() - days * 86_400_000)}`, notInArray(t.proofSnapshots.metric, [...RETIRED_METRICS])))
    .orderBy(t.proofSnapshots.date);
}
