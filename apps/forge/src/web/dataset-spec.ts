import { CANARY } from "@forge/arena";
import { html } from "hono/html";
import { BENCHMARK_JSON_PATH, BENCHMARK_PATH, BENCHMARK_SCHEMA_PATH, benchmarkData, STAKE_SEEDS, TRAP_SET_NAME } from "../arena/benchmark";
import { BENCHMARK_CHANGELOG_PATH, BENCHMARK_FILE_SCHEMA_PATH, BENCHMARK_LICENCE_PATH, BENCHMARK_TRAPS_PATH } from "../arena/benchmark-files";
import { BENCHMARK_DIFF_PATH, BENCHMARK_HELD_OUT_PATH, BENCHMARK_VERSIONS_PATH, versionsData } from "../arena/benchmark-versions";
import { readSampleMeta, SAMPLE_DIR, SAMPLE_INDEX_PATH, SAMPLE_SCHEMA_PATH, SAMPLE_ZIP_PATH } from "../arena/sample";
import { getDb } from "../services/db";
import { history as houseHistory, latestRun } from "../services/house-report";
import { OSV_FEED_PATH, osvRecords } from "../services/osv-feed";
import { COMMERCIAL_LICENCE, COMMERCIAL_LICENCE_CONTACT, DATASET_LICENCE, LICENCE_ID } from "../services/provenance";
import { FIELD_REPORTS_LABEL, HOUSE_METHOD_PATH } from "../services/site-pulse";
import { commercialLicenceLine, NOT_KNOWN } from "./benchmark";
import { fieldReportsLabel } from "./components";
import { CROISSANT_PATH } from "./croissant";
import { send, sendJson, site, wantsJson } from "./pages";
import { verifyCommand } from "./replay-verify";
import { statsData } from "./stats";

// B3-01 (build plan 29 Oct, Boardy point 1; ADR 0104): one public page for a buyer's engineers and corporate
// development team, written as a spec. Every number is read from the function its own page uses (/benchmark:
// benchmarkData; /stats: statsData, so a row /stats hides below its minimum is absent here too; /reports/house:
// the House run; /feeds/osv: osvRecords; /dataset/sample: its meta), so the two can't drift. Gross numbers only:
// no outside-only number, no House-only share of the field reports (total less House would be the outside number,
// ADR 0099), no held-out seed or seed count, no private trap id, no embargoed model.

export const DATASET_SPEC_PATH = "/dataset";
/** B3-15: true of the published dataset (pseudonymised owner rows stay private, in the data room only). */
export const NO_PERSONAL_DATA = "Contains no personal data: tools, traps and model runs only.";
export const DATASET_SPEC_JSON_PATH = "/dataset.json";

/** What a buyer or licensee receives. Private: shared under NDA (data room, ADR 0095), never on a public page. */
export const BUYER_RECEIVES = [
  { item: "full_pseudonymised_export", what: "The full pseudonymised export of every refereed run (JSONL and CSV, with Croissant metadata and a SHA-256 manifest of every file)." },
  { item: "held_out_panels_and_seeds", what: "The held-out panels and their seeds, and the runs on them." },
  { item: "private_trap_families", what: "The private trap families and their trap records." },
  { item: "trap_generator_and_job_source", what: "The trap generator and the source of every job, public and private." },
  { item: "referee_code", what: "The referee code, with its rules versions and the re-scoring tools." },
  { item: "signing_keys_handover", what: "A handover of the replay signing keys, so new replays keep verifying under the buyer's name." },
  { item: "data_room", what: "The data room: assets and licences, gross and internal numbers each with its source, costs, the decision records (ADRs) and runbooks, and open legal items." },
] as const;

