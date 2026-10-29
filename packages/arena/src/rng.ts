// Seeded random numbers (mulberry32) so every variant and every flaky failure replays exactly.

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes a seed with a label, so each task and tool gets its own independent stream. */
export function subSeed(seed: number, label: string) {
  let h = seed ^ 0x9e3779b9;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

/**
 * A seeded shuffle with one fixed algorithm (binary insertion, as V8 sorts a short array when it starts cold), so a
 * seed rebuilds the same sandbox on every engine and every call. It replaces `[...xs].sort(() => r() - 0.5)`, whose
 * result depends on the engine's sort: Node's V8 sorts differently from the Workers runtime, and the Workers runtime
 * itself switched algorithm once an isolate had warmed up (ADR 0084), so `forge verify` and even the Gauntlet's own
 * per-call replay could rebuild a different sandbox from the same seed.
 */
export function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = 1; i < a.length; i++) {
    const pivot = a[i]!;
    let left = 0;
    let right = i;
    while (left < right) {
      const mid = left + ((right - left) >> 1);
      if (r() - 0.5 < 0) right = mid;
      else left = mid + 1;
    }
    for (let j = i; j > left; j--) a[j] = a[j - 1]!;
    a[left] = pivot;
  }
  return a;
}

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
/** Money in cents, to avoid floating-point surprises in checks. */
export const cents = (r: () => number, lo: number, hi: number) => int(r, lo * 100, hi * 100);
export const money = (c: number) => `$${(c / 100).toFixed(2)}`;
