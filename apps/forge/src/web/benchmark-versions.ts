import { CANARY } from "@forge/arena";
import { html } from "hono/html";
import { BENCHMARK_JSON_PATH, BENCHMARK_PATH, TRAP_SET, TRAP_SET_NAME } from "../arena/benchmark";
import { BENCHMARK_CHANGELOG_PATH, BENCHMARK_LICENCE_PATH } from "../arena/benchmark-files";
import {
  BENCHMARK_DIFF_PATH,
  BENCHMARK_HELD_OUT_JSON_PATH,
  BENCHMARK_HELD_OUT_PATH,
  BENCHMARK_VERSIONS_PATH,
  diffVersions,
  heldOutContract,
  snapshotPath,
  versionsData,
} from "../arena/benchmark-versions";
import { SNAPSHOTS } from "../seed/benchmark";
import { LICENCE_PATH } from "../services/provenance";
import { send, sendJson, site, wantsJson } from "./pages";

// B3-05 (ADR 0101): frozen Trap Set snapshots served byte for byte, the version list, the diff and the held-out contract.

const JSON_HEADERS = { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" };

for (const s of SNAPSHOTS) {
  // The committed file's text, unchanged: never parsed and re-serialised, so its sha256 is the one in versions.json.
  site.get(snapshotPath(s.version), (c) =>
    c.body(s.text, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      ETag: `"sha256-${s.sha256}"`,
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      Link: `<${c.env.PUBLIC_ORIGIN}${BENCHMARK_VERSIONS_PATH}>; rel="version-history", <${c.env.PUBLIC_ORIGIN}${LICENCE_PATH}>; rel="license"`,
    }),
  );
}

site.get(BENCHMARK_VERSIONS_PATH, (c) => c.json(versionsData(c.env.PUBLIC_ORIGIN), 200, JSON_HEADERS));

// Never edge-cached: the page cache drops `from` from its key (it is read as a tracking parameter), so a cached diff
// would be served for every `from`. The diff is cheap to compute.
const DIFF_HEADERS = { ...JSON_HEADERS, "Cache-Control": "no-store" };
site.get(BENCHMARK_DIFF_PATH, (c) => {
  const r = diffVersions(c.env.PUBLIC_ORIGIN, c.req.query("from"), c.req.query("to"));
  if (!r.ok) return c.json({ error: r.error, versions: r.versions, usage: `${BENCHMARK_DIFF_PATH}?from={version}&to={version}` }, 400, DIFF_HEADERS);
  return c.json(r.body, 200, DIFF_HEADERS);
});

const ITEM_TITLE: Record<string, string> = {
  held_out_seeds: "Held-out seeds",
  longitudinal_panel: "The longitudinal panel",
  private_trap_families: "Private trap families",
  unpublished_job_versions: "Unpublished job versions",
  trap_generator_and_job_source: "The trap generator and job source",
};
const LICENSEE: Record<string, string> = {
  held_out_panels_and_seeds: "the held-out panels and their seeds",
  private_trap_families_and_their_trap_records: "the private trap families, with their trap records",
  trap_generator_and_job_source: "the trap generator and the jobs' source code",
  referee_code: "the referee code",
  full_pseudonymised_run_export_with_sha256_manifest: "the full pseudonymised run export, with a SHA-256 manifest",
};
const words = (s: string) => s.replace(/_/g, " ");