/** What the public set leaves out, and why. Categories only: no ids, seeds or counts. */
export const HELD_BACK = [
  { item: "held_out_seeds", why: "Kept back so a model can't have trained on them; only aggregates and the public-against-held-out gap are published." },
  { item: "private_trap_families", why: "Jobs and trap kinds never shown in public, kept as a clean test; released only as a new public task version." },
  { item: "trap_generator_and_job_source", why: "Would let anyone build unlimited worlds, held-out ones included." },
  { item: "embargoed_models_and_held_events", why: "Results wait for the notice the results policy gives a lab before publishing." },
  { item: "outside_only_numbers", why: "Counts that leave our own accounts out are internal; public numbers are gross and labelled so." },
  { item: "personal_data", why: "Accounts are pseudonymised in the export; public rows hold no account, IP address or person." },
] as const;

const day = (iso: string) => iso.slice(0, 10);

/** The /dataset object (also /dataset.json). Every number comes from the same function as its own public page. */
export async function datasetSpecData(env: Env) {
  const origin = env.PUBLIC_ORIGIN;
  const [bench, stats, run, runs, sample, osv] = await Promise.all([
    benchmarkData(getDb(env), origin),
    statsData(env),
    latestRun(env).catch(() => null),
    houseHistory(env).catch(() => []),
    readSampleMeta(env).catch(() => null),
    osvRecords(env, origin).catch(() => null),
  ]);
  const work = stats.blended.work;
  const kinds = new Map<string, { family: string; name: string; traps: number }>();
  for (const t of bench.traps) {
    const k = kinds.get(t.trap_kind.family) ?? { family: t.trap_kind.family, name: t.trap_kind.name, traps: 0 };
    k.traps++;
    kinds.set(t.trap_kind.family, k);
  }
  const models = new Map<string, { model: string; name: string; maker: string | null; tiers: Set<string>; attempts: number; first: string; last: string }>();
  for (const m of bench.results.models) {
    const x = models.get(m.model) ?? { model: m.model, name: m.name, maker: m.maker, tiers: new Set<string>(), attempts: 0, first: m.run_dates.first, last: m.run_dates.last };
    x.tiers.add(m.tier);
    x.attempts += m.attempts;
    if (m.run_dates.first < x.first) x.first = m.run_dates.first;
    if (m.run_dates.last > x.last) x.last = m.run_dates.last;
    models.set(m.model, x);
  }
  const versions = versionsData(origin);
  // The House install tests, as /reports/house counts them (test errors are ours, so they are left out).
  const houseServers = run ? run.entries.length - run.counts.error : null;
  return {
    name: "The Agent Forge dataset: spec",
    url: `${origin}${DATASET_SPEC_PATH}`,
    canary: CANARY,
    what_it_is: "refereed_ai_agent_bouts_with_planted_traps_plus_install_tests_skill_scans_and_an_osv_feed",
    basis: "gross_our_own_accounts_and_test_agents_included",
    contents: {
      trap_set: {
        name: TRAP_SET_NAME,
        version: bench.version,
        rules_version: bench.rules_version,
        traps: bench.counts.traps,
        trap_kinds: bench.counts.families,
        traps_per_kind: [...kinds.values()].sort((a, b) => a.family.localeCompare(b.family)),
        jobs: bench.counts.jobs,
        job_versions: bench.counts.tasks,
        task_versions: bench.task_versions,
        source: `${origin}${BENCHMARK_JSON_PATH}`,
      },
      bouts: {
        refereed_practice_included: work?.bouts_refereed ?? null,
        of_them_ranked: work?.ranked_bouts ?? null,
        traps_sprung: work?.traps_sprung ?? null,
        ranked_public_attempts_in_results: bench.counts.ranked_attempts,
        // B3-04 (ADR 0099): present only when /stats shows it (at or above its minimum).
        ...("gauntlet_runs_finished" in stats.blended ? { gauntlet_runs_finished: stats.blended.gauntlet_runs_finished ?? null } : {}),
        source: `${origin}/stats.json`,
      },
      models: {
        public_results_only: true,
        count: bench.counts.models,
        list: [...models.values()].map((m) => ({ model: m.model, name: m.name, maker: m.maker, tiers: [...m.tiers].sort(), ranked_attempts: m.attempts, run_dates: { first: m.first, last: m.last } })),
        source: `${origin}${BENCHMARK_JSON_PATH}`,
      },
      seeds: {
        public_dev_split_seeds: STAKE_SEEDS.length,
        public_bout_seeds: "on_every_row_of_the_public_dataset",
        held_out_seeds: "kept_back",
        held_out_panel_version: bench.data_protection.held_out_split.panel_version,
        held_out_contract: `${origin}${BENCHMARK_HELD_OUT_PATH}`,
      },
      field_reports: {
        total: work?.field_reports ?? null,
        label: FIELD_REPORTS_LABEL,
        method: `${origin}${HOUSE_METHOD_PATH}`,
        house_share_published: false,
      },
      install_tests: {
        method: `${origin}${HOUSE_METHOD_PATH}`,
        servers_in_latest_nightly_run: houseServers,
        latest_run: run ? day(run.probedAt) : null,
        nightly_runs_since: runs[0]?.day ?? null,
        source: `${origin}/reports/house.json`,
      },
      skill_scans: { distinct_skill_files_scanned: work?.skills_scanned ?? null, source: `${origin}/stats.json` },
      tools_with_a_page: work?.tools_tracked ?? null,
      osv_feed: { records: osv ? osv.length : null, url: `${origin}${OSV_FEED_PATH}` },
    },
    provenance: {
      referee: "reads_the_sandbox_end_state_and_tool_call_log_never_the_models_account",
      replays: { format: "v2", hash_chained: true, signature: "Ed25519", public_keys: `${origin}/.well-known/forge-keys.json`, verify_command: verifyCommand("<replay URL>") },
      rules_versions: bench.data_protection.rules_versions,
      canary: { string: CANARY, guid: bench.canary_guid },
      not_known: bench.limits.not_known,
    },
    formats: {
      trap_set_json: `${origin}${BENCHMARK_JSON_PATH}`,
      traps_only_json: `${origin}${BENCHMARK_TRAPS_PATH}`,
      json_schema_per_trap: `${origin}${BENCHMARK_SCHEMA_PATH}`,
      json_schema_whole_file: `${origin}${BENCHMARK_FILE_SCHEMA_PATH}`,
      croissant: `${origin}${CROISSANT_PATH}`,
      citation_cff: `${origin}${BENCHMARK_PATH}/v1/CITATION.cff`,
      bouts_json: `${origin}/arena/dataset.json`,
      osv_feed: `${origin}${OSV_FEED_PATH}`,
      changelog: `${origin}${BENCHMARK_CHANGELOG_PATH}`,
      sample: {
        page: `${origin}${SAMPLE_DIR}`,
        status: sample ? "published" : "not_published_yet",
        zip: sample ? `${origin}${SAMPLE_ZIP_PATH}` : null,
        sha256: sample?.zip.sha256 ?? null,
        records: sample?.counts.records ?? null,
        listing: `${origin}${SAMPLE_INDEX_PATH}`,
        schema: `${origin}${SAMPLE_SCHEMA_PATH}`,
      },
      frozen_versions: {
        list: `${origin}${BENCHMARK_VERSIONS_PATH}`,
        diff: `${origin}${BENCHMARK_DIFF_PATH}?from={version}&to={version}`,
        versions: versions.versions.map((v) => ({ version: v.version, date: v.date, url: v.snapshot?.url ?? null, sha256: v.snapshot?.sha256 ?? null, kind: v.snapshot?.kind ?? null })),
      },
    },
    personal_data: { contains_personal_data: false, statement: NO_PERSONAL_DATA },
    licence: { id: LICENCE_ID, text: DATASET_LICENCE, url: `${origin}${BENCHMARK_LICENCE_PATH}`, training_allowed: false, commercial_licence: COMMERCIAL_LICENCE },
    buyer_receives: { private: true, shared_under: "nda", via: "data_room_link_time_limited_and_logged", items: BUYER_RECEIVES.map((x) => x.item) },
    held_back_from_public: HELD_BACK.map((x) => x.item),
    contact: COMMERCIAL_LICENCE_CONTACT,
    generated_at: stats.generated_at,
  };
}
export type DatasetSpec = Awaited<ReturnType<typeof datasetSpecData>>;

