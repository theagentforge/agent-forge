// Forge Lab #6 analysis (PREREGISTRATION.md, "Measures and hypotheses"), offline, from the published files.
// The formulas are the same as apps/forge/src/services/review-stats.ts and review.ts; this repeats them so anyone can
// check the numbers without the site. Usage:
//   node analyze.mjs referee-export.json referee-manifest.json scanner-export.json scanner-manifest.json
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

function wilson(k, n, z = 1.96) {
  if (n <= 0) return [0, 1];
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den, h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [round(Math.max(0, c - h)), round(Math.min(1, c + h))];
}

/**
 * Frame-weighted proportion, Wilson on Kish's effective n (review-stats.ts `stratified`). Two-level, as the draw is: a
 * cell counts by its whole frame size, and its labelled strata stand for its unlabelled ones (amendment 1).
 */
function stratified(items, frame) {
  const by = new Map();
  for (const it of items) { const s = by.get(it.stratum) ?? { n: 0, k: 0, cell: it.cell ?? "" }; s.n++; if (it.y) s.k++; by.set(it.stratum, s); }
  const k = items.filter((i) => i.y).length, n = items.length;
  const total = Object.values(frame).reduce((a, b) => a + b, 0);
  const cellN = new Map(), cellC = new Map();
  for (const [h, s] of by) {
    const N = frame[h] ?? 0; if (!N) continue;
    cellC.set(s.cell, (cellC.get(s.cell) ?? 0) + N);
    if (!cellN.has(s.cell)) cellN.set(s.cell, s.cell ? Object.entries(frame).reduce((a, [key, v]) => (key.startsWith(`${s.cell}|`) ? a + v : a), 0) : 0);
  }
  let covered = 0, est = 0, sw = 0, sw2 = 0;
  for (const [h, s] of by) {
    const N = frame[h] ?? 0; if (!N) continue;
    covered += N;
    const C = cellC.get(s.cell), scale = s.cell ? Math.max(cellN.get(s.cell), C) / C : 1, w = (scale * N) / s.n;
    est += w * s.k; sw += w * s.n; sw2 += w * w * s.n;
  }
  if (!covered || !n) return { k, n, p: null, ci: null, nEff: 0, coverage: total ? 0 : null };
  const p = est / sw, nEff = (sw * sw) / sw2;
  return { k, n, p: round(p), ci: wilson(p * nEff, nEff), nEff: round(nEff, 1), coverage: round(covered / total) };
}

const prop = (k, n) => ({ k, n, p: n ? round(k / n) : null, ci: n ? wilson(k, n) : null });

function confusion(pairs, rows, cols) {
  const m = Object.fromEntries(rows.map((r) => [r, Object.fromEntries(cols.map((c) => [c, 0]))]));
  for (const [h, x] of pairs) if (m[h] && x in m[h]) m[h][x]++;
  return m;
}

function kappa(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const cats = [...new Set(pairs.flat())];
  const po = pairs.filter(([a, b]) => a === b).length / n;
  let pe = 0;
  for (const c of cats) pe += (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n);
  return round(pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe), 3);
}

/** Primary reading (amendment 2): met when the estimate is at or above the bar and its lower 95% bound at or above the floor. */
const judgeMet = (e, bar, floor) => (e.p === null ? "not yet measured" : e.p >= bar && e.ci[0] >= floor ? "met" : "not met");
/** The original strict reading, reported as a secondary: the whole interval at or above the bar. */
const judge = (e, bar) => (e.p === null ? "not yet measured" : e.ci[0] >= bar ? "met" : e.p >= bar ? "not shown" : "not met");

function done(study, item, l) {
  if (!l || !item) return false;
  if (study === "referee") return true;
  const rules = item.truth.rules ?? [];
  return rules.every((r) => ["correct", "fp"].includes((l.rule_marks ?? {})[r]));
}

/** Primary reviewer: most finished items; ties: the earliest first label (any label, finished or not), as review.ts. */
function primary(study, exp) {
  const items = new Map(exp.items.map((i) => [i.item, i]));
  const n = new Map();
  for (const l of exp.labels) {
    if (!items.has(l.item)) continue;
    const s = n.get(l.reviewer) ?? { done: 0, first: Infinity };
    if (done(study, items.get(l.item), l)) s.done++;
    s.first = Math.min(s.first, Date.parse(l.created_at));
    n.set(l.reviewer, s);
  }
  return [...n].sort((a, b) => b[1].done - a[1].done || a[1].first - b[1].first)[0]?.[0] ?? null;
}

function pairwise(study, exp) {
  const items = new Map(exp.items.map((i) => [i.item, i]));
  const by = new Map();
  for (const l of exp.labels) if (done(study, items.get(l.item), l)) (by.get(l.reviewer) ?? by.set(l.reviewer, new Map()).get(l.reviewer)).set(l.item, l.answer);
  const rs = [...by.keys()], out = [];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const A = by.get(rs[i]), B = by.get(rs[j]);
    const pairs = [...A].filter(([id]) => B.has(id)).map(([id, x]) => [x, B.get(id)]);
    out.push({ a: rs[i], b: rs[j], n: pairs.length, kappa: pairs.length < 30 ? "too few shared items" : kappa(pairs) });
  }
  return out;
}

