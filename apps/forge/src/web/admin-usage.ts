import { isPlanId, PLANS } from "@forge/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { deleteApiData, flushApiUsage, forgetOwner, monthStart, planOf, pricingMode } from "../services/api-keys";
import { customerPseudonyms, mrrScheduleCsv, revenueData, revenueSummary } from "../services/api-revenue";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { polarReady } from "../services/polar";
import { currentSession, guardPost } from "./dashboard";
import { csrfToken } from "./session";
import { send, site } from "./pages";

// ADR 0110: /admin/usage, API keys and plans for the founder. Usage by owner and plan, keyed calls by day, revenue
// (MRR, paying organisations, concentration) with House and founder accounts left out, the MRR schedule CSV for the
// data room (pilot revenue in its own column, never MRR), and a form for invoiced plans and pilot payments. Admins
// only, never cached, never indexed.

type Ctx = Context<{ Bindings: Env }>;
export const ADMIN_USAGE_PATH = "/admin/usage";

async function admin(c: Ctx) {
  const s = await currentSession(c);
  if (!s) return null;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return me && isAdmin(c.env, me.githubId) ? { me, s } : null;
}

export async function usageData(env: Env, now = Date.now()) {
  // This isolate's unwritten counts first, so the page matches what has been served.
  await flushApiUsage(env, now);
  const db = getDb(env);
  const month = monthStart(now);
  const since = new Date(now - 13 * 86_400_000).toISOString().slice(0, 10);
  const keys = await db.select({ total: sql<number>`count(*)`, active: sql<number>`sum(case when ${t.apiKeys.revokedAt} is null then 1 else 0 end)` }).from(t.apiKeys).get();
  const byDay = await db
    .select({ day: t.apiUsageDaily.day, n: sql<number>`sum(${t.apiUsageDaily.n})`, n429: sql<number>`sum(${t.apiUsageDaily.n429})` })
    .from(t.apiUsageDaily)
    .where(sql`${t.apiUsageDaily.day} >= ${since}`)
    .groupBy(t.apiUsageDaily.day)
    .orderBy(desc(t.apiUsageDaily.day));
  const sources = await db
    .select({ day: t.checkSources.day, n: sql<number>`count(*)` })
    .from(t.checkSources)
    .where(sql`${t.checkSources.day} >= ${since}`)
    .groupBy(t.checkSources.day);
  const sourcesByDay = new Map(sources.map((s) => [s.day, Number(s.n)]));
  const owners = await db
    .select({
      humanId: t.apiUsageDaily.humanId,
      login: t.humans.githubLogin,
      n: sql<number>`sum(${t.apiUsageDaily.n})`,
      n429: sql<number>`sum(${t.apiUsageDaily.n429})`,
    })
    .from(t.apiUsageDaily)
    .innerJoin(t.humans, eq(t.humans.id, t.apiUsageDaily.humanId))
    .where(sql`${t.apiUsageDaily.day} >= ${month}`)
    .groupBy(t.apiUsageDaily.humanId)
    .orderBy(desc(sql`sum(${t.apiUsageDaily.n})`));
  const lastUsed = await db.select({ humanId: t.apiKeys.humanId, at: sql<number>`max(${t.apiKeys.lastUsedAt})`, keys: sql<number>`sum(case when ${t.apiKeys.revokedAt} is null then 1 else 0 end)` }).from(t.apiKeys).groupBy(t.apiKeys.humanId);
  const lastBy = new Map(lastUsed.map((l) => [l.humanId, l]));
  const subs = await db.select().from(t.apiSubscriptions).orderBy(desc(t.apiSubscriptions.updatedAt));
  const subBy = new Map<string, (typeof subs)[number]>();
  for (const s of subs) if (!subBy.has(s.humanId)) subBy.set(s.humanId, s);
  const perOwner = await Promise.all(
    owners.map(async (o) => {
      const plan = PLANS[await planOf(env, o.humanId, now)];
      const sub = subBy.get(o.humanId);
      return {
        login: o.login,
        plan: plan.id,
        provider: sub?.provider ?? null,
        status: sub?.status ?? null,
        calls_this_month: Number(o.n),
        quota_pct: plan.perMonth ? Math.round((Number(o.n) / plan.perMonth) * 1000) / 10 : null,
        refused_429_this_month: Number(o.n429),
        active_keys: Number(lastBy.get(o.humanId)?.keys ?? 0),
        last_used: lastBy.get(o.humanId)?.at ? new Date(Number(lastBy.get(o.humanId)!.at)).toISOString() : null,
      };
    }),
  );
  const rev = await revenueData(env);
  return {
    as_of: new Date(now).toISOString(),
    pricing_mode: pricingMode(env),
    polar: polarReady(env),
    keys: { total: Number(keys?.total ?? 0), active: Number(keys?.active ?? 0) },
    keyed_owners_this_month: owners.length,
    by_day: byDay.map((d) => ({ day: d.day, keyed_calls: Number(d.n), keyed_429: Number(d.n429), distinct_check_sources_all: sourcesByDay.get(d.day) ?? 0 })),
    owners: perOwner,
    subscriptions: subs.map((s) => ({ plan: s.plan, provider: s.provider, interval: s.billingInterval, status: s.status, started: new Date(s.startedAt).toISOString().slice(0, 10), period_end: s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toISOString().slice(0, 10) : null, ended: s.endedAt ? new Date(s.endedAt).toISOString().slice(0, 10) : null, human_id: s.humanId })),
    revenue: revenueSummary(rev.subs, rev.pilots, rev.excluded, now),
    pilots: rev.pilots.map((p) => ({ customer: p.customer, amount_usd: p.amountCents / 100, received_on: p.receivedOn })),
  };
}

