import { CANARY, CANARY_GUID, HELDOUT_VERSION, LONGITUDINAL } from "@forge/arena";
import { SNAPSHOTS, type SnapshotEntry } from "../seed/benchmark";
import { LICENCE_ID, LICENCE_PATH } from "../services/provenance";
import {
  BENCHMARK_JSON_PATH,
  BENCHMARK_PATH,
  TRAP_SET,
  TRAP_SET_NAME,
  TRAP_SET_VERSIONS,
  trapRecord,
  trapSchema,
  trapSetCitation,
  trapSetEntries,
  trapSetTasks,
  VERSIONING,
} from "./benchmark";
import { GAP_METHOD } from "./holdout";

// B3-05 (build plan 29 Oct, Boardy point 5; ADR 0101): frozen Trap Set versions, a diff between them, and the held-out
// contract. /benchmark/v1.json stays the live "latest" file (rebuilt on each request, with live results). Each released
// version also has a snapshot committed in src/seed/benchmark/ and served unchanged at /benchmark/v<version>.json; a
// test fails if a snapshot's bytes change, or if TRAP_SET_VERSIONS names a version with no snapshot.

/** The origin written into snapshots, so their bytes don't depend on where they are served (staging or production). */
export const SNAPSHOT_ORIGIN = "https://theagentforge.io";
export const BENCHMARK_VERSIONS_PATH = "/benchmark/versions.json";
export const BENCHMARK_DIFF_PATH = "/benchmark/diff";
export const BENCHMARK_HELD_OUT_PATH = "/benchmark/held-out";
export const BENCHMARK_HELD_OUT_JSON_PATH = "/benchmark/held-out.json";
export const snapshotPath = (version: string) => `/benchmark/v${version}.json`;

/**
 * The versioned definition of the current Trap Set: everything in /benchmark/v1.json that is fixed by the version (traps,
 * rules, task versions, the per-trap schema, versioning rules, changelog, citation, canary), and none of the live parts
 * (per-model results, the held-out gap, the referee audit), which keep growing after a version is released. A snapshot
 * file is `{ snapshot: <how it was made>, ...trapSetDefinition() }` at its freeze, written by scripts/freeze-trap-set.mjs.
 */
export function trapSetDefinition(origin = SNAPSHOT_ORIGIN) {
  const traps = trapSetEntries().map(trapRecord);
  return {
    name: TRAP_SET_NAME,
    version: TRAP_SET.version,
    date: TRAP_SET.date,
    rules_version: TRAP_SET.rules,
    task_versions: TRAP_SET.task_versions,
    url: `${origin}${BENCHMARK_PATH}`,
    canary: CANARY,
    canary_guid: CANARY_GUID,
    counts: {
      traps: traps.length,
      families: new Set(traps.map((t) => t.trap_kind.family)).size,
      jobs: new Set(traps.map((t) => t.job.id)).size,
      tasks: trapSetTasks().length,
    },
    traps,
    trap_schema: trapSchema(origin),
    versioning: VERSIONING,
    changelog: TRAP_SET_VERSIONS.map(({ version, date, change }) => ({ version, date, change })),
    citation: trapSetCitation(origin),
  };
}
export type TrapSetDefinition = ReturnType<typeof trapSetDefinition>;

/** How a snapshot was made (its `snapshot` block). */
export interface SnapshotMeta {
  trap_set_version: string;
  /** "frozen": written from the code at release; byte-exact from then on. "reconstructed": rebuilt later from an older commit. */
  kind: "frozen" | "reconstructed";
  made_on: string;
  from_commit: string;
  original_bytes: boolean;
  counts_as_of: string;
  results: { included: boolean; reason: string; live: string };
  statement: string;
}
export type Snapshot = TrapSetDefinition & { snapshot: SnapshotMeta };

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export const snapshotOf = (version: string): SnapshotEntry | undefined => SNAPSHOTS.find((s) => s.version === version);
export const parseSnapshot = (s: SnapshotEntry) => JSON.parse(s.text) as Snapshot;