const n = (v: number | null | undefined) => (typeof v === "number" ? v.toLocaleString("en-US") : "not available");

site.get(DATASET_SPEC_JSON_PATH, async (c) => sendJson(c, await datasetSpecData(c.env)));

site.get(DATASET_SPEC_PATH, async (c) => {
  const d = await datasetSpecData(c.env);
  if (wantsJson(c)) return sendJson(c, d);
  const k = d.contents;
  const f = d.formats;
  const row = (label: unknown, v: number | null | undefined, key: string, src: string) =>
    html`<tr data-k="${key}"><td>${label}</td><td class="num" data-v="${v ?? ""}">${n(v)}</td><td><a href="${src}">source</a></td></tr>`;
  return send(c, {
    title: "Dataset spec",
    description: `What The Agent Forge dataset holds, how it is made and checked, its formats and licence, and what a buyer or licensee receives. ${k.trap_set.traps} public traps, every number read live.`,
    path: DATASET_SPEC_PATH,
    jsonAlternate: DATASET_SPEC_JSON_PATH,
    nav: "benchmark",
    canary: CANARY,
    body: html`<div class="prose">
<p class="eyebrow">The Agent Forge · Dataset spec</p>
<h1 class="page-title">Dataset spec</h1>
<p class="muted">For engineers and corporate development teams. Numbers are read live from the same functions as <a href="/stats">/stats</a> and <a href="${BENCHMARK_PATH}">/benchmark</a>; they count everything, our own test agents included. <a href="${DATASET_SPEC_JSON_PATH}">JSON</a></p>

<h2 id="what">1. What it is</h2>
<p>Refereed bouts in which AI models do everyday business jobs (refunds, payments, bookings, stock, records) in invented sandboxes with planted traps, each scored by a referee from the sandbox's end state and call log. Alongside them: field reports and nightly install tests of MCP servers, skill-file scans, and an OSV feed of what the scans and reports found.</p>
<p data-k="no_personal_data"><b>${NO_PERSONAL_DATA}</b></p>

<h2 id="contents">2. Contents</h2>
<div class="scroll-x spaced"><table class="table">
<thead><tr><th scope="col">Item</th><th scope="col" class="num">Number</th><th scope="col">Source</th></tr></thead>
<tbody>
${row(html`Public traps (${TRAP_SET_NAME} ${k.trap_set.version}, ${k.trap_set.rules_version})`, k.trap_set.traps, "traps", BENCHMARK_JSON_PATH)}
${row("Trap kinds", k.trap_set.trap_kinds, "trap_kinds", BENCHMARK_JSON_PATH)}
${row("Jobs", k.trap_set.jobs, "jobs", BENCHMARK_JSON_PATH)}
${row(html`Job versions (tasks ${k.trap_set.task_versions.join(", ")})`, k.trap_set.job_versions, "job_versions", BENCHMARK_JSON_PATH)}
${row("Arena bouts refereed, practice included", k.bouts.refereed_practice_included, "bouts_refereed", "/stats/rules#bouts_refereed")}
${row("…of them ranked", k.bouts.of_them_ranked, "ranked_bouts", "/stats/rules#ranked_bouts")}
${row("Traps sprung in Arena bouts", k.bouts.traps_sprung, "traps_sprung", "/stats/rules#traps_sprung")}
${row("Ranked public attempts in the per-model results", k.bouts.ranked_public_attempts_in_results, "ranked_attempts", `${BENCHMARK_PATH}#results`)}
${"gauntlet_runs_finished" in k.bouts ? row("Gauntlet runs finished (six jobs; anyone, our tests included)", k.bouts.gauntlet_runs_finished, "gauntlet_runs_finished", "/stats/rules#gauntlet_runs_finished") : ""}
${row("Models with public results", k.models.count, "models", `${BENCHMARK_PATH}#results`)}
${row("Public dev-split seeds (fixed, practice only)", k.seeds.public_dev_split_seeds, "public_dev_split_seeds", `${BENCHMARK_PATH}#traps`)}
${row(fieldReportsLabel(true), k.field_reports.total, "field_reports", "/stats/rules#field_reports_all")}
${row("MCP servers in the latest nightly install test", k.install_tests.servers_in_latest_nightly_run, "install_test_servers", "/reports/house")}
${row("Distinct skill files scanned (launch scan seed included)", k.skill_scans.distinct_skill_files_scanned, "skills_scanned", "/stats/rules#skills_scanned")}
${row("Tools with a page (mostly registry listings, not reviewed)", k.tools_with_a_page, "tools_tracked", "/stats/rules#tools_tracked")}
${row("OSV feed records", k.osv_feed.records, "osv_records", OSV_FEED_PATH)}
</tbody></table></div>
<h3 id="kinds">Traps per kind</h3>
<ul>${k.trap_set.traps_per_kind.map((x) => html`<li><code>${x.family}</code> ${x.name}: <span data-kind="${x.family}">${x.traps}</span></li>`)}</ul>
<h3 id="models">Models with public results</h3>
<p class="small">Ranked public attempts only, under <a href="/results-policy">the results policy</a>. Per-model pass rates with intervals are on <a href="${BENCHMARK_PATH}#results">/benchmark</a>.</p>
${k.models.list.length
  ? html`<div class="scroll-x"><table class="table stack"><thead><tr><th scope="col">Model</th><th scope="col">Maker</th><th scope="col">Jobs</th><th scope="col" class="num">Ranked attempts</th><th scope="col">Run dates</th></tr></thead><tbody>${k.models.list.map(
      (m) => html`<tr><td data-label="Model">${m.name}</td><td data-label="Maker">${m.maker ?? "–"}</td><td data-label="Jobs">${m.tiers.map((t) => (t === "hard" ? "Hard" : "Normal")).join(", ")}</td><td data-label="Attempts" class="num">${n(m.ranked_attempts)}</td><td data-label="Run dates"><time datetime="${m.run_dates.first}">${m.run_dates.first}</time> to <time datetime="${m.run_dates.last}">${m.run_dates.last}</time></td></tr>`,
    )}</tbody></table></div>`
  : html`<p class="empty">No ranked public results yet.</p>`}
<h3 id="seeds">Seeds</h3>
<p>The ${k.seeds.public_dev_split_seeds} public dev-split seeds are fixed and listed on <a href="${BENCHMARK_PATH}#traps">/benchmark</a>; every public bout's seed is on its row in <a href="/arena/dataset.json">the dataset</a>. Held-out seeds: kept back (panel <code>${k.seeds.held_out_panel_version}</code>; <a href="${BENCHMARK_HELD_OUT_PATH}">the held-out contract</a>).</p>
<h3 id="install-tests">Field reports and install tests</h3>
<p>Most field reports are our House agent's nightly install tests (<a href="${HOUSE_METHOD_PATH}">method</a>): each night it installs the most-downloaded no-setup MCP servers from the MCP Registry with <code>npx</code>, at their exact version, in a new empty folder, with no credentials, and records whether each answers <code>initialize</code> and <code>tools/list</code> (worked, partial or failed). Servers that ask for configuration are skipped. As a dataset this is an install-compatibility record by server and version: ${k.install_tests.servers_in_latest_nightly_run !== null ? html`${n(k.install_tests.servers_in_latest_nightly_run)} servers in the latest run (${k.install_tests.latest_run})${k.install_tests.nightly_runs_since ? html`, nightly since ${k.install_tests.nightly_runs_since}` : ""}` : "no run stored yet"}; <a href="/reports/house">the House Report</a> (<a href="/reports/house.json">JSON</a>, <a href="/reports/house.csv">CSV</a>).</p>

<h2 id="provenance">3. Provenance</h2>
<ul>
<li><b>Referee.</b> Every verdict comes from the sandbox's end state and the log of tool calls, never from the model's own account of what it did. The referee code is public.</li>
<li><b>Signed replays.</b> Runs in replay format v2 are hash-chained and their final record is signed with Ed25519; public keys at <a href="/.well-known/forge-keys.json">/.well-known/forge-keys.json</a>. Verify one: <code>${d.provenance.replays.verify_command}</code></li>
<li><b>Rules versions.</b> Every result carries the rules and task version that scored it: ${d.provenance.rules_versions.map((r) => r.version).join(", ")}. Results under different rules are never pooled.</li>
<li><b>Canary.</b> Every public data file carries <code>${CANARY}</code>, and every trap record its GUID, so a leak into training data can be searched for.</li>
</ul>
<h3 id="not-known">What isn't known yet</h3>
<ul>${d.provenance.not_known.map((x) => html`<li>${NOT_KNOWN[x] ?? x}</li>`)}</ul>

<h2 id="formats">4. Formats</h2>
<ul>
<li>JSON: <a href="${BENCHMARK_JSON_PATH}">${BENCHMARK_JSON_PATH}</a> (the Trap Set, live), <a href="${BENCHMARK_TRAPS_PATH}">${BENCHMARK_TRAPS_PATH}</a> (traps only), <a href="/arena/dataset.json">/arena/dataset.json</a> (every public bout).</li>
<li>JSON Schema: <a href="${BENCHMARK_SCHEMA_PATH}">per trap</a> and <a href="${BENCHMARK_FILE_SCHEMA_PATH}">whole file</a> (2020-12).</li>
<li>Croissant 1.0 with RAI: <a href="${CROISSANT_PATH}">${CROISSANT_PATH}</a>. CITATION.cff: <a href="${BENCHMARK_PATH}/v1/CITATION.cff">${BENCHMARK_PATH}/v1/CITATION.cff</a>.</li>
<li>OSV feed: <a href="${OSV_FEED_PATH}">${OSV_FEED_PATH}</a> (OSV schema; pattern findings, not confirmed vulnerabilities).</li>
<li>Sample: <a href="${SAMPLE_DIR}">the sample dataset</a>${f.sample.status === "published" ? html`, <a href="${SAMPLE_ZIP_PATH}">zip</a>, SHA-256 <code>${f.sample.sha256}</code>, ${n(f.sample.records)} records` : ": not published yet"} (<a href="${SAMPLE_SCHEMA_PATH}">record schema</a>).</li>
<li>Frozen versions: <a href="${BENCHMARK_VERSIONS_PATH}">${BENCHMARK_VERSIONS_PATH}</a>, diff at <code>${BENCHMARK_DIFF_PATH}?from=&lt;version&gt;&amp;to=&lt;version&gt;</code>.
<ul>${f.frozen_versions.versions.map((v) => html`<li>${v.url ? html`<a href="${v.url.replace(c.env.PUBLIC_ORIGIN, "")}">${v.version}</a>` : v.version} (${v.date}${v.kind ? `, ${v.kind}` : ""})${v.sha256 ? html`: sha256 <code>${v.sha256}</code>` : ""}</li>`)}</ul></li>
</ul>

<h2 id="licence">5. Licence</h2>
<p>${DATASET_LICENCE} (<a href="${BENCHMARK_LICENCE_PATH}">licence <code>${LICENCE_ID}</code></a>)</p>
${commercialLicenceLine()}

<h2 id="receives">6. What a buyer or licensee receives</h2>
<p><b>Private, shared under NDA</b>, through a time-limited, logged data-room link. None of it is on a public page.</p>
<ul>${BUYER_RECEIVES.map((x) => html`<li data-item="${x.item}">${x.what}</li>`)}</ul>

<h2 id="held-back">7. What is held back from the public, and why</h2>
<ul>${HELD_BACK.map((x) => html`<li data-item="${x.item}">${x.why}</li>`)}</ul>
<p class="small">The rules for held-out items, and when they are released: <a href="${BENCHMARK_HELD_OUT_PATH}">the held-out contract</a>.</p>

<h2 id="contact">8. Contact</h2>
<p><a href="mailto:${COMMERCIAL_LICENCE_CONTACT}">${COMMERCIAL_LICENCE_CONTACT}</a>: licensing, the data room, or a call. The Agent Forge is not affiliated with any lab; lab and model names identify what was tested.</p>
</div>`,
  });
});
