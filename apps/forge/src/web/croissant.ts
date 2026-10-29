import { citation, PUBLIC_NAME, RULES_VERSION } from "@forge/arena";
import { COMMERCIAL_LICENCE, DATASET_LICENCE, LICENCE_PATH, PRIVACY_HISTORY, TERMS_HISTORY } from "../services/provenance";
import { site } from "./pages";

// Machine-readable dataset card for /arena/dataset.json (ADR 0053, D10): MLCommons Croissant 1.0 with the Responsible
// AI (RAI) 1.0 vocabulary. Static facts only: counts live in the dataset itself, so this file never states a number
// that could go stale. The human datasheet (docs/data/datasheet.md) has the same headings.

export const CROISSANT_PATH = "/arena/croissant.json";
/** The day /arena/dataset.json first went public (the Arena pages and dataset shipped on 15 Oct 2026). */
export const DATASET_FIRST_PUBLISHED = "2026-10-15";

/**
 * The Croissant 1.0 JSON-LD context, as given in the specification (mlcommons.org/croissant/1.0), `rai` included.
 * Every key of the standard context must be here: the reference validator (mlcroissant) warns on any missing one.
 */
export const CROISSANT_CONTEXT = {
  "@language": "en",
  "@vocab": "https://schema.org/",
  citeAs: "cr:citeAs",
  column: "cr:column",
  conformsTo: "dct:conformsTo",
  cr: "http://mlcommons.org/croissant/",
  rai: "http://mlcommons.org/croissant/RAI/",
  data: { "@id": "cr:data", "@type": "@json" },
  dataType: { "@id": "cr:dataType", "@type": "@vocab" },
  dct: "http://purl.org/dc/terms/",
  equivalentProperty: "cr:equivalentProperty",
  examples: { "@id": "cr:examples", "@type": "@json" },
  extract: "cr:extract",
  field: "cr:field",
  fileProperty: "cr:fileProperty",
  fileObject: "cr:fileObject",
  fileSet: "cr:fileSet",
  format: "cr:format",
  includes: "cr:includes",
  isLiveDataset: "cr:isLiveDataset",
  jsonPath: "cr:jsonPath",
  key: "cr:key",
  md5: "cr:md5",
  parentField: "cr:parentField",
  path: "cr:path",
  recordSet: "cr:recordSet",
  references: "cr:references",
  regex: "cr:regex",
  repeated: "cr:repeated",
  replace: "cr:replace",
  samplingRate: "cr:samplingRate",
  sc: "https://schema.org/",
  separator: "cr:separator",
  source: "cr:source",
  subField: "cr:subField",
  transform: "cr:transform",
};

type Kind = "sc:Text" | "sc:Integer" | "sc:Float" | "sc:Boolean" | "sc:URL" | "sc:Date";

/** One column of the `runs` record set, read from /arena/dataset.json by JSONPath. */
const field = (name: string, dataType: Kind, description: string, path = name, repeated = false) => ({
  "@type": "cr:Field",
  "@id": `runs/${name}`,
  name,
  description,
  dataType,
  ...(repeated ? { repeated: true } : {}),
  source: { fileObject: { "@id": "dataset-json" }, extract: { jsonPath: `$.runs[*].${path}` } },
});

