import { attemptScore, playedUnderAt, rescore, rescoreRefusal, RULES_VERSION, type AttemptResult } from "@forge/arena";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";

// Re-scoring stored runs in the Worker (rules 0.5, ADR 0049). The logs are too big to export through the Cloudflare
// API, so the replay runs here, next to the data, a few runs per arena cron tick. A job in KV names the events and a
// mode: "dry" only writes a report; "apply" also re-labels runs (below). The signed log is never touched. Runs whose
// replay isn't faithful (the job's world changed since the bout) are reported and never changed. Rules 0.6 adds a job
// filter (`tasks`), `publicOnly` (no held-out runs), `events: ["*"]` for every event, and counts by event and model;
// /admin/arena-rescore starts and reads one.
//
// B2-01 (ADR 0088):
// - Apply is gated. It runs only when `arena:rescore:apply-approved` holds an approval for exactly the job's scope, given
//   by an admin on /admin/arena-rescore after a finished dry report of that scope. An apply job without one is deleted
//   unread. Apply is always published runs only, and the approval is used up when the apply finishes.
// - Apply re-labels every faithful run it may re-score, changed or not: the result keeps its original `rules` stamp
//   (played under) and gains `rescored` (scored under, played under, the verdict before, whether it changed, and for a
//   v2-sealed run the exact result its seal covers). `rulesVersionAt` then reads "<rules> re-scored", a group of its own.
// - Hard v3 runs played before rules 0.3 (another harness) are refused in both modes and counted as excluded, and so
//   are runs played under the rules in force (native: re-scoring them would move them out of the native group).
// - The report holds a full before/after grid per model and job, not only the runs that changed.

export const RESCORE_JOB_KEY = "arena:rescore";
export const RESCORE_REPORT_KEY = "arena:rescore:report";
/** The admin's approval to apply: written only by /admin/arena-rescore after a finished dry report (ADR 0088). */
export const RESCORE_APPROVAL_KEY = "arena:rescore:apply-approved";
/** `events: ["*"]`: every event. */
export const ALL_EVENTS = "*";
// A replay is pure CPU (milliseconds); 40 runs keep a 360-run pass to about nine ticks.
const BATCH = 40;

export interface RescoreJob {
  events: string[];
  mode: "dry" | "apply";
  cursor?: string;
  /** Only these jobs (rules 0.6: the jobs whose referee changed, RULES_0_6_TASKS). All jobs when absent. */
  tasks?: string[];
  /** Published runs only: leave out held-out runs (ADR 0058) and runs in held events (status "planned"). */
  publicOnly?: boolean;
  /** Apply only: the id of the approval it was queued under by /admin/arena-rescore (an apply job without it is dropped). */
  approval?: string;
}

/** What an approval covers: the scope of the dry report the admin read. */
export interface RescoreApproval {
  /** Random id, copied into the one apply job the admin page queues: a job written by hand doesn't carry it. */
  id: string;
  by: string;
  at: string;
  rules: string;
  /** `updatedAt` of the finished dry report that was read. */
  dry_report_at: string;
  dry: { checked: number; changed: number; unfaithful: number; excluded: number; errors: number };
  scope: { events: string[]; tasks: string[] | null; publicOnly: true };
}

/** Changed verdicts in one group (an event or a model): how many runs were checked, and which way verdicts moved. */
export interface RescoreCount {
  checked: number;
  changed: number;
  toFail: number;
  toPass: number;
}

/** One model on one job: every run checked, before and after (unchanged, unfaithful and excluded runs included). */
export interface GridCell {
  model: string;
  task: string;
  runs: number;
  /** Runs the re-score covers (faithful and allowed). */
  rescored: number;
  unfaithful: number;
  excluded: number;
  changed: number;
  before: { passes: number; falls: number };
  after: { passes: number; falls: number };
  /** Runs by the rules they were played under. */
  played_under: Record<string, number>;
}

