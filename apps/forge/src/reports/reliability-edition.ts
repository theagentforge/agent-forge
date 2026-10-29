// The State of Agent Reliability (W5.1 / AQ-11, ADR 0079): one pure function from the site's own public JSON files to
// an edition, used three ways: by the Worker for the live page, by scripts/reliability-report.mjs to freeze an edition
// (with copies of its sources) and build its PDF, and by the tests that check every number against its source.
//
// No imports, and only TypeScript that Node can strip (no enums, namespaces or parameter properties), so the script
// can run this file directly with `node`. Every number in an edition is a `Num`: a value read at a JSON pointer in one
// named source file, or computed from such values by a named, documented operation (`op`). Pages and the PDF show
// numbers only through `Num`s, so a test can check each one against its source.

export const REPORT_NAME = "The State of Agent Reliability";
export const EDITION = {
  number: 1,
  slug: "2026-q4",
  quarter: "2026 Q4",
  path: "/reports/state-of-agent-reliability/2026-q4",
  json: "/reports/state-of-agent-reliability/2026-q4.json",
  pdf: "/reports/state-of-agent-reliability/2026-q4.pdf",
  /** Where frozen copies of the sources are served (static files, written by the script). */
  sources_dir: "/reports/state-of-agent-reliability/2026-q4/sources",
  /** Editions are regenerated each quarter; the next one is due in this month. */
  next_due: "2027-01",
} as const;
export const SERIES_PATH = "/reports/state-of-agent-reliability";

/** The public files every number comes from (paths on the site; the same objects the Worker builds in-process). */
export const SOURCES = {
  benchmark: "/benchmark/v1.json",
  stats: "/stats.json",
  security: "/security?format=json",
  home: "/?format=json",
} as const;
export type SourceKey = keyof typeof SOURCES;
export type Sources = Record<SourceKey, unknown>;
/** The file name a frozen copy of each source is saved under. */
export const SOURCE_FILES: Record<SourceKey, string> = { benchmark: "benchmark-v1.json", stats: "stats.json", security: "security.json", home: "home.json" };

/** How a derived number is computed from values at pointers (all documented on the page, in the JSON and in the PDF). */
export type Op = "length" | "count_shown" | "diff" | "rate" | "wilson_lo" | "wilson_hi";
export const OP_TEXT: Record<Op, string> = {
  length: "number of items in the list at the pointer",
  count_shown: "number of items in the list at the pointer whose `shown` is true",
  diff: "value at the pointer minus value at the second pointer",
  rate: "value at the pointer divided by value at the second pointer",
  wilson_lo: "lower bound of the 95% Wilson interval for (pointer) of (second pointer), rounded down to 3 decimals",
  wilson_hi: "upper bound of the 95% Wilson interval for (pointer) of (second pointer), rounded up to 3 decimals",
};

export type Value = number | string | boolean | null;
export interface Num {
  value: Value;
  source: SourceKey;
  pointer: string;
  op?: Op;
  pointer2?: string;
}

/** `pct2`: a percentage to 2 decimals, for small rates published that way (the launch skill scan's 0.33%). */
/** `ratio`: a risk ratio or a p-value, to 2 decimals (B2-04). */
export type Fmt = "int" | "pct" | "pct2" | "pct_lo" | "pct_hi" | "ratio" | "text" | "date";
/** A sentence: plain text and numbers (`{ n, fmt }` names a key in `nums`). */
export type Seg = string | { n: string; fmt: Fmt };

export interface Finding {
  id: string;
  title: string;
  text: Seg[];
  /** Shown next to the finding when a sample is small or a number is missing. */
  warning: Seg[] | null;
  source: SourceKey;
  /** Anchor on the source's page with the full table. */
  more: string;
  /** Set on a Forge Lab experiment's finding (B2-04: Lab #4's null result). */
  lab?: number;
}

export interface GroupRow {
  name: string;
  attempts: string;
  falls: string | null;
  rate: string | null;
  lo: string | null;
  hi: string | null;
  early: boolean;
  shown: boolean;
}

export interface Edition {
  name: string;
  edition: number;
  quarter: string;
  path: string;
  /** "frozen": numbers from saved copies of the sources (citable); "live_preview": read when the page was built. */
  mode: "frozen" | "live_preview";
  /** True only for a frozen edition: a live preview's numbers change, so it must not be cited. */
  citable: boolean;
  generated: string;
  generated_at: string;
  next_due: string;
  rules_versions: { arena_referee: string | null; trap_set: string | null; skill_scan: string | null; stats_rules: string | null };
  canary: string | null;
  sources: { key: SourceKey; path: string }[];
  ops: Record<Op, string>;
  nums: Record<string, Num>;
  findings: Finding[];
  groups: GroupRow[];
  totals: { label: string; n: string }[];
  case_study: { found: boolean; run: string | null; replay_url: string | null };
  citation: { text: string; bibtex: string; cff: string };
}

/**
 * Numbers a frozen edition must have: if any is missing, a source file changed shape (or the wrong file was saved), and
 * freezing stops rather than publish "not available" in a citable edition. Totals that stats.json hides below their
 * minimums may be null; rates may be null only when the source shows no rate.
 */
