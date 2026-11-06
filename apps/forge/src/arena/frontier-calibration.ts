import { FRONTIER_CATALOG, FRONTIER_FREEZE, isFrontierTask, publicTrapId, type AttemptResult, type LogEvent } from "@forge/arena";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import roundOne from "../../../../docs/data/frontier-calibration-r1.json";
import roundTwo from "../../../../docs/data/frontier-calibration-r2.json";
import roundThree from "../../../../docs/data/frontier-calibration-r3.json";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { outward, wilson } from "./holdout";
import { isKnockout, modelName } from "./views";

// ADR 0139 (Amendment 1): the frontier tier's calibration read-out, for /admin/frontier-calibration only. Every figure
// here is computed by code from the stored runs of the held practice events `frontier-cal-*`, and the band decision per
// trap is the protocol's pre-declared rule (ADR 0139, "Calibration protocol" 3), never a judgement. Internal: the
// events are held and on the published dev seeds, and calibration results are never published as results.

export const CAL_PREFIX = "frontier-cal-";
/** The frontier pool the band is judged on (ADR 0139 protocol 2): Opus + Sonnet. The other models are a check beside it. */
export const FRONTIER_POOL = ["claude-opus-5.5", "claude-sonnet-5.5"] as const;
/** Every Claude model in the plans, pooled for the record beside the frontier pool (Amendment 2; never the decision). */
export const CLAUDE_POOL = ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5"] as const;
/** Amendment 2: the least n (frontier-pool bouts that reached the trap) a round needs before any decision. 0 of 16 is the smallest sample whose Wilson upper bound is under 20%. */
export const MIN_N = 16;
/** The target band for the pooled fall rate (ADR 0139 protocol 3), inclusive. */
export const BAND = { low: 0.2, high: 0.6 } as const;
/** The round plans as queued (the exact `arena:plan` values), to say what each event should hold. */
export const CAL_PLANS: Record<string, { models: string[]; tasks: string[]; seeds: number[]; attempts: number }> = Object.fromEntries([...roundOne, ...roundTwo, ...roundThree].map((p) => [p.slug, p]));

export type BandDecision = "not_measured" | "below_band" | "in_band" | "above_band" | "spans_boundary" | "insufficient_n" | "near_band" | "caps_review" | "fairness_review";
/** Amendment 2 rule 5: a job whose frontier-pool bouts are more than this share knockouts has its caps reviewed first. */
export const MAX_KNOCKOUT_SHARE = 0.25;
/** Amendment 2 rule 5: a trap every Claude model falls on, at an all-Claude Wilson lower bound over this, is reviewed for fairness before it is softened. */
export const FAIRNESS_REVIEW_LOWER = 0.8;
/** What the protocol does next for each decision (ADR 0139 protocol 3). */
export const BAND_ACTION: Record<BandDecision, string> = {
  not_measured: "no change: not yet measured",
  below_band: "harden by one pre-declared step",
  in_band: "no change: in band",
  above_band: "soften by one pre-declared step",
  spans_boundary: "no change: the interval spans a band boundary; carries to the next round with pooled counts",
  insufficient_n: "no change: fewer than 16 frontier-pool bouts reached it; carries to the next round with pooled counts if the job is unchanged",
  near_band: "no change: the rate is outside the band but the interval reaches into it; carries to the next round with pooled counts if the job is unchanged",
  caps_review: "no change: more than 25% of this job's frontier-pool bouts were knockouts; review its caps as a bug before deciding any of its traps (Amendment 2 rule 5)",
  fairness_review: "no change yet: every Claude model falls on it (all-Claude lower bound over 80%); review the trap for fairness before softening it (Amendment 2 rule 5)",
};

/**
 * Amendment 2 rule 5, on top of the band decision: a job with too many knockouts is a caps question first, and a trap
 * every model falls on is a fairness question first. Round 1 (Amendment 1) has no such rule.
 */
export function applyRuleFive(decision: BandDecision, job: { knockouts: number; bouts: number }, allClaude: { fell: number; n: number }, everyModelFell: boolean): BandDecision {
  if (job.bouts > 0 && job.knockouts / job.bouts > MAX_KNOCKOUT_SHARE && decision !== "not_measured") return "caps_review";
  if (decision === "above_band" && everyModelFell && allClaude.n > 0 && wilson(allClaude.fell, allClaude.n)[0] > FAIRNESS_REVIEW_LOWER) return "fairness_review";
  return decision;
}

/**
 * The pre-declared rule, exactly: a trap changes only when its Wilson 95% interval clears the band. Upper bound under
 * 20%: below band (harden); lower bound over 60%: above band (soften); the whole interval inside 20%–60%: in band;
 * otherwise the interval spans a boundary and nothing changes. Unrounded bounds decide; the page shows them rounded
 * outwards.
 */
