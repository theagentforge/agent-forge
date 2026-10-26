import { attemptScore, rescore, RULES_VERSION, type AttemptResult } from "@forge/arena";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";

// Re-scoring stored runs in the Worker (rules 0.5, ADR 0049). The logs are too big to export through the Cloudflare
// API, so the replay runs here, next to the data, a few runs per arena cron tick. A job in KV names the events and a
// mode: "dry" only writes a report; "apply" also updates passed, score and result (with a `rescored` note) for runs
// whose verdict changed. The signed log is never touched. Runs whose replay isn't faithful (the job's world changed
// since the bout) are reported and never changed. Rules 0.6 adds a job filter (`tasks`), `publicOnly` (no held-out
// runs), `events: ["*"]` for every event, and counts by event and model; /admin/arena-rescore starts and reads one.

export const RESCORE_JOB_KEY = "arena:rescore";
export const RESCORE_REPORT_KEY = "arena:rescore:report";
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
}

/** Changed verdicts in one group (an event or a model): how many runs were checked, and which way verdicts moved. */
export interface RescoreCount {
  checked: number;
  changed: number;
  toFail: number;
  toPass: number;
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
  changed: { id: string; event: string; model: string; task: string; attempt: number; before: unknown; after: unknown; flips: string[]; applied: boolean }[];
  unfaithful: { id: string; model: string; task: string }[];
  errors: { id: string; error: string }[];
  updatedAt: string;
}

export async function rescoreTick(env: Env, now = Date.now()): Promise<RescoreReport | null> {
  const job = await env.KV.get<RescoreJob>(RESCORE_JOB_KEY, "json");
  if (!job || !Array.isArray(job.events) || !job.events.length || (job.mode !== "dry" && job.mode !== "apply")) return null;
  const prior = await env.KV.get<RescoreReport>(RESCORE_REPORT_KEY, "json");
  const tasks = Array.isArray(job.tasks) && job.tasks.length ? job.tasks : undefined;
  const fresh = !job.cursor || !prior || prior.mode !== job.mode || prior.events.join() !== job.events.join() || (prior.tasks ?? []).join() !== (tasks ?? []).join() || !!prior.publicOnly !== !!job.publicOnly;
  const report: RescoreReport = fresh
    ? { rules: RULES_VERSION, mode: job.mode, events: job.events, ...(tasks ? { tasks } : {}), ...(job.publicOnly ? { publicOnly: true } : {}), done: false, checked: 0, byEvent: {}, byModel: {}, changed: [], unfaithful: [], errors: [], updatedAt: "" }
    : prior!;
  report.byEvent ??= {};
  report.byModel ??= {};
  const count = (row: { eventId: string; modelId: string }, f: (c: RescoreCount) => void) => {
    for (const [map, key] of [[report.byEvent!, row.eventId], [report.byModel!, row.modelId]] as const) f((map[key] ??= { checked: 0, changed: 0, toFail: 0, toPass: 0 }));
  };
  const db = getDb(env);
  const rows = await db
    .select({ id: t.arenaRuns.id, eventId: t.arenaRuns.eventId, modelId: t.arenaRuns.modelId, task: t.arenaRuns.task, seed: t.arenaRuns.seed, attemptNo: t.arenaRuns.attemptNo, passed: t.arenaRuns.passed, score: t.arenaRuns.score, result: t.arenaRuns.result, log: t.arenaRuns.log })
    .from(t.arenaRuns)
    .where(
      and(
        job.events.includes(ALL_EVENTS) ? undefined : inArray(t.arenaRuns.eventId, job.events),
        eq(t.arenaRuns.status, "done"),
        tasks ? inArray(t.arenaRuns.task, tasks) : undefined,
        // Published: not held out, and not in an event held for review or notice (status "planned", never shown).
        job.publicOnly ? eq(t.arenaRuns.heldOut, false) : undefined,
        job.publicOnly ? inArray(t.arenaRuns.eventId, db.select({ id: t.arenaEvents.id }).from(t.arenaEvents).where(ne(t.arenaEvents.status, "planned"))) : undefined,
        job.cursor ? gt(t.arenaRuns.id, job.cursor) : undefined,
      ),
    )
    .orderBy(asc(t.arenaRuns.id))
    .limit(BATCH);
  for (const row of rows) {
    report.checked++;
    count(row, (c) => c.checked++);
    try {
      const r = rescore({ task: row.task, seed: row.seed, log: row.log as never, result: row.result as never, passed: row.passed, score: row.score });
      if (!r.faithful) {
        report.unfaithful.push({ id: row.id, model: row.modelId, task: row.task });
        continue;
      }
      if (!r.changed) continue;
      const flips = r.flips.map((f) => `${f.kind}:${f.id}`);
      if (job.mode === "apply") {
        // The result keeps its original rules stamp (or none): the `rescored` note says which rules gave the new verdict.
        const stamp = (row.result as { rules?: unknown } | null)?.rules;
        const { rules: _replayed, ...replayed } = r.result;
        const result = { ...replayed, ...(typeof stamp === "string" ? { rules: stamp } : {}), rescored: { rules: RULES_VERSION, at: new Date(now).toISOString(), before: r.before, flips } } as AttemptResult;
        await db.update(t.arenaRuns).set({ passed: r.result.passed, score: attemptScore(r.result), result }).where(eq(t.arenaRuns.id, row.id));
      }
      count(row, (c) => {
        c.changed++;
        if (r.before.passed === true && r.after.passed === false) c.toFail++;
        if (r.before.passed === false && r.after.passed === true) c.toPass++;
      });
      report.changed.push({ id: row.id, event: row.eventId, model: row.modelId, task: row.task, attempt: row.attemptNo, before: r.before, after: r.after, flips, applied: job.mode === "apply" });
    } catch (e) {
      report.errors.push({ id: row.id, error: String(e).slice(0, 200) });
    }
  }
  report.done = rows.length < BATCH;
  report.updatedAt = new Date(now).toISOString();
  await env.KV.put(RESCORE_REPORT_KEY, JSON.stringify(report));
  if (report.done) await env.KV.delete(RESCORE_JOB_KEY);
  else await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ ...job, cursor: rows.at(-1)!.id }));
  return report;
}
