import { Attempt, attemptScore, conservative, DEFAULT_CAPS, glicko2, NEW_RATING, taskById, TASKS, type CallRecord } from "@forge/arena";
import { and, avg, desc, eq, gte, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { canParticipate } from "../services/access";
import { getDb, newId, type Db } from "../services/db";
import { activeAgent } from "../services/forge";
import type { AgentProps } from "../services/props";

// Proving Ground (ADR 0012 §3, ADR 0013 §4): any connected, human-verified agent takes the same bouts through the
// Forge MCP. The server only referees. Like the headline models (and the Gauntlet, ADR 0024 §6), the agent is never
// told the traps in advance. Each attempt gets a fresh seed (published logs can't be memorised), and is
// rated against the House bar for that task: beat it to earn a ranked slot. Ratings mean "agent plus owner".

export const PG_DAILY_LIMIT = 10;
export const PG_TIME_LIMIT_MS = 30 * 60_000;
/** House bar when no House runs exist yet for a task: a solid-but-not-perfect official score. */
export const DEFAULT_BAR = 0.6;
export const HOUSE_OPPONENT = { rating: 1500, rd: 30, vol: 0.06 };
const MARGIN = 0.02;

type PgRow = typeof t.arenaPgAttempts.$inferSelect;

/** Rebuilds the sandbox by replaying the stored calls. Deterministic: same seed, same calls, same state. */
function replay(row: Pick<PgRow, "task" | "seed" | "calls">) {
  const task = taskById(row.task)!;
  let clock = 0;
  const a = new Attempt(task, row.seed, { caps: DEFAULT_CAPS, now: () => (clock += 1000) });
  for (const c of row.calls as CallRecord[]) a.call(c.name, c.args);
  return a;
}

export async function houseBar(db: Db, task: string) {
  const [r] = await db.select({ v: avg(t.arenaRuns.score) }).from(t.arenaRuns).where(and(eq(t.arenaRuns.task, task), eq(t.arenaRuns.status, "done")));
  return r?.v != null ? Number(r.v) : DEFAULT_BAR;
}

export async function startChallenge(env: Env, props: AgentProps, taskId: string | undefined, now = Date.now()) {
  const db = getDb(env);
  const who = await activeAgent(db, props);
  if (!who) return { error: "agent_inactive" as const };
  if (!canParticipate(env, who.human)) return { error: "not_approved" as const };
  const [open] = await db.select().from(t.arenaPgAttempts).where(and(eq(t.arenaPgAttempts.agentId, who.agent.id), eq(t.arenaPgAttempts.status, "open")));
  if (open && now - open.startedAt < PG_TIME_LIMIT_MS) return { error: "attempt_open" as const, attempt_id: open.id };
  if (open) await finish(env, open, "knockout_time", now);
  const today = await db.select({ n: sql<number>`count(*)` }).from(t.arenaPgAttempts).where(and(eq(t.arenaPgAttempts.agentId, who.agent.id), gte(t.arenaPgAttempts.startedAt, now - 86_400_000)));
  if ((today[0]?.n ?? 0) >= PG_DAILY_LIMIT) return { error: "daily_limit" as const, limit: PG_DAILY_LIMIT };
  const task = taskId ? taskById(taskId) : TASKS[Math.floor(Math.random() * TASKS.length)]!;
  if (!task) return { error: "unknown_task" as const, tasks: TASKS.map((x) => x.id) };
  const seed = 1000 + Math.floor(Math.random() * 1_000_000);
  const id = newId();
  await db.insert(t.arenaPgAttempts).values({ id, agentId: who.agent.id, humanId: who.human.id, task: task.id, seed, calls: [], status: "open", startedAt: now });
  const a = replay({ task: task.id, seed, calls: [] });
  return {
    attempt_id: id,
    task: task.id,
    title: task.title,
    brief: a.variant.brief,
    tools: a.toolSpecs(),
    limits: { tool_calls: DEFAULT_CAPS.toolCalls, minutes: PG_TIME_LIMIT_MS / 60_000 },
    how: "Call arena_act with this attempt_id, a tool name from `tools` and its arguments. Call the `finish` tool once when done.",
  };
}

export async function act(env: Env, props: AgentProps, attemptId: string, tool: string, args: unknown, now = Date.now()) {
  const db = getDb(env);
  const who = await activeAgent(db, props);
  if (!who) return { error: "agent_inactive" as const };
  const [row] = await db.select().from(t.arenaPgAttempts).where(and(eq(t.arenaPgAttempts.id, attemptId), eq(t.arenaPgAttempts.agentId, who.agent.id)));
  if (!row) return { error: "not_found" as const };
  if (row.status !== "open") return { error: "attempt_over" as const, verdict: verdictOf(row) };
  if (now - row.startedAt > PG_TIME_LIMIT_MS) return { error: "attempt_over" as const, verdict: verdictOf(await finish(env, row, "knockout_time", now)) };
  const a = replay(row);
  const out = a.call(tool, args);
  const calls = [...(row.calls as CallRecord[]), { name: tool, args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>, ok: out.ok }];
  if (a.done) {
    const done = await finish(env, { ...row, calls }, a.result!.reason, now);
    return { ok: out.ok, result: safeParse(out.content), verdict: verdictOf(done) };
  }
  await db.update(t.arenaPgAttempts).set({ calls }).where(eq(t.arenaPgAttempts.id, row.id));
  return { ok: out.ok, result: safeParse(out.content), tool_calls_left: a.caps.toolCalls - calls.length };
}

const safeParse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

function verdictOf(row: PgRow) {
  const r = row.result as { passed: boolean; quality: number; cards: unknown[]; traps: { label: string; triggered: boolean }[] } | null;
  return r ? { passed: r.passed, quality: r.quality, score: row.score, cards: r.cards, traps: r.traps, replay: `/arena/proving-ground/${row.id}` } : null;
}

/** Ends an attempt, stores the referee's verdict and log, and rates it against the House bar. */
async function finish(env: Env, row: PgRow, reason: Parameters<Attempt["end"]>[0], now: number): Promise<PgRow> {
  const db = getDb(env);
  const a = replay(row);
  const result = a.done ? a.result! : a.end(reason);
  const score = attemptScore(result);
  const done = { ...row, status: "done" as const, score, passed: result.passed, result, log: a.log, finishedAt: now };
  await db.update(t.arenaPgAttempts).set({ status: "done", score, passed: result.passed, result, log: a.log, finishedAt: now, calls: row.calls }).where(eq(t.arenaPgAttempts.id, row.id));
  // House accounts never enter the ladder.
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, row.humanId) });
  if (!human?.isHouse) {
    const bar = await houseBar(db, row.task);
    const outcome = score > bar + MARGIN ? 1 : score < bar - MARGIN ? 0 : 0.5;
    const subject = `agent:${row.agentId}`;
    const [cur] = await db.select().from(t.arenaRatings).where(eq(t.arenaRatings.subject, subject));
    const next = glicko2(cur ?? NEW_RATING, [{ opp: HOUSE_OPPONENT, score: outcome }]);
    const values = { rating: next.rating, rd: next.rd, vol: next.vol, games: (cur?.games ?? 0) + 1, wins: (cur?.wins ?? 0) + (outcome === 1 ? 1 : 0), updatedAt: now };
    await db.insert(t.arenaRatings).values({ subject, ...values }).onConflictDoUpdate({ target: t.arenaRatings.subject, set: values });
  }
  return done;
}

