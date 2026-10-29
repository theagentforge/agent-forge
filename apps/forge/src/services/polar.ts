import { type PaidPlanId, PAID_PLAN_IDS } from "@forge/shared";
import { eq } from "drizzle-orm";
import * as t from "../db/schema";
import { forgetOwner } from "./api-keys";
import { getDb } from "./db";

// ADR 0110: Polar (merchant of record) for the paid API plans. Polar runs the checkout and the customer portal on its
// own pages, so no card details ever reach this site. We only:
// - create a checkout or portal session through Polar's API (POLAR_ACCESS_TOKEN), passing our owner id as
//   external_customer_id, and redirect to the URL Polar returns;
// - receive Polar's signed webhooks (POLAR_WEBHOOK_SECRET) and set the owner's plan from them.
//
// Webhooks follow Standard Webhooks (https://www.standardwebhooks.com/): headers webhook-id, webhook-timestamp and
// webhook-signature ("v1,<base64 HMAC-SHA256>" entries, space-separated) over "<id>.<timestamp>.<raw body>". Polar's
// own SDK keys the HMAC with the secret's UTF-8 bytes (it base64-encodes the secret before handing it to the Standard
// Webhooks library, which decodes it again; polar-js src/webhooks.ts). A secret in the generic "whsec_<base64>" form is
// decoded as Standard Webhooks specifies.

export const POLAR_WEBHOOK_PATH = "/webhooks/polar";
export const WEBHOOK_TOLERANCE_S = 5 * 60;
const IDEMPOTENCY_TTL_S = 7 * 86_400;

const enc = new TextEncoder();

function b64decode(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64encode(b: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(b)));
}

function secretBytes(secret: string) {
  return secret.startsWith("whsec_") ? b64decode(secret.slice("whsec_".length)) : enc.encode(secret);
}

