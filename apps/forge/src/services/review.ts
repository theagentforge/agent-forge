import { Attempt, familyOf, taskById, twistById, type AttemptResult, type LogEvent } from "@forge/arena";
import { SCAN_RULES_VERSION, type ScanFinding } from "@forge/shared";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { notEmbargoed } from "../arena/views";
import type { Db } from "./db";
import { cohenKappa, confusion, judge, judgeMet, proportion, recall, stratified, type HypothesisStatus, type Proportion, type Verdict } from "./review-stats";

// Lab #6: human review audits (ADR 0054; lab/006-referee-and-scanner-audit/PREREGISTRATION.md).
// D8: do people agree with the Arena referee? D12: how often is the skill scanner right?
// Each study has a sample drawn once, from a fixed published seed, frozen in review_items with the machine's verdict
// as it stood at the draw. Reviewers answer blind; the comparison happens only here, server-side, for admins.

export type Study = "referee" | "scanner";
export const STUDIES: Study[] = ["referee", "scanner"];

/** Fixed in the pre-registration. Changing any of these after a draw makes it a different study. */
export const LAB6 = {
  referee: {
    sampleId: "lab6-referee",
    seed: "forge-lab-006-referee-v1",
    size: 200,
    /** Four referee-outcome cells, 50 each; a short cell gives its spare places to the others (water-filling). */
    quotas: { "pass|no-trap": 50, "pass|trap": 50, "fail|no-trap": 50, "fail|trap": 50 } as Record<string, number>,
    bar: 0.95,
    /** Amendment 2: H1 is met when the estimate is ≥ bar and its lower 95% bound ≥ floor. */
    floor: 0.9,
  },
  scanner: {
    sampleId: "lab6-scanner",
    seed: "forge-lab-006-scanner-v1",
    size: 200,
    quotas: { flagged: 80, caution: 60, clear: 60 } as Record<string, number>,
    bar: 0.9,
    floor: 0.8,
  },
  reservesPerCell: 20,
} as const;

/** Results stay on /admin/review until Dinike decides to publish (then this flips, with a release). */
export const LAB6_RESULTS_PUBLIC = false;

// --- Seeded draw (pure) ----------------------------------------------------------------------------------------

/** The sort key every draw uses: SHA-256 of "<seed>:<text>", hex. Anyone with the public data can recompute it. */
export async function seededKey(seed: string, text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${seed}:${text}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Quotas against cell sizes: a cell smaller than its quota is taken whole, and the spare places go to the cells with
 * room, equally, in the order the quotas are listed (one at a time once fewer spare places than open cells are left).
 */
export function allocate(quotas: Record<string, number>, sizes: Record<string, number>): Record<string, number> {
  const cells = Object.keys(quotas);
  const out: Record<string, number> = Object.fromEntries(cells.map((c) => [c, Math.min(quotas[c]!, sizes[c] ?? 0)]));
  let spare = cells.reduce((s, c) => s + quotas[c]!, 0) - cells.reduce((s, c) => s + out[c]!, 0);
  while (spare > 0) {
    const open = cells.filter((c) => out[c]! < (sizes[c] ?? 0));
    if (!open.length) break;
    const share = Math.max(1, Math.floor(spare / open.length));
    for (const c of open) {
      if (!spare) break;
      const add = Math.min(share, (sizes[c] ?? 0) - out[c]!, spare);
      out[c]! += add;
      spare -= add;
    }
  }
  return out;
}

/**
 * One cell's draw order: its sub-strata (model × job family, or scanner rule) are put in seeded order, each one's
 * items too, and the sequence takes the first item of every sub-stratum, then the second of each, and so on. So every
 * sub-stratum is in the sample before any has two, and the sample's first n items are the sequence's first n.
 */
export async function cellSequence<T extends { id: string; sub: string }>(items: T[], seed: string): Promise<T[]> {
  const subs = new Map<string, { key: string; items: { key: string; item: T }[] }>();
  for (const item of items) {
    let s = subs.get(item.sub);
    if (!s) subs.set(item.sub, (s = { key: await seededKey(seed, `sub:${item.sub}`), items: [] }));
    s.items.push({ key: await seededKey(seed, item.id), item });
  }
  const ordered = [...subs.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const s of ordered) s.items.sort((a, b) => (a.key < b.key ? -1 : 1));
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) for (const s of ordered) if (s.items[round]) out.push(s.items[round]!.item);
  return out;
}