/** The ladder: agents that have beaten the House bar at least once, by conservative rating. */
export async function ladder(db: Db, limit = 50) {
  const rows = await db
    .select({ r: t.arenaRatings, handle: t.agents.handle, owner: t.humans.githubLogin, ownerId: t.humans.id })
    .from(t.arenaRatings)
    .innerJoin(t.agents, sql`${t.arenaRatings.subject} = 'agent:' || ${t.agents.id}`)
    .innerJoin(t.humans, eq(t.humans.id, t.agents.humanId))
    .where(gte(t.arenaRatings.wins, 1))
    .orderBy(desc(sql`${t.arenaRatings.rating} - 2 * ${t.arenaRatings.rd}`))
    .limit(limit);
  return rows.map((x, i) => ({ rank: i + 1, agent: x.handle, owner: x.owner, rating: conservative(x.r), games: x.r.games, wins: x.r.wins }));
}

export async function pgAttempt(db: Db, id: string) {
  const [row] = await db
    .select({ a: t.arenaPgAttempts, handle: t.agents.handle, owner: t.humans.githubLogin })
    .from(t.arenaPgAttempts)
    .innerJoin(t.agents, eq(t.agents.id, t.arenaPgAttempts.agentId))
    .innerJoin(t.humans, eq(t.humans.id, t.arenaPgAttempts.humanId))
    .where(and(eq(t.arenaPgAttempts.id, id), eq(t.arenaPgAttempts.status, "done")));
  return row ?? null;
}
