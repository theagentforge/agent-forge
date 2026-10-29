// API plans (ADR 0110, docs/strategy/api-pricing-2026-10-29.md §D1). One source for /pricing, the API's limits, the
// 429 body, the admin MRR maths and the tests. Prices approved by Dinike on 29 Oct 2026 as the starting prices; the
// paid plans can only be bought once PRICING_MODE is "paid" (docs/runbooks/pricing.md).

export type PlanId = "free" | "team" | "volume" | "enterprise";
export type PaidPlanId = "team" | "volume";

export interface Plan {
  id: PlanId;
  name: string;
  /** Calls a minute per key (a Cloudflare rate-limit binding; approximate per location). Null: by contract. */
  perMinute: number | null;
  /** Calls a calendar month (UTC) across all of an owner's keys. Null: by contract. */
  perMonth: number | null;
  /** Active keys an owner may hold. */
  keys: number;
  /** Optional overage, US$ per 1,000 calls past the quota. Off by default; not built yet (hard stop at the quota). */
  overagePer1kUsd: number | null;
  /** Whole US dollars; null for invoiced plans. */
  priceMonthUsd: number | null;
  priceYearUsd: number | null;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Free key", perMinute: 120, perMonth: 20_000, keys: 2, overagePer1kUsd: null, priceMonthUsd: 0, priceYearUsd: 0 },
  team: { id: "team", name: "Team", perMinute: 600, perMonth: 250_000, keys: 10, overagePer1kUsd: 0.4, priceMonthUsd: 29, priceYearUsd: 290 },
  volume: { id: "volume", name: "Volume", perMinute: 3_000, perMonth: 3_000_000, keys: 50, overagePer1kUsd: 0.15, priceMonthUsd: 199, priceYearUsd: 1_990 },
  enterprise: { id: "enterprise", name: "Enterprise", perMinute: null, perMonth: null, keys: 50, overagePer1kUsd: null, priceMonthUsd: null, priceYearUsd: null },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];
export const PAID_PLAN_IDS: PaidPlanId[] = ["team", "volume"];

/** Calls without a key: the existing per-IP limit (CHECK_LIMITER), unchanged by any plan. */
export const ANONYMOUS_PER_MINUTE = 60;

export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && v in PLANS;

/** Monthly recurring revenue in US cents for one subscription: monthly at face value, annual divided by 12. */
export function mrrCents(plan: PlanId, interval: "month" | "year", priceCents: number | null = null): number {
  const p = PLANS[plan];
  const cents = priceCents ?? (interval === "year" ? (p.priceYearUsd ?? 0) * 100 : (p.priceMonthUsd ?? 0) * 100);
  return interval === "year" ? Math.round(cents / 12) : cents;
}
