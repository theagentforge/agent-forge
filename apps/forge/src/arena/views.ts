import { boutOutcome, conservative, glicko2, HARD3_2_TASKS, HARD3_TASKS, HARD_TASKS, NEW_RATING, PRACTICE_ONLY_TASK_IDS, summarize, taskById, TASKS, type AttemptResult, type LogEvent, type Rating, type Stats } from "@forge/arena";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { EMBARGOED_MODEL_IDS, modelById, type ArenaModel } from "./lineup";

// Read side of the Arena: what the pages, the Task Guide and the dataset show. Only finished, refereed runs.

export type Kind = "card" | "guest" | "practice";

/** The Normal card (TASKS) and the Hard tier (HARD_TASKS, ADR 0021): the same six jobs, shown as separate sections. */
export type Tier = "normal" | "hard";
const HARD_IDS = [...HARD_TASKS, ...HARD3_TASKS, ...HARD3_2_TASKS].map((x) => x.id);
export const tierOf = (task: string): Tier => (HARD_IDS.includes(task) ? "hard" : "normal");
export const tierTasks = (tier: Tier) => (tier === "hard" ? HARD_TASKS : TASKS);
/** `?tier=hard` picks the Hard tier; anything else (or nothing) is Normal. */
export const parseTier = (q: string | undefined): Tier => (q === "hard" ? "hard" : "normal");

/**
 * Consistency (ADR 0021 §5, amendment 2): did a model get the same version of a job right every time? Attempts are
 * grouped by (task, seed); `reliable` is the share of groups where every attempt passed ("right 3 times out of 3").
 */
export interface Consistency {
  passes: number;
  attempts: number;
  /** (task, seed) groups: one per version of a job a model was given. */
  groups: number;
  /** Groups where every attempt passed. */
  allRight: number;
  reliable: number;
}

export function consistency(results: { task: string; seed: number; passed: boolean }[]): Consistency {
  const groups = new Map<string, boolean[]>();
  for (const r of results) groups.set(`${r.task}:${r.seed}`, [...(groups.get(`${r.task}:${r.seed}`) ?? []), r.passed]);
  const allRight = [...groups.values()].filter((g) => g.every(Boolean)).length;
  return {
    passes: results.filter((r) => r.passed).length,
    attempts: results.length,
    groups: groups.size,
    allRight,
    reliable: groups.size ? Math.round((allRight / groups.size) * 1000) / 1000 : 0,
  };
}

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

/** True when a bout ended because the model hit a stamina limit (ADR 0021): reported apart from traps and mistakes. */
export const isKnockout = (r: { reason?: string } | null | undefined) => !!r?.reason?.startsWith("knockout_");

export const modelName = (id: string) => modelById(id)?.name ?? id;

/** Finished runs, newest first, optionally filtered. Results are parsed; logs are not loaded here. */
/**
 * Lab #3 events (an `arm` is set) change the prompt, so they never mix into rankings, task guides, the hero or trap
 * rates. Only the lab's own measurement (arena/lift.ts) reads them, with `lab: true`. An event-id filter sees its own.
 */
