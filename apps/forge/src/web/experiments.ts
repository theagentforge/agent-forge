import lab3Counts from "../../../../lab/003-trap-cards/counts.json";
import lab4Counts from "../../../../lab/004-trap-card-frontier/counts.json";
import { rulesVersionAt } from "@forge/arena";

// The trap card experiments (Boardy review item 3, W1.2): Forge Lab #3 (small open models) and Lab #4 (frontier
// models), summarised from the same counts.json files that /lab/3/results and /lab/4/results publish, with the same
// statistics as lab/00{3,4}-*/analyze.mjs (Mantel–Haenszel risk ratio with the Greenland–Robins interval; Cochran–
// Mantel–Haenszel test; Fisher's exact test). Nothing here is typed in except what can't be computed: the plain
// names, the dates the runs finished and the links. The two are always shown together, so a strong result on small
// models is never read as a result on frontier models.

export interface CountRow {
  arm: string;
  model: string;
  task: string;
  n: number;
  trapped: number;
  passed: number;
  q: number;
  q2: number;
  stops: number;
  cost: number;
}
interface Stratum {
  a: number;
  n1: number;
  c: number;
  n0: number;
}

/** Fisher's exact test, two-sided (as lab/003-trap-cards/analyze.mjs and arena/lift.ts). */
export function fisherExact(a: number, b: number, c: number, d: number) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const lf = (k: number) => { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s; };
  const p = (x: number) => Math.exp(lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1), obs = p(a);
  let sum = 0;
  for (let x = lo; x <= hi; x++) { const q = p(x); if (q <= obs * (1 + 1e-7)) sum += q; }
  return Math.min(1, sum);
}

const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const chi1p = (x: number) => 1 - erf(Math.sqrt(x / 2));

/** Cochran–Mantel–Haenszel test with continuity correction (treated vs control): the p-value. */
export function cmhP(strata: Stratum[]) {
  let sumA = 0, sumE = 0, sumV = 0;
  for (const { a, n1, c, n0 } of strata) {
    const n = n1 + n0, m1 = a + c, m0 = n - m1;
    if (n < 2) continue;
    sumA += a; sumE += (n1 * m1) / n; sumV += (n1 * n0 * m1 * m0) / (n * n * (n - 1));
  }
  return chi1p(sumV > 0 ? (Math.abs(sumA - sumE) - 0.5) ** 2 / sumV : 0);
}

/** Mantel–Haenszel common risk ratio (treated vs control) with the Greenland–Robins 95% interval. */
export function mhRiskRatio(strata: Stratum[]) {
  let num = 0, den = 0, v = 0;
  for (const { a, n1, c, n0 } of strata) {
    const n = n1 + n0;
    num += (a * n0) / n; den += (c * n1) / n; v += (n1 * n0 * (a + c) - a * c * n) / (n * n);
  }
  const rr = num / den, se = Math.sqrt(v / (num * den));
  return { rr, lo: Math.exp(Math.log(rr) - 1.96 * se), hi: Math.exp(Math.log(rr) + 1.96 * se) };
}

const pairsOf = (rows: CountRow[]) => [...new Set(rows.map((r) => `${r.model}\u0000${r.task}`))];
const cell = (rows: CountRow[], pair: string, arm: string) => rows.find((r) => `${r.model}\u0000${r.task}` === pair && r.arm === arm);
const total = (rows: CountRow[], arm: string) => rows.filter((r) => r.arm === arm).reduce((t, r) => ({ n: t.n + r.n, trapped: t.trapped + r.trapped }), { n: 0, trapped: 0 });

