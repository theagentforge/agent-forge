import { html } from "hono/html";
import { benchmarkData } from "../arena/benchmark";
import { homeHero, homeHeroJson } from "../arena/hero-proof";
import { editionPdf, TOTALS_NOT_RATES } from "../reports/reliability-pdf";
import {
  buildEdition,
  caseText,
  dayText,
  display,
  EDITION,
  methods,
  plain,
  REPORT_NAME,
  SERIES_PATH,
  SOURCE_FILES,
  SOURCES,
  type Edition,
  type Seg,
  type SourceKey,
  type Sources,
} from "../reports/reliability-edition";
import frozenFile from "../reports/editions/2026-q4.json";
import { getDb } from "../services/db";
import { securityJson } from "./security";
import { statsData } from "./stats";
import { send, sendJson, site } from "./pages";

// The State of Agent Reliability, Edition 1 (W5.1 / AQ-11, ADR 0079). One edition object drives the page, its JSON
// twin and the PDF. Before an edition is frozen, it is built live from the same in-process objects the public JSON
// files serve (so every number equals its source file, tested), and says it is a live preview. Freezing
// (`node scripts/reliability-report.mjs freeze`, or the "Reliability report" workflow) saves copies of the source
// files, the edition and its PDF; from then on the page reads the frozen edition and the static PDF is served from
// apps/forge/public, so the citable edition never changes under its readers.

export interface FrozenEdition {
  frozen: true;
  origin: string;
  edition: Edition;
  sources: Record<SourceKey, { path: string; file: string; fetched_at: string; sha256: string; bytes: number }>;
  pdf: { path: string; sha256: string; bytes: number };
}
type FrozenMarker = { frozen: false } | FrozenEdition;
export const FROZEN = frozenFile as unknown as FrozenMarker;

/** The live sources, from the same functions that serve each public JSON file. */
export async function liveSources(env: Env): Promise<Sources> {
  const origin = env.PUBLIC_ORIGIN;
  const [benchmark, stats, security, hero] = await Promise.all([
    benchmarkData(getDb(env), origin),
    statsData(env),
    securityJson(env),
    homeHero(env).catch(() => null),
  ]);
  // The home JSON twin's `hero.headline_source` (only that part of /?format=json is read).
  const home = { hero: { headline_source: hero ? homeHeroJson(hero, origin) : { status: "not_found" } } };
  // A JSON round trip, so values are exactly what the files serve (no undefined, no Dates).
  return JSON.parse(JSON.stringify({ benchmark, stats, security, home })) as Sources;
}

export async function currentEdition(env: Env, now = new Date()): Promise<Edition> {
  if (FROZEN.frozen) return FROZEN.edition;
  return buildEdition(await liveSources(env), { origin: env.PUBLIC_ORIGIN, mode: "live_preview", generatedAt: now.toISOString() });
}

/** Where a number's source can be read: the frozen copy once frozen, else the live file. */
function sourceHref(e: Edition, key: SourceKey) {
  return e.mode === "frozen" ? `${EDITION.sources_dir}/${SOURCE_FILES[key]}` : SOURCES[key];
}

/** One number: its display text, linked to its source file, with the source and JSON pointer as data attributes. */
function numHtml(e: Edition, id: string, fmt: Parameters<typeof display>[1]) {
  const x = e.nums[id];
  if (!x) return html`<span class="muted">not available</span>`;
  const how = x.op ? `${x.op}(${x.pointer}${x.pointer2 ? `, ${x.pointer2}` : ""})` : x.pointer;
  return html`<a class="src-num" href="${sourceHref(e, x.source)}" title="${SOURCES[x.source]} ${how}" data-num="${id}" data-source="${x.source}" data-pointer="${x.pointer}"${x.op ? html` data-op="${x.op}"` : ""}${x.pointer2 ? html` data-pointer2="${x.pointer2}"` : ""}><data value="${String(x.value)}">${display(x.value, fmt)}</data></a>`;
}

function segsHtml(e: Edition, segs: Seg[]) {
  return segs.map((s) => (typeof s === "string" ? html`${s}` : numHtml(e, s.n, s.fmt)));
}

/** The edition with each finding also as plain text (the JSON twin; structured data, no instructions). */
export function editionJson(e: Edition, origin: string, frozen: FrozenMarker = FROZEN) {
  return {
    ...e,
    url: `${origin}${EDITION.path}`,
    pdf: `${origin}${EDITION.pdf}`,
    frozen: frozen.frozen ? { sources: frozen.sources, pdf: frozen.pdf, copies: `${origin}${EDITION.sources_dir}/` } : null,
    findings: e.findings.map((f) => ({ ...f, plain: plain(f.text, e.nums), warning_plain: f.warning ? plain(f.warning, e.nums) : null })),
    methods: methods(e).map((m) => ({ title: m.title, plain: plain(m.text, e.nums) })),
    case_study: { ...e.case_study, plain: caseText(e) ? plain(caseText(e)!, e.nums) : null },
  };
}