export interface FrameItem {
  id: string;
  cell: string;
  sub: string;
  truth: unknown;
}

export interface Draw {
  items: { itemId: string; cell: string; sub: string; rank: number; position: number | null; status: "active" | "reserve"; truth: unknown }[];
  /** Frame size per cell and per cell|sub (the weights). */
  frame: { cells: Record<string, number>; strata: Record<string, number> };
  allocation: Record<string, number>;
}

/** The whole draw from a frame: allocation, round-robin per cell, reserves, and a seeded queue order. Pure. */
export async function drawSample(frame: FrameItem[], seed: string, quotas: Record<string, number>, reserves: number = LAB6.reservesPerCell): Promise<Draw> {
  const cells: Record<string, number> = {};
  const strata: Record<string, number> = {};
  for (const f of frame) {
    cells[f.cell] = (cells[f.cell] ?? 0) + 1;
    strata[`${f.cell}|${f.sub}`] = (strata[`${f.cell}|${f.sub}`] ?? 0) + 1;
  }
  const allocation = allocate(quotas, cells);
  const items: Draw["items"] = [];
  for (const cell of Object.keys(quotas)) {
    const seq = await cellSequence(
      frame.filter((f) => f.cell === cell),
      seed,
    );
    seq.slice(0, allocation[cell]! + reserves).forEach((f, i) => items.push({ itemId: f.id, cell, sub: f.sub, rank: i + 1, position: null, status: i < allocation[cell]! ? "active" : "reserve", truth: f.truth }));
  }
  // The queue mixes the cells, so a reviewer can't tell an item's cell from where it sits.
  const active = items.filter((i) => i.status === "active");
  const keyed = await Promise.all(active.map(async (i) => ({ i, key: await seededKey(seed, `order:${i.itemId}`) })));
  keyed.sort((a, b) => (a.key < b.key ? -1 : 1)).forEach((x, n) => (x.i.position = n + 1));
  return { items, frame: { cells, strata }, allocation };
}

// --- Frames (D1) -----------------------------------------------------------------------------------------------

/** "refund-hard3" (or "refund-hard3-2") → "refund": a job family spans its Normal and Hard versions. */
export const jobFamily = (task: string) => familyOf(task);

export interface RefereeTruth {
  passed: boolean;
  /** Trap ids the referee marked sprung. */
  sprung: string[];
  reason: string | null;
  model: string;
  task: string;
}

export interface ScannerTruth {
  verdict: "flagged" | "caution" | "clear";
  rulesVersion: string;
  sourceUrl: string;
  name: string | null;
  rules: string[];
  findings: Pick<ScanFinding, "rule" | "title" | "why" | "severity" | "line" | "evidence">[];
}

/** Every public refereed run finished before `cutoff`: done, not embargoed, not in a held event or unpremiered fixture. */
export async function refereeFrame(db: Db, cutoff: number): Promise<FrameItem[]> {
  const rows = await db
    .select({
      id: t.arenaRuns.id,
      model: t.arenaRuns.modelId,
      task: t.arenaRuns.task,
      passed: sql<number>`coalesce(${t.arenaRuns.passed}, json_extract(${t.arenaRuns.result}, '$.passed'), 0)`,
      sprung: sql<number>`exists (select 1 from json_each(${t.arenaRuns.result}, '$.traps') j where json_extract(j.value, '$.triggered') = 1)`,
    })
    .from(t.arenaRuns)
    .where(and(eq(t.arenaRuns.status, "done"), isNotNull(t.arenaRuns.finishedAt), lt(t.arenaRuns.finishedAt, cutoff), isNotNull(t.arenaRuns.log), notEmbargoed(cutoff)));
  return rows.map((r) => ({ id: r.id, cell: `${r.passed ? "pass" : "fail"}|${r.sprung ? "trap" : "no-trap"}`, sub: `${r.model}|${jobFamily(r.task)}`, truth: null }));
}