function referee(exp, man) {
  const p = primary("referee", exp);
  const mine = new Map(exp.labels.filter((l) => l.reviewer === p).map((l) => [l.item, l]));
  const rows = exp.items.filter((i) => mine.has(i.item)).map((i) => ({ i, l: mine.get(i.item) }));
  const decided = rows.filter((x) => x.l.answer !== "unclear");
  const agree = decided.map((x) => ({ stratum: `${x.i.cell}|${x.i.sub}`, cell: x.i.cell, y: (x.l.answer === "passed") === x.i.truth.passed, blind: !x.l.saw_replay }));
  const est = stratified(agree, man.config.frame.strata);
  const traps = (l) => [...(l.traps ?? [])].sort().join(",");
  const byCell = {};
  for (const cell of Object.keys(man.config.quotas)) { const xs = agree.filter((a) => a.cell === cell); byCell[cell] = prop(xs.filter((a) => a.y).length, xs.length); }
  const blind = agree.filter((a) => a.blind);
  return {
    primary: p, labelled: rows.length, of: exp.items.length, unclear: rows.length - decided.length,
    agreement_weighted: est,
    agreement_raw: prop(agree.filter((a) => a.y).length, agree.length),
    agreement_blind_only: prop(blind.filter((a) => a.y).length, blind.length),
    agreement_by_cell: byCell,
    trap_sprung_agreement: prop(rows.filter((x) => (x.l.traps ?? []).length > 0 === x.i.truth.sprung.length > 0).length, rows.length),
    trap_exact_agreement: prop(rows.filter((x) => traps(x.l) === [...x.i.truth.sprung].sort().join(",")).length, rows.length),
    kappa_vs_referee: kappa(decided.map((x) => [x.l.answer === "passed" ? "pass" : "fail", x.i.truth.passed ? "pass" : "fail"])),
    kappa_reviewers: pairwise("referee", exp),
    confusion: confusion(rows.map((x) => [x.l.answer, x.i.truth.passed ? "pass" : "fail"]), ["passed", "failed", "unclear"], ["pass", "fail"]),
    h1: rows.length === exp.items.length ? judgeMet(est, 0.95, 0.9) : "not yet measured",
    h1_strict: rows.length === exp.items.length ? judge(est, 0.95) : "not yet measured",
  };
}

function scanner(exp, man) {
  const p = primary("scanner", exp);
  const items = new Map(exp.items.map((i) => [i.item, i]));
  const rows = exp.labels.filter((l) => l.reviewer === p && done("scanner", items.get(l.item), l)).map((l) => ({ i: items.get(l.item), l }));
  const sure = rows.filter((x) => x.l.answer !== "unsure");
  const share = (cell) => stratified(
    sure.filter((x) => x.i.cell === cell).map((x) => ({ stratum: `${x.i.cell}|${x.i.sub}`, cell, y: x.l.answer === "risky" })),
    Object.fromEntries(Object.entries(man.config.frame.strata).filter(([k]) => k.startsWith(`${cell}|`))),
  );
  const flagged = share("flagged"), caution = share("caution"), clear = share("clear");
  const rules = {};
  for (const x of rows) for (const [r, m] of Object.entries(x.l.rule_marks ?? {})) { rules[r] ??= { correct: 0, fp: 0 }; rules[r][m === "correct" ? "correct" : "fp"]++; }
  return {
    primary: p, labelled: rows.length, of: exp.items.length, unsure: rows.length - sure.length,
    precision_flagged: flagged, risky_in_caution: caution, missed_in_clear: clear,
    per_rule: Object.fromEntries(Object.entries(rules).map(([r, s]) => [r, { ...s, ci: wilson(s.correct, s.correct + s.fp) }])),
    kappa_reviewers: pairwise("scanner", exp),
    confusion: confusion(rows.map((x) => [x.l.answer, x.i.truth.verdict]), ["risky", "benign", "unsure"], ["flagged", "caution", "clear"]),
    h2: rows.length === exp.items.length ? judgeMet(flagged, 0.9, 0.8) : "not yet measured",
    h2_strict: rows.length === exp.items.length ? judge(flagged, 0.9) : "not yet measured",
    note: "Recall is computed on /admin/review (seeded simulation, review-stats.ts `recall`) from these shares and the frame cell sizes.",
  };
}

export { referee, scanner, stratified, wilson, kappa };

// Run as a script (not when a test imports the functions above).
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) {
  const { readFileSync } = await import("node:fs");
  const read = (f) => JSON.parse(readFileSync(f, "utf8"));
  const [re, rm, se, sm] = process.argv.slice(2);
  const out = {};
  if (re && rm) out.referee = referee(read(re), read(rm));
  if (se && sm) out.scanner = scanner(read(se), read(sm));
  console.log(JSON.stringify(out, null, 2));
}
