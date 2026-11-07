import { CANARY, CANARY_GUID, HELDOUT_VERSION, publicTrapId, RULES_HISTORY, RULES_IN_FORCE } from "@forge/arena";
import { consistencyOf, diff95, MODEL_VARIANCE_NOTE, rate3, wilson95, type AuditResult } from "@forge/arena/audit";
import type { Db } from "../services/db";
import { contaminationStatus, eventWorlds, refereeAudit } from "./benchmark";
import { csvCell } from "./business";
import { dayText, disagreementStatuses, errorRecord, REFEREE_AUDIT, REFEREE_AUDIT_2, REFEREE_AUDIT_ADJUDICATIONS, trapHistory, validityGate, type DisagreementStatus, type ErrorEntry } from "./error-record";
import { LOWER_BOUND_TRAPS } from "./lower-bound-traps";
export { PASS_FAIL_FALL } from "./terms";
import { heldOutGap, weeklyPooledGap } from "./holdout";
import { finishedRuns } from "./views";

// The validity pack (ADR 0136): /benchmark/validity and its files. Four parts, every number from code: the referee
// audit (frozen file, re-runnable script), the contamination test (live public-vs-held-out pass rates, and the
// answer-key scan of the audit's replays), the error record (dated corrections, shown only with the audit) and the
// reproducibility kit (`pnpm forge:reproduce <run-id>`, with the 3-of-3 consistency figures for model variance).

export const VALIDITY_PATH = "/benchmark/validity";
export const VALIDITY_JSON_PATH = "/benchmark/validity.json";
export const AUDIT_FILE_PATH = "/benchmark/validity/referee-audit-1.json";
export const AUDIT_TRAPS_CSV_PATH = "/benchmark/validity/referee-audit-1-per-trap.csv";
export const AUDIT_DISAGREEMENTS_CSV_PATH = "/benchmark/validity/referee-audit-1-disagreements.csv";
export const AUDIT_2_FILE_PATH = "/benchmark/validity/referee-audit-2.json";
export const AUDIT_2_TRAPS_CSV_PATH = "/benchmark/validity/referee-audit-2-per-trap.csv";
export const AUDIT_2_DISAGREEMENTS_CSV_PATH = "/benchmark/validity/referee-audit-2-disagreements.csv";
export const ERROR_RECORD_JSON_PATH = "/benchmark/validity/error-record.json";
export const ERROR_RECORD_CSV_PATH = "/benchmark/validity/error-record.csv";
export const REPRODUCE_COMMAND = "pnpm forge:reproduce <run-id>";
export const AUDIT_COMMAND = "node scripts/referee-audit.mjs --out referee-audit.json";
export const PUBLIC_REPO = "https://github.com/theagentforge/agent-forge";

/** The tests that keep held-out seeds and answer keys away from models and published files. */
export const CONTAMINATION_CONTROLS = [
  { control: "held_out_seeds_never_published", how: "Runs on held-out seeds are never published one by one (no row, brief, log, replay or card); only aggregates are shown", enforced_by: "apps/forge/src/arena/views.ts notHeldOut(), tested in the private repo (held-out panel tests)" },
  { control: "held_out_seeds_not_in_public_code", how: "The public repo's copy of the private module has no seeds, so the public code holds an empty held-out panel", enforced_by: "scripts/public-export.mjs (EXCLUDE_PREFIXES packages/arena/src/private/)" },
  { control: "answer_key_never_in_a_tool_output", how: "Each job's answer key lives in its world state; no tool returns it", enforced_by: "packages/arena/test/tasks.test.ts and packages/arena/test/validity.test.ts (every public job version), plus the answer-key scan of the audit's replays below" },
  { control: "canary_on_every_published_file", how: `The canary GUID ${CANARY_GUID} is on every published Arena data file and replay page`, enforced_by: "apps/forge/test/benchmark-files.test.ts, apps/forge/test/benchmark-versions.test.ts" },
  { control: "frozen_trap_set_snapshots", how: "Each released Trap Set version is frozen byte for byte, so a later change can't quietly rewrite what was tested", enforced_by: "apps/forge/test/benchmark-versions.test.ts" },
] as const;

