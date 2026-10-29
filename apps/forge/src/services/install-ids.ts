import { lt, sql } from "drizzle-orm";
import { INSTALL_ID_HEADER, isInstallId } from "@forge/shared/light";
import * as t from "../db/schema";
import { getDb } from "./db";
import type { InternalComponent } from "./internal";
import { installClient, type InstallClient } from "./install-metrics";

// B3-09 (ADR 0103; Dinike approved 29 Oct, "Yes, opt-out ID"): return cohorts for the install path. The CLI, its hooks
// for Codex, Gemini CLI and Copilot CLI, and the Claude Code plugin send an anonymous random install ID (a UUID v4 made
// on the user's machine; packages/shared/src/install-id.ts) as the `forge-install-id` header on /api/v1/check.
//
// What we keep, per ID: a keyed hash of it (never the ID), the first and last UTC day it was seen, the client it was
// first seen from, and whether a request carrying it was tagged as ours (services/internal.ts: our CI, House and
// repositories). No IP address and no package names are stored with it; the check itself is counted, as before, only
// in the daily counters, which carry no ID. Rows are deleted 400 days after they were last seen (daily cron).
//
// Ours: a request tagged X-Forge-Internal (or a theagentforge-internal User-Agent) marks the row as ours for good, and
// the clients send no ID at all when CI is set, so our own CI never reaches the table. Cohorts are shown outside-only,
// with ours apart.

/** The clients that send an install ID (the Actions run on fresh CI machines and never send one). */
export const ID_CLIENTS = ["plugin", "cli", "hook-codex", "hook-gemini", "hook-copilot"] as const satisfies readonly InstallClient[];
export type IdClient = (typeof ID_CLIENTS)[number];
const isIdClient = (c: InstallClient | null): c is IdClient => !!c && (ID_CLIENTS as readonly string[]).includes(c);

export const INSTALL_ID_KEEP_DAYS = 400;
const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * HMAC-SHA256 of the ID with a key derived from SESSION_SECRET for this one use (no new root secret). Rotating
 * SESSION_SECRET starts every ID afresh, which only resets the cohorts.
 */
export async function installIdHash(secret: string, id: string): Promise<string> {
  const enc = new TextEncoder();
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode("forge-install-id/1"));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(id))).slice(0, 32);
}

/** Records one install-time check's install ID (first and last day). Ignores anything that isn't a UUID v4. Never throws. */
export async function recordInstallId(env: Env, rawId: string | undefined, userAgent: string | undefined, internal: InternalComponent | null, now = Date.now()) {
  try {
    const id = (rawId ?? "").trim().toLowerCase();
    const client = installClient(userAgent);
    if (!isInstallId(id) || !isIdClient(client)) return;
    const day = isoDay(now);
    const ours = internal !== null;
    await getDb(env)
      .insert(t.installIds)
      .values({ idHash: await installIdHash(env.SESSION_SECRET, id), client, firstDay: day, lastDay: day, ours })
      .onConflictDoUpdate({
        target: t.installIds.idHash,
        set: { lastDay: sql`max(${t.installIds.lastDay}, excluded.last_day)`, ours: sql`max(${t.installIds.ours}, excluded.ours)` },
        // Only when something changes: a second check on the same day writes nothing.
        setWhere: sql`excluded.last_day > ${t.installIds.lastDay} or excluded.ours > ${t.installIds.ours}`,
      });
  } catch (e) {
    console.error("install_id_failed", String(e));
  }
}

/** Deletes IDs last seen more than 400 days ago (daily cron). */
export async function sweepInstallIds(env: Env, now = Date.now()) {
  const before = isoDay(now - INSTALL_ID_KEEP_DAYS * DAY);
  const r = await getDb(env).delete(t.installIds).where(lt(t.installIds.lastDay, before));
  return { before, deleted: (r as { meta?: { changes?: number } }).meta?.changes ?? null };
}

export const RETURN_DAYS = [1, 7, 30] as const;
export type ReturnDay = (typeof RETURN_DAYS)[number];

