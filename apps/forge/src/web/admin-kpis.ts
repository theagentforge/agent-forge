import { and, asc, count, eq, gte, like } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { dataInventory, growthKpis, PARTNER_STAGES, PARTNERS_KV, CITATIONS_KV, type PartnerContact, type PartnerStage, type Citation, type Kpi } from "../services/kpis";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";
import type { OwnerFunnel } from "../services/owner-funnel";
import { ownerActivity, type OwnerActivity, type ownersBySource } from "../services/owners";
import { ACTIVE_OWNERS_RULE, outsideStatsData, smallRows } from "./stats";
import { connectChecksToday } from "./connect";
import { gateHeadline, HEADLINE_RULES, headlineSplits, STATS_RULES_VERSION, type HeadlineKey, type Split } from "../services/public-stats";
import { BYOK_EXPIRES, byokSpendThisMonth, creditGuard, FILLER_MODELS, OPENROUTER_CREDIT_PURCHASED_USD, type CreditGuard } from "../arena/credit";

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "not yet measured" : `$${n.toFixed(2)}`);

/** ADR 0064: OpenRouter credit, the reserve, the guard and Anthropic BYOK spend. Internal only. */
export function creditPanel(g: CreditGuard, byok: Awaited<ReturnType<typeof byokSpendThisMonth>>) {
  const state = g.state === "paused" ? "paused: credit" : g.state === "open" ? "open" : "off (no OpenRouter key)";
  const r = g.reserve;
  return html`<h2 id="credit">Arena credit (ADR 0064)</h2>
<table class="kpi-table"><tbody>
<tr><td>Credit guard</td><td><b>${state}</b>${g.state === "paused" ? html`<br><small>New practice and longitudinal-panel bouts on non-Claude OpenRouter models wait. The weekly headline, other ranked events, held studies and bouts already started carry on. Claude (BYOK) and Workers AI bouts are never paused by this guard.</small>` : ""}</td></tr>
<tr><td>OpenRouter credit left (estimate)</td><td>${usd(g.remaining)} <small>(${g.source === "openrouter_key_api" ? html`OpenRouter key API, read ${g.checked_at ?? "–"}${g.reading_ok ? "" : html`; last reading failed: ${g.snapshot?.error ?? ""}`}, less ${usd(g.spent_since_reading)} spent by bouts since` : html`no OpenRouter reading yet: $${OPENROUTER_CREDIT_PURCHASED_USD} bought less stored bout costs`})</small></td></tr>
<tr><td>Reserve kept back</td><td>${usd(r.total)} <small>= (next two weekly bouts ${usd(r.weekly)} + held studies queued ${usd(r.held)} + contamination test 1 not yet queued ${usd(r.contamination_test_1)}) × ${r.safety}; per bout: ${Object.entries(r.per_bout).map(([m, v]) => `${m} $${v.toFixed(4)}`).join(", ") || "–"}</small></td></tr>
<tr><td>Anthropic BYOK spend this month (estimate)</td><td>${usd(byok.usd)} <small>from stored bout costs since ${byok.since} (${byok.claude_bouts} Claude bouts; ${byok.without_byok_cost} without a BYOK cost reported, which can't be separated)${g.snapshot?.byok_usage_monthly !== null && g.snapshot?.byok_usage_monthly !== undefined ? html`; OpenRouter's own BYOK figure this month: $${g.snapshot.byok_usage_monthly.toFixed(2)}` : ""}. Credits expire ${new Date(BYOK_EXPIRES).toISOString().slice(0, 10)}. Check the cost column in the Anthropic Console for the exact figure.</small></td></tr>
<tr><td>BYOK fallback seen</td><td>${g.byok_fallback ? html`<b>yes</b>, ${g.byok_fallback.model} at ${g.byok_fallback.at}: a Claude bout was billed to OpenRouter credit, so Claude counts as a credit spender for 24 hours` : "no"}</td></tr>
<tr><td>Model-agnostic filler</td><td>${FILLER_MODELS.join(", ")} (BYOK), then the Workers AI practice models</td></tr>
</tbody></table>`;
}
import { INSTALL_CLIENT_NAMES, INSTALL_CLIENTS, INSTALL_OUTCOMES, installTotals, type InstallTotals } from "../services/install-metrics";
import { ID_CLIENTS, installReturnsData, RETURN_DAYS, type Cohort, type InstallReturns } from "../services/install-ids";
import { landingFunnel, LANDING_STAGES, type LandingFunnel } from "../services/landing-funnel";
import { privateWorkflow, verifyActionsToken, type OidcClaims } from "../services/house";
import { growthStats } from "../services/growth";

const measured = (n: number | null) => (n === null ? "not yet measured" : n.toLocaleString("en-US"));

/** ADR 0055: the owner funnel (D11), from a finished Gauntlet run to a verified owner. Internal only. */
function ownerFunnelPanel(f: OwnerFunnel | undefined) {
  if (!f) return "";
  const st = f.stages;
  const rows: [string, number | null][] = [
    ["Gauntlet runs finished (six jobs)", st.runs_finished],
    ["Claim link shown (end-of-run result)", st.claim_link_shown],
    ["Claim page opened (views)", st.claim_page_opened],
    ["Runs claimed (verified owners outside the project)", st.claimed],
    ["Verified owners who claimed", st.verified_owners_claimed],
    // Review (ADR 0085): Sprints apart, never added to the six-job stages.
    ["Gauntlet Sprints finished (one job; House Sprints included)", f.sprints?.finished ?? null],
    ["Sprint claim link shown", f.sprints?.claim_link_shown ?? null],
    ["Sprints claimed (verified owners outside the project)", f.sprints?.claimed ?? null],
  ];
  return html`<h2>Owner funnel (D11)</h2>
<p><small>Last ${f.window.days} full UTC days (${f.window.from} to ${f.window.to}). Target: 100 verified owners by 31 Dec, agents per owner close to 1.</small></p>
<table class="kpi-table"><tbody>${rows.map(([k, v]) => html`<tr><td>${k}</td><td>${measured(v)}</td></tr>`)}
<tr><td>Verified owners now (all time)</td><td>${f.verified_owners}</td></tr>
<tr><td>Agents per owner</td><td>${f.agents_per_owner ?? "–"} (${f.verified_agents} agents; ${f.web_claim_profiles} profiles made at claim time)</td></tr>
<tr><td>Season 1 entrants (since ${f.season.starts_at})</td><td>${f.season.entrants} owners, ${f.season.entries} runs</td></tr>
<tr><td>Claim page by source</td><td>${Object.entries(f.claim_page_by_source).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}</td></tr>
<tr><td>Claims on a new profile · refused (not verified)</td><td>${measured(f.claims_on_new_profiles)} · ${measured(f.refused_not_verified)}</td></tr>
</tbody></table>
<ul>${f.notes.map((n) => html`<li><small>${n}</small></li>`)}</ul>`;
}

/** ADR 0073 (OA-01, OA-06): owners by source, active owners and the connected / web-only split. Internal only. */
export function ownersPanel(active: Kpi | undefined, sources: Kpi | undefined) {
  if (!active || !sources) return "";
  const a = active.detail as unknown as OwnerActivity & { pending_claims: number; pending_claim_people: number; review_requests_open: number };
  const src = sources.detail as unknown as Awaited<ReturnType<typeof ownersBySource>>;
  const list = (o: Record<string, number>) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet";
  return html`<h2 id="owners">Owners: where they came from, and whether they stay (OA-01)</h2>
<table class="kpi-table"><tbody>
<tr><td>Owners now · active in the last 30 days</td><td><b>${a.owners}</b> · <b>${a.active}</b></td></tr>
<tr><td>Connected an app (OAuth) · of them active</td><td>${a.connected.owners} · ${a.connected.active}</td></tr>
<tr><td>Web-only (a website report or a claim profile) · of them active</td><td>${a.web_only.owners} · ${a.web_only.active}</td></tr>
<tr><td>New owners by source, last ${src.window.days} full days (${src.window.from} to ${src.window.to})</td><td>${src.total === null ? "not yet measured" : list(src.by_source)}</td></tr>
<tr><td>New owners by source, all time</td><td>${src.measured_since ? html`${list(src.all_time_by_source)} <small>(counted since ${src.measured_since})</small>` : "not yet measured"}</td></tr>
<tr><td>Pending claims (not verified yet; not counted)</td><td>${a.pending_claims} from ${a.pending_claim_people} ${a.pending_claim_people === 1 ? "person" : "people"}</td></tr>
<tr><td>Review requests waiting</td><td>${a.review_requests_open} · <a href="/admin/owners">open the queue</a></td></tr>
</tbody></table>
<p><small>${a.definition} People who were owners before this tracking went live have no source and are not counted as new.</small></p>`;
}

/**
 * ADR 0067 Amendment 1 (Dinike, 28 Oct): the outside-only figures, internal only. The exact third-party number is shown
 * here (admins only), next to what a public headline would have shown under the old ADR 0067 minimum.
 */
export async function thirdPartyData(env: Env, now = Date.now()) {
  const [splits, owners, page, checksToday, install, returns] = await Promise.all([headlineSplits(env), ownerActivity(env, now, 30, false), outsideStatsData(env).catch(() => null), connectChecksToday(env, now).catch(() => null), installTotals(env, now).catch(() => null), installReturnsData(env, now).catch(() => null)]);
  return {
    internal_only: true as const,
    rules_version: STATS_RULES_VERSION,
    splits,
    headline: gateHeadline(splits, env.PUBLIC_ORIGIN),
    rules: [...HEADLINE_RULES.map(({ short: _s, ...r }) => r), ACTIVE_OWNERS_RULE],
    active_owners_30d: owners.active,
    owners: owners.owners,
    /** F-02 (ADR 0082): what /stats, /connect and the dashboard used to show publicly, outside-only. */
    stats_page: page,
    connect_check_sources_today: checksToday,
    /** B2-06 (ADR 0086): install checks, gross, ours and outside (gross less ours), by client. Never public. */
    install: install ? { ...install, outside: installOutside(install) } : null,
    /** B3-09 (ADR 0103): return cohorts from the anonymous install IDs, outside-only with ours apart. Never public. */
    install_returns: returns,
    generated_at: new Date(now).toISOString(),
  };
}

/** Gross less our own tagged callers: the outside install numbers (internal only). */
export function installOutside(v: InstallTotals) {
  const minus = (w: "all_time" | "last_7_days") => Object.fromEntries(INSTALL_OUTCOMES.map((o) => [o, Math.max(0, v.gross[w][o] - v.ours[w][o])])) as Record<(typeof INSTALL_OUTCOMES)[number], number>;
  return { all_time: minus("all_time"), last_7_days: minus("last_7_days") };
}

/** B2-06 (ADR 0086): install checks by client, with the outside split and distinct sources. Internal only. */
export function installPanel(v: (InstallTotals & { outside: ReturnType<typeof installOutside> }) | null, sources: Record<string, { external_exact: number; house: number }> | null) {
  if (!v) return "";
  const cell = (r: Record<string, number>) => INSTALL_OUTCOMES.map((o) => r[o]!.toLocaleString("en-US")).join(" · ");
  return html`<h2 id="install">Install checks (B2-06): outside split, internal</h2>
<p><small>Checked · would block · advisory. Gross is what /stats shows; outside is gross less our tagged CI and repositories (<code>install:ours:*</code>). The outside numbers are never shown publicly (Dinike, 28 Oct). Distinct sources today come from check_sources (the plugin, the CLI and its hooks, and the Action; daily-salted codes, never an IP).</small></p>
<table class="kpi-table"><thead><tr><th>Client</th><th>Last 7 days (gross)</th><th>All time (gross)</th></tr></thead><tbody>
${INSTALL_CLIENTS.map((c) => html`<tr data-client="${c}"><td>${INSTALL_CLIENT_NAMES[c]}</td><td>${cell(v.by_client[c].last_7_days)}</td><td>${cell(v.by_client[c].all_time)}</td></tr>`)}
<tr><td><b>All clients, gross</b></td><td>${cell(v.gross.last_7_days)}</td><td>${cell(v.gross.all_time)}</td></tr>
<tr><td>Ours (tagged)</td><td>${cell(v.ours.last_7_days)}</td><td>${cell(v.ours.all_time)}</td></tr>
<tr data-k="install_outside"><td><b>Outside</b></td><td><b>${cell(v.outside.last_7_days)}</b></td><td><b>${cell(v.outside.all_time)}</b></td></tr>
${sources ? html`<tr><td>Distinct outside sources today: plugin · CLI and hooks · Action</td><td colspan="2">${(["plugin_check_sources", "cli_check_sources", "ci_check_sources"] as const).map((k) => (sources[k]?.external_exact ?? 0).toLocaleString("en-US")).join(" · ")}</td></tr>` : ""}
</tbody></table>`;
}

/** B3-04 (ADR 0099): every public /stats row with a minimum, its exact gross value and whether /stats shows it. */
export function smallRowsPanel(rows: Awaited<ReturnType<typeof smallRows>>) {
  return html`<h2 id="small-rows">Small /stats rows (B3-04, ADR 0099)</h2>
<p><small>Gross numbers (our own accounts and tests included). Below its minimum a row is left out of /stats, /stats.json and /api/v1/stats with no note; it appears by itself once it passes. Every row is shown here and in the data room.</small></p>
<table class="kpi-table"><thead><tr><th>Row</th><th>Now (gross)</th><th>Minimum</th><th>On /stats</th></tr></thead><tbody>
${rows.map((r) => html`<tr data-small-row="${r.key}"><td>${r.label}</td><td>${r.value === null ? "–" : r.value.toLocaleString("en-US")}</td><td>${r.minimum}</td><td>${r.shown ? "shown" : "hidden"}</td></tr>`)}
</tbody></table>`;
}

const cohortCell = (c: Cohort) => (c.eligible === 0 ? html`<small>not yet measured</small>` : html`<b>${c.pct}%</b> <small>(${c.returned} of ${c.eligible})</small>`);

/** B3-09 (ADR 0103): return cohorts (day 1, 7, 30) per client, outside and ours, and the install step table. Internal only. */
export function installReturnsPanel(r: InstallReturns | null) {
  if (!r) return "";
  const row = (label: string, g: InstallReturns["outside"], k?: string) =>
    html`<tr${k ? html` data-k="${k}"` : ""}><td>${label}</td><td>${g.ids.toLocaleString("en-US")}</td>${RETURN_DAYS.map((d) => html`<td>${cohortCell(g[`d${d}`])}</td>`)}</tr>`;
  return html`<h2 id="returns">Install path: return cohorts (B3-09)</h2>
<p><small>${r.definition} As of ${r.as_of}. Internal only.</small></p>
<table class="kpi-table"><thead><tr><th>Group</th><th>Install IDs</th>${RETURN_DAYS.map((d) => html`<th>Day ${d} return</th>`)}</tr></thead><tbody>
${ID_CLIENTS.map((c) => row(`${INSTALL_CLIENT_NAMES[c]} (outside)`, r.by_client[c], `returns_${c}`))}
${row("All clients, outside", r.outside, "returns_outside")}
${row("Ours (tagged CI, House and repositories)", r.ours, "returns_ours")}
</tbody></table>
<table class="kpi-table funnel-table" id="install-steps"><thead><tr><th>Step (outside)</th><th>Install IDs</th><th>Of the IDs old enough</th></tr></thead><tbody>
${r.steps.map((s, i) => html`<tr data-step="${s.key}"><td><b>${i + 1}. ${s.label}</b><br><small>${s.definition}</small></td><td>${s.n === null ? "not yet measured" : s.n.toLocaleString("en-US")}</td><td>${s.pct === null ? "–" : `${s.pct}%${s.base !== null && s.key !== "first_check" ? ` of ${s.base}` : ""}`}</td></tr>`)}
</tbody></table>
<p><b>Biggest drop (install path):</b> ${r.biggest_drop ?? "not enough data yet"}</p>`;
}

export function thirdPartyPanel(d: Awaited<ReturnType<typeof thirdPartyData>>) {
  const row = (k: HeadlineKey, s: Split) => {
    const r = HEADLINE_RULES.find((x) => x.key === k)!;
    return html`<tr><td>${r.label}<br><small>${r.counts}</small></td><td><b>${s.third_party.toLocaleString("en-US")}</b></td><td>${s.ours.toLocaleString("en-US")}</td><td>${s.unattributed === undefined ? "–" : s.unattributed.toLocaleString("en-US")}</td></tr>`;
  };
  return html`<h2 id="third-party">Outside-only numbers (internal, ADR 0067 Amendment 1)</h2>
<p><small>Activity by people and agents outside the project: House, founder accounts, our tagged tests, the launch-scan seed and the Forge's own Arena bouts left out. Not shown publicly since 28 Oct (Dinike); public pages show the totals. Rules and SQL: <code>HEADLINE_RULES</code> in services/public-stats.ts. JSON: <a href="/admin/stats/third-party.json">/admin/stats/third-party.json</a>.</small></p>
<table class="kpi-table"><thead><tr><th>Counter</th><th>Outside</th><th>Ours</th><th>Unattributed</th></tr></thead><tbody>
${(Object.keys(d.splits) as HeadlineKey[]).map((k) => row(k, d.splits[k]))}
<tr><td>Active owners, last 30 days (outside the project)</td><td><b>${d.active_owners_30d}</b></td><td>–</td><td>–</td></tr>
${d.stats_page ? html`${Object.entries(d.stats_page.now).map(([k, v]) => html`<tr data-k="${k}"><td>${v.label}</td><td><b>${v.external_exact.toLocaleString("en-US")}</b></td><td>${v.house.toLocaleString("en-US")}</td><td>–</td></tr>`)}
${d.stats_page.signed_in_agents_all_time === null ? "" : html`<tr><td>Signed-in agents of people outside the project, all time</td><td><b>${d.stats_page.signed_in_agents_all_time.toLocaleString("en-US")}</b></td><td>–</td><td>–</td></tr>`}
${d.stats_page.usage ? html`<tr><td>AI connections, last 7 days (House left out)</td><td><b>${d.stats_page.usage.exact.mcp_sessions.toLocaleString("en-US")}</b></td><td>${d.stats_page.usage.house_mcp_sessions.toLocaleString("en-US")}</td><td>–</td></tr><tr><td>AI tool calls, last 7 days (House left out)</td><td><b>${d.stats_page.usage.exact.mcp_tool_calls.toLocaleString("en-US")}</b></td><td>${d.stats_page.usage.house_mcp_tool_calls.toLocaleString("en-US")}</td><td>–</td></tr>` : ""}` : ""}
${d.connect_check_sources_today === null ? "" : html`<tr><td>Distinct outside sources that checked a tool today (was on /connect)</td><td><b>${d.connect_check_sources_today.toLocaleString("en-US")}</b></td><td>–</td><td>–</td></tr>`}
</tbody></table>
<p><small>The 7-day agent funnel, skill checks and daily history that /stats used to show are in the JSON (<code>stats_page</code>).</small></p>`;
}

const pctText = (p: number | null) => (p === null ? "–" : `${p}%`);

/** ADR 0065: every step from opening /connect to a verified owner, with drop-off. Internal only. */
export function landingFunnelPanel(f: LandingFunnel) {
  const choices = [7, 30, 90].map((d) => (d === f.window.days ? html`<b>${d} days</b>` : html`<a href="/admin/kpis?days=${d}#funnel">${d} days</a>`));
  return html`<h2 id="funnel">From /connect to verified owner</h2>
<p><small>Last ${f.window.days} full UTC days (${f.window.from} to ${f.window.to}) · ${choices.map((x, i) => html`${i ? " · " : ""}${x}`)}. Goal: 100 verified owners by 31 Dec (Season 1). "Kept" is the share of the step before; "lost" is the drop-off.</small></p>
<table class="kpi-table funnel-table"><thead><tr><th>Step</th><th>Count</th><th>Kept</th><th>Lost</th><th>Of /connect</th></tr></thead><tbody>
${f.stages.map(
  (s, i) => html`<tr><td><b>${i + 1}. ${s.label}</b><br><small>${s.definition}${s.measured_since ? ` · counted since ${s.measured_since}` : ""}</small></td><td>${measured(s.n)}</td><td>${pctText(s.pct_of_previous)}</td><td>${s.pct_of_previous === null ? "–" : `${Math.max(0, Math.round((100 - s.pct_of_previous) * 10) / 10)}%`}</td><td>${pctText(s.pct_of_first)}</td></tr>`,
)}</tbody></table>
<p><b>Biggest drop:</b> ${f.biggest_drop ?? "not enough data yet"}</p>
<table class="kpi-table"><tbody>
<tr><td>Chose a client, by app (presses)</td><td>${Object.entries(f.detail.chose_by_app).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}</td></tr>
<tr><td>App tiles opened</td><td>${Object.entries(f.detail.tiles_by_app).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}</td></tr>
<tr><td>Example question copied · example checks by path</td><td>${measured(f.detail.first_prompt_copied)} · ${Object.entries(f.detail.first_check_by_channel).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}</td></tr>
<tr><td>/connect test codes passed</td><td>${measured(f.detail.connect_tests_passed)}</td></tr>
<tr><td>Gauntlet line copied on /connect</td><td>${measured(f.detail.gauntlet_line_copied)}</td></tr>
<tr><td>GitHub sign-in started from the claim page</td><td>${measured(f.detail.signin_started_from_claim)}</td></tr>
<tr><td>Maintainer right of reply: page opened · replies sent</td><td>${measured(f.detail.maintainer_reply_page)} · ${measured(f.detail.maintainer_disputes_sent)}</td></tr>
<tr><td>/connect page views (gross, crawlers left out)</td><td>${measured(f.detail.connect_page_views_gross)}</td></tr>
</tbody></table>
<details><summary>Day by day (last ${f.daily.length} days)</summary>
<table class="kpi-table"><thead><tr><th>Day</th>${LANDING_STAGES.map(([, label]) => html`<th>${label}</th>`)}</tr></thead>
<tbody>${f.daily.map((d) => html`<tr><td>${d.day}</td>${LANDING_STAGES.map(([id]) => html`<td>${d[id] === null ? "–" : d[id]}</td>`)}</tr>`)}</tbody></table>
<p><small>– means not yet measured on that day.</small></p></details>
<ul>${f.notes.map((n) => html`<li><small>${n}</small></li>`)}</ul>`;
}

/**
 * Open disputes (ADR 0065): the dispute form, and the maintainer right of reply that sends maintainers to it, promise a
 * person's answer within 7 days, so the open ones are listed here for admins (oldest 20 first). Nothing else shows them.
 */
export async function openDisputes(env: Env, limit = 20) {
  const db = getDb(env);
  const open = eq(t.disputes.state, "open");
  const [n] = await db.select({ n: count() }).from(t.disputes).where(open);
  const rows = await db
    .select({ id: t.disputes.id, reason: t.disputes.reason, createdAt: t.disputes.createdAt, tool: t.tools.canonicalId, report: t.disputes.reportId, login: t.humans.githubLogin })
    .from(t.disputes)
    .leftJoin(t.tools, eq(t.tools.id, t.disputes.toolId))
    .leftJoin(t.humans, eq(t.humans.id, t.disputes.openedByHumanId))
    .where(open)
    .orderBy(asc(t.disputes.createdAt))
    .limit(limit);
  return { open: Number(n?.n ?? 0), rows };
}

export function disputesPanel(d: Awaited<ReturnType<typeof openDisputes>>, now = Date.now()) {
  const age = (ms: number) => Math.floor((now - ms) / 86_400_000);
  return html`<h2 id="disputes">Open disputes (${d.open})</h2>
<p><small>Answer within 7 days (the dispute page and the maintainer line on scan pages say so). Oldest first; anything open 5 days or more is marked. Resolve in D1 by setting <code>state</code>.</small></p>
${d.rows.length
  ? html`<table class="kpi-table"><thead><tr><th>Opened</th><th>By</th><th>About</th><th>Reason</th></tr></thead><tbody>${d.rows.map(
      (r) => html`<tr><td>${new Date(r.createdAt).toISOString().slice(0, 10)}${age(r.createdAt) >= 5 ? html` <b>(${age(r.createdAt)} days)</b>` : ""}</td><td>${r.login ?? "–"}</td><td>${r.tool ?? "–"}${r.report ? html`<br><small>report ${r.report}</small>` : ""}</td><td><small>${r.reason}</small></td></tr>`,
    )}</tbody></table>`
  : html`<p>None open.</p>`}`;
}

// /admin/kpis: the twelve growth KPIs (ADR 0039) with their targets and
// 30-day trend, plus two hand-kept lists: citations of our results and partner conversations (organisations only, never
// personal names). Admins only, never cached, never indexed. The same numbers go to Forge Scout and the digest.

const page = { title: "Growth KPIs", description: "Internal growth KPIs.", path: "/admin/kpis", noindex: true };

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

const STATUS_LABEL: Record<Kpi["status"], string> = { below: "below target", first: "first target met", second: "second target met", untracked: "parked" };
const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));

/** A tiny inline bar chart of a daily series (no script, no external assets). */
function spark(values: number[]) {
  const max = Math.max(1, ...values);
  return html`<span class="kpi-spark" aria-hidden="true">${values.map((v) => html`<i style="height:${Math.max(2, Math.round((v / max) * 24))}px"></i>`)}</span>`;
}

site.get("/admin/kpis", async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const { as_of, kpis } = await growthKpis(c.env);
  const inv = await dataInventory(c.env);
  // The credit panel never takes the KPI page down with it.
  const credit = await creditGuard(c.env).catch((e) => (console.error("admin: credit guard unavailable", String(e)), null));
  const byok = await byokSpendThisMonth(c.env).catch(() => null);
  const history = await getDb(c.env)
    .select({ date: t.proofSnapshots.date, metric: t.proofSnapshots.metric, v: t.proofSnapshots.externalValue })
    .from(t.proofSnapshots)
    .where(and(like(t.proofSnapshots.metric, "kpi_%"), gte(t.proofSnapshots.date, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))))
    .orderBy(t.proofSnapshots.date);
  const trend = (id: string) => history.filter((h) => h.metric === `kpi_${id}`).map((h) => h.v);
  const citations = (await c.env.KV.get<Citation[]>(CITATIONS_KV, "json")) ?? [];
  const partners = (await c.env.KV.get<PartnerContact[]>(PARTNERS_KV, "json")) ?? [];
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const days = [7, 30, 90].includes(Number(c.req.query("days"))) ? Number(c.req.query("days")) : 30;
  const funnel = await landingFunnel(c.env, Date.now(), days);
  const disputes = await openDisputes(c.env);
  const third = await thirdPartyData(c.env).catch((e) => (console.error("admin: third-party numbers unavailable", String(e)), null));
  const small = await smallRows(c.env).catch(() => null);
  const north = kpis[0]!;
  const daily = ((north.detail?.daily as { day: string; agents: number }[]) ?? []).map((d) => d.agents);
  return send(
    c,
    {
      ...page,
      body: html`<h1 class="page-title">Growth KPIs</h1>
<p>Full UTC days to ${as_of}. Definitions: ADR 0039. Internal only.</p>
<p><b>North star:</b> ${fmt(north.value)} ${north.unit} (${STATUS_LABEL[north.status]}); last 14 days ${spark(daily)}</p>
<table class="kpi-table">
<thead><tr><th>KPI</th><th>Now</th><th>First target</th><th>Second target</th><th>Status</th><th>30-day trend</th></tr></thead>
<tbody>${kpis.map(
        (k) => html`<tr class="kpi-${k.status}"><td><b>${k.name}</b><br><small>${k.definition}</small></td><td>${fmt(k.value)} ${k.unit}</td><td>${fmt(k.first)}</td><td>${fmt(k.second)}</td><td>${STATUS_LABEL[k.status]}</td><td>${spark(trend(k.id))}</td></tr>`,
      )}</tbody></table>
${credit && byok ? creditPanel(credit, byok) : html`<h2 id="credit">Arena credit (ADR 0064)</h2><p>Couldn't be worked out just now (see the Worker log). The runner pauses new practice and panel bouts on credit-spending models while that's so.</p>`}
${landingFunnelPanel(funnel)}
${disputesPanel(disputes)}
${third ? thirdPartyPanel(third) : ""}
${third ? installPanel(third.install, third.stats_page?.now ?? null) : ""}
${small ? smallRowsPanel(small) : ""}
${third ? installReturnsPanel(third.install_returns) : ""}
${ownersPanel(kpis.find((k) => k.id === "active_owners"), kpis.find((k) => k.id === "owners_by_source"))}
${ownerFunnelPanel(kpis.find((k) => k.id === "verified_owners")?.detail as OwnerFunnel | undefined)}
<details><summary>Detail (JSON)</summary><pre>${JSON.stringify(kpis.map((k) => ({ id: k.id, detail: k.detail ?? null })), null, 2)}</pre></details>

<h2>Dataset inventory</h2>
<p><small>What we hold that's hard to recreate (ADR 0040). Calibrated means a ranked task with 6+ runs and a pass rate between 3% and 97%.</small></p>
<table class="kpi-table"><tbody>
<tr><td>Task environments</td><td>${inv.environments.task_families} job families, ${inv.environments.job_versions} job versions (${inv.environments.tiers.join(", ")}), seeded variants</td></tr>
<tr><td>Refereed runs</td><td>${fmt(inv.refereed_runs.total)} (ranked ${fmt(inv.refereed_runs.ranked)}, ${inv.refereed_runs.models} models, ${fmt(inv.refereed_runs.with_trap_fall)} ranked runs with a trap fall; ${inv.refereed_runs.freshness_pct ?? "–"}% from the last 30 days)</td></tr>
<tr><td>Difficulty calibration</td><td>${inv.calibration.tasks_in_band} of ${inv.calibration.tasks_measured} measured tasks in band${inv.calibration.per_task.length ? html`<br><small>${inv.calibration.per_task.map((x) => `${x.task} ${x.pass_rate}% (n ${x.n})`).join(" · ")}</small>` : ""}</td></tr>
<tr><td>Outside agents' runs</td><td>${fmt(inv.external_runs.gauntlet_finished)} Gauntlet, ${fmt(inv.external_runs.proving_ground_finished)} Proving Ground</td></tr>
<tr><td>Field reports</td><td>${fmt(inv.field_reports.total)} (${fmt(inv.field_reports.external)} from outside; ${fmt(inv.field_reports.tools_covered)} tool versions)</td></tr>
<tr><td>Skill scans</td><td>${fmt(inv.scans.unique_skills)} unique skills (${fmt(inv.scans.public)} public)</td></tr>
<tr><td>Controls</td><td>${Object.entries(inv.controls).map(([k, v]) => html`${v ? "✓" : "✗"} ${k.replaceAll("_", " ")}<br>`)}</td></tr>
</tbody></table>

<h2>Citations (${citations.length})</h2>
<ul>${citations.map((x) => html`<li>${x.date}: <a href="${x.url}" rel="noopener nofollow">${x.title}</a></li>`)}</ul>
<form method="post" action="/admin/kpis/citation"><input type="hidden" name="csrf" value="${csrf}">
<input name="url" type="url" required placeholder="https://…" maxlength="500"> <input name="title" required placeholder="Title" maxlength="200"> <button class="btn chamfer" type="submit">Add citation</button></form>

<h2>Partner conversations (${partners.length})</h2>
<p><small>Organisations only. No personal names here (they belong in your own notes).</small></p>
<ul>${partners.map((b) => html`<li>${b.date}: ${b.org}: ${b.stage}</li>`)}</ul>
<form method="post" action="/admin/kpis/partner"><input type="hidden" name="csrf" value="${csrf}">
<input name="org" required placeholder="Organisation" maxlength="80"> <select name="stage">${PARTNER_STAGES.map((x) => html`<option>${x}</option>`)}</select> <button class="btn chamfer" type="submit">Add</button></form>
<style>.kpi-table{width:100%;border-collapse:collapse}.kpi-table td,.kpi-table th{border-bottom:1px solid var(--line,#333);padding:.4rem;vertical-align:top;text-align:left}.kpi-second td:nth-child(5){color:#3fb950}.kpi-first td:nth-child(5){color:#d29922}.kpi-spark{display:inline-flex;gap:1px;align-items:flex-end;height:24px}.kpi-spark i{display:inline-block;width:4px;background:currentColor;opacity:.7}</style>`,
    },
    { cache: false },
  );
});

