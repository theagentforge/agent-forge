import { CANARY, PRACTICE_ONLY_TASK_IDS, RULES_VERSION, taskVersion, type AttemptResult } from "@forge/arena";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import { licenceInfo, runProvenance } from "../services/provenance";
import { replayDocBlock, sha256Hex } from "../services/replay-keys";
import { NOTICE_DAYS, RESULTS_POLICY_PATH, RESULTS_POLICY_VERSION } from "../web/results-policy";
import { rate } from "./benchmark";
import { EMBARGOED_MODEL_IDS } from "./lineup";
import { RESULTS_METHOD, trapsFell } from "./results";
import { rulesFields } from "./rules-label";
import { isKnockout, modelName, tierOf } from "./views";

// B2-02 (ADR 0089): publishing a held event under the results policy (/results-policy, NOTICE_DAYS = 7).
// A held event (status "planned") is played, refereed, signed and stored, and shown nowhere. The admin downloads the
// full pack from /admin/arena-held (draft result, method, exact model versions, n with 95% intervals, signed replay
// logs: the event's own data only), sends it to every named lab, then presses "Mark full pack sent": that records the
// date, who, and a digest of the runs the pack covered. "Publish held event" refuses until NOTICE_DAYS after that date,
// and refuses if the runs changed since the pack; when it publishes, the event's status becomes "running" (shown
// everywhere, with its original dates and replays) and who and when are recorded. Nothing here publishes by itself.

export const DAY_MS = 86_400_000;
export const PACK_FORMAT = "forge-notice-pack/1";

type Event = typeof t.arenaEvents.$inferSelect;
type Notice = typeof t.arenaEventNotices.$inferSelect;

/** The earliest publication instant for a pack sent at `packSentAt` (ms). */
export const earliestPublication = (packSentAt: number) => packSentAt + NOTICE_DAYS * DAY_MS;

/** The runs a pack and a publication cover: finished, not held out, no embargoed model, no private job family. */
async function packRows(db: Db, eventId: string) {
  const rows = await db.select().from(t.arenaRuns).where(and(eq(t.arenaRuns.eventId, eventId), eq(t.arenaRuns.status, "done"), eq(t.arenaRuns.heldOut, false))).orderBy(asc(t.arenaRuns.id));
  return rows.filter((r) => !EMBARGOED_MODEL_IDS.includes(r.modelId) && !PRACTICE_ONLY_TASK_IDS.includes(r.task));
}

/** The current digest of an event's pack runs without reading their logs (for the admin list and "Mark full pack sent"). */
export async function packDigest(db: Db, eventId: string) {
  const rows = (
    await db
      .select({ id: t.arenaRuns.id, passed: t.arenaRuns.passed, result: t.arenaRuns.result, signature: t.arenaRuns.signature, replaySeal: t.arenaRuns.replaySeal, modelId: t.arenaRuns.modelId, task: t.arenaRuns.task })
      .from(t.arenaRuns)
      .where(and(eq(t.arenaRuns.eventId, eventId), eq(t.arenaRuns.status, "done"), eq(t.arenaRuns.heldOut, false)))
      .orderBy(asc(t.arenaRuns.id))
  ).filter((r) => !EMBARGOED_MODEL_IDS.includes(r.modelId) && !PRACTICE_ONLY_TASK_IDS.includes(r.task));
  return { sha256: await runsDigest(rows), runs: rows.length };
}

/** SHA-256 over what the pack's results rest on: each run's id, verdict, result, signature and seal, in id order. */
export async function runsDigest(rows: { id: string; passed: boolean | null; result: unknown; signature: string | null; replaySeal: unknown }[]) {
  const body = JSON.stringify(rows.map((r) => [r.id, r.passed, r.result ?? null, r.signature ?? null, r.replaySeal ?? null]));
  return sha256Hex(body);
}

/** Runs by status, for the admin list. */
async function statusCounts(db: Db, eventId: string) {
  const rows = await db.select({ status: t.arenaRuns.status }).from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  const out = { queued: 0, running: 0, done: 0, void: 0 };
  for (const r of rows) out[r.status]++;
  return out;
}

