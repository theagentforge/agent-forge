import { Attempt, DEFAULT_CAPS, publicTrapId, TASKS, type AttemptResult, type CallRecord } from "@forge/arena";
import { TRAP_CARD_DATE, TRAP_CARD_VERSION, TRAP_CHECKS } from "@forge/shared";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import { day, sourceHash } from "../services/proof";

// The Gauntlet (ADR 0024): the six everyday jobs in a row, for any agent, with no account. The server only referees:
// it rebuilds each sandbox by replaying the stored calls, so a run costs D1 writes and no model. At the end the agent
// gets a report card and a trap card made from the traps it fell for. A re-run with `card_from` plays six new variants
// with that card at the top of every brief, so the before/after is measured on the user's own agent, not promised.
// Agents never get the trap names in advance (headline models don't either), so results compare with the Arena's.

export const GAUNTLET_TIME_LIMIT_MS = 2 * 60 * 60_000;
/** Starts per visitor per day (one-day code, never the IP) and for everyone per day: soft caps against abuse. */
export const GAUNTLET_DAILY_PER_SOURCE = 10;
export const GAUNTLET_DAILY_TOTAL = 3000;
/** Tool calls and logs are deleted after this; the summary (pass/fail and traps per job) stays. */
export const GAUNTLET_KEEP_LOGS_MS = 30 * 86_400_000;
export const JOBS = TASKS;

type G = typeof t.arenaGauntlets.$inferSelect;
type B = typeof t.arenaGauntletBouts.$inferSelect;

export interface GauntletJob {
  idx: number;
  task: string;
  title: string;
  passed: boolean;
  reason: string;
  quality: number;
  traps: { id: string; public_id: string | null; label: string; triggered: boolean }[];
}
export interface GauntletSummary {
  jobs: GauntletJob[];
  passed: number;
  jobs_total: number;
  traps_fell: number;
  traps_total: number;
  /** "task/trap" keys of the traps it fell for. */
  fell: string[];
}

const newGauntletId = () => `g${crypto.randomUUID().replace(/-/g, "")}`;
const newSeed = () => 1000 + Math.floor(Math.random() * 1_000_000);
export const reportPath = (id: string) => `/gauntlet/r/${id}`;

function replay(b: Pick<B, "task" | "seed" | "calls">) {
  const task = JOBS.find((x) => x.id === b.task)!;
  let clock = 0;
  const a = new Attempt(task, b.seed, { caps: DEFAULT_CAPS, now: () => (clock += 1000) });
  for (const c of b.calls as CallRecord[]) a.call(c.name, c.args);
  return a;
}

/**
 * The trap card for one agent: the published checks, with the ones for traps it fell for first. Same wording as the
 * public card (no new claims), so its effect can be read against Forge Lab #3.
 */
export function tailoredCard(fell: string[], runId: string): string {
  const hit = new Set(fell);
  const first = TRAP_CHECKS.filter((c) => c.traps.some((k) => hit.has(k)));
  const rest = TRAP_CHECKS.filter((c) => !first.includes(c));
  const head = `Checks for my AI agent (Forge trap card v${TRAP_CARD_VERSION}, ${TRAP_CARD_DATE}, tailored from Gauntlet run ${runId.slice(1, 9)}):`;
  if (!first.length) return [head, ...rest.map((c) => `- ${c.text}`)].join("\n");
  return [head, "Most important (it slipped on these):", ...first.map((c) => `- ${c.text}`), "Also:", ...rest.map((c) => `- ${c.text}`)].join("\n");
}

/** The job an agent sees. On a measured re-run, the card comes first, the way a user's standing instructions would. */
function jobPayload(g: Pick<G, "id" | "card" | "cardFrom">, b: Pick<B, "idx" | "task" | "seed" | "calls">) {
  const a = replay(b);
  const brief = g.cardFrom && g.card ? `Your owner's standing instructions:\n${g.card}\n\nThe job:\n${a.variant.brief}` : a.variant.brief;
  return {
    job: b.idx + 1,
    of: JOBS.length,
    task: b.task,
    title: a.task.title,
    brief,
    tools: a.toolSpecs(),
    limits: { tool_calls: a.caps.toolCalls, tool_calls_left: a.caps.toolCalls - (b.calls as CallRecord[]).length },
  };
}

async function sourceCount(env: Env, ip: string, now: number) {
  const d = day(now);
  const code = await sourceHash(env.SESSION_SECRET, d, `gauntlet|${ip}`);
  return { mine: `gauntlet-src:${d}:${code}`, all: `gauntlet-all:${d}` };
}

async function bump(env: Env, key: string) {
  const n = Number((await env.KV.get(key)) ?? 0) + 1;
  await env.KV.put(key, String(n), { expirationTtl: 2 * 86_400 });
  return n;
}