/** What "independent" means for the checker (diligence review, 7 Nov): its code, not its rules. */
export const CHECKER_INDEPENDENCE =
  "The checker is independent of the referee's code, not of the written rules: both were written from the same rules, so where a rule itself is ambiguous they can agree and both be wrong (see the claim-trap class review below).";


/** What the contamination comparison needs before it can show anything, with no promised date. */
export const CONTAMINATION_NEEDS =
  "To mean something it needs held-out runs on jobs models sometimes fail, such as the harder job families being added for the Trap Set; no date is set for those runs.";

/**
 * The claim-trap class review (ADR 0136 Amendment 1 §3), in words: why checker agreement can't vouch for the traps that
 * read the agent's own prose, and why their fall rates are shown as lower bounds. Its own figures are not published.
 */
export function claimReviewText(traps: readonly string[] = LOWER_BOUND_TRAPS) {
  const list = traps.join(" and ");
  return [
    `Agreement between the referee and the checker can't vouch for a trap whose evidence is the agent's own free-text messages: both read the same prose against the same written rule, so both can miss the same false claim. ${traps.length === 1 ? "One public trap works this way" : "These public traps work this way"}: ${list}. The other false-claim traps grade a structured field.`,
    `So the review read those traps' messages one by one: the audit agent (an AI model working with code, not a person) read every message in audit 2's runs that ${traps.length === 1 ? "this trap" : "these traps"} can turn on and found no false claim the referee missed. Then a set of test sentences, labelled from the written rules before any reader ran, showed that phrasings the rule doesn't cover (other languages, typos, euphemisms, reported speech) can be misread by the referee and the checker alike, in the same way.`,
    `That is why the published fall rates of ${list} are shown as "at least": the true rate may be higher. The review's own figures are not yet published.`,
  ];
}

/** One audit's reproduce check, split by why each run differs, so a reader can find each one in the error record. */
export function reproduceBreakdown(audit: AuditResult) {
  const rc = audit.reproduce_check;
  const changed = new Set(rc.worlds_not_identical.map((w) => w.run));
  const disagreed = new Set(audit.disagreements.map((d) => d.run));
  const pick = (f: (run: string) => boolean) => rc.referee_rerun_differs.filter((v) => f(v.run)).map((v) => ({ run: v.run, task: v.task }));
  return {
    audit_id: audit.audit_id,
    runs: rc.runs,
    worlds_identical: rc.world_and_tool_outputs_identical,
    /** The job's code changed after the run was played, so its world can't be rebuilt exactly. */
    worlds_differ_job_code_changed: rc.worlds_not_identical.map((w) => ({ run: w.run, task: w.task })),
    verdicts_identical: rc.referee_rerun_identical_verdict,
    verdicts_differ: {
      /** Runs the audit lists as disagreements: today's referee gives the corrected verdict. */
      audit_disagreements: pick((r) => disagreed.has(r)),
      job_code_changed: pick((r) => !disagreed.has(r) && changed.has(r)),
      /** A checkpoint scores differently today with no change to the job's world: not yet explained. */
      not_yet_explained: pick((r) => !disagreed.has(r) && !changed.has(r)),
    },
  };
}

const n0 = (x: number) => x.toLocaleString("en-US");

/**
 * The census headline (referee audit 2), from its own figures: every public ranked replay re-graded, how many verdicts
 * agreed, whether its disagreements are the ones audit 1 found and where they stand, and its re-run under later rules.
 */
