import { CANARY } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { disagreementNowText, disagreementStatuses, REFEREE_AUDIT, REFEREE_AUDIT_2, REFEREE_AUDIT_ADJUDICATIONS, validityGate, type ErrorEntry } from "../arena/error-record";
import {
  AUDIT_2_DISAGREEMENTS_CSV_PATH,
  AUDIT_2_FILE_PATH,
  AUDIT_2_TRAPS_CSV_PATH,
  CHECKER_INDEPENDENCE,
  claimReviewText,
  CONTAMINATION_NEEDS,
  PASS_FAIL_FALL,
  reproduceBreakdown,
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

const n0 = (x: number) => x.toLocaleString("en-US");
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
gated(AUDIT_2_FILE_PATH, () => {
  if (!validityGate(REFEREE_AUDIT_2).ok) return withheld();
  // The frozen census file as the audit script wrote it (public runs only: its frame excludes held-out seeds, held
  // events, embargoed models and private jobs).
  return new Response(`${JSON.stringify(REFEREE_AUDIT_2, null, 1)}\n`, { headers: { ...FILE_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
});
gated(AUDIT_2_TRAPS_CSV_PATH, () => (validityGate(REFEREE_AUDIT_2).ok ? csv(perTrapCsv(REFEREE_AUDIT_2), "forge-referee-audit-2-per-trap.csv") : withheld()));
gated(AUDIT_2_DISAGREEMENTS_CSV_PATH, () => (validityGate(REFEREE_AUDIT_2).ok ? csv(disagreementsCsv(REFEREE_AUDIT_2, disagreementStatuses(REFEREE_AUDIT_2, REFEREE_AUDIT_ADJUDICATIONS)), "forge-referee-audit-2-disagreements.csv") : withheld()));
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

/** The error record's anchor for an entry about one run: what the reproduce section links to. */
export const entryAnchor = (e: Pick<ErrorEntry, "kind" | "runs">) => (e.runs.length === 1 ? `er-${e.kind}-${e.runs[0]!.split("/").at(-1)!.slice(0, 8)}` : null);

/** One audit's reproduce check in plain words, naming the runs that differ and linking each to its error-record entry. */
function reproduceText(b: ReturnType<typeof reproduceBreakdown>, entries: readonly ErrorEntry[], label: string) {
  const anchors = new Set(entries.map(entryAnchor).filter(Boolean));
  const link = (run: string, kind: ErrorEntry["kind"]) => {
    const id = `er-${kind}-${run.slice(0, 8)}`;
    return anchors.has(id) ? html`<a href="#${id}">${run.slice(0, 8)}</a>` : html`<a href="/arena/run/${run}">${run.slice(0, 8)}</a>`;
  };
  const list = (xs: readonly { run: string }[], kind: ErrorEntry["kind"]) => xs.map((x, i) => html`${i ? ", " : ""}${link(x.run, kind)}`);
  const w = b.worlds_differ_job_code_changed;
  const v = b.verdicts_differ;
  const vParts = [
    v.audit_disagreements.length ? html`${v.audit_disagreements.length} ${v.audit_disagreements.length === 1 ? "is an audit disagreement" : "are audit disagreements"}, where the referee in force at the audit already gave the corrected verdict (${list(v.audit_disagreements, "audit_disagreement")})` : null,
    v.job_code_changed.length ? html`${v.job_code_changed.length} ${v.job_code_changed.length === 1 ? "is" : "are"} among the replays whose job's code changed (${list(v.job_code_changed, "reproduce_difference")})` : null,
    v.not_yet_explained.length ? html`${v.not_yet_explained.length} score a task-completion checkpoint differently today with the same pass/fail and no change to the job's world, which is not yet explained (${list(v.not_yet_explained, "reproduce_difference")})` : null,
  ].filter(Boolean);
  const vDiff = b.runs - b.verdicts_identical;
  return html`<p data-reproduce="${b.audit_id}">${label}: the world and every tool output were rebuilt identically for ${b.worlds_identical} of ${b.runs}${w.length ? html`; the other ${w.length} ${w.length === 1 ? "is a replay" : "are replays"} of ${[...new Set(w.map((x) => x.task))].join(", ")} whose job's code changed after ${w.length === 1 ? "it was" : "they were"} played (${list(w, "reproduce_difference")})` : ""}. The referee re-run gave the identical verdict for ${b.verdicts_identical} of ${b.runs}${vDiff ? html`; of the other ${vDiff}, ${vParts.map((x, i) => html`${i ? (i === vParts.length - 1 ? ", and " : ", ") : ""}${x}`)}` : ""}. Each run named here has its entry in the error record.</p>`;
}

gated(VALIDITY_PATH, async (c) => {
  const d = await validityData(getDb(c.env), c.env.PUBLIC_ORIGIN);
  if (d.status !== "published") return withheld();
  if (wantsJson(c)) return sendJson(c, d, 300);
  const a = d.referee_audit;
  const a2 = d.referee_audit_2;
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
<div class="summary-3" data-headlines>${a2 ? html`<p data-census-headline>${d.headlines[0]}</p><p class="small muted">Referee audit ${a.audit_id.replace("referee-audit-", "")}, the first pass, on a sample, that found the ${a.disagreements.length} errors:</p>` : ""}${d.headlines.slice(a2 ? 1 : 0).map((h) => html`<p>${h}</p>`)}</div>
<p class="small" data-terms>${PASS_FAIL_FALL}</p>
${a2
  ? html`<section id="referee-audit-2"><h2>1. Referee audit ${a2.audit_id.replace("referee-audit-", "")} (${a2.date}): every public ranked replay</h2>
<p>${a2.what}</p>
<dl class="facts">
<dt>Frame</dt><dd>${a2.frame.runs} public ranked replays (${a2.frame.definition}). Every one was re-graded, with no sampling.</dd>
<dt>Agreement</dt><dd data-agreement-2><b>${n0(a2.overall.agree)} of ${n0(a2.overall.n)}</b> trap verdicts (${pct(a2.overall.agreement)}, 95% ${ci(a2.overall.ci_95)}); Cohen's kappa ${a2.overall.kappa ?? "n/a"}.</dd>
<dt>Whole runs</dt><dd>${a2.run_level.all_trap_verdicts_identical} of ${a2.run_level.runs} runs had every trap verdict the same.</dd>
<dt>Disagreements</dt><dd>${a2.same_disagreements_as ? `The same ${REFEREE_AUDIT_2.disagreements.length} as audit ${a2.same_disagreements_as.replace("referee-audit-", "")} (listed below), ` : `${REFEREE_AUDIT_2.disagreements.length}, `}${a2.disagreements_now.every((x) => x.status_now === "fixed_and_rescored") ? "all now fixed and re-scored." : `${a2.disagreements_now.filter((x) => x.status_now === "fixed_and_rescored").length} now fixed and re-scored.`}</dd>
${Object.entries((a2.referee_under_rules ?? {}) as Record<string, { n: number; agree: number }>).map(([rules, x]) => html`<dt>Under ${rules}</dt><dd>The referee re-run under ${rules} agreed with the checker on ${n0(x.agree)} of ${n0(x.n)} trap verdicts.</dd>`)}
<dt>Method</dt><dd>The same checker and method as audit 1 (checker commit <code>${String(a2.method.checker_commit ?? "").slice(0, 7)}</code>). ${CHECKER_INDEPENDENCE}</dd>
</dl>
<p class="small muted">Files: <a href="${AUDIT_2_FILE_PATH}">audit result (JSON)</a>, <a href="${AUDIT_2_TRAPS_CSV_PATH}">per trap (CSV)</a>, <a href="${AUDIT_2_DISAGREEMENTS_CSV_PATH}">disagreements (CSV)</a>. Public runs only.</p>
</section>`
  : ""}

<section id="referee-audit"><h2>${a2 ? "" : "1. "}Referee audit ${a.audit_id.replace("referee-audit-", "")} (${a.date})${a2 ? html`: the first pass, on a sample, that found the ${a.disagreements.length} errors` : ""}</h2>
<p>${a.what}</p>
<dl class="facts">
<dt>Frame</dt><dd>${a.frame.runs} public ranked replays (${a.frame.definition}).</dd>
<dt>Sample</dt><dd>${a.sample.runs} replays across ${a.sample.job_versions} job versions: all ${a.sample.runs_with_a_sprung_trap} with a referee-sprung trap, plus ${a.sample.random_runs} drawn at random (${a.sample.random_per_job} per job version, seed <code>${a.sample.seed_text}</code>).</dd>
<dt>Agreement</dt><dd data-agreement><b>${a.overall.agree} of ${a.overall.n}</b> trap verdicts (${pct(a.overall.agreement)}, 95% ${ci(a.overall.ci_95)}); Cohen's kappa ${a.overall.kappa ?? "n/a"}.</dd>
<dt>Sprung traps</dt><dd>Of the ${a.referee_sprung.n} traps the referee marked sprung, the checker also found ${a.referee_sprung.checker_agrees} (95% ${ci(a.referee_sprung.ci_95)}). Of the ${a.checker_sprung.n} the checker found, the referee had marked ${a.checker_sprung.referee_agrees}.</dd>
<dt>Whole runs</dt><dd>${a.run_level.all_trap_verdicts_identical} of ${a.run_level.runs} runs had every trap verdict the same.</dd>
<dt>Published verdicts found wrong</dt><dd>At the audit: ${a.adjudicated.published_verdicts_found_wrong.k} of ${a.adjudicated.published_verdicts_found_wrong.n} (95% ${ci(a.adjudicated.published_verdicts_found_wrong.ci_95)}).</dd>
<dt>Method</dt><dd>${a.method.checker}. It shares the job's world and answer key with the referee, and no referee code. ${CHECKER_INDEPENDENCE} ${a.method.grading}. Scope: ${a.method.scope}. ${a.method.intervals}.</dd>
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
<dt>Difference</dt><dd>${k.difference === null ? "not yet measured" : html`${(k.difference * 100).toFixed(1)} points (95% ${k.difference_ci_95 ? `${(k.difference_ci_95[0] * 100).toFixed(1)} to ${(k.difference_ci_95[1] * 100).toFixed(1)} points` : "no interval"})`}${k.at_ceiling ? html`. <b>Both sides pass every attempt, so this comparison can't show a difference yet.</b> ${CONTAMINATION_NEEDS}` : ""}</dd>
<dt>Effect status</dt><dd>${d.contamination.public_vs_held_out.status.status.replace(/_/g, " ")} (${d.contamination.public_vs_held_out.status.test_rows} test rows from ${d.contamination.public_vs_held_out.status.test_events} events).</dd>
<dt>Answer keys</dt><dd>In the ${s.replays} audited replays, ${s.outputs_containing_the_answer_key} of ${s.tool_outputs} tool outputs contained a job's answer key, ${s.outputs_with_a_key_field} carried a key field and ${s.briefs_containing_the_answer_key} briefs contained it.</dd>
</dl>
<ul class="small">${d.contamination.controls.map((x) => html`<li>${x.how}. <span class="muted">${x.enforced_by}.</span></li>`)}</ul>
</section>

<section id="error-record"><h2>3. Error record</h2>
<p data-error-record-intro>Every correction to the Arena's published results and traps, dated. ${a2
  ? html`It is shown only together with referee audit ${a2.audit_id.replace("referee-audit-", "")} above (${a2.date}: ${a2.overall.agree.toLocaleString("en-US")} of ${a2.overall.n.toLocaleString("en-US")} verdicts agreed, every one of the ${a2.sample.runs.toLocaleString("en-US")} public ranked replays checked), so it reads as a measured error rate.`
  : html`It is shown only together with referee audit ${a.audit_id.replace("referee-audit-", "")} above (${a.overall.agree} of ${a.overall.n} verdicts agreed, ${a.sample.runs} replays sampled), so it reads as a measured error rate.`}</p>
<ol class="runs" data-error-record>${d.error_record.entries.map((e) => html`<li${entryAnchor(e) ? html` id="${entryAnchor(e)}"` : ""}><b>${e.date}</b> · ${e.title} <span class="label">${e.status.replace(/_/g, " ")}</span><br><span class="small">${e.what}</span>${e.runs.length ? html` <span class="small">${e.runs.map((u) => html`<a href="${u}">${u.split("/").at(-1)!.slice(0, 8)}</a> `)}</span>` : ""}${e.traps.length ? html` <span class="small muted">${e.traps.map((t) => html`<a href="/arena/failures/${t}">${t}</a> `)}</span>` : ""}</li>`)}</ol>
<p class="small muted">Files: <a href="${ERROR_RECORD_JSON_PATH}">error record (JSON)</a>, <a href="${ERROR_RECORD_CSV_PATH}">CSV</a>. Each trap's own history is on its page under <a href="/arena/failures">failure modes</a>.</p>
</section>

<section id="claim-review"><h2>Claim-trap class review</h2>
${claimReviewText().map((x) => html`<p>${x}</p>`)}
</section>

<section id="reproduce"><h2>4. Reproduce a public run</h2>
<pre class="verdict-line">${r.command}</pre>
<p>From ${r.works_from}. It checks: ${r.checks.join("; ")}. The audits below name every run that didn't rebuild exactly, and why.</p>
${r.differences.map((b) => reproduceText(b, d.error_record.entries, b.audit_id === REFEREE_AUDIT_2.audit_id ? `In referee audit ${b.audit_id.replace("referee-audit-", "")}'s ${b.runs} replays` : `In referee audit ${b.audit_id.replace("referee-audit-", "")}'s ${b.runs} sampled replays`))}
<p><b>Model outputs vary.</b> ${r.model_variance.statement} Across ${r.model_variance.three_of_three.groups} model-job-seed groups with three attempts, ${r.model_variance.three_of_three.same_pass_fail_on_every_attempt} reached the same pass/fail every time and ${r.model_variance.three_of_three.same_verdict_and_traps_on_every_attempt} also sprang the same traps.</p>
</section>
<p class="small muted"><a href="${VALIDITY_JSON_PATH}">This page as JSON</a> · <a href="/benchmark">The Trap Set</a> · <a href="/benchmark/held-out">Held-out contract</a></p>`,
  });
});
