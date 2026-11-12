import { CANARY } from "@forge/arena";
import { sql } from "drizzle-orm";
import { html } from "hono/html";
import { BENCHMARK_JSON_PATH, BENCHMARK_PATH } from "../arena/benchmark";
import { BENCHMARK_LICENCE_PATH } from "../arena/benchmark-files";
import { SAMPLE_DIR } from "../arena/sample";
import * as t from "../db/schema";
import { CENSUS_DIR, CENSUS_GAPS, CENSUS_STATEMENT, DAY_BOUNDARY, FAILURE_CLASSES, latestBundle, METRICS, SERIES_HEADER, TAXONOMY_VERSION } from "../services/census";
import { getDb } from "../services/db";
import { DRIFT_DIR, driftTotals, METHOD as DRIFT_METHOD, SAMPLE_RULE } from "../services/drift-report";
import { COMMERCIAL_LICENCE_CONTACT, COMMERCIAL_LICENCE_LINE, DATASET_LICENCE, LICENCE_ID, LICENCE_PATH } from "../services/provenance";
import { BACKFILL_SINCE, backfillProgress, DRIFT_HEADER, EXCLUDED_REASONS, MAX_VERSIONS, PYPI_CAP } from "../services/tool-history";
import { CROISSANT_PATH, croissant } from "./croissant";
import { driftReleased, SAMPLE_PATH } from "./dataset-drift";
import { DATASET_SPEC_PATH, datasetSpecData, NO_PERSONAL_DATA } from "./dataset-spec";
import { send, sendJson, site, wantsJson } from "./pages";

// The datasheet (ADR 0148): one "Datasheets for Datasets" description (Gebru et al.: motivation, composition, collection
// process, preprocessing, uses, distribution, maintenance) per public dataset family, for a buyer's diligence team and
// for researchers who cite the data. Every number is read from the function its own page or file uses (datasetSpecData,
// the census manifest, backfillProgress, driftTotals); none is typed in. Gross totals only. Figures that only the drift
// report would publish (the backfill's server set and queue, the drift totals) appear only once DRIFT_PUBLIC is on, as on
// /dataset/drift. The licence text shown is the one each file carries today: this page never changes a licence.
// Machine-readable twin: /dataset/datasheet.json; Croissant for the census family: /dataset/croissant.json.

export const DATASHEET_PATH = "/dataset/datasheet";
export const DATASHEET_JSON_PATH = "/dataset/datasheet.json";
export const DATASET_CROISSANT_PATH = "/dataset/croissant.json";
/** Croissant spec version, checked on docs.mlcommons.org on 12 Nov 2026 (1.1, dated 29 Jan 2026; no newer version). */
export const CROISSANT_SPEC = "http://mlcommons.org/croissant/1.1";
export const CROISSANT_RAI = "http://mlcommons.org/croissant/RAI/1.0";
export const DATASHEET_VERSION = "datasheet/1";
export const SECTIONS = ["motivation", "composition", "collection_process", "preprocessing", "uses", "distribution", "maintenance"] as const;
export const SECTION_TITLES: Record<(typeof SECTIONS)[number], string> = {
  motivation: "Motivation",
  composition: "Composition",
  collection_process: "Collection process",
  preprocessing: "Preprocessing, cleaning and labelling",
  uses: "Uses",
  distribution: "Distribution and licence",
  maintenance: "Maintenance",
};

const day = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString().slice(0, 10));
const fmt = (v: number) => v.toLocaleString("en-US");
const NOT_PUBLIC_YET = "Published together with the drift report (not public yet).";

/** The tool-history and drift figures, read only once the drift report is public. */
async function backfillFigures(env: Env) {
  const [p, d, frozen] = await Promise.all([
    backfillProgress(env),
    driftTotals(env),
    getDb(env).all(sql`SELECT min(${t.toolHistoryServers.addedAt}) AS at FROM ${t.toolHistoryServers}`) as Promise<{ at: number | null }[]>,
  ]);
  return {
    // Gross totals only (owner's rule): the set's size and the versions recorded. The queue (pending, failed by class,
    // excluded by reason, lists read) stays on /admin/tool-history.
    frozen_on: day(frozen[0]?.at),
    tool_history: {
      servers_in_set: p.servers.total,
      of_them_npm: p.servers.npm,
      of_them_pypi: p.servers.pypi,
      versions_recorded: p.versions.done,
    },
    drift: {
      servers_in_set: d.servers_in_set,
      servers_compared: d.servers_compared,
      pairs_compared: d.pairs_compared,
      pairs_changed: d.pairs_changed,
      pairs_changed_without_major_bump: d.pairs_changed_without_major_bump,
      of_which_zero_major: d.of_which_zero_major,
      servers_changed_without_major_bump: d.servers_changed_without_major_bump,
      computed_through: d.computed_through,
    },
  };
}