/** /benchmark/versions.json: every released version with its date, rules, counts and the sha256 of its snapshot. */
export function versionsData(origin: string) {
  return {
    name: TRAP_SET_NAME,
    canary: CANARY,
    canary_guid: CANARY_GUID,
    current: TRAP_SET.version,
    latest: { url: `${origin}${BENCHMARK_JSON_PATH}`, live: true, rebuilt_on_each_request: true, version_field: "version", results: "live_at_request_time" },
    hash: "sha256_of_the_snapshot_file_bytes_as_served",
    diff: `${origin}${BENCHMARK_DIFF_PATH}?from={version}&to={version}`,
    held_out_contract: `${origin}${BENCHMARK_HELD_OUT_PATH}`,
    licence: { id: LICENCE_ID, url: `${origin}${LICENCE_PATH}` },
    versions: TRAP_SET_VERSIONS.map((v) => {
      const s = snapshotOf(v.version);
      const m = s ? parseSnapshot(s) : null;
      return {
        version: v.version,
        date: v.date,
        rules: v.rules,
        task_versions: v.task_versions,
        current: v.version === TRAP_SET.version,
        counts: m?.counts ?? null,
        snapshot: s && m
          ? {
              url: `${origin}${snapshotPath(v.version)}`,
              sha256: s.sha256,
              bytes: new TextEncoder().encode(s.text).length,
              kind: m.snapshot.kind,
              made_on: m.snapshot.made_on,
              from_commit: m.snapshot.from_commit,
              original_bytes: m.snapshot.original_bytes,
              results_included: m.snapshot.results.included,
            }
          : null,
      };
    }),
  };
}

// --- Diff --------------------------------------------------------------------------------------------------------

/** Leaf paths where two JSON values differ (arrays compared whole), e.g. "canary_guid" or "scoring_rule.rules_version". */
export function changedPaths(a: unknown, b: unknown, prefix = ""): string[] {
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || "."];
}

type TrapLike = { id: string } & Record<string, unknown>;

/**
 * Trap records added, changed and removed between two versions, by id. `trap_set_version` is left out of the
 * comparison, because every record carries its own version and it always differs.
 */
export function diffTraps(from: readonly TrapLike[], to: readonly TrapLike[]) {
  const strip = (t: TrapLike) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "trap_set_version"));
  const a = new Map(from.map((t) => [t.id, t]));
  const b = new Map(to.map((t) => [t.id, t]));
  const changed = [...b.values()]
    .filter((t) => a.has(t.id))
    .map((t) => ({ id: t.id, fields: changedPaths(strip(a.get(t.id)!), strip(t)) }))
    .filter((x) => x.fields.length);
  return {
    added: [...b.keys()].filter((id) => !a.has(id)),
    changed,
    removed: [...a.keys()].filter((id) => !b.has(id)),
    unchanged: [...b.keys()].filter((id) => a.has(id) && !changed.some((c) => c.id === id)).length,
  };
}

export type DiffResult = { ok: true; body: ReturnType<typeof diffBody> } | { ok: false; error: string; versions: string[] };

function diffBody(origin: string, from: Snapshot, to: Snapshot) {
  const d = diffTraps(from.traps as unknown as TrapLike[], to.traps as unknown as TrapLike[]);
  const side = (s: Snapshot) => ({ version: s.version, snapshot: `${origin}${snapshotPath(s.version)}`, kind: s.snapshot.kind, original_bytes: s.snapshot.original_bytes, rules_version: s.rules_version, traps: s.traps.length });
  return {
    name: TRAP_SET_NAME,
    canary: CANARY,
    from: side(from),
    to: side(to),
    compared: "trap_records_in_the_two_snapshots_by_id",
    ignored_fields: ["trap_set_version"],
    rules_changed: from.rules_version !== to.rules_version,
    task_versions_added: to.task_versions.filter((v) => !from.task_versions.includes(v)),
    task_versions_removed: from.task_versions.filter((v) => !to.task_versions.includes(v)),
    traps: d,
    counts: { added: d.added.length, changed: d.changed.length, removed: d.removed.length, unchanged: d.unchanged },
  };
}

