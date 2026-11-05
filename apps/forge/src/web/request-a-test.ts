import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { createRequest, getRequest, REQUEST_CAPS, REQUEST_PATH, requestMetrics, requestView, type RequestError, type RequestResult, type RequestView } from "../services/test-requests";
import { currentSession } from "./dashboard";
import { send, sendJson, site, wantsJson } from "./pages";
import { isGithubOwner } from "./publishers";
import { checkCsrf, csrfToken } from "./session";

// ADR 0131: the "Request a test" form, the dated result page per request, and the admin-only metric family.
// Wording rules: never "safe" or a certification; a pattern match is never called malicious; a clear scan means no known
// pattern matched. Every result page links the dispute flow (right of reply). No counts on public pages.

type Ctx = Context<{ Bindings: Env }>;

const OUTCOME_WORDS: Record<string, string> = {
  worked: "Started and listed its tools",
  partial: "Started and answered initialize, but tools/list failed",
  failed: "Could not be installed at this version",
  needs_config: "Asked for configuration (a key, token or argument), which the House tester never gives",
  no_answer: "Started but gave no MCP answer in time",
  not_on_npm: "The registry no longer served this version",
  not_on_pypi: "The registry no longer served this version",
  no_command: "The package has no command to start",
  error: "The test run hit an error on our side",
  not_tested: "Not tested: no sweep run answered within 7 days",
};

const ERROR_WORDS = (e: RequestError) =>
  e.error === "invalid_input"
    ? `That doesn't look right${e.field ? ` (${e.field})` : ""}: ${e.detail}.`
    : e.error === "unsupported_field"
      ? "Only a registry, a package name and an exact version are accepted."
      : e.error === "not_found_on_registry"
        ? `The ${e.registry === "npm" ? "npm" : "PyPI"} registry has no ${e.package} at version ${e.version}.`
        : e.error === "registry_unavailable"
          ? "The registry didn't answer. Try again in a few minutes."
          : e.error === "rate_limited"
            ? "Too many requests from here. Wait a minute and try again."
            : e.error === "daily_limit_reached"
              ? "Today's requests are used up. Try again tomorrow (UTC)."
              : "The queue is full until the next sweep. Try again tomorrow.";

const dateTime = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "not yet");

function formBody(o: { csrf: string; login: string | null; message?: string; values?: Record<string, string> }) {
  const v = o.values ?? {};
  return html`<h1 class="page-title">Request a test</h1>
<p class="lead spaced">Name a public npm or PyPI MCP server and an exact version. It joins the next daily run of the House tester's weekly sweep, which starts it with no credentials, does the MCP handshake and scans what its tools say about themselves. The result gets its own dated page, with a right of reply.</p>
${o.message ? html`<p class="notice warn" role="alert">${o.message}</p>` : ""}
<form class="stack" method="post" action="${REQUEST_PATH}">
<input type="hidden" name="csrf" value="${o.csrf}">
<label for="rq-registry">Registry</label>
<select id="rq-registry" name="registry"><option value="npm"${v.registry === "pypi" ? "" : " selected"}>npm</option><option value="pypi"${v.registry === "pypi" ? " selected" : ""}>PyPI</option></select>
<label for="rq-package">Package name</label><input id="rq-package" type="text" name="package" maxlength="214" required value="${v.package ?? ""}" placeholder="@scope/name or name" autocomplete="off" spellcheck="false">
<label for="rq-version">Exact version</label><input id="rq-version" type="text" name="version" maxlength="64" required value="${v.version ?? ""}" placeholder="1.4.2" autocomplete="off" spellcheck="false">
<button class="btn primary chamfer" type="submit">Request a test</button>
</form>
<ul class="muted small">
<li>Only packages published on registry.npmjs.org or pypi.org, at a version that exists. No links, keys, tokens, environment variables or arguments are accepted, and none are ever used.</li>
<li>One test per server and version: asking again shows the first request.</li>
<li>Up to ${REQUEST_CAPS.perSweep} requested servers join each daily sweep run (05:41 UTC), oldest first.</li>
<li>${o.login
    ? html`Signed in as <b>@${o.login}</b>. If your account or one of your public GitHub organisations owns the repository the package names, the request is marked as the maintainer's.`
    : html`Maintainers: <a href="/auth/login?next=${encodeURIComponent(REQUEST_PATH)}">sign in with GitHub</a> first, and a request for a package whose repository you own is marked as yours.`}</li>
