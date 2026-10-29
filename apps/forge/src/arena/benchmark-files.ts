import { PRIVATE_TASK_IDS, RULES_0_6_TASKS, RULES_HISTORY, TASK_VERSIONS, taskById, type TaskVersion } from "@forge/arena";
import { LICENCE_ID } from "../services/provenance";
import { BENCHMARK_JSON_PATH, BENCHMARK_PATH, BENCHMARK_SCHEMA_PATH, TRAP_SET, TRAP_SET_NAME, TRAP_SET_VERSIONS, trapSchema, trapSetEntries, VERSIONING } from "./benchmark";

// B2-07 (build plan 28 Oct, Boardy item 2; ADR 0087): the Trap Set's machine-readable completion. The traps array on
// its own (/benchmark/v1/traps.json), a JSON Schema for the whole /benchmark/v1.json file, a changelog that lists, per
// version, the trap ids added, changed or retired (page and JSON), and a standalone licence page. Everything is built
// from the live catalog and the version histories; private families (FA-*-101+), private tasks and held-out seeds never
// appear, because only trapSetEntries (the public catalog) and public task ids are read.

export { BENCHMARK_TRAPS_PATH } from "./benchmark";
export const BENCHMARK_FILE_SCHEMA_PATH = "/benchmark/v1/schema/benchmark.json";
export const BENCHMARK_CHANGELOG_PATH = "/benchmark/changelog";
export const BENCHMARK_CHANGELOG_JSON_PATH = "/benchmark/changelog.json";
export const BENCHMARK_LICENCE_PATH = "/benchmark/licence";

// --- Changelog -----------------------------------------------------------------------------------------------------

/**
 * What each rules version changed in the referee, as data: the public jobs whose referee it changed, optionally only
 * for some trap kinds. Taken from each version's changelog line (packages/arena versions.ts) and, for rules 0.5, the
 * grader-hacking report (docs/reports/grader-hacking-2026-10.md: 11 of the 18 jobs). A test fails when a rules version
 * has no entry here, so a new one can't ship without saying what it changed.
 */
export const RULES_REFEREE_CHANGES: Record<string, { jobs: readonly string[] | "all"; trap_kinds: readonly string[] | "all" } | null> = {
  "rules 0.1": null,
  "rules 0.2": null,
  "rules 0.3": null,
  // Permission overreach became refereed: the three FA-PRM traps on the Hard v3.1 jobs.
  "rules 0.4": { jobs: "all", trap_kinds: ["PRM"] },
  "rules 0.5": {
    jobs: ["refund", "scam-invoice", "spreadsheet", "impossible", "scam-invoice-hard", "spreadsheet-hard", "impossible-hard", "scam-invoice-hard3", "spreadsheet-hard3", "impossible-hard3", "refund-hard3"],
    trap_kinds: "all",
  },
  // The lie detectors (false-claim traps) on the jobs the negation fix touched.
  "rules 0.6": { jobs: RULES_0_6_TASKS, trap_kinds: ["CLM"] },
};

const isPublicTask = (id: string) => !PRIVATE_TASK_IDS.includes(id) && !!taskById(id);
const trapIds = (f: (e: ReturnType<typeof trapSetEntries>[number]) => boolean) => trapSetEntries().filter(f).map((e) => e.id);
const tasksOf = (e: ReturnType<typeof trapSetEntries>[number]) => e.traps.map((k) => k.split("/")[0]!);

export interface ChangelogEntry {
  kind: "trap_set" | "task_version" | "rules";
  version: string;
  date: string;
  change: string;
  trap_ids: { added: string[]; changed: string[]; retired: string[] };
  /** task_version: the public job ids it holds; new_jobs: those first published in this version. */
  jobs?: string[];
  new_jobs?: string[];
  /** rules: the public jobs and trap kinds whose referee this version changed (null: none). */
  referee_changes?: { jobs: string[] | "all"; trap_kinds: string[] | "all" } | null;
}

