import { CANARY } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { dayText } from "../arena/error-record";
import { citationCff, frozenVersions, RESEARCH_SUBTITLE, RESEARCH_TITLE, RESEARCH_VALIDITY_JSON_PATH, RESEARCH_VALIDITY_PATH, researchIndex, versionCffPath, versionJsonPath, versionPath, type RefereeValidity } from "../arena/research-validity";
import { VALIDITY_PATH } from "../arena/validity";
import { send, sendJson, site, wantsJson } from "./pages";
import { asPreview, validityAccess } from "./validity-release";

// /research/referee-validity (ADR 0149): the referee audit as a citable research report. Each version's page and JSON
// are rendered from its frozen text (src/seed/research/), never from live data, so a version reads the same forever.
// Part of the validity pack, so behind the same release switch (VALIDITY_PUBLIC): 404 for everyone but an admin until on.

type Ctx = Context<{ Bindings: Env }>;
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "not measured" : `${(x * 100).toFixed(1)}%`);
const ci = (c: readonly [number, number] | null | undefined) => (c ? `${pct(c[0])}–${pct(c[1])}` : "no interval");
const n0 = (x: number) => x.toLocaleString("en-US");
const words = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ");
/** Frozen files: the bytes never change, so browsers and the edge may keep them a day. */
const FROZEN_HEADERS = { "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" };

function gated(path: string, handler: (c: Ctx) => Response | Promise<Response>) {
  site.get(path, async (c) => {
    const access = await validityAccess(c);
    if (!access) return c.notFound();
    const res = await handler(c);
    return access === "admin_preview" ? asPreview(res) : res;
  });
}

gated(RESEARCH_VALIDITY_JSON_PATH, (c) => sendJson(c, researchIndex(c.env.PUBLIC_ORIGIN), 300));

gated(RESEARCH_VALIDITY_PATH, (c) => {
  const d = researchIndex(c.env.PUBLIC_ORIGIN);
  if (wantsJson(c)) return sendJson(c, d, 300);
  return send(c, {
    title: RESEARCH_TITLE,
    description: `${RESEARCH_TITLE}: ${RESEARCH_SUBTITLE}. Every version is frozen when published, with its method, results, disagreements, corrections and limitations.`,
    path: RESEARCH_VALIDITY_PATH,
    nav: "benchmark",
    jsonAlternate: RESEARCH_VALIDITY_JSON_PATH,
    canary: CANARY,
    body: html`<div class="prose">
<p class="eyebrow"><a href="/benchmark">The Forge Trap Set</a> · Research</p>
<h1 class="page-title">${RESEARCH_TITLE}</h1>
<p class="lead">How often is the referee that scores the Trap Set wrong? An independent checker, written from the trap rules and sharing no referee code, re-grades every public ranked replay. Each version of this report is frozen on the day it is published and never recomputed.</p>
${d.latest ? html`<p data-latest>Latest: <a href="${versionPath(d.latest.version)}">version ${d.latest.version}, ${dayText(d.latest.date)}</a>.</p><p class="small">Cite it as: <span data-citation>${d.latest.citation}</span></p>` : html`<p class="empty">No version is published yet.</p>`}
<h2>Every version</h2>
<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Version</th><th scope="col">Date</th><th scope="col">Audit</th><th scope="col">Files</th></tr></thead><tbody>
${d.versions.map((v) => html`<tr data-version="${v.version}"><td><a href="${versionPath(v.version)}">v${v.version}</a></td><td>${dayText(v.date)}</td><td>${v.audit_id}</td><td><a href="${versionJsonPath(v.version)}">JSON</a> · <a href="${versionCffPath(v.version)}">CITATION.cff</a> <span class="small muted">sha256 <code>${v.sha256.slice(0, 12)}…</code></span></td></tr>`)}
</tbody></table></div>
<p class="small muted">${d.policy} The live figures, with today's error record, are on <a href="${VALIDITY_PATH}">the validity page</a>. <a href="${RESEARCH_VALIDITY_JSON_PATH}">This list as JSON</a>.</p>
</div>`,
  });
});