export async function startGauntlet(env: Env, ip: string, opts: { cardFrom?: string } = {}, now = Date.now()) {
  const db = getDb(env);
  const { success } = await env.CHECK_LIMITER.limit({ key: `gauntlet:${ip}` });
  if (!success) return { error: "rate_limited" as const };
  const keys = await sourceCount(env, ip, now);
  if (Number((await env.KV.get(keys.all)) ?? 0) >= GAUNTLET_DAILY_TOTAL) return { error: "busy_today" as const };
  if (Number((await env.KV.get(keys.mine)) ?? 0) >= GAUNTLET_DAILY_PER_SOURCE) return { error: "daily_limit" as const, limit: GAUNTLET_DAILY_PER_SOURCE };

  let card: string | null = null;
  if (opts.cardFrom) {
    const [parent] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, opts.cardFrom));
    if (!parent || parent.cardFrom) return { error: "unknown_run" as const };
    if (parent.status !== "done" || !parent.card) return { error: "run_not_finished" as const };
    card = parent.card;
  }
  await bump(env, keys.all);
  await bump(env, keys.mine);

  const id = newGauntletId();
  await db.insert(t.arenaGauntlets).values({ id, status: "open", cardFrom: opts.cardFrom ?? null, card, current: 0, startedAt: now });
  const first = { id: crypto.randomUUID(), gauntletId: id, idx: 0, task: JOBS[0]!.id, seed: newSeed(), calls: [], status: "open" as const, startedAt: now };
  await db.insert(t.arenaGauntletBouts).values(first);
  return {
    gauntlet_id: id,
    measured_rerun_of: opts.cardFrom ?? null,
    jobs: JOBS.map((x) => x.id),
    time_limit_minutes: GAUNTLET_TIME_LIMIT_MS / 60_000,
    report_url: reportPath(id),
    how: "Call gauntlet_act with this gauntlet_id, a tool name from `tools` and its arguments. Call the job's `finish` tool when a job is done or can't be done; the next job follows.",
    current: jobPayload({ id, card, cardFrom: opts.cardFrom ?? null }, first),
  };
}

async function load(db: Db, id: string) {
  const [g] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, id));
  if (!g) return null;
  const [b] = await db.select().from(t.arenaGauntletBouts).where(and(eq(t.arenaGauntletBouts.gauntletId, id), eq(t.arenaGauntletBouts.idx, g.current)));
  return { g, b: b ?? null };
}

export async function gauntletAct(env: Env, id: string, tool: string, args: unknown, now = Date.now()) {
  const db = getDb(env);
  const { success } = await env.CHECK_LIMITER.limit({ key: `gauntlet-act:${id}` });
  if (!success) return { error: "rate_limited" as const };
  const got = await load(db, id);
  if (!got) return { error: "not_found" as const };
  let { g, b } = got;
  if (g.status === "done" || !b) return { error: "gauntlet_over" as const, report: reportOf(g) };
  if (now - g.startedAt > GAUNTLET_TIME_LIMIT_MS) {
    g = await finishAll(env, g, b, now);
    return { error: "gauntlet_over" as const, reason: "time_limit", report: reportOf(g) };
  }
  const a = replay(b);
  const out = a.call(tool, args);
  const calls = [...(b.calls as CallRecord[]), { name: tool, args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>, ok: out.ok }];
  if (!a.done) {
    await db.update(t.arenaGauntletBouts).set({ calls }).where(eq(t.arenaGauntletBouts.id, b.id));
    return { ok: out.ok, result: safeParse(out.content), tool_calls_left: a.caps.toolCalls - calls.length };
  }
  const verdict = await closeBout(db, { ...b, calls }, a.result!, a, now);
  if (b.idx + 1 < JOBS.length) {
    const next = { id: crypto.randomUUID(), gauntletId: g.id, idx: b.idx + 1, task: JOBS[b.idx + 1]!.id, seed: newSeed(), calls: [], status: "open" as const, startedAt: now };
    await db.insert(t.arenaGauntletBouts).values(next);
    await db.update(t.arenaGauntlets).set({ current: next.idx }).where(eq(t.arenaGauntlets.id, g.id));
    return { ok: out.ok, result: safeParse(out.content), job_verdict: verdict, next: jobPayload(g, next) };
  }
  g = await finalize(env, g, now);
  return { ok: out.ok, result: safeParse(out.content), job_verdict: verdict, report: reportOf(g) };
}

export async function gauntletStatus(env: Env, id: string, now = Date.now()) {
  const db = getDb(env);
  const got = await load(db, id);
  if (!got) return { error: "not_found" as const };
  let { g, b } = got;
  if (g.status === "open" && b && now - g.startedAt > GAUNTLET_TIME_LIMIT_MS) g = await finishAll(env, g, b, now);
  if (g.status === "done" || !b) return { status: "done" as const, report: reportOf(g) };
  return { status: "open" as const, current: jobPayload(g, b) };
}