/** Held events, and events published through this page, newest first, with their notice state. */
export async function heldEvents(db: Db, now = Date.now()) {
  const notices = await db.select().from(t.arenaEventNotices);
  const byEvent = new Map(notices.map((n) => [n.eventId, n]));
  const planned = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.status, "planned")).orderBy(desc(t.arenaEvents.createdAt));
  const publishedIds = notices.filter((n) => n.publishedAt).map((n) => n.eventId);
  const published = publishedIds.length ? await db.select().from(t.arenaEvents).where(inArray(t.arenaEvents.id, publishedIds)) : [];
  return Promise.all(
    [...planned, ...published].map(async (e) => {
      const n = byEvent.get(e.id) ?? null;
      const runs = await statusCounts(db, e.id);
      // The fingerprint of the pack as it is now (the pack's runs.sha256): "Mark full pack sent" must name it.
      const current = e.status === "planned" ? await packDigest(db, e.id) : null;
      return { event: e, notice: n, runs, current, ...state(e, n, runs, now) };
    }),
  );
}

/** What can be done next with a held event, and why not. */
function state(e: Event, n: Notice | null, runs: { queued: number; running: number; done: number }, now: number) {
  const unfinished = runs.queued + runs.running;
  const earliest = n?.packSentAt ? earliestPublication(n.packSentAt) : null;
  return {
    held: e.status === "planned",
    published_at: n?.publishedAt ?? null,
    can_mark_pack_sent: e.status === "planned" && !unfinished && runs.done > 0,
    earliest_publication: earliest,
    can_publish: e.status === "planned" && !unfinished && earliest !== null && now >= earliest,
  };
}

/**
 * The full pack for a held event (results policy: "the draft result, the method, the exact model versions, the sample
 * sizes and intervals, and copies of the signed replay logs"). Only this event's own runs. `replays: false` leaves the
 * logs out (for reading on the page). Null for an unknown slug.
 */
