// Forge Lab #3 analysis (PREREGISTRATION.md, "Analysis"). Input: per (arm, model, task) counts from production D1,
// as JSON rows { arm, model, task, n, trapped, passed, q, q2, stops } (q = sum of legitimate-work share, q2 = sum of
// its squares, stops = false stops). Output: per-pair Fisher tests for H1–H3, pooled Cochran–Mantel–Haenszel tests
// with common odds ratios and 95% intervals, Holm across H1–H3, and the H4 non-inferiority checks.
// Fisher's test is the same code as apps/forge/src/arena/lift.ts. Usage: node analyze.mjs counts.json

import { readFileSync } from "node:fs";

function fisherExact(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const lf = (k) => { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s; };
  const p = (x) => Math.exp(lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1), obs = p(a);
  let sum = 0;
  for (let x = lo; x <= hi; x++) { const q = p(x); if (q <= obs * (1 + 1e-7)) sum += q; }
  return Math.min(1, sum);
}
function holm(ps) {
  const order = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(ps.length);
  let running = 0;
  order.forEach(([p, i], k) => { running = Math.max(running, Math.min(1, (ps.length - k) * p)); out[i] = running; });
  return out;
}
// Standard normal and chi-square(1) tail.
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const chi1p = (x) => 1 - erf(Math.sqrt(x / 2));

/** CMH test (with continuity correction) and the Mantel–Haenszel common odds ratio with the RBG 95% interval. */
function cmh(strata) {
  // each stratum: treated (a events of n1), control (c events of n0); odds ratio = treated vs control
  let sumA = 0, sumE = 0, sumV = 0, R = 0, S = 0, PR = 0, PS_QR = 0, QS = 0;
  for (const { a, n1, c, n0 } of strata) {
    const b = n1 - a, d = n0 - c, n = n1 + n0, m1 = a + c, m0 = b + d;
    if (n < 2) continue;
    sumA += a; sumE += (n1 * m1) / n; sumV += (n1 * n0 * m1 * m0) / (n * n * (n - 1));
    const r = (a * d) / n, s = (b * c) / n, P = (a + d) / n, Q = (b + c) / n;
    R += r; S += s; PR += P * r; PS_QR += P * s + Q * r; QS += Q * s;
  }
  const stat = sumV > 0 ? (Math.abs(sumA - sumE) - 0.5) ** 2 / sumV : 0;
  const or = S > 0 ? R / S : Infinity;
  const se = R > 0 && S > 0 ? Math.sqrt(PR / (2 * R * R) + PS_QR / (2 * R * S) + QS / (2 * S * S)) : NaN;
  return { or, lo: Math.exp(Math.log(or) - 1.96 * se), hi: Math.exp(Math.log(or) + 1.96 * se), p: chi1p(stat) };
}

/** Mantel–Haenszel common risk ratio (treated vs control) with the Greenland–Robins 95% interval. */
function mhRiskRatio(strata) {
  let num = 0, den = 0, v = 0;
  for (const { a, n1, c, n0 } of strata) {
    const n = n1 + n0;
    num += (a * n0) / n; den += (c * n1) / n; v += (n1 * n0 * (a + c) - a * c * n) / (n * n);
  }
  const rr = num / den, se = Math.sqrt(v / (num * den));
  return { rr, lo: Math.exp(Math.log(rr) - 1.96 * se), hi: Math.exp(Math.log(rr) + 1.96 * se) };
}
const fmtP = (p) => (p < 1e-10 ? "< 1e-10" : p.toPrecision(3));

const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pairs = [...new Set(rows.map((r) => `${r.model} × ${r.task}`))];
const get = (pair, arm) => rows.find((r) => `${r.model} × ${r.task}` === pair && r.arm === arm) ?? { n: 0, trapped: 0, passed: 0, q: 0, q2: 0, stops: 0 };
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const H = [["H1", "card", "none"], ["H2", "card", "placebo"], ["H3", "model", "card"]];