export interface RescoreReport {
  rules: string;
  mode: "dry" | "apply";
  events: string[];
  tasks?: string[];
  publicOnly?: boolean;
  done: boolean;
  checked: number;
  /** Counts by event id and by model id (rules 0.6 report). */
  byEvent?: Record<string, RescoreCount>;
  byModel?: Record<string, RescoreCount>;
  /** B2-01: model × job, keyed `${model}|${task}`. */
  grid?: Record<string, GridCell>;
  changed: { id: string; event: string; model: string; task: string; attempt: number; before: unknown; after: unknown; flips: string[]; applied: boolean }[];
  unfaithful: { id: string; model: string; task: string }[];
  /** Runs refused by rule (B2-01): Hard v3 played before rules 0.3, or already re-scored under these rules. */
  excluded?: { id: string; model: string; task: string; reason: "harness_changed" | "already_rescored" | "played_under_current_rules" }[];
  /** Runs re-labelled by an apply job (changed or not). */
  relabelled?: number;
  errors: { id: string; error: string }[];
  updatedAt: string;
}

const scopeKey = (s: { events: string[]; tasks?: string[] | null; publicOnly?: boolean }) => JSON.stringify([s.events, s.tasks?.length ? s.tasks : null, !!s.publicOnly]);

/** True when `a` approves exactly this job's scope. */
export const approves = (a: RescoreApproval | null, job: RescoreJob) =>
  !!a && typeof a.id === "string" && a.id.length > 0 && job.approval === a.id && a.rules === RULES_VERSION && job.publicOnly === true && scopeKey(a.scope) === scopeKey(job);

/** A report written by code from before B2-01 (no grid, no exclusions): never approved, and restarted if still running. */
const isLegacy = (r: RescoreReport) => r.grid === undefined || r.excluded === undefined;

/**
 * Record the admin's approval of the finished dry report in KV (ADR 0088). Refuses (null) unless the report is a
 * finished dry run of published runs under the rules in force. Runs that errored in the dry run are counted in the
 * approval; apply never changes a run whose replay errors.
 */
export async function approveApply(env: Env, by: string, now = Date.now()): Promise<RescoreApproval | null> {
  const report = await env.KV.get<RescoreReport>(RESCORE_REPORT_KEY, "json");
  if (!report || report.mode !== "dry" || !report.done || !report.publicOnly || report.rules !== RULES_VERSION || isLegacy(report)) return null;
  if (await env.KV.get(RESCORE_JOB_KEY)) return null;
  const approval: RescoreApproval = {
    id: crypto.randomUUID(),
    by,
    at: new Date(now).toISOString(),
    rules: report.rules,
    dry_report_at: report.updatedAt,
    dry: { checked: report.checked, changed: report.changed.length, unfaithful: report.unfaithful.length, excluded: report.excluded?.length ?? 0, errors: report.errors.length },
    scope: { events: report.events, tasks: report.tasks?.length ? report.tasks : null, publicOnly: true },
  };
  await env.KV.put(RESCORE_APPROVAL_KEY, JSON.stringify(approval));
  return approval;
}

/** The apply job an approval allows, or null without a valid approval. */
export async function applyJobFor(env: Env): Promise<RescoreJob | null> {
  const a = await env.KV.get<RescoreApproval>(RESCORE_APPROVAL_KEY, "json");
  if (!a || a.rules !== RULES_VERSION) return null;
  return { events: a.scope.events, mode: "apply", ...(a.scope.tasks ? { tasks: a.scope.tasks } : {}), publicOnly: true, approval: a.id };
}

/** At least one trap sprung. */
const fell = (r: { traps?: { triggered?: boolean }[] } | null | undefined) => (r?.traps ?? []).some((x) => x.triggered === true);

