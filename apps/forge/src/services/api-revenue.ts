import { isPlanId, mrrCents } from "@forge/shared";
import { desc, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { RENEWAL_GRACE_MS } from "./api-keys";
import { getDb } from "./db";
import { countsAsHouse } from "./identity";

// ADR 0110: API subscription revenue for /admin/usage and the data room's MRR schedule (B5 in
// docs/strategy/api-pricing-2026-10-29.md). Rules:
// - MRR: monthly plans at face value, annual divided by 12 (packages/shared mrrCents). Only team, volume and
//   enterprise plans count; the free plan is not revenue.
// - House and founder accounts (countsAsHouse) are never counted as paying organisations or MRR.
// - Pilot (services) revenue is a separate column, never MRR.
// - A subscription counts at a month's end if it had started and not ended by then. Canceled plans count until the
//   period they paid for ends. Rows hold each subscription's current plan, so a plan change is shown in every month
//   (no plan history yet): contraction and expansion are "not yet measured". Polar's export is the source of truth.

export interface SubForRevenue {
  id: string;
  humanId: string;
  plan: string;
  provider: string;
  billingInterval: string;
  priceCents: number | null;
  status: string;
  currentPeriodEnd: number | null;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
  externalSubscriptionId: string | null;
}

/**
 * When a subscription stops counting: its end, the end of a canceled period, or (revoked without a date) its update. An
 * active plan whose paid period ended more than the renewal grace ago (a renewal that never came, or an invoiced plan
 * past its end date) stops counting then, as it stops giving the plan (effectivePlan): MRR is never more than is in force.
 */
export function subEnd(s: Pick<SubForRevenue, "status" | "endedAt" | "currentPeriodEnd" | "updatedAt">) {
  if (s.endedAt !== null) return s.endedAt;
  if ((s.status === "active" || s.status === "trialing") && s.currentPeriodEnd !== null) return s.currentPeriodEnd + RENEWAL_GRACE_MS;
  if (s.status === "canceled" || s.status === "past_due") return s.currentPeriodEnd;
  if (s.status === "revoked" || s.status === "ended" || s.status === "incomplete_expired" || s.status === "unpaid") return s.updatedAt;
  return null;
}

const PAYING = new Set(["team", "volume", "enterprise"]);
const LIVE = new Set(["active", "trialing", "canceled", "past_due", "revoked", "ended", "unpaid"]);

export function activeAt(s: SubForRevenue, at: number) {
  if (!PAYING.has(s.plan) || !isPlanId(s.plan) || !LIVE.has(s.status) || s.startedAt > at) return false;
  const end = subEnd(s);
  return end === null || end > at;
}

export const subMrrCents = (s: SubForRevenue) => (isPlanId(s.plan) ? mrrCents(s.plan, s.billingInterval === "year" ? "year" : "month", s.priceCents) : 0);

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const monthEndOf = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return Date.UTC(y, m, 1) - 1;
};
const monthStartOf = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return Date.UTC(y, m - 1, 1);
};

export interface RevenueSummary {
  as_of: string;
  mrr_usd: number;
  paying_organisations: number;
  new_this_month: number;
  churned_this_month: number;
  contraction_this_month: "not yet measured";
  top1_share: number | null;
  top2_share: number | null;
  excluded_house_or_founder_subscriptions: number;
  pilot_revenue_this_month_usd: number;
}

/** The summary at `now` from subscriptions already filtered to outside owners. */
export function revenueSummary(subs: SubForRevenue[], pilots: { amountCents: number; receivedOn: string }[], excluded: number, now = Date.now()): RevenueSummary {
  const live = subs.filter((s) => activeAt(s, now));
  const byOwner = new Map<string, number>();
  for (const s of live) byOwner.set(s.humanId, (byOwner.get(s.humanId) ?? 0) + subMrrCents(s));
  const total = [...byOwner.values()].reduce((a, b) => a + b, 0);
  const sorted = [...byOwner.values()].sort((a, b) => b - a);
  const month = monthKey(now);
  const start = monthStartOf(month);
  const ownersAt = (at: number) => new Set(subs.filter((s) => activeAt(s, at)).map((s) => s.humanId));
  const before = ownersAt(start - 1);
  const nowOwners = new Set(byOwner.keys());
  return {
    as_of: new Date(now).toISOString(),
    mrr_usd: total / 100,
    paying_organisations: nowOwners.size,
    new_this_month: [...nowOwners].filter((h) => !before.has(h)).length,
    churned_this_month: [...before].filter((h) => !nowOwners.has(h)).length,
    contraction_this_month: "not yet measured",
    top1_share: total ? Math.round((sorted[0]! / total) * 1000) / 1000 : null,
    top2_share: total ? Math.round((((sorted[0] ?? 0) + (sorted[1] ?? 0)) / total) * 1000) / 1000 : null,
    excluded_house_or_founder_subscriptions: excluded,
    pilot_revenue_this_month_usd: pilots.filter((p) => p.receivedOn.startsWith(month)).reduce((a, p) => a + p.amountCents, 0) / 100,
  };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The customer-level monthly MRR schedule (one row per customer and month at month end, the current month as of
 * now), then pilot payments in their own rows and column. `customer` for subscriptions is a pseudonym that reconciles
 * to Polar through `external_subscription_id`; for pilots it is the organisation invoiced.
 */
export function mrrScheduleCsv(subs: SubForRevenue[], pilots: { customer: string; amountCents: number; receivedOn: string }[], pseudonym: (humanId: string) => string, now = Date.now()) {
  const rows: (string | number)[][] = [["month", "kind", "customer", "plan", "provider", "interval", "external_subscription_id", "mrr_usd", "pilot_revenue_usd"]];
  const first = subs.length ? Math.min(...subs.map((s) => s.startedAt)) : null;
  if (first !== null) {
    for (let key = monthKey(first); key <= monthKey(now); key = monthKey(monthEndOf(key) + 1)) {
      const at = key === monthKey(now) ? now : monthEndOf(key);
      for (const s of subs.filter((x) => activeAt(x, at)).sort((a, b) => a.humanId.localeCompare(b.humanId)))
        rows.push([key, "subscription", pseudonym(s.humanId), s.plan, s.provider, s.billingInterval, s.externalSubscriptionId ?? "", (subMrrCents(s) / 100).toFixed(2), ""]);
    }
  }
  for (const p of [...pilots].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn)))
    rows.push([p.receivedOn.slice(0, 7), "pilot", p.customer, "", "invoice", "", "", "0.00", (p.amountCents / 100).toFixed(2)]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** Loads subscriptions (outside owners only), the excluded count and pilot payments. */
export async function revenueData(env: Env) {
  const db = getDb(env);
  const all = await db
    .select({ sub: t.apiSubscriptions, isHouse: t.humans.isHouse, githubId: t.humans.githubId })
    .from(t.apiSubscriptions)
    .innerJoin(t.humans, sql`${t.humans.id} = ${t.apiSubscriptions.humanId}`);
  const subs = all.filter((r) => !countsAsHouse(env, r)).map((r) => r.sub);
  const pilots = await db.select().from(t.pilotRevenue).orderBy(desc(t.pilotRevenue.receivedOn));
  return { subs, excluded: all.length - subs.length, pilots };
}

/** A stable, non-reversible customer label for the CSV (HMAC of the owner id). */
export async function customerPseudonyms(env: Env, humanIds: string[]) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.EXPORT_PSEUDONYM_KEY ?? env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Map<string, string>();
  for (const h of new Set(humanIds)) {
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`api-customer:${h}`)));
    out.set(h, `cust_${[...sig.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  }
  return out;
}