export function censusHeadline(census: AuditResult = REFEREE_AUDIT_2, sample: AuditResult = REFEREE_AUDIT, statuses: readonly DisagreementStatus[] = disagreementStatuses(census, REFEREE_AUDIT_ADJUDICATIONS)) {
  const o = census.overall;
  const pct = (x: number | null) => (x === null ? "not measured" : `${(x * 100).toFixed(1)}%`);
  const ci = o.ci_95 ? `${pct(o.ci_95[0])}–${pct(o.ci_95[1])}` : "";
  const key = (d: { run: string; trap: string }) => `${d.run}/${d.trap}`;
  const known = new Set(sample.disagreements.map(key));
  const k = census.disagreements.length;
  const fresh = census.disagreements.filter((d) => !known.has(key(d))).length;
  const sampleNo = sample.audit_id.replace("referee-audit-", "");
  const parts = [
    `Referee audit ${census.audit_id.replace("referee-audit-", "")} (${dayText(census.date)}) re-graded every public ranked replay on that day, ${n0(census.frame.runs)} runs and not a sample, with the same independent checker: it agreed with the published referee verdict on ${n0(o.agree)} of ${n0(o.n)} trap verdicts (${pct(o.agreement)}; 95% interval ${ci}).`,
  ];
  const done = statuses.filter((s) => s.status_now === "fixed_and_rescored");
  const status = !k
    ? ""
    : done.length === k
      ? ` ${k === 1 ? "It is" : "All are"} now fixed, and the published verdict${k === 1 ? " was" : "s were"} re-scored from the signed log${k === 1 ? "" : "s"} ${[...new Set(done.map((s) => `on ${dayText(s.rescored!.date)} (correction ${s.rescored!.correction})`))].join(" and ")}.`
      : ` ${done.length} of the ${k} are now fixed and re-scored; ${k - done.length} are not yet.`;
  if (!k) parts.push("It found no disagreement.");
  else if (!fresh) parts.push(`Its only ${k === 1 ? "disagreement is the one" : `${k} disagreements are the ${k}`} that audit ${sampleNo} found, where the published verdict was wrong.${status}`);
  else parts.push(`It found ${k} disagreement${k === 1 ? "" : "s"}, ${fresh} of them not in audit ${sampleNo}.${status}`);
  const under = (census as AuditResult & { referee_under_rules?: Record<string, { n: number; agree: number }> }).referee_under_rules ?? {};
  for (const [rules, r] of Object.entries(under)) {
    const since = rules === RULES_IN_FORCE ? RULES_HISTORY.find((x) => x.version === rules)?.date : undefined;
    parts.push(`Re-run under ${rules}${since ? `, the rules in force since ${dayText(since)}` : ""}, the referee agreed with the checker on ${n0(r.agree)} of ${n0(r.n)}.`);
  }
  return parts.join(" ");
}

/** Pools the per-event public-vs-held-out rows into one comparison (both sides summed). */
export function pooledGap(rows: readonly { public: { attempts: number; passes: number }; held_out: { attempts: number; passes: number } }[]) {
  const pub = rows.reduce((t, r) => ({ n: t.n + r.public.attempts, k: t.k + r.public.passes }), { n: 0, k: 0 });
  const held = rows.reduce((t, r) => ({ n: t.n + r.held_out.attempts, k: t.k + r.held_out.passes }), { n: 0, k: 0 });
  const atCeiling = pub.n > 0 && held.n > 0 && pub.k === pub.n && held.k === held.n;
  return {
    rows: rows.length,
    public: { attempts: pub.n, passes: pub.k, pass_rate: rate3(pub.k, pub.n), ci_95: wilson95(pub.k, pub.n) },
    held_out: { attempts: held.n, passes: held.k, pass_rate: rate3(held.k, held.n), ci_95: wilson95(held.k, held.n) },
    difference: pub.n && held.n ? Math.round((pub.k / pub.n - held.k / held.n) * 1000) / 1000 : null,
    difference_ci_95: diff95(pub.k, pub.n, held.k, held.n),
    at_ceiling: atCeiling,
    reading: !pub.n || !held.n ? "not_yet_measured" : atCeiling ? "both_sides_pass_every_attempt_so_this_comparison_cannot_show_a_difference" : "compare_the_interval_with_zero",
  };
}