/** The census files of the latest published version, counted from its manifest. */
async function censusFigures(env: Env) {
  const bundle = await latestBundle(env);
  const first = (await getDb(env).all(sql`SELECT min(${t.censusVersions.version}) AS v, count(*) AS n FROM ${t.censusVersions}`)) as { v: string | null; n: number }[];
  if (!bundle) return { status: "not_published_yet" as const, first_version: first[0]?.v ?? null, versions_published: Number(first[0]?.n ?? 0) };
  const n = (prefix: string) => bundle.hashes.filter((h) => h.path.startsWith(prefix)).length;
  return {
    status: "published" as const,
    latest_version: bundle.version,
    first_version: first[0]?.v ?? bundle.version,
    versions_published: Number(first[0]?.n ?? 0),
    files: bundle.hashes.length,
    bytes: bundle.hashes.reduce((s, h) => s + h.bytes, 0),
    server_history_months: n("server-history/"),
    tool_history_months: n("tool-history/"),
    nightly_rosters: n("roster/"),
  };
}

/** The known gaps of the measurement families, written from the code's own constants. */
export function knownGaps(frozenOn: string | null) {
  const failed = (["install_failed", "no_handshake", "needs_config"] as const).map((c) => `${c} (${FAILURE_CLASSES[c]})`).join("; ");
  return {
    frozen_server_set: `The backfill's server set was frozen the first time it was needed${frozenOn ? ` (${frozenOn})` : ""}: the latest nightly top-500 roster (npm) and the first ${PYPI_CAP} PyPI servers by name that the weekly sweep had seen start. A server that entered the top 500 later has only its forward history, and the PyPI part is not a popularity ranking.`,
    prereleases_excluded: `Prereleases are listed but never tested: ${EXCLUDED_REASONS.prerelease} A PyPI version whose every file is yanked is not listed; npm deprecated versions are.`,
    older_versions_last: `The newest ${MAX_VERSIONS} stable versions of each server are tested first and its older stable versions after every first-pass version; until they are re-queued, older versions are listed as over_cap (${EXCLUDED_REASONS.over_cap}).`,
    replaced_between_runs: "After a server's version list was read once, new versions are recorded only by the nightly House run (npm top-500) and the weekly sweep (PyPI), which test the version current at run time. A version published and replaced between two runs is never recorded.",
    failed_handshakes: `A version that didn't start has no recorded definitions: it is listed with its failure class (${TAXONOMY_VERSION}; for example ${failed}) and counted in untested_between of the pair that spans it, so a change may have come at a version we couldn't read.`,
    observed_not_published: "Backfilled definitions are what each version lists when we install it, not on its publish day; a server that builds its tool list from the network or the date can differ. Every row says observed_at for this reason.",
    self_report: "A server can detect the sandbox or return a dishonest tools/list about itself; the isolation protects other servers' results, not a server's own answer.",
    census_gaps: CENSUS_GAPS.map((g) => `${g.from} to ${g.to} (${g.metrics.join(", ")}): ${g.note}`).join(" "),
    absent_not_zero: "A day before a metric was first measured is absent, never a zero; a day not measured is an empty value.",
    hashes_only: "The public files hold hashes, counts and change classes only; the tool text itself is not public.",
  };
}

