import { CANARY, RULES_HISTORY } from "@forge/arena";
import type { AuditResult } from "@forge/arena/audit";
import { REFEREE_VALIDITY_SNAPSHOTS, type ResearchSnapshot } from "../seed/research";
import { CORRECTIONS, type Correction } from "./corrections";
import { dayText, disagreementStatuses, REFEREE_AUDIT_2, REFEREE_AUDIT_ADJUDICATIONS, RULES_TRAPS } from "./error-record";
import { LOWER_BOUND_TRAPS } from "./lower-bound-traps";
import { AUDIT_2_DISAGREEMENTS_CSV_PATH, AUDIT_2_FILE_PATH, AUDIT_2_TRAPS_CSV_PATH, CHECKER_INDEPENDENCE, PUBLIC_REPO, REPRODUCE_COMMAND, VALIDITY_PATH } from "./validity";
import { validityReleased } from "../web/validity-switch";

// The referee-validity research artefact (ADR 0149): the referee audit published as a citable, versioned report at
// /research/referee-validity/v<n>. Each version is built once by `buildRefereeValidity` from the frozen audit file,
// its adjudications and the published corrections, frozen as text in src/seed/research/ (sha256 pinned in the
// registry), and from then on served byte for byte: never recomputed, never edited. A new audit makes a new version.
// Only already-published material goes in: the census frame holds public runs only (public seeds, no held event, no
// embargoed model, no private job), and the claim-trap review's own figures stay out.

export const RESEARCH_VALIDITY_PATH = "/research/referee-validity";
export const RESEARCH_VALIDITY_JSON_PATH = `${RESEARCH_VALIDITY_PATH}.json`;
export const RESEARCH_FORMAT = "forge-referee-validity/1";
export const RESEARCH_TITLE = "Referee validity of The Forge Trap Set";
export const RESEARCH_SUBTITLE = "an independent re-grade of every public ranked replay";

export const versionPath = (v: number) => `${RESEARCH_VALIDITY_PATH}/v${v}`;
export const versionJsonPath = (v: number) => `${versionPath(v)}.json`;
export const versionCffPath = (v: number) => `${versionPath(v)}/CITATION.cff`;

/** The audit command that re-grades exactly the runs of a frozen audit file from the public endpoints. */
export const RERUN_COMMAND = "node scripts/referee-audit.mjs --census --runs-from apps/forge/src/seed/validity/referee-audit-2.json --cache .audit-cache --out audit.json";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "not measured" : `${(x * 100).toFixed(1)}%`);
const ci = (c: readonly [number, number] | null | undefined) => (c ? `${pct(c[0])}–${pct(c[1])}` : "no interval");
const n0 = (x: number) => x.toLocaleString("en-US");
const said = (sprung: boolean | null | undefined) => (sprung ? "sprung" : "not_sprung");

/** The suggested citation line, from a version's own fields. */
export const citationLine = (s: { version: number; date: string; url: string }) =>
  `The Agent Forge (${s.date.slice(0, 4)}). ${RESEARCH_TITLE}: ${RESEARCH_SUBTITLE}. Version ${s.version}, ${dayText(s.date)}. ${s.url}`;

/** CITATION.cff (Citation File Format 1.2.0) for one version. */
export function citationCff(s: { version: number; date: string; url: string; json_url: string; abstract: string }) {
  const q = (x: string) => JSON.stringify(x);
  return [
    "cff-version: 1.2.0",
    `message: ${q("If you use this report, please cite it as below.")}`,
    "type: dataset",
    `title: ${q(`${RESEARCH_TITLE}: ${RESEARCH_SUBTITLE}`)}`,
    `abstract: ${q(s.abstract)}`,
    `version: ${q(String(s.version))}`,
    `date-released: ${s.date}`,
    `url: ${q(s.url)}`,
    `repository: ${q(s.json_url)}`,
    `repository-code: ${q(PUBLIC_REPO)}`,
    "authors:",
    `  - name: ${q("The Agent Forge")}`,
    "keywords:",
    ...["AI agents", "benchmark validity", "referee audit", "agent safety", "evaluation"].map((k) => `  - ${q(k)}`),
    "",
  ].join("\n");
}