/** The headline sentences of the page, from the audit. Shown word for word; Dinike approves them before release. */
export function headlines(
  audit: AuditResult,
  human: { status: string; agreement: number | null; n: number | null } = { status: "not_yet_published", agreement: null, n: null },
  statuses: readonly DisagreementStatus[] = disagreementStatuses(audit),
) {
  const o = audit.overall;
  const pct = (x: number | null) => (x === null ? "not measured" : `${(x * 100).toFixed(1)}%`);
  const ci = o.ci_95 ? `${pct(o.ci_95[0])}–${pct(o.ci_95[1])}` : "";
  const a = audit.adjudicated;
  const wrong = a.referee_wrong_open + a.referee_wrong_fixed_later;
  return [
    `At the time of the audit (${dayText(audit.date)}), an independent checker agreed with the published referee verdict on ${o.agree} of ${o.n} trap verdicts (${pct(o.agreement)}; 95% interval ${ci}), in a sample of ${audit.sample.runs} of the ${audit.frame.runs} public ranked replays (all ${audit.sample.runs_with_a_sprung_trap} where the referee marked a trap sprung, plus ${audit.sample.random_runs} drawn at random).`,
    `Every one of the ${audit.disagreements.length} disagreements in that audit was read in its log: in ${wrong} the published verdict was wrong, and in ${a.checker_wrong} the checker was wrong. ${statusSentence(statuses, wrong)}`,
    human.status === "measured" ? `This audit re-grades trap verdicts by code; in the separate human re-grade (Lab #6), people agreed with the referee on ${pct(human.agreement)} of ${human.n} attempts.` : `This audit re-grades trap verdicts by code, not by people; the separate human re-grade (Lab #6) is not yet published.`,
  ];
}

/** Where the wrong published verdicts stand today, from the adjudications and the published corrections. */
function statusSentence(statuses: readonly DisagreementStatus[], wrong: number) {
  if (!wrong) return "No published verdict needed a fix.";
  const done = statuses.filter((s) => s.status_now === "fixed_and_rescored");
  const later = statuses.filter((s) => s.status_now === "fixed_in_later_rules").length;
  const open = statuses.filter((s) => s.status_now === "open").length;
  const count = (xs: readonly DisagreementStatus[], key: (s: DisagreementStatus) => string) => {
    const m = new Map<string, number>();
    for (const s of xs) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
    return [...m];
  };
  const parts: string[] = [];
  if (done.length) {
    const rules = count(done, (s) => s.fixed_by ?? "later rules").sort(([x], [y]) => x.localeCompare(y, "en", { numeric: true })).map(([r, n]) => `${n} by ${r}`).join(", ");
    const when = count(done, (s) => `on ${dayText(s.rescored!.date)} (correction ${s.rescored!.correction})`).map(([w]) => w).join(" and ");
    parts.push(`${done.length === wrong ? `All ${wrong} are` : `${done.length} of the ${wrong} are`} now fixed (${rules}) and their published verdicts were re-scored from the signed logs ${when}.`);
  }
  if (later) parts.push(`${later} ${later === 1 ? "is" : "are"} fixed in later referee rules but not yet re-scored.`);
  if (open) parts.push(`${open} ${open === 1 ? "is" : "are"} still open.`);
  return parts.join(" ");
}

