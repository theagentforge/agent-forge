import { wilsonInterval } from "@forge/arena";

// Lab #6 statistics (ADR 0054; lab/006-referee-and-scanner-audit/PREREGISTRATION.md "Analysis"). Pure functions, no D1:
// the admin page and the public results page call them on the same rows, and lab/006/analyze.mjs repeats them offline.

export type Interval = [number, number];

export interface Proportion {
  /** Successes and trials as counted (unweighted). */
  k: number;
  n: number;
  /** The estimate: weighted back to the frame when frame counts are given, else k / n. Null when n is 0. */
  p: number | null;
  /** 95% Wilson interval; for a weighted estimate, on Kish's effective sample size. Null when n is 0. */
  ci: Interval | null;
  /** Kish effective sample size (= n when unweighted). */
  nEff: number;
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export function proportion(k: number, n: number): Proportion {
  return { k, n, p: n ? round(k / n) : null, ci: n ? wilsonInterval(k, n) : null, nEff: n };
}

/**
 * A stratified proportion: each stratum's share of the frame (`frame[h]`) weights its own sample mean, so strata drawn
 * at a higher rate than the frame (rare cells, small models) don't tilt the estimate. The interval is Wilson's on
 * Kish's effective sample size, (Σw)² / Σw², with w the weight of each labelled item.
 *
 * Items may name their design cell (`cell`; frame keys are "<cell>|<sub>"). Then the estimate is two-level, as the
 * draw is: a cell counts by its whole frame size N_c, and inside it the strata that have a labelled item stand for the
 * cell's strata that have none (the round-robin draw reaches only some sub-strata when there are more than the quota).
 * Each item's weight is w = (N_c / C_c) · (N_h / n_h), C_c being the frame size of the cell's labelled strata. Without
 * cells, unlabelled strata simply get no weight. `coverage` is the share of the frame in strata with a labelled item.
 */
export function stratified(items: { stratum: string; y: boolean; cell?: string }[], frame: Record<string, number>): Proportion & { coverage: number | null } {
  const by = new Map<string, { n: number; k: number; cell: string }>();
  for (const it of items) {
    const s = by.get(it.stratum) ?? { n: 0, k: 0, cell: it.cell ?? "" };
    s.n++;
    if (it.y) s.k++;
    by.set(it.stratum, s);
  }
  const k = items.filter((i) => i.y).length;
  const n = items.length;
  const total = Object.values(frame).reduce((a, b) => a + b, 0);
  // Per cell: its frame size, and the frame size of its strata that have a label.
  const cellN = new Map<string, number>();
  const cellC = new Map<string, number>();
  for (const [h, s] of by) {
    const N = frame[h] ?? 0;
    if (!N) continue;
    cellC.set(s.cell, (cellC.get(s.cell) ?? 0) + N);
    if (!cellN.has(s.cell)) cellN.set(s.cell, s.cell ? Object.entries(frame).reduce((a, [key, v]) => (key.startsWith(`${s.cell}|`) ? a + v : a), 0) : 0);
  }
  let covered = 0;
  let est = 0;
  let sw = 0;
  let sw2 = 0;
  for (const [h, s] of by) {
    const N = frame[h] ?? 0;
    if (!N || !s.n) continue;
    covered += N;
    const C = cellC.get(s.cell)!;
    const scale = s.cell ? Math.max(cellN.get(s.cell)!, C) / C : 1;
    const w = (scale * N) / s.n;
    est += w * s.k;
    sw += w * s.n;
    sw2 += w * w * s.n;
  }
  if (!covered || !n) return { k, n, p: null, ci: null, nEff: 0, coverage: total ? 0 : null };
  const p = est / sw;
  const nEff = (sw * sw) / sw2;
  return { k, n, p: round(p), ci: wilsonInterval(p * nEff, nEff), nEff: round(nEff, 1), coverage: round(covered / total) };
}

/** Cohen's kappa for two raters over the same items (categories are any strings). Null with fewer than 2 items. */
export function cohenKappa(pairs: [string, string][]): { kappa: number | null; n: number; observed: number | null } {
  const n = pairs.length;
  if (n < 2) return { kappa: null, n, observed: null };
  const cats = [...new Set(pairs.flat())];
  const po = pairs.filter(([a, b]) => a === b).length / n;
  let pe = 0;
  for (const c of cats) pe += (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n);
  const kappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { kappa: round(kappa, 3), n, observed: round(po) };
}

/** A confusion matrix: rows (the human's answers) × columns (the machine's), counts only. */
export function confusion(pairs: { human: string; machine: string }[], rows: string[], cols: string[]) {
  const m: Record<string, Record<string, number>> = {};
  for (const r of rows) m[r] = Object.fromEntries(cols.map((c) => [c, 0]));
  for (const p of pairs) if (m[p.human] && p.machine in m[p.human]!) m[p.human]![p.machine]!++;
  return { rows, cols, counts: m };
}

/** What a pre-registered threshold hypothesis says, fixed in PREREGISTRATION.md "Hypotheses". */
export type HypothesisStatus = "not_yet_measured" | "met" | "consistent_not_shown" | "not_met";

/** The primary reading (pre-registration amendment 2): met when the estimate reaches the bar and the lower 95% bound the floor. */
export type Verdict = "not_yet_measured" | "met" | "not_met";

export function judgeMet(est: Proportion, bar: number, floor: number, complete: boolean): Verdict {
  if (!complete || est.p === null || !est.ci) return "not_yet_measured";
  return est.p >= bar && est.ci[0] >= floor ? "met" : "not_met";
}

/** The original, strict reading (now a reported secondary). Met: the interval's lower bound clears the bar. Consistent: the estimate does but the lower bound doesn't. */
export function judge(est: Proportion, bar: number, complete: boolean): HypothesisStatus {
  if (!complete || est.p === null || !est.ci) return "not_yet_measured";
  if (est.ci[0] >= bar) return "met";
  return est.p >= bar ? "consistent_not_shown" : "not_met";
}

// --- Recall (scanner) ------------------------------------------------------------------------------------------
// Recall needs the risky skills the scanner called clear, which only the clear sample can show. With the verdict
// groups' frame sizes N and risky shares p (flagged), q (caution) and m (clear):
//   recall(flagged)            = N_f·p / (N_f·p + N_c·q + N_cl·m)
//   recall(flagged or caution) = (N_f·p + N_c·q) / (N_f·p + N_c·q + N_cl·m)
// The interval is a seeded simulation: each share is drawn from its Jeffreys posterior, Beta(x + ½, n − x + ½), on the
// group's effective sample size, 10,000 times; the median is the estimate and the 2.5th and 97.5th percentiles the
// interval.

/** mulberry32: a small seeded generator, so the interval is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Marsaglia–Tsang gamma sampler (shape ≥ 1, boosted for shape < 1). */
function gamma(shape: number, r: () => number): number {
  if (shape < 1) return gamma(shape + 1, r) * Math.pow(Math.max(r(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

const beta = (a: number, b: number, r: () => number) => {
  const x = gamma(a, r);
  return x / (x + gamma(b, r));
};

export interface Group {
  /** Frame size of the verdict group. */
  N: number;
  /** Weighted risky share and its effective sample size (from `stratified`). */
  p: number | null;
  nEff: number;
}

export function recall(groups: { flagged: Group; caution: Group; clear: Group }, opts: { draws?: number; seed?: number } = {}) {
  const { flagged: f, caution: c, clear: cl } = groups;
  if (f.p === null || c.p === null || cl.p === null || !f.nEff || !c.nEff || !cl.nEff) return { flagged: null, flaggedOrCaution: null };
  const calc = (pf: number, pc: number, m: number) => {
    const all = f.N * pf + c.N * pc + cl.N * m;
    return all > 0 ? { flagged: (f.N * pf) / all, either: (f.N * pf + c.N * pc) / all } : { flagged: 1, either: 1 };
  };
  const point = calc(f.p, c.p, cl.p);
  const r = rng(opts.seed ?? 6006);
  const draws = opts.draws ?? 10_000;
  const a: number[] = [];
  const b: number[] = [];
  const post = (g: Group) => beta(g.p! * g.nEff + 0.5, (1 - g.p!) * g.nEff + 0.5, r);
  for (let i = 0; i < draws; i++) {
    const x = calc(post(f), post(c), post(cl));
    a.push(x.flagged);
    b.push(x.either);
  }
  const pct = (xs: number[], q: number) => xs.sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  // The estimate is the simulation's median, so it always sits inside its interval. The plug-in value (shares as
  // measured) is kept too: with no risky clear skill seen it overstates recall, which the interval shows.
  return {
    flagged: { p: round(pct(a, 0.5)), ci: [round(pct(a, 0.025)), round(pct(a, 0.975))] as Interval, plugIn: round(point.flagged) },
    flaggedOrCaution: { p: round(pct(b, 0.5)), ci: [round(pct(b, 0.025)), round(pct(b, 0.975))] as Interval, plugIn: round(point.either) },
  };
}