</ul>
<p class="small">Agents: <code>POST /api/v1/test-requests</code> with <code>{"registry","package","version"}</code>, or the <code>forge_request_test</code> tool on <code>/mcp/requests</code>.</p>`;
}

async function formPage(c: Ctx, message?: string, values?: Record<string, string>, status = 200) {
  const s = await currentSession(c);
  const human = s ? await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : undefined;
  const csrf = s ? await csrfToken(c.env.SESSION_SECRET, s.token) : "";
  return send(
    c,
    { title: "Request a test", description: "Name a public npm or PyPI MCP server and version; it joins the next House tester sweep and gets a dated result page.", path: REQUEST_PATH, status, body: formBody({ csrf, login: human?.githubLogin ?? null, message, values }) },
    { cache: false },
  );
}

site.get(REQUEST_PATH, (c) => formPage(c, undefined, { registry: c.req.query("registry") ?? "", package: (c.req.query("package") ?? "").slice(0, 214), version: (c.req.query("version") ?? "").slice(0, 64) }));

site.post(REQUEST_PATH, async (c) => {
  // Cross-site posts are refused: the Origin must be ours, and a signed-in person's form carries the session's CSRF token.
  if (c.req.header("Origin") !== c.env.PUBLIC_ORIGIN) return c.text("Forbidden", 403);
  const form = await c.req.formData();
  const s = await currentSession(c);
  if (s && !(await checkCsrf(c.env.SESSION_SECRET, s.token, String(form.get("csrf") ?? "")))) return c.text("Forbidden", 403);
  const values = { registry: String(form.get("registry") ?? ""), package: String(form.get("package") ?? ""), version: String(form.get("version") ?? "") };
  const human = s ? await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : undefined;
  const r = await createRequest(c.env, values, {
    channel: "web",
    ip: c.req.header("CF-Connecting-IP") ?? "unknown",
    humanId: human?.id ?? null,
    isOwner: human ? (owner) => isGithubOwner(owner, human.githubLogin, s!.session.o ?? []) : undefined,
  });
  if (!r.ok) return formPage(c, ERROR_WORDS(r.error), values, r.status);
  return new Response(null, { status: 303, headers: { Location: `${REQUEST_PATH}/${r.view.id}` } });
});

function scanBlock(r: RequestResult) {
  if (!r.scan) return html`<p class="muted">No tool descriptions to scan (the server didn't list its tools).</p>`;
  const s = r.scan;
  const word = s.verdict === "flagged" ? "matched a high-risk pattern" : s.verdict === "caution" ? "matched a pattern worth a look" : "matched no known pattern";
  return html`<h2>Tool descriptions: ${word}</h2>
<p class="muted small">Scanned with rules ${s.rules_version} (<a href="/scan/rules">the skill scanner's rules</a>). A match means a person should read that text; it is not a finding about the server's intent. A clear scan means no known pattern matched, and is not a security review or a certification.</p>
${s.findings.length ? html`<ul>${s.findings.map((f) => html`<li><b>${f.severity}</b> ${f.title} (${f.rule}) in tool <code>${f.tool}</code>${f.context === "warning" ? " (reads as a warning or example)" : ""}: <code>${f.evidence}</code></li>`)}</ul>` : ""}
${r.tools.length ? html`<p class="muted small">Tools: ${r.tools.slice(0, 40).join(", ")}${r.tools.length > 40 ? ", …" : ""}</p>` : ""}`;
}

function resultBody(v: RequestView, r: RequestResult | null) {
  return html`<h1 class="page-title">Requested test: <span class="mono">${v.tool}@${v.version}</span></h1>
<dl class="facts">
<dt>Requested</dt><dd>${dateTime(v.requested_at)}</dd>
<dt>Status</dt><dd>${v.status === "done" ? html`Tested ${dateTime(r?.tested_at ?? v.completed_at)}` : html`Queued, number ${v.queue_position}; expected in the sweep run of ${dateTime(v.expected_sweep_at)}`}</dd>
<dt>Package fingerprint</dt><dd class="mono small">${v.fingerprint}</dd>
${r?.fingerprint && r.fingerprint !== v.fingerprint ? html`<dt>Fingerprint tested</dt><dd class="mono small">${r.fingerprint} (differs from the one read when requested: the registry served other files for this version)</dd>` : ""}
<dt>Requested by</dt><dd>${v.attribution === "owner_verified" ? "the package's maintainer (GitHub ownership checked)" : "someone who hasn't shown they maintain it"}</dd>
</dl>
${v.status === "done" && r
  ? html`<h2>Handshake: ${OUTCOME_WORDS[r.outcome] ?? r.outcome}</h2>
<p class="muted small">The House tester started it with ${v.registry === "pypi" ? "uvx" : "npx"} in a sandbox with no credentials${r.ms !== null ? `, in ${Math.max(1, Math.round(r.ms / 1000))} s` : ""}${r.tools_count !== null ? `, and it listed ${r.tools_count} tool${r.tools_count === 1 ? "" : "s"}` : ""}.</p>
${r.outcome === "worked" ? scanBlock(r) : ""}`
  : v.status === "done"
    ? html`<h2>${OUTCOME_WORDS[v.result?.outcome ?? ""] ?? v.result?.outcome}</h2><p class="muted small">Closed ${dateTime(v.completed_at)}.</p>`
    : html`<p>The result appears here after the sweep run. This page keeps the date it was requested and tested.</p>`}
<p class="small">Maintain this package and think something here is wrong? <a rel="nofollow" href="/disputes?tool=${encodeURIComponent(v.tool)}&amp;from=maintainer">Reply or open a dispute</a>. A person reviews every one.</p>
<p class="small"><a href="${REQUEST_PATH}">Request another test</a> · <a href="/api/v1/test-requests/${v.id}">This result as JSON</a></p>`;
}