export async function validityData(db: Db, origin: string, audit: AuditResult | null = REFEREE_AUDIT, census2: AuditResult | null = REFEREE_AUDIT_2) {
  const gate = validityGate(audit);
  const links = {
    page: `${origin}${VALIDITY_PATH}`,
    json: `${origin}${VALIDITY_JSON_PATH}`,
    referee_audit: `${origin}${AUDIT_FILE_PATH}`,
    referee_audit_2: `${origin}${AUDIT_2_FILE_PATH}`,
    referee_audit_2_per_trap_csv: `${origin}${AUDIT_2_TRAPS_CSV_PATH}`,
    referee_audit_2_disagreements_csv: `${origin}${AUDIT_2_DISAGREEMENTS_CSV_PATH}`,
    referee_audit_per_trap_csv: `${origin}${AUDIT_TRAPS_CSV_PATH}`,
    referee_audit_disagreements_csv: `${origin}${AUDIT_DISAGREEMENTS_CSV_PATH}`,
    error_record_json: `${origin}${ERROR_RECORD_JSON_PATH}`,
    error_record_csv: `${origin}${ERROR_RECORD_CSV_PATH}`,
    trap_set: `${origin}/benchmark/v1.json`,
    held_out_contract: `${origin}/benchmark/held-out`,
    public_repo: PUBLIC_REPO,
  };
  // The gate: without a complete, resolved audit, nothing of the error record or the audit is shown.
  if (!gate.ok || !audit) return { canary: CANARY, status: "withheld" as const, why: gate.ok ? "no_referee_audit" : gate.why, links };

  const statuses = disagreementStatuses(audit);
  // Referee audit 2 (the census) leads the page once released (7 Nov); shown only when it passes the same gate.
  const census = census2 && validityGate(census2).ok ? census2 : null;
  const censusStatuses = census ? disagreementStatuses(census, REFEREE_AUDIT_ADJUDICATIONS) : [];
  const [record, gap, pooled, human, ranked] = await Promise.all([
    errorRecord(db, origin, audit),
    heldOutGap(db),
    weeklyPooledGap(db),
    refereeAudit(db),
    finishedRuns(db, { kinds: ["card", "guest"], hard: true }),
  ]);
  const contamination = contaminationStatus(gap, await eventWorlds(db, gap.filter((g) => g.status === "measured" && g.public_arm === "previously_published").map((g) => g.event)));
  const consistency = consistencyOf(
    ranked.map((r) => ({ model: r.summary.model, task: r.summary.task, seed: r.summary.seed, passed: r.summary.passed, traps: (r.result?.traps ?? []).filter((x) => x.triggered).map((x) => publicTrapId(r.summary.task, x.id) ?? x.id) })),
  );

  return {
    canary: CANARY,
    status: "published" as const,
    /** Audit 2 (every public ranked replay) first, then audit 1 (the first pass, on a sample, that found the errors). */
    headlines: [...(census ? [censusHeadline(census, audit, censusStatuses)] : []), ...headlines(audit, human, statuses)],
    referee_audit_2: census
      ? {
          audit_id: census.audit_id,
          date: census.date,
          what: census.what,
          method: census.method,
          frame: census.frame,
          sample: census.sample,
          overall: census.overall,
          run_level: census.run_level,
          referee_sprung: census.referee_sprung,
          checker_sprung: census.checker_sprung,
          referee_under_rules: (census as AuditResult & { referee_under_rules?: unknown }).referee_under_rules ?? null,
          adjudicated: census.adjudicated,
          disagreements_now: censusStatuses.map(({ note_at_audit: _a, note_now: _b, ...x }) => x),
          same_disagreements_as: census.disagreements.every((d) => audit.disagreements.some((x) => x.run === d.run && x.trap === d.trap)) ? audit.audit_id : null,
          per_public_trap: census.per_public_trap,
          checker_independence: CHECKER_INDEPENDENCE,
          files: { result: `${origin}${AUDIT_2_FILE_PATH}`, per_trap_csv: `${origin}${AUDIT_2_TRAPS_CSV_PATH}`, disagreements_csv: `${origin}${AUDIT_2_DISAGREEMENTS_CSV_PATH}` },
        }
      : null,
    claim_review: { traps_read_from_free_text: LOWER_BOUND_TRAPS, fall_rates_are_lower_bounds: true, figures_published: false },
    referee_audit: {
      audit_id: audit.audit_id,
      date: audit.date,
      what: audit.what,
      method: audit.method,
      frame: audit.frame,
      sample: audit.sample,
      overall: audit.overall,
      run_level: audit.run_level,
      referee_sprung: audit.referee_sprung,
      checker_sprung: audit.checker_sprung,
      adjudicated: audit.adjudicated,
      /** As frozen in the audit file: each resolution is the one given on the audit's date. */
      disagreements: audit.disagreements,
      /** Each disagreement's status today (the adjudications file and the published corrections); prose stays on the page. */
      disagreements_now: statuses.map(({ note_at_audit: _a, note_now: _b, ...x }) => x),
      per_public_trap: audit.per_public_trap,
      rerun: AUDIT_COMMAND,
      human_regrade: { study: human.study, status: human.status, agreement: human.agreement, n: human.n },
    },
    contamination: {
      held_out_panel: HELDOUT_VERSION,
      public_vs_held_out: { pooled_ranked_events: pooledGap(gap), per_event: gap, weekly_pooled: pooled, status: contamination },
      answer_key_scan: audit.answer_key_scan,
      controls: CONTAMINATION_CONTROLS,
    },
    error_record: { entries: record.entries, disputes: record.disputes, shown_with: { audit_id: audit.audit_id, agreement: audit.overall.agreement, n: audit.overall.n, sample_runs: audit.sample.runs } },
    reproducibility: {
      command: REPRODUCE_COMMAND,
      works_from: `a fresh clone of ${PUBLIC_REPO} with Node 22.7 or later; nothing to install`,
      checks: ["world and every tool output rebuilt from task version and seed, byte for byte against the replay", "the open referee re-run on the recorded trace gives the identical verdict", "the hash chain and Ed25519 signature (replay format v2)"],
      audit_sample: audit.reproduce_check,
      /** Each audit's reproduce check, split by why each run differs (the error record has an entry for each run). */
      differences: [...(census ? [reproduceBreakdown(census)] : []), reproduceBreakdown(audit)],
      model_variance: { statement: MODEL_VARIANCE_NOTE, three_of_three: consistency, source: "every published ranked attempt, grouped by model, job and seed" },
    },
    links,
  };
}