export async function finishedRuns(db: Db, f: { kinds?: Kind[]; task?: string; eventId?: string; limit?: number; now?: number; lab?: boolean; hard?: boolean; tier?: Tier } = {}) {
  const where = [eq(t.arenaRuns.status, "done"), isNotNull(t.arenaRuns.finishedAt), notEmbargoed(f.now ?? Date.now())];
  // Hard-tier runs (ADR 0021) stay out of the Normal pages, rankings, trap data and the home duel until asked for:
  // `tier: "hard"` gives only Hard runs, `hard: true` gives both tiers.
  if (f.tier === "hard") where.push(inArray(t.arenaRuns.task, HARD_IDS));
  else if (!f.hard && !f.eventId && !f.task) where.push(notInArray(t.arenaRuns.task, HARD_IDS));
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
export const notEmbargoed = (now: number) => and(notEmbargoedKeepHeldOut(now), notHeldOut())!;

/**
 * As `notEmbargoed`, but held-out runs (ADR 0058) stay in. Only aggregate readers use it (arena/holdout.ts: the
 * public-vs-held-out gap and the longitudinal panel), and they publish counts and rates, never a run.
 */
export const notEmbargoedKeepHeldOut = (now: number) =>
  and(
    sql`not exists (select 1 from arena_fixtures f where f.event_id = ${t.arenaRuns.eventId} and f.task = ${t.arenaRuns.task} and f.premiere_at > ${now} and (f.model_a = ${t.arenaRuns.modelId} or f.model_b = ${t.arenaRuns.modelId}))`,
    publishableModelAndEvent(),
  )!;

/** Runs on a private held-out seed (ADR 0058) are never published one by one: no row, brief, log, replay or card. */
export const notHeldOut = () => eq(t.arenaRuns.heldOut, false);

/**
 * Runs no public surface may read: an embargoed model's (K2, `embargoed` in the lineup), a private family's (ADR 0057), and any run of an event held
 * for review (status "planned": ADR 0021 amendment 2, every fail is checked in the log before it's published). A held
 * event is published by setting its status to "running" once the review is done; no release needed. Runs on held-out
 * seeds (ADR 0058) are never readable here either.
 */
export const notEmbargoedModel = () => and(publishableModelAndEvent(), notHeldOut())!;

const publishableModelAndEvent = () =>
  and(
    EMBARGOED_MODEL_IDS.length ? notInArray(t.arenaRuns.modelId, EMBARGOED_MODEL_IDS) : sql`1 = 1`,
    // ADR 0057: runs of the private job families are private held-out material, shown on no public surface.
    PRACTICE_ONLY_TASK_IDS.length ? notInArray(t.arenaRuns.task, [...PRACTICE_ONLY_TASK_IDS]) : sql`1 = 1`,
    sql`${t.arenaRuns.eventId} not in (select id from arena_events where status = 'planned')`,
  )!;

export async function runWithLog(db: Db, id: string, now = Date.now()) {
  const [row] = await db
    .select({ run: t.arenaRuns, event: t.arenaEvents })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(eq(t.arenaRuns.id, id), eq(t.arenaRuns.status, "done"), notEmbargoed(now)));
  if (!row) return null;
  return { run: row.run, event: row.event, result: row.run.result as AttemptResult, log: row.run.log as LogEvent[] };
}

/** A short link's run (ADR 0023 §1): the one finished, public run whose id starts with `prefix`, or null if none or several. */
export async function runIdByPrefix(db: Db, prefix: string, now = Date.now()) {
  if (!/^[0-9a-f]{8}$/.test(prefix)) return null;
  const rows = await db
    .select({ id: t.arenaRuns.id })
    .from(t.arenaRuns)
    .where(and(sql`${t.arenaRuns.id} like ${`${prefix}%`}`, eq(t.arenaRuns.status, "done"), notEmbargoed(now)))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}

export interface ModelRow {
  item: ArenaModel | { id: string; name: string; lab: string; division: string };
  stats: Stats;
  consistency: Consistency;
}

/** Per-model stats for one task. Headline (card + guest) runs only, unless `practice` is asked for. */
export async function taskBoard(db: Db, task: string, practice = false): Promise<ModelRow[]> {
  const runs = await finishedRuns(db, { task, kinds: practice ? ["practice"] : ["card", "guest"] });
  const by = new Map<string, AttemptResult[]>();
  for (const r of runs) by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r.result]);
  return [...by.entries()].map(([id, results]) => ({ item: modelById(id) ?? { id, name: id, lab: "", division: "" }, stats: summarize(results), consistency: consistency(results) }));
}

/**
 * The consistency table for one tier: for each model, passes out of attempts on each job (same version, e.g. "2 of
 * 3"), the overall pass rate and the Reliable figure. Headline (card + guest) runs only, most reliable first.
 */
