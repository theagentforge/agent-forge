import { bulkScanProgress, type BulkProgress } from "../services/bulk-scan-cron";
import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { monthlyCosts } from "../services/costs";
import { freeLaneUsage } from "../arena/free-lane";
import { currentSession } from "./dashboard";
import { send, site } from "./pages";

// AQ-08 (ADR 0097): /admin/costs, what the Forge costs to run this month by source, credits and their expiry, and
// whether the Arena is paused. Admins only, never cached, never indexed. Reads stored figures only (no provider call).

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "not yet measured" : `$${n.toFixed(2)}`);

/** One line on where the weekly bulk skill scan is (ADR 0112): counts and repository names only, never a result. */
export function bulkScanLine(b: BulkProgress): string {
  const n = (x: number) => x.toLocaleString("en-US");
  if (!b.pass) return `${b.enabled ? "On" : "Off"}; no pass started yet.`;
  const where =
    b.phase === "clawhub"
      ? `ClawHub catalogue: ${n(b.clawhub.pages_read)} pages listed, ${n(b.clawhub.queued)} skills queued, cursor ${b.clawhub.cursor_held ? "held" : b.clawhub.listed ? "at the end" : "at the start"}`
      : b.phase === "github"
        ? `GitHub: repository ${n(b.github.repo_index + 1)} of ${b.github.repos === null ? "?" : n(b.github.repos)}${b.github.current ? ` (${b.github.current.repo}, file ${n(b.github.current.next)} of ${n(b.github.current.files)})` : ""}`
        : `pass finished ${b.pass_done?.slice(0, 16).replace("T", " ")} UTC; next pass from ${b.next_pass?.slice(0, 16).replace("T", " ")} UTC`;
  const paused = Object.entries(b.paused).map(([h, t]) => `${h} until ${t.slice(11, 16)} UTC (Retry-After)`);
  return [
    `${b.enabled ? "On" : "Off"}. Pass ${b.pass}, started ${b.pass_started?.slice(0, 10)}; ${where}.`,
    `This week (${b.week}): ${n(b.week_read)} files read, ${n(b.week_added)} new skill files scanned, ${n(b.week_failed)} couldn't be read.`,
    b.last_run ? `Last run ${b.last_run.at.slice(0, 16).replace("T", " ")} UTC: ${n(b.last_run.read)} files in ${Math.round(b.last_run.ms / 1000)} s, stopped on ${b.last_run.stop}.` : "",
    paused.length ? `Paused: ${paused.join(", ")}.` : "",
    b.github.skipped.length ? `Left for next pass (tarball failed 3 times): ${b.github.skipped.join(", ")}.` : "",
    b.clawhub.error ? `ClawHub catalogue error this pass: ${b.clawhub.error}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

site.get("/admin/costs", async (c) => {
  const s = await currentSession(c);
  if (!s) return c.redirect("/dashboard");
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  if (!me || !isAdmin(c.env, me.githubId)) return c.redirect("/dashboard");
  const k = await monthlyCosts(c.env);
  const f = await freeLaneUsage(c.env);
  const b = await bulkScanProgress(c.env);
  if (c.req.query("format") === "json") return c.json({ ...k, free_lane: f, bulk_scan: b }, 200, { "Cache-Control": "no-store" });
  const n = (x: number) => x.toLocaleString("en-US");
  const a = k.anthropic_byok;
  const bt = k.by_task;
  return send(
    c,
    {
      title: "Costs",
      description: "Internal: monthly running costs.",
      path: "/admin/costs",
      noindex: true,
      body: html`<h1 class="page-title">Running costs, ${k.month}</h1>
<p>As of ${k.as_of}. Internal only. Figures come from stored bout costs and the last OpenRouter reading; nothing here calls a provider. <a href="/admin/costs?format=json">JSON</a></p>
${k.pause.notes.length ? html`<p class="notice warn">${k.pause.notes.join(" ")} Every public Arena page shows this note.</p>` : html`<p>Arena: <b>not paused</b>.</p>`}
<table class="kpi-table"><thead><tr><th>Source</th><th>This month</th><th>Detail</th></tr></thead><tbody>
<tr><td><b>Cloudflare</b> (Workers Paid)</td><td>$${k.cloudflare.plan_usd.toFixed(2)} plan fee; usage: ${usd(k.cloudflare.usage_usd)}</td><td>Usage above the included amounts isn't readable from the Worker (no Cloudflare API token, by design): run the GraphQL check in <code>docs/runbooks/cost-guard.md</code> with the Cloudflare connector, or see <a href="${k.cloudflare.billing_url}" rel="noopener">Cloudflare billing</a>. Ops mode: <b>${k.cloudflare.ops_mode}</b>.</td></tr>
<tr><td><b>OpenRouter</b> (prepaid credit)</td><td>${usd(k.openrouter.spent_month_usd)}</td><td>${k.openrouter.bouts_month} bouts this month. Credit left: ${usd(k.openrouter.remaining_usd)}${k.openrouter.reading_at ? ` (OpenRouter reading ${k.openrouter.reading_at}${k.openrouter.reading_ok === false ? ", last reading failed" : ""})` : " (no OpenRouter reading stored)"}; $${k.openrouter.purchased_usd} bought in total.</td></tr>
<tr><td><b>Anthropic</b> (BYOK, Claude Max API credit)</td><td>${usd(a.spent_month_usd)}</td><td>${usd(a.spent_since_start_usd)} of the $${a.allowance_usd} allowance used since ${a.started}; about ${usd(a.left_usd)} left. ${a.expired ? html`<b>Expired on ${a.expires}</b>: Claude bouts are paused.` : html`Expires <b>${a.expires}</b> (${a.days_left} days); unused credit is lost then.`} Burn over the last 7 days: ${usd(a.burn_per_day_usd)} a day; ${a.days_left_at_burn === null ? "days left at that rate: not yet measured (no spend recorded)" : html`at that rate the credit lasts <b>${a.days_left_at_burn} days</b>`}, so it runs until <b>${a.lasts_until}</b> (credit used up or expiry, whichever is first). Bouts and Moltbook replies; an estimate from OpenRouter's reported upstream cost; the Anthropic Console has the exact figure.</td></tr>
<tr><td><b>Workers AI</b> (Cloudflare)</td><td>${usd(k.workers_ai.estimated_month_usd)} (estimate)</td><td>${k.workers_ai.bouts_month} bouts this month, priced from list prices; billed with Cloudflare.</td></tr>
<tr><td><b>GitHub Actions</b></td><td>not measured here</td><td><a href="${k.github_actions.billing_url}" rel="noopener">GitHub billing and usage</a> (spending cap set there).</td></tr>
</tbody></table>
<h2 id="by-task">Model spend by task, ${k.month}</h2>
<p>Where the model money goes (ADR 0113). "Anthropic" is the Claude credit on our own key; "credit" is OpenRouter's prepaid credit; neurons are Workers AI (10,000 a day free, then $0.011 per 1,000).</p>
<table class="kpi-table"><thead><tr><th>Task</th><th>This month</th><th>Detail</th></tr></thead><tbody>
<tr><td><b>Arena: Claude</b> (Anthropic key)</td><td>${usd(bt.arena.claude_byok.anthropic_usd)} Anthropic</td><td>${bt.arena.claude_byok.bouts} bouts; ${usd(bt.arena.claude_byok.credit_usd)} billed to OpenRouter credit instead (should be $0.00).</td></tr>
<tr><td><b>Arena: other OpenRouter models</b></td><td>${usd(bt.arena.openrouter_credit.credit_usd)} credit</td><td>${bt.arena.openrouter_credit.bouts} bouts.</td></tr>
<tr><td><b>Arena: free variants</b></td><td>$0.00</td><td>${bt.arena.free_variants.bouts} bouts.</td></tr>
<tr><td><b>Arena: Workers AI practice</b></td><td>${usd(bt.arena.workers_ai_practice.estimated_usd)} (estimate)</td><td>${bt.arena.workers_ai_practice.bouts} bouts, about ${n(bt.arena.workers_ai_practice.neurons)} neurons.</td></tr>
<tr><td><b>Arena: Workers AI ranked</b></td><td>${usd(bt.arena.workers_ai_ranked.estimated_usd)} (estimate)</td><td>${bt.arena.workers_ai_ranked.bouts} bouts, about ${n(bt.arena.workers_ai_ranked.neurons)} neurons. Held at the day's total line unless a paid allowance is set (now ${n(f.workers_ai.paid_allowance)} neurons a day).</td></tr>
<tr><td><b>Moltbook replies</b></td><td>${usd(bt.moltbook_replies.anthropic_usd)} Anthropic</td><td>${n(bt.moltbook_replies.calls)} model calls; ${n(bt.moltbook_replies.neurons)} Workers AI neurons (fallback); ${usd(bt.moltbook_replies.credit_usd)} OpenRouter credit; prompt cache: ${n(bt.moltbook_replies.cached_tokens)} tokens read, ${n(bt.moltbook_replies.cache_write_tokens)} written.</td></tr>
<tr><td><b>Moltbook challenge solver</b></td><td>${n(bt.moltbook_challenge.neurons)} neurons</td><td>${n(bt.moltbook_challenge.calls)} model calls (most questions are solved in code).</td></tr>
<tr><td><b>Note moderation</b> (Llama Guard)</td><td>${n(bt.moderation.neurons)} neurons</td><td>${n(bt.moderation.calls)} model calls; identical notes reuse the earlier verdict.</td></tr>
</tbody></table>
<p class="small muted">${bt.ledger_note} Ops checks (tool selection, AI citations) report their own cost in their GitHub issues.</p>
<h2 id="free-lane">Free-model lane today (${f.day}, UTC)</h2>
<p>Practice bouts that must never be billed (ADR 0109). Caps are enforced before every request; both reset at 00:00 UTC.</p>
<table class="kpi-table"><thead><tr><th>Lane</th><th>Used today</th><th>Detail</th></tr></thead><tbody>
<tr><td><b>OpenRouter free variants</b></td><td>${n(f.openrouter_free.requests_today)} of ${n(f.openrouter_free.daily_max)} requests</td><td>${f.openrouter_free.paused ? html`<b>Paused until tomorrow</b>: ${f.openrouter_free.paused.reason} (${f.openrouter_free.paused.at}).` : "Running."} At most ${f.openrouter_free.per_minute_max} a minute. ${f.openrouter_free.bouts_today} bouts finished today on ${f.openrouter_free.models.join(", ") || "no models"}. Free variants never count against the paid-credit reserve.${f.openrouter_free.catalog_not_in_lane?.length ? html` Tool-capable free variants in the catalog but not in the lane: ${f.openrouter_free.catalog_not_in_lane.join(", ")}.` : ""}</td></tr>
<tr><td><b>Workers AI</b></td><td>${n(f.workers_ai.neurons_today)} of ${n(f.workers_ai.daily_max)} neurons (practice); total line ${n(f.workers_ai.total_max)}</td><td>${f.workers_ai.open ? "Practice running." : html`<b>Practice stopped for today.</b>`} ${f.workers_ai.ranked_open ? "Ranked bouts, Moltbook and moderation may still run." : html`<b>Total line reached: ranked bouts wait, Moltbook uses Claude or waits, notes wait.</b>`} Practice leaves ${n(f.workers_ai.ranked_reserve)} neurons for waiting ranked bouts. Counts every Workers AI call the Worker makes (Arena bouts of any kind, Moltbook, moderation), from Workers AI's reported neurons or the published rates; ${n(f.workers_ai.free_allocation)} a day are free on Workers Paid. ${f.workers_ai.bouts_today} practice bouts finished today on ${f.workers_ai.models.join(", ")}.</td></tr>
</tbody></table>
<h2 id="bulk-scan">Bulk skill scan (Worker cron)</h2>
<p>${bulkScanLine(b)}</p>
<p class="small muted">The Claude plan itself is the founder's own subscription and isn't counted here. Runbook: <code>docs/runbooks/cost-guard.md</code>.</p>`,
    },
    { cache: false },
  );
});