export function croissant(origin: string) {
  const cite = citation(origin);
  return {
    "@context": CROISSANT_CONTEXT,
    "@type": "sc:Dataset",
    conformsTo: ["http://mlcommons.org/croissant/1.0", "http://mlcommons.org/croissant/RAI/1.0"],
    name: `${PUBLIC_NAME} dataset`,
    description:
      "Every published, refereed Arena bout: an AI model given an everyday business job (refunds, payments, bookings, stock, records) in an invented sandbox with planted traps, scored by an end-state referee. One row per attempt with model, job, seed, attempt, pass, score, cost, tokens, rules and task versions, the public ids of traps sprung, a link to the signed full log, and provenance.",
    url: `${origin}/arena`,
    license: `${origin}${LICENCE_PATH}`,
    creator: { "@type": "sc:Organization", name: "The Agent Forge", url: origin },
    publisher: { "@type": "sc:Organization", name: "The Agent Forge", url: origin },
    isAccessibleForFree: true,
    isLiveDataset: true,
    // The first public Arena bouts and /arena/dataset.json went live on 15 Oct 2026 (recommended by Croissant 1.0).
    datePublished: DATASET_FIRST_PUBLISHED,
    version: RULES_VERSION.replace(/^rules /, ""),
    citeAs: cite.bibtex,
    keywords: ["AI agents", "evaluation", "benchmark", "tool use", "prompt injection", "agent safety", "business tasks"],
    inLanguage: "en",
    // Responsible AI (Croissant RAI 1.0). Facts from the methodology and rules pages; see docs/data/datasheet.md.
    "rai:dataCollection":
      "Each row is one bout The Forge ran itself: the model is called through its provider's API (OpenRouter, with a pinned provider and no fallbacks for paid models; OpenRouter's free \":free\" variants, practice only, with no provider pinned, no fallback to another provider or a paid model, and providers that may train on prompts, so they only ever play public jobs on public seeds; or Cloudflare Workers AI), given the job brief and sandbox tools, and refereed from the sandbox's end state and call log. Logs are signed when a bout finishes.",
    "rai:dataCollectionType": ["Experiments", "Software Collection"],
    "rai:dataCollectionTimeframe": "Ongoing since the first Arena bouts in October 2026 (live dataset). Each row's finishedAt and provenance.run_date give its date.",
    "rai:dataCollectionMissingData":
      "Voided bouts (a provider failed mid-bout) are re-run and not published. Bouts of a model or event held for review are left out until published, and Lab experiment arms that change the prompt are left out.",
    "rai:dataPreprocessingProtocol":
      "None beyond the referee: each attempt's verdict, score and trap results come from the referee at the end of the bout. When the rules change, stored runs can be re-scored by replaying their logs: the verdict and score are updated with a note, the signed log is never changed, and the change is listed in the methodology changelog.",
    "rai:dataAnnotationProtocol": "Labels are machine-made by the deterministic referee (rules version per row). No human annotation in this file.",
    "rai:machineAnnotationTools": [`The Forge Arena referee (${RULES_VERSION})`],
    "rai:dataUseCases": "Evaluation, research and reporting on how AI models behave on business jobs with traps. Not for training or fine-tuning AI models.",
    "rai:dataLimitations":
      "A small number of job families and seeded variants; invented sandboxes, not real systems; 3 attempts per variant, so per-model rates carry wide intervals. Practice rows (kind practice) are calibration runs and never ranked.",
    "rai:dataBiases":
      "Jobs and traps were written by The Forge from public fraud and failure patterns (sources on the methodology page), in English, for business settings. Model choice follows the published lineup, not a random sample of models.",
    "rai:personalSensitiveInformation":
      "None. The sandboxes are invented: no real companies, people or money. Rows hold no account, IP address or person.",
    "rai:dataSocialImpact": "Shows where AI agents fall for fraud and policy traps, so people can choose and configure agents more safely.",
    "rai:dataReleaseMaintenancePlan":
      "Live: new bouts are added as they finish. Rules and task versions are on every row and in the methodology changelog. Corrections are published, never silent; see the results policy at /results-policy.",
    "rai:hasSyntheticData": true,
    // Legal context in force over the dataset's life (Terms and Privacy by date), carried on every row as provenance.
    termsHistory: TERMS_HISTORY.map((h) => ({ version: h.version, from: new Date(h.from).toISOString().slice(0, 10) })),
    privacyHistory: PRIVACY_HISTORY.map((h) => ({ version: h.version, from: new Date(h.from).toISOString().slice(0, 10) })),
    licenceText: DATASET_LICENCE,
    // B3-02 (ADR 0104): the licence notes. The evaluation-only text above is unchanged; this is the route to more.
    commercialLicence: COMMERCIAL_LICENCE,
    distribution: [
      {
        "@type": "cr:FileObject",
        "@id": "dataset-json",
        name: "dataset.json",
        description: "Every published refereed run, regenerated on request (cached 5 minutes). It changes as bouts finish, so it has no fixed checksum.",
        contentUrl: `${origin}/arena/dataset.json`,
        encodingFormat: "application/json",
        // No checksum: the file is live (isLiveDataset), and Croissant 1.0 needs md5 or sha256 only for files that
        // aren't. The reference loader (mlcroissant) skips the hash check for a live file without one, but treats any
        // value given (even the "issues/80" placeholder) as a real hash and fails to load the records.
      },
    ],
    recordSet: [
      {
        "@type": "cr:RecordSet",
        "@id": "runs",
        name: "runs",
        description: "One refereed attempt per record.",
        key: { "@id": "runs/id" },
        field: [
          field("id", "sc:Text", "Run id; the signed log is at /arena/run/<id>.json."),
          field("event", "sc:Text", "Event slug."),
          field("kind", "sc:Text", "Event kind: card or guest (ranked) or practice (never ranked)."),
          field("model", "sc:Text", "The Forge's lineup id of the model."),
          field("task", "sc:Text", "Job id; Hard-tier job ids contain -hard (for example refund-hard, refund-hard3, refund-hard3-2)."),
          field("tier", "sc:Text", "normal or hard."),
          field("seed", "sc:Integer", "Seed that built the job's sandbox; the same seed gives the same world."),
          field("attempt", "sc:Integer", "Attempt number on that seed (1 to 3)."),
          field("passed", "sc:Boolean", "The referee's pass or fail from the sandbox's end state."),
          field("score", "sc:Float", "Official score for the attempt, 0 to 1 (weights on /arena/rules)."),
          field("cost", "sc:Float", "Model spend for the attempt in US dollars."),
          field("costEstimated", "sc:Boolean", "True when cost was estimated from list prices rather than reported by the gateway."),
          field("tokens", "sc:Integer", "Tokens used."),
          field("provider", "sc:Text", "Serving provider recorded for the run."),
          field("finishedAt", "sc:Integer", "Finish time in milliseconds since 1970 (UTC)."),
          field("rules_version", "sc:Text", "Referee and scoring rules group of the run: the version that scored it (stamped on the result from rules 0.6; older runs by finish time), or \"<version> re-scored\" for a run played under older rules and re-scored from its signed log, never pooled with runs played under that version (scored_under and played_under give both)."),
          field("task_version", "sc:Text", "Task version of the job at the finish time."),
          // Repeated field: the JSONPath selects the list itself (one value per run). "traps_triggered[*]" would select
          // one value per trap, so the column lengths differ and mlcroissant can't build the records.
          field("traps_triggered", "sc:Text", "Public trap ids (FA-...) the attempt fell for.", "traps_triggered", true),
          field("log", "sc:URL", "Path of the run's signed full log."),
          field("provenance_source", "sc:Text", "Where the record came from (house_bout for every row of this file).", "provenance.source"),
          field("provenance_model_exact", "sc:Text", "Exact model id sent to the gateway.", "provenance.model.exact"),
          field("provenance_model_maker", "sc:Text", "Lab that makes the model, as named in the lineup.", "provenance.model.maker"),
          field("provenance_served_by", "sc:Text", "Serving provider recorded for the run, or the provider the model is pinned to when none was recorded.", "provenance.model.served_by"),
          field("provenance_run_date", "sc:Date", "UTC date the run finished.", "provenance.run_date"),
          field("provenance_terms_version", "sc:Text", "Terms of Service version in force on the run date.", "provenance.terms_version"),
          field("provenance_privacy_version", "sc:Text", "Privacy Policy version in force on the run date.", "provenance.privacy_version"),
          field("provenance_licence", "sc:Text", "Licence id: evaluation-only.", "provenance.licence"),
        ],
      },
    ],
  };
}

site.get(CROISSANT_PATH, (c) =>
  new Response(JSON.stringify(croissant(c.env.PUBLIC_ORIGIN)), {
    headers: { "Content-Type": "application/ld+json; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
  }),
);