export async function consistencyBoard(db: Db, tier: Tier = "normal") {
  const tasks = tierTasks(tier);
  const runs = (await finishedRuns(db, { kinds: ["card", "guest"], tier })).filter((r) => tasks.some((x) => x.id === r.summary.task));
  const by = new Map<string, RunSummary[]>();
  const ranOut = new Map<string, number>();
  for (const r of runs) {
    by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r.summary]);
    if (isKnockout(r.result)) ranOut.set(r.summary.model, (ranOut.get(r.summary.model) ?? 0) + 1);
  }
  const models = [...by.entries()].map(([model, rs]) => {
    const all = consistency(rs);
    return {
      model,
      name: modelName(model),
      passRate: all.attempts ? Math.round((all.passes / all.attempts) * 1000) / 1000 : 0,
      overall: all,
      /** Attempts lost to a stamina limit (time, tool calls, tokens or turns), not to a trap or a wrong answer. */
      ranOut: ranOut.get(model) ?? 0,
      tasks: Object.fromEntries(tasks.map((x) => [x.id, rs.some((r) => r.task === x.id) ? consistency(rs.filter((r) => r.task === x.id)) : null])) as Record<string, Consistency | null>,
    };
  });
  models.sort((a, b) => b.overall.reliable - a.overall.reliable || b.passRate - a.passRate || a.name.localeCompare(b.name));
  return { tier, tasks: tasks.map((x) => ({ id: x.id, title: x.title })), models };
}

/** The terms every Arena download carries (the dataset, event files and their schema.org Dataset markup): ADR 0053. */
export { DATASET_LICENCE } from "../services/provenance";

/** Event kinds that are ranked (headline) results. */
export const RANKED_KINDS: Kind[] = ["card", "guest"];

/** An event any public surface may show: it exists and isn't held for review (status "planned"). */
export async function publicEvent(db: Db, slug: string) {
  const [event] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, slug));
  return event && event.status !== "planned" ? event : null;
}

/** A ranked event: card or guest, and not a Lab #3 arm (those change the prompt). */
export const isRankedEvent = (e: { kind: Kind; arm: string | null }) => RANKED_KINDS.includes(e.kind) && !e.arm;

/**
 * Ranked events with at least one public run (so held events and embargoed-only events never show), newest first,
 * with the first and last finish times of their public runs.
 */
export async function rankedEvents(db: Db, now = Date.now()) {
  const last = sql<number>`max(${t.arenaRuns.finishedAt})`;
  return db
    .select({ slug: t.arenaEvents.slug, name: t.arenaEvents.name, kind: t.arenaEvents.kind, runs: sql<number>`count(*)`, first: sql<number>`min(${t.arenaRuns.finishedAt})`, last })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(eq(t.arenaRuns.status, "done"), isNotNull(t.arenaRuns.finishedAt), notEmbargoed(now), inArray(t.arenaEvents.kind, RANKED_KINDS), isNull(t.arenaEvents.arm)))
    .groupBy(t.arenaEvents.id)
    .orderBy(desc(last));
}

/** One event's card: for each task, every model's stats and the head-to-head winner against the runner-up. */
export async function eventCard(db: Db, slug: string) {
  // An event held for review isn't public yet.
  const event = await publicEvent(db, slug);
  if (!event) return null;
  const runs = await finishedRuns(db, { eventId: event.id });
  const bouts = [...TASKS, ...HARD_TASKS, ...HARD3_TASKS, ...HARD3_2_TASKS].map((task) => {
    const by = new Map<string, AttemptResult[]>();
    for (const r of runs.filter((x) => x.summary.task === task.id)) by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r.result]);
    const rows = [...by.entries()].map(([model, results]) => ({ model, results, stats: summarize(results) })).sort((a, b) => b.stats.score - a.stats.score);
    const outcome = rows.length >= 2 ? boutOutcome(rows[0]!, rows[1]!) : null;
    return { task, rows: rows.map(({ model, stats, results }) => ({ model, name: modelName(model), stats, consistency: consistency(results) })), outcome };
  }).filter((b) => b.rows.length);
  return { event, bouts, runs: runs.map((r) => r.summary) };
}

/** Now Playing: finished runs as a looping playlist. Everyone sees the same moment (position comes from the clock). */
export async function playlist(db: Db, limit = 24) {
  const runs = await finishedRuns(db, { limit });
  return runs.map(({ summary: s, result }) => {
    const beats = Math.min(90, Math.max(20, (result.toolCalls + result.turns) * 3));
    return { id: s.id, model: modelName(s.model), task: taskById(s.task)?.title ?? s.task, kind: s.kind, recorded: s.finishedAt, seconds: beats, passed: s.passed };
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

export async function divisionRankings(db: Db, divisionOf: (model: string) => string | null = (m) => modelById(m)?.division ?? null, tier: Tier = "normal") {
  const runs = (await finishedRuns(db, { kinds: ["card", "guest"], tier })).reverse();
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