/** The datasheet object (also /dataset/datasheet.json). */
export async function datasheetData(env: Env) {
  const origin = env.PUBLIC_ORIGIN;
  const released = driftReleased(env);
  const [spec, census, bf] = await Promise.all([datasetSpecData(env), censusFigures(env), released ? backfillFigures(env) : Promise.resolve(null)]);
  const cr = croissant(origin);
  const k = spec.contents;
  const gaps = knownGaps(bf?.frozen_on ?? null);
  const evaluationOnly = { id: LICENCE_ID, text: DATASET_LICENCE, url: `${origin}${LICENCE_PATH}`, commercial: COMMERCIAL_LICENCE_LINE };
  const arena = {
    id: "arena_trap_set_results",
    name: "Arena and Trap Set results",
    status: "published",
    numbers: {
      public_traps: k.trap_set.traps,
      trap_kinds: k.trap_set.trap_kinds,
      jobs: k.trap_set.jobs,
      models_with_public_results: k.models.count,
      bouts_refereed_practice_included: k.bouts.refereed_practice_included,
      of_them_ranked: k.bouts.of_them_ranked,
      sample_records: spec.formats.sample.records,
      as_of: spec.as_of,
      source: `${origin}${DATASET_SPEC_PATH}.json`,
    },
    sections: {
      motivation: [
        "To measure, in public, how AI models behave when they do everyday business jobs (refunds, payments, bookings, stock, records) that contain planted traps modelled on real fraud and failure patterns, and to let anyone check each result.",
        "Made and paid for by The Agent Forge (theagentforge.io). No lab funds or commissions it (results policy).",
      ],
      composition: [
        "One record is one refereed attempt by one model at one job variant (a seed): model, job, tier, seed, attempt, pass, score, cost, tokens, rules and task versions, the public ids of traps sprung, a link to the signed full log, and a provenance block. Fields are listed in the Croissant file.",
        "Every sandbox is invented: no real companies, people or money. Ranked rows (card and guest events) and practice rows (calibration, never ranked) are labelled.",
        NO_PERSONAL_DATA,
      ],
      collection_process: [cr["rai:dataCollection"], cr["rai:dataCollectionMissingData"]],
      preprocessing: [cr["rai:dataPreprocessingProtocol"], cr["rai:dataAnnotationProtocol"]],
      uses: [cr["rai:dataUseCases"], cr["rai:dataLimitations"], cr["rai:dataBiases"]],
      distribution: [
        `Live JSON at ${origin}/arena/dataset.json; the Trap Set at ${origin}${BENCHMARK_JSON_PATH}; a fixed sample at ${origin}${SAMPLE_DIR}; Croissant 1.0 with RAI at ${origin}${CROISSANT_PATH}.`,
        `Licence carried by every file today: ${DATASET_LICENCE}`,
      ],
      maintenance: [cr["rai:dataReleaseMaintenancePlan"]],
    },
    known_gaps: [cr["rai:dataCollectionMissingData"], cr["rai:dataLimitations"]],
    licence: evaluationOnly,
    links: { page: `${origin}${BENCHMARK_PATH}`, data: `${origin}/arena/dataset.json`, croissant: `${origin}${CROISSANT_PATH}`, sample: `${origin}${SAMPLE_DIR}` },
  };
  const censusFamily = {
    id: "census",
    name: "Census of MCP server installs and scans",
    status: census.status,
    numbers: { ...census, metrics: METRICS.length, failure_classes: Object.keys(FAILURE_CLASSES).length, source: `${origin}${CENSUS_DIR}/manifest.json` },
    sections: {
      motivation: [
        "To keep a dated, never-overwritten record of whether published MCP servers install, start and answer, and of what the scanners read, so a claim about the ecosystem can be checked against stored rows rather than a live counter.",
        CENSUS_STATEMENT,
      ],
      composition: [
        `series.csv: one row per metric per UTC day (${SERIES_HEADER.join(", ")}). server-history/<YYYY-MM>.csv: one row per server per night per family. roster/<date>.csv: each night's top-500 roster. schema.json describes every field and metric.`,
        "Two House families with separate denominators, never added together: the nightly top-500 run (npm) and the weekly sweep of every no-setup npm and PyPI server.",
        "Servers are named by their public package ids. No account, person or IP address.",
      ],
      collection_process: [
        "The House tester installs each server at its exact version in a new empty folder with no credentials, as its own throwaway operating-system user, and records whether it answers the MCP initialize handshake and tools/list (ADR 0134 amendment 2).",
        DAY_BOUNDARY,
      ],
      preprocessing: [
        `Each raw outcome is mapped once to a closed failure taxonomy (${TAXONOMY_VERSION}). A daily snapshot is written once for the day just ended and never backfilled; earlier days are counted from stored, dated rows.`,
      ],
      uses: [
        "Install compatibility of MCP servers by server, version and night; trends in the share that install and answer. A failure class describes what our no-credentials test saw, not the server's quality or safety; a scanner pattern match is for a person to read, not a finding.",
      ],
      distribution: [
        `Files at stable URLs under ${origin}${CENSUS_DIR}, built once a day; manifest.json gives the sha256 of every file and the address of every earlier version's manifest. Croissant 1.1: ${origin}${DATASET_CROISSANT_PATH}.`,
        `Licence stated in schema.json today: ${DATASET_LICENCE}`,
      ],
      maintenance: ["A new version is published once a day by the hourly cron, from stored data. Each version's file list is kept for good, so any published version can be checked against its hashes."],
    },
    known_gaps: [gaps.census_gaps, gaps.absent_not_zero],
    licence: { ...evaluationOnly, stated_in: "schema.json" },
    links: { page: `${origin}${CENSUS_DIR}`, manifest: `${origin}${CENSUS_DIR}/manifest.json`, schema: `${origin}${CENSUS_DIR}/schema.json`, croissant: `${origin}${DATASET_CROISSANT_PATH}` },
  };
  const toolHistory = {
    id: "tool_definition_history",
    name: "Tool-definition history",
    status: census.status === "published" && census.tool_history_months > 0 ? "published" : "not_published_yet",
    numbers: { tool_history_files: census.status === "published" ? census.tool_history_months : null, ...(bf ? bf.tool_history : { backfill: NOT_PUBLIC_YET }) },
    sections: {
      motivation: [
        "MCP servers can change the tool names, descriptions and input schemas an agent reads between versions. The official MCP Registry does not version tool definitions; this history records them per server version, so a change can be dated and checked.",
      ],
      composition: [
        "One row per tool-definition set seen per server version: server, package, version, publish date, when we ran it, origin (nightly, carried or backfill), tools count, sha256 of the set, change class against the previous set, and for a version that didn't start, its failure class. Files by publish month in the census (tool-history/<YYYY-MM>.csv).",
        `Coverage: stable versions published since ${BACKFILL_SINCE} of the frozen server set, plus what the nightly and weekly House runs see going forward.`,
      ],
      collection_process: [DRIFT_METHOD[1]!, "Each version is installed as its own throwaway user on a public GitHub runner; each shard's results file is checked by sha256 before it is filed (ADR 0134 amendments 1 and 2)."],
      preprocessing: ["The set's names, descriptions and input schemas are hashed (sha256) as scanned; consecutive sets are compared per tool to give the change class. Origins never mix: a nightly sighting never overwrites a backfill row."],
      uses: ["Dating when a server's tool definitions changed, and how often. Not a judgement of any server."],
      distribution: [`Inside the census files (same URLs, manifest and licence statement as the census). The tool text is not public.`],
      maintenance: ["The backfill runs twice a day until every queued version is answered; an unanswered version is closed as test_error after three offers. Change classes are recomputed per tool when its history changes."],
    },
    known_gaps: [gaps.frozen_server_set, gaps.prereleases_excluded, gaps.older_versions_last, gaps.replaced_between_runs, gaps.failed_handshakes, gaps.observed_not_published, gaps.self_report, gaps.hashes_only],
    licence: { ...evaluationOnly, stated_in: "census schema.json" },
    links: { files: `${origin}${CENSUS_DIR}`, schema: `${origin}${CENSUS_DIR}/schema.json` },
  };
  const drift = {
    id: "drift_report",
    name: "Tool-definition drift report",
    status: released ? "published" : "not_published_yet",
    numbers: bf ? bf.drift : { totals: NOT_PUBLIC_YET },
    sections: {
      motivation: ["To show how often MCP servers' tool text changed between published versions without a major version change, the change an agent pinned to a major version would not expect."],
      composition: [
        `Public: totals over the whole set, and a seeded sample. ${SAMPLE_RULE}`,
        `drift.csv in the census: one row per changed consecutive pair (${DRIFT_HEADER.join(", ")}).`,
      ],
      collection_process: [DRIFT_METHOD[0]!, DRIFT_METHOD[1]!],
      preprocessing: [DRIFT_METHOD[2]!, DRIFT_METHOD[3]!],
      uses: [DRIFT_METHOD[5]!, "Pairs whose recorded text matched a scanner rule are not in the public sample, and no rule ids are public."],
      distribution: released
        ? [`Totals at ${origin}${DRIFT_DIR}; the sample at ${origin}${SAMPLE_PATH}. The sample file states no licence of its own; the site Terms apply.`]
        : ["Not public yet: the totals and the sample are published when the report is released."],
      maintenance: ["Recomputed from the stored history as it grows; the sample is fixed for the same data (sha256 of a fixed seed and the server)."],
    },
    known_gaps: [DRIFT_METHOD[4]!, gaps.frozen_server_set, gaps.prereleases_excluded, gaps.replaced_between_runs, gaps.failed_handshakes],
    licence: { id: null, stated_in: null, note: "The drift sample file carries no licence field today; the site Terms apply." },
    links: released ? { page: `${origin}${DRIFT_DIR}`, sample: `${origin}${SAMPLE_PATH}` } : {},
  };
  return {
    name: "The Agent Forge datasets: datasheet",
    datasheet_version: DATASHEET_VERSION,
    url: `${origin}${DATASHEET_PATH}`,
    structure: "datasheets_for_datasets_gebru_et_al",
    sections: [...SECTIONS],
    basis: "gross_totals_only",
    canary: CANARY,
    families: [arena, censusFamily, toolHistory, drift],
    full_set: { public: false, how: "licensed separately to buyers or licensees, under NDA through the data room", contact: COMMERCIAL_LICENCE_CONTACT },
    citation: { author: "The Agent Forge", title: "The Agent Forge datasets", url: `${origin}${DATASHEET_PATH}`, version_field: "use the census version date or the rules version on each row" },
    as_of: spec.as_of,
    generated_at: spec.generated_at,
  };
}
export type Datasheet = Awaited<ReturnType<typeof datasheetData>>;

