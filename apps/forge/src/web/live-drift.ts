import { CANARY_PATH } from "@forge/shared/drift-canary";
import { MONITOR_CONTACT, MONITOR_PAGE_PATH, MONITOR_POLICY, MONITOR_REQUESTS, MONITOR_USER_AGENT } from "@forge/shared/drift-monitor";
import type { Context } from "hono";
import { html } from "hono/html";
import { canaryStatus, coverage, liveDriftReleased, optouts } from "../services/live-drift";
import { isFounder } from "./dataset-drift";
import { send, site } from "./pages";
import { asPreview } from "./validity-release";

// ADR 0151: the live drift monitor's public pages. /drift/monitor says exactly what the poller requests, how often,
// with which User-Agent, and how to opt out; /drift/monitor/optouts.json is the opt-out list it honours. /drift/coverage
// shows coverage counts with dates; change totals appear there only once LIVE_DRIFT_PUBLIC is "on" (or, uncached, to a
// signed-in founder). Wording: a change is "changed tool text", never a judgement about the server.

type Ctx = Context<{ Bindings: Env }>;
export const COVERAGE_PATH = "/drift/coverage";
export const OPTOUTS_PATH = `${MONITOR_PAGE_PATH}/optouts.json`;

const JSON_HEADERS = { "Cache-Control": "public, max-age=600", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" };
const n = (v: number) => v.toLocaleString("en-US");
const day = (s: string | null) => (s ? s.slice(0, 10) : "not yet");
const pass = (s: string | null) => (s ? `completed ${s.slice(0, 10)}` : "in progress");

site.get(OPTOUTS_PATH, async (c) => c.json({ data_kind: "forge_drift_monitor_optouts", honoured_within_hours: MONITOR_POLICY.optOutHours, optouts: await optouts(c.env) }, 200, JSON_HEADERS));

site.get(MONITOR_PAGE_PATH, async (c) => {
  const cov = await coverage(c.env, false);
  const list = await optouts(c.env);
  const p = MONITOR_POLICY;
  const body = html`<h1 class="page-title">The Forge drift monitor</h1>
<p class="lead">If you run a remote MCP server listed in the official MCP Registry, this page explains the requests you may see from <code>TheAgentForge-DriftMonitor</code>: what they ask, how often, and how to stop them.</p>
<h2>What it is for</h2>
<p>It records when the tool list a server publishes changes (a tool's name, description or input schema), including changes made without a new version number, so agents and gateways can check that the tools they approved are still the tools they are calling. This data comes from the Official MCP Registry (the list of servers) and from each server's own <code>tools/list</code> answer.</p>
<h2>Exactly what it requests</h2>
<ul>${MONITOR_REQUESTS.map((r) => html`<li>${r}</li>`)}</ul>
<p>Over Streamable HTTP only. It never calls a tool, never reads resources or prompts, never sends a key, token, cookie or login, and never follows a redirect. An endpoint the Registry says needs a header (such as an API key) or a URL variable is never contacted. The older HTTP+SSE transport is not polled.</p>
<h2>How often</h2>
<ul>
<li>Each endpoint at most once every ${p.minIntervalHours} hours (plus a fixed spread of up to an hour).</li>
<li>${p.batchPerRun} endpoints at most every 10 minutes across all servers, no more than ${p.perHostPerRun} per host in each 10-minute run, and at most ${p.concurrency} requests in flight at once.</li>
<li>Each request times out after ${p.requestTimeoutMs / 1000} seconds and a whole poll after ${p.pollBudgetMs / 1000} seconds; answers over ${Math.round(p.maxBodyBytes / 1024 / 1024)} MB are not read.</li>
<li>After an error it waits 24 hours, then 48, then 96, up to ${p.backoffCapHours / 24} days; a <code>Retry-After</code> on a 429 or 503 is honoured when longer.</li>
<li>An answer of 401 or 403 is recorded as "auth required" and the endpoint is left alone for ${p.authRecheckDays} days.</li>
<li>The Registry itself is read once an hour, as its aggregator guide asks.</li>
</ul>
<h2>How to recognise it</h2>
<p>User-Agent: <code class="mono">${MONITOR_USER_AGENT}</code></p>
<p>It runs on Cloudflare Workers, whose outgoing IP addresses are shared with many other Cloudflare customers: an IP block would stop more than this monitor, and may not stop it. Use the User-Agent, or ask us to stop.</p>
<h2>How to opt out</h2>
<p>Email <a href="mailto:${MONITOR_CONTACT}?subject=Drift%20monitor%20opt-out">${MONITOR_CONTACT}</a> with your server's Registry name, host or URL. We add it to the list below within ${p.optOutHours} hours, and the monitor checks that list before every request. A host opt-out covers its subdomains. Nothing already recorded about your server is published as a change sample after you opt out.</p>
${list.length ? html`<table class="kpi-table"><thead><tr><th>Kind</th><th>Value</th><th>Added</th></tr></thead><tbody>${list.map((o) => html`<tr><td>${o.kind}</td><td class="mono">${o.value}</td><td>${day(o.added_at)}</td></tr>`)}</tbody></table>` : html`<p class="small muted">No opt-outs yet.</p>`}
<p class="small"><a href="${OPTOUTS_PATH}">optouts.json</a> · <a href="${COVERAGE_PATH}">coverage</a></p>
<h2 id="canary">How we check it works</h2>
<p>Once a day it also polls a canary we run ourselves, <code>${CANARY_PATH}</code>: one tool whose description switches between two fixed texts each UTC day while the server's version stays the same. Each switch should be recorded as one change, and each switch back as another. The canary is not in the Registry and is left out of every count.</p>
<h2>When it started</h2>
<p>${cov.series_started_at ? html`The series starts on <b>${day(cov.series_started_at)}</b> (${cov.series_started_at.replace("T", " ").slice(0, 16)} UTC), the first successful poll. Nothing in it is older.` : "The monitor has not made its first poll yet. Its series starts on that day; nothing in it will be older."}</p>`;
  return send(c, { title: "Drift monitor", description: "What The Agent Forge's drift monitor requests from remote MCP servers, how often, its User-Agent, and how to opt out.", path: MONITOR_PAGE_PATH, body }, { maxAge: 600 });
});

site.get(`${COVERAGE_PATH}.json`, async (c) => {
  const released = liveDriftReleased(c.env);
  const founder = !released && (await isFounder(c));
  const res = c.json(await coverage(c.env, released || founder), 200, founder ? { "Cache-Control": "no-store" } : JSON_HEADERS);
  return founder ? asPreview(res) : res;
});

site.get(COVERAGE_PATH, async (c) => {
  const released = liveDriftReleased(c.env);
  const founder = !released && (await isFounder(c));
  const x = await coverage(c.env, released || founder);
  const k = x.counts;
  const row = (key: string, label: string, v: number) => html`<tr data-k="${key}"><td>${label}</td><td class="num"><b>${n(v)}</b></td></tr>`;
  const ch = x.changes;
  const body = html`<h1 class="page-title">Drift monitor coverage</h1>
<p class="lead">How many remote MCP servers the official MCP Registry lists, and how many the <a href="${MONITOR_PAGE_PATH}">drift monitor</a> has tried, reached, found needing auth, or skipped.</p>
<p data-scope>Servers that need sign-in, keys, headers or URL variables, and servers that only speak the older HTTP+SSE transport, are not observed, so the record covers publicly reachable remote servers only.</p>
<p class="small">Series start: <b>${day(x.series_started_at)}</b> · Registry last read: ${day(x.registry_synced_at)} · last poll: ${day(x.last_poll_at)}</p>
<p class="small" data-first-pass>First full pass: <b>${pass(x.poll_first_pass_done_at)}</b> (every endpoint we may contact tried at least once) · Registry's first full read: ${pass(x.registry_first_pass_done_at)}</p>
<table class="kpi-table"><tbody>
${row("servers_listed", "Servers in the Registry with a remote endpoint (latest version)", k.servers_listed)}
${row("endpoints_listed", "Remote endpoints listed", k.endpoints_listed)}
${row("endpoints_attempted", "Endpoints we have sent a request to", k.endpoints_attempted)}
${row("endpoints_reached", "Endpoints that answered tools/list at least once", k.endpoints_reached)}
${row("auth_required", "Needed auth (401 or 403), left alone for 30 days", k.auth_required)}
${row("errored", "Errored at the last attempt", k.errored)}
${row("rate_limited", "Asked us to slow down at the last attempt (429)", k.rate_limited)}
${row("opted_out", "Opted out", k.opted_out)}
${row("needs_config_declared", "The Registry says a key, header or URL variable is needed (never contacted)", k.needs_config_declared)}
${row("sse_not_polled", "Old HTTP+SSE transport only (not polled)", k.sse_not_polled)}
${row("not_yet_attempted", "Not attempted yet", k.not_yet_attempted)}
</tbody></table>
${
  ch
    ? html`<h2>Changed tool text${founder ? " (founder preview: not public)" : ""}</h2>
<table class="kpi-table"><tbody>
${row("events", "Change events recorded (one per tool per poll that saw a different digest)", ch.events)}
${row("whitespace_only", "Of which whitespace-only", ch.whitespace_only)}
<tr data-k="whitespace_only_share"><td>Whitespace-only share</td><td class="num"><b>${ch.whitespace_only_share === null ? "none yet" : `${(ch.whitespace_only_share * 100).toFixed(1)}%`}</b></td></tr>
${row("description", "Description text", ch.by_class.description ?? 0)}
${row("schema", "Input schema", ch.by_class.schema ?? 0)}
${row("output_schema", "Output schema only (changes the contract digest)", ch.by_class.output_schema ?? 0)}
${row("tool_added", "Tool added", ch.by_class.tool_added ?? 0)}
${row("tool_removed", "Tool removed", ch.by_class.tool_removed ?? 0)}
${row("same_version_excluding_whitespace", "Under the same version on both sides, whitespace-only left out", ch.same_version_excluding_whitespace)}
${row("endpoints_with_changes_excluding_whitespace", "Endpoints with at least one such change", ch.endpoints_with_changes_excluding_whitespace)}
</tbody></table>
<p class="small muted">Counted from ${day(ch.first_event_at)} to ${day(ch.last_event_at)}. A server's first observation is its baseline and is never counted as a change.</p>${founder ? html`<p class="small">Founder: the detector on our own fixture, <a href="/admin/drift">the canary</a>.</p>` : ""}`
    : ""
}
<p class="small muted"><a href="${COVERAGE_PATH}.json">coverage.json</a>. Counts are by each endpoint's latest status; a server can list more than one endpoint. Our own <a href="${MONITOR_PAGE_PATH}#canary">canary</a> is in no count.</p>`;
  const res = await send(c, { title: "Drift monitor coverage", description: "Coverage of The Agent Forge's live drift monitor of remote MCP servers in the official MCP Registry.", path: COVERAGE_PATH, body }, { cache: !founder, maxAge: 600 });
  return founder ? asPreview(res) : res;
});

