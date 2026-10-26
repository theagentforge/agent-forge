import { modelById } from "../arena/lineup";

// Provenance and licence for every published record (ADR 0053, build item D10). Derived when a record is read, from
// what each row already stores (model id, serving provider, finish time), so no migration and no backfill: old rows
// get the same tags as new ones. The Terms and Privacy history below must match web/legal.ts (a test checks).

/** Machine id of the licence on every published data file. */
export const LICENCE_ID = "evaluation-only";
/** Where the licence is written out for people (the Arena methodology page). */
export const LICENCE_PATH = "/arena/methodology#licence";
/** The licence text every Arena download and data file carries (Dinike approved "evaluation only", 26 Oct 2026). */
export const DATASET_LICENCE =
  "Evaluation-only licence: free to use for evaluation, research and reporting, with attribution and a link to theagentforge.io/arena. Not for training or fine-tuning AI models. Model outputs in the run logs remain subject to their providers' terms.";

/** Terms of Service versions by the moment they came into force (UTC). Nothing was in force before 15 Oct 2026. */
export const TERMS_HISTORY = [
  { version: "1.0", from: Date.UTC(2026, 9, 15) },
  { version: "1.1", from: Date.UTC(2026, 10, 7) },
] as const;
/** Privacy Policy versions by the moment they came into force (UTC). */
export const PRIVACY_HISTORY = [
  { version: "1.0", from: Date.UTC(2026, 9, 15) },
  { version: "1.1", from: Date.UTC(2026, 9, 19) },
  { version: "1.2", from: Date.UTC(2026, 10, 7) },
] as const;

/** The version in force at `at` (ms), or null before the first one. */
export function versionAt(history: readonly { version: string; from: number }[], at: number): string | null {
  let v: string | null = null;
  for (const h of history) if (at >= h.from) v = h.version;
  return v;
}

/**
 * Where a record came from:
 * - `house_bout`: an Arena bout The Forge ran itself, calling the model through its provider's API;
 * - `gauntlet`: a Gauntlet run by an outside agent (no account; the model isn't recorded);
 * - `field_report`: a field report filed by a signed-in owner's agent;
 * - `scan`: a skill scan result.
 */
export type ProvenanceSource = "house_bout" | "gauntlet" | "field_report" | "scan";

export interface ModelProvenance {
  /** The Forge's lineup id, as in the record's `model` field. */
  id: string;
  /** The exact model id sent to the gateway (e.g. "openai/gpt-5.6-luna" or "@cf/meta/llama-3.3-70b-instruct-fp8-fast"). */
  exact: string | null;
  /** The lab that makes the model, as named in the lineup (not an affiliation). */
  maker: string | null;
  /** The API gateway the bout went through. */
  gateway: "openrouter" | "workers-ai" | null;
  /** The serving provider recorded for the run (pinned per model), or the lineup's pinned provider if none was recorded. */
  served_by: string | null;
}

export interface Provenance {
  source: ProvenanceSource;
  /** Only for house bouts; null where no model is recorded (Gauntlet, field reports, scans). */
  model: ModelProvenance | null;
  /** UTC date the run finished, the report was filed or the scan last ran (YYYY-MM-DD). */
  run_date: string;
  /** Terms of Service and Privacy Policy versions in force on that date (null before 15 Oct 2026). */
  terms_version: string | null;
  privacy_version: string | null;
  licence: typeof LICENCE_ID;
}

/** The provider name the Workers AI adapter records on every run it serves. */
export const WORKERS_AI_PROVIDER = "cloudflare-workers-ai";

export function modelProvenance(id: string, servedBy: string | null): ModelProvenance {
  const m = modelById(id);
  const route = m?.route;
  // Workers AI replies are recorded as "cloudflare-workers-ai" (arena/adapters.ts); the fallback uses the same name so a
  // row with no recorded provider can't read differently from one that has it.
  const pinned = route?.kind === "openrouter" ? route.provider : route?.kind === "workers-ai" ? WORKERS_AI_PROVIDER : null;
  return { id, exact: route?.model ?? null, maker: m?.lab ?? null, gateway: route?.kind ?? null, served_by: servedBy ?? pinned };
}

/** The provenance block for one record. `model` only for house bouts. */
export function provenance(source: ProvenanceSource, at: number, model?: { id: string; servedBy: string | null }): Provenance {
  return {
    source,
    model: model ? modelProvenance(model.id, model.servedBy) : null,
    run_date: new Date(at).toISOString().slice(0, 10),
    terms_version: versionAt(TERMS_HISTORY, at),
    privacy_version: versionAt(PRIVACY_HISTORY, at),
    licence: LICENCE_ID,
  };
}

/** A house bout (an Arena run). */
export const runProvenance = (r: { model: string; provider: string | null; finishedAt: number }) => provenance("house_bout", r.finishedAt, { id: r.model, servedBy: r.provider });

/** The licence block at the top of a data file. */
export const licenceInfo = (origin: string) => ({ licence: DATASET_LICENCE, licence_id: LICENCE_ID, licence_url: `${origin}${LICENCE_PATH}` });

/**
 * /arena/dataset.json with provenance: the licence id and link at the top and a `provenance` block on every run.
 * Wraps the payload so the dataset's own fields stay as they are.
 */
export function datasetWithProvenance<T extends { runs: { model: string; provider: string | null; finishedAt: number }[] }>(d: T, origin: string) {
  return {
    ...d,
    ...licenceInfo(origin),
    runs: d.runs.map((r) => ({ ...r, provenance: runProvenance(r) })),
    terms_history: TERMS_HISTORY.map((h) => ({ version: h.version, from: new Date(h.from).toISOString() })),
    privacy_history: PRIVACY_HISTORY.map((h) => ({ version: h.version, from: new Date(h.from).toISOString() })),
  };
}
