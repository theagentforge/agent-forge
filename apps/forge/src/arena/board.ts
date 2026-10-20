import { utcDay } from "@forge/arena";
import type { Db } from "../services/db";
import { finishedRuns, modelName } from "./views";

// "Which AI falls for it?" (ADR 0029 §home): the share of refereed Arena bouts in which each model set off at least
// one planted trap. Normal-tier practice and ranked bouts only: Lab runs with trap cards (they change the prompt) and
// Hard runs are left out, and a model needs MIN_RUNS bouts to be listed. Cached for the day, like the featured duel.

export const MIN_RUNS = 30;

export interface BoardRow {
  model: string;
  name: string;
  runs: number;
  fell: number;
  rate: number;
}

export interface Board {
  rows: BoardRow[];
  runs: number;
  since: string | null;
  until: string | null;
}

export async function gullibilityBoard(env: Pick<Env, "KV">, db: Db, now = Date.now()): Promise<Board> {
  const key = `arena:board:v1:${utcDay(now)}`;
  const hit = await env.KV.get<Board>(key, "json");
  if (hit) return hit;
  const runs = await finishedRuns(db, { limit: 5000, now });
  const by = new Map<string, { runs: number; fell: number }>();
  let first = Infinity;
  let last = 0;
  for (const { summary: s, result } of runs) {
    if (!result.traps.length) continue;
    const m = by.get(s.model) ?? { runs: 0, fell: 0 };
    m.runs++;
    if (result.traps.some((t) => t.triggered)) m.fell++;
    by.set(s.model, m);
    first = Math.min(first, s.finishedAt);
    last = Math.max(last, s.finishedAt);
  }
  const rows = [...by]
    .filter(([, m]) => m.runs >= MIN_RUNS)
    .map(([model, m]) => ({ model, name: modelName(model), runs: m.runs, fell: m.fell, rate: m.fell / m.runs }))
    .sort((a, b) => b.rate - a.rate || b.runs - a.runs || a.model.localeCompare(b.model));
  const board: Board = {
    rows,
    runs: rows.reduce((n, r) => n + r.runs, 0),
    since: Number.isFinite(first) ? new Date(first).toISOString().slice(0, 10) : null,
    until: last ? new Date(last).toISOString().slice(0, 10) : null,
  };
  await env.KV.put(key, JSON.stringify(board), { expirationTtl: 2 * 86_400 });
  return board;
}

/** Ranked Hard-tier bouts (each lab's everyday model, no trap card) and how many set off a planted trap. Cached daily. */
export interface FrontierHard {
  runs: number;
  fell: number;
  models: number;
}

export async function frontierHard(env: Pick<Env, "KV">, db: Db, now = Date.now()): Promise<FrontierHard> {
  const key = `arena:frontier-hard:v1:${utcDay(now)}`;
  const hit = await env.KV.get<FrontierHard>(key, "json");
  if (hit) return hit;
  const runs = await finishedRuns(db, { tier: "hard", kinds: ["card"], now });
  const out = { runs: runs.length, fell: runs.filter((r) => r.result.traps.some((t) => t.triggered)).length, models: new Set(runs.map((r) => r.summary.model)).size };
  await env.KV.put(key, JSON.stringify(out), { expirationTtl: 2 * 86_400 });
  return out;
}