/**
 * ADR 0151 amendment 2: founders only. The canary's latest polls and change events, so a person can see the detector
 * at work on a fixture we control (text A, then B under the same version: one event; back to A: a second one).
 */
export const ADMIN_DRIFT_PATH = "/admin/drift";
site.get(ADMIN_DRIFT_PATH, async (c) => {
  if (!(await isFounder(c))) return c.redirect("/dashboard");
  const s = await canaryStatus(c.env);
  if (c.req.query("format") === "json") return c.json(s, 200, { "Cache-Control": "no-store" });
  const t = (v: string | null) => (v ? v.replace("T", " ").slice(0, 16) : "never");
  const e = s.endpoint;
  const body = html`<h1 class="page-title">Drift monitor: canary</h1>
<p class="small">Founders only. Our own fixture at <code>${CANARY_PATH}</code>, polled once per UTC day; in no public count. <a href="${COVERAGE_PATH}">Coverage</a> · <a href="?format=json">JSON</a></p>
<p data-canary-line>${e ? html`Canary: last poll ${t(e.last_poll_at)} UTC (${e.last_status ?? "not yet"}${e.last_error_class ? `, ${e.last_error_class}` : ""}), ${s.events.length ? html`latest change event <b>${t(s.events[0]!.observed_at)} UTC</b>, ${s.events[0]!.change_class}${s.events[0]!.same_version ? ", same version" : ""}` : "no change event yet"}.` : "The canary has not been polled yet."}</p>
${s.events.length ? html`<table class="kpi-table"><thead><tr><th>Observed (UTC)</th><th>Class</th><th>Same version</th><th>Before</th><th>After</th><th>Snapshots</th></tr></thead><tbody>${s.events.map((x) => html`<tr data-event><td>${t(x.observed_at)}</td><td>${x.change_class}</td><td>${x.same_version ? "yes" : "no"}</td><td>${x.before_description ?? ""}</td><td>${x.after_description ?? ""}</td><td class="mono">${(x.before_snapshot ?? "").slice(0, 10)} → ${x.after_snapshot.slice(0, 10)}</td></tr>`)}</tbody></table>` : ""}
${s.polls.length ? html`<h2>Latest polls</h2><table class="kpi-table"><thead><tr><th>At (UTC)</th><th>Status</th><th>Snapshot</th><th>Changes</th></tr></thead><tbody>${s.polls.map((p) => html`<tr><td>${t(p.at)}</td><td>${p.status}${p.error_class ? ` (${p.error_class})` : ""}${p.baseline ? ", baseline" : ""}</td><td class="mono">${(p.snapshot ?? "").slice(0, 10)}</td><td class="num">${p.changes}</td></tr>`)}</tbody></table>` : ""}
<h2>Registry read</h2>
<p class="small">Last sync without an error: ${s.registry.registry_synced_at ?? "never"} · cursor: <code>${s.registry.registry_cursor ?? "none (pass complete)"}</code>${s.registry.registry_sync_error ? html` · last error: <code>${s.registry.registry_sync_error}</code>` : ""}</p>`;
  return send(c, { title: "Drift canary", description: "Founders only: the drift monitor's canary.", path: ADMIN_DRIFT_PATH, noindex: true, body }, { cache: false });
});