const isNum = (v: unknown): v is number => typeof v === "number";

site.get(DATASHEET_JSON_PATH, async (c) => sendJson(c, await datasheetData(c.env), 300));

site.get(DATASHEET_PATH, async (c) => {
  const d = await datasheetData(c.env);
  if (wantsJson(c)) return sendJson(c, d, 300);
  const numbers = (f: Datasheet["families"][number]) => {
    const rows = Object.entries(f.numbers).filter(([key, v]) => isNum(v) && key !== "bytes");
    const text = Object.entries(f.numbers).filter(([key, v]) => typeof v === "string" && !["source", "status", "as_of"].includes(key));
    const split = Object.entries(f.numbers).filter(([, v]) => v !== null && typeof v === "object") as [string, Record<string, number>][];
    return html`<div class="table-wrap"><table class="table"><tbody>
${rows.map(([key, v]) => html`<tr data-k="${f.id}.${key}"><td>${key.replaceAll("_", " ")}</td><td class="num" data-v="${v}">${fmt(v as number)}</td></tr>`)}
${split.map(([key, v]) => html`<tr data-k="${f.id}.${key}"><td>${key.replaceAll("_", " ")}</td><td>${Object.entries(v).map(([c, x], i) => `${i ? "; " : ""}${c || "unclassified"} ${fmt(Number(x))}`)}</td></tr>`)}
${text.map(([key, v]) => html`<tr data-k="${f.id}.${key}"><td>${key.replaceAll("_", " ")}</td><td>${v}</td></tr>`)}
</tbody></table></div>`;
  };
  const body = html`<div class="prose">
<h1 class="page-title">Datasheet</h1>
<p class="lead">A standard description of each public dataset of The Agent Forge, following "Datasheets for Datasets" (Gebru et al.): motivation, composition, collection process, preprocessing, uses, distribution and maintenance, with the known gaps stated.</p>
<p class="small muted">Every number is read live from the same function as its own page; gross totals only. <a href="${DATASHEET_JSON_PATH}">JSON</a> · <a href="${DATASET_CROISSANT_PATH}">Croissant 1.1 (census)</a> · <a href="${CROISSANT_PATH}">Croissant 1.0 (Arena)</a> · <a href="${DATASET_SPEC_PATH}">dataset spec</a></p>
<ul>${d.families.map((f) => html`<li><a href="#${f.id}">${f.name}</a> (${f.status === "published" ? "published" : "not published yet"})</li>`)}</ul>
${d.families.map(
  (f) => html`<h2 id="${f.id}">${f.name}</h2>
${numbers(f)}
${SECTIONS.map((s) => html`<h3 id="${f.id}-${s}">${SECTION_TITLES[s]}</h3><ul>${f.sections[s].map((p) => html`<li>${p}</li>`)}</ul>`)}
<h3 id="${f.id}-gaps">Known gaps</h3>
<ul>${f.known_gaps.map((g) => html`<li>${g}</li>`)}</ul>
<p class="small">${Object.entries(f.links).map(([name, url], i) => html`${i ? " · " : ""}<a href="${new URL(url).pathname}">${name}</a>`)}</p>`,
)}
<h2 id="full-set">The full set</h2>
<p>The public files are a record and a sample. The full set (every row, the tool text, the internal reports) is not public: it is licensed separately to buyers or licensees, under NDA through the data room. Licence terms on this page are the ones each file carries today (<a href="${BENCHMARK_LICENCE_PATH}">licence</a>). Contact: <a href="mailto:${COMMERCIAL_LICENCE_CONTACT}">${COMMERCIAL_LICENCE_CONTACT}</a>.</p>
<h2 id="cite">How to cite</h2>
<p>The Agent Forge. <i>The Agent Forge datasets</i>. ${c.env.PUBLIC_ORIGIN}${DATASHEET_PATH}. Give the census version date (for census, tool-history and drift files) or the rules version on each row (for Arena results).</p>
</div>`;
  return send(c, { title: "Datasheet", description: "Datasheets for The Agent Forge datasets: Arena and Trap Set results, the census, tool-definition history and the drift report.", path: DATASHEET_PATH, jsonAlternate: DATASHEET_JSON_PATH, canary: CANARY, body }, { maxAge: 300 });
});