const MSG = {
  plan_saved: "Invoiced plan saved.",
  plan_ended: "Invoiced plan ended.",
  pilot_saved: "Pilot payment recorded.",
  invalid: "Check the fields and try again.",
  no_such_owner: "Nobody with that GitHub username has signed in yet.",
  api_data_deleted: "API keys and usage records deleted. Paid-plan rows, if any, are kept as tax records.",
} as const;
type Msg = keyof typeof MSG;
const back = (m: Msg) => new Response(null, { status: 303, headers: { Location: `${ADMIN_USAGE_PATH}?m=${m}` } });

site.get(ADMIN_USAGE_PATH, async (c) => {
  const a = await admin(c);
  if (!a) return c.redirect("/dashboard");
  const d = await usageData(c.env);
  if (c.req.query("format") === "json") return c.json(d, 200, { "Cache-Control": "no-store" });
  const r = d.revenue;
  const m = c.req.query("m") as Msg | undefined;
  const csrf = await csrfToken(c.env.SESSION_SECRET, a.s.token);
  const pct = (v: number | null) => (v === null ? "not yet measured" : `${Math.round(v * 1000) / 10}%`);
  return send(
    c,
    {
      title: "API usage",
      description: "Internal: API keys, plans and revenue.",
      path: ADMIN_USAGE_PATH,
      noindex: true,
      body: html`<h1 class="page-title">API usage and plans</h1>
${m && m in MSG ? html`<p class="notice">${MSG[m]}</p>` : ""}
<p>As of ${d.as_of}. Internal only. PRICING_MODE <b>${d.pricing_mode}</b>. Polar set up: access token ${d.polar.access_token ? "yes" : "no"}, webhook secret ${d.polar.webhook_secret ? "yes" : "no"}, products ${d.polar.products ? "yes" : "no"}. <a href="${ADMIN_USAGE_PATH}?format=json">JSON</a> · <a href="${ADMIN_USAGE_PATH}/mrr.csv">MRR schedule CSV</a></p>

<h2>Revenue (outside owners only)</h2>
<table class="kpi-table"><tbody>
<tr><td>MRR (monthly at face value, annual ÷ 12)</td><td>US$${r.mrr_usd.toFixed(2)}</td></tr>
<tr><td>Paying organisations</td><td>${r.paying_organisations}</td></tr>
<tr><td>New this month / churned this month</td><td>${r.new_this_month} / ${r.churned_this_month}</td></tr>
<tr><td>Contraction this month</td><td>${r.contraction_this_month}</td></tr>
<tr><td>Top customer / top two, share of MRR</td><td>${pct(r.top1_share)} / ${pct(r.top2_share)}</td></tr>
<tr><td>Pilot revenue received this month (not MRR)</td><td>US$${r.pilot_revenue_this_month_usd.toFixed(2)}</td></tr>
<tr><td>House or founder subscriptions left out</td><td>${r.excluded_house_or_founder_subscriptions}</td></tr>
</tbody></table>

<h2>Keys</h2>
<p>${d.keys.active} active of ${d.keys.total} created; ${d.keyed_owners_this_month} owners made keyed calls this month.</p>
<div class="scroll-x"><table class="kpi-table"><thead><tr><th>Day (UTC)</th><th>Keyed calls</th><th>Keyed 429s</th><th>Distinct check sources (all callers)</th></tr></thead><tbody>
${d.by_day.length ? d.by_day.map((x) => html`<tr><td>${x.day}</td><td>${x.keyed_calls}</td><td>${x.keyed_429}</td><td>${x.distinct_check_sources_all}</td></tr>`) : html`<tr><td colspan="4">No keyed calls in the last 14 days.</td></tr>`}
</tbody></table></div>

<h2>By owner, this month</h2>
<div class="scroll-x"><table class="kpi-table"><thead><tr><th>Owner</th><th>Plan</th><th>Provider</th><th>Status</th><th>Calls</th><th>Quota used</th><th>429s</th><th>Active keys</th><th>Last used</th></tr></thead><tbody>
${d.owners.length ? d.owners.map((o) => html`<tr><td>${o.login}</td><td>${o.plan}</td><td>${o.provider ?? "–"}</td><td>${o.status ?? "–"}</td><td>${o.calls_this_month}</td><td>${o.quota_pct === null ? "–" : `${o.quota_pct}%`}</td><td>${o.refused_429_this_month}</td><td>${o.active_keys}</td><td>${o.last_used ?? "never"}</td></tr>`) : html`<tr><td colspan="9">No keyed calls this month.</td></tr>`}
</tbody></table></div>

<h2>Invoiced plan</h2>
<p class="small">For a customer who pays by invoice (provider "invoice"). Polar plans are set only by Polar's webhook.</p>
<form method="post" action="${ADMIN_USAGE_PATH}/plan" class="stack"><input type="hidden" name="csrf" value="${csrf}">
<label>GitHub username <input name="login" required maxlength="39"></label>
<label>Plan <select name="plan"><option>team</option><option>volume</option><option>enterprise</option><option value="end">end the invoiced plan</option></select></label>
<label>Billing <select name="interval"><option>year</option><option>month</option></select></label>
<label>Price per period, US$ (blank = list price) <input name="price" inputmode="decimal" maxlength="10"></label>
<label>Period start <input name="start" type="date"></label>
<label>Period end <input name="end" type="date"></label>
<button class="btn chamfer" type="submit">Save</button></form>

<h2>Pilot payment (services, never MRR)</h2>
<form method="post" action="${ADMIN_USAGE_PATH}/pilot" class="stack"><input type="hidden" name="csrf" value="${csrf}">
<label>Organisation <input name="customer" required maxlength="120"></label>
<label>Amount received, US$ <input name="amount" required inputmode="decimal" maxlength="10"></label>
<label>Received on <input name="received" type="date" required></label>
<label>Note <input name="note" maxlength="200"></label>
<button class="btn chamfer" type="submit">Record</button></form>
<h2>Account deletion request</h2>
<p class="small">When someone asks for their account to be deleted (Privacy, "Deleting your account"): deletes their API keys and daily usage records. Paid-plan rows stay as tax records, with no key data.</p>
<form method="post" action="${ADMIN_USAGE_PATH}/delete-api-data" class="stack"><input type="hidden" name="csrf" value="${csrf}">
<label>GitHub username <input name="login" required maxlength="39"></label>
<button class="btn chamfer" type="submit">Delete their API data</button></form>
${d.pilots.length ? html`<ul>${d.pilots.map((p) => html`<li>${p.received_on}: ${p.customer}, US$${p.amount_usd.toFixed(2)}</li>`)}</ul>` : ""}`,
    },
    { cache: false },
  );
});

