import { attemptScore, rescore, RULES_VERSION, type AttemptResult } from "@forge/arena";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";

// Re-scoring stored runs in the Worker (rules 0.5, ADR 0049). The logs are too big to export through the Cloudflare
// API, so the replay runs here, next to the data, a few runs per arena cron tick. A job in KV names the events and a
// mode: "dry" only writes a report; "apply" also updates passed, score and result (with a `rescored` note) for runs
// whose verdict changed. The signed log is never touched. Runs whose replay isn't faithful (the job's world changed
// since the bout) are reported and never changed.

export const RESCORE_JOB_KEY = "arena:rescore";
export const RESCORE_REPORT_KEY = "arena:rescore:report";
// A replay is pure CPU (milliseconds); 40 runs keep a 360-run pass to about nine ticks.
const BATCH = 40;

export interface RescoreJob {
  events: string[];
  mode: "dry" | "apply";
  cursor?: string;
}

export interface RescoreReport {
  rules: string;
  mode: "dry" | "apply";
  events: string[];
  done: boolean;
  checked: number;
  changed: { id: string; event: string; model: string; task: string; attempt: number; before: unknown; after: unknown; flips: string[]; applied: boolean }[];
  unfaithful: { id: string; model: string; task: string }[];
  errors: { id: string; error: string }[];
  updatedAt: string;
}

export async function rescoreTick(env: Env, now = Date.now()): Promise<RescoreReport | null> {
  const job = await env.KV.get<RescoreJob>(RESCORE_JOB_KEY, "json");
  if (!job || !Array.isArray(job.events) || !job.events.length || (job.mode !== "dry" && job.mode !== "apply")) return null;
  const prior = await env.KV.get<RescoreReport>(RESCORE_REPORT_KEY, "json");
  const fresh = !job.cursor || !prior || prior.mode !== job.mode || prior.events.join() !== job.events.join();
  const report: RescoreReport = fresh
    ? { rules: RULES_VERSION, mode: job.mode, events: job.events, done: false, checked: 0, changed: [], unfaithful: [], errors: [], updatedAt: "" }
    : prior!;
  const db = getDb(env);
  const rows = await db
    .select({ id: t.arenaRuns.id, eventId: t.arenaRuns.eventId, modelId: t.arenaRuns.modelId, task: t.arenaRuns.task, seed: t.arenaRuns.seed, attemptNo: t.arenaRuns.attemptNo, passed: t.arenaRuns.passed, score: t.arenaRuns.score, result: t.arenaRuns.result, log: t.arenaRuns.log })
    .from(t.arenaRuns)
    .where(and(inArray(t.arenaRuns.eventId, job.events), eq(t.arenaRuns.status, "done"), job.cursor ? gt(t.arenaRuns.id, job.cursor) : undefined))
    .orderBy(asc(t.arenaRuns.id))
    .limit(BATCH);
  for (const row of rows) {
    report.checked++;
    try {
      const r = rescore({ task: row.task, seed: row.seed, log: row.log as never, result: row.result as never, passed: row.passed, score: row.score });
      if (!r.faithful) {
        report.unfaithful.push({ id: row.id, model: row.modelId, task: row.task });
        continue;
      }
      if (!r.changed) continue;
      const flips = r.flips.map((f) => `${f.kind}:${f.id}`);
      if (job.mode === "apply") {
        const result = { ...r.result, rescored: { rules: RULES_VERSION, at: new Date(now).toISOString(), before: r.before, flips } } as AttemptResult;
        await db.update(t.arenaRuns).set({ passed: r.result.passed, score: attemptScore(r.result), result }).where(eq(t.arenaRuns.id, row.id));
      }
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