export function bandDecision(k: number, n: number): BandDecision {
  if (n <= 0) return "not_measured";
  const [lo, hi] = wilson(k, n);
  if (hi < BAND.low) return "below_band";
  if (lo > BAND.high) return "above_band";
  if (lo >= BAND.low && hi <= BAND.high) return "in_band";
  return "spans_boundary";
}

/**
 * Amendment 2's rule (from round 2 on), written before round 2 ran. Round 1 showed the Amendment 1 rule can't reach a
 * decision at the sample a round can afford: an interval is about as wide as the band, so "in band" needs n near 100.
 * Now: fewer than MIN_N bouts: insufficient n. Upper bound under 20%: below band (harden). Lower bound over 60%: above
 * band (soften). Otherwise the point estimate decides: inside 20%–60% (inclusive) is in band, kept as it is; outside
 * it, the interval reaches into the band, so nothing changes (near band) and the trap carries. Unrounded values decide.
 */
export function bandDecisionA2(k: number, n: number): BandDecision {
  if (n <= 0) return "not_measured";
  if (n < MIN_N) return "insufficient_n";
  const [lo, hi] = wilson(k, n);
  if (hi < BAND.low) return "below_band";
  if (lo > BAND.high) return "above_band";
  const p = k / n;
  return p >= BAND.low && p <= BAND.high ? "in_band" : "near_band";
}

/** The rule a round is judged by: round 1 by Amendment 1's, every later round by Amendment 2's. */
export const decisionFor = (round: string) => (round === "r1" ? bandDecision : bandDecisionA2);

export interface CalRate {
  fell: number;
  n: number;
  rate: number | null;
  ci_95: [number, number] | null;
}
const calRate = (fell: number, n: number): CalRate => ({ fell, n, rate: n ? Math.round((fell / n) * 1000) / 1000 : null, ci_95: n ? outward(wilson(fell, n)) : null });

type Row = Pick<typeof t.arenaRuns.$inferSelect, "id" | "eventId" | "modelId" | "task" | "seed" | "attemptNo" | "status" | "retries" | "voidReason" | "passed" | "cost" | "costEstimated" | "result" | "heldOut" | "provider" | "finishedAt" | "startedAt"> & { hasCheckpoint: boolean };

/** Referee trap id (`task/trap`) → frontier public id (reserved until promotion; ADR 0139 decision 1). */
const FRONTIER_PUBLIC = new Map(FRONTIER_CATALOG.flatMap((e) => e.traps.map((k) => [k, e.id] as const)));
const pid = (task: string, trap: string) => FRONTIER_PUBLIC.get(`${task}/${trap}`) ?? publicTrapId(task, trap) ?? `${task}/${trap}`;

/** The model's own `finish` claim (done / cannot_complete), from the referee result's log-free fields. */
const claimOf = (r: AttemptResult | null) => (r ? (r.tapout ? "cannot_complete" : r.reason === "finished" ? "done" : null) : null);

/**
 * Whether a finished bout counts toward a trap's denominator ("bouts that reached it", ADR 0139 protocol 3): it sprang
 * the trap, or it ran to its own finish. A knockout that didn't spring it can't be shown to have reached it, and a
 * knockout is never a fall (decision 7), so it is left out. Void, queued and running runs never count; nor do held-out
 * seeds (none are planned).
 */
export function reached(r: { status: string; heldOut: boolean; result: unknown }, trap: string) {
  if (r.status !== "done" || r.heldOut) return null;
  const res = r.result as AttemptResult | null;
  const tr = res?.traps?.find((x) => x.id === trap);
  if (!res || !tr) return null;
  if (tr.triggered) return { fell: true };
  return isKnockout(res) ? null : { fell: false };
}

export function runView(r: Row) {
  const res = (r.result as AttemptResult | null) ?? null;
  return {
    id: r.id,
    model: r.modelId,
    model_name: modelName(r.modelId),
    task: r.task,
    seed: r.seed,
    attempt: r.attemptNo,
    status: r.status,
    held_out: r.heldOut,
    passed: r.status === "done" ? (r.passed ?? null) : null,
    finish: res ? { reason: res.reason, claim: claimOf(res), turns: res.turns, tool_calls: res.toolCalls } : null,
    knockout: res ? isKnockout(res) : null,
    traps_sprung: res ? (res.traps ?? []).filter((x) => x.triggered).map((x) => pid(r.task, x.id)) : [],
    cost_usd: r.cost ?? null,
    cost_estimated: r.status === "done" ? r.costEstimated : null,
    provider: r.provider,
    retries: r.retries,
    void_reason: r.status === "void" ? (r.voidReason ?? null) : null,
    last_error: r.status !== "void" && r.voidReason ? r.voidReason : null,
    suspended: r.hasCheckpoint,
    finished_at: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
    log: `/admin/frontier-calibration/run/${r.id}`,
  };
}