/** Every public scan with a source we can fetch again, scanned under `rulesVersion`, first seen before `cutoff`. */
export async function scannerFrame(db: Db, cutoff: number, rulesVersion = SCAN_RULES_VERSION): Promise<FrameItem[]> {
  const rows = await db
    .select({ fp: t.skillScans.fingerprint, verdict: t.skillScans.verdict, src: t.skillScans.sourceUrl, top: sql<string | null>`json_extract(${t.skillScans.findings}, '$[0].rule')` })
    .from(t.skillScans)
    .where(and(eq(t.skillScans.public, true), isNotNull(t.skillScans.sourceUrl), eq(t.skillScans.rulesVersion, rulesVersion), lt(t.skillScans.firstSeen, cutoff)));
  // Flagged and caution: stratified by the rule of the top finding (highest severity, then first line). Clear: by host.
  return rows.map((r) => ({ id: r.fp, cell: r.verdict, sub: r.verdict === "clear" ? hostOf(r.src) : (r.top ?? "none"), truth: null }));
}

const hostOf = (u: string | null) => {
  try {
    return new URL(u ?? "").hostname;
  } catch {
    return "unknown";
  }
};

async function inChunks<T, R>(xs: T[], size: number, f: (chunk: T[]) => Promise<R[]>) {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += size) out.push(...(await f(xs.slice(i, i + size))));
  return out;
}

async function refereeTruths(db: Db, ids: string[]) {
  const rows = await inChunks(ids, 90, (c) => db.select({ id: t.arenaRuns.id, passed: t.arenaRuns.passed, result: t.arenaRuns.result, model: t.arenaRuns.modelId, task: t.arenaRuns.task }).from(t.arenaRuns).where(inArray(t.arenaRuns.id, c)));
  return new Map(
    rows.map((r) => {
      const res = (r.result ?? {}) as Partial<AttemptResult>;
      const truth: RefereeTruth = { passed: !!(r.passed ?? res.passed), sprung: (res.traps ?? []).filter((x) => x.triggered).map((x) => x.id), reason: res.reason ?? null, model: r.model, task: r.task };
      return [r.id, truth];
    }),
  );
}

async function scannerTruths(db: Db, fps: string[]) {
  const rows = await inChunks(fps, 90, (c) => db.select().from(t.skillScans).where(inArray(t.skillScans.fingerprint, c)));
  return new Map(
    rows.map((r) => {
      const findings = ((r.findings ?? []) as ScanFinding[]).map((f) => ({ rule: f.rule, title: f.title, why: f.why, severity: f.severity, line: f.line, evidence: f.evidence }));
      const truth: ScannerTruth = { verdict: r.verdict, rulesVersion: r.rulesVersion, sourceUrl: r.sourceUrl ?? "", name: r.name, rules: [...new Set(findings.map((f) => f.rule))], findings };
      return [r.fingerprint, truth];
    }),
  );
}

export async function sampleOf(db: Db, study: Study) {
  const [s] = await db.select().from(t.reviewSamples).where(eq(t.reviewSamples.study, study));
  return s ?? null;
}

export interface SampleConfig {
  cutoff: number;
  size: number;
  quotas: Record<string, number>;
  allocation: Record<string, number>;
  frame: Draw["frame"];
  rulesVersion?: string;
}

/** Draws a study's sample once (an existing draw is returned unchanged). The frame closes at the moment of the draw. */
export async function drawStudy(db: Db, study: Study, humanId: string, now = Date.now()) {
  const existing = await sampleOf(db, study);
  if (existing) return { sample: existing, created: false };
  const cfg = LAB6[study];
  const frame = study === "referee" ? await refereeFrame(db, now) : await scannerFrame(db, now);
  const draw = await drawSample(frame, cfg.seed, cfg.quotas);
  const ids = draw.items.map((i) => i.itemId);
  const truths: Map<string, unknown> = study === "referee" ? await refereeTruths(db, ids) : await scannerTruths(db, ids);
  const config: SampleConfig = { cutoff: now, size: cfg.size, quotas: cfg.quotas, allocation: draw.allocation, frame: draw.frame, ...(study === "scanner" ? { rulesVersion: SCAN_RULES_VERSION } : {}) };
  const stmts = [
    db.insert(t.reviewSamples).values({ id: cfg.sampleId, study, seed: cfg.seed, config, drawnBy: humanId, drawnAt: now }).onConflictDoNothing(),
    ...chunk(draw.items, 9).map((c) => db.insert(t.reviewItems).values(c.map((i) => ({ sampleId: cfg.sampleId, itemId: i.itemId, cell: i.cell, sub: i.sub, rank: i.rank, position: i.position, status: i.status, truth: truths.get(i.itemId) ?? {} })))),
  ];
  await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  return { sample: (await sampleOf(db, study))!, created: true };
}

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// --- Queue and labels ------------------------------------------------------------------------------------------