/** One frozen version as a page: every number is read from the frozen document. */
function versionPage(c: Ctx, d: RefereeValidity, sha256: string) {
  const r = d.results;
  const rc = d.reproducibility.reproduce_check_at_audit;
  return send(c, {
    title: `${RESEARCH_TITLE}, version ${d.version}`,
    description: d.summary[0]!,
    path: versionPath(d.version),
    nav: "benchmark",
    jsonAlternate: versionJsonPath(d.version),
    canary: CANARY,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: d.title,
      version: String(d.version),
      datePublished: d.date,
      url: d.url,
      description: d.summary.join(" "),
      creator: { "@type": "Organization", name: "The Agent Forge" },
      distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: d.json_url }],
    },
    body: html`<div class="prose">
<p class="eyebrow"><a href="${RESEARCH_VALIDITY_PATH}">Research</a> · Version ${d.version} · ${dayText(d.date)} · frozen</p>
<h1 class="page-title">${RESEARCH_TITLE}</h1>
<p class="lead">${RESEARCH_SUBTITLE[0]!.toUpperCase()}${RESEARCH_SUBTITLE.slice(1)}.</p>
<div class="summary-3" data-summary>${d.summary.map((s) => html`<p>${s}</p>`)}</div>
<p class="small" data-citation-block><b>Cite as:</b> <span data-citation>${d.citation.text}</span> · <a href="${versionCffPath(d.version)}">CITATION.cff</a> · <a href="${versionJsonPath(d.version)}">JSON</a> <span class="muted">(sha256 <code>${sha256}</code>)</span></p>
<p class="small muted">${d.versioning}</p>

<h2 id="method">1. Method</h2>
<p>${d.method.what}</p>
<dl class="facts">
<dt>Design</dt><dd>${d.method.design}.</dd>
<dt>Checker</dt><dd><code>${d.method.checker}</code>, commit <code>${String(d.method.checker_commit ?? "").slice(0, 7)}</code>, committed before it was run on real replays.</dd>
<dt>World</dt><dd>${d.method.world}.</dd>
<dt>Shared with the referee</dt><dd>${d.method.shared_with_referee.join("; ")}.</dd>
<dt>Not shared</dt><dd>${d.method.not_shared_with_referee.join("; ")}.</dd>
<dt>Independence</dt><dd>${d.method.independence}</dd>
<dt>Grading</dt><dd>${d.method.grading}; ${d.method.adjudication}.</dd>
<dt>Scope and unit</dt><dd>${d.method.scope}; one unit is ${d.method.unit}.</dd>
<dt>Intervals</dt><dd>${d.method.intervals}.</dd>
<dt>Frontier jobs</dt><dd>${d.method.frontier_checker.why} <span class="muted">(<code>${d.method.frontier_checker.file}</code>)</span></dd>
</dl>

<h2 id="frame">2. What was re-graded</h2>
<p>${n0(d.frame.runs)} replays across ${d.frame.job_versions} job versions, ${n0(d.frame.trap_verdicts)} trap verdicts: ${d.frame.definition}. Left out: ${d.frame.left_out.join("; ")}.</p>
<p class="small muted">Read from: ${d.frame.read_from}. Every run, its seed, its log sha256 and both verdicts are listed in <a href="${d.frame.runs_listed_in}">the audit file</a> (frame sha256 <code>${d.frame.frame_sha256.slice(0, 12)}…</code>).</p>

<h2 id="results">3. Results</h2>
<dl class="facts">
<dt>Agreement</dt><dd data-agreement><b>${n0(r.agreement.agree)} of ${n0(r.agreement.n)}</b> trap verdicts (${pct(r.agreement.rate)}, 95% ${ci(r.agreement.ci_95)}); Cohen's kappa ${r.agreement.kappa ?? "n/a"}.</dd>
<dt>Published error rate</dt><dd data-error-rate><b>${r.published_error_rate.wrong} of ${n0(r.published_error_rate.n)}</b> (${pct(r.published_error_rate.rate)}, 95% ${ci(r.published_error_rate.ci_95)}): ${r.published_error_rate.definition}.</dd>
<dt>Whole runs</dt><dd>${r.runs_with_every_verdict_identical.identical} of ${r.runs_with_every_verdict_identical.runs} runs had every trap verdict the same.</dd>
<dt>Sprung traps</dt><dd>Of the ${r.referee_sprung_traps_the_checker_also_found.n} traps the referee marked sprung, the checker also found ${r.referee_sprung_traps_the_checker_also_found.checker_agrees}. Of the ${r.checker_sprung_traps_the_referee_also_marked.n} the checker found, the referee had marked ${r.checker_sprung_traps_the_referee_also_marked.referee_agrees}.</dd>
${Object.entries(r.referee_under_later_rules).map(([rules, x]) => html`<dt>Under ${rules}</dt><dd>The referee of ${rules}, re-run on every replay, agreed with the checker on ${n0(x.agree)} of ${n0(x.n)} (not the published verdicts; not in the figures above).</dd>`)}
<dt>Answer keys</dt><dd>${r.answer_key_scan.outputs_containing_the_answer_key} of ${n0(r.answer_key_scan.tool_outputs)} tool outputs in the ${r.answer_key_scan.replays} replays contained a job's answer key.</dd>
</dl>
<details><summary>Agreement by trap (${r.per_public_trap.length} public traps)</summary>
<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Trap</th><th scope="col" class="num">Verdicts</th><th scope="col" class="num">Agree</th><th scope="col">95% interval</th></tr></thead><tbody>
${r.per_public_trap.map((t) => html`<tr><td><a href="/arena/failures/${t.public_trap_id}">${t.public_trap_id}</a>${t.lower_bound_trap ? html` <span class="small muted">(reads free text)</span>` : ""}</td><td class="num">${t.n}</td><td class="num">${t.agree}</td><td>${ci(t.ci_95)}</td></tr>`)}
</tbody></table></div></details>

<h2 id="disagreements">4. Every disagreement</h2>
<p class="small muted">Status as of ${dayText(d.date)}. Each replay is public and signed.</p>
<div class="table-wrap"><table class="table stack"><thead><tr><th scope="col">Replay</th><th scope="col">Referee said</th><th scope="col">Checker said</th><th scope="col">What the log shows</th><th scope="col">Resolution</th></tr></thead><tbody>
${d.disagreements.map(
  (x) => html`<tr data-run="${x.run}"><td><a href="${x.replay}">${x.run.slice(0, 8)}</a> <span class="muted small">${x.task} · <a href="/arena/failures/${x.public_trap_id}">${x.public_trap_id}</a></span></td><td>${words(x.referee_published)}</td><td>${words(x.checker)}</td><td>${(x.evidence as { text?: string } | null)?.text ? html`<q>${(x.evidence as { text: string }).text}</q> ` : ""}<span class="small">${x.reading}</span></td><td><b>${words(x.status.status)}</b>${x.status.rescored ? html`: fixed by ${x.fixed_by}, re-scored from the signed log on ${dayText(x.status.rescored.date)} (<a href="${x.status.rescored.source}">correction ${x.status.rescored.correction}</a>)` : x.fixed_by ? html`: fixed by ${x.fixed_by}` : ""}. <span class="muted small">At the audit: ${words(x.resolution_at_audit)}.</span></td></tr>`,
)}
</tbody></table></div>

<h2 id="corrections">5. Correction history</h2>
<ol class="runs">${d.correction_history.map((e) => html`<li><b>${dayText(e.date)}</b> · ${"title" in e ? e.title : `Referee rules changed: ${e.id}`}<br><span class="small">${e.what}</span>${e.traps.length ? html` <span class="small muted">${e.traps.join(", ")}</span>` : ""} <a class="small" href="${e.source}">source</a></li>`)}</ol>
<p class="small muted">Later corrections are in the live <a href="${d.links.error_record}">error record</a>.</p>

<h2 id="limitations">6. Limitations</h2>
<ul>${d.limitations.map((l) => html`<li>${l}</li>`)}</ul>

<h2 id="reproduce">7. Reproduce it from public endpoints</h2>
<p>From ${d.reproducibility.from}:</p>
<pre class="verdict-line">${d.reproducibility.rerun_the_audit}</pre>
<p>${d.reproducibility.what_to_expect}</p>
<p>One replay, rebuilt and checked byte for byte with its signature: <code>${d.reproducibility.reproduce_one_replay}</code>. At the audit ${rc.worlds_and_tool_outputs_identical} of ${rc.runs} worlds rebuilt identically and the referee re-run gave the identical verdict on ${rc.referee_rerun_identical_verdict}.</p>
<ul class="small">${d.reproducibility.public_endpoints.map((e) => html`<li>${e.what}: <code>${e.url}</code></li>`)}</ul>
<p class="small muted"><a href="${RESEARCH_VALIDITY_PATH}">Every version</a> · <a href="${VALIDITY_PATH}">The validity page (live)</a> · <a href="/dataset">Dataset spec</a></p>
</div>`,
  });
}

for (const { snapshot, doc } of frozenVersions()) {
  // The frozen file itself, byte for byte.
  gated(versionJsonPath(snapshot.version), () => new Response(snapshot.text, { headers: { ...FROZEN_HEADERS, "Content-Type": "application/json; charset=utf-8" } }));
  gated(versionCffPath(snapshot.version), () =>
    new Response(citationCff({ version: doc.version, date: doc.date, url: doc.url, json_url: doc.json_url, abstract: doc.summary.slice(0, 2).join(" ") }), { headers: { ...FROZEN_HEADERS, "Content-Type": "text/plain; charset=utf-8" } }),
  );
  gated(versionPath(snapshot.version), (c) => (wantsJson(c) ? new Response(snapshot.text, { headers: { ...FROZEN_HEADERS, "Content-Type": "application/json; charset=utf-8" } }) : versionPage(c, doc, snapshot.sha256)));
}