site.get(`${REQUEST_PATH}/:id`, async (c) => {
  const row = await getRequest(c.env, c.req.param("id"));
  if (!row) return send(c, { title: "No such request", description: "That test request doesn't exist.", path: `${REQUEST_PATH}/${c.req.param("id")}`, status: 404, noindex: true, body: html`<h1 class="page-title">No such request</h1><p><a href="${REQUEST_PATH}">Request a test</a></p>` }, { cache: false });
  const v = await requestView(c.env, row);
  if (wantsJson(c)) return sendJson(c, v, 60);
  return send(
    c,
    { title: `Test of ${v.tool}@${v.version}`, description: `Requested House tester run of ${v.tool}@${v.version}: status, dated result and right of reply.`, path: `${REQUEST_PATH}/${row.id}`, noindex: true, body: resultBody(v, row.result as RequestResult | null) },
    { maxAge: 60 },
  );
});

/** /admin/requests: the requested-servers metric family (ADR 0131). Admin only, never public. */
site.get("/admin/requests", async (c) => {
  const s = await currentSession(c);
  const me = s ? await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : undefined;
  if (!me || !isAdmin(c.env, me.githubId)) return c.redirect("/dashboard");
  const m = await requestMetrics(c.env);
  if (wantsJson(c)) return c.json(m, 200, { "Cache-Control": "no-store" });
  const x = m.totals;
  return send(
    c,
    {
      title: "Test requests",
      description: "Internal: the requested-servers metric family.",
      path: "/admin/requests",
      noindex: true,
      body: html`<h1 class="page-title">Test requests (${m.family})</h1>
<p>Counted from the test_requests table at ${dateTime(m.counted_at)}. First request: ${m.first_day ?? "none yet"}. Only <b>claimed</b> requests (GitHub ownership proved) may count as outside use; unclaimed ones are tested the same way and counted here only.</p>
<table class="table"><tbody>
<tr><th>Requests</th><td class="num">${x.requests}</td></tr>
<tr><th>Claimed (owner verified)</th><td class="num">${x.claimed}</td></tr>
<tr><th>Completed</th><td class="num">${x.completed}</td></tr>
<tr><th>Claimed and completed</th><td class="num">${x.claimed_completed}</td></tr>
<tr><th>Queued</th><td class="num">${x.queued}</td></tr>
<tr><th>Closed untested (7 days)</th><td class="num">${x.not_tested}</td></tr>
</tbody></table>
<h2>Last 14 days</h2>
${m.by_day.length ? html`<table class="table"><thead><tr><th>UTC day</th><th class="num">Requests</th><th class="num">Claimed</th><th class="num">Completed</th></tr></thead><tbody>${m.by_day.map((d) => html`<tr><td>${d.day}</td><td class="num">${d.requests}</td><td class="num">${d.claimed}</td><td class="num">${d.completed}</td></tr>`)}</tbody></table>` : html`<p class="empty">No requests in this window.</p>`}
<h2>By channel</h2>
${m.by_channel.length ? html`<table class="table"><thead><tr><th>Channel</th><th class="num">Requests</th><th class="num">Claimed</th></tr></thead><tbody>${m.by_channel.map((d) => html`<tr><td>${d.channel}</td><td class="num">${d.requests}</td><td class="num">${d.claimed}</td></tr>`)}</tbody></table>` : html`<p class="empty">None yet.</p>`}
<h2>Outcomes</h2>
${m.by_outcome.length ? html`<table class="table"><tbody>${m.by_outcome.map((d) => html`<tr><td>${d.outcome}</td><td class="num">${d.n}</td></tr>`)}</tbody></table>` : html`<p class="empty">No completed tests yet.</p>`}
<p class="muted small">Caps: ${m.caps.perIpDay} a day per IP, ${m.caps.globalDay} a day in all, ${m.caps.queue} waiting at most, ${m.caps.perSweep} per sweep run. <a href="/admin/requests?format=json">JSON</a></p>`,
    },
    { cache: false },
  );
});