site.get(`${ADMIN_USAGE_PATH}/mrr.csv`, async (c) => {
  const a = await admin(c);
  if (!a) return c.redirect("/dashboard");
  const rev = await revenueData(c.env);
  const names = await customerPseudonyms(c.env, rev.subs.map((s) => s.humanId));
  const csv = mrrScheduleCsv(rev.subs, rev.pilots, (h) => names.get(h) ?? "cust_unknown");
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="forge-api-mrr-schedule.csv"', "Cache-Control": "no-store" } });
});

const dollarsToCents = (v: unknown) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
};
const dateMs = (v: unknown) => {
  const s = String(v ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? Date.parse(`${s}T00:00:00Z`) : null;
};

site.post(`${ADMIN_USAGE_PATH}/plan`, async (c) => {
  const a = await admin(c);
  const g = a ? await guardPost(c) : null;
  if (!a || !g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  const login = String(g.form.get("login") ?? "").trim();
  const human = await db.query.humans.findFirst({ where: sql`lower(${t.humans.githubLogin}) = lower(${login})` });
  if (!human) return back("no_such_owner");
  const now = Date.now();
  const id = `invoice:${human.id}`;
  const plan = String(g.form.get("plan") ?? "");
  const existing = await db.query.apiSubscriptions.findFirst({ where: eq(t.apiSubscriptions.id, id) });
  if (plan === "end") {
    if (!existing) return back("invalid");
    await db.update(t.apiSubscriptions).set({ status: "ended", endedAt: now, updatedAt: now }).where(eq(t.apiSubscriptions.id, id));
    await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `admin:${a.me.id}`, action: "api_plan_changed", target: `human:${human.id}`, detail: { provider: "invoice", status: "ended", before: { plan: existing.plan } }, createdAt: now });
    forgetOwner(human.id);
    return back("plan_ended");
  }
  const price = dollarsToCents(g.form.get("price"));
  const start = dateMs(g.form.get("start")) ?? now;
  const end = dateMs(g.form.get("end"));
  if (!isPlanId(plan) || plan === "free" || Number.isNaN(price) || (end !== null && end <= start)) return back("invalid");
  const interval = g.form.get("interval") === "month" ? "month" : "year";
  const values = { humanId: human.id, plan, provider: "invoice", billingInterval: interval, priceCents: price, status: "active", currentPeriodStart: start, currentPeriodEnd: end, startedAt: existing?.startedAt ?? start, endedAt: null, updatedAt: now };
  if (existing) await db.update(t.apiSubscriptions).set(values).where(eq(t.apiSubscriptions.id, id));
  else await db.insert(t.apiSubscriptions).values({ id, ...values });
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `admin:${a.me.id}`, action: "api_plan_changed", target: `human:${human.id}`, detail: { provider: "invoice", plan, interval, price_cents: price, before: existing ? { plan: existing.plan, status: existing.status } : null }, createdAt: now });
  forgetOwner(human.id);
  return back("plan_saved");
});