/** The summary sentences, from the audit's own figures and today's disagreement statuses. */
function summary(audit: AuditResult, statuses: ReturnType<typeof disagreementStatuses>) {
  const o = audit.overall;
  const w = audit.adjudicated.published_verdicts_found_wrong;
  const traps = [...new Set(audit.disagreements.map((d) => d.public_trap_id ?? `${d.task}/${d.trap}`))];
  const done = statuses.filter((s) => s.status_now === "fixed_and_rescored");
  const out = [
    `On ${dayText(audit.date)} an independent checker re-graded every public ranked replay of The Forge Trap Set (${n0(audit.frame.runs)} runs across ${audit.sample.job_versions} job versions, ${n0(o.n)} trap verdicts, no sampling) and agreed with the published referee verdict on ${n0(o.agree)} (${pct(o.agreement)}; 95% interval ${ci(o.ci_95)}; Cohen's kappa ${o.kappa ?? "n/a"}).`,
    `Each of the ${audit.disagreements.length} disagreements was read in its log. In ${w.k} the published verdict was wrong: a published error rate of ${w.k} in ${n0(w.n)} trap verdicts (${pct(w.rate)}; 95% interval ${ci(w.ci_95)}), all on ${traps.length === 1 ? "one trap" : `${traps.length} traps`}, ${traps.join(", ")}.`,
  ];
  if (done.length) out.push(`${done.length === statuses.length ? `All ${done.length} were` : `${done.length} of ${statuses.length} were`} fixed and re-scored from the signed logs ${[...new Set(done.map((s) => `on ${dayText(s.rescored!.date)} (correction ${s.rescored!.correction})`))].join(" and ")}.`);
  out.push(CHECKER_INDEPENDENCE.replace(" (see the claim-trap class review below)", ""));
  return out;
}

/** The dated corrections up to the version's date: referee rules changes that touched traps, and applied re-scores. */
function correctionHistory(origin: string, date: string, corrections: readonly Correction[]) {
  const rules = RULES_HISTORY.filter((r) => Object.hasOwn(RULES_TRAPS, r.version) && r.date <= date).map((r) => ({
    date: r.date,
    kind: "rules_change" as const,
    id: r.version,
    what: r.change,
    traps: RULES_TRAPS[r.version] ?? [],
    source: `${origin}/benchmark/changelog`,
  }));
  const rescores = corrections
    .filter((c) => c.published && c.applied && c.counts && c.date <= date)
    .map((c) => ({ date: c.date, kind: "rescore_applied" as const, id: c.id, rules: c.rules, title: c.title, what: c.what, counts: c.counts, traps: RULES_TRAPS[c.rules] ?? [], source: `${origin}/results-policy#${c.id}` }));
  // Oldest first; on one day the rules change comes before the re-score that applied it.
  return [...rules, ...rescores].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "rules_change" ? -1 : 1));
}

/**
 * Builds a version of the report from the frozen audit file. Run once, when a version is frozen (docs/runbooks/
 * research-artefacts.md); the served version is the frozen text, never this function's output on a later day.
 */
