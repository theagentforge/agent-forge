import { boutOutcome, conservative, glicko2, NEW_RATING, summarize, TASKS, type AttemptResult, type LogEvent, type Rating, type Stats } from "@forge/arena";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { modelById, type ArenaModel } from "./lineup";

// Read side of the Arena: what the pages, the Task Guide and the dataset show. Only finished, refereed runs.

export type Kind = "card" | "guest" | "practice";

export interface RunSummary {
  id: string;
  arm?: string | null;
  event: string;
  eventName: string;
  kind: Kind;
  model: string;
  task: string;
  seed: number;
  attempt: number;
  passed: boolean;
  score: number;
  cost: number;
  costEstimated: boolean;
  tokens: number;
  provider: string | null;
  finishedAt: number;
  signature: string | null;
}

export const modelName = (id: string) => modelById(id)?.name ?? id;

/** Finished runs, newest first, optionally filtered. Results are parsed; logs are not loaded here. */
/**
 * Lab #3 events (an `arm` is set) change the prompt, so they never mix into rankings, task guides, the hero or trap
 * rates. Only the lab's own measurement (arena/lift.ts) reads them, with `lab: true`. An event-id filter sees its own.
 */
export async function finishedRuns(db: Db, f: { kinds?: Kind[]; task?: string; eventId?: string; limit?: number; now?: number; lab?: boolean } = {}) {
  const where = [eq(t.arenaRuns.status, "done"), isNotNull(t.arenaRuns.finishedAt), notEmbargoed(f.now ?? Date.now())];
  if (f.lab) where.push(isNotNull(t.arenaEvents.arm));
  else if (!f.eventId) where.push(isNull(t.arenaEvents.arm));
  if (f.task) where.push(eq(t.arenaRuns.task, f.task));
  if (f.eventId) where.push(eq(t.arenaRuns.eventId, f.eventId));
  if (f.kinds) where.push(inArray(t.arenaEvents.kind, f.kinds));
  const rows = await db
    .select({ run: t.arenaRuns, event: t.arenaEvents })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(...where))
    .orderBy(desc(t.arenaRuns.finishedAt))
    .limit(f.limit ?? 5000);
  return rows.map(({ run, event }) => ({
    summary: {
      id: run.id,
      event: event.slug,
      eventName: event.name,
      kind: event.kind,
      arm: event.arm,
      model: run.modelId,
      task: run.task,
      seed: run.seed,
      attempt: run.attemptNo,
      passed: !!run.passed,
      score: run.score ?? 0,
      cost: run.cost ?? 0,
      costEstimated: run.costEstimated,
      tokens: run.tokens ?? 0,
      provider: run.provider,
      finishedAt: run.finishedAt!,
      signature: run.signature,
    } satisfies RunSummary,
    result: run.result as AttemptResult,
  }));
}

/**
 * Runs in a "Call it" fixture stay hidden until the fixture premieres (ADR 0014 §7). Publication is delayed by the
 * schedule, never withheld: every run is public once its premiere has passed.
 */
export const notEmbargoed = (now: number) =>
  sql`not exists (select 1 from arena_fixtures f where f.event_id = ${t.arenaRuns.eventId} and f.task = ${t.arenaRuns.task} and f.premiere_at > ${now} and (f.model_a = ${t.arenaRuns.modelId} or f.model_b = ${t.arenaRuns.modelId}))`;

export async function runWithLog(db: Db, id: string, now = Date.now()) {
  const [row] = await db
    .select({ run: t.arenaRuns, event: t.arenaEvents })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(eq(t.arenaRuns.id, id), eq(t.arenaRuns.status, "done"), notEmbargoed(now)));
  if (!row) return null;
  return { run: row.run, event: row.event, result: row.run.result as AttemptResult, log: row.run.log as LogEvent[] };
}

export interface ModelRow {
  item: ArenaModel | { id: string; name: string; lab: string; division: string };
  stats: Stats;
}

/** Per-model stats for one task. Headline (card + guest) runs only, unless `practice` is asked for. */
export async function taskBoard(db: Db, task: string, practice = false): Promise<ModelRow[]> {
  const runs = await finishedRuns(db, { task, kinds: practice ? ["practice"] : ["card", "guest"] });
  const by = new Map<string, AttemptResult[]>();
  for (const r of runs) by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r.result]);
  return [...by.entries()].map(([id, results]) => ({ item: modelById(id) ?? { id, name: id, lab: "", division: "" }, stats: summarize(results) }));
}