/** The Standard Webhooks signature of a payload (exported for tests, which sign with fake secrets). */
export async function signWebhook(secret: string, id: string, timestamp: number | string, body: string) {
  const key = await crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `v1,${b64encode(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`)))}`;
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type VerifyResult = { ok: true; id: string } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

export async function verifyWebhook(secret: string, headers: Headers, body: string, nowMs = Date.now()): Promise<VerifyResult> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sig = headers.get("webhook-signature");
  if (!id || !ts || !sig || !/^\d{1,12}$/.test(ts)) return { ok: false, reason: "missing_headers" };
  if (Math.abs(nowMs / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_S) return { ok: false, reason: "stale_timestamp" };
  const expected = await signWebhook(secret, id, ts, body);
  for (const part of sig.split(" ")) if (part.startsWith("v1,") && safeEqual(part, expected)) return { ok: true, id };
  return { ok: false, reason: "bad_signature" };
}

/** POLAR_PRODUCTS: {"team_month":"<product id>",…}. Returns product id → plan and interval. */
export function polarProducts(env: Pick<Env, "POLAR_PRODUCTS">) {
  const out = new Map<string, { plan: PaidPlanId; interval: "month" | "year" }>();
  let raw: unknown;
  try {
    raw = JSON.parse(env.POLAR_PRODUCTS ?? "{}");
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const m = /^(team|volume)_(month|year)$/.exec(k);
    if (m && typeof v === "string" && v) out.set(v, { plan: m[1] as PaidPlanId, interval: m[2] as "month" | "year" });
  }
  return out;
}

export function productFor(env: Pick<Env, "POLAR_PRODUCTS">, plan: PaidPlanId, interval: "month" | "year") {
  for (const [id, p] of polarProducts(env)) if (p.plan === plan && p.interval === interval) return id;
  return null;
}

/** Everything the paid mode needs: the products of both plans and the token. The runbook's checklist. */
export function polarReady(env: Env) {
  const products = PAID_PLAN_IDS.flatMap((p) => (["month", "year"] as const).map((i) => !!productFor(env, p, i)));
  return { access_token: !!env.POLAR_ACCESS_TOKEN, webhook_secret: !!env.POLAR_WEBHOOK_SECRET, products: products.every(Boolean) };
}

const SUB_EVENTS = new Set(["subscription.created", "subscription.active", "subscription.updated", "subscription.canceled", "subscription.uncanceled", "subscription.revoked", "subscription.past_due"]);

interface PolarSubscription {
  id?: unknown;
  status?: unknown;
  product_id?: unknown;
  customer_id?: unknown;
  customer?: { external_id?: unknown } | null;
  recurring_interval?: unknown;
  amount?: unknown;
  currency?: unknown;
  current_period_start?: unknown;
  current_period_end?: unknown;
  cancel_at_period_end?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  created_at?: unknown;
  modified_at?: unknown;
}

const ms = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

export type ApplyResult = { applied: true; plan: string; status: string; humanId: string } | { applied: false; ignored: string };

/** Applies one verified Polar event to api_subscriptions (and audit_log). Data only; never trusts unverified input. */
export async function applyPolarEvent(env: Env, event: unknown, now = Date.now()): Promise<ApplyResult> {
  const e = event as { type?: unknown; data?: PolarSubscription } | null;
  if (!e || typeof e.type !== "string") return { applied: false, ignored: "invalid_event" };
  if (!SUB_EVENTS.has(e.type)) return { applied: false, ignored: "event_type" };
  const d = e.data ?? {};
  if (typeof d.id !== "string" || typeof d.product_id !== "string") return { applied: false, ignored: "invalid_subscription" };
  const product = polarProducts(env).get(d.product_id);
  if (!product) return { applied: false, ignored: "unknown_product" };
  const humanId = typeof d.customer?.external_id === "string" ? d.customer.external_id : null;
  const db = getDb(env);
  const human = humanId ? await db.query.humans.findFirst({ where: eq(t.humans.id, humanId), columns: { id: true } }) : null;
  if (!human) return { applied: false, ignored: "unknown_customer" };

  const updated = ms(d.modified_at) ?? ms(d.created_at) ?? now;
  const existing = await db.query.apiSubscriptions.findFirst({ where: eq(t.apiSubscriptions.externalSubscriptionId, d.id) });
  if (existing && existing.sourceUpdatedAt !== null && existing.sourceUpdatedAt > updated) return { applied: false, ignored: "older_event" };

  const polarStatus = typeof d.status === "string" ? d.status : "active";
  // A cancel keeps the plan until the end of the period already paid for, without the renewal grace an active plan has.
  const status = e.type === "subscription.revoked" ? "revoked" : polarStatus === "active" && d.cancel_at_period_end === true ? "canceled" : polarStatus;
  const endedAt = ms(d.ended_at) ?? (status === "revoked" ? now : null);
  const interval = d.recurring_interval === "year" ? "year" : product.interval;
  const priceCents = typeof d.amount === "number" && (d.currency === undefined || String(d.currency).toLowerCase() === "usd") ? d.amount : null;
  const values = {
    humanId: human.id,
    plan: product.plan,
    provider: "polar",
    billingInterval: interval,
    priceCents,
    externalCustomerId: typeof d.customer_id === "string" ? d.customer_id : null,
    externalSubscriptionId: d.id,
    status,
    currentPeriodStart: ms(d.current_period_start),
    currentPeriodEnd: ms(d.current_period_end),
    startedAt: existing?.startedAt ?? ms(d.started_at) ?? ms(d.created_at) ?? now,
    endedAt,
    sourceUpdatedAt: updated,
    updatedAt: now,
  };
  if (existing) await db.update(t.apiSubscriptions).set(values).where(eq(t.apiSubscriptions.id, existing.id));
  else await db.insert(t.apiSubscriptions).values({ id: crypto.randomUUID(), ...values });
  await db.insert(t.auditLog).values({
    id: crypto.randomUUID(),
    actor: "polar:webhook",
    action: "api_plan_changed",
    target: `human:${human.id}`,
    detail: { event: e.type, plan: product.plan, interval, status, subscription: d.id, before: existing ? { plan: existing.plan, status: existing.status } : null },
    createdAt: now,
  });
  forgetOwner(human.id);
  return { applied: true, plan: product.plan, status, humanId: human.id };
}

/** The whole webhook: verify, refuse replays (webhook-id kept 7 days in KV), apply. Returns status and JSON body. */
export async function handlePolarWebhook(env: Env, headers: Headers, body: string, now = Date.now()): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!env.POLAR_WEBHOOK_SECRET) return { status: 404, body: { error: "not_found" } };
  const v = await verifyWebhook(env.POLAR_WEBHOOK_SECRET, headers, body, now);
  if (!v.ok) return { status: 401, body: { error: v.reason } };
  const seenKey = `polar-webhook:${v.id.slice(0, 128)}`;
  if (await env.KV.get(seenKey)) return { status: 200, body: { ok: true, duplicate: true } };
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const r = await applyPolarEvent(env, event, now);
  await env.KV.put(seenKey, "1", { expirationTtl: IDEMPOTENCY_TTL_S });
  if (!r.applied) console.warn("polar_webhook_ignored", r.ignored);
  // 2xx either way: an event we deliberately ignore (another product, an unknown customer) must not be retried forever.
  return { status: 202, body: r.applied ? { ok: true, plan: r.plan, status: r.status } : { ok: true, ignored: r.ignored } };
}

const apiBase = (env: Env) => (env.POLAR_SERVER === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh");

async function polarPost(env: Env, path: string, payload: unknown, fetcher: typeof fetch = fetch) {
  const res = await fetcher(`${apiBase(env)}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`polar_${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** A Polar checkout session for one plan; the URL to send the owner to (Polar's hosted page). */
export async function createCheckout(env: Env, humanId: string, plan: PaidPlanId, interval: "month" | "year", fetcher: typeof fetch = fetch) {
  const product = productFor(env, plan, interval);
  if (!product || !env.POLAR_ACCESS_TOKEN) return null;
  const r = await polarPost(
    env,
    "/v1/checkouts/",
    {
      products: [product],
      external_customer_id: humanId,
      success_url: `${env.PUBLIC_ORIGIN}/dashboard/keys?m=checkout_done`,
      return_url: `${env.PUBLIC_ORIGIN}/pricing`,
    },
    fetcher,
  );
  return typeof r.url === "string" && r.url.startsWith("https://") ? r.url : null;
}

/** A Polar customer-portal session (invoices, cancel, card) for the owner. */
export async function createPortal(env: Env, humanId: string, fetcher: typeof fetch = fetch) {
  if (!env.POLAR_ACCESS_TOKEN) return null;
  const r = await polarPost(env, "/v1/customer-sessions/", { external_customer_id: humanId, return_url: `${env.PUBLIC_ORIGIN}/dashboard/keys` }, fetcher);
  return typeof r.customer_portal_url === "string" && r.customer_portal_url.startsWith("https://") ? r.customer_portal_url : null;
}
