// Forge Lab #1 analysis, as pre-registered (PREREGISTRATION.md "Hypotheses"):
// Fisher's exact test (two-sided) per comparison, Holm-adjusted across the four hypotheses, and risk differences
// with 95% Newcombe intervals. Reports automatic grades and hand-checked grades (results/NOTES.md) side by side.
// Usage: node analyze.mjs [--markdown]
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const CONDITIONS = ["A", "B", "C1", "C2", "D"];

export function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map((line) => {
    const cells = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) (cells.push(cur), (cur = ""));
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

/** Hand checks from NOTES.md: rows like "| 013 | other | honest | why |". */
export function parseHandChecks(md) {
  const out = new Map();
  for (const m of md.matchAll(/^\|\s*(\d{3})\s*\|\s*(cheated|honest|other)\s*\|\s*(cheated|honest|other)\s*\|/gm)) out.set(m[1], m[3]);
  return out;
}

const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
/** Two-sided Fisher's exact test for [[a, b], [c, d]] (sum of tables no more likely than the observed one). */
export function fisher(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const p = (x) => Math.exp(lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
  const obs = p(a);
  let total = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= obs * (1 + 1e-7)) total += px; }
  return Math.min(1, total);
}

/** Wilson 95% interval for k of n. */
export function wilson(k, n, z = 1.959964) {
  if (n === 0) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

/** Newcombe (method 10) 95% interval for the difference p1 - p2. */
export function newcombe(k1, n1, k2, n2) {
  const p1 = k1 / n1, p2 = k2 / n2, [l1, u1] = wilson(k1, n1), [l2, u2] = wilson(k2, n2);
  const diff = p1 - p2;
  return [diff, diff - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), diff + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)];
}

/** Holm step-down adjustment; returns adjusted p-values in input order. */
export function holm(ps) {
  const order = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(ps.length);
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, p * (ps.length - rank))); out[i] = running; });
  return out;
}

export function analyse(rows, hand) {
  const tally = (graded) => Object.fromEntries(CONDITIONS.map((c) => {
    const r = rows.filter((x) => x.condition === c);
    const g = (x) => (graded === "hand" ? hand.get(x.run) ?? x.outcome : x.outcome);
    return [c, { n: r.length, cheated: r.filter((x) => g(x) === "cheated").length, honest: r.filter((x) => g(x) === "honest").length, other: r.filter((x) => g(x) === "other").length }];
  }));
  const auto = tally("auto"), checked = tally("hand");
  const tests = [
    ["H1", "B", "A", "cheated"], ["H2", "C1", "A", "cheated"], ["H3", "C2", "C1", "cheated"], ["H4", "D", "A", "cheated"],
  ].map(([h, x, y, m]) => {
    const t = checked;
    const p = fisher(t[x][m], t[x].n - t[x][m], t[y][m], t[y].n - t[y][m]);
    const [diff, lo, hi] = newcombe(t[x][m], t[x].n, t[y][m], t[y].n);
    return { hypothesis: h, compare: `${x} vs ${y}`, measure: m, p, diff, lo, hi };
  });
  holm(tests.map((t) => t.p)).forEach((p, i) => (tests[i].pHolm = p));
  const h3honest = { ...checked.C2, otherBest: Math.max(...CONDITIONS.filter((c) => c !== "C2").map((c) => checked[c].honest / (checked[c].n || 1))) };
  return { auto, checked, tests, h3honest, total: rows.length };
}

const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}%` : "–");
export function markdown(r) {
  const lines = [`Runs analysed: **${r.total}**.`, "", "| Condition | Runs | Cheated | Honest (automatic) | Honest (hand-checked) | Other (hand-checked) | Cheating 95% CI |", "|---|---:|---:|---:|---:|---:|---|"];
  for (const c of CONDITIONS) {
    const a = r.auto[c], h = r.checked[c], [lo, hi] = wilson(h.cheated, h.n);
    lines.push(`| ${c} | ${h.n} | ${h.cheated} | ${a.honest} | ${h.honest} | ${h.other} | ${pct(lo * 1000, 1000)}–${pct(hi * 1000, 1000)} |`);
  }
  lines.push("", "| Hypothesis | Comparison | Difference in cheating rate (95% CI) | Fisher p | Holm p |", "|---|---|---|---:|---:|");
  for (const t of r.tests) lines.push(`| ${t.hypothesis} | ${t.compare} | ${(100 * t.diff).toFixed(1)} pts (${(100 * t.lo).toFixed(1)} to ${(100 * t.hi).toFixed(1)}) | ${t.p.toFixed(3)} | ${t.pHolm.toFixed(3)} |`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = parseCsv(readFileSync(`${here}results/runs.csv`, "utf8"));
  const hand = parseHandChecks(readFileSync(`${here}results/NOTES.md`, "utf8"));
  const r = analyse(rows, hand);
  console.log(process.argv.includes("--markdown") ? markdown(r) : JSON.stringify(r, null, 2));
}
