import { publicTrapId, TRAP_CATALOG, TRAP_FAMILIES, trapEntry, VERDICT_RUNS, wilsonInterval, type TrapEntry, type TrapFamily } from "@forge/arena";
import type { Db } from "../services/db";
import { finishedRuns, modelName, tierOf, type Tier } from "./views";

// The leaderboard by failure mode (ADR 0023 §4): for each public trap (rows, grouped by family) and each model
// (columns), how often the model fell for the trap when it was in the job. Ranked bouts only (card and guest events):
// practice runs and Lab #3 arm events never count. Every number comes from the referee's results.
//
// The rule, stated on the page too: a trap counts as present in an attempt when the referee listed it in that
// attempt's result, and as a fall when the referee marked it sprung. An attempt that ran out of time or moves still
// counts as present (the referee checks the end state either way); running out is a knockout, never a fall.

export type FailTier = Tier | "all";
/** `?tier=normal|hard|all`; anything else (or nothing) is all tiers. */
export const parseFailTier = (q: string | undefined): FailTier => (q === "normal" || q === "hard" ? q : "all");

/** The order rows are shown in: money traps first, permission overreach last. */
export const FAMILY_ORDER: TrapFamily[] = ["PAY", "INJ", "POL", "DUP", "CLM", "AMT", "DAT", "TIM", "PRM"];

export interface Cell {
  /** Attempts where the trap was present. */
  n: number;
  /** Attempts where the model fell for it. */
  fell: number;
  rate: number;
  /** 95% Wilson interval for the fall rate. */
  ci: [number, number];
  /** Fewer than VERDICT_RUNS attempts: a first look, not a verdict. */
  early: boolean;
}

export interface Example {
  id: string;
  model: string;
  name: string;
  task: string;
  fell: boolean;
  finishedAt: number;
}

export const cellOf = (n: number, fell: number): Cell => ({ n, fell, rate: n ? Math.round((fell / n) * 1000) / 1000 : 0, ci: wilsonInterval(fell, n), early: n < VERDICT_RUNS });

/** The public trap entries a tier's jobs can spring (all of them for "all"). */
export function entriesFor(tier: FailTier): TrapEntry[] {
  const inTier = (e: TrapEntry) => tier === "all" || e.traps.some((k) => tierOf(k.split("/")[0]!) === tier);
  return FAMILY_ORDER.flatMap((f) => TRAP_CATALOG.filter((e) => e.family === f && inTier(e)));
}

/** Ranked runs for a tier, newest first. Practice and Lab #3 events are left out by `finishedRuns` itself. */
async function rankedRuns(db: Db, tier: FailTier) {
  const runs = await finishedRuns(db, { kinds: ["card", "guest"], ...(tier === "hard" ? { tier: "hard" } : tier === "all" ? { hard: true } : {}) });
  return tier === "all" ? runs : runs.filter((r) => tierOf(r.summary.task) === tier);
}

/** Per run: each public trap the referee listed, and whether it was sprung (once per public ID per run). */
function trapsOfRun(task: string, traps: { id: string; triggered: boolean }[] | undefined) {
  const out = new Map<string, boolean>();
  for (const t of traps ?? []) {
    const pid = publicTrapId(task, t.id);
    if (pid) out.set(pid, (out.get(pid) ?? false) || t.triggered);
  }
  return out;
}

/** The whole board: every catalogued trap of the tier against every model with ranked runs in it. */
export async function failureBoard(db: Db, tier: FailTier = "all") {
  const runs = await rankedRuns(db, tier);
  const counts = new Map<string, { n: number; fell: number }>(); // `${publicId}|${model}`
  const models = new Map<string, number>();
  for (const r of runs) {
    models.set(r.summary.model, (models.get(r.summary.model) ?? 0) + 1);
    for (const [pid, fell] of trapsOfRun(r.summary.task, r.result?.traps)) {
      const k = `${pid}|${r.summary.model}`;
      const c = counts.get(k) ?? { n: 0, fell: 0 };
      c.n++;
      if (fell) c.fell++;
      counts.set(k, c);
    }
  }
  const cols = [...models.keys()].map((id) => ({ id, name: modelName(id), attempts: models.get(id)! })).sort((a, b) => a.name.localeCompare(b.name));
  const entries = entriesFor(tier);
  const rows = entries.map((e) => ({
    entry: e,
    cells: Object.fromEntries(cols.map((m) => {
      const c = counts.get(`${e.id}|${m.id}`);
      return [m.id, c ? cellOf(c.n, c.fell) : null];
    })) as Record<string, Cell | null>,
  }));
  const families = FAMILY_ORDER.filter((f) => rows.some((r) => r.entry.family === f)).map((f) => ({ family: f, name: TRAP_FAMILIES[f].name, rows: rows.filter((r) => r.entry.family === f) }));
  const latest = runs.reduce((m, r) => Math.max(m, r.summary.finishedAt), 0);
  return { tier, models: cols, families, attempts: runs.length, asOf: latest ? new Date(latest).toISOString().slice(0, 10) : null };
}

/** One trap: its catalog entry, each model's cell, and the most recent ranked falls and catches. */
export async function trapBoard(db: Db, publicId: string, tier: FailTier = "all", examples = 6) {
  const entry = trapEntry(publicId);
  if (!entry) return null;
  const runs = await rankedRuns(db, tier);
  const by = new Map<string, { n: number; fell: number }>();
  const falls: Example[] = [];
  const catches: Example[] = [];
  for (const r of runs) {
    const fell = trapsOfRun(r.summary.task, r.result?.traps).get(entry.id);
    if (fell === undefined) continue;
    const c = by.get(r.summary.model) ?? { n: 0, fell: 0 };
    c.n++;
    if (fell) c.fell++;
    by.set(r.summary.model, c);
    const ex: Example = { id: r.summary.id, model: r.summary.model, name: modelName(r.summary.model), task: r.summary.task, fell, finishedAt: r.summary.finishedAt };
    // Runs come newest first, so the first few of each kind are the most recent.
    if (fell && falls.length < examples) falls.push(ex);
    if (!fell && catches.length < examples) catches.push(ex);
  }
  const models = [...by.entries()]
    .map(([id, c]) => ({ id, name: modelName(id), cell: cellOf(c.n, c.fell) }))
    .sort((a, b) => b.cell.rate - a.cell.rate || b.cell.n - a.cell.n || a.name.localeCompare(b.name));
  const total = [...by.values()].reduce((s, c) => ({ n: s.n + c.n, fell: s.fell + c.fell }), { n: 0, fell: 0 });
  return { entry, tier, models, overall: total.n ? cellOf(total.n, total.fell) : null, falls, catches };
}