site.post(`${ADMIN_USAGE_PATH}/pilot`, async (c) => {
  const a = await admin(c);
  const g = a ? await guardPost(c) : null;
  if (!a || !g) return c.text("Forbidden", 403);
  const customer = String(g.form.get("customer") ?? "").trim().slice(0, 120);
  const cents = dollarsToCents(g.form.get("amount"));
  const received = String(g.form.get("received") ?? "");
  if (!customer || cents === null || Number.isNaN(cents) || cents <= 0 || dateMs(received) === null) return back("invalid");
  const note = String(g.form.get("note") ?? "").trim().slice(0, 200) || null;
  const now = Date.now();
  await getDb(c.env).insert(t.pilotRevenue).values({ id: crypto.randomUUID(), customer, amountCents: cents, receivedOn: received, note, createdAt: now, createdBy: `admin:${a.me.id}` });
  await getDb(c.env).insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `admin:${a.me.id}`, action: "pilot_revenue_recorded", target: `pilot:${customer.slice(0, 60)}`, detail: { amount_cents: cents, received_on: received }, createdAt: now });
  return back("pilot_saved");
});


site.post(`${ADMIN_USAGE_PATH}/delete-api-data`, async (c) => {
  const a = await admin(c);
  const g = a ? await guardPost(c) : null;
  if (!a || !g) return c.text("Forbidden", 403);
  const login = String(g.form.get("login") ?? "").trim();
  const human = await getDb(c.env).query.humans.findFirst({ where: sql`lower(${t.humans.githubLogin}) = lower(${login})` });
  if (!human) return back("no_such_owner");
  await deleteApiData(c.env, human.id, `admin:${a.me.id}`);
  return back("api_data_deleted");
});