export function missingNumbers(e: Edition): string[] {
  const need = [
    "arena_rules", "arena_attempts", "arena_shown", "arena_models", "arena_knockouts", "arena_min_shown", "early_read_below",
    "trap_set_rules", "trap_set_version", "stats_rules_version", "canary",
    "traps", "jobs", "families", "job_versions", "bench_ranked_attempts", "bench_models", "model_rows", "model_rows_early", "model_rows_older", "bench_early_below", "traps_unplayed",
    "scan_skills", "scan_ordinary", "scan_flagged", "scan_rate", "scan_lo", "scan_hi", "scan_real", "scan_malice", "scan_malware", "scan_date", "scan_rules_version",
    "referee_status", "contamination_status", "contamination_events", "contamination_needs", "gap_rows",
    "bouts", "ranked_bouts", "practice_bouts", "traps_sprung", "case_status",
  ];
  if (e.nums.arena_shown?.value === true) need.push("arena_falls", "arena_rate", "arena_lo", "arena_hi", "arena_since", "arena_as_of");
  if (e.case_study.found) need.push("case_run", "case_model", "case_task", "case_trap_id", "case_trap", "case_claim", "case_ranked", "case_finished", "case_replay");
  for (const g of e.groups) for (const id of [g.name, g.attempts, g.falls, g.rate, g.lo, g.hi]) if (id) need.push(id);
  for (const f of e.findings) if (f.lab !== undefined) for (const seg of f.text) if (typeof seg !== "string") need.push(seg.n);
  return need.filter((id) => (e.nums[id]?.value ?? null) === null);
}

// ---------------------------------------------------------------- reading values

/** RFC 6901 JSON pointer. Missing paths read as undefined. */
export function at(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const Z = 1.959963984540054;
/** 95% Wilson score interval for k of n, rounded outwards to 3 decimals (ADR 0068 Amendment 1). */
export function wilsonOutward(k: number, n: number): [number, number] | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const c = (p + (Z * Z) / (2 * n)) / d;
  const h = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  const lo = Math.max(0, Math.floor((c - h) * 1000 + 1e-9) / 1000);
  const hi = Math.min(1, Math.ceil((c + h) * 1000 - 1e-9) / 1000);
  return [lo, hi];
}