/** Every Trap Set, task and rules version, oldest first within each kind, with the trap ids each added, changed or retired. */
export function changelogEntries(): ChangelogEntry[] {
  const trapSet: ChangelogEntry[] = TRAP_SET_VERSIONS.map((v, i) => {
    const has = (tv: readonly TaskVersion[]) => trapIds((e) => tv.includes(e.since));
    const prev = i ? has(TRAP_SET_VERSIONS[i - 1]!.task_versions) : [];
    const now = has(v.task_versions);
    return { kind: "trap_set", version: v.version, date: v.date, change: v.change, trap_ids: { added: now.filter((x) => !prev.includes(x)), changed: [], retired: prev.filter((x) => !now.includes(x)) } };
  });
  const seen = new Set<string>();
  const tasks: ChangelogEntry[] = TASK_VERSIONS.map((v) => {
    const jobs = v.tasks.filter(isPublicTask);
    const fresh = jobs.filter((j) => !seen.has(j));
    for (const j of jobs) seen.add(j);
    return {
      kind: "task_version",
      version: v.version,
      date: v.date,
      change: v.change,
      jobs,
      new_jobs: fresh,
      // Added: traps first published in this version. Changed: older traps that this version's new jobs also carry.
      trap_ids: { added: trapIds((e) => e.since === v.version), changed: trapIds((e) => e.since !== v.version && tasksOf(e).some((t) => fresh.includes(t))), retired: [] },
    };
  });
  const rules: ChangelogEntry[] = RULES_HISTORY.map((r) => {
    const c = RULES_REFEREE_CHANGES[r.version] ?? null;
    const jobs = c ? (c.jobs === "all" ? ("all" as const) : c.jobs.filter(isPublicTask)) : null;
    const changed = c
      ? trapIds((e) => (c.trap_kinds === "all" || c.trap_kinds.includes(e.family)) && (jobs === "all" || tasksOf(e).some((t) => jobs!.includes(t))))
      : [];
    return { kind: "rules", version: r.version, date: r.date, change: r.change, referee_changes: c ? { jobs: jobs!, trap_kinds: c.trap_kinds === "all" ? "all" : [...c.trap_kinds] } : null, trap_ids: { added: [], changed, retired: [] } };
  });
  return [...trapSet, ...tasks, ...rules];
}

export function changelogData(origin: string) {
  return {
    name: TRAP_SET_NAME,
    current: { trap_set: TRAP_SET.version, rules: TRAP_SET.rules, task_versions: TRAP_SET.task_versions },
    url: `${origin}${BENCHMARK_CHANGELOG_PATH}`,
    data: `${origin}${BENCHMARK_JSON_PATH}`,
    licence: { id: LICENCE_ID, url: `${origin}${BENCHMARK_LICENCE_PATH}` },
    meaning: {
      trap_set: { added: "traps in this Trap Set version that the previous one didn't hold", changed: "none: a changed trigger or scoring rule is a major version (see versioning)", retired: "traps the previous version held that this one doesn't" },
      task_version: { added: "traps first published in this task version (the trap's since)", changed: "older traps placed in this version's newly published jobs: the trap's definition did not change, it appears in more jobs", retired: "none: trap ids are never reused or removed" },
      rules: { added: "none: traps are added by task versions", changed: "could have changed: public traps on a job (and of a trap kind) whose referee this rules version changed or began, from referee_changes. Their scoring could have moved; it does not mean every one did", retired: "none" },
    },
    versioning: VERSIONING,
    entries: changelogEntries(),
    public_traps_only: true,
  };
}

// --- The JSON Schema for the whole /benchmark/v1.json file (draft 2020-12) ----------------------------------------