const PDF_HEADERS = (bytes: number) => ({
  "Content-Type": "application/pdf",
  "Content-Disposition": `inline; filename="state-of-agent-reliability-${EDITION.slug}.pdf"`,
  "Content-Length": String(bytes),
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
});

export function pdfFor(e: Edition, origin: string) {
  return editionPdf(e, origin, { methods: methods(e), caseText: caseText(e) });
}

site.get(SERIES_PATH, (c) => c.redirect(EDITION.path, 302));
site.get(EDITION.json, async (c) => sendJson(c, editionJson(await currentEdition(c.env), c.env.PUBLIC_ORIGIN)));
// Once frozen, the static PDF in apps/forge/public is served before the Worker; until then this builds the preview.
site.get(EDITION.pdf, async (c) => {
  const pdf = pdfFor(await currentEdition(c.env), c.env.PUBLIC_ORIGIN);
  return new Response(pdf, { headers: PDF_HEADERS(pdf.byteLength) });
});

site.get(EDITION.path, async (c) => {
  const e = await currentEdition(c.env);
  const rv = e.rules_versions;
  const cs = caseText(e);
  const live = e.mode === "live_preview";
  return send(c, {
    title: `${REPORT_NAME}, Edition ${e.edition} (${e.quarter})`,
    description: "How often AI agents fell for planted traps in refereed business jobs, what a scan of public agent skills found, and what isn't known yet. Every number links to its source, with sample sizes and 95% intervals. Page and PDF.",
    path: EDITION.path,
    jsonAlternate: EDITION.json,
    image: `/og/reports/state-of-agent-reliability-${EDITION.slug}.png`,
    canary: e.canary ?? undefined,
    nav: "benchmark",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Report",
      name: `${REPORT_NAME}, Edition ${e.edition} (${e.quarter})`,
      // A live preview isn't published as the edition: no publication date until it is frozen.
      ...(live ? { creativeWorkStatus: "Draft", dateModified: e.generated } : { datePublished: e.generated }),
      author: { "@type": "Organization", name: "The Agent Forge", url: c.env.PUBLIC_ORIGIN },
      url: `${c.env.PUBLIC_ORIGIN}${EDITION.path}`,
      encoding: { "@type": "MediaObject", contentUrl: `${c.env.PUBLIC_ORIGIN}${EDITION.pdf}`, encodingFormat: "application/pdf" },
    },
    body: html`<article class="prose reliability-report">
<p class="eyebrow">Report · Edition ${e.edition} · ${e.quarter}</p>
<h1 class="page-title">${REPORT_NAME}</h1>
<p class="muted" id="stamp">Edition ${e.edition}, generated <time datetime="${e.generated}">${dayText(e.generated)}</time>. Rules versions: Arena referee <code>${rv.arena_referee ?? "n/a"}</code>, Trap Set <code>${rv.trap_set ?? "n/a"}</code>, skill scan <code>${rv.skill_scan ?? "n/a"}</code>, stats <code>${rv.stats_rules ?? "n/a"}</code>. Regenerated each quarter; the next edition is due in ${dayText(`${e.next_due}-01`).replace(/^1 /, "")}.</p>
${live ? html`<p class="panel chamfer" id="preview"><b>Live preview.</b> This edition isn't frozen yet: its numbers are read from the live source files each time the page is built. Once frozen, the numbers, the PDF and copies of the source files stay fixed under this address, so it can be cited.</p>` : ""}
<p class="lead">How often AI agents fall for planted traps in refereed business jobs, what a scan of public agent skills found, and what isn't known yet. Drawn only from The Agent Forge's own public data: every number links to the file it came from.</p>
<p><a class="btn chamfer" href="${EDITION.pdf}">Download the PDF</a> · <a href="${EDITION.json}">Data (JSON)</a> · <a href="#cite">How to cite</a> · <a href="#sources">Sources</a></p>

<h2 id="methods">Methods and limits</h2>
<p>Read these first: they say what each number can and can't tell you.</p>
<ul>${methods(e).map((m) => html`<li><b>${m.title}.</b> ${segsHtml(e, m.text)}</li>`)}</ul>

<h2 id="findings">Findings</h2>
<div data-findings>
${e.findings.map(
  (f, i) => html`<section id="${f.id}" data-finding="${f.id}">
<h3>${i + 1}. ${f.title}</h3>
<p>${segsHtml(e, f.text)}</p>
${f.warning ? html`<p class="small"><span class="label">${String(f.warning[0]).startsWith("Small sample") ? "Small sample" : "Limit"}</span> ${segsHtml(e, f.warning)}</p>` : ""}
<p class="small muted">Source: <a href="${sourceHref(e, f.source)}">${SOURCES[f.source]}</a> · <a href="${f.more}">full table</a></p>
</section>`,
)}
${e.groups.length
  ? html`<h3 id="by-job">Fall rate by kind of job</h3>
<p class="small muted">Ranked attempts under referee rules <code>${rv.arena_referee ?? "n/a"}</code>; at least one planted trap fallen for. No models are named or ranked here.</p>
<div class="table-wrap"><table class="table stack"><thead><tr><th scope="col">Kind of job</th><th scope="col" class="num">Attempts</th><th scope="col">Fell for a trap</th><th scope="col">95% interval</th></tr></thead><tbody>${e.groups.map(
      (g) => html`<tr><td class="wide">${numHtml(e, g.name, "text")}</td><td class="num" data-label="Attempts">${numHtml(e, g.attempts, "int")}</td><td data-label="Fell for a trap">${g.shown ? html`${numHtml(e, g.falls!, "int")} (${numHtml(e, g.rate!, "pct")})` : html`<span class="muted">too few to show a rate</span>`}</td><td data-label="95% interval">${g.shown ? html`${numHtml(e, g.lo!, "pct_lo")} to ${numHtml(e, g.hi!, "pct_hi")}${g.early ? html` <span class="label">Early read</span>` : ""}` : html`<span class="muted">–</span>`}</td></tr>`,
    )}</tbody></table></div>`
  : ""}
</div>

<h2 id="case">Illustrative case: ${e.nums.case_ranked?.value === true ? "a ranked bout" : "a practice bout"}</h2>
${cs
  ? html`<p data-case>${segsHtml(e, cs)}</p><p><a href="${e.case_study.replay_url}">Watch the refereed replay</a> · <a href="/methodology#replays">how replays are verified</a></p>`
  : html`<p class="muted">No public replay currently shows both a paid fake invoice and a model reporting the job done, so the case is left out rather than guessed.</p>`}

<h2 id="totals">Activity totals</h2>
<p class="small">Includes The Forge's own test agents. ${TOTALS_NOT_RATES} <a href="/stats/rules">How each is counted →</a></p>
<div class="table-wrap"><table class="table"><tbody>${e.totals.map((t) => html`<tr><td class="wide">${t.label}</td><td class="num">${numHtml(e, t.n, "int")}</td></tr>`)}</tbody></table></div>

<h2 id="sources">Sources and how to reproduce</h2>
<p>Every number above is a value at a JSON pointer in one of these public files (hover a number to see its pointer; the full list is in <a href="${EDITION.json}">the edition's data file</a>).${e.mode === "frozen" ? html` Copies of the files as they were read are kept with this edition, with their SHA-256 hashes in the data file.` : ""}</p>
<ul>${e.sources.map((s) => html`<li><code>${s.key}</code>: <a href="${s.path}">${s.path}</a>${e.mode === "frozen" ? html` (<a href="${EDITION.sources_dir}/${SOURCE_FILES[s.key]}">copy used for this edition</a>)` : ""}</li>`)}</ul>
<p>Derived numbers: ${Object.entries(e.ops).map(([op, t], i) => html`${i ? "; " : ""}<code>${op}</code>: ${t}`)}.</p>
<p>To rebuild the edition and its PDF from the saved files and check they match: <code>node scripts/reliability-report.mjs rebuild</code> in the <a href="https://github.com/theagentforge/agent-forge">public code</a>.</p>

<h2 id="cite">How to cite</h2>
${live ? html`<p class="panel chamfer" id="cite-preview"><b>Not citable yet.</b> This is a live preview: its numbers change until the edition is frozen. The citation below says so; cite the frozen edition once it is published at this address.</p>` : ""}
<p id="cite-text">${e.citation.text}</p>
<p>BibTeX:</p>
<pre class="verdict-line" id="cite-bibtex">${e.citation.bibtex}</pre>
<p>CITATION.cff:</p>
<pre class="verdict-line" id="cite-cff">${e.citation.cff}</pre>
${e.canary ? html`<p class="small">Canary: this page, its data and its PDF carry this line, so a leak into a training set can be searched for: <code id="canary">${e.canary}</code></p>` : ""}
<p class="small muted">Regenerated each quarter from the same public files; each edition keeps its own address. Data is free for evaluation, research and reporting with attribution, and not for training AI models (<a href="/arena/methodology#licence">licence</a>). Corrections: <a href="/results-policy#corrections">results policy</a>.</p>
</article>`,
  });
});

export const RELIABILITY_REPORT_PATH = EDITION.path;