const scalar = (x: unknown): Value => (typeof x === "number" || typeof x === "string" || typeof x === "boolean" ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** The value of a Num from the sources (the builder and the tests' cross-check both use the definition in OP_TEXT). */
export function resolve(sources: Sources, source: SourceKey, pointer: string, op?: Op, pointer2?: string): Value {
  const doc = sources[source];
  const a = at(doc, pointer);
  if (!op) return scalar(a);
  if (op === "length") return Array.isArray(a) ? a.length : null;
  if (op === "count_shown") return Array.isArray(a) ? a.filter((x) => at(x, "/shown") === true).length : null;
  const x = num(a);
  const y = num(at(doc, pointer2 ?? ""));
  if (x === null || y === null) return null;
  if (op === "diff") return x - y;
  if (op === "rate") return y > 0 ? Math.round((x / y) * 1e6) / 1e6 : null;
  const ci = wilsonOutward(x, y);
  return ci ? (op === "wilson_lo" ? ci[0] : ci[1]) : null;
}

// ---------------------------------------------------------------- formatting

/** How a number reads on the page and in the PDF. Interval bounds are shown rounded outwards to 0.1%. */
export function display(v: Value, fmt: Fmt): string {
  if (v === null) return "not available";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return fmt === "date" ? dayText(v) : v.replace(/_/g, " ");
  if (fmt === "pct") return `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
  if (fmt === "pct2") return `${(Math.round(v * 10000) / 100).toFixed(2)}%`;
  if (fmt === "pct_lo") return `${(Math.floor(v * 1000 + 1e-9) / 10).toFixed(1)}%`;
  if (fmt === "pct_hi") return `${(Math.ceil(v * 1000 - 1e-9) / 10).toFixed(1)}%`;
  if (fmt === "ratio") return v.toFixed(2);
  return v.toLocaleString("en-US");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function dayText(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

/** A sentence as plain text (the PDF, the JSON's `plain` fields and the share description). */
export function plain(segs: Seg[], nums: Record<string, Num>): string {
  return segs.map((s) => (typeof s === "string" ? s : display(nums[s.n]?.value ?? null, s.fmt))).join("");
}

// ---------------------------------------------------------------- the edition

export interface BuildOptions {
  origin: string;
  mode: Edition["mode"];
  /** ISO time the sources were read. */
  generatedAt: string;
}

export function buildEdition(sources: Sources, o: BuildOptions): Edition {
  const nums: Record<string, Num> = {};
  const put = (id: string, source: SourceKey, pointer: string, op?: Op, pointer2?: string) => {
    nums[id] = { value: resolve(sources, source, pointer, op, pointer2), source, pointer, ...(op ? { op } : {}), ...(pointer2 ? { pointer2 } : {}) };
    return id;
  };
  const v = (id: string) => nums[id]?.value ?? null;
  const n = (id: string, fmt: Fmt = "int"): Seg => ({ n: id, fmt });

  // Rules versions and stamps.
  put("arena_rules", "security", "/arena/rules_version");
  put("trap_set_rules", "benchmark", "/rules_version");
  put("trap_set_version", "benchmark", "/version");
  put("scan_rules_version", "security", "/reports/skill_scan/rules_version");
  put("stats_rules_version", "stats", "/rules_version");

  // 1. Ranked Arena attempts under the current referee rules (ADR 0072: one rules version, outward intervals).
  put("arena_attempts", "security", "/arena/overall/attempts");
  put("arena_falls", "security", "/arena/overall/policy_breaks");
  put("arena_rate", "security", "/arena/overall/break_rate");
  put("arena_lo", "security", "/arena/overall/ci_95/0");
  put("arena_hi", "security", "/arena/overall/ci_95/1");
  put("arena_early", "security", "/arena/overall/early_read");
  put("arena_shown", "security", "/arena/overall/shown");
  put("arena_models", "security", "/arena/models");
  put("arena_knockouts", "security", "/arena/knockouts");
  put("arena_since", "security", "/arena/since");
  put("arena_as_of", "security", "/arena/as_of");
  put("arena_min_shown", "security", "/arena/min_attempts_shown");
  put("early_read_below", "security", "/arena/early_read_below");
  const older = at(sources.security, "/arena/attempts_under_older_rules");
  if (Array.isArray(older))
    older.forEach((_, i) => {
      put(`older_rules_${i}`, "security", `/arena/attempts_under_older_rules/${i}/rules_version`);
      put(`older_attempts_${i}`, "security", `/arena/attempts_under_older_rules/${i}/attempts`);
    });
  // B2-01 (ADR 0088): attempts re-scored under the current rules from signed logs are named apart, never pooled.
  const rescored = at(sources.security, "/arena/rescored");
  if (rescored && typeof rescored === "object") {
    put("rescored_rules", "security", "/arena/rescored/scored_under");
    put("rescored_attempts", "security", "/arena/rescored/attempts");
  }

  const arenaShown = v("arena_shown") === true && typeof v("arena_attempts") === "number";
  const findings: Finding[] = [];
  findings.push({
    id: "ranked-trap-falls",
    title: "How often ranked AI models fell for a planted trap",
    text: arenaShown
      ? ["In ", n("arena_attempts"), " ranked attempts at everyday business jobs, scored under the current referee rules (", n("arena_rules", "text"), "), AI models fell for at least one planted trap ", n("arena_falls"), " times: ", n("arena_rate", "pct"), " (95% interval ", n("arena_lo", "pct_lo"), " to ", n("arena_hi", "pct_hi"), "), across ", n("arena_models"), " models, ", n("arena_since", "date"), " to ", n("arena_as_of", "date"), ". A further ", n("arena_knockouts"), " attempts ran out of time, tokens or turns and are counted neither way."]
      : ["Not yet measured: there are too few ranked attempts under the current referee rules (", n("arena_rules", "text"), "; ", n("arena_attempts"), " attempts) to show a rate."],
    warning: arenaShown
      ? v("arena_early") === true
        ? ["Small sample: fewer than ", n("early_read_below"), " attempts, so this is an early read, not a verdict."]
        : ["The interval treats every attempt as a separate draw; each job version is played 3 times and an attempt can hold several traps, so the real uncertainty is somewhat wider."]
      : null,
    source: "security",
    more: "/security#arena",
  });

  // 2. By kind of job (the same rules version). Only rows the source shows (enough attempts) are compared.
  const groups: GroupRow[] = [];
  const g = at(sources.security, "/arena/by_group");
  if (Array.isArray(g))
    g.forEach((row, i) => {
      if (num(at(row, "/attempts")) === 0) return;
      const p = `/arena/by_group/${i}`;
      put(`group_${i}_name`, "security", `${p}/name`);
      put(`group_${i}_attempts`, "security", `${p}/attempts`);
      const shown = at(row, "/shown") === true;
      if (shown) {
        put(`group_${i}_falls`, "security", `${p}/policy_breaks`);
        put(`group_${i}_rate`, "security", `${p}/break_rate`);
        put(`group_${i}_lo`, "security", `${p}/ci_95/0`);
        put(`group_${i}_hi`, "security", `${p}/ci_95/1`);
      }
      groups.push({
        name: `group_${i}_name`,
        attempts: `group_${i}_attempts`,
        falls: shown ? `group_${i}_falls` : null,
        rate: shown ? `group_${i}_rate` : null,
        lo: shown ? `group_${i}_lo` : null,
        hi: shown ? `group_${i}_hi` : null,
        early: at(row, "/early_read") === true,
        shown,
      });
    });
  const rated = groups.filter((r) => r.shown && typeof v(r.rate!) === "number");
  if (rated.length >= 2) {
    const sorted = [...rated].sort((a, b) => (v(b.rate!) as number) - (v(a.rate!) as number));
    const hi = sorted[0]!;
    const lo = sorted[sorted.length - 1]!;
    const overlap = (v(hi.lo!) as number) <= (v(lo.hi!) as number);
    put("groups_rated", "security", "/arena/by_group", "count_shown");
    findings.push({
      id: "by-kind-of-job",
      title: "Which kinds of job tripped models most",
      text: ["Scored under the current referee rules (", n("arena_rules", "text"), "), across the ", n("groups_rated"), " kinds of business job with enough attempts to show a rate, the highest fall rate was ", n(hi.name, "text"), " at ", n(hi.rate!, "pct"), " (", n(hi.falls!), " of ", n(hi.attempts), "; 95% interval ", n(hi.lo!, "pct_lo"), " to ", n(hi.hi!, "pct_hi"), ") and the lowest ", n(lo.name, "text"), " at ", n(lo.rate!, "pct"), " (", n(lo.falls!), " of ", n(lo.attempts), "; ", n(lo.lo!, "pct_lo"), " to ", n(lo.hi!, "pct_hi"), "). ", overlap ? "Their intervals overlap, so this is not a clear difference." : "Their intervals don't overlap."],
      warning: hi.early || lo.early ? ["Small sample: at least one of these rows has fewer than ", n("early_read_below"), " attempts (an early read)."] : null,
      source: "security",
      more: "/security#jobs",
    });
  }

  // 2b. What our own fix didn't do (B2-04, Boardy 10): Forge Lab #4's pre-registered result on frontier models, with
  // Lab #3 (small open models, with a placebo arm) beside it, read from /security's trap_card_experiments.
  const exps = at(sources.security, "/trap_card_experiments");
  const labAt = (lab: number) => (Array.isArray(exps) ? exps.findIndex((x) => at(x, "/lab") === lab) : -1);
  const i4 = labAt(4);
  const i3 = labAt(3);
  if (i4 >= 0) {
    const lab = (id: string, i: number, field: string) => put(`lab${id}_${field}`, "security", `/trap_card_experiments/${i}/${field.replace(/__/g, "/")}`);
    for (const f of ["finished", "rules_version", "bouts", "bouts_per_arm", "model_job_pairs", "arms__card__fell", "arms__card__bouts", "arms__no_card__fell", "arms__no_card__bouts", "risk_ratio", "risk_ratio_ci95__0", "risk_ratio_ci95__1", "p_text", "result"]) lab("4", i4, f);
    if (i3 >= 0) for (const f of ["finished", "rules_version", "bouts", "arms__card__fell", "arms__card__bouts", "arms__placebo__fell", "arms__placebo__bouts", "arms__no_card__fell", "arms__no_card__bouts", "risk_ratio", "risk_ratio_ci95__0", "risk_ratio_ci95__1", "p_text"]) lab("3", i3, f);
    const nullResult = v("lab4_result") === "did_not_measurably_reduce_traps";
    findings.push({
      id: "trap-card-null",
      title: "What our own fix didn't do",
      lab: 4,
      text: [
        "The Forge's free trap card is our own product. In a pre-registered experiment (Forge Lab #4, finished ", n("lab4_finished", "date"), ", scored under ", n("lab4_rules_version", "text"), "), frontier models given the card fell for a planted trap in ", n("lab4_arms__card__fell"), " of ", n("lab4_arms__card__bouts"), " bouts on Hard jobs, against ", n("lab4_arms__no_card__fell"), " of ", n("lab4_arms__no_card__bouts"), " without it (", n("lab4_bouts"), " bouts in all, ", n("lab4_model_job_pairs"), " model–job pairs). ",
        nullResult ? "In the words its pre-registration allows: the card didn't measurably reduce traps." : "Its pre-registered test found a reduction.",
        " Risk ratio ", n("lab4_risk_ratio", "ratio"), " (95% interval ", n("lab4_risk_ratio_ci95__0", "ratio"), " to ", n("lab4_risk_ratio_ci95__1", "ratio"), "; ", n("lab4_p_text", "text"), ").",
        ...(i3 >= 0
          ? [" Beside it, Forge Lab #3 on small open models (finished ", n("lab3_finished", "date"), ", ", n("lab3_rules_version", "text"), "): with the card ", n("lab3_arms__card__fell"), " of ", n("lab3_arms__card__bouts"), " bouts fell for a trap, with a placebo text of the same length ", n("lab3_arms__placebo__fell"), " of ", n("lab3_arms__placebo__bouts"), ", with no card ", n("lab3_arms__no_card__fell"), " of ", n("lab3_arms__no_card__bouts"), " (risk ratio ", n("lab3_risk_ratio", "ratio"), ", 95% interval ", n("lab3_risk_ratio_ci95__0", "ratio"), " to ", n("lab3_risk_ratio_ci95__1", "ratio"), "; ", n("lab3_p_text", "text"), ")."] as Seg[]
          : []),
      ],
      warning: ["A risk ratio of one means no difference; an interval that includes one means no measurable effect. Lab runs change the prompt, so they are never counted in the ranked rates above."],
      source: "security",
      more: "/security#null-result",
    });
  }

  // 3. Sample sizes in the Trap Set (ADR 0068 Amendment 1: rows split by rules version).
  put("traps", "benchmark", "/counts/traps");
  put("jobs", "benchmark", "/counts/jobs");
  put("families", "benchmark", "/counts/families");
  put("job_versions", "benchmark", "/counts/tasks");
  put("bench_ranked_attempts", "benchmark", "/counts/ranked_attempts");
  put("bench_models", "benchmark", "/counts/models");
  put("model_rows", "benchmark", "/limits/model_tier_rows");
  put("model_rows_early", "benchmark", "/limits/model_tier_rows_below_early_read");
  put("model_rows_older", "benchmark", "/limits/model_tier_rows_scored_under_older_rules");
  put("bench_early_below", "benchmark", "/limits/early_read_below_attempts");
  put("traps_unplayed", "benchmark", "/limits/traps_with_no_ranked_attempts_yet", "length");
  findings.push({
    id: "sample-sizes",
    title: "How big the samples are",
    text: ["The Forge Trap Set ", n("trap_set_version", "text"), " holds ", n("traps"), " public traps in ", n("jobs"), " jobs (", n("job_versions"), " job versions). Its per-model results hold ", n("bench_ranked_attempts"), " ranked attempts by ", n("bench_models"), " models across all rules versions, so more than the current-rules count above. ", n("model_rows_early"), " of its ", n("model_rows"), " per-model result rows have fewer than ", n("bench_early_below"), " attempts, ", n("model_rows_older"), " were scored under rules older than the set's own (", n("trap_set_rules", "text"), ") and are kept apart, and ", n("traps_unplayed"), " of the ", n("traps"), " traps have no ranked attempt yet."],
    warning: ["Small samples: read a per-model row with fewer than ", n("bench_early_below"), " attempts as an early read, not a verdict."],
    source: "benchmark",
    more: "/benchmark#results",
  });

  // 4. The launch skill scan, with the report's own figures (ADR 0072 rule 4).
  put("scan_skills", "security", "/reports/skill_scan/skills");
  put("scan_ordinary", "security", "/reports/skill_scan/ordinary_skills");
  put("scan_flagged", "security", "/reports/skill_scan/flagged_ordinary");
  put("scan_rate", "security", "/reports/skill_scan/flagged_ordinary", "rate", "/reports/skill_scan/ordinary_skills");
  put("scan_lo", "security", "/reports/skill_scan/flagged_ordinary", "wilson_lo", "/reports/skill_scan/ordinary_skills");
  put("scan_hi", "security", "/reports/skill_scan/flagged_ordinary", "wilson_hi", "/reports/skill_scan/ordinary_skills");
  put("scan_real", "security", "/reports/skill_scan/real_patterns");
  put("scan_malice", "security", "/reports/skill_scan/signs_of_malice");
  put("scan_malware", "security", "/reports/skill_scan/malware_found");
  put("scan_date", "security", "/reports/skill_scan/date");
  findings.push({
    id: "skill-scan",
    title: "What the launch scan of public agent skills found",
    text: ["In the launch scan (", n("scan_date", "date"), ", scan rules ", n("scan_rules_version", "text"), "), ", n("scan_flagged"), " of ", n("scan_ordinary"), " ordinary public agent skills matched a high-risk pattern: ", n("scan_rate", "pct2"), " (95% interval ", n("scan_lo", "pct_lo"), " to ", n("scan_hi", "pct_hi"), "). On hand review, real patterns: ", n("scan_real"), "; showing signs of malice: ", n("scan_malice"), "; malware found by this method: ", n("scan_malware"), ". Security courses, test fixtures and examples, which quote attacks on purpose, are counted apart (", n("scan_skills"), " skills were scanned in all)."],
    warning: ["The scanner matches text only: it runs no code and can't see what a remote server does, so a clear result is not a safety guarantee."],
    source: "security",
    more: "/reports/skill-scan-2026-10",
  });

  // 5. What isn't known yet (ADR 0071 and its Amendment 1; the referee audit, ADR 0068 Amendment 1 rule 3).
  put("referee_status", "benchmark", "/referee_validation/status");
  put("contamination_status", "benchmark", "/data_protection/public_vs_private_gap/contamination/status");
  put("contamination_events", "benchmark", "/data_protection/public_vs_private_gap/contamination/test_events");
  put("contamination_needs", "benchmark", "/data_protection/public_vs_private_gap/contamination/needs/min_distinct_events");
  put("gap_rows", "benchmark", "/data_protection/public_vs_private_gap/rows_measured");
  const established = v("contamination_status") === "established";
  findings.push({
    id: "not-yet-known",
    title: "What isn't known yet",
    text: [
      "How often a person agrees with the referee: ",
      v("referee_status") === "measured" ? "measured (see the Trap Set page)" : "not yet published (Forge Lab #6, a pre-registered blind audit, measures it)",
      ". Whether models do better on job versions published before a test (contamination): ",
      // Review of ADR 0082 (ADR 0085): a known unknown says exactly where it stands (the test hasn't run, with its counts
      // below), never a bare "not yet measured", which the freeze gate keeps out of findings.
      established ? "established" : v("contamination_status") === "not_yet_established" ? "measured, not yet established" : "not tested yet: no contamination test event has run",
      ". Contamination test events so far: ",
      n("contamination_events"),
      " (at least ",
      n("contamination_needs"),
      " are needed, between them playing different job versions). Public-against-held-out comparison rows measured: ",
      n("gap_rows"),
      ".",
    ],
    warning: established ? null : ["Until the contamination effect is established, a measured gap is not a contamination result."],
    source: "benchmark",
    more: "/benchmark#data-protection",
  });

  // Totals (stats.json, ADR 0067 Amendment 1: they include The Forge's own test agents and say so).
  put("bouts", "stats", "/blended/work/bouts_refereed");
  put("ranked_bouts", "stats", "/blended/work/ranked_bouts");
  put("practice_bouts", "stats", "/blended/work/bouts_refereed", "diff", "/blended/work/ranked_bouts");
  put("traps_sprung", "stats", "/blended/work/traps_sprung");
  put("gauntlet_runs", "stats", "/blended/gauntlet_runs_finished");
  // Review of B3-04 (ADR 0105): below its minimum /stats.json leaves the key out; so does the edition (no null entry
  // naming the row in `nums`, which the edition JSON publishes).
  if (v("gauntlet_runs") === null) delete nums.gauntlet_runs;
  put("field_reports", "stats", "/blended/work/field_reports");
  put("skills_scanned", "stats", "/blended/work/skills_scanned");
  put("tools_tracked", "stats", "/blended/work/tools_tracked");
  const totals = [
    { label: "Arena bouts refereed, practice included", n: "bouts" },
    { label: "…of them ranked", n: "ranked_bouts" },
    { label: "…of them practice and other unranked runs", n: "practice_bouts" },
    { label: "Traps sprung in all bouts", n: "traps_sprung" },
    { label: "Gauntlet runs finished", n: "gauntlet_runs" },
    { label: "Field reports filed (most are our House agent's nightly install tests)", n: "field_reports" },
    { label: "Distinct skills scanned", n: "skills_scanned" },
    { label: "Tools tracked", n: "tools_tracked" },
  ];

  // The illustrative case: the home page's source replay (a practice bout, not ranked).
  put("case_status", "home", "/hero/headline_source/status");
  const found = v("case_status") === "found";
  if (found) {
    put("case_run", "home", "/hero/headline_source/run");
    put("case_model", "home", "/hero/headline_source/model_name");
    put("case_lab", "home", "/hero/headline_source/model_lab");
    put("case_task", "home", "/hero/headline_source/task");
    put("case_trap_id", "home", "/hero/headline_source/trap_id");
    put("case_trap", "home", "/hero/headline_source/trap");
    put("case_claim", "home", "/hero/headline_source/claim");
    put("case_ranked", "home", "/hero/headline_source/ranked");
    put("case_finished", "home", "/hero/headline_source/finished_at");
    put("case_replay", "home", "/hero/headline_source/replay_url");
  }

  put("canary", "benchmark", "/canary");
  const generated = o.generatedAt.slice(0, 10);
  const rv = {
    arena_referee: (v("arena_rules") as string | null) ?? null,
    trap_set: (v("trap_set_rules") as string | null) ?? null,
    skill_scan: (v("scan_rules_version") as string | null) ?? null,
    stats_rules: (v("stats_rules_version") as string | null) ?? null,
  };
  return {
    name: REPORT_NAME,
    edition: EDITION.number,
    quarter: EDITION.quarter,
    path: EDITION.path,
    mode: o.mode,
    citable: o.mode === "frozen",
    generated,
    generated_at: o.generatedAt,
    next_due: EDITION.next_due,
    rules_versions: rv,
    canary: typeof v("canary") === "string" ? (v("canary") as string) : null,
    sources: (Object.keys(SOURCES) as SourceKey[]).map((key) => ({ key, path: SOURCES[key] })),
    ops: OP_TEXT,
    nums,
    findings,
    groups,
    // B3-04 (ADR 0099): stats.json leaves Gauntlet runs out below their minimum; the row goes, never "not available".
    totals: totals.filter((x) => x.n !== "gauntlet_runs" || v("gauntlet_runs") !== null),
    case_study: { found, run: found ? (v("case_run") as string) : null, replay_url: found ? (v("case_replay") as string) : null },
    citation: citation(o.origin, generated, rv, o.mode),
  };
}

// ---------------------------------------------------------------- freeze gates (F-03)

/**
 * F-03 (build plan 28 Oct §5.1; ADR 0082): Edition 1 is frozen only when every blocking gate passes. The freeze script
 * checks them on the edition it is about to freeze and refuses (or, with --dry-run, only reports) when one fails.
 */
export const FREEZE_RULES = {
  /** Gate 1: at least this many models, each with at least `min_attempts` ranked Hard attempts under the current rules. */
  min_models: 4,
  min_attempts: 30,
  tier: "hard",
  /** Gate 2: no finding may read like this. */
  unmeasured: ["not yet measured", "not available"],
  /** Gate 5: findings that state a rate must name the rules that scored it. */
  rate_findings: ["ranked-trap-falls", "by-kind-of-job", "trap-card-null"],
} as const;

/** The finding that lists what isn't known yet (ADR 0085: honest, specific, and always last). */
export const KNOWN_UNKNOWNS = "not-yet-known";

export interface FreezeGate {
  id: string;
  title: string;
  pass: boolean;
  /** A failing blocking gate stops the freeze; an advisory one is only reported (§5.1 item 4). */
  blocking: boolean;
  detail: string;
}

export function freezeGates(e: Edition, sources: Sources, o: { approved: boolean; approvalDetail?: string }): FreezeGate[] {
  const gates: FreezeGate[] = [];
  const add = (id: string, title: string, pass: boolean, detail: string, blocking = true) => gates.push({ id, title, pass, blocking, detail });

  const missing = missingNumbers(e);
  add("numbers_present", "Every number the edition needs is in the sources", !missing.length, missing.length ? `missing from the sources (a file changed shape or is the wrong file): ${missing.join(", ")}` : "all present");

  const current = e.rules_versions.arena_referee;
  const rows = at(sources.benchmark, "/results/models");
  const per = new Map<string, number>();
  if (Array.isArray(rows))
    for (const r of rows)
      if (at(r, "/tier") === FREEZE_RULES.tier && current !== null && at(r, "/rules_version") === current) {
        const m = String(at(r, "/model"));
        per.set(m, (per.get(m) ?? 0) + (num(at(r, "/attempts")) ?? 0));
      }
  const enough = [...per.values()].filter((x) => x >= FREEZE_RULES.min_attempts).length;
  add(
    "current_rules_results",
    `At least ${FREEZE_RULES.min_models} models with at least ${FREEZE_RULES.min_attempts} ranked Hard attempts each under the current rules`,
    enough >= FREEZE_RULES.min_models,
    `${enough} of ${FREEZE_RULES.min_models} models have ${FREEZE_RULES.min_attempts}+ ranked Hard attempts under ${current ?? "the current rules (unknown)"}${per.size ? ` (${[...per.entries()].map(([m, a]) => `${m}: ${a}`).join(", ")})` : "; none has any"}`,
  );

  const unmeasured = e.findings.filter((f) => {
    const t = `${plain(f.text, e.nums)} ${f.warning ? plain(f.warning, e.nums) : ""}`.toLowerCase();
    return FREEZE_RULES.unmeasured.some((w) => t.includes(w));
  });
  add("no_unmeasured_findings", 'No finding reads "Not yet measured" or "not available"', !unmeasured.length, unmeasured.length ? `found in: ${unmeasured.map((f) => f.id).join(", ")}` : "none");

  // The known unknowns (what hasn't been tested yet, each with its counts) are honest and stay, but never lead: they
  // come after every measured finding (ADR 0085).
  const unknownsAt = e.findings.findIndex((f) => f.id === KNOWN_UNKNOWNS);
  const framed = unknownsAt === -1 || unknownsAt === e.findings.length - 1;
  add("known_unknowns_last", "What isn't known yet comes after every measured finding", framed, framed ? (unknownsAt === -1 ? "no known-unknowns finding" : "last") : `it is finding ${unknownsAt + 1} of ${e.findings.length}`);

  const lab4 = e.findings.find((f) => f.lab === 4);
  const ci = ["lab4_risk_ratio_ci95__0", "lab4_risk_ratio_ci95__1", "lab4_bouts"].every((id) => typeof e.nums[id]?.value === "number");
  add("null_result_finding", "The Lab #4 null result is a finding, with its n and interval", !!lab4 && ci, lab4 ? (ci ? "present" : "present, but its n or interval is missing") : "missing");

  const audit = e.nums.referee_status?.value ?? null;
  add("referee_audit", "Referee audit status is current (recommended, not required)", audit === "measured", audit === "measured" ? "measured" : `status: ${audit ?? "unknown"}; the finding says so and names the audit`, false);

  const unlabelled = e.findings.filter((f) => (FREEZE_RULES.rate_findings as readonly string[]).includes(f.id) && !/\brules \d/.test(plain(f.text, e.nums)));
  const rv = Object.entries(e.rules_versions).filter(([, x]) => x === null).map(([k]) => k);
  add("rules_labels", "Every rate names the rules that scored it", !unlabelled.length && !rv.length, [unlabelled.length ? `no rules label: ${unlabelled.map((f) => f.id).join(", ")}` : "", rv.length ? `rules version unknown: ${rv.join(", ")}` : ""].filter(Boolean).join("; ") || "all labelled");

  const text = JSON.stringify(e);
  const leaks = [/FA-[A-Z]+-1\d\d/.test(text) ? "a private trap id" : "", /held[-_ ]?out (seed|panel) [a-z0-9]/i.test(text) ? "a held-out seed" : ""].filter(Boolean);
  add("no_private_material", "No private trap, held-out seed or held scan (embargoed models are filtered out of the sources upstream)", !leaks.length, leaks.length ? `found ${leaks.join(" and ")}` : "none found");

  add("dinike_said_freeze", 'Dinike has read the final PDF and said "freeze"', o.approved, o.approvalDetail ?? (o.approved ? "given (--dinike-said-freeze)" : "not given: pass --dinike-said-freeze only after Dinike says so"));
  return gates;
}

/** The gates as lines for the script's report. */
export const gateLines = (gates: FreezeGate[]) => gates.map((g) => `${g.pass ? "✓" : g.blocking ? "✗" : "!"} ${g.id}: ${g.title}. ${g.detail}`);
export const failedGates = (gates: FreezeGate[]) => gates.filter((g) => g.blocking && !g.pass);

/** "Methods and limits", which comes first in the page and the PDF. */
export function methods(e: Edition): { title: string; text: Seg[] }[] {
  const older = olderRulesText(e);
  const n = (id: string, fmt: Fmt = "int"): Seg => ({ n: id, fmt });
  return [
    { title: "Only our public data", text: ["Every finding is read from The Agent Forge's own public data files, listed under Sources at the end. Each number links to the file and the JSON pointer it came from; a derived number (a rate, a difference, an interval we compute) names its formula. Rebuilding this edition from the same files gives the same numbers and the same PDF."] },
    { title: "What the Arena tests", text: ["AI models do everyday business jobs (refunds, supplier invoices, bookings, stock orders, records) in an invented sandbox with traps planted inside. A referee scores the sandbox's end state and the log of tool calls, never the model's own account of what it did."] },
    { title: "Ranked and practice are kept apart", text: ["Arena rates come from ranked bouts only (headline and guest events). Practice runs, prompt experiments (Forge Lab arms), results still under notice under the results policy, private job families, held-out job versions and events still being checked are left out of every rate. Practice appears only in the totals and in the illustrative case, labelled as practice."] },
    {
      title: "One rules version",
      text: [
        ...(older.length
          ? ["Arena rates count only attempts scored under the current referee rules (", n("arena_rules", "text"), "). Attempts scored under older rules (", ...older, ") are not pooled with them; their per-model rows are on the Trap Set page."]
          : ["Arena rates count only attempts scored under the current referee rules (", n("arena_rules", "text"), ")."]),
        ...("rescored_attempts" in e.nums
          ? [" A further ", n("rescored_attempts"), " attempts were played under older rules and re-scored under ", n("rescored_rules", "text"), " from their signed logs; they are counted apart, labelled re-scored, and never pooled with attempts played under the current rules."]
          : []),
      ] as Seg[],
    },
    { title: "Intervals", text: ["Every rate comes with its count (k of n) and a 95% Wilson interval, rounded outwards so it is never narrower than computed. Intervals cover sampling error only, not referee error, and treat attempts as separate draws, so the real uncertainty is wider."] },
    { title: "Small samples", text: ["Under ", n("early_read_below"), " attempts a rate is an early read, not a verdict, and is marked. Rows under ", n("arena_min_shown"), " attempts show no rate at all."] },
    { title: "Totals include our own agents", text: ["Includes The Forge's own test agents. The activity totals count everything, our own test agents, practice and crawlers included; how each is counted is on the stats rules page."] },
    { title: "Sandbox, not the real world", text: ["The jobs are invented, with no real companies, people or money. A rate here is evidence about these jobs, not a forecast for yours; the real-world cost of a failure is not measured."] },
    { title: "Kinds of job, not models", text: ["This report compares kinds of job, not models. Per-model results are already published, with their counts, intervals and replays, on the Trap Set page under the results policy; this edition does not rank models. The Agent Forge is not affiliated with any lab."] },
  ];
}

/** The illustrative case as a sentence, or null when the home page has no source replay. */
export function caseText(e: Edition): Seg[] | null {
  if (!e.case_study.found) return null;
  const n = (id: string, fmt: Fmt = "text"): Seg => ({ n: id, fmt });
  const ranked = e.nums.case_ranked?.value === true;
  const lab = e.nums.case_lab?.value;
  return [
    "In a refereed ",
    ranked ? "ranked bout" : "practice bout (not ranked, and not counted in any rate above)",
    " on ",
    n("case_finished", "date"),
    " (run ",
    n("case_run"),
    "), ",
    n("case_model"),
    ...(typeof lab === "string" && lab ? [" (", n("case_lab"), ")"] : []),
    " was given the job ",
    n("case_task"),
    ". The referee's record shows it fell for the planted trap ",
    n("case_trap_id"),
    " (",
    n("case_trap"),
    "), then its own finish call said the job was ",
    n("case_claim"),
    ". The referee reads the sandbox and the tool-call log, so the fall is on the record whatever the model said. One run is an illustration, not a rate: it shows what a trap fall looks like, not how often it happens.",
  ];
}

/** Older-rules attempts as a sentence (kept apart from the current rules, ADR 0068 Amendment 1). */
export function olderRulesText(e: Edition): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; `older_rules_${i}` in e.nums; i++) segs.push(i ? "; " : "", { n: `older_rules_${i}`, fmt: "text" }, ": ", { n: `older_attempts_${i}`, fmt: "int" });
  return segs;
}

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Until frozen, every form of the citation says it is a live preview that must not be cited (no release date). */
export function citation(origin: string, generated: string, rv: Edition["rules_versions"], mode: Edition["mode"] = "frozen") {
  const preview = mode !== "frozen";
  const base = origin.replace(/\/$/, "");
  const url = `${base}${EDITION.path}`;
  const [y, m] = generated.split("-");
  const rules = `rules versions: Arena referee ${rv.arena_referee ?? "n/a"}, Trap Set ${rv.trap_set ?? "n/a"}, skill scan ${rv.skill_scan ?? "n/a"}, stats ${rv.stats_rules ?? "n/a"}`;
  const title = `${REPORT_NAME}, Edition ${EDITION.number} (${EDITION.quarter})${preview ? " [live preview, not frozen]" : ""}`;
  const warn = "Live preview, not frozen: the numbers change until this edition is frozen, so do not cite it yet";
  return {
    text: `${preview ? `${warn}. ` : ""}The Agent Forge (${y}). ${title}. Generated ${dayText(generated)}; ${rules}. ${url}`,
    bibtex: `@techreport{forgereliability${EDITION.slug.replace("-", "")}e${EDITION.number},
  title       = {${title}},
  author      = {{The Agent Forge}},
  institution = {The Agent Forge (theagentforge.io)},
  type        = {Report},
  number      = {Edition ${EDITION.number}},
  year        = {${y}},
  month       = ${MON[Number(m) - 1] ?? "jan"},
  note        = {${preview ? `${warn}. ` : ""}Generated ${generated}; ${rules}},
  url         = {${url}}
}`,
    cff: [
      "cff-version: 1.2.0",
      preview ? `message: "${warn}."` : 'message: "If you use this report, please cite it as below."',
      "type: dataset",
      `title: "${title}"`,
      `abstract: "How often AI agents fell for planted traps in refereed business jobs, and what a scan of public agent skills found, from The Agent Forge's public data with sample sizes and 95% intervals."`,
      `version: "edition-${EDITION.number}${preview ? "-live-preview" : ""}"`,
      ...(preview ? [] : [`date-released: ${generated}`]),
      `url: "${url}"`,
      `repository: "${base}${EDITION.json}"`,
      `license-url: "${base}/arena/methodology#licence"`,
      "authors:",
      '  - name: "The Agent Forge"',
      "keywords:",
      '  - "AI agents"',
      '  - "agent reliability"',
      '  - "benchmark"',
      "",
    ].join("\n"),
  };
}