// --- Croissant 1.1 for the census family ---------------------------------------------------------------------------

/**
 * The JSON-LD context of Croissant 1.1 (Appendix 1 of the spec at docs.mlcommons.org, checked 12 Nov 2026), with `rai`.
 * Two changes so the reference validator (mlcroissant 1.1.1, `mlcroissant validate`) passes with no warning: schema.org
 * as https (as in its own context and /arena/croissant.json; with http it reports the file "doesn't extend
 * https://schema.org/Dataset"), and the 1.0 keys it still expects (path, repeated, replace, samplingRate).
 */
export const CROISSANT_11_CONTEXT = {
  "@language": "en",
  "@vocab": "https://schema.org/",
  sc: "https://schema.org/",
  cr: "http://mlcommons.org/croissant/",
  rai: "http://mlcommons.org/croissant/RAI/",
  dct: "http://purl.org/dc/terms/",
  annotation: "cr:annotation",
  arrayShape: "cr:arrayShape",
  citeAs: "cr:citeAs",
  column: "cr:column",
  conformsTo: "dct:conformsTo",
  containedIn: "cr:containedIn",
  data: { "@id": "cr:data", "@type": "@json" },
  dataType: { "@id": "cr:dataType", "@type": "@vocab" },
  equivalentProperty: "cr:equivalentProperty",
  examples: { "@id": "cr:examples", "@type": "@json" },
  excludes: "cr:excludes",
  extract: "cr:extract",
  field: "cr:field",
  fileProperty: "cr:fileProperty",
  fileObject: "cr:fileObject",
  fileSet: "cr:fileSet",
  format: "cr:format",
  includes: "cr:includes",
  isArray: "cr:isArray",
  isLiveDataset: "cr:isLiveDataset",
  jsonPath: "cr:jsonPath",
  key: "cr:key",
  md5: "cr:md5",
  parentField: "cr:parentField",
  path: "cr:path",
  recordSet: "cr:recordSet",
  references: "cr:references",
  regex: "cr:regex",
  readLines: "cr:readLines",
  repeated: "cr:repeated",
  replace: "cr:replace",
  samplingRate: "cr:samplingRate",
  sdVersion: "cr:sdVersion",
  separator: "cr:separator",
  source: "cr:source",
  subField: "cr:subField",
  transform: "cr:transform",
  unArchive: "cr:unArchive",
  value: "cr:value",
};