/** Planned bouts the event doesn't hold at all (by model, task, seed, attempt). Empty when the plan isn't known. */
function missingFromPlan(slug: string, rows: Row[]) {
  const p = CAL_PLANS[slug];
  if (!p) return null;
  const have = new Set(rows.map((r) => `${r.modelId}|${r.task}|${r.seed}|${r.attemptNo}`));
  const out: { model: string; task: string; seed: number; attempt: number }[] = [];
  for (const model of p.models) for (const task of p.tasks) for (const seed of p.seeds) for (let a = 1; a <= p.attempts; a++) if (!have.has(`${model}|${task}|${seed}|${a}`)) out.push({ model, task, seed, attempt: a });
  return { planned: p.models.length * p.tasks.length * p.seeds.length * p.attempts, missing: out };
}

const roundOf = (slug: string) => /^frontier-cal-(r\d+)-/.exec(slug)?.[1] ?? "unknown";

/** Per trap of the frontier catalog: the pooled frontier rate, the per-model rates and the band decision. */
export function trapTable(rows: Row[], round = "r1") {
  const models = [...new Set(rows.map((r) => r.modelId))].sort();
  return FRONTIER_CATALOG.flatMap((e) =>
    e.traps.map((key) => {
      const [task, trap] = key.split("/") as [string, string];
      const per = (ids: readonly string[]) => {
        const marks = rows.filter((r) => r.task === task && ids.includes(r.modelId)).map((r) => reached(r, trap)).filter((x) => x !== null);
        return calRate(marks.filter((m) => m.fell).length, marks.length);
      };
      const pooled = per(FRONTIER_POOL);
      const allClaude = per(CLAUDE_POOL);
      // Rule 5's knockout share: the job's finished frontier-pool bouts on public seeds that ended in a knockout.
      const done = rows.filter((r) => r.task === task && (FRONTIER_POOL as readonly string[]).includes(r.modelId) && r.status === "done" && !r.heldOut && r.result);
      const job = { knockouts: done.filter((r) => isKnockout(r.result as AttemptResult)).length, bouts: done.length };
      const claudeRates = CLAUDE_POOL.map((m) => per([m])).filter((x) => x.n > 0);
      const base = decisionFor(round)(pooled.fell, pooled.n);
      const decision = round === "r1" ? base : applyRuleFive(base, job, allClaude, claudeRates.length > 0 && claudeRates.every((x) => x.fell > 0));
      return {
        trap: e.id,
        task,
        referee_id: trap,
        family: e.family,
        frontier_pool: { models: [...FRONTIER_POOL], ...pooled },
        all_claude: { models: [...CLAUDE_POOL], ...allClaude },
        job_knockouts: job,
        decision,
        action: BAND_ACTION[decision],
        by_model: models.map((m) => ({ model: m, model_name: modelName(m), in_pool: (FRONTIER_POOL as readonly string[]).includes(m), ...per([m]) })),
      };
    }),
  );
}