export function buildRefereeValidity(o: { version: number; date: string; origin: string; audit?: AuditResult; auditFileSha256: string; corrections?: readonly Correction[] }) {
  const audit = o.audit ?? REFEREE_AUDIT_2;
  const corrections = o.corrections ?? CORRECTIONS;
  const statuses = disagreementStatuses(audit, REFEREE_AUDIT_ADJUDICATIONS, corrections);
  const url = `${o.origin}${versionPath(o.version)}`;
  const jsonUrl = `${o.origin}${versionJsonPath(o.version)}`;
  const s = summary(audit, statuses);
  const rc = audit.reproduce_check;
  const w = audit.adjudicated.published_verdicts_found_wrong;
  return {
    format: RESEARCH_FORMAT,
    canary: CANARY,
    id: "referee-validity",
    version: o.version,
    date: o.date,
    title: `${RESEARCH_TITLE}: ${RESEARCH_SUBTITLE}`,
    immutable: true,
    url,
    json_url: jsonUrl,
    citation: { text: citationLine({ version: o.version, date: o.date, url }), cff: `${o.origin}${versionCffPath(o.version)}` },
    snapshot_of: {
      audit_id: audit.audit_id,
      audit_date: audit.date,
      audit_file: `${o.origin}${AUDIT_2_FILE_PATH}`,
      /** sha256 of the audit file exactly as /benchmark/validity/referee-audit-2.json serves it. */
      audit_file_sha256: o.auditFileSha256,
      statuses_as_of: o.date,
    },
    summary: s,
    method: {
      what: audit.what,
      design: "census: every run in the frame re-graded, no sampling",
      checker: audit.method.checker,
      checker_commit: audit.method.checker_commit,
      world: audit.method.world,
      shared_with_referee: audit.method.shared_with_referee,
      not_shared_with_referee: audit.method.not_shared,
      independence: CHECKER_INDEPENDENCE.replace(" (see the claim-trap class review below)", ""),
      grading: audit.method.grading,
      scope: audit.method.scope,
      unit: audit.method.unit,
      intervals: audit.method.intervals,
      adjudication: "every disagreement read by hand in its signed log and given an outcome before publication; a disagreement is never tuned away by changing the checker",
      frontier_checker: {
        file: "packages/arena/src/audit/frontier-checkers.ts",
        added: "2026-11-08",
        in_this_version: false,
        why: `The Frontier jobs joined the ranked Trap Set with version 1.3 on ${dayText("2026-11-07")}, after this frame was read on ${dayText(audit.date)}, so no Frontier replay is in this version. Their independent checker (written from the Frontier handbooks' rule text, importing only types from checkers.ts) has no published figures yet; a later version of this report will include them.`,
      },
    },
    frame: {
      definition: audit.frame.definition,
      runs: audit.frame.runs,
      job_versions: audit.sample.job_versions,
      trap_verdicts: audit.overall.n,
      read_from: audit.frame.source,
      frame_sha256: audit.frame.sha256,
      runs_listed_in: `${o.origin}${AUDIT_2_FILE_PATH}`,
      left_out: ["runs on held-out seeds (only aggregates are ever published)", "held events", "embargoed models", "private jobs", "practice and unranked runs"],
    },
    results: {
      agreement: { n: audit.overall.n, agree: audit.overall.agree, rate: audit.overall.agreement, ci_95: audit.overall.ci_95, kappa: audit.overall.kappa },
      published_error_rate: { definition: "trap verdicts whose published value was found wrong on reading the log, over every trap verdict re-graded", wrong: w.k, n: w.n, rate: w.rate, ci_95: w.ci_95 },
      runs_with_every_verdict_identical: { runs: audit.run_level.runs, identical: audit.run_level.all_trap_verdicts_identical, rate: audit.run_level.agreement, ci_95: audit.run_level.ci_95 },
      referee_sprung_traps_the_checker_also_found: audit.referee_sprung,
      checker_sprung_traps_the_referee_also_marked: audit.checker_sprung,
      adjudicated_at_audit: { referee_wrong_open: audit.adjudicated.referee_wrong_open, referee_wrong_fixed_later: audit.adjudicated.referee_wrong_fixed_later, checker_wrong: audit.adjudicated.checker_wrong, ambiguous_rule: audit.adjudicated.ambiguous_rule, unresolved: audit.adjudicated.unresolved },
      referee_under_later_rules: (audit as AuditResult & { referee_under_rules?: Record<string, { n: number; agree: number; agreement: number | null; ci_95: [number, number] | null; note?: string }> }).referee_under_rules ?? {},
      answer_key_scan: audit.answer_key_scan,
      per_public_trap: audit.per_public_trap.map((r) => ({ public_trap_id: r.public_trap_id, n: r.n, agree: r.agree, agreement: r.agreement, ci_95: r.ci_95, kappa: r.kappa, lower_bound_trap: LOWER_BOUND_TRAPS.includes(r.public_trap_id) })),
    },
    disagreements: audit.disagreements.map((d) => {
      const st = statuses.find((x) => x.run === d.run && x.trap === d.trap)!;
      return {
        run: d.run,
        replay: d.replay_url,
        replay_json: `${d.replay_url}.json`,
        event: (d as { event?: string }).event ?? null,
        model: (d as { model?: string }).model ?? null,
        task: d.task,
        public_trap_id: d.public_trap_id,
        referee_published: said(d.published),
        checker: said(d.checker),
        referee_in_force_at_audit: said(d.current_referee),
        evidence: (d.resolution as { evidence?: unknown } | undefined)?.evidence ?? null,
        resolution_at_audit: d.resolution?.outcome ?? null,
        reading_at_audit: d.resolution?.note ?? null,
        /** The reading as it stands on the version's date (the adjudications file, kept current). */
        reading: st.note_now,
        fixed_by: st.fixed_by,
        status: { as_of: o.date, status: st.status_now, rescored: st.rescored ? { ...st.rescored, source: `${o.origin}/results-policy#${st.rescored.correction}` } : null },
      };
    }),
    correction_history: correctionHistory(o.origin, o.date, corrections),
    reproducibility: {
      from: `a fresh clone of ${PUBLIC_REPO} with Node 22.7 or later; nothing to install`,
      public_endpoints: [
        { what: "ranked events", url: `${o.origin}/arena/dataset.json` },
        { what: "each event's runs and the traps the referee marked", url: `${o.origin}/arena/events/<slug>.json` },
        { what: "each replay: signed log and result", url: `${o.origin}/arena/run/<run-id>.json` },
        { what: "the replay signing keys", url: `${o.origin}/.well-known/forge-keys.json` },
        { what: "the frozen audit result, with every run, its seed, its log sha256 and both verdicts", url: `${o.origin}${AUDIT_2_FILE_PATH}` },
        { what: "per trap (CSV)", url: `${o.origin}${AUDIT_2_TRAPS_CSV_PATH}` },
        { what: "disagreements (CSV)", url: `${o.origin}${AUDIT_2_DISAGREEMENTS_CSV_PATH}` },
      ],
      rerun_the_audit: RERUN_COMMAND,
      reproduce_one_replay: REPRODUCE_COMMAND,
      what_to_expect:
        "Each run's log sha256 and checker verdicts should match the audit file: the signed logs and the checker are unchanged. The published side has moved since the audit: the four wrong verdicts were re-scored on 6 Nov 2026, so today's published verdicts agree with the checker where the frozen file records the disagreements. The verdicts as published on the audit's day are the `published` values in the audit file.",
      reproduce_check_at_audit: {
        runs: rc.runs,
        worlds_and_tool_outputs_identical: rc.world_and_tool_outputs_identical,
        worlds_not_identical: rc.worlds_not_identical.map((x) => ({ run: x.run, task: x.task, why: "the job's code changed after the run was played" })),
        referee_rerun_identical_verdict: rc.referee_rerun_identical_verdict,
        referee_rerun_differs: rc.referee_rerun_differs.map((x) => ({ run: x.run, task: x.task, differences: x.differences.filter((y) => !y.startsWith("replayed event")) })),
      },
    },
    limitations: [
      CHECKER_INDEPENDENCE.replace(" (see the claim-trap class review below)", ""),
      `${LOWER_BOUND_TRAPS.join(" and ")} read the agent's own free-text messages. A review found phrasings both the referee and the checker can misread in the same way, so agreement can't vouch for these traps, and their published fall rates are lower bounds. That review's own figures are not published.`,
      "Trap verdicts only: task-completion checkpoints were not re-graded.",
      `Reproduce check: ${rc.runs - rc.world_and_tool_outputs_identical} of ${rc.runs} worlds could not be rebuilt exactly (their job's code changed after they ran); the referee re-run differed on ${rc.runs - rc.referee_rerun_identical_verdict}, of which ${rc.referee_rerun_differs.filter((x) => !audit.disagreements.some((d) => d.run === x.run) && !rc.worlds_not_identical.some((y) => y.run === x.run)).length} score a task-completion checkpoint differently with the same pass/fail, not yet explained.`,
      "Verdicts in the same run are not independent, so the true uncertainty is wider than the intervals shown.",
      "Re-graded by code, not by people. The separate human re-grade is not published.",
      "Runs on held-out seeds are not in the frame, so this version says nothing about them one by one.",
      "Frontier jobs were not yet ranked when the frame was read and are not in this version.",
      "Model outputs vary between attempts; this report checks the referee's reading of what was played, not how a model would play again.",
    ],
    versioning: `Version ${o.version} is frozen as published on ${dayText(o.date)} and is never recomputed or edited. Statuses are as of that day; later corrections go in the live error record (${o.origin}${VALIDITY_PATH}#error-record) and in the next version.`,
    links: { latest: `${o.origin}${RESEARCH_VALIDITY_PATH}`, validity_pack: `${o.origin}${VALIDITY_PATH}`, error_record: `${o.origin}${VALIDITY_PATH}#error-record`, dataset: `${o.origin}/dataset`, public_repo: PUBLIC_REPO },
  };
}