/** One event's card: for each task, every model's stats and the head-to-head winner against the runner-up. */
export async function eventCard(db: Db, slug: string) {
  const [event] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, slug));
  if (!event) return null;
  const runs = await finishedRuns(db, { eventId: event.id });
  const bouts = TASKS.map((task) => {
    const by = new Map<string, AttemptResult[]>();
    for (const r of runs.filter((x) => x.summary.task === task.id)) by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r.result]);
    const rows = [...by.entries()].map(([model, results]) => ({ model, results, stats: summarize(results) })).sort((a, b) => b.stats.score - a.stats.score);
    const outcome = rows.length >= 2 ? boutOutcome(rows[0]!, rows[1]!) : null;
    return { task, rows: rows.map(({ model, stats }) => ({ model, name: modelName(model), stats })), outcome };
  }).filter((b) => b.rows.length);
  return { event, bouts, runs: runs.map((r) => r.summary) };
}

/** Now Playing: finished runs as a looping playlist. Everyone sees the same moment (position comes from the clock). */
export async function playlist(db: Db, limit = 24) {
  const runs = await finishedRuns(db, { limit });
  return runs.map(({ summary: s, result }) => {
    const beats = Math.min(90, Math.max(20, (result.toolCalls + result.turns) * 3));
    return { id: s.id, model: modelName(s.model), task: TASKS.find((x) => x.id === s.task)?.title ?? s.task, kind: s.kind, recorded: s.finishedAt, seconds: beats, passed: s.passed };
  });
}

/**
 * Division rankings (ADR 0013 §4): Glicko-2 over headline events in order. Each event is one rating period; every
 * pair of models on a task is a game decided by the published scorecard (a tiebreak win counts, a draw is ½).
 */
export function computeRankings(events: { results: { model: string; task: string; result: AttemptResult }[] }[]) {
  const ratings = new Map<string, Rating>();
  for (const ev of events) {
    const games = new Map<string, { opp: Rating; score: number }[]>();
    const tasks = new Set(ev.results.map((r) => r.task));
    for (const task of tasks) {
      const by = new Map<string, AttemptResult[]>();
      for (const r of ev.results.filter((x) => x.task === task)) by.set(r.model, [...(by.get(r.model) ?? []), r.result]);
      const models = [...by.keys()];
      for (let i = 0; i < models.length; i++)
        for (let j = i + 1; j < models.length; j++) {
          const [a, b] = [models[i]!, models[j]!];
          const o = boutOutcome({ model: a, results: by.get(a)! }, { model: b, results: by.get(b)! });
          const sa = o.winner === a ? 1 : o.winner === b ? 0 : 0.5;
          const ra = ratings.get(a) ?? NEW_RATING;
          const rb = ratings.get(b) ?? NEW_RATING;
          games.set(a, [...(games.get(a) ?? []), { opp: rb, score: sa }]);
          games.set(b, [...(games.get(b) ?? []), { opp: ra, score: 1 - sa }]);
        }
    }
    for (const [m, g] of games) ratings.set(m, glicko2(ratings.get(m) ?? NEW_RATING, g));
  }
  return ratings;
}

export async function divisionRankings(db: Db, divisionOf: (model: string) => string | null = (m) => modelById(m)?.division ?? null) {
  const runs = (await finishedRuns(db, { kinds: ["card", "guest"] })).reverse();
  const order: string[] = [];
  const byEvent = new Map<string, { model: string; task: string; result: AttemptResult }[]>();
  for (const r of runs) {
    if (!byEvent.has(r.summary.event)) order.push(r.summary.event);
    byEvent.set(r.summary.event, [...(byEvent.get(r.summary.event) ?? []), { model: r.summary.model, task: r.summary.task, result: r.result }]);
  }
  const ratings = computeRankings(order.map((e) => ({ results: byEvent.get(e)! })));
  const out: Record<string, { model: string; name: string; rating: number; rd: number }[]> = {};
  for (const [model, r] of ratings) {
    const d = divisionOf(model);
    if (!d || d === "practice") continue;
    (out[d] ??= []).push({ model, name: modelName(model), rating: conservative(r), rd: Math.round(r.rd) });
  }
  for (const d of Object.keys(out)) out[d] = out[d]!.sort((a, b) => b.rating - a.rating).slice(0, 15);
  return out;
}