export type Item = typeof t.reviewItems.$inferSelect;
export type Label = typeof t.reviewLabels.$inferSelect;

export async function activeItems(db: Db, sampleId: string) {
  return db.select().from(t.reviewItems).where(and(eq(t.reviewItems.sampleId, sampleId), eq(t.reviewItems.status, "active"))).orderBy(asc(t.reviewItems.position));
}

export async function labelsOf(db: Db, sampleId: string, reviewerId?: string) {
  return db
    .select()
    .from(t.reviewLabels)
    .where(reviewerId ? and(eq(t.reviewLabels.sampleId, sampleId), eq(t.reviewLabels.reviewerId, reviewerId)) : eq(t.reviewLabels.sampleId, sampleId));
}

/** Done means answered, and for the scanner every matched rule marked after the reveal. */
export function labelComplete(study: Study, item: Pick<Item, "truth">, l: Pick<Label, "answer" | "ruleMarks" | "revealedAt"> | undefined) {
  if (!l) return false;
  if (study === "referee") return true;
  const rules = (item.truth as ScannerTruth).rules ?? [];
  const marks = (l.ruleMarks ?? {}) as Record<string, string>;
  return l.revealedAt !== null && rules.every((r) => marks[r] === "correct" || marks[r] === "fp");
}

/** The next position this reviewer hasn't finished, after `from` first, then from the start; null when all are done. */
export function nextOpen(study: Study, items: Item[], mine: Label[], from = 0): number | null {
  const by = new Map(mine.map((l) => [l.itemId, l]));
  const open = items.filter((i) => !labelComplete(study, i, by.get(i.itemId))).map((i) => i.position!);
  return open.find((p) => p > from) ?? open[0] ?? null;
}

export const REFEREE_ANSWERS = ["passed", "failed", "unclear"] as const;
export const SCANNER_ANSWERS = ["risky", "benign", "unsure"] as const;

export async function saveRefereeLabel(db: Db, sampleId: string, item: Item, reviewerId: string, v: { answer: string; traps: string[]; note: string; sawReplay: boolean; seconds: number | null }, now = Date.now()) {
  if (!(REFEREE_ANSWERS as readonly string[]).includes(v.answer)) return "bad_answer" as const;
  const allowed = new Set(trapOptions(item).map((x) => x.id));
  const traps = [...new Set(v.traps)].filter((x) => allowed.has(x));
  const [old] = await db.select().from(t.reviewLabels).where(and(eq(t.reviewLabels.sampleId, sampleId), eq(t.reviewLabels.itemId, item.itemId), eq(t.reviewLabels.reviewerId, reviewerId)));
  const row = { answer: v.answer, traps, note: v.note.slice(0, 500) || null, sawReplay: !!old?.sawReplay || v.sawReplay, seconds: v.seconds ?? old?.seconds ?? null, updatedAt: now };
  await db
    .insert(t.reviewLabels)
    .values({ sampleId, itemId: item.itemId, reviewerId, ...row, createdAt: now })
    .onConflictDoUpdate({ target: [t.reviewLabels.sampleId, t.reviewLabels.itemId, t.reviewLabels.reviewerId], set: row });
  return "saved" as const;
}

/** The blind answer, which also reveals the verdict. Locked once revealed: a second answer is refused. */
export async function saveScannerAnswer(db: Db, sampleId: string, item: Item, reviewerId: string, v: { answer: string; note: string; seconds: number | null }, now = Date.now()) {
  if (!(SCANNER_ANSWERS as readonly string[]).includes(v.answer)) return "bad_answer" as const;
  const [old] = await db.select().from(t.reviewLabels).where(and(eq(t.reviewLabels.sampleId, sampleId), eq(t.reviewLabels.itemId, item.itemId), eq(t.reviewLabels.reviewerId, reviewerId)));
  if (old?.revealedAt) return "locked" as const;
  await db.insert(t.reviewLabels).values({ sampleId, itemId: item.itemId, reviewerId, answer: v.answer, note: v.note.slice(0, 500) || null, revealedAt: now, seconds: v.seconds, createdAt: now, updatedAt: now }).onConflictDoNothing();
  return "saved" as const;
}