export interface Cohort {
  /** IDs first seen at least N days ago (old enough to have come back). */
  eligible: number;
  /** Of those, seen again N or more days after their first day. */
  returned: number;
  pct: number | null;
}
export interface ReturnGroup {
  ids: number;
  d1: Cohort;
  d7: Cohort;
  d30: Cohort;
}
export interface ReturnRow {
  client: string;
  ours: boolean;
  ids: number;
  e1: number;
  r1: number;
  e7: number;
  r7: number;
  e30: number;
  r30: number;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const emptyGroup = (): ReturnGroup => ({ ids: 0, d1: { eligible: 0, returned: 0, pct: null }, d7: { eligible: 0, returned: 0, pct: null }, d30: { eligible: 0, returned: 0, pct: null } });
function add(g: ReturnGroup, r: ReturnRow) {
  g.ids += r.ids;
  for (const d of RETURN_DAYS) {
    const c = g[`d${d}`];
    c.eligible += r[`e${d}`];
    c.returned += r[`r${d}`];
    c.pct = pct(c.returned, c.eligible);
  }
}

export interface Step {
  key: string;
  label: string;
  definition: string;
  /** IDs at this step; null when it can't be measured. */
  n: number | null;
  /** The IDs old enough to reach this step. */
  base: number | null;
  pct: number | null;
}

export const RETURNS_DEFINITION =
  "Random install IDs (outside the project) sent with install checks by the CLI, its hooks and the Claude Code plugin. Day N return: of the IDs first seen at least N days ago, the share seen again N or more days after their first day. Only the first and last day are kept, so a return means \"still checking N+ days later\", not \"on exactly day N\". IDs our tagged tests sent are counted apart (ours); CI machines and people who opted out send none.";

/** Cohorts and the step table from the grouped rows (pure; tested on fixtures). */
export function installReturns(rows: ReturnRow[], asOf: string) {
  const outside = emptyGroup();
  const ours = emptyGroup();
  const byClient = Object.fromEntries(ID_CLIENTS.map((c) => [c, emptyGroup()])) as Record<IdClient, ReturnGroup>;
  for (const r of rows) {
    add(r.ours ? ours : outside, r);
    if (!r.ours && (ID_CLIENTS as readonly string[]).includes(r.client)) add(byClient[r.client as IdClient], r);
  }
  const steps: Step[] = [
    { key: "installed", label: "Installed", definition: "Not measurable: an install sends nothing until its first check.", n: null, base: null, pct: null },
    { key: "first_check", label: "First check", definition: "Install IDs first seen (outside the project).", n: outside.ids, base: outside.ids, pct: outside.ids ? 100 : null },
    { key: "second_day", label: "Came back another day", definition: "Seen again 1 or more days after the first day, of the IDs first seen at least 1 day ago.", n: outside.d1.returned, base: outside.d1.eligible, pct: outside.d1.pct },
    { key: "week_2", label: "Still checking in week 2", definition: "Seen again 7 or more days after the first day, of the IDs first seen at least 7 days ago.", n: outside.d7.returned, base: outside.d7.eligible, pct: outside.d7.pct },
  ];
  let biggest: { from: Step; to: Step; drop: number } | null = null;
  for (let i = 1; i < steps.length; i++) {
    const [a, b] = [steps[i - 1]!, steps[i]!];
    if (a.pct === null || b.pct === null) continue;
    const drop = Math.round((a.pct - b.pct) * 10) / 10;
    if (drop > 0 && (!biggest || drop > biggest.drop)) biggest = { from: a, to: b, drop };
  }
  return {
    internal_only: true as const,
    as_of: asOf,
    definition: RETURNS_DEFINITION,
    outside,
    ours,
    by_client: byClient,
    steps,
    biggest_drop: biggest ? `${biggest.from.label} → ${biggest.to.label}: ${biggest.drop} points lost (${biggest.to.n} of ${biggest.to.base} IDs old enough came back)` : null,
  };
}
export type InstallReturns = ReturnType<typeof installReturns>;

/** The grouped counts behind the cohorts, read from install_ids (one query). */
export async function installReturnsData(env: Env, now = Date.now()): Promise<InstallReturns> {
  const today = isoDay(now);
  const since = (d: number) => isoDay(now - d * DAY);
  const gap = sql`(julianday(${t.installIds.lastDay}) - julianday(${t.installIds.firstDay}))`;
  const n = (cond: ReturnType<typeof sql>) => sql<number>`coalesce(sum(case when ${cond} then 1 else 0 end), 0)`;
  const rows = await getDb(env)
    .select({
      client: t.installIds.client,
      ours: t.installIds.ours,
      ids: sql<number>`count(*)`,
      e1: n(sql`${t.installIds.firstDay} <= ${since(1)}`),
      r1: n(sql`${t.installIds.firstDay} <= ${since(1)} and ${gap} >= 1`),
      e7: n(sql`${t.installIds.firstDay} <= ${since(7)}`),
      r7: n(sql`${t.installIds.firstDay} <= ${since(7)} and ${gap} >= 7`),
      e30: n(sql`${t.installIds.firstDay} <= ${since(30)}`),
      r30: n(sql`${t.installIds.firstDay} <= ${since(30)} and ${gap} >= 30`),
    })
    .from(t.installIds)
    .groupBy(t.installIds.client, t.installIds.ours);
  return installReturns(
    rows.map((r) => ({ client: r.client, ours: Boolean(r.ours), ids: Number(r.ids), e1: Number(r.e1), r1: Number(r.r1), e7: Number(r.e7), r7: Number(r.r7), e30: Number(r.e30), r30: Number(r.r30) })),
    today,
  );
}

export { INSTALL_ID_HEADER };
