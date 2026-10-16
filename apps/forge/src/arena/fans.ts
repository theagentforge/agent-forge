import { boutOutcome, TASKS, TWISTS, type AttemptResult } from "@forge/arena";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, newId, type Db } from "../services/db";
import { modelName } from "./views";

// Fans choose what is tested, never how it's scored (ADR 0014 §5), and call results before they air (§7).

/** ISO week label, e.g. 2026-W44 (weeks start Monday, UTC). */
export function isoWeek(ms: number) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Voting closes at the end of the ISO week (Sunday 23:59:59 UTC). */
export function weekCloses(ms: number) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 7) - 1;
}

/** House options for a week: three tasks (rotating, so every task comes round) and every twist. */
export function pollOptions(week: string, kind: "task" | "twist"): { id: string; label: string }[] {
  if (kind === "twist") return TWISTS.map((x) => ({ id: x.id, label: x.label }));
  const n = Number(week.slice(-2)) || 0;
  return [0, 1, 2].map((i) => TASKS[(n * 3 + i) % TASKS.length]!).map((x) => ({ id: x.id, label: x.title }));
}

export async function pollResults(db: Db, week: string, kind: "task" | "twist") {
  const rows = await db
    .select({ option: t.arenaVotes.option, n: sql<number>`count(*)` })
    .from(t.arenaVotes)
    .where(and(eq(t.arenaVotes.week, week), eq(t.arenaVotes.kind, kind)))
    .groupBy(t.arenaVotes.option);
  const counts = Object.fromEntries(rows.map((r) => [r.option, r.n]));
  const options = pollOptions(week, kind).map((o) => ({ ...o, votes: counts[o.id] ?? 0 }));
  // The winner is honoured; a tie goes to the option listed first (published in advance on the page).
  const winner = options.reduce<(typeof options)[0] | null>((best, o) => (o.votes > (best?.votes ?? 0) ? o : best), null);
  return { week, kind, options, total: options.reduce((s, o) => s + o.votes, 0), winner: winner?.id ?? null };
}

export type VoteOutcome = "recorded" | "already_voted" | "not_an_option" | "closed";

export async function castVote(env: Env, humanId: string, kind: "task" | "twist", option: string, now = Date.now()): Promise<VoteOutcome> {
  const week = isoWeek(now);
  if (now > weekCloses(now)) return "closed";
  if (!pollOptions(week, kind).some((o) => o.id === option)) return "not_an_option";
  const res = await getDb(env).insert(t.arenaVotes).values({ week, kind, option, humanId }).onConflictDoNothing().run();
  return res.meta.changes ? "recorded" : "already_voted";
}

export async function myVotes(db: Db, humanId: string, week: string) {
  const rows = await db.select().from(t.arenaVotes).where(and(eq(t.arenaVotes.week, week), eq(t.arenaVotes.humanId, humanId)));
  return Object.fromEntries(rows.map((r) => [r.kind, r.option])) as Partial<Record<"task" | "twist", string>>;
}

// --- Call it --------------------------------------------------------------------------------------------------

export const PICK_OPTIONS = ["a", "b", "tie"] as const;
export type PickOption = (typeof PICK_OPTIONS)[number];

/** Schedules a daily premiere of a head-to-head from an event. Its runs stay embargoed until `premiereAt`. */
export async function scheduleFixture(env: Env, f: { day: string; eventId: string; task: string; modelA: string; modelB: string; premiereAt: number }) {
  const id = newId();
  await getDb(env).insert(t.arenaFixtures).values({ id, ...f }).onConflictDoNothing();
  return id;
}

/** The result of an aired fixture, from the published scorecard (a statistical tie is a "tie" here). */
async function fixtureResult(db: Db, f: typeof t.arenaFixtures.$inferSelect): Promise<PickOption | null> {
  const rows = await db
    .select({ model: t.arenaRuns.modelId, result: t.arenaRuns.result })
    .from(t.arenaRuns)
    .where(and(eq(t.arenaRuns.eventId, f.eventId), eq(t.arenaRuns.task, f.task), eq(t.arenaRuns.status, "done")));
  const a = rows.filter((r) => r.model === f.modelA).map((r) => r.result as AttemptResult);
  const b = rows.filter((r) => r.model === f.modelB).map((r) => r.result as AttemptResult);
  if (!a.length || !b.length) return null;
  const o = boutOutcome({ model: f.modelA, results: a }, { model: f.modelB, results: b });
  // Picks call the scorecard result; a tiebreak win counts as a tie (the scorecard couldn't separate them).
  if (o.method !== "score" || !o.winner) return "tie";
  return o.winner === f.modelA ? "a" : "b";
}

export async function fixtures(db: Db, now = Date.now(), days = 14) {
  const from = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now + 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select().from(t.arenaFixtures).where(and(gte(t.arenaFixtures.day, from), lte(t.arenaFixtures.day, to))).orderBy(desc(t.arenaFixtures.day));
  return Promise.all(
    rows.map(async (f) => {
      const aired = f.premiereAt <= now;
      const totals = await db.select().from(t.arenaPickTotals).where(eq(t.arenaPickTotals.fixtureId, f.id));
      const task = TASKS.find((x) => x.id === f.task);
      return {
        id: f.id,
        day: f.day,
        task: f.task,
        taskTitle: task?.title ?? f.task,
        a: { id: f.modelA, name: modelName(f.modelA) },
        b: { id: f.modelB, name: modelName(f.modelB) },
        premiereAt: f.premiereAt,
        aired,
        result: aired ? await fixtureResult(db, f) : null,
        picks: Object.fromEntries(PICK_OPTIONS.map((o) => [o, totals.find((x) => x.option === o)?.n ?? 0])),
      };
    }),
  );
}

export async function recordPick(env: Env, fixtureId: string, option: string, now = Date.now()) {
  if (!PICK_OPTIONS.includes(option as PickOption)) return "not_an_option" as const;
  const db = getDb(env);
  const [f] = await db.select().from(t.arenaFixtures).where(eq(t.arenaFixtures.id, fixtureId));
  if (!f) return "not_found" as const;
  if (f.premiereAt <= now) return "closed" as const;
  await db
    .insert(t.arenaPickTotals)
    .values({ fixtureId, option, n: 1 })
    .onConflictDoUpdate({ target: [t.arenaPickTotals.fixtureId, t.arenaPickTotals.option], set: { n: sql`${t.arenaPickTotals.n} + 1` } });
  return "recorded" as const;
}
