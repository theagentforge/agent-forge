import { sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import type { HistoryPoint, HouseEntry, HouseRun } from "./house-report";

// ADR 0129 (build plan 5 Nov, P0 item 1): the House tester's per-server results, kept per night in D1 for good.
//
// Before this, a night's per-server rows lived only in KV: the nightly top-500 for 120 days (house:run:<day>) and each
// sweep day for 21 days (house:sweep:<day>). House field reports (the `reports` table) are filed once per server
// version, not per night (houseAlreadyReported), so they were never a nightly record. This table is that record. Two
// families, never merged: the nightly top-500 and the weekly every-server sweep.

export const FAMILIES = { top500: "top500_nightly", sweep: "weekly_sweep" } as const;
export type HouseFamily = (typeof FAMILIES)[keyof typeof FAMILIES];

/** D1 allows 100 bound parameters a statement; a row has 12 columns. */
const ROWS_PER_INSERT = 8;

const serverId = (e: Pick<HouseEntry, "pkg" | "registry">) => `${e.registry ?? "npm"}:${e.pkg}`;

/**
 * Stores one night of one family. A re-run on the same UTC night replaces that night's rows (as the House Report's KV
 * copy does); other nights are never touched. Errors are logged, never thrown: the KV copy is already stored and the
 * tester's run must not fail on this (for example before the migration is applied).
 */
export async function recordHouseNight(env: Env, family: HouseFamily, run: Pick<HouseRun, "probedAt" | "entries">, origin: "post" | "kv_copy") {
  const night = run.probedAt.slice(0, 10);
  const probedAt = Date.parse(run.probedAt);
  const db = getDb(env);
  const seen = new Set<string>();
  const rows = run.entries
    .map((e) => ({ family, night, server: serverId(e), version: e.version, outcome: e.outcome, rank: e.rank, downloads: e.downloads, tools: e.tools, ms: e.ms, slow: e.slow, probedAt, origin }))
    .filter((r) => (seen.has(r.server) ? false : (seen.add(r.server), true)));
  try {
    const del = db.delete(t.houseResults).where(sql`${t.houseResults.family} = ${family} AND ${t.houseResults.night} = ${night}`);
    const inserts = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) inserts.push(db.insert(t.houseResults).values(rows.slice(i, i + ROWS_PER_INSERT)));
    await db.batch([del, ...inserts]);
    return { night, rows: rows.length };
  } catch (e) {
    console.error("house_results_failed", family, night, String(e).slice(0, 200));
    return { night, rows: 0, error: "not_written" };
  }
}

/** The nights already in D1, per family. */
export async function storedNights(env: Env) {
  const rows = (await getDb(env).all(sql`SELECT family, night FROM house_results GROUP BY family, night`)) as { family: HouseFamily; night: string }[];
  return new Set(rows.map((r) => `${r.family}:${r.night}`));
}

/**
 * Copies nights that are still in KV but not yet in D1 (the record from 15 Oct, before this table). Copies stored rows
 * only, unchanged; never invents a night. At most `limit` nights a call, so a cron run stays short.
 */
export async function copyKvNights(env: Env, now = Date.now(), limit = 10) {
  // KV keeps a nightly run 120 days and a sweep day 21 days: older days can't be read any more, so they aren't tried.
  const since = (days: number) => new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const have = await storedNights(env);
  const [nightly, sweep] = await Promise.all([env.KV.get<HistoryPoint[]>("house:history", "json"), env.KV.get<HistoryPoint[]>("house:sweep:history", "json")]);
  const todo: [HouseFamily, string, string][] = [
    ...(nightly ?? []).map((h) => [FAMILIES.top500, h.day, `house:run:${h.day}`] as [HouseFamily, string, string]),
    ...(sweep ?? []).map((h) => [FAMILIES.sweep, h.day, `house:sweep:${h.day}`] as [HouseFamily, string, string]),
  ].filter(([f, d]) => !have.has(`${f}:${d}`) && d > since(f === FAMILIES.sweep ? 21 : 120));
  let copied = 0;
  let missing = 0;
  for (const [family, day, key] of todo.slice(0, limit)) {
    const run = await env.KV.get<HouseRun>(key, "json");
    // Expired from KV (sweep days after 21 days): that night's per-server rows are gone and stay absent.
    if (!run?.entries?.length || run.probedAt.slice(0, 10) !== day) {
      missing++;
      continue;
    }
    const r = await recordHouseNight(env, family, run, "kv_copy");
    if (r.rows) copied++;
  }
  return { pending: todo.length, copied, missing };
}