export async function rescoreTick(env: Env, now = Date.now()): Promise<RescoreReport | null> {
  const job = await env.KV.get<RescoreJob>(RESCORE_JOB_KEY, "json");
  if (!job || !Array.isArray(job.events) || !job.events.length || (job.mode !== "dry" && job.mode !== "apply")) return null;
  const tasks = Array.isArray(job.tasks) && job.tasks.length ? job.tasks : undefined;
  if (job.mode === "apply" && !approves(await env.KV.get<RescoreApproval>(RESCORE_APPROVAL_KEY, "json"), job)) {
    // Never apply without the admin's approval of this exact scope: the job is dropped and nothing is read or written.
    console.warn("arena_rescore_apply_refused", JSON.stringify({ events: job.events, tasks: tasks ?? null, publicOnly: !!job.publicOnly }));
    await env.KV.delete(RESCORE_JOB_KEY);
    return null;
  }
  const prior = await env.KV.get<RescoreReport>(RESCORE_REPORT_KEY, "json");
  // A report begun by code from before B2-01 has no grid and didn't apply the exclusions: it starts again from the
  // first run, so a report is never half old, half new (a job left running across that release).
  const fresh = !job.cursor || !prior || isLegacy(prior) || prior.mode !== job.mode || prior.events.join() !== job.events.join() || (prior.tasks ?? []).join() !== (tasks ?? []).join() || !!prior.publicOnly !== !!job.publicOnly;
  const report: RescoreReport = fresh
    ? { rules: RULES_VERSION, mode: job.mode, events: job.events, ...(tasks ? { tasks } : {}), ...(job.publicOnly ? { publicOnly: true } : {}), done: false, checked: 0, byEvent: {}, byModel: {}, grid: {}, changed: [], unfaithful: [], excluded: [], relabelled: 0, errors: [], updatedAt: "" }
    : prior!;
  // A new dry report replaces the one an approval was given on: that approval no longer stands.
  if (fresh && job.mode === "dry") await env.KV.delete(RESCORE_APPROVAL_KEY);
  report.byEvent ??= {};
  report.byModel ??= {};
  report.grid ??= {};
  report.excluded ??= [];
  report.relabelled ??= 0;
  const count = (row: { eventId: string; modelId: string }, f: (c: RescoreCount) => void) => {
    for (const [map, key] of [[report.byEvent!, row.eventId], [report.byModel!, row.modelId]] as const) f((map[key] ??= { checked: 0, changed: 0, toFail: 0, toPass: 0 }));
  };
  const cellOf = (model: string, task: string) =>
    (report.grid![`${model}|${task}`] ??= { model, task, runs: 0, rescored: 0, unfaithful: 0, excluded: 0, changed: 0, before: { passes: 0, falls: 0 }, after: { passes: 0, falls: 0 }, played_under: {} });
  const db = getDb(env);
  const rows = await db
    .select({ id: t.arenaRuns.id, eventId: t.arenaRuns.eventId, modelId: t.arenaRuns.modelId, task: t.arenaRuns.task, seed: t.arenaRuns.seed, attemptNo: t.arenaRuns.attemptNo, passed: t.arenaRuns.passed, score: t.arenaRuns.score, result: t.arenaRuns.result, log: t.arenaRuns.log, replaySeal: t.arenaRuns.replaySeal, finishedAt: t.arenaRuns.finishedAt })
    .from(t.arenaRuns)
    .where(
      and(
        job.events.includes(ALL_EVENTS) ? undefined : inArray(t.arenaRuns.eventId, job.events),
        eq(t.arenaRuns.status, "done"),
        tasks ? inArray(t.arenaRuns.task, tasks) : undefined,
        // Published: not held out, and not in an event held for review or notice (status "planned", never shown).
        job.publicOnly ? eq(t.arenaRuns.heldOut, false) : undefined,
        job.publicOnly ? inArray(t.arenaRuns.eventId, db.select({ id: t.arenaEvents.id }).from(t.arenaEvents).where(ne(t.arenaEvents.status, "planned"))) : undefined,
        !fresh && job.cursor ? gt(t.arenaRuns.id, job.cursor) : undefined,
      ),
    )
    .orderBy(asc(t.arenaRuns.id))
    .limit(BATCH);
  for (const row of rows) {
    report.checked++;
    count(row, (c) => c.checked++);
    const stored = row.result as (AttemptResult & { rescored?: { rules?: unknown; sealed?: unknown } }) | null;
    const finishedAt = row.finishedAt ?? 0;
    const played = playedUnderAt(finishedAt, stored);
    const cell = cellOf(row.modelId, row.task);
    cell.runs++;
    cell.played_under[played] = (cell.played_under[played] ?? 0) + 1;
    const beforePass = row.passed === true;
    const beforeFell = fell(stored);
    cell.before.passes += beforePass ? 1 : 0;
    cell.before.falls += beforeFell ? 1 : 0;
    // Unchanged unless the re-score covers the run: the "after" side starts as the stored verdict.
    let afterPass = beforePass;
    let afterFell = beforeFell;
    try {
      // A run played under the rules in force is native, never re-scored (it would leave the native group).
      const refusal =
        played === RULES_VERSION ? ("played_under_current_rules" as const) : (rescoreRefusal(row.task, finishedAt, stored) ?? (stored?.rescored?.rules === RULES_VERSION ? ("already_rescored" as const) : null));
      if (refusal) {
        cell.excluded++;
        report.excluded.push({ id: row.id, model: row.modelId, task: row.task, reason: refusal });
        continue;
      }
      const r = rescore({ task: row.task, seed: row.seed, log: row.log as never, result: row.result as never, passed: row.passed, score: row.score });
      if (!r.faithful) {
        cell.unfaithful++;
        report.unfaithful.push({ id: row.id, model: row.modelId, task: row.task });
        continue;
      }
      cell.rescored++;
      afterPass = r.result.passed === true;
      afterFell = fell(r.result);
      const flips = r.flips.map((f) => `${f.kind}:${f.id}`);
      if (job.mode === "apply") {
        // The result keeps its original rules stamp (or none): played under. `rescored` says which rules scored it now.
        const stamp = stored?.rules;
        const { rules: _replayed, ...replayed } = r.result;
        // A v2-sealed run (ADR 0066) keeps the exact result its seal covers under `rescored.sealed` (the first one, if it
        // was re-scored before), so `forge verify` can still check the seal; the referee re-run checks the new verdict.
        const { rescored: _old, ...original } = (stored ?? {}) as Record<string, unknown>;
        const sealed = row.replaySeal ? (stored?.rescored?.sealed ?? stored) : undefined;
        const note = { rules: RULES_VERSION, played_under: played, at: new Date(now).toISOString(), before: r.before, changed: r.changed, flips, ...(sealed ? { sealed } : {}) };
        const base = r.changed ? { ...replayed, ...(typeof stamp === "string" ? { rules: stamp } : {}) } : original;
        const result = { ...base, rescored: note } as unknown as AttemptResult;
        await db
          .update(t.arenaRuns)
          .set(r.changed ? { passed: r.result.passed, score: attemptScore(r.result), result } : { result })
          .where(eq(t.arenaRuns.id, row.id));
        report.relabelled++;
      }
      if (!r.changed) continue;
      cell.changed++;
      count(row, (c) => {
        c.changed++;
        if (r.before.passed === true && r.after.passed === false) c.toFail++;
        if (r.before.passed === false && r.after.passed === true) c.toPass++;
      });
      report.changed.push({ id: row.id, event: row.eventId, model: row.modelId, task: row.task, attempt: row.attemptNo, before: r.before, after: r.after, flips, applied: job.mode === "apply" });
    } catch (e) {
      report.errors.push({ id: row.id, error: String(e).slice(0, 200) });
    } finally {
      cell.after.passes += afterPass ? 1 : 0;
      cell.after.falls += afterFell ? 1 : 0;
    }
  }
  report.done = rows.length < BATCH;
  report.updatedAt = new Date(now).toISOString();
  await env.KV.put(RESCORE_REPORT_KEY, JSON.stringify(report));
  if (report.done) {
    await env.KV.delete(RESCORE_JOB_KEY);
    // An approval is for one apply: used up once it has run.
    if (job.mode === "apply") await env.KV.delete(RESCORE_APPROVAL_KEY);
  } else await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ ...job, cursor: rows.at(-1)!.id }));
  return report;
}

/** The grid as sorted rows (model, then job). */
export const gridRows = (report: Pick<RescoreReport, "grid">) => Object.values(report.grid ?? {}).sort((a, b) => a.model.localeCompare(b.model) || a.task.localeCompare(b.task));
