import { utcDay } from "@forge/arena";
import type { Db } from "../services/db";
import { tallyRules, type RulesCount } from "./rules-label";
import { finishedRuns, isRankedEvent, modelName } from "./views";

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
  /** F-01 (ADR 0082): of `runs`, bouts in ranked events (headline and guest) and in practice or other unranked events. */
  ranked: number;
  practice: number;
  /** F-01: the rules version that scored each counted bout (oldest first); the counts sum to `runs`. */
  rules_versions: RulesCount[];
  since: string | null;
  until: string | null;
}

export const EMPTY_BOARD: Board = { rows: [], runs: 0, ranked: 0, practice: 0, rules_versions: [], since: null, until: null };

export async function gullibilityBoard(env: Pick<Env, "KV">, db: Db, now = Date.now()): Promise<Board> {
  const key = `arena:board:v2:${utcDay(now)}`;
  const hit = await env.KV.get<Board>(key, "json");
  if (hit) return hit;
  const runs = await finishedRuns(db, { limit: 5000, now });
  const by = new Map<string, { runs: number; fell: number; bouts: (typeof runs)[number][] }>();
  for (const r of runs) {
    if (!r.result.traps.length) continue;
    const m = by.get(r.summary.model) ?? { runs: 0, fell: 0, bouts: [] };
    m.runs++;
    if (r.result.traps.some((t) => t.triggered)) m.fell++;
    m.bouts.push(r);
    by.set(r.summary.model, m);
  }
  const listed = [...by].filter(([, m]) => m.runs >= MIN_RUNS);
  const rows = listed
    .map(([model, m]) => ({ model, name: modelName(model), runs: m.runs, fell: m.fell, rate: m.fell / m.runs }))
    .sort((a, b) => b.rate - a.rate || b.runs - a.runs || a.model.localeCompare(b.model));
  // The caption counts exactly the bouts behind the listed rows: their dates, ranked/practice mix and rules versions.
  const counted = listed.flatMap(([, m]) => m.bouts);
  const ranked = counted.filter((r) => isRankedEvent({ kind: r.summary.kind, arm: r.summary.arm ?? null })).length;
  const times = counted.map((r) => r.summary.finishedAt);
  const board: Board = {
    rows,
    runs: counted.length,
    ranked,
    practice: counted.length - ranked,
    rules_versions: tallyRules(counted.map((r) => ({ finishedAt: r.summary.finishedAt, result: r.result }))),
    since: times.length ? new Date(Math.min(...times)).toISOString().slice(0, 10) : null,
    until: times.length ? new Date(Math.max(...times)).toISOString().slice(0, 10) : null,
  };
  await env.KV.put(key, JSON.stringify(board), { expirationTtl: 2 * 86_400 });
  return board;
}

/**
 * The frontier line under the Lab #3 band: the latest headline Hard event (25 Oct 2026: Crucible 2: Hard), each lab's
 * everyday model with no trap card, and in how many of its bouts the referee marked a planted trap sprung. Counted like
 * /arena/failures: a fall is a trap the referee marked triggered; running out of time or moves is never one (a
 * knocked-out attempt still counts in the total). Embargoed models (ADR 0041) and events held for review are left
 * out by `finishedRuns`, and so are Lab arm events and practice. One event, not several pooled: each Crucible uses a
 * different version of the Hard jobs (Crucible 1: Hard v2, Crucible 2: Hard v3), so pooling would mix two tests.
 * "Latest" is the event whose first public bout finished last, among card events with at least MIN_RUNS public Hard
 * bouts (so a weekly headline bout, 18 attempts, never replaces a Crucible). Cached by the hour, so an event published
 * mid-day (a held event set to running) shows the same hour.
 */
export interface FrontierHard {
  event: { slug: string; name: string };
  runs: number;
  fell: number;
  models: number;
}

export const fellInRun = (r: { result: { traps?: { triggered: boolean }[] } }) => (r.result?.traps ?? []).some((t) => t.triggered);

export async function frontierHard(env: Pick<Env, "KV">, db: Db, now = Date.now()): Promise<FrontierHard | null> {
  const key = `arena:frontier-hard:v3:${new Date(now).toISOString().slice(0, 13)}`;
  const hit = await env.KV.get<FrontierHard | { none: true }>(key, "json");
  if (hit) return "none" in hit ? null : hit;
  const runs = await finishedRuns(db, { tier: "hard", kinds: ["card"], now });
  const by = new Map<string, { name: string; first: number; runs: typeof runs }>();
  for (const r of runs) {
    const e = by.get(r.summary.event) ?? { name: r.summary.eventName, first: Infinity, runs: [] };
    e.first = Math.min(e.first, r.summary.finishedAt);
    e.runs.push(r);
    by.set(r.summary.event, e);
  }
  const latest = [...by.entries()].filter(([, e]) => e.runs.length >= MIN_RUNS).sort((a, b) => b[1].first - a[1].first)[0];
  const out: FrontierHard | null = latest
    ? { event: { slug: latest[0], name: latest[1].name }, runs: latest[1].runs.length, fell: latest[1].runs.filter(fellInRun).length, models: new Set(latest[1].runs.map((r) => r.summary.model)).size }
    : null;
  await env.KV.put(key, JSON.stringify(out ?? { none: true }), { expirationTtl: 2 * 3_600 });
  return out;
}
