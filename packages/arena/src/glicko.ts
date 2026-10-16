// Glicko-2 ratings (Glickman 2012) for division rankings and the Open Division ladder (ADR 0012 §3, ADR 0013 §4).

export interface Rating {
  rating: number;
  rd: number;
  vol: number;
}

export const NEW_RATING: Rating = { rating: 1500, rd: 350, vol: 0.06 };
const SCALE = 173.7178;
const TAU = 0.5;

/** Updates one player's rating after a rating period of games. score: 1 win, 0.5 draw, 0 loss. */
export function glicko2(p: Rating, games: { opp: Rating; score: number }[]): Rating {
  const mu = (p.rating - 1500) / SCALE;
  const phi = p.rd / SCALE;
  if (!games.length) return { ...p, rd: Math.min(350, Math.sqrt(phi ** 2 + p.vol ** 2) * SCALE) };
  const g = (ph: number) => 1 / Math.sqrt(1 + (3 * ph ** 2) / Math.PI ** 2);
  const E = (m: number, mj: number, phj: number) => 1 / (1 + Math.exp(-g(phj) * (m - mj)));
  let vInv = 0;
  let deltaSum = 0;
  for (const { opp, score } of games) {
    const mj = (opp.rating - 1500) / SCALE;
    const phj = opp.rd / SCALE;
    const e = E(mu, mj, phj);
    vInv += g(phj) ** 2 * e * (1 - e);
    deltaSum += g(phj) * (score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;
  // Volatility by the Illinois algorithm.
  const a = Math.log(p.vol ** 2);
  const f = (x: number) => (Math.exp(x) * (delta ** 2 - phi ** 2 - v - Math.exp(x))) / (2 * (phi ** 2 + v + Math.exp(x)) ** 2) - (x - a) / TAU ** 2;
  let A = a;
  let B: number;
  if (delta ** 2 > phi ** 2 + v) B = Math.log(delta ** 2 - phi ** 2 - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi ** 2 + vol ** 2);
  const phiNew = 1 / Math.sqrt(1 / phiStar ** 2 + 1 / v);
  const muNew = mu + phiNew ** 2 * deltaSum;
  return { rating: muNew * SCALE + 1500, rd: phiNew * SCALE, vol };
}

/** A conservative display rating (rating − 2·RD), so new entrants don't top the table on luck. */
export const conservative = (r: Rating) => Math.round(r.rating - 2 * r.rd);
