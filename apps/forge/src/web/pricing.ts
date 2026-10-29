import { ANONYMOUS_PER_MINUTE, PAID_PLAN_IDS, type PaidPlanId, PLANS, type Plan } from "@forge/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { createKey, KEY_NAME_MAX, KEYS_PATH, listKeys, monthReset, monthUsed, planOf, pricingMode, PRICING_CONTACT, PRICING_PATH, revokeKey } from "../services/api-keys";
import { getDb } from "../services/db";
import { createCheckout, createPortal, handlePolarWebhook, POLAR_WEBHOOK_PATH } from "../services/polar";
import { csrfToken } from "./session";
import { currentSession, guardPost } from "./dashboard";
import { notFound, send, site, wantsJson } from "./pages";

// ADR 0110: /pricing, /dashboard/keys, the Polar checkout and portal redirects, and the Polar webhook.
// PRICING_MODE off: none of these pages exist (404) and nothing links to them. keys: free keys, paid plans shown as
// "coming soon" with no checkout. paid: checkout and billing links (Polar's hosted pages; no card fields here).

type Ctx = Context<{ Bindings: Env }>;

/** The /pricing wording (docs/strategy/api-pricing-2026-10-29.md §D5); pinned by tests. */
export const PRICING_WORDS = {
  heading: "Free to check. Pay only for high volume.",
  free: `Checks, scans, watch and exposure stay free without an account or key, at up to ${ANONYMOUS_PER_MINUTE} requests a minute per IP address. That doesn't change.`,
  sameAnswers: "A paid plan buys higher limits and usage records. It doesn't buy different answers: every plan gets the same reports, advisories and receipts.",
  notSafe: "A clear result means no known pattern matched, not that a tool is safe.",
  noSla: "We don't offer a guaranteed uptime (SLA) on self-serve plans.",
  payment: `Payments are processed by Polar, our merchant of record, which handles sales tax and VAT. We never see your card. Annual and enterprise plans can be invoiced: ${PRICING_CONTACT}.`,
  operator: "The Agent Forge is run by Dinike Jayamaha, an individual based in Sri Lanka.",
  comingSoon: "Paid plans are coming soon. Free keys work now.",
  counts: "Every request to a check, scan, watch or exposure endpoint (REST or the public MCP server) made with your key counts as one call, whether the answer was cached or fresh. Calls without a key don't count.",
  atLimit: "Past the per-minute limit or the monthly quota you get a 429 answer with the reason, the reset time and your usage, never a surprise charge. The quota is counted within about a minute, so it can run slightly over. Optional overage billing is not offered yet.",
  refund: "Refunds and cancellation: terms to be confirmed before paid plans open.",
} as const;

const n = (v: number | null) => (v === null ? "by contract" : v.toLocaleString("en-US"));
const price = (p: Plan) =>
  p.priceMonthUsd === null ? "invoiced" : p.priceMonthUsd === 0 ? "US$0" : `US$${p.priceMonthUsd} a month or US$${p.priceYearUsd!.toLocaleString("en-US")} a year`;

export function pricingData(env: Env) {
  const mode = pricingMode(env);
  return {
    data_kind: "pricing",
    pricing_mode: mode,
    anonymous: { key_required: false, per_minute_per_ip: ANONYMOUS_PER_MINUTE, per_month: null, endpoints: ["check", "scan", "watch", "exposure"] },
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      per_minute: p.perMinute,
      per_month: p.perMonth,
      keys: p.keys,
      price_month_usd: p.priceMonthUsd,
      price_year_usd: p.priceYearUsd,
      available: p.id === "free" ? true : p.id === "enterprise" ? "contact" : mode === "paid",
    })),
    counting: { unit: "call", cached_answers_count: true, quota_period: "utc_calendar_month", quota_scope: "all_keys_of_one_owner", quota_lag_seconds_approx: 60 },
    at_limit: { status: 429, overage: "not_offered", surprise_charges: false },
    same_answers_on_every_plan: true,
    sla: false,
    key_header: "Authorization: Bearer forge_sk_…",
    keys_url: `${env.PUBLIC_ORIGIN}${KEYS_PATH}`,
    payments: { merchant_of_record: "Polar", card_details_on_this_site: false, invoice_contact: PRICING_CONTACT },
  };
}