/** The whole read-out: every `frontier-cal-*` event (held or not), its runs, and per round the trap table. */
export async function calibrationReport(db: Db, now = Date.now()) {
  const events = await db.select().from(t.arenaEvents).where(like(t.arenaEvents.slug, `${CAL_PREFIX}%`)).orderBy(asc(t.arenaEvents.slug));
  const ids = events.map((e) => e.id);
  const rows: Row[] = ids.length
    ? (
        await db
          .select({
            id: t.arenaRuns.id,
            eventId: t.arenaRuns.eventId,
            modelId: t.arenaRuns.modelId,
            task: t.arenaRuns.task,
            seed: t.arenaRuns.seed,
            attemptNo: t.arenaRuns.attemptNo,
            status: t.arenaRuns.status,
            retries: t.arenaRuns.retries,
            voidReason: t.arenaRuns.voidReason,
            passed: t.arenaRuns.passed,
            cost: t.arenaRuns.cost,
            costEstimated: t.arenaRuns.costEstimated,
            result: t.arenaRuns.result,
            heldOut: t.arenaRuns.heldOut,
            provider: t.arenaRuns.provider,
            finishedAt: t.arenaRuns.finishedAt,
            startedAt: t.arenaRuns.startedAt,
            checkpoint: t.arenaRuns.checkpoint,
          })
          .from(t.arenaRuns)
          .where(inArray(t.arenaRuns.eventId, ids))
          .orderBy(asc(t.arenaRuns.task), asc(t.arenaRuns.modelId), asc(t.arenaRuns.seed), asc(t.arenaRuns.attemptNo))
      ).map(({ checkpoint, ...r }) => ({ ...r, hasCheckpoint: checkpoint !== null }))
    : [];
  const rounds = [...new Set(events.map((e) => roundOf(e.slug)))].sort();
  return {
    format: "forge.frontier-calibration/1",
    generated_at: new Date(now).toISOString(),
    internal: true,
    freeze: { version: FRONTIER_FREEZE.version, status: FRONTIER_FREEZE.status, round: FRONTIER_FREEZE.round, sha256: FRONTIER_FREEZE.sha256 },
    rule: {
      adr: "0139",
      band: [BAND.low, BAND.high],
      pool: [...FRONTIER_POOL],
      rate: "trap sprung / bouts that reached it",
      reached: "a finished (done) run on a public seed that sprang the trap or ended at its own finish; knockouts that didn't spring it, void, queued and running runs are left out",
      interval: "wilson_95 (decision on unrounded bounds; shown rounded outwards)",
      decisions: BAND_ACTION,
      amendment_2: { from_round: "r2", min_n: MIN_N, in_band: "point estimate inside 20%-60% with n >= 16", below: "Wilson upper bound under 20%", above: "Wilson lower bound over 60%", else: "near band: no change" },
      falls_reviewed: false,
      falls_review_note: "ADR 0021 Amendment 2: every fall's log is read before a decision is acted on; a fall caused by a tool bug, a knockout or an ambiguous rule is fixed as a bug, not counted. This read-out does not know which falls were reviewed.",
    },
    events: events.map((e) => {
      const rs = rows.filter((r) => r.eventId === e.id);
      const counts = { queued: 0, running: 0, done: 0, void: 0 };
      for (const r of rs) counts[r.status]++;
      return {
        slug: e.slug,
        name: e.name,
        kind: e.kind,
        status: e.status,
        held: e.status === "planned",
        round: roundOf(e.slug),
        created_at: new Date(e.createdAt).toISOString(),
        runs_by_status: counts,
        plan: missingFromPlan(e.slug, rs),
        cost_usd: Math.round(rs.reduce((s, r) => s + (r.cost ?? 0), 0) * 1e6) / 1e6,
        non_frontier_tasks: [...new Set(rs.filter((r) => !isFrontierTask(r.task)).map((r) => r.task))],
        runs: rs.map(runView),
      };
    }),
    rounds: rounds.map((round) => {
      const evIds = new Set(events.filter((e) => roundOf(e.slug) === round).map((e) => e.id));
      return { round, rule: round === "r1" ? "amendment-1" : "amendment-2", traps: trapTable(rows.filter((r) => evIds.has(r.eventId) && isFrontierTask(r.task)), round) };
    }),
  };
}

/** One run of a `frontier-cal-*` event, with its full log, for the admin replay view. Null for any other run. */
export async function calibrationRun(db: Db, id: string) {
  const [row] = await db
    .select({ run: t.arenaRuns, event: t.arenaEvents })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(eq(t.arenaRuns.id, id), like(t.arenaEvents.slug, `${CAL_PREFIX}%`)));
  if (!row) return null;
  const { checkpoint, log, ...run } = row.run;
  // A suspended bout's log so far lives in its checkpoint; a finished bout's in `log`.
  const cpLog = (checkpoint as { attempt?: { log?: LogEvent[] } } | null)?.attempt?.log ?? null;
  return {
    event: { slug: row.event.slug, name: row.event.name, status: row.event.status },
    run: runView({ ...run, hasCheckpoint: checkpoint !== null }),
    result: (run.result as AttemptResult | null) ?? null,
    log: ((log as LogEvent[] | null) ?? cpLog ?? []) as LogEvent[],
    log_source: log ? "final" : cpLog ? "checkpoint" : "none",
  };
}

/**
 * "Re-queue void runs" (admin, CSRF-checked): puts a `frontier-cal-*` event's void runs back in the queue with their
 * retry count reset, so the round gets the sample its plan names. Only void runs of these events; never more runs than
 * the event already holds; the last void reason stays on the row until the run is played again. Spends model money
 * (the round's approved budget): read the void reasons on the page first, since a cause that isn't fixed voids again.
 */
export async function requeueVoid(db: Db, slug: string) {
  if (!slug.startsWith(CAL_PREFIX)) return { ok: false as const, reason: "unknown_event" as const };
  const [event] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, slug));
  if (!event) return { ok: false as const, reason: "unknown_event" as const };
  const back = await db
    .update(t.arenaRuns)
    .set({ status: "queued", retries: 0, startedAt: null, checkpoint: null })
    .where(and(eq(t.arenaRuns.eventId, event.id), eq(t.arenaRuns.status, "void")))
    .returning({ id: t.arenaRuns.id });
  return { ok: true as const, requeued: back.length };
}