/** ADR 0067 Amendment 1: the outside-only figures as JSON. Admins only, never cached, never indexed. */
site.get("/admin/stats/third-party.json", async (c) => {
  const s = await currentSession(c);
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (!s || !(await admin(c, s.session.h))) return c.json({ error: "forbidden" }, 403, headers);
  return c.json(await thirdPartyData(c.env), 200, headers);
});

/**
 * The private callers of the outside-only numbers (review of ADR 0082; ADR 0085): the daily Ops Digest and the Forge
 * Scout collector, each a workflow on main in the private repo, proved by its GitHub OIDC token. Nothing else.
 */
export const INTERNAL_STATS_WORKFLOWS = ["ops-digest.yml", "scout-collect.yml"] as const;
export const internalStatsCaller = (c: OidcClaims) => INTERNAL_STATS_WORKFLOWS.some((w) => privateWorkflow(w)(c));

/**
 * What the digest and Scout read since F-02 took the outside-only numbers off /stats and /api/v1/growth: the admin
 * figures (/admin/stats/third-party.json, with `stats_page`, the old /stats object, outside-only) and the full growth
 * object (`growth`, the outside-only fields that /api/v1/growth gives as null included). Counts only, no people.
 */
export async function internalStatsData(env: Env, now = Date.now()) {
  const [third, growth] = await Promise.all([thirdPartyData(env, now), growthStats(env, now)]);
  return { data_kind: "internal_stats" as const, ...third, growth };
}