export type ValidityData = Awaited<ReturnType<typeof validityData>>;

export function perTrapCsv(audit: AuditResult) {
  const head = "audit_id,task,trap,public_trap_id,verdicts,agree,agreement,ci_low,ci_high,referee_sprung,checker_sprung,kappa,canary";
  const rows = audit.per_job_trap.map((r) => [audit.audit_id, r.task, r.trap, r.public_trap_id, r.n, r.agree, r.agreement, r.ci_95?.[0], r.ci_95?.[1], r.both + r.only_referee, r.both + r.only_checker, r.kappa, CANARY].map(csvCell).join(","));
  return `${[head, ...rows].join("\n")}\n`;
}

export function disagreementsCsv(audit: AuditResult, statuses: readonly DisagreementStatus[] = disagreementStatuses(audit)) {
  const head = "audit_id,run,replay_url,task,trap,public_trap_id,published,checker,current_referee,outcome_at_audit,note_at_audit,status_now,fixed_by,rescored_on,correction,note_now,canary";
  const rows = audit.disagreements.map((d) => {
    const s = statuses.find((x) => x.run === d.run && x.trap === d.trap);
    return [audit.audit_id, d.run, d.replay_url, d.task, d.trap, d.public_trap_id, d.published, d.checker, d.current_referee, d.resolution?.outcome, d.resolution?.note, s?.status_now, s?.fixed_by, s?.rescored?.date, s?.rescored?.correction, s?.note_now, CANARY].map(csvCell).join(",");
  });
  return `${[head, ...rows].join("\n")}\n`;
}

export function errorRecordCsv(entries: readonly ErrorEntry[], audit: AuditResult) {
  const head = "date,kind,status,title,what,traps,runs,source,shown_with_audit,audit_agreement,audit_verdicts";
  const rows = entries.map((e) => [e.date, e.kind, e.status, e.title, e.what, e.traps.join(";"), e.runs.join(";"), e.source, audit.audit_id, audit.overall.agreement, audit.overall.n].map(csvCell).join(","));
  return `${[head, ...rows].join("\n")}\n`;
}

export { trapHistory };