/** Per matched rule, after the reveal: "correct" (the text is what the rule describes) or "fp" (it isn't). */
export async function saveScannerMarks(db: Db, sampleId: string, item: Item, reviewerId: string, v: { marks: Record<string, string>; note: string; seconds: number | null }, now = Date.now()) {
  const [old] = await db.select().from(t.reviewLabels).where(and(eq(t.reviewLabels.sampleId, sampleId), eq(t.reviewLabels.itemId, item.itemId), eq(t.reviewLabels.reviewerId, reviewerId)));
  if (!old?.revealedAt) return "not_revealed" as const;
  const rules = (item.truth as ScannerTruth).rules ?? [];
  const marks = Object.fromEntries(rules.filter((r) => v.marks[r] === "correct" || v.marks[r] === "fp").map((r) => [r, v.marks[r]!]));
  const note = [old.note, v.note.slice(0, 500)].filter(Boolean).join(" · ").slice(0, 500) || null;
  await db
    .update(t.reviewLabels)
    .set({ ruleMarks: { ...((old.ruleMarks ?? {}) as Record<string, string>), ...marks }, note, seconds: (old.seconds ?? 0) + (v.seconds ?? 0), updatedAt: now })
    .where(and(eq(t.reviewLabels.sampleId, sampleId), eq(t.reviewLabels.itemId, item.itemId), eq(t.reviewLabels.reviewerId, reviewerId)));
  return "saved" as const;
}

/**
 * An item whose material can't be shown (the run's log is missing, or the skill's file changed at its source) is
 * replaced by its cell's next reserve, in drawn order, at the same position. Refused once anyone has labelled it.
 */
export async function replaceItem(db: Db, sampleId: string, item: Item) {
  const labelled = await db.select({ n: sql<number>`count(*)` }).from(t.reviewLabels).where(and(eq(t.reviewLabels.sampleId, sampleId), eq(t.reviewLabels.itemId, item.itemId)));
  if (Number(labelled[0]?.n ?? 0) > 0) return "labelled" as const;
  const [next] = await db
    .select()
    .from(t.reviewItems)
    .where(and(eq(t.reviewItems.sampleId, sampleId), eq(t.reviewItems.cell, item.cell), eq(t.reviewItems.status, "reserve")))
    .orderBy(asc(t.reviewItems.rank))
    .limit(1);
  const pos = item.position;
  await db.batch([
    db.update(t.reviewItems).set({ status: "unavailable", position: null, replacedBy: next?.itemId ?? null }).where(and(eq(t.reviewItems.sampleId, sampleId), eq(t.reviewItems.itemId, item.itemId))),
    ...(next ? [db.update(t.reviewItems).set({ status: "active", position: pos }).where(and(eq(t.reviewItems.sampleId, sampleId), eq(t.reviewItems.itemId, next.itemId)))] : []),
  ]);
  return next ? ("replaced" as const) : ("no_reserve" as const);
}

// --- What a reviewer sees (blind) -------------------------------------------------------------------------------

/** The traps the job tells viewers about before the bout (the log's start event), as answer options. */
export function trapOptions(item: Pick<Item, "truth">, log?: LogEvent[] | null): { id: string; label: string }[] {
  const start = log?.[0];
  if (start?.type === "start") return start.traps;
  const task = taskById((item.truth as RefereeTruth).task);
  return task?.traps ?? [];
}

/** Events a blind reviewer may see: everything the model saw and did. The referee's own events are left out. */
const BLIND = new Set<LogEvent["type"]>(["turn", "call", "result", "hit", "spin"]);