const verdictOf = (r: AttemptResult) => ({ passed: r.passed, reason: r.reason, traps_fell: r.traps.filter((x) => x.triggered).length, traps_total: r.traps.length });

async function closeBout(db: Db, b: B, result: AttemptResult, a: Attempt, now: number) {
  await db.update(t.arenaGauntletBouts).set({ status: "done", calls: b.calls, passed: result.passed, result, log: a.log, finishedAt: now }).where(eq(t.arenaGauntletBouts.id, b.id));
  return verdictOf(result);
}

/** Time ran out: the open job ends as a time knockout, and jobs never reached count as not passed. */
async function finishAll(env: Env, g: G, b: B, now: number) {
  const a = replay(b);
  const result = a.done ? a.result! : a.end("knockout_time");
  await closeBout(getDb(env), b, result, a, now);
  return finalize(env, g, now);
}

async function finalize(env: Env, g: G, now: number): Promise<G> {
  const db = getDb(env);
  const bouts = await db.select().from(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, g.id)).orderBy(asc(t.arenaGauntletBouts.idx));
  const summary = summarise(bouts);
  // The first run gets its own card; a measured re-run keeps the card it was given.
  const card = g.cardFrom ? g.card : tailoredCard(summary.fell, g.id);
  await db.update(t.arenaGauntlets).set({ status: "done", summary, card, finishedAt: now }).where(eq(t.arenaGauntlets.id, g.id));
  return { ...g, status: "done", summary, card, finishedAt: now };
}

export function summarise(bouts: Pick<B, "idx" | "task" | "result">[]): GauntletSummary {
  const jobs: GauntletJob[] = JOBS.map((task, idx) => {
    const r = bouts.find((x) => x.idx === idx)?.result as AttemptResult | null | undefined;
    return {
      idx,
      task: task.id,
      title: task.title,
      passed: r?.passed ?? false,
      reason: r?.reason ?? "not_reached",
      quality: r?.quality ?? 0,
      traps: (r?.traps ?? []).map((x) => ({ id: x.id, public_id: publicTrapId(task.id, x.id), label: x.label, triggered: x.triggered })),
    };
  });
  const all = jobs.flatMap((j) => j.traps.map((x) => ({ ...x, task: j.task })));
  return {
    jobs,
    passed: jobs.filter((j) => j.passed).length,
    jobs_total: jobs.length,
    traps_fell: all.filter((x) => x.triggered).length,
    traps_total: all.length,
    fell: all.filter((x) => x.triggered).map((x) => `${x.task}/${x.id}`),
  };
}

function reportOf(g: G) {
  const s = g.summary as GauntletSummary | null;
  if (!s) return null;
  return {
    report_url: reportPath(g.id),
    passed: s.passed,
    jobs_total: s.jobs_total,
    traps_fell: s.traps_fell,
    traps_total: s.traps_total,
    fell_for: s.jobs.flatMap((j) => j.traps.filter((x) => x.triggered).map((x) => x.public_id ?? `${j.task}/${x.id}`)),
    measured_rerun_of: g.cardFrom,
    trap_card: g.cardFrom ? null : g.card,
    next: g.cardFrom
      ? "Compare with the first run on report_url."
      : "To measure the trap card on this agent, call gauntlet_start with card_from set to this gauntlet_id: six new variants with the card at the top of every brief.",
  };
}

const safeParse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export async function gauntletRun(db: Db, id: string) {
  const [g] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, id));
  if (!g) return null;
  const bouts = await db.select().from(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, id)).orderBy(asc(t.arenaGauntletBouts.idx));
  const parent = g.cardFrom ? ((await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, g.cardFrom)))[0] ?? null) : null;
  const [rerun] = g.cardFrom
    ? []
    : await db
        .select()
        .from(t.arenaGauntlets)
        .where(and(eq(t.arenaGauntlets.cardFrom, id), eq(t.arenaGauntlets.status, "done")))
        .orderBy(asc(t.arenaGauntlets.finishedAt))
        .limit(1);
  return { g, bouts, parent, rerun: rerun ?? null };
}

/** Hourly: deletes tool calls and logs older than GAUNTLET_KEEP_LOGS_MS. The per-job summary stays. */
export async function sweepGauntletLogs(env: Env, now = Date.now()) {
  const res = await getDb(env)
    .update(t.arenaGauntletBouts)
    .set({ calls: [], log: null })
    .where(and(lt(t.arenaGauntletBouts.startedAt, now - GAUNTLET_KEEP_LOGS_MS), sql`(${t.arenaGauntletBouts.log} is not null or ${t.arenaGauntletBouts.calls} != '[]')`));
  return { cleared: res.meta?.changes ?? 0 };
}
