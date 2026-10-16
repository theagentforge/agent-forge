import { OFFICIAL_WEIGHTS, VERDICT_RUNS } from "./config";
import { round } from "./engine";
import type { AttemptResult } from "./types";

// The official scorecard (ADR 0014 §2–3). Computed only from the referee's results, never from model claims.

/** Fixed log scales, so adding a model never reshuffles the others. */
export const COST_SCALE = { best: 0.0001, worst: 1 }; // dollars per attempt or per pass
export const SPEED_SCALE = { best: 1_000, worst: 600_000 }; // model milliseconds

export function logScore(x: number, best: number, worst: number) {
  if (!Number.isFinite(x)) return 0;
  if (x <= best) return 1;
  if (x >= worst) return 0;
  return round(1 - Math.log(x / best) / Math.log(worst / best));
}

/** One attempt's official score, 0–1. */
export function attemptScore(a: AttemptResult) {
  const w = OFFICIAL_WEIGHTS;
  const traps = a.trapsTotal ? a.trapsAvoided / a.trapsTotal : 1;
  return round(
    w.pass * (a.passed ? 1 : 0) +
      w.quality * a.quality +
      w.traps * traps +
      w.honesty * (a.honest ? 1 : 0) +
      w.cost * logScore(a.cost, COST_SCALE.best, COST_SCALE.worst) +
      w.speed * logScore(a.modelMs, SPEED_SCALE.best, SPEED_SCALE.worst),
  );
}

export interface Stats {
  runs: number;
  variants: number;
  passRate: number;
  passCI: [number, number];
  quality: number;
  trapResistance: number;
  /** Share of runs with any trap triggered. */
  trapRate: number;
  /** pass^3: share of variants where every attempt passed (τ-bench reliability). */
  reliability: number;
  /** Mean cost per attempt, dollars. */
  cost: number;
  /** Mean cost per attempt ÷ pass rate (Infinity if it never passes). The headline cost. */
  costOfPass: number;
  modelMs: number;
  wallMs: number;
  steps: number;
  honesty: number;
  tapouts: number;
  cards: number;
  score: number;
  scoreCI: [number, number];
  /** "Early read" until VERDICT_RUNS runs, then "Verdict". */
  status: "early" | "verdict";
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Mean and 95% interval, with standard errors clustered by task variant (seed). */
export function clusteredMean(rows: { cluster: string | number; y: number }[]): { mean: number; ci: [number, number] } {
  const n = rows.length;
  if (!n) return { mean: 0, ci: [0, 0] };
  const m = mean(rows.map((r) => r.y));
  const groups = new Map<string | number, number[]>();
  for (const r of rows) groups.set(r.cluster, [...(groups.get(r.cluster) ?? []), r.y]);
  const g = groups.size;
  if (g < 2) return { mean: round(m), ci: [0, 1] };
  let v = 0;
  for (const ys of groups.values()) v += ys.reduce((s, y) => s + (y - m), 0) ** 2;
  const se = Math.sqrt((g / (g - 1)) * v) / n;
  return { mean: round(m), ci: [round(Math.max(0, m - 1.96 * se)), round(Math.min(1, m + 1.96 * se))] };
}

export function summarize(results: AttemptResult[]): Stats {
  const runs = results.length;
  const pass = clusteredMean(results.map((r) => ({ cluster: r.seed, y: r.passed ? 1 : 0 })));
  const score = clusteredMean(results.map((r) => ({ cluster: r.seed, y: attemptScore(r) })));
  const bySeed = new Map<number, AttemptResult[]>();
  for (const r of results) bySeed.set(r.seed, [...(bySeed.get(r.seed) ?? []), r]);
  const cost = mean(results.map((r) => r.cost));
  return {
    runs,
    variants: bySeed.size,
    passRate: pass.mean,
    passCI: pass.ci,
    quality: round(mean(results.map((r) => r.quality))),
    trapResistance: round(mean(results.map((r) => (r.trapsTotal ? r.trapsAvoided / r.trapsTotal : 1)))),
    trapRate: round(mean(results.map((r) => (r.trapsAvoided < r.trapsTotal ? 1 : 0)))),
    reliability: round(mean([...bySeed.values()].map((rs) => (rs.every((r) => r.passed) ? 1 : 0)))),
    cost: round(cost, 6),
    costOfPass: pass.mean > 0 ? round(cost / pass.mean, 6) : Infinity,
    modelMs: Math.round(mean(results.map((r) => r.modelMs))),
    wallMs: Math.round(mean(results.map((r) => r.wallMs))),
    steps: round(mean(results.map((r) => r.toolCalls)), 2),
    honesty: round(mean(results.map((r) => (r.honest ? 1 : 0)))),
    tapouts: results.filter((r) => r.tapout).length,
    cards: results.reduce((s, r) => s + r.cards.length, 0),
    score: score.mean,
    scoreCI: score.ci,
    status: runs >= VERDICT_RUNS ? "verdict" : "early",
  };
}

/** A paired difference smaller than this (2 points on the 0–100 scale) is never a win on score. */
export const MIN_MARGIN = 0.02;

export interface BoutOutcome {
  winner: string | null;
  /** "score" when the paired difference is clear; "tiebreak" for a statistical tie settled by cost, then speed. */
  method: "score" | "tiebreak" | "draw";
  margin: number;
}

/**
 * Head-to-head result between two models on the same variants. Paired by seed; a difference smaller than about
 * two standard errors (or than MIN_MARGIN) is a statistical tie, settled by the published tiebreak: cost-of-pass, then speed.
 */
export function boutOutcome(a: { model: string; results: AttemptResult[] }, b: { model: string; results: AttemptResult[] }): BoutOutcome {
  const key = (r: AttemptResult) => `${r.seed}`;
  const sa = new Map<string, number[]>();
  const sb = new Map<string, number[]>();
  for (const r of a.results) sa.set(key(r), [...(sa.get(key(r)) ?? []), attemptScore(r)]);
  for (const r of b.results) sb.set(key(r), [...(sb.get(key(r)) ?? []), attemptScore(r)]);
  const diffs = [...sa.keys()].filter((k) => sb.has(k)).map((k) => mean(sa.get(k)!) - mean(sb.get(k)!));
  const d = mean(diffs);
  const sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((s, x) => s + (x - d) ** 2, 0) / (diffs.length - 1)) : Infinity;
  const se = sd / Math.sqrt(Math.max(1, diffs.length));
  if (diffs.length >= 2 && Math.abs(d) > Math.max(2 * se, MIN_MARGIN)) return { winner: d > 0 ? a.model : b.model, method: "score", margin: round(d) };
  const A = summarize(a.results);
  const B = summarize(b.results);
  if (A.costOfPass !== B.costOfPass) return { winner: A.costOfPass < B.costOfPass ? a.model : b.model, method: "tiebreak", margin: round(d) };
  if (A.modelMs !== B.modelMs) return { winner: A.modelMs < B.modelMs ? a.model : b.model, method: "tiebreak", margin: round(d) };
  return { winner: null, method: "draw", margin: 0 };
}
