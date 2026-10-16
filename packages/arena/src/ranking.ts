import { round } from "./engine";
import { COST_SCALE, logScore, SPEED_SCALE, type Stats } from "./scorecard";

// "Your champion" (ADR 0014 §4): personal weights over quality, cost-of-pass and speed. Weights live in the URL.

export interface Weights {
  quality: number;
  cost: number;
  speed: number;
}

export const PRESETS: Record<string, { label: string; weights: Weights }> = {
  quality: { label: "Best quality", weights: { quality: 1, cost: 0, speed: 0 } },
  cheapest: { label: "Cheapest that works", weights: { quality: 0.2, cost: 0.8, speed: 0 } },
  fastest: { label: "Fastest that works", weights: { quality: 0.2, cost: 0, speed: 0.8 } },
  balanced: { label: "Balanced", weights: { quality: 0.5, cost: 0.25, speed: 0.25 } },
};

/** "q50-c25-s25" ↔ weights. Unknown or empty input falls back to Balanced. */
export function parseWeights(s: string | null | undefined): Weights {
  if (s && PRESETS[s]) return PRESETS[s]!.weights;
  const m = /^q(\d{1,3})-c(\d{1,3})-s(\d{1,3})$/.exec(s ?? "");
  if (!m) return PRESETS.balanced!.weights;
  const [q, c, sp] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (q + c + sp === 0) return PRESETS.balanced!.weights;
  return { quality: q / 100, cost: c / 100, speed: sp / 100 };
}

export const formatWeights = (w: Weights) => `q${Math.round(w.quality * 100)}-c${Math.round(w.cost * 100)}-s${Math.round(w.speed * 100)}`;

/** Weighted geometric mean of quality, cost and speed scores (each 0–1, floored at 0.01 so one zero isn't fatal). */
export function personalScore(s: Stats, w: Weights) {
  const parts: [number, number][] = [
    [s.quality, w.quality],
    [logScore(s.costOfPass, COST_SCALE.best, COST_SCALE.worst), w.cost],
    [logScore(s.modelMs, SPEED_SCALE.best, SPEED_SCALE.worst), w.speed],
  ];
  const total = parts.reduce((t, [, x]) => t + x, 0) || 1;
  return round(Math.exp(parts.reduce((t, [v, x]) => t + x * Math.log(Math.max(0.01, v)), 0) / total));
}

export interface Ranked<T> {
  item: T;
  stats: Stats;
  score: number;
  rank: number;
  /** Best and worst plausible rank, from overlapping 95% intervals on the official score. */
  range: [number, number];
  /** Falls for traps: ranked below every model that never does (the quality floor). */
  trapped: boolean;
}

/** Ranks models for a set of weights. A model that ever falls for a trap can't rank above one that never does. */
export function rankModels<T>(rows: { item: T; stats: Stats }[], w: Weights): Ranked<T>[] {
  const scored = rows
    .filter((r) => r.stats.runs > 0)
    .map((r) => ({ ...r, score: personalScore(r.stats, w), trapped: r.stats.trapRate > 0 }))
    .sort((a, b) => Number(a.trapped) - Number(b.trapped) || b.score - a.score);
  return scored.map((r, i) => {
    const best = 1 + scored.filter((o) => o !== r && o.stats.scoreCI[0] > r.stats.scoreCI[1]).length;
    const worst = scored.length - scored.filter((o) => o !== r && o.stats.scoreCI[1] < r.stats.scoreCI[0]).length;
    return { ...r, rank: i + 1, range: [Math.min(best, i + 1), Math.max(worst, i + 1)] as [number, number] };
  });
}

/** Models on the "best value" line: nobody else is at least as good and at least as cheap, and better at one. */
export function paretoFrontier<T>(rows: { item: T; stats: Stats }[]): T[] {
  return rows
    .filter((r) => r.stats.runs > 0 && Number.isFinite(r.stats.costOfPass))
    .filter(
      (r) =>
        !rows.some(
          (o) =>
            o !== r &&
            o.stats.quality >= r.stats.quality &&
            o.stats.costOfPass <= r.stats.costOfPass &&
            (o.stats.quality > r.stats.quality || o.stats.costOfPass < r.stats.costOfPass),
        ),
    )
    .map((r) => r.item);
}

/**
 * The task title (ADR 0014 §1): held only when the leader's lead is statistically clear (its official-score
 * interval sits entirely above everyone else's); otherwise the title is "contested".
 */
export function titleHolder<T>(rows: { item: T; stats: Stats }[]): { holder: T | null; contested: boolean } {
  const ranked = rows.filter((r) => r.stats.runs > 0).sort((a, b) => b.stats.score - a.stats.score);
  if (!ranked.length) return { holder: null, contested: false };
  const [top, ...rest] = ranked;
  const clear = top!.stats.status === "verdict" && rest.every((r) => top!.stats.scoreCI[0] > r.stats.scoreCI[1]);
  return clear ? { holder: top!.item, contested: false } : { holder: null, contested: ranked.length > 1 };
}