export type RefereeValidity = ReturnType<typeof buildRefereeValidity>;

/** The frozen versions, oldest first, each parsed from its frozen text. */
export function frozenVersions(snapshots: readonly ResearchSnapshot[] = REFEREE_VALIDITY_SNAPSHOTS): { snapshot: ResearchSnapshot; doc: RefereeValidity }[] {
  return [...snapshots].sort((a, b) => a.version - b.version).map((snapshot) => ({ snapshot, doc: JSON.parse(snapshot.text) as RefereeValidity }));
}

/** The index of every version (the latest page and its JSON). */
export function researchIndex(origin: string) {
  const versions = frozenVersions();
  const latest = versions.at(-1) ?? null;
  return {
    format: "forge-referee-validity-index/1",
    canary: CANARY,
    title: `${RESEARCH_TITLE}: ${RESEARCH_SUBTITLE}`,
    latest: latest ? { version: latest.doc.version, date: latest.doc.date, url: `${origin}${versionPath(latest.doc.version)}`, json: `${origin}${versionJsonPath(latest.doc.version)}`, citation: latest.doc.citation.text } : null,
    versions: versions.map(({ snapshot, doc }) => ({ version: doc.version, date: doc.date, audit_id: doc.snapshot_of.audit_id, url: `${origin}${versionPath(doc.version)}`, json: `${origin}${versionJsonPath(doc.version)}`, sha256: snapshot.sha256, cff: `${origin}${versionCffPath(doc.version)}` })),
    policy: "Each version is frozen when published and never recomputed; a new audit is a new version.",
  };
}

/**
 * 16 Nov review: the referee's verdicts were checked and the check is published (ADR 0149): the latest frozen version
 * of /research/referee-validity, in the report's own words, or null before release (VALIDITY_PUBLIC off). /security
 * and the home page's proof strip both read it, so the figure is the same on both.
 */
export function refereeValidity(env: { VALIDITY_PUBLIC?: string }, origin: string) {
  const latest = frozenVersions().at(-1);
  if (!validityReleased(env) || !latest) return null;
  const a = latest.doc.results.agreement;
  return { version: latest.doc.version, date: latest.doc.date, agree: a.agree, trap_verdicts: a.n, url: `${origin}${versionPath(latest.doc.version)}` };
}