/** GET /api/v1/ops/internal-stats: the outside-only numbers for ops-digest.yml and scout-collect.yml (GitHub OIDC). */
site.get("/api/v1/ops/internal-stats", async (c) => {
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyActionsToken(token, c.env.PUBLIC_ORIGIN, internalStatsCaller))) return c.json({ error: "unauthorized" }, 401, headers);
  return c.json(await internalStatsData(c.env), 200, headers);
});

site.post("/admin/kpis/citation", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const url = String(g.form.get("url") ?? "").trim().slice(0, 500);
  const title = String(g.form.get("title") ?? "").trim().slice(0, 200);
  if (/^https:\/\/[^\s]+$/.test(url) && title) {
    const list = (await c.env.KV.get<Citation[]>(CITATIONS_KV, "json")) ?? [];
    if (!list.some((x) => x.url === url)) list.push({ url, title, date: new Date().toISOString().slice(0, 10) });
    await c.env.KV.put(CITATIONS_KV, JSON.stringify(list.slice(-500)));
  }
  return c.redirect("/admin/kpis");
});

site.post("/admin/kpis/partner", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const org = String(g.form.get("org") ?? "").trim().slice(0, 80);
  const stage = String(g.form.get("stage") ?? "") as PartnerStage;
  if (org && PARTNER_STAGES.includes(stage)) {
    const list = (await c.env.KV.get<PartnerContact[]>(PARTNERS_KV, "json")) ?? [];
    list.push({ org, stage, date: new Date().toISOString().slice(0, 10) });
    await c.env.KV.put(PARTNERS_KV, JSON.stringify(list.slice(-500)));
  }
  return c.redirect("/admin/kpis");
});