/** The card vs no-card comparison over every model–job pair, as the pre-registered analysis does it. */
export function summarise(rows: CountRow[]) {
  const pairs = pairsOf(rows).filter((p) => cell(rows, p, "card") && cell(rows, p, "none"));
  const strata = pairs.map((p) => { const T = cell(rows, p, "card")!, C = cell(rows, p, "none")!; return { a: T.trapped, n1: T.n, c: C.trapped, n0: C.n }; });
  const rr = mhRiskRatio(strata);
  const p = cmhP(strata);
  const arms = [...new Set(rows.map((r) => r.arm))];
  const rate = (arm: string) => { const t = total(rows, arm); return t.n ? t.trapped / t.n : null; };
  const placebo = arms.includes("placebo") ? { ...total(rows, "placebo"), rate: rate("placebo")! } : null;
  // A pair counts as a clear effect when the card cut traps significantly against no card and (where the experiment
  // had one) against the placebo text: the rule RESULTS.md uses for "3 of 6 pairs".
  const clear = pairs.filter((pair) => {
    const C = cell(rows, pair, "card")!, A = cell(rows, pair, "none")!, B = cell(rows, pair, "placebo");
    const beats = (x: CountRow) => C.trapped / C.n < x.trapped / x.n && fisherExact(C.trapped, C.n - C.trapped, x.trapped, x.n - x.trapped) < 0.05;
    return beats(A) && (!B || beats(B));
  }).length;
  return {
    pairs: pairs.length,
    models: new Set(rows.map((r) => r.model)).size,
    armsRun: arms.length,
    boutsTotal: rows.reduce((s, r) => s + r.n, 0),
    none: { ...total(rows, "none"), rate: rate("none")! },
    card: { ...total(rows, "card"), rate: rate("card")! },
    placebo,
    /** Relative reduction, card vs no card (1 − risk ratio), and its 95% interval (negative = more traps). */
    fewer: 1 - rr.rr,
    fewerLo: 1 - rr.hi,
    fewerHi: 1 - rr.lo,
    p,
    significant: p < 0.05 && rr.hi < 1,
    clearPairs: clear,
  };
}

export const EXPERIMENTS = [
  {
    id: "experiment-3",
    lab: 3,
    name: "Experiment 3: does the free trap card help small open models?",
    short: "Experiment 3",
    who: "small open models",
    date: "2026-10-18",
    /** When the runs started and finished (lab/003-trap-cards/RESULTS.md), and the rules that scored them (F-01). */
    run: { from: "2026-10-18T03:16:00Z", to: "2026-10-18T07:50:00Z" },
    rules: rulesVersionAt(Date.parse("2026-10-18T07:50:00Z"), null),
    plan: "/lab/3",
    results: "/lab/3/results",
    stats: summarise(lab3Counts as CountRow[]),
  },
  {
    id: "experiment-4",
    lab: 4,
    name: "Experiment 4: does it help frontier models?",
    short: "Experiment 4",
    who: "frontier models",
    date: "2026-10-21",
    run: { from: "2026-10-20T11:51:00Z", to: "2026-10-21T05:01:00Z" },
    rules: rulesVersionAt(Date.parse("2026-10-21T05:01:00Z"), null),
    plan: "/lab/4",
    results: "/lab/4/results",
    stats: summarise(lab4Counts as CountRow[]),
  },
] as const;
export type Experiment = (typeof EXPERIMENTS)[number];

/** Plain names for the Lab pages (/lab/3, /lab/3/results, /lab/4, /lab/4/results); the URLs stay as they are. */
export function experimentForPath(path: string) {
  return EXPERIMENTS.find((e) => path === e.plan || path === e.results) ?? null;
}

/** Whole percent; a negative interval end reads as "more". */
export const pct = (x: number) => Math.round(x * 100);
export const in100 = (x: { n: number; trapped: number }) => Math.round((x.trapped / x.n) * 100);
export const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export function intervalText(s: Experiment["stats"]) {
  const end = (x: number) => (x >= 0 ? `${pct(x)}% fewer` : `${pct(-x)}% more`);
  return s.fewerLo >= 0 ? `${pct(s.fewerLo)}–${pct(s.fewerHi)}% fewer` : `from ${end(s.fewerHi)} to ${end(s.fewerLo)}`;
}
export const pText = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(2)}`);

/** Both experiments as structured data (AGENTS.md rule 7), for the home page JSON twin and /trap-card.json. */
export function experimentsData() {
  return EXPERIMENTS.map((e) => {
    const s = e.stats;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return {
      id: e.id,
      name: e.name,
      models: e.who,
      finished: e.date,
      model_job_pairs: s.pairs,
      bouts: s.boutsTotal,
      bouts_per_arm: s.card.n,
      trap_rate: { none: r3(s.none.rate), ...(s.placebo ? { placebo: r3(s.placebo.rate) } : {}), card: r3(s.card.rate) },
      relative_reduction: r3(s.fewer),
      ci95: [r3(s.fewerLo), r3(s.fewerHi)],
      p: s.p < 0.001 ? "<0.001" : r3(s.p),
      statistically_significant: s.significant,
      rules_version: e.rules,
      plan: e.plan,
      results: e.results,
    };
  });
}
