import { CANARY } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { disagreementNowText, disagreementStatuses, REFEREE_AUDIT, validityGate } from "../arena/error-record";
import {
  AUDIT_DISAGREEMENTS_CSV_PATH,
  AUDIT_FILE_PATH,
  AUDIT_TRAPS_CSV_PATH,
  disagreementsCsv,
  ERROR_RECORD_CSV_PATH,
  ERROR_RECORD_JSON_PATH,
  errorRecordCsv,
  perTrapCsv,
  validityData,
  VALIDITY_JSON_PATH,
  VALIDITY_PATH,
} from "../arena/validity";
import { getDb } from "../services/db";
import { send, sendJson, site, wantsJson } from "./pages";
import { asPreview, validityAccess } from "./validity-release";

// /benchmark/validity (ADR 0136): the referee audit, the contamination test, the error record and the reproducibility
// kit on one page, with files buyers can download. Every figure is read from validityData; nothing is typed in here.
// Without a complete, resolved referee audit the page, its JSON and the error-record files are withheld (503).
// Until the release switch is on (VALIDITY_PUBLIC, web/validity-release.ts) every path here is 404 except to an admin.

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "not measured" : `${(x * 100).toFixed(1)}%`);
const ci = (c: readonly [number, number] | null | undefined) => (c ? `${pct(c[0])}–${pct(c[1])}` : "no interval");
const FILE_HEADERS = { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" };
const withheld = () => new Response(JSON.stringify({ status: "withheld", why: "the error record is published only with a complete referee audit" }), { status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "86400" } });
/** Registers a validity route behind the release switch: 404 for everyone but an admin until VALIDITY_PUBLIC is on. */
function gated(path: string, handler: (c: Ctx) => Response | Promise<Response>) {
  site.get(path, async (c) => {
    const access = await validityAccess(c);
    if (!access) return c.notFound();
    const res = await handler(c);
    return access === "admin_preview" ? asPreview(res) : res;
  });
}
type Ctx = Context<{ Bindings: Env }>;
const csv = (body: string, name: string) => new Response(body, { headers: { ...FILE_HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });

gated(VALIDITY_JSON_PATH, async (c) => {
  const d = await validityData(getDb(c.env), c.env.PUBLIC_ORIGIN);
  if (d.status !== "published") return withheld();
  return sendJson(c, d, 300);
});

gated(AUDIT_FILE_PATH, (c) => {
  if (!validityGate(REFEREE_AUDIT).ok) return withheld();
  // The frozen file as the audit script wrote it (JSON, one-space indent, trailing newline).
  return new Response(`${JSON.stringify(REFEREE_AUDIT, null, 1)}\n`, { headers: { ...FILE_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
});
gated(AUDIT_TRAPS_CSV_PATH, () => (validityGate(REFEREE_AUDIT).ok ? csv(perTrapCsv(REFEREE_AUDIT), "forge-referee-audit-1-per-trap.csv") : withheld()));
gated(AUDIT_DISAGREEMENTS_CSV_PATH, () => (validityGate(REFEREE_AUDIT).ok ? csv(disagreementsCsv(REFEREE_AUDIT), "forge-referee-audit-1-disagreements.csv") : withheld()));
gated(ERROR_RECORD_JSON_PATH, async (c) => {
  const d = await validityData(getDb(c.env), c.env.PUBLIC_ORIGIN);
  if (d.status !== "published") return withheld();
  return c.json({ canary: CANARY, shown_with: d.error_record.shown_with, referee_audit: d.links.referee_audit, entries: d.error_record.entries, disputes: d.error_record.disputes }, 200, FILE_HEADERS);
});
gated(ERROR_RECORD_CSV_PATH, async (c) => {
  const d = await validityData(getDb(c.env), c.env.PUBLIC_ORIGIN);
  if (d.status !== "published") return withheld();
  return csv(errorRecordCsv(d.error_record.entries, REFEREE_AUDIT), "forge-error-record.csv");
});

gated(VALIDITY_PATH, async (c) => {
  const d = await validityData(getDb(c.env), c.env.PUBLIC_ORIGIN);
  if (d.status !== "published") return withheld();
  if (wantsJson(c)) return sendJson(c, d, 300);
  const a = d.referee_audit;
  const statuses = disagreementStatuses(REFEREE_AUDIT);
  const k = d.contamination.public_vs_held_out.pooled_ranked_events;
  const r = d.reproducibility;
  const s = d.contamination.answer_key_scan;
  return send(c, {
    title: "Benchmark validity",
    description: d.headlines[0]!,
    path: VALIDITY_PATH,
    nav: "arena",
    jsonAlternate: VALIDITY_JSON_PATH,
    canary: CANARY,
    body: html`<p class="eyebrow"><a href="/benchmark">The Forge Trap Set</a> · Validity</p>
<h1 class="page-title">How far can you trust the Trap Set's results?</h1>
<div class="summary-3" data-headlines>${d.headlines.map((h) => html`<p>${h}</p>`)}</div>

<section id="referee-audit"><h2>1. Referee audit ${a.audit_id.replace("referee-audit-", "")} (${a.date})</h2>
<p>${a.what}</p>
<dl class="facts">
<dt>Frame</dt><dd>${a.frame.runs} public ranked replays (${a.frame.definition}).</dd>
<dt>Sample</dt><dd>${a.sample.runs} replays across ${a.sample.job_versions} job versions: all ${a.sample.runs_with_a_sprung_trap} with a referee-sprung trap, plus ${a.sample.random_runs} drawn at random (${a.sample.random_per_job} per job version, seed <code>${a.sample.seed_text}</code>).</dd>
<dt>Agreement</dt><dd data-agreement><b>${a.overall.agree} of ${a.overall.n}</b> trap verdicts (${pct(a.overall.agreement)}, 95% ${ci(a.overall.ci_95)}); Cohen's kappa ${a.overall.kappa ?? "n/a"}.</dd>
<dt>Sprung traps</dt><dd>Of the ${a.referee_sprung.n} traps the referee marked sprung, the checker also found ${a.referee_sprung.checker_agrees} (95% ${ci(a.referee_sprung.ci_95)}). Of the ${a.checker_sprung.n} the checker found, the referee had marked ${a.checker_sprung.referee_agrees}.</dd>
<dt>Whole runs</dt><dd>${a.run_level.all_trap_verdicts_identical} of ${a.run_level.runs} runs had every trap verdict the same.</dd>
<dt>Published verdicts found wrong</dt><dd>At the audit: ${a.adjudicated.published_verdicts_found_wrong.k} of ${a.adjudicated.published_verdicts_found_wrong.n} (95% ${ci(a.adjudicated.published_verdicts_found_wrong.ci_95)}).</dd>
<dt>Method</dt><dd>${a.method.checker}. It shares the job's world and answer key with the referee, and no referee code. ${a.method.grading}. Scope: ${a.method.scope}. ${a.method.intervals}.</dd>
<dt>Human re-grade</dt><dd>${a.human_regrade.study}: ${a.human_regrade.status === "measured" ? `${pct(a.human_regrade.agreement)} of ${a.human_regrade.n}` : "not yet published"}.</dd>
</dl>
<h3>Every disagreement</h3>
<p class="small muted">The figures above are the audit's own, as frozen on ${a.date}. The status of each disagreement below is today's.</p>
${a.disagreements.length
  ? html`<div class="table-wrap"><table class="table stack"><thead><tr><th scope="col">Replay</th><th scope="col">Trap</th><th scope="col">Published at the audit</th><th scope="col">Checker</th><th scope="col">Status today</th></tr></thead><tbody>${a.disagreements.map(
      (x) => html`<tr><td><a href="${x.replay_url}">${x.run.slice(0, 8)}</a> <span class="muted">${x.task}</span></td><td>${x.public_trap_id ?? x.trap}</td><td>${x.published ? "sprung" : "not sprung"}</td><td>${x.checker ? "sprung" : "not sprung"}</td><td>${(() => {
        const now = statuses.find((y) => y.run === x.run && y.trap === x.trap);
        return html`<b>${now?.status_now.replace(/_/g, " ") ?? x.resolution?.outcome.replace(/_/g, " ")}</b>. ${now ? disagreementNowText(now) : ""} ${now?.note_now ?? x.resolution?.note} <span class="muted small">At the audit (${a.date}): ${x.resolution?.outcome.replace(/_/g, " ")}.</span>`;
      })()}</td></tr>`,
    )}</tbody></table></div>`
  : html`<p class="empty">No disagreements.</p>`}
<p class="small muted">Re-run it: <code>${a.rerun}</code> in the <a href="${d.links.public_repo}">public repo</a>. Files: <a href="${AUDIT_FILE_PATH}">audit result (JSON)</a>, <a href="${AUDIT_TRAPS_CSV_PATH}">per trap (CSV)</a>, <a href="${AUDIT_DISAGREEMENTS_CSV_PATH}">disagreements (CSV)</a>.</p>
</section>

<section id="contamination"><h2>2. Contamination test</h2>
<p>Held-out seeds (panel ${d.contamination.held_out_panel}) are never published; a model can't have trained on them. If public seeds behaved differently from held-out seeds, that would suggest the public ones leaked into training.</p>
<dl class="facts">
<dt>Public seeds</dt><dd>${k.public.passes} of ${k.public.attempts} attempts passed (${pct(k.public.pass_rate)}, 95% ${ci(k.public.ci_95)}).</dd>
<dt>Held-out seeds</dt><dd>${k.held_out.passes} of ${k.held_out.attempts} attempts passed (${pct(k.held_out.pass_rate)}, 95% ${ci(k.held_out.ci_95)}).</dd>
<dt>Difference</dt><dd>${k.difference === null ? "not yet measured" : html`${(k.difference * 100).toFixed(1)} points (95% ${k.difference_ci_95 ? `${(k.difference_ci_95[0] * 100).toFixed(1)} to ${(k.difference_ci_95[1] * 100).toFixed(1)} points` : "no interval"})`}${k.at_ceiling ? html`. <b>Both sides pass every attempt, so this comparison can't show a difference yet</b>; it needs held-out runs on jobs models sometimes fail.` : ""}</dd>
<dt>Effect status</dt><dd>${d.contamination.public_vs_held_out.status.status.replace(/_/g, " ")} (${d.contamination.public_vs_held_out.status.test_rows} test rows from ${d.contamination.public_vs_held_out.status.test_events} events).</dd>
<dt>Answer keys</dt><dd>In the ${s.replays} audited replays, ${s.outputs_containing_the_answer_key} of ${s.tool_outputs} tool outputs contained a job's answer key, ${s.outputs_with_a_key_field} carried a key field and ${s.briefs_containing_the_answer_key} briefs contained it.</dd>
</dl>
<ul class="small">${d.contamination.controls.map((x) => html`<li>${x.how}. <span class="muted">${x.enforced_by}.</span></li>`)}</ul>
</section>

<section id="error-record"><h2>3. Error record</h2>
<p>Every correction to the Arena's published results and traps, dated. It is shown only together with the referee audit above (${a.overall.agree} of ${a.overall.n} verdicts agreed, ${a.sample.runs} replays sampled), so it reads as a measured error rate.</p>
<ol class="runs" data-error-record>${d.error_record.entries.map((e) => html`<li><b>${e.date}</b> · ${e.title} <span class="label">${e.status.replace(/_/g, " ")}</span><br><span class="small">${e.what}</span>${e.runs.length ? html` <span class="small">${e.runs.map((u) => html`<a href="${u}">${u.split("/").at(-1)!.slice(0, 8)}</a> `)}</span>` : ""}${e.traps.length ? html` <span class="small muted">${e.traps.map((t) => html`<a href="/arena/failures/${t}">${t}</a> `)}</span>` : ""}</li>`)}</ol>
<p class="small muted">Files: <a href="${ERROR_RECORD_JSON_PATH}">error record (JSON)</a>, <a href="${ERROR_RECORD_CSV_PATH}">CSV</a>. Each trap's own history is on its page under <a href="/arena/failures">failure modes</a>.</p>
</section>

<section id="reproduce"><h2>4. Reproduce any public run</h2>
<pre class="verdict-line">${r.command}</pre>
<p>From ${r.works_from}. It checks: ${r.checks.join("; ")}.</p>
<p>On the ${r.audit_sample.runs} audited replays: the world and every tool output were rebuilt identically for ${r.audit_sample.world_and_tool_outputs_identical}, and the referee re-run gave the identical verdict for ${r.audit_sample.referee_rerun_identical_verdict}. Each difference is in the error record.</p>
<p><b>Model outputs vary.</b> ${r.model_variance.statement} Across ${r.model_variance.three_of_three.groups} model-job-seed groups with three attempts, ${r.model_variance.three_of_three.same_pass_fail_on_every_attempt} reached the same pass/fail every time and ${r.model_variance.three_of_three.same_verdict_and_traps_on_every_attempt} also sprang the same traps.</p>
</section>
<p class="small muted"><a href="${VALIDITY_JSON_PATH}">This page as JSON</a> · <a href="/benchmark">The Trap Set</a> · <a href="/benchmark/held-out">Held-out contract</a></p>`,
  });
});