site.get(BENCHMARK_HELD_OUT_JSON_PATH, (c) => c.json(heldOutContract(c.env.PUBLIC_ORIGIN), 200, JSON_HEADERS));
site.get(BENCHMARK_HELD_OUT_PATH, async (c) => {
  const d = heldOutContract(c.env.PUBLIC_ORIGIN);
  if (wantsJson(c)) return sendJson(c, d);
  const h = d.how_long_private;
  return send(c, {
    title: `${TRAP_SET_NAME}: held-out contract`,
    description: `What ${TRAP_SET_NAME} keeps back from the public (held-out seeds, private trap families, unpublished job versions, the trap generator), what is published about it, and for how long it stays private.`,
    path: BENCHMARK_HELD_OUT_PATH,
    jsonAlternate: BENCHMARK_HELD_OUT_JSON_PATH,
    canary: CANARY,
    nav: "arena",
    body: html`<div class="prose">
<h1 class="page-title">Held-out contract</h1>
<p class="muted">${TRAP_SET_NAME} ${d.trap_set_version} · <a href="${BENCHMARK_PATH}">the Trap Set</a> · <a href="${BENCHMARK_HELD_OUT_JSON_PATH}">JSON</a> · <a href="${BENCHMARK_VERSIONS_PATH}">frozen versions</a> · <a href="${BENCHMARK_LICENCE_PATH}">licence</a></p>
<p class="lead">Part of the test is never published, so a model can be scored on jobs it can't have seen. This page says what is kept back, what we publish about it, and the rules. It lists kinds of item only: no private trap id, job, seed or seed count.</p>

<h2 id="kept-back">What is kept back</h2>
<ul>${d.kept_back.map((k) => html`<li><b>${ITEM_TITLE[k.item] ?? words(k.item)}.</b> ${k.what[0]!.toUpperCase()}${k.what.slice(1)}.${"panel_version" in k ? html` Panel <code>${k.panel_version}</code>.` : ""}${"max_bouts_per_model_version" in k ? html` At most ${k.max_bouts_per_model_version} bouts per model version.` : ""}</li>`)}</ul>

<h2 id="published">What is published about it</h2>
<ul>
<li><b>Aggregates only.</b> No held-out brief, log, replay, clip or seed is published.</li>
<li><b>The public against held-out gap:</b> pass rate on public job versions minus pass rate on held-out ones, with a 95% interval (Newcombe), shown only with at least ${d.published_about_them.gap_method.min_attempts_each_side} attempts a side. On <a href="${BENCHMARK_PATH}#data-protection">the Trap Set page</a>, <a href="/arena/history#gap">Arena history</a> and in <a href="${BENCHMARK_JSON_PATH}">v1.json</a>.</li>
</ul>

<h2 id="breaking">What counts as a breaking change</h2>
<p>A major version of the Trap Set (from <a href="${BENCHMARK_CHANGELOG_PATH}">the versioning rules</a>): ${d.breaking_changes.major.map((m, i) => html`${i ? "; " : ""}${words(m)}`)}. Any change to the held-out or canary protocol is a major version.</p>

<h2 id="how-long">How long it stays private</h2>
<ul>
<li><b>Held-out panel:</b> private while it is in use, with no end date. It is replaced only by a new panel version with new seeds, because changing a seed breaks the time series.</li>
<li><b>Retiring a panel:</b> a retired panel stays private. Publishing one needs ${h.publishing_a_retired_panel_requires.map((x, i) => html`${i ? (i === h.publishing_a_retired_panel_requires.length - 1 ? " and " : ", ") : ""}${words(x).replace("adr", "(ADR)")}`)}. Panels retired so far: ${h.retired_panels_so_far}.</li>
<li><b>Private trap families:</b> private unless released in a public task version, which is a minor Trap Set version. A release publishes the family's public job versions and their trap records; the held-out seeds and the generator stay private.</li>
</ul>

<h2 id="canary">The canary</h2>
<p>Every public data file, every trap record (as <code>canary_guid</code>), every frozen snapshot and this contract carry this line, so a leak into a training set can be searched for. It never changes: <code>${d.canary}</code></p>

<h2 id="licensees">What a licensee receives under NDA</h2>
<ul>${d.licensee_under_nda.map((x) => html`<li>${LICENSEE[x] ?? words(x)}</li>`)}</ul>
<p>Ask <a href="mailto:${d.licensee_contact}">${d.licensee_contact}</a>. The public set stays under <a href="${d.public_licence.url}">the evaluation-only licence</a> (<code>${d.public_licence.id}</code>).</p>
</div>`,
  });
});

/** The "Frozen versions" block on /benchmark: each version, its snapshot and sha256. */
export function frozenVersionsBlock(origin: string) {
  const v = versionsData(origin);
  return html`<h2 id="versions">Frozen versions</h2>
<p><a href="${BENCHMARK_JSON_PATH}">v1.json</a> is the latest version, rebuilt on each request with live results. Each released version is also frozen as a file that never changes (the trap records, rules, schema and citation; no live results), listed with its sha256 in <a href="${BENCHMARK_VERSIONS_PATH}">versions.json</a>. Compare two: <a href="${BENCHMARK_DIFF_PATH}?from=${v.versions[0]?.version ?? TRAP_SET.version}&amp;to=${TRAP_SET.version}">diff</a>. What is never published: <a href="${BENCHMARK_HELD_OUT_PATH}">the held-out contract</a>.</p>
<ul>${v.versions.map((x) => html`<li><b>${x.version}</b> (${x.date})${x.snapshot ? html`: <a href="${snapshotPath(x.version)}">${snapshotPath(x.version)}</a> · ${x.snapshot.kind === "reconstructed" ? html`reconstructed on ${x.snapshot.made_on} from the catalog at commit <code>${x.snapshot.from_commit.slice(0, 7)}</code>, not the original bytes` : html`frozen on ${x.snapshot.made_on}`} · <code class="small">sha256 ${x.snapshot.sha256}</code>` : html`: <span class="muted">no snapshot</span>`}</li>`)}</ul>`;
}
