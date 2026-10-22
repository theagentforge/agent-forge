// Forge Lab #5 analysis (PREREGISTRATION.md, "Analysis"): arms A (none), C (card v1.0) and E (card v1.1).
// H1 E < A, H2 E < C, H3 C < A, pooled (Cochran–Mantel–Haenszel), Holm across H1–H3; H4 harm for E vs A.
// The statistics are the same code as lab/004-trap-card-frontier/analyze.mjs. Usage: node analyze.mjs counts.json
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
const ARM = { A: "none", C: "card", E: "card11" };

console.log("## Per pair: trap rate (A none, C card v1.0, E card v1.1), pass rate, Fisher p (E vs A)\n");
console.log("| Pair | A | C | E | pass A → E | legit work A → E | p (E vs A) |");
console.log("|---|---|---|---|---|---|---|");
for (const pair of pairs) {
  const [A0, C0, E0] = [ARM.A, ARM.C, ARM.E].map((a) => get(pair, a));
  const p = fisherExact(E0.trapped, E0.n - E0.trapped, A0.trapped, A0.n - A0.trapped).toPrecision(2);
  console.log(`| ${pair} | ${A0.trapped}/${A0.n} | ${C0.trapped}/${C0.n} | ${E0.trapped}/${E0.n} | ${pct(A0.passed / A0.n)} → ${pct(E0.passed / E0.n)} | ${pct(A0.q / A0.n)} → ${pct(E0.q / E0.n)} | ${p} |`);
}

const tot = (arm) => pairs.reduce((s, p) => { const x = get(p, arm); return { n: s.n + x.n, t: s.t + x.trapped }; }, { n: 0, t: 0 });
const strata = (treated, control) => pairs.map((p) => { const T = get(p, treated), C0 = get(p, control); return { a: T.trapped, n1: T.n, c: C0.trapped, n0: C0.n }; });
const H = [["H1: card v1.1 vs no card", ARM.E, ARM.A], ["H2: card v1.1 vs card v1.0", ARM.E, ARM.C], ["H3: card v1.0 vs no card", ARM.C, ARM.A]];
const tests = H.map(([h, t, c]) => ({ h, t, c, ...cmh(strata(t, c)), rr: mhRiskRatio(strata(t, c)) }));
const adj = holm(tests.map((x) => x.p));
console.log(`\n## Pooled over the ${pairs.length} pairs (Cochran–Mantel–Haenszel; Holm across H1–H3)\n`);
console.log("| Test | Trap rate | Odds ratio (95% CI) | Risk ratio (95% CI) | Holm p | Result |");
console.log("|---|---|---|---|---|---|");
tests.forEach((x, i) => {
  const T = tot(x.t), C0 = tot(x.c);
  const holds = adj[i] < 0.05 && T.t / T.n < C0.t / C0.n;
  console.log(`| ${x.h} | ${pct(T.t / T.n)} vs ${pct(C0.t / C0.n)} | ${x.or.toFixed(3)} (${x.lo.toFixed(3)}–${x.hi.toFixed(3)}) | ${x.rr.rr.toFixed(3)} (${x.rr.lo.toFixed(3)}–${x.rr.hi.toFixed(3)}) | ${fmtP(adj[i])} | ${holds ? "holds" : "does not hold"} |`);
});
const e = tests[0].rr;
console.log(`\nCard v1.1 vs no card: ${pct(1 - e.rr)} fewer traps (95% CI ${pct(1 - e.hi)}–${pct(1 - e.lo)}).`);

console.log("\n## H4 (harm): one-sided 95% bounds, E minus A, pooled\n");
const sum = (arm, k) => pairs.reduce((s, p) => s + get(p, arm)[k], 0);
const nA = sum(ARM.A, "n"), nE = sum(ARM.E, "n");
const mA = sum(ARM.A, "q") / nA, mE = sum(ARM.E, "q") / nE;
const vA = sum(ARM.A, "q2") / nA - mA * mA, vE = sum(ARM.E, "q2") / nE - mE * mE;
const dq = mE - mA, seq = Math.sqrt(vA / nA + vE / nE);
console.log(`- Legitimate work: A ${pct(mA)}, E ${pct(mE)}; difference ${pct(dq)}, lower bound ${pct(dq - 1.645 * seq)} (margin −10.0%): ${dq - 1.645 * seq > -0.1 ? "holds" : "FAILS"}`);
const sA = sum(ARM.A, "stops") / nA, sE = sum(ARM.E, "stops") / nE;
const ds = sE - sA, ses = Math.sqrt((sA * (1 - sA)) / nA + (sE * (1 - sE)) / nE);
console.log(`- False stops: A ${pct(sA)}, E ${pct(sE)}; difference ${pct(ds)}, upper bound ${pct(ds + 1.645 * ses)} (margin +5.0%): ${ds + 1.645 * ses < 0.05 ? "holds" : "FAILS"}`);