const planRows = (mode: string) =>
  Object.values(PLANS).map(
    (p) => html`<tr><td data-label="Plan"><b>${p.name}</b></td><td data-label="Per minute" class="num">${n(p.perMinute)}</td><td data-label="Per month" class="num">${n(p.perMonth)}</td><td data-label="Keys" class="num">${p.keys}</td><td data-label="Price">${price(p)}${p.id !== "free" && p.id !== "enterprise" && mode !== "paid" ? html` <span class="muted">(coming soon)</span>` : ""}</td></tr>`,
  );

site.get(PRICING_PATH, async (c) => {
  const mode = pricingMode(c.env);
  if (mode === "off") return notFound(c, "Page not found", "That page doesn't exist.");
  if (wantsJson(c)) return c.json(pricingData(c.env), 200, { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", Vary: "Accept" });
  return send(c, {
    title: "Pricing",
    description: PRICING_WORDS.free,
    path: PRICING_PATH,
    jsonAlternate: `${PRICING_PATH}?format=json`,
    noindex: mode === "keys",
    body: html`<article class="prose pricing">
<p class="eyebrow">API pricing</p>
<h1 class="page-title">${PRICING_WORDS.heading}</h1>
<p class="lead">${PRICING_WORDS.free}</p>
${mode === "keys" ? html`<p class="notice">${PRICING_WORDS.comingSoon}</p>` : ""}

<h2>Plans</h2>
<div class="scroll-x"><table class="table stack"><thead><tr><th scope="col">Plan</th><th scope="col" class="num">Calls a minute (per key)</th><th scope="col" class="num">Calls a month</th><th scope="col" class="num">Keys</th><th scope="col">Price</th></tr></thead>
<tbody>${planRows(mode)}</tbody></table></div>
<p>A key is optional. With one, limits are counted per key instead of per IP address, which helps CI runners and shared networks, and you get a record of your usage on <a href="${KEYS_PATH}">your keys page</a>. Paid plans add higher limits, more keys and commercial terms (an invoice and a merchant of record that handles tax).</p>
<p><a class="btn primary chamfer" href="${KEYS_PATH}">Get a free key</a></p>

<h2>What counts as a call</h2>
<p>${PRICING_WORDS.counts}</p>
<h2>What happens at the limit</h2>
<p>${PRICING_WORDS.atLimit}</p>

<h2>What a plan doesn't change</h2>
<ul>
<li>${PRICING_WORDS.sameAnswers}</li>
<li>${PRICING_WORDS.notSafe}</li>
<li>${PRICING_WORDS.noSla}</li>
</ul>

<h2>Payments</h2>
<p>${PRICING_WORDS.payment}</p>
<p>${PRICING_WORDS.refund}</p>
<p class="small muted">${PRICING_WORDS.operator} Pilots and data licences for teams: <a href="/teams">/teams</a>. <a href="${PRICING_PATH}?format=json">JSON</a></p>
</article>`,
  });
});

// ------------------------------------------------------------------------------------------------------------------
// /dashboard/keys

const KEY_MESSAGES = {
  revoked: "Key revoked. Calls with it are refused within 30 seconds.",
  not_verified: "Only verified people can create keys. A GitHub account with little public activity starts in the sandbox until someone vouches for you.",
  key_limit: "You have the most keys your plan allows. Revoke one first.",
  name_invalid: `Give the key a name of 1 to ${KEY_NAME_MAX} characters.`,
  not_found: "Sign in again, then try once more.",
  checkout_done: "Thanks. Your plan changes as soon as Polar confirms the payment, usually within a minute.",
  billing_unavailable: "Billing isn't available right now. Try again later, or email " + PRICING_CONTACT + ".",
} as const;
type KeyMessage = keyof typeof KEY_MESSAGES;
const backTo = (m: KeyMessage) => new Response(null, { status: 303, headers: { Location: `${KEYS_PATH}?m=${m}` } });

const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");

async function keysPage(c: Ctx, shown: { key: string; name: string } | null) {
  const s = await currentSession(c);
  const mode = pricingMode(c.env);
  const m = c.req.query("m") as KeyMessage | undefined;
  const message = m && m in KEY_MESSAGES ? KEY_MESSAGES[m] : null;
  const base = { title: "API keys", description: "Create and revoke API keys for The Agent Forge.", path: KEYS_PATH, nav: "dashboard" as const, noindex: true };
  if (!s)
    return send(
      c,
      {
        ...base,
        body: html`<h1 class="page-title">API keys</h1>${message ? html`<p class="notice">${message}</p>` : ""}
<p>Sign in to create an API key. Keys are optional: checks work without one (<a href="${PRICING_PATH}">pricing</a>).</p>
<p><a class="btn primary chamfer" href="/auth/login?next=${encodeURIComponent(KEYS_PATH)}">Sign in with GitHub</a></p>`,
      },
      { cache: false },
    );
  const human = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  if (!human) return c.redirect("/dashboard");
  const now = Date.now();
  const planId = await planOf(c.env, human.id, now);
  const plan = PLANS[planId];
  const used = await monthUsed(c.env, human.id, now);
  const keys = await listKeys(c.env, human.id, now);
  const active = keys.filter((k) => k.revokedAt === null);
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const verified = human.tier === "verified";
  const resets = new Date(monthReset(now)).toISOString().slice(0, 10);
  return send(
    c,
    {
      ...base,
      // The paid-mode buttons post here and are redirected to Polar's hosted checkout or portal.
      formAction: mode === "paid" ? ["https://polar.sh", "https://*.polar.sh"] : undefined,
      body: html`<h1 class="page-title">API keys</h1>
${message ? html`<p class="notice">${message}</p>` : ""}
${shown
  ? html`<div class="notice success" role="status"><p><b>Your new key "${shown.name}".</b> Copy it now: it is shown only once, and we keep only a hash of it.</p>
<p><code class="breakable" data-copy>${shown.key}</code></p>
<p class="small">Send it as <code>Authorization: Bearer &lt;key&gt;</code> to the check, scan, watch and exposure endpoints or the public MCP server. Keep it out of code and logs; store it as a secret.</p></div>`
  : ""}
<p>Plan: <b>${plan.name}</b>. This month: <b>${used.toLocaleString("en-US")}</b> of ${n(plan.perMonth)} calls across your keys; resets ${resets} (UTC). Up to ${n(plan.perMinute)} calls a minute per key. <a href="${PRICING_PATH}">Pricing</a></p>
${mode === "paid" && verified
  ? html`<div class="row gap">${planId === "free" || planId === "team"
      ? PAID_PLAN_IDS.filter((p) => p !== planId).map(
          (p) => html`<form method="post" action="/billing/checkout" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="plan" value="${p}"><select name="interval" aria-label="Billing period"><option value="month">Monthly</option><option value="year">Yearly</option></select> <button class="btn chamfer" type="submit">Upgrade to ${PLANS[p].name}</button></form>`,
        )
      : ""}
${planId !== "free" ? html`<form method="post" action="/billing/portal" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Manage billing</button></form>` : ""}</div>`
  : ""}

<h2>Your keys</h2>
${keys.length
  ? html`<div class="scroll-x"><table class="table stack"><thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col" class="num">Calls this month</th><th scope="col"></th></tr></thead><tbody>
${keys.map(
  (k) => html`<tr><td data-label="Name">${k.name}</td><td data-label="Key"><code>${k.prefix}…</code></td><td data-label="Created">${date(k.createdAt)}</td><td data-label="Last used">${date(k.lastUsedAt)}</td><td data-label="Calls" class="num">${k.callsThisMonth.toLocaleString("en-US")}</td><td>${k.revokedAt
    ? html`<span class="muted">revoked ${date(k.revokedAt)}</span>`
    : html`<form method="post" action="${KEYS_PATH}/revoke" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${k.id}"><button class="btn small" type="submit">Revoke</button></form>`}</td></tr>`,
)}</tbody></table></div>`
  : html`<p class="empty">No keys yet.</p>`}

<h2>Create a key</h2>
${verified
  ? active.length >= plan.keys
    ? html`<p>${KEY_MESSAGES.key_limit}</p>`
    : html`<form method="post" action="${KEYS_PATH}" class="stack"><input type="hidden" name="csrf" value="${csrf}">
<label for="key-name">Name (for you, e.g. "CI" or "laptop")</label>
<input id="key-name" name="name" required maxlength="${KEY_NAME_MAX}" autocomplete="off">
<button class="btn primary chamfer" type="submit">Create key</button></form>`
  : html`<p>${KEY_MESSAGES.not_verified}</p>`}
<p class="small muted">Usage is recorded per key per day (calls and refusals), with no request contents. ${PRICING_WORDS.noSla}</p>`,
    },
    { cache: false },
  );
}

site.get(KEYS_PATH, async (c) => (pricingMode(c.env) === "off" ? notFound(c, "Page not found", "That page doesn't exist.") : keysPage(c, null)));

site.post(KEYS_PATH, async (c) => {
  if (pricingMode(c.env) === "off") return notFound(c, "Page not found", "That page doesn't exist.");
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const name = String(g.form.get("name") ?? "");
  const r = await createKey(c.env, g.session.h, name);
  if (!r.ok) return backTo(r.reason);
  // The key is rendered once, in this response, and never stored or logged.
  return keysPage(c, { key: r.key, name: name.trim() });
});

site.post(`${KEYS_PATH}/revoke`, async (c) => {
  if (pricingMode(c.env) === "off") return notFound(c, "Page not found", "That page doesn't exist.");
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  await revokeKey(c.env, g.session.h, String(g.form.get("id") ?? ""));
  return backTo("revoked");
});

// ------------------------------------------------------------------------------------------------------------------
// Polar: checkout, customer portal and webhook (PRICING_MODE paid only, except the webhook: see below)

site.post("/billing/checkout", async (c) => {
  if (pricingMode(c.env) !== "paid") return notFound(c, "Page not found", "That page doesn't exist.");
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const human = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, g.session.h), columns: { id: true, tier: true } });
  if (!human || human.tier !== "verified") return backTo("not_verified");
  const plan = String(g.form.get("plan") ?? "") as PaidPlanId;
  const interval = g.form.get("interval") === "year" ? "year" : "month";
  if (!PAID_PLAN_IDS.includes(plan)) return backTo("billing_unavailable");
  const url = await createCheckout(c.env, human.id, plan, interval).catch((e) => {
    console.error("polar_checkout_failed", String(e).slice(0, 120));
    return null;
  });
  return url ? new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } }) : backTo("billing_unavailable");
});

site.post("/billing/portal", async (c) => {
  if (pricingMode(c.env) !== "paid") return notFound(c, "Page not found", "That page doesn't exist.");
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const url = await createPortal(c.env, g.session.h).catch((e) => {
    console.error("polar_portal_failed", String(e).slice(0, 120));
    return null;
  });
  return url ? new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } }) : backTo("billing_unavailable");
});

/**
 * Polar's webhook. Live whenever POLAR_WEBHOOK_SECRET is set (404 without it), whatever PRICING_MODE says, so a plan
 * bought while switching modes is never lost. Signature, timestamp and replay checks in services/polar.ts.
 */
site.post(POLAR_WEBHOOK_PATH, async (c) => {
  const body = await c.req.text();
  if (body.length > 256 * 1024) return c.json({ error: "too_large" }, 413);
  const r = await handlePolarWebhook(c.env, c.req.raw.headers, body);
  return c.json(r.body, r.status as 200, { "Cache-Control": "no-store" });
});