/** A JSON Schema for the entire benchmark file. The trap record schema is embedded under $defs.trap. */
export function benchmarkFileSchema(origin: string) {
  const { $schema: _s, $id: _i, title: _t, ...trap } = trapSchema(origin);
  const str = { type: "string", minLength: 1 } as const;
  const int0 = { type: "integer", minimum: 0 } as const;
  const day = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
  const strs = { type: "array", items: { type: "string" } } as const;
  const prob = { type: "number", minimum: 0, maximum: 1 } as const;
  const nullable = (s: object) => ({ oneOf: [{ type: "null" }, s] });
  const interval = (min: number) => nullable({ type: "array", minItems: 2, maxItems: 2, items: { type: "number", minimum: min, maximum: 1 } });
  const obj = (required: string[], properties: Record<string, unknown>, extra = false) => ({ type: "object", additionalProperties: extra, required, properties });
  const side = obj(["attempts", "passes", "pass_rate", "ci_95"], { attempts: int0, passes: int0, pass_rate: nullable(prob), ci_95: interval(0) });
  const gapCore = {
    model: str,
    name: str,
    public: side,
    held_out: side,
    gap: nullable({ type: "number", minimum: -1, maximum: 1 }),
    gap_ci_95: interval(-1),
    status: { enum: ["measured", "not_enough_bouts"] },
    public_versions: int0,
    public_versions_published_before: int0,
    public_arm: { enum: ["previously_published", "fresh", "mixed"] },
  };
  const gapReq = Object.keys(gapCore);
  const rate = obj(["k", "n", "rate", "ci_95", "early"], { k: int0, n: int0, rate: nullable(prob), ci_95: interval(0), early: { type: "boolean" } });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${origin}${BENCHMARK_FILE_SCHEMA_PATH}`,
    title: `${TRAP_SET_NAME} ${TRAP_SET.version}: the whole ${BENCHMARK_JSON_PATH} file`,
    $comment: `One trap record is $defs.trap, the same schema as ${BENCHMARK_SCHEMA_PATH}.`,
    $defs: { trap },
    type: "object",
    additionalProperties: false,
    required: ["name", "version", "date", "url", "schema", "canary", "canary_guid", "rules_version", "task_versions", "counts", "traps", "data_protection", "referee_validation", "results", "limits", "versioning", "changelog", "citation"],
    properties: {
      name: { const: TRAP_SET_NAME },
      version: { type: "string", pattern: "^\\d+\\.\\d+(\\.\\d+)?$" },
      date: day,
      url: { type: "string", pattern: `${BENCHMARK_PATH.replace(/\//g, "\\/")}$` },
      schema: { type: "string", pattern: "^https?://" },
      canary: str,
      canary_guid: str,
      rules_version: { type: "string", pattern: "^rules \\d+\\.\\d+$" },
      task_versions: { type: "array", minItems: 1, items: str },
      counts: obj(["traps", "families", "jobs", "tasks", "ranked_attempts", "models"], { traps: int0, families: int0, jobs: int0, tasks: int0, ranked_attempts: int0, models: int0 }),
      traps: { type: "array", minItems: 1, items: { $ref: "#/$defs/trap" } },
      data_protection: obj(["public_traps_only", "private_families_included", "held_out_split", "canary", "provenance", "rules_versions", "task_versions", "public_vs_private_gap"], {
        public_traps_only: { const: true },
        private_families_included: { const: false },
        held_out_split: obj(["panel_version", "seeds_published", "runs_published", "reported_as", "longitudinal_panel"], {
          panel_version: str,
          seeds_published: { const: false },
          runs_published: { const: false },
          reported_as: str,
          longitudinal_panel: obj(["version", "max_bouts_per_model_version"], { version: str, max_bouts_per_model_version: int0 }),
        }),
        // on_each_trap_record is optional (Trap Set 1.0.1), so a 1.0 file still validates.
        canary: obj(["string", "guid", "carried_by"], { string: str, guid: str, carried_by: strs, on_each_trap_record: { const: "canary_guid" } }),
        provenance: obj(["licence_id", "licence_url", "per_row_block", "croissant"], { licence_id: { const: LICENCE_ID }, licence_url: str, per_row_block: { const: true }, croissant: str }),
        rules_versions: { type: "array", items: obj(["version", "date"], { version: str, date: day }) },
        task_versions: { type: "array", items: obj(["version", "date"], { version: str, date: day }) },
        public_vs_private_gap: obj(["method", "per_event", "weekly_pooled", "rows_measured", "rows_testing_contamination", "contamination", "history"], {
          method: obj(["unit", "gap", "interval", "min_attempts_each_side", "held_out_runs_published", "contamination_test_needs"], {
            unit: str,
            gap: str,
            interval: str,
            min_attempts_each_side: int0,
            held_out_runs_published: { const: false },
            contamination_test_needs: str,
          }),
          per_event: { type: "array", items: obj(["event", "event_name", ...gapReq], { event: str, event_name: str, ...gapCore }) },
          weekly_pooled: { type: "array", items: obj(["pooled", "events", ...gapReq], { pooled: { const: "weekly_headline_bouts" }, events: int0, ...gapCore }) },
          rows_measured: int0,
          rows_testing_contamination: int0,
          contamination: obj(["status", "test_rows", "test_events", "test_world_sets", "needs"], {
            status: { enum: ["not_yet_measured", "not_yet_established", "established"] },
            test_rows: int0,
            test_events: int0,
            test_world_sets: obj(["public", "held_out"], { public: int0, held_out: int0 }),
            needs: obj(["min_attempts_each_side", "public_arm", "min_distinct_events", "min_distinct_world_sets_each_side"], { min_attempts_each_side: int0, public_arm: { const: "previously_published" }, min_distinct_events: int0, min_distinct_world_sets_each_side: int0 }),
          }),
          history: str,
        }),
      }),
      referee_validation: obj(["study", "planned_sample", "agreement_bar", "lower_bound_floor", "status", "agreement", "ci_95", "n"], {
        study: str,
        planned_sample: int0,
        agreement_bar: prob,
        lower_bound_floor: prob,
        status: { enum: ["not_yet_published", "measured"] },
        agreement: nullable(prob),
        ci_95: interval(0),
        n: nullable(int0),
      }),
      results: obj(["policy", "unit", "source", "gauntlet_sprints_included", "models"], {
        policy: str,
        unit: { const: "attempt" },
        source: { const: "ranked_public_events" },
        gauntlet_sprints_included: { const: false },
        models: {
          type: "array",
          items: obj(["model", "name", "maker", "tier", "rules_version", "scored_under", "rescored_from_signed_logs", "played_under", "scored_under_trap_set_rules", "providers", "attempts", "pass", "trap_falls", "knockouts", "run_dates", "task_versions"], {
            model: str,
            name: str,
            maker: nullable(str),
            tier: { enum: ["normal", "hard"] },
            // ADR 0088: a re-scored group is "rules 0.6 re-scored" (scored under 0.6, played under older rules).
            rules_version: { type: "string", pattern: "^rules \\d+\\.\\d+( re-scored)?$" },
            scored_under: { type: "string", pattern: "^rules \\d+\\.\\d+$" },
            rescored_from_signed_logs: { type: "boolean" },
            played_under: { type: "object", propertyNames: { pattern: "^rules \\d+\\.\\d+$" }, additionalProperties: int0 },
            scored_under_trap_set_rules: { type: "boolean" },
            providers: strs,
            attempts: int0,
            pass: rate,
            trap_falls: rate,
            knockouts: int0,
            run_dates: obj(["first", "last"], { first: day, last: day }),
            task_versions: strs,
          }),
        },
      }),
      limits: obj(["early_read_below_attempts", "gap_min_attempts_each_side", "model_tier_rows", "model_tier_rows_below_early_read", "model_tier_rows_scored_under_older_rules", "model_tier_rows_rescored_from_signed_logs", "interval_assumptions", "traps_with_no_ranked_attempts_yet", "not_known"], {
        early_read_below_attempts: int0,
        gap_min_attempts_each_side: int0,
        model_tier_rows: int0,
        model_tier_rows_below_early_read: int0,
        model_tier_rows_scored_under_older_rules: int0,
        model_tier_rows_rescored_from_signed_logs: int0,
        interval_assumptions: obj(["independent_attempts_assumed", "repeated_attempts_per_variant", "trap_falls_count_each_trap_present_in_an_attempt", "covers_referee_error"], {
          independent_attempts_assumed: { type: "boolean" },
          repeated_attempts_per_variant: { type: "boolean" },
          trap_falls_count_each_trap_present_in_an_attempt: { type: "boolean" },
          covers_referee_error: { type: "boolean" },
        }),
        traps_with_no_ranked_attempts_yet: { type: "array", items: { type: "string", pattern: "^FA-[A-Z]{3}-0\\d{2}$" } },
        not_known: strs,
      }),
      versioning: obj(["scheme", "patch", "minor", "major", "next_minor_v1_1_when", "ids_stable_across_versions", "results_carry"], {
        scheme: str,
        patch: strs,
        minor: strs,
        major: strs,
        next_minor_v1_1_when: strs,
        ids_stable_across_versions: { const: true },
        results_carry: strs,
      }),
      changelog: { type: "array", minItems: 1, items: obj(["version", "date", "change"], { version: str, date: day, change: str }) },
      citation: obj(["title", "author", "version", "date", "url", "text", "bibtex", "cff"], { title: str, author: str, version: str, date: day, url: str, text: str, bibtex: str, cff: str }),
      // Optional (B3-05, ADR 0101): says this file is the live latest and where the frozen copies are.
      latest: obj(["live", "rebuilt_on_each_request", "frozen_snapshot", "versions"], { live: { const: true }, rebuilt_on_each_request: { const: true }, frozen_snapshot: str, versions: str }),
    },
  };
}