const SERIES_TYPES: Record<string, string> = { date_utc: "sc:Date", value: "sc:Float" };
const DRIFT_TYPES: Record<string, string> = { tools_added: "sc:Integer", tools_removed: "sc:Integer", descriptions_changed: "sc:Integer", schemas_changed: "sc:Integer", untested_between: "sc:Integer", major_bump: "sc:Boolean", zero_major: "sc:Boolean", same_version: "sc:Boolean" };
const csvField = (set: string, file: string, name: string, types: Record<string, string>) => ({
  "@type": "cr:Field",
  "@id": `${set}/${name}`,
  name,
  dataType: types[name] ?? "sc:Text",
  source: { fileObject: { "@id": file }, extract: { column: name } },
});

/**
 * Croissant 1.1 with RAI for the census family (series, tool history, drift.csv). Live: no checksums (each file changes
 * daily; manifest.json has every version's sha256). `version` is the census version date as MAJOR.MINOR.PATCH
 * (2026-11-11 is 2026.11.11), the form the validator asks for.
 */
export async function censusCroissant(env: Env) {
  const origin = env.PUBLIC_ORIGIN;
  const sheet = await datasheetData(env);
  const census = sheet.families.find((f) => f.id === "census")!;
  const th = sheet.families.find((f) => f.id === "tool_definition_history")!;
  const [bundle, cf] = await Promise.all([latestBundle(env), censusFigures(env)]);
  const months = bundle ? bundle.hashes.filter((h) => h.path.startsWith("tool-history/")).map((h) => h.path) : [];
  const file = (id: string, path: string, description: string) => ({ "@type": "cr:FileObject", "@id": id, name: path, description, contentUrl: `${origin}${CENSUS_DIR}/${path}`, encodingFormat: path.endsWith(".csv") ? "text/csv" : "application/json" });
  return {
    "@context": CROISSANT_11_CONTEXT,
    "@type": "sc:Dataset",
    conformsTo: [CROISSANT_SPEC, CROISSANT_RAI],
    name: "The Forge census",
    description: "A dated, never-overwritten record of MCP server install tests (nightly top-500 and weekly sweep), scans, and the tool-definition history and drift of a frozen server set. Hashes, counts and change classes only.",
    url: `${origin}${CENSUS_DIR}`,
    license: `${origin}${LICENCE_PATH}`,
    creator: { "@type": "sc:Organization", name: "The Agent Forge", url: origin },
    publisher: { "@type": "sc:Organization", name: "The Agent Forge", url: origin },
    isAccessibleForFree: true,
    isLiveDataset: true,
    ...(cf.first_version ? { datePublished: cf.first_version } : {}),
    ...(cf.status === "published" ? { version: cf.latest_version.split("-").map(Number).join("."), dateModified: cf.latest_version } : {}),
    citeAs: `The Agent Forge. The Forge census. ${origin}${CENSUS_DIR}`,
    keywords: ["MCP", "Model Context Protocol", "AI agents", "tool definitions", "software supply chain", "install tests"],
    inLanguage: "en",
    "rai:dataCollection": census.sections.collection_process.join(" "),
    "rai:dataCollectionType": ["Software Collection"],
    "rai:dataCollectionMissingData": [...census.known_gaps, ...th.known_gaps].join(" "),
    "rai:dataPreprocessingProtocol": [...census.sections.preprocessing, ...th.sections.preprocessing].join(" "),
    "rai:dataUseCases": [...census.sections.uses, ...th.sections.uses].join(" "),
    "rai:dataLimitations": th.known_gaps.join(" "),
    "rai:personalSensitiveInformation": "None. Servers are named by public package ids; no account, person or IP address.",
    "rai:dataReleaseMaintenancePlan": census.sections.maintenance.join(" "),
    "rai:hasSyntheticData": false,
    licenceText: DATASET_LICENCE,
    datasheet: `${origin}${DATASHEET_PATH}`,
    manifest: `${origin}${CENSUS_DIR}/manifest.json`,
    distribution: bundle
      ? [
          file("series-csv", "series.csv", "One row per metric per UTC day."),
          file("schema-json", "schema.json", "Every file's fields, the metrics, the gaps and the failure classes."),
          file("drift-csv", "drift.csv", "One row per changed consecutive pair of a server's tool-definition sets."),
          ...months.map((p) => file(p.replace(/[^a-z0-9]+/gi, "-"), p, "Tool-definition history for one publish month (fields in schema.json).")),
        ]
      : [],
    recordSet: bundle
      ? [
          { "@type": "cr:RecordSet", "@id": "series", name: "series", description: "Daily census metrics.", field: SERIES_HEADER.map((n) => csvField("series", "series-csv", n, SERIES_TYPES)) },
          { "@type": "cr:RecordSet", "@id": "drift", name: "drift", description: "Changed consecutive pairs of tool-definition sets.", field: DRIFT_HEADER.map((n) => csvField("drift", "drift-csv", n, DRIFT_TYPES)) },
        ]
      : [],
  };
}

site.get(DATASET_CROISSANT_PATH, async (c) =>
  new Response(JSON.stringify(await censusCroissant(c.env)), {
    headers: { "Content-Type": `application/ld+json; charset=utf-8`, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" },
  }),
);