export interface BlindRun {
  brief: string;
  steps: { n: number; kind: "said" | "call" | "result" | "error" | "repeat"; name?: string; text: string }[];
  claim: { status: string; summary: string } | null;
  /** The world after the run, rebuilt by replaying the logged calls; only the parts that changed, then the rest. */
  changed: { key: string; before: string; after: string }[];
  unchanged: string[];
  /** The job's checklist, computed on the untouched world, so it carries no outcome. */
  checklist: { label: string; critical: boolean }[];
  traps: { id: string; label: string }[];
  ended: "finished" | "tapped_out" | "out_of_moves_or_time" | "error";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pretty = (v: unknown) => JSON.stringify(v, null, 1) ?? "";

/** Builds the blind view of a run from its log alone. Throws when the log can't be replayed (missing, or foreign). */
export function blindRun(task: string, seed: number, log: LogEvent[]): BlindRun {
  const start = log[0];
  if (!start || start.type !== "start") throw new Error("The run has no usable log.");
  const tt = taskById(task);
  if (!tt) throw new Error(`Unknown job ${task}.`);
  const steps: BlindRun["steps"] = [];
  for (const e of log) {
    if (!BLIND.has(e.type)) continue;
    if (e.type === "turn" && e.text) steps.push({ n: e.n, kind: "said", text: clip(e.text, 1200) });
    else if (e.type === "call") steps.push({ n: e.n, kind: "call", name: e.name, text: clip(JSON.stringify(e.args), 1500) });
    else if (e.type === "result") steps.push({ n: e.n, kind: "result", name: e.name, text: clip(JSON.stringify(e.result), 900) });
    else if (e.type === "hit") steps.push({ n: e.n, kind: "error", name: e.name, text: clip(e.error, 400) });
    else if (e.type === "spin") steps.push({ n: e.n, kind: "repeat", name: e.name, text: `repeated ${e.count} times` });
  }
  const twist = start.twist ? { id: start.twist, label: twistById(start.twist)?.label ?? start.twist } : null;
  const fresh = new Attempt(tt, seed, { twist, caps: start.caps });
  const before = structuredClone(fresh.state) as Record<string, unknown>;
  const a = new Attempt(tt, seed, { twist, caps: { turns: 1e9, toolCalls: 1e9, tokens: 1e15, ms: 1e15 } });
  let claim: BlindRun["claim"] = null;
  for (const e of log) if (e.type === "call") a.call(e.name, e.args);
  const fin = log.findLast((e) => e.type === "finish");
  if (fin?.type === "finish" && fin.claim) claim = { status: fin.claim.status, summary: clip(fin.claim.summary, 1500) };
  const tap = log.find((e) => e.type === "tapout");
  if (!claim && tap?.type === "tapout") claim = { status: "cannot_complete", summary: clip(tap.summary, 1500) };
  const after = a.state as Record<string, unknown>;
  const changed: BlindRun["changed"] = [];
  const unchanged: string[] = [];
  for (const key of Object.keys({ ...before, ...after })) {
    const b = pretty(before[key]);
    const af = pretty(after[key]);
    if (b === af) unchanged.push(key);
    else changed.push({ key, before: clip(b, 6000), after: clip(af, 12000) });
  }
  // The checklist from the referee on the untouched world: the labels describe what's required, never what happened.
  const blank = tt.referee(fresh.variant, structuredClone(fresh.variant.state), [], null);
  // How the bout ended, as the end state shows it (a run cut short by a model or provider error isn't "finished").
  const ended = fin?.type === "finish" && fin.reason.startsWith("knockout") ? "out_of_moves_or_time" : fin?.type === "finish" && fin.reason !== "finished" ? "error" : tap ? "tapped_out" : "finished";
  return { brief: start.brief, steps, claim, changed, unchanged, checklist: blank.checkpoints.map((c) => ({ label: c.label, critical: c.critical })), traps: start.traps, ended };
}

// --- Results ---------------------------------------------------------------------------------------------------

export interface ReviewerProgress {
  reviewerId: string;
  done: number;
  medianSeconds: number | null;
}

/** The primary reviewer: most finished labels, then earliest first label (fixed in the pre-registration). */
function primaryOf(study: Study, items: Item[], labels: Label[]) {
  const byItem = new Map(items.map((i) => [i.itemId, i]));
  const tally = new Map<string, { done: number; first: number; secs: number[] }>();
  for (const l of labels) {
    const it = byItem.get(l.itemId);
    if (!it) continue;
    const s = tally.get(l.reviewerId) ?? { done: 0, first: Infinity, secs: [] };
    if (labelComplete(study, it, l)) {
      s.done++;
      if (l.seconds !== null) s.secs.push(l.seconds);
    }
    s.first = Math.min(s.first, l.createdAt);
    tally.set(l.reviewerId, s);
  }
  const reviewers: ReviewerProgress[] = [...tally]
    .sort((a, b) => b[1].done - a[1].done || a[1].first - b[1].first)
    .map(([reviewerId, s]) => ({ reviewerId, done: s.done, medianSeconds: s.secs.length ? s.secs.sort((x, y) => x - y)[Math.floor(s.secs.length / 2)]! : null }));
  return { primary: reviewers[0]?.reviewerId ?? null, reviewers };
}

function pairwiseKappa(study: Study, items: Item[], labels: Label[], reviewers: string[]) {
  const out: { a: string; b: string; kappa: number | null; n: number }[] = [];
  const done = (r: string) => new Map(labels.filter((l) => l.reviewerId === r && items.some((i) => i.itemId === l.itemId && labelComplete(study, i, l))).map((l) => [l.itemId, l.answer]));
  for (let i = 0; i < reviewers.length; i++)
    for (let j = i + 1; j < reviewers.length; j++) {
      const A = done(reviewers[i]!);
      const B = done(reviewers[j]!);
      const pairs = [...A].filter(([id]) => B.has(id)).map(([id, x]) => [x, B.get(id)!] as [string, string]);
      const k = cohenKappa(pairs);
      out.push({ a: reviewers[i]!, b: reviewers[j]!, kappa: k.kappa, n: k.n });
    }
  return out;
}

export interface RefereeResults {
  study: "referee";
  size: number;
  complete: boolean;
  reviewers: ReviewerProgress[];
  primary: string | null;
  labelled: number;
  unclear: number;
  agreement: Proportion & { coverage: number | null };
  agreementRaw: Proportion;
  agreementBlindOnly: Proportion;
  byCell: Record<string, Proportion>;
  trapAgreement: Proportion;
  trapExact: Proportion;
  kappaVsReferee: { kappa: number | null; n: number };
  kappaReviewers: { a: string; b: string; kappa: number | null; n: number }[];
  confusion: ReturnType<typeof confusion>;
  /** Primary reading (amendment 2): estimate ≥ bar and lower bound ≥ floor. */
  h1: Verdict;
  /** The original strict reading (lower bound ≥ bar), reported as a secondary. */
  h1Strict: HypothesisStatus;
  bar: number;
  floor: number;
}

export function refereeResults(sample: { config: unknown }, items: Item[], labels: Label[]): RefereeResults {
  const cfg = sample.config as SampleConfig;
  const { primary, reviewers } = primaryOf("referee", items, labels);
  const mine = new Map(labels.filter((l) => l.reviewerId === primary).map((l) => [l.itemId, l]));
  const rows = items.map((i) => ({ i, truth: i.truth as RefereeTruth, l: mine.get(i.itemId) })).filter((x) => x.l);
  const decided = rows.filter((x) => x.l!.answer !== "unclear");
  const agree = decided.map((x) => ({ stratum: `${x.i.cell}|${x.i.sub}`, cell: x.i.cell, y: (x.l!.answer === "passed") === x.truth.passed, blind: !x.l!.sawReplay }));
  const byCell: Record<string, Proportion> = {};
  for (const cell of Object.keys(cfg.quotas)) {
    const xs = decided.filter((x) => x.i.cell === cell);
    byCell[cell] = proportion(xs.filter((x) => (x.l!.answer === "passed") === x.truth.passed).length, xs.length);
  }
  const trapAny = rows.map((x) => ((x.l!.traps as string[] | null)?.length ?? 0) > 0 === x.truth.sprung.length > 0);
  const trapExact = rows.map((x) => [...((x.l!.traps as string[] | null) ?? [])].sort().join(",") === [...x.truth.sprung].sort().join(","));
  const complete = items.length > 0 && rows.length === items.length;
  const agreement = stratified(agree, cfg.frame.strata);
  return {
    study: "referee",
    size: items.length,
    complete,
    reviewers,
    primary,
    labelled: rows.length,
    unclear: rows.length - decided.length,
    agreement,
    agreementRaw: proportion(agree.filter((a) => a.y).length, agree.length),
    agreementBlindOnly: proportion(agree.filter((a) => a.blind && a.y).length, agree.filter((a) => a.blind).length),
    byCell,
    trapAgreement: proportion(trapAny.filter(Boolean).length, trapAny.length),
    trapExact: proportion(trapExact.filter(Boolean).length, trapExact.length),
    kappaVsReferee: cohenKappa(decided.map((x) => [x.l!.answer === "passed" ? "pass" : "fail", x.truth.passed ? "pass" : "fail"])),
    kappaReviewers: pairwiseKappa("referee", items, labels, reviewers.map((r) => r.reviewerId)),
    confusion: confusion(
      rows.map((x) => ({ human: x.l!.answer, machine: x.truth.passed ? "pass" : "fail" })),
      [...REFEREE_ANSWERS],
      ["pass", "fail"],
    ),
    h1: judgeMet(agreement, LAB6.referee.bar, LAB6.referee.floor, complete),
    h1Strict: judge(agreement, LAB6.referee.bar, complete),
    bar: LAB6.referee.bar,
    floor: LAB6.referee.floor,
  };
}

export interface ScannerResults {
  study: "scanner";
  size: number;
  complete: boolean;
  reviewers: ReviewerProgress[];
  primary: string | null;
  labelled: number;
  unsure: number;
  precision: Record<"flagged" | "caution", Proportion & { coverage: number | null }>;
  /** Share of the clear sample a person called risky: what the scanner missed. */
  missedInClear: Proportion & { coverage: number | null };
  recall: ReturnType<typeof recall>;
  perRule: { rule: string; correct: number; fp: number; precision: Proportion }[];
  kappaReviewers: { a: string; b: string; kappa: number | null; n: number }[];
  confusion: ReturnType<typeof confusion>;
  h2: Verdict;
  h2Strict: HypothesisStatus;
  bar: number;
  floor: number;
}

export function scannerResults(sample: { config: unknown }, items: Item[], labels: Label[]): ScannerResults {
  const cfg = sample.config as SampleConfig;
  const { primary, reviewers } = primaryOf("scanner", items, labels);
  const mine = new Map(labels.filter((l) => l.reviewerId === primary).map((l) => [l.itemId, l]));
  const rows = items.map((i) => ({ i, truth: i.truth as ScannerTruth, l: mine.get(i.itemId) })).filter((x) => x.l && labelComplete("scanner", x.i, x.l));
  const sure = rows.filter((x) => x.l!.answer !== "unsure");
  const frameIn = (cell: string) => Object.fromEntries(Object.entries(cfg.frame.strata).filter(([k]) => k.startsWith(`${cell}|`)));
  const share = (cell: string) => stratified(
    sure.filter((x) => x.i.cell === cell).map((x) => ({ stratum: `${x.i.cell}|${x.i.sub}`, cell: x.i.cell, y: x.l!.answer === "risky" })),
    frameIn(cell),
  );
  const flagged = share("flagged");
  const caution = share("caution");
  const clear = share("clear");
  const tally = new Map<string, { correct: number; fp: number }>();
  for (const x of rows)
    for (const [rule, m] of Object.entries((x.l!.ruleMarks ?? {}) as Record<string, string>)) {
      const s = tally.get(rule) ?? { correct: 0, fp: 0 };
      if (m === "correct") s.correct++;
      else if (m === "fp") s.fp++;
      tally.set(rule, s);
    }
  const complete = items.length > 0 && rows.length === items.length;
  const N = (cell: string) => cfg.frame.cells[cell] ?? 0;
  return {
    study: "scanner",
    size: items.length,
    complete,
    reviewers,
    primary,
    labelled: rows.length,
    unsure: rows.length - sure.length,
    precision: { flagged, caution },
    missedInClear: clear,
    recall: recall({ flagged: { N: N("flagged"), p: flagged.p, nEff: flagged.nEff }, caution: { N: N("caution"), p: caution.p, nEff: caution.nEff }, clear: { N: N("clear"), p: clear.p, nEff: clear.nEff } }),
    perRule: [...tally].sort((a, b) => a[0].localeCompare(b[0])).map(([rule, s]) => ({ rule, ...s, precision: proportion(s.correct, s.correct + s.fp) })),
    kappaReviewers: pairwiseKappa("scanner", items, labels, reviewers.map((r) => r.reviewerId)),
    confusion: confusion(
      rows.map((x) => ({ human: x.l!.answer, machine: x.truth.verdict })),
      [...SCANNER_ANSWERS],
      ["flagged", "caution", "clear"],
    ),
    h2: judgeMet(flagged, LAB6.scanner.bar, LAB6.scanner.floor, complete),
    h2Strict: judge(flagged, LAB6.scanner.bar, complete),
    bar: LAB6.scanner.bar,
    floor: LAB6.scanner.floor,
  };
}

export async function studyResults(db: Db, study: Study) {
  const sample = await sampleOf(db, study);
  if (!sample) return null;
  const items = await activeItems(db, sample.id);
  const labels = await labelsOf(db, sample.id);
  return study === "referee" ? refereeResults(sample, items, labels) : scannerResults(sample, items, labels);
}