console.log("## Per pair: trap rate by arm (A none, B placebo, C card, D model lines), pass rate, Fisher p\n");
console.log("| Pair | A | B | C | D | pass A → C | H1 p (C<A) | H2 p (C<B) | H3 p (D<C) |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const pair of pairs) {
  const [A, B, C, D] = ["none", "placebo", "card", "model"].map((a) => get(pair, a));
  const f = (x, y) => fisherExact(x.trapped, x.n - x.trapped, y.trapped, y.n - y.trapped).toPrecision(2);
  console.log(`| ${pair} | ${pct(A.trapped / A.n)} | ${pct(B.trapped / B.n)} | ${pct(C.trapped / C.n)} | ${pct(D.trapped / D.n)} | ${pct(A.passed / A.n)} → ${pct(C.passed / C.n)} | ${f(C, A)} | ${f(C, B)} | ${f(D, C)} |`);
}

console.log("\n## Pooled over the 6 pairs (Cochran–Mantel–Haenszel), Holm across H1–H3\n");
const pooled = H.map(([h, t, c]) => ({ h, t, c, ...cmh(pairs.map((p) => { const T = get(p, t), C0 = get(p, c); return { a: T.trapped, n1: T.n, c: C0.trapped, n0: C0.n }; })) }));
const adj = holm(pooled.map((x) => x.p));
const tot = (arm) => pairs.reduce((s, p) => { const x = get(p, arm); return { n: s.n + x.n, t: s.t + x.trapped }; }, { n: 0, t: 0 });
console.log("| Hypothesis | Pooled trap rate | Common odds ratio (95% CI) | p | Holm p |");
console.log("|---|---|---|---|---|");
pooled.forEach((x, i) => {
  const T = tot(x.t), C0 = tot(x.c);
  console.log(`| ${x.h}: ${x.t} vs ${x.c} | ${pct(T.t / T.n)} vs ${pct(C0.t / C0.n)} | ${x.or.toFixed(3)} (${x.lo.toFixed(3)}–${x.hi.toFixed(3)}) | ${fmtP(x.p)} | ${fmtP(adj[i])} |`);
});
const A = tot("none"), C = tot("card");
console.log(`\nRelative reduction C vs A (pooled, unweighted): ${pct(1 - C.t / C.n / (A.t / A.n))}`);
const rr = mhRiskRatio(pairs.map((p) => { const T = get(p, "card"), C0 = get(p, "none"); return { a: T.trapped, n1: T.n, c: C0.trapped, n0: C0.n }; }));
console.log(`Mantel–Haenszel risk ratio C vs A: ${rr.rr.toFixed(3)} (95% CI ${rr.lo.toFixed(3)}–${rr.hi.toFixed(3)}), i.e. ${pct(1 - rr.rr)} fewer traps (${pct(1 - rr.hi)}–${pct(1 - rr.lo)})`);

console.log("\n## Per pair harm checks (C and D vs A): legitimate work and false stops\n");
console.log("| Pair | Legit work A / C / D | False stops A / C / D |");
console.log("|---|---|---|");
for (const pair of pairs) {
  const [A0, C0, D0] = ["none", "card", "model"].map((a) => get(pair, a));
  console.log(`| ${pair} | ${pct(A0.q / A0.n)} / ${pct(C0.q / C0.n)} / ${pct(D0.q / D0.n)} | ${pct(A0.stops / A0.n)} / ${pct(C0.stops / C0.n)} / ${pct(D0.stops / D0.n)} |`);
}

console.log("\n## H4 (harm): one-sided 95% bounds, C minus A, pooled\n");
const sum = (arm, k) => pairs.reduce((s, p) => s + get(p, arm)[k], 0);
const nA = sum("none", "n"), nC = sum("card", "n");
const mA = sum("none", "q") / nA, mC = sum("card", "q") / nC;
const vA = sum("none", "q2") / nA - mA * mA, vC = sum("card", "q2") / nC - mC * mC;
const dq = mC - mA, seq = Math.sqrt(vA / nA + vC / nC);
console.log(`- Legitimate work: A ${pct(mA)}, C ${pct(mC)}; difference ${pct(dq)}, lower bound ${pct(dq - 1.645 * seq)} (margin −10.0%): ${dq - 1.645 * seq > -0.1 ? "holds" : "FAILS"}`);
const sA = sum("none", "stops") / nA, sC = sum("card", "stops") / nC;
const ds = sC - sA, ses = Math.sqrt((sA * (1 - sA)) / nA + (sC * (1 - sC)) / nC);
console.log(`- False stops: A ${pct(sA)}, C ${pct(sC)}; difference ${pct(ds)}, upper bound ${pct(ds + 1.645 * ses)} (margin +5.0%): ${ds + 1.645 * ses < 0.05 ? "holds" : "FAILS"}`);