/** /benchmark/diff?from=&to=: both must be versions with a snapshot. */
export function diffVersions(origin: string, fromV: string | undefined, toV: string | undefined): DiffResult {
  const versions = SNAPSHOTS.map((s) => s.version);
  const a = fromV ? snapshotOf(fromV) : undefined;
  const b = toV ? snapshotOf(toV) : undefined;
  if (!a || !b) return { ok: false, error: "unknown_version", versions };
  return { ok: true, body: diffBody(origin, parseSnapshot(a), parseSnapshot(b)) };
}

// --- The held-out contract ---------------------------------------------------------------------------------------

/**
 * What is kept back from the public Trap Set, what is published about it, and the rules around it. Categories and
 * rules only: no private trap id, job id, family name, seed or seed count appears here (a test checks).
 */
export function heldOutContract(origin: string) {
  return {
    name: `${TRAP_SET_NAME}: held-out contract`,
    canary: CANARY,
    canary_guid: CANARY_GUID,
    trap_set_version: TRAP_SET.version,
    url: `${origin}${BENCHMARK_HELD_OUT_PATH}`,
    kept_back: [
      { item: "held_out_seeds", what: "private seeds for every public job and tier, in a frozen panel", panel_version: HELDOUT_VERSION },
      { item: "longitudinal_panel", what: "held-out job versions replayed for each new model version", panel_version: LONGITUDINAL.version, max_bouts_per_model_version: LONGITUDINAL.maxBoutsPerModel },
      { item: "private_trap_families", what: "job families and trap kinds that have never been public; their names, jobs and trap ids are not published" },
      { item: "unpublished_job_versions", what: "job versions written but not yet released in a task version" },
      { item: "trap_generator_and_job_source", what: "the seeded generators that build each job's world, and the private jobs' code" },
    ],
    published_about_them: {
      runs_published: false,
      seeds_published: false,
      only: ["aggregates", "public_minus_held_out_pass_rate_gap"],
      gap_method: GAP_METHOD,
      where: [`${origin}${BENCHMARK_PATH}#data-protection`, `${origin}/arena/history#gap`, `${origin}${BENCHMARK_JSON_PATH}`],
    },
    breaking_changes: { major: VERSIONING.major, held_out_protocol_change_is_major: (VERSIONING.major as readonly string[]).includes("change_to_the_held_out_or_canary_protocol") },
    how_long_private: {
      held_out_panel: "while_in_use_no_end_date",
      replaced_by: "a_new_panel_version_with_new_seeds",
      retired_panel_published: false,
      publishing_a_retired_panel_requires: ["a_recorded_decision_adr", "founder_written_approval", "a_major_trap_set_version"],
      private_families: "private_unless_released_in_a_public_task_version",
      releasing_a_private_family_is: "a_minor_trap_set_version",
      release_publishes: ["the_family_public_job_versions", "their_trap_records"],
      release_keeps_private: ["held_out_seeds", "trap_generator_and_job_source"],
      retired_panels_so_far: 0,
    },
    canary_protocol: { string: CANARY, guid: CANARY_GUID, never_changes: true, on: ["every_public_data_file", "every_trap_record_as_canary_guid", "every_snapshot", "this_contract"] },
    licensee_under_nda: [
      "held_out_panels_and_seeds",
      "private_trap_families_and_their_trap_records",
      "trap_generator_and_job_source",
      "referee_code",
      "full_pseudonymised_run_export_with_sha256_manifest",
    ],
    licensee_contact: "partners@theagentforge.io",
    public_licence: { id: LICENCE_ID, url: `${origin}${LICENCE_PATH}`, training_allowed: false },
  };
}

/**
 * The release check: versions with no committed snapshot. Empty for TRAP_SET_VERSIONS, or CI fails (a version bump
 * must commit its snapshot with scripts/freeze-trap-set.mjs; docs/runbooks/trap-set-release.md).
 */
export const missingSnapshots = (versions: readonly { version: string }[] = TRAP_SET_VERSIONS) => versions.map((v) => v.version).filter((v) => !snapshotOf(v));