export async function fullPack(db: Db, slug: string, origin: string, opts: { replays?: boolean; now?: number } = {}) {
  const [event] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, slug));
  if (!event) return null;
  const [notice] = await db.select().from(t.arenaEventNotices).where(eq(t.arenaEventNotices.eventId, event.id));
  const rows = await packRows(db, event.id);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const group = <K>(key: (r: (typeof rows)[number]) => K) => {
    const m = new Map<K, typeof rows>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const cell = (rs: typeof rows) => {
    const counted = rs.filter((r) => !isKnockout(r.result as AttemptResult));
    const passes = rs.filter((r) => r.passed === true).length;
    const fell = rs.filter((r) => trapsFell(r.task, r.result as AttemptResult).length > 0).length;
    const times = rs.map((r) => r.finishedAt ?? 0);
    return {
      attempts: rs.length,
      passes: rate(passes, rs.length),
      fell_for_a_trap: rate(fell, rs.length),
      knockouts: rs.length - counted.length,
      run_dates: rs.length ? { first: day(Math.min(...times)), last: day(Math.max(...times)) } : null,
      rules_versions: [...new Set(rs.map((r) => rulesFields(r.finishedAt ?? 0, r.result).rules_version))].sort(),
      task_versions: [...new Set(rs.map((r) => taskVersion(r.task, r.finishedAt ?? undefined)))].sort(),
    };
  };
  const models = [...group((r) => r.modelId).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const digest = await runsDigest(rows);
  const content = {
    event: { slug: event.slug, name: event.name, kind: event.kind, season: event.season, status: event.status, created_at: new Date(event.createdAt).toISOString() },
    method: {
      results_policy: { version: RESULTS_POLICY_VERSION, url: `${origin}${RESULTS_POLICY_PATH}`, notice_days: NOTICE_DAYS },
      methodology: `${origin}/arena/methodology`,
      rules_in_force: RULES_VERSION,
      counting: RESULTS_METHOD,
      interval: "wilson_95_rounded_outwards",
      interval_assumptions: { independent_attempts_assumed: true, covers_referee_error: false },
      tasks: [...new Set(rows.map((r) => r.task))].sort(),
      seeds: [...new Set(rows.map((r) => r.seed))].sort((a, b) => a - b),
      attempts_per_variant: Math.max(0, ...rows.map((r) => r.attemptNo)),
      verify: { cli: "npx @theagentforge/cli verify <replay.json>", keys: `${origin}/.well-known/forge-keys.json` },
    },
    models: models.map(([id, rs]) => {
      const p = runProvenance({ model: id, provider: rs[0]!.provider, finishedAt: rs[0]!.finishedAt ?? 0 });
      return { id, name: modelName(id), exact: p.model ?? null, providers_served: [...new Set(rs.map((r) => r.provider).filter((x): x is string => !!x))].sort() };
    }),
    draft_result: models.map(([id, rs]) => ({
      model: id,
      name: modelName(id),
      overall: cell(rs),
      by_job: [...new Set(rs.map((r) => r.task))].sort().map((task) => ({ task, tier: tierOf(task), ...cell(rs.filter((r) => r.task === task)) })),
    })),
    runs: { count: rows.length, sha256: digest },
  };
  const replays = opts.replays === false
    ? null
    : await Promise.all(
        rows.map(async (r) => ({
          canary: CANARY,
          id: r.id,
          event: event.slug,
          kind: event.kind,
          task: r.task,
          tier: tierOf(r.task),
          seed: r.seed,
          attempt: r.attemptNo,
          model: r.modelId,
          provider: r.provider,
          ...rulesFields(r.finishedAt ?? 0, r.result),
          task_version: taskVersion(r.task, r.finishedAt ?? undefined),
          finished_at: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
          traps_fell: trapsFell(r.task, r.result as AttemptResult),
          result: r.result,
          log: r.log,
          signature: r.signature,
          replay: await replayDocBlock(r.log as unknown[] | null, r.replaySeal, "arena"),
          provenance: runProvenance({ model: r.modelId, provider: r.provider, finishedAt: r.finishedAt ?? 0 }),
        })),
      );
  return {
    pack: {
      format: PACK_FORMAT,
      generated_at: new Date(opts.now ?? Date.now()).toISOString(),
      // Shown nowhere until published: the replay links in this pack open only from the publication date.
      held: event.status === "planned",
      pack_sent_at: notice?.packSentAt ? new Date(notice.packSentAt).toISOString() : null,
      earliest_publication: notice?.packSentAt ? new Date(earliestPublication(notice.packSentAt)).toISOString() : null,
      published_at: notice?.publishedAt ? new Date(notice.publishedAt).toISOString() : null,
      ...licenceInfo(origin),
    },
    ...content,
    ...(replays ? { replays } : {}),
  };
}

export type PackResult = { ok: true } | { ok: false; reason: "unknown_event" | "not_held" | "runs_unfinished" | "no_runs" | "no_pack_sent" | "notice_period" | "runs_changed" | "pack_stale" };

/**
 * "Mark full pack sent": the 7-day clock starts now. Allowed again (a re-sent pack restarts the clock) until published.
 * `packSha256` is the runs fingerprint of the pack that was sent (its runs.sha256, shown on the admin page): refused
 * ("pack_stale") unless it is the fingerprint of the runs now, so the record never covers runs the labs didn't get.
 */
export async function markPackSent(env: Env, slug: string, by: string, packSha256: string, now = Date.now()): Promise<PackResult> {
  const db = getDb(env);
  const [event] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, slug));
  if (!event) return { ok: false, reason: "unknown_event" };
  if (event.status !== "planned") return { ok: false, reason: "not_held" };
  const runs = await statusCounts(db, event.id);
  if (runs.queued + runs.running) return { ok: false, reason: "runs_unfinished" };
  const rows = await packRows(db, event.id);
  if (!rows.length) return { ok: false, reason: "no_runs" };
  const digest = await runsDigest(rows);
  if (packSha256 !== digest) return { ok: false, reason: "pack_stale" };
  const values = { packSentAt: now, packSentBy: by, packRunsSha256: digest, packRuns: rows.length, updatedAt: now };
  await db
    .insert(t.arenaEventNotices)
    .values({ eventId: event.id, ...values })
    .onConflictDoUpdate({ target: t.arenaEventNotices.eventId, set: values });
  return { ok: true };
}

/** "Publish held event": only NOTICE_DAYS after the full pack was sent, and only if its runs are the ones in the pack. */
export async function publishHeld(env: Env, slug: string, by: string, now = Date.now()): Promise<PackResult> {
  const db = getDb(env);
  const [event] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, slug));
  if (!event) return { ok: false, reason: "unknown_event" };
  if (event.status !== "planned") return { ok: false, reason: "not_held" };
  const runs = await statusCounts(db, event.id);
  if (runs.queued + runs.running) return { ok: false, reason: "runs_unfinished" };
  const [notice] = await db.select().from(t.arenaEventNotices).where(eq(t.arenaEventNotices.eventId, event.id));
  if (!notice?.packSentAt) return { ok: false, reason: "no_pack_sent" };
  if (now < earliestPublication(notice.packSentAt)) return { ok: false, reason: "notice_period" };
  if ((await runsDigest(await packRows(db, event.id))) !== notice.packRunsSha256) return { ok: false, reason: "runs_changed" };
  await db.update(t.arenaEvents).set({ status: "running" }).where(and(eq(t.arenaEvents.id, event.id), eq(t.arenaEvents.status, "planned")));
  await db.update(t.arenaEventNotices).set({ publishedAt: now, publishedBy: by, updatedAt: now }).where(eq(t.arenaEventNotices.eventId, event.id));
  return { ok: true };
}
