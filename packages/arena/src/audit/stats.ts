// Small, dependency-free statistics for the validity pack (ADR 0136). Intervals are 95%, rounded outwards to three
// decimals so a published interval is never narrower than the computed one.

const Z = 1.959964;
const lo3 = (x: number) => Math.floor(x * 1000 + 1e-9) / 1000;
const hi3 = (x: number) => Math.ceil(x * 1000 - 1e-9) / 1000;

/** 95% Wilson score interval for k successes in n, bounds rounded outwards; null when n is 0. */
export function wilson95(k: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = Z * Z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [lo3(Math.max(0, c - h)), hi3(Math.min(1, c + h))];
}

/** 95% interval for p1 - p2 (Newcombe's hybrid score method from the two Wilson intervals); null if a side is empty. */
export function diff95(k1: number, n1: number, k2: number, n2: number): [number, number] | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const raw = (k: number, n: number) => {
    const p = k / n;
    const z2 = Z * Z;
    const d = 1 + z2 / n;
    const c = (p + z2 / (2 * n)) / d;
    const h = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)] as const;
  };
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const [l1, u1] = raw(k1, n1);
  const [l2, u2] = raw(k2, n2);
  const d = p1 - p2;
  return [lo3(Math.max(-1, d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2))), hi3(Math.min(1, d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)))];
}

/** Cohen's kappa for two raters on yes/no items; null when chance agreement is 1 (every item the same class). */
export function kappa(both: number, onlyA: number, onlyB: number, neither: number): number | null {
  const n = both + onlyA + onlyB + neither;
  if (!n) return null;
  const po = (both + neither) / n;
  const pa = (both + onlyA) / n;
  const pb = (both + onlyB) / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  if (pe >= 1) return null;
  return Math.round(((po - pe) / (1 - pe)) * 1000) / 1000;
}

export const rate3 = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 1000 : null);
