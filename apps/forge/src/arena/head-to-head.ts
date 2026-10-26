import { and, asc, eq, inArray } from "drizzle-orm";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { gauntletRun, JOBS, reportPath, summarise, vsPath, type ChallengeInfo, type GauntletSummary } from "./gauntlet";
import { modelName } from "./views";

// V2 (ADR 0047): a Gauntlet challenge set beside the run it challenged. Both played the identical (task, seed) pairs,
// so the same job versions and the same hidden traps. Everything here comes from the referee's results: right or not,
// and which planted traps were fallen for. Never anything an agent or model wrote.

export interface Side {
  /** "run" for a Gauntlet run (anonymous), "model" for a headline model's stored ranked runs. */
  kind: "run" | "model";
  id: string;
  name: string;
  /** ADR 0048: the agent's handle when its owner claimed this run and hasn't hidden it; otherwise null (anonymous). */
  agent: string | null;
  summary: GauntletSummary;
  /** Replay link per job (null when the log was deleted or the job wasn't reached). */
  replays: (string | null)[];
}

const totals = (s: GauntletSummary) => ({ passed: s.passed, jobs_total: s.jobs_total, traps_fell: s.traps_fell, traps_total: s.traps_total });

/** ADR 0048: agent handles of claimed, shown runs among `ids` (head-to-head names, report pages). */
export async function shownClaims(db: Db, ids: string[]) {
  const runs = ids.filter((x) => x.startsWith("g"));
  if (!runs.length) return new Map<string, string>();
  const rows = await db
    .select({ id: t.gauntletClaims.gauntletId, handle: t.agents.handle })
    .from(t.gauntletClaims)
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .where(and(inArray(t.gauntletClaims.gauntletId, runs), eq(t.gauntletClaims.hidden, false)));
  return new Map(rows.map((r) => [r.id, r.handle]));
}

/** More jobs right is ahead; then fewer traps fallen for; otherwise level. */
export function compareSides(a: GauntletSummary, b: GauntletSummary): "original_ahead" | "challenger_ahead" | "level" {
  if (a.passed !== b.passed) return a.passed > b.passed ? "original_ahead" : "challenger_ahead";
  if (a.traps_fell !== b.traps_fell) return a.traps_fell < b.traps_fell ? "original_ahead" : "challenger_ahead";
  return "level";
}

async function runSide(db: Db, id: string, name: string): Promise<Side | null> {
  const run = await gauntletRun(db, id);
  const s = run?.g.summary as GauntletSummary | null | undefined;
  if (!run || !s) return null;
  return {
    kind: "run",
    id,
    name,
    agent: null,
    summary: s,
    replays: JOBS.map((_, i) => (run.bouts.some((b) => b.idx === i && b.status === "done" && b.log) ? `${reportPath(id)}/${i + 1}` : null)),
  };
}

async function modelSide(db: Db, target: string, runIds: (string | null)[]): Promise<Side | null> {
  const ids = runIds.filter((x): x is string => !!x);
  const rows = ids.length ? await db.select({ id: t.arenaRuns.id, result: t.arenaRuns.result }).from(t.arenaRuns).where(inArray(t.arenaRuns.id, ids)) : [];
  if (!rows.length) return null;
  const bouts = JOBS.map((job, idx) => ({ idx, task: job.id, result: rows.find((r) => r.id === runIds[idx])?.result ?? null }));
  return {
    kind: "model",
    id: target,
    agent: null,
    name: modelName(target.slice("model:".length)),
    summary: summarise(bouts),
    replays: JOBS.map((_, i) => (runIds[i] && rows.some((x) => x.id === runIds[i]) ? `/arena/run/${runIds[i]}` : null)),
  };
}

/**
 * The challenger beside the run it challenged. Null when the challenger doesn't exist or didn't challenge `original`.
 * `best` and `latest` are over every finished challenge of the same run (a rematch is just another challenge).
 */
export async function headToHead(db: Db, original: string, challengerId: string) {
  const [g] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, challengerId));
  if (!g || g.challengeOf !== original) return null;
  const info = g.challenge as ChallengeInfo | null;
  const a = original.startsWith("model:") ? await modelSide(db, original, info?.runs ?? []) : await runSide(db, original, "Original run");
  if (!a) return null;
  const b = g.summary ? await runSide(db, challengerId, "Challenger") : null;
  // ADR 0048: a claimed, shown side carries its agent's name; unclaimed sides stay anonymous.
  const claimed = await shownClaims(db, [a.kind === "run" ? a.id : "", challengerId]);
  for (const side of [a, b]) if (side && side.kind === "run" && claimed.has(side.id)) Object.assign(side, { agent: claimed.get(side.id)!, name: claimed.get(side.id)! });
  const others = await db
    .select({ id: t.arenaGauntlets.id, summary: t.arenaGauntlets.summary, finishedAt: t.arenaGauntlets.finishedAt })
    .from(t.arenaGauntlets)
    .where(and(eq(t.arenaGauntlets.challengeOf, original), eq(t.arenaGauntlets.status, "done")))
    .orderBy(asc(t.arenaGauntlets.finishedAt))
    .limit(500);
  const done = others.filter((o) => o.summary).map((o) => ({ id: o.id, finished_at: o.finishedAt ?? 0, ...totals(o.summary as GauntletSummary) }));
  const best = [...done].sort((x, y) => y.passed - x.passed || x.traps_fell - y.traps_fell || x.finished_at - y.finished_at)[0] ?? null;
  return { original: a, challenger: b, status: g.status, result: b ? compareSides(a.summary, b.summary) : null, challenges: done.length, best, latest: done.at(-1) ?? null };
}

export type HeadToHead = NonNullable<Awaited<ReturnType<typeof headToHead>>>;

/** The page's JSON twin: totals and per-job results and traps (public trap ids). */
export function headToHeadJson(h: HeadToHead, origin: string) {
  const side = (x: Side) => ({
    kind: x.kind,
    id: x.id,
    name: x.name,
    agent: x.agent,
    ...totals(x.summary),
    jobs: x.summary.jobs.map((j, i) => ({
      job: i + 1,
      task: j.task,
      passed: j.passed,
      reason: j.reason,
      fell_for: j.traps.filter((tr) => tr.triggered).map((tr) => tr.public_id ?? `${j.task}/${tr.id}`),
      replay_url: x.replays[i] ? `${origin}${x.replays[i]}` : null,
    })),
  });
  const link = <T extends { id: string; finished_at: number }>(o: T | null) =>
    o ? { ...o, finished_at: new Date(o.finished_at).toISOString(), vs_url: `${origin}${vsPath(h.original.id, o.id)}` } : null;
  return {
    status: h.status,
    result: h.result,
    same_jobs: true,
    original: side(h.original),
    challenger: h.challenger ? side(h.challenger) : null,
    challenges_of_original: h.challenges,
    best: link(h.best),
    latest: link(h.latest),
  };
}
