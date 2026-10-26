import { FRAMEWORKS, ISSUES, NOTE_MAX_LENGTH, type Report } from "@forge/shared";
import { and, eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { parseDraft, type ReportDraft } from "../services/contribute";
import { registryId } from "../services/registry";
import { getDb } from "../services/db";
import { submitReport, type ReportRejection } from "../services/forge";
import { agentForClient, MAX_AGENTS_PER_HUMAN } from "../services/identity";
import { toolPageUrl } from "../services/tools";
import { bump } from "../services/usage";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";

// One-tap filing (ADR 0038): an agent's draft arrives as a /report link from any check result or the
// report-after-use prompt. The person reviews it, signs in with GitHub if needed, and files it in their own name.
// It goes through the same submitReport as the forge_report tool: limits, note scan, moderation, anomaly holds.

/** The OAuth client id of the agent that web-filed reports belong to when the person has no other agent. */
export const WEB_AGENT_CLIENT = "forge-web";

const REJECTED: Record<ReportRejection, string> = {
  invalid_report: "Something in the report wasn't valid. Check the fields and try again.",
  agent_inactive: "That agent was revoked. Pick another one.",
  invite_only: "Reporting is invite-only right now.",
  rate_limited: "Too many reports in a minute. Wait a moment and try again.",
  note_contains_credential: "The note looks like it holds a key or password. Remove it and try again.",
  note_contains_file_path: "The note holds a file path. Remove it and try again.",
  note_contains_link: "The note holds a link. Remove it and try again.",
  publisher_cannot_report_own_tool: "Publishers can't report on their own tools.",
  verdict_incomplete: "A verdict needs both the report it is on and confirm or dispute.",
  unknown_report: "That report isn't on the site (it may be held for review).",
  verdict_needs_verified_owner: "Confirming or disputing reports needs a verified account.",
  verdict_not_same_version: "A verdict must be on a report about the same tool version.",
  verdict_on_own_report: "You can't confirm or dispute your own reports.",
};

const ISSUE_LABEL = (i: string) => i.replace(/_/g, " ");
const draftQuery = (d: ReportDraft) => new URLSearchParams({ tool: d.tool, kind: d.kind, ...(d.version ? { version: d.version } : {}), ...(d.fp ? { fp: d.fp } : {}), ...(d.outcome ? { outcome: d.outcome } : {}), ...(d.issues?.length ? { issues: d.issues.join(",") } : {}), ...(d.note ? { note: d.note } : {}) }).toString();

// A bare /report (linked from /methodology) is a 200 page that says how filing works; a link with broken parameters is a
// 400 (Search Console, 26 Oct: "Blocked due to other 4xx"). Both stay noindex.
const invalid = (c: Parameters<typeof send>[0], status = 400) =>
  send(c, {
    title: "File a field report",
    description: "File a field report on a tool your agent used.",
    path: "/report",
    noindex: true,
    status,
    body: html`<section class="narrow"><h1>File a field report</h1><p>This link is missing the tool, its version or its fingerprint. Ask your agent to run <code>forge_check</code> and use the <code>report_url</code> it returns.</p></section>`,
  }, { cache: false });

site.get("/report", async (c) => {
  const d = parseDraft((k) => c.req.query(k), { partial: true });
  if (!d) return invalid(c, new URL(c.req.url).search ? 400 : 200);
  c.executionCtx.waitUntil(bump(c.env, ["contribute:report-page"]).catch(() => {}));
  const s = await currentSession(c);
  const db = getDb(c.env);
  const agents = s ? await db.query.agents.findMany({ where: and(eq(t.agents.humanId, s.session.h), eq(t.agents.status, "active")) }) : [];
  const csrf = s ? await csrfToken(c.env.SESSION_SECRET, s.token) : "";
  const back = `/report?${draftQuery(d)}`;
  const registry = registryId(d.tool);
  return send(c, {
    title: `Report on ${d.tool}`,
    description: "File a field report on a tool your agent used.",
    path: "/report",
    noindex: true,
    body: html`<section class="narrow report-file">
<h1>Report on <span class="mono">${d.tool}</span></h1>
<p class="lead">${d.version ? `Version ${d.version}. ` : ""}One report from a real use helps every agent that checks it next.</p>
${s
  ? html`<form method="post" action="/report" class="panel chamfer panel-body">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="tool" value="${d.tool}"><input type="hidden" name="kind" value="${d.kind}">
${d.version && (d.fp || registry)
  ? html`<input type="hidden" name="version" value="${d.version}"><input type="hidden" name="fp" value="${d.fp}">${d.fp ? "" : html`<p class="small muted">The version's fingerprint is looked up on the ${d.tool.startsWith("pypi:") ? "PyPI" : "npm"} registry when you file.</p>`}`
  : registry
    ? html`<p class="small muted">We have no version of this tool on file. Ask your agent which version it used; its fingerprint is looked up on the registry when you file.</p>
<label for="r-version">Version</label><input id="r-version" name="version" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9.+_-]*" placeholder="1.4.2">`
    : html`<p class="small muted">We have no version of this tool on file. Ask your agent for the version it used and its fingerprint.</p>
<label for="r-version">Version</label><input id="r-version" name="version" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9.+_-]*" placeholder="1.4.2">
<label for="r-fp">Fingerprint</label><input id="r-fp" name="fp" required pattern="sha256:[0-9a-f]{64}" placeholder="sha256:…" class="mono">`}
<fieldset><legend>How did it go?</legend>${(["worked", "partial", "failed"] as const).map((o) => html`<label class="choice"><input type="radio" name="outcome" value="${o}" required${d.outcome === o ? " checked" : ""}> ${o}</label>`)}</fieldset>
<fieldset><legend>Any problems? <span class="muted small">optional</span></legend>${ISSUES.map((i) => html`<label class="choice"><input type="checkbox" name="issues" value="${i}"${d.issues?.includes(i) ? " checked" : ""}> ${ISSUE_LABEL(i)}</label>`)}</fieldset>
<label for="r-note">Note <span class="muted small">optional, ${NOTE_MAX_LENGTH} characters, no keys, paths or links</span></label>
<textarea id="r-note" name="note" maxlength="${NOTE_MAX_LENGTH}" rows="3">${d.note ?? ""}</textarea>
<label for="r-task">Kind of task <span class="muted small">a short word, e.g. coding, research</span></label>
<input id="r-task" name="category" value="general" pattern="[a-z0-9][a-z0-9-]{0,39}" maxlength="40" required>
<label for="r-fw">Your agent's app</label>
<select id="r-fw" name="framework">${FRAMEWORKS.map((f) => html`<option value="${f}"${f === "other" ? " selected" : ""}>${f}</option>`)}</select>
<label for="r-agent">File as</label>
<select id="r-agent" name="agent">${agents.map((a) => html`<option value="${a.id}">${a.handle}</option>`)}${agents.length < MAX_AGENTS_PER_HUMAN ? html`<option value="web"${agents.length ? "" : " selected"}>a new web agent</option>` : ""}</select>
<p><button class="btn primary chamfer" type="submit">File report</button></p>
<p class="small muted">Filed in your GitHub name, checked and moderated like every report. <a href="/methodology">How scoring works</a></p>
</form>`
  : html`<p><a class="btn primary chamfer" href="/auth/login?next=${encodeURIComponent(back)}">Sign in with GitHub to file</a></p>
<p class="small muted">Free. Your report is tied to your GitHub account, so one person counts once.</p>`}
</section>`,
  }, { cache: false });
});

site.post("/report", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const f = g.form;
  const get = (k: string) => (f.get(k) === null ? undefined : String(f.get(k)));
  const d = parseDraft(get);
  if (!d) return invalid(c);
  const db = getDb(c.env);
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (!human) return c.text("Forbidden", 403);

  let agentId = String(f.get("agent") ?? "");
  if (agentId === "web" || !agentId) {
    const r = await agentForClient(db, human.id, WEB_AGENT_CLIENT, "web");
    if (!r.ok) return page(c, d, r.reason === "agent_limit_reached" ? `You already have ${MAX_AGENTS_PER_HUMAN} agents. Pick one of them.` : "Your web agent was revoked. Pick another agent.");
    agentId = r.agent.id;
  }
  const report: Report = {
    tool: { kind: d.kind, id: d.tool, version: d.version, fingerprint: d.fp },
    task: { category: String(f.get("category") ?? "general").trim().toLowerCase(), framework: (FRAMEWORKS as readonly string[]).includes(String(f.get("framework"))) ? (String(f.get("framework")) as Report["task"]["framework"]) : "other" },
    outcome: String(f.get("outcome") ?? "") as Report["outcome"],
    issues: f.getAll("issues").map(String) as Report["issues"],
    ...(String(f.get("note") ?? "").trim() ? { note: String(f.get("note")).trim() } : {}),
  };
  const result = await submitReport(c.env, { humanId: human.id, agentId, githubLogin: human.githubLogin, githubOrgs: g.session.o ?? [] }, report);
  if (!result.ok && result.field === "tool.fingerprint" && registryId(d.tool))
    return page(c, d, `We couldn't find version ${d.version} of ${d.tool} on the registry. Check the version number and try again.`);
  if (!result.ok) return page(c, d, `${REJECTED[result.reason] ?? REJECTED.invalid_report}${result.detail ? ` (${result.detail})` : ""}`);
  c.executionCtx.waitUntil(bump(c.env, ["contribute:web-filed"]).catch(() => {}));
  return send(c, {
    title: "Report filed",
    description: "Your field report is filed.",
    path: "/report",
    noindex: true,
    body: html`<section class="narrow"><h1>Filed. Thank you.</h1>
<p class="lead">${result.counted ? "It counts now" : "It's held for a quick review first"}${result.reason === "sandbox_reduced_weight" ? ", at a lower weight until your account is verified" : ""}.</p>
<p><a class="btn primary chamfer" href="${toolPageUrl(c.env.PUBLIC_ORIGIN, d.tool)}">See the tool page</a> <a class="btn chamfer" href="/dashboard">Your reports</a></p>
<p class="small muted">Your dashboard shows how many checks your reports appear in, and alerts if a tool you reported on is flagged.</p></section>`,
  }, { cache: false });
});

function page(c: Parameters<typeof send>[0], d: ReportDraft, error: string) {
  return send(c, {
    title: "File a field report",
    description: "File a field report on a tool your agent used.",
    path: "/report",
    noindex: true,
    status: 400,
    body: html`<section class="narrow"><h1>Not filed</h1><p class="notice">${error}</p><p><a class="btn chamfer" href="/report?${draftQuery(d)}">Back to the report</a></p></section>`,
  }, { cache: false });
}
