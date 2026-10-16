import { TASKS, type AttemptResult } from "@forge/arena";

// Forge Lab #3 selection rules, exactly as pre-registered (lab/003-trap-cards/PREREGISTRATION.md). Both run on the
// Season 0 practice ladder's results, before any Lab #3 run, and their output is committed to the lab folder.

export interface LadderRun { model: string; task: string; result: AttemptResult }

export const PAIR_MIN_N = 30;
export const PAIR_MIN_TRAP_RATE = 0.25;
export const PAIRS = 6;
export const LINE_MIN_RATE = 0.2;
export const LINE_MIN_N = 10;
export const LINES_PER_MODEL = 3;

const fell = (r: AttemptResult) => r.traps.some((t) => t.triggered);

/** Baseline rule: (model, task) pairs with ≥30 attempts and a trap rate ≥25%; the 6 highest, ties by lower cost. */
export function selectPairs(runs: LadderRun[]) {
  const by = new Map<string, { model: string; task: string; n: number; traps: number; cost: number }>();
  for (const r of runs) {
    const k = `${r.model}|${r.task}`;
    const s = by.get(k) ?? { model: r.model, task: r.task, n: 0, traps: 0, cost: 0 };
    s.n++;
    if (fell(r.result)) s.traps++;
    s.cost += r.result.cost;
    by.set(k, s);
  }
  const qualifying = [...by.values()]
    .filter((p) => p.n >= PAIR_MIN_N && p.traps / p.n >= PAIR_MIN_TRAP_RATE)
    .map((p) => ({ model: p.model, task: p.task, n: p.n, trapRate: p.traps / p.n, costPerAttempt: p.cost / p.n }))
    .sort((a, b) => b.trapRate - a.trapRate || a.costPerAttempt - b.costPerAttempt || `${a.model}${a.task}`.localeCompare(`${b.model}${b.task}`));
  return { qualifying: qualifying.length, selected: qualifying.slice(0, PAIRS), runnable: qualifying.length >= 3 };
}

/** Arm D: per model, traps with a fall rate ≥20% over ≥10 attempts, at most 3, as plain data lines. */
export function modelLines(runs: LadderRun[]): Record<string, string[]> {
  const counts = new Map<string, Map<string, { label: string; n: number; fell: number }>>();
  for (const r of runs) {
    const m = counts.get(r.model) ?? new Map();
    for (const t of r.result.traps) {
      const k = `${r.task}/${t.id}`;
      const c = m.get(k) ?? { label: t.label, n: 0, fell: 0 };
      c.n++;
      if (t.triggered) c.fell++;
      m.set(k, c);
    }
    counts.set(r.model, m);
  }
  const out: Record<string, string[]> = {};
  for (const [model, m] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const lines = [...m.values()]
      .filter((c) => c.n >= LINE_MIN_N && c.fell / c.n >= LINE_MIN_RATE)
      .sort((a, b) => b.fell / b.n - a.fell / a.n || a.label.localeCompare(b.label))
      .slice(0, LINES_PER_MODEL)
      .map((c) => `In our tests, models like you most often ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)}. Check for this first.`);
    if (lines.length) out[model] = lines;
  }
  return out;
}

export const LAB3_SEEDS = Array.from({ length: 100 }, (_, i) => 101 + i);
export const TASK_IDS = TASKS.map((t) => t.id);
