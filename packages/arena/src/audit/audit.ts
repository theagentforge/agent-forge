import { refereeCheck } from "../replay";
import { rescore } from "../rescore";
import { PRIVATE_CHECKERS } from "../private/index";
import { anyTaskById, taskUnderRules } from "../tasks/index";
import { publicTrapId } from "../traps";
import type { AttemptResult, LogEvent } from "../types";
import { checkerFor } from "./checkers";
import { drawSample, AUDIT_SEED_TEXT, RANDOM_PER_JOB, type FrameRow, type SampledRow } from "./sample";
import { kappa, rate3, wilson95 } from "./stats";
import { canonicalJson, rebuildWorld } from "./world";

// The referee audit (ADR 0136): the sampled public ranked replays re-graded by the independent end-state checker
// (./checkers), compared trap by trap with the published verdict. The current referee's re-score is computed only to
// help explain a disagreement (did the rules change since the run?); it is never part of the agreement figures.

export const AUDIT_FORMAT = "forge-referee-audit/1";

export interface AuditDoc {
  id: string;
  task: string;
  seed: number;
  log: LogEvent[];
  result: AttemptResult & { rescored?: unknown };
}

export interface Adjudication {
  run: string;
  trap: string;
  /** Who was right after reading the log: the published verdict, the checker, or a rules change explains it. */
  // Audit 2 adds `evidence`: the log act and sentence the verdict turns on, quoted from the public replay.
  outcome: "referee_right" | "checker_wrong" | "referee_wrong_open" | "referee_wrong_fixed_later" | "ambiguous_rule";
  note: string;
  evidence?: { act: string; to?: string; text: string };
  /** Audit 2: which prepared rules version (if any) would turn the published verdict into the checker's. */
  fixed_by?: string | null;
}

export interface Disagreement {
  run: string;
  replay_url: string;
  task: string;
  trap: string;
  public_trap_id: string | null;
  published: boolean;
  checker: boolean;
  current_referee: boolean | null;
  /** Audit 2 on: the run's model and event, from the frame (public fields of the replay). */
  model?: string | null;
  event?: string | null;
  /** Audit 2 on: the verdict a prepared, not-in-force rules version's referee gives (rules 0.7: ADR 0140). */
  referee_under_rules?: Record<string, boolean | null>;
  resolution: Adjudication | null;
}

interface Tally {
  n: number;
  agree: number;
  both: number;
  only_referee: number;
  only_checker: number;
  neither: number;
}
const tally = (): Tally => ({ n: 0, agree: 0, both: 0, only_referee: 0, only_checker: 0, neither: 0 });
const add = (t: Tally, ref: boolean, chk: boolean) => {
  t.n++;
  if (ref === chk) t.agree++;
  if (ref && chk) t.both++;
  else if (ref) t.only_referee++;
  else if (chk) t.only_checker++;
  else t.neither++;
};
const summary = (t: Tally) => ({
  ...t,
  agreement: rate3(t.agree, t.n),
  ci_95: wilson95(t.agree, t.n),
  kappa: kappa(t.both, t.only_referee, t.only_checker, t.neither),
});

export interface AuditOptions {
  origin: string;
  date: string;
  sha256Hex: (s: string) => string;
  frameSource: string;
  checkerCommit: string | null;
  adjudications?: Adjudication[];
  /** Audit 2 (ADR 0136 Amendment 1): the audit's id (default "referee-audit-1"). */
  auditId?: string;
  /** "sample" (audit 1: the stratified draw) or "census" (audit 2: every run in the frame). */
  design?: "sample" | "census";
  /** Rules versions prepared but not in force whose referee is also run on every replay (never in the agreement figures). */
  alsoUnderRules?: string[];
}

const byRun = (a: FrameRow, b: FrameRow) => (a.run < b.run ? -1 : a.run > b.run ? 1 : 0);

export function runAudit(frame: FrameRow[], docs: Map<string, AuditDoc>, o: AuditOptions) {
  const census = o.design === "census";
  const sample: SampledRow[] = census ? [...frame].sort(byRun).map((r) => ({ ...r, stratum: "census" as const })) : drawSample(frame);
  const meta = new Map(frame.map((f) => [f.run, f]));
  const under = new Map<string, Tally>((o.alsoUnderRules ?? []).map((r) => [r, tally()]));
  const overall = tally();
  const byTrap = new Map<string, Tally & { task: string; trap: string }>();
  const byPublic = new Map<string, Tally>();
  const byJob = new Map<string, Tally>();
  const sprungByReferee = tally();
  const runs: unknown[] = [];
  const disagreements: Disagreement[] = [];
  const notCovered: { run: string; task: string; why: string }[] = [];
  let runsIdentical = 0;
  let runsCompared = 0;
  let unfaithful = 0;
  const unfaithfulRuns: { run: string; task: string; at: number }[] = [];
  let sameVerdict = 0;
  const verdictDiffers: { run: string; task: string; differences: string[] }[] = [];
  // Contamination check: does any tool output the model saw, or the brief, carry the job's answer key?
  const keyScan = { replays: 0, tool_outputs: 0, outputs_with_a_key_field: 0, outputs_containing_the_answer_key: 0, briefs_containing_the_answer_key: 0 };
  const hasKeyProp = (v: unknown): boolean => (Array.isArray(v) ? v.some(hasKeyProp) : !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => k === "key" || hasKeyProp(x)));

  for (const s of sample) {
    const d = docs.get(s.run);
    if (!d) {
      notCovered.push({ run: s.run, task: s.task, why: "replay_not_available" });
      continue;
    }
    // A private job (a frontier held-out variant) is graded by its private checker (ADR 0143), on its own world.
    const check = checkerFor(d.task) ?? PRIVATE_CHECKERS[d.task] ?? null;
    if (!check) {
      notCovered.push({ run: s.run, task: s.task, why: "job_version_not_covered_by_checker" });
      continue;
    }
    const job = anyTaskById(d.task);
    const w = rebuildWorld(d.log, job ? { task: job } : {});
    const keyObj = (job?.make(d.seed).state as { key?: unknown } | undefined)?.key;
    // Jobs with no answer-key object (the Normal refund, weekend, flaky and impossible jobs) have nothing to match.
    const answer = keyObj === undefined ? null : JSON.stringify(keyObj);
    keyScan.replays++;
    if (answer && d.log[0]?.type === "start" && d.log[0].brief.includes(answer)) keyScan.briefs_containing_the_answer_key++;
    for (const e of d.log) {
      if (e.type !== "result" && e.type !== "hit") continue;
      keyScan.tool_outputs++;
      if (e.type === "result" && hasKeyProp(e.result)) keyScan.outputs_with_a_key_field++;
      if (answer && JSON.stringify(e).includes(answer)) keyScan.outputs_containing_the_answer_key++;
    }
    if (!w.faithful) {
      unfaithful++;
      unfaithfulRuns.push({ run: d.id, task: d.task, at: w.mismatch!.at });
    }
    // The reproduce check on every sampled run: the open referee on the recorded trace, against the published verdict.
    const rc = refereeCheck({ id: d.id, log: d.log, result: d.result });
    if (rc.checked && rc.same_verdict) sameVerdict++;
    else verdictDiffers.push({ run: d.id, task: d.task, differences: rc.differences.length ? rc.differences : [rc.why ?? "not checked"] });
    const mine = check({ task: d.task, start: w.start, final: w.final, calls: w.calls, claim: w.claim });
    let now: Map<string, boolean> | null = null;
    try {
      const r = rescore({ task: d.task, seed: d.seed, log: d.log, result: d.result });
      now = new Map(r.result.traps.map((t) => [t.id, t.triggered]));
    } catch {
      now = null;
    }
    const nowUnder = new Map<string, Map<string, boolean> | null>();
    for (const rules of under.keys()) {
      try {
        const task = taskUnderRules(d.task, rules);
        const r = rescore({ task: d.task, seed: d.seed, log: d.log, result: d.result }, task ? { task } : {});
        nowUnder.set(rules, new Map(r.result.traps.map((t) => [t.id, t.triggered])));
      } catch {
        nowUnder.set(rules, null);
      }
    }
    let same = true;
    const verdicts: { trap: string; published: boolean; checker: boolean }[] = [];
    for (const t of d.result.traps) {
      if (!(t.id in mine)) {
        notCovered.push({ run: s.run, task: d.task, why: `trap_${t.id}_not_covered` });
        same = false;
        continue;
      }
      const chk = mine[t.id]!;
      const key = `${d.task}/${t.id}`;
      const pid = publicTrapId(d.task, t.id);
      const bt = byTrap.get(key) ?? { ...tally(), task: d.task, trap: t.id };
      add(bt, t.triggered, chk);
      byTrap.set(key, bt);
      if (pid) {
        const bp = byPublic.get(pid) ?? tally();
        add(bp, t.triggered, chk);
        byPublic.set(pid, bp);
      }
      const bj = byJob.get(d.task) ?? tally();
      add(bj, t.triggered, chk);
      byJob.set(d.task, bj);
      add(overall, t.triggered, chk);
      for (const [rules, tl] of under) {
        const v = nowUnder.get(rules)?.get(t.id);
        if (v !== undefined) add(tl, v, chk);
      }
      if (t.triggered) add(sprungByReferee, true, chk);
      verdicts.push({ trap: t.id, published: t.triggered, checker: chk });
      if (t.triggered !== chk) {
        same = false;
        disagreements.push({
          run: d.id,
          replay_url: `${o.origin}/arena/run/${d.id}`,
          task: d.task,
          trap: t.id,
          public_trap_id: pid,
          published: t.triggered,
          checker: chk,
          current_referee: now?.get(t.id) ?? null,
          ...(census || under.size
            ? {
                model: meta.get(d.id)?.model ?? null,
                event: meta.get(d.id)?.event ?? null,
                referee_under_rules: Object.fromEntries([...under.keys()].map((rules) => [rules, nowUnder.get(rules)?.get(t.id) ?? null])),
              }
            : {}),
          resolution: o.adjudications?.find((a) => a.run === d.id && a.trap === t.id) ?? null,
        });
      }
    }
    runsCompared++;
    if (same) runsIdentical++;
    runs.push({ run: d.id, task: d.task, seed: d.seed, stratum: s.stratum, log_sha256: o.sha256Hex(canonicalJson(d.log)), world_faithful: w.faithful, verdicts });
  }

  return {
    format: AUDIT_FORMAT,
    audit_id: o.auditId ?? "referee-audit-1",
    date: o.date,
    what: census
      ? "An independent re-grade of every public ranked Arena replay: each run's trap verdicts recomputed by a separate end-state checker and compared with the published verdicts."
      : "An independent re-grade of a random, stratified sample of public ranked Arena replays: each sampled run's trap verdicts recomputed by a separate end-state checker and compared with the published verdicts.",
    method: {
      checker: "packages/arena/src/audit/checkers.ts (written from the Trap Set's written trap rules; imports no referee code)",
      checker_commit: o.checkerCommit,
      world: "packages/arena/src/audit/world.ts rebuilds each job's sandbox from task version and seed and applies the logged tool calls; it does not run the referee",
      shared_with_referee: ["the job's world generator and tool handlers", "the answer key inside the starting world"],
      not_shared: ["referee functions", "referee helpers and lie detectors", "the engine's Attempt class"],
      grading: "code only; no model or LLM grading",
      scope: "trap verdicts (what the published trap-fall rates count); task-completion checkpoints are not re-graded in this audit",
      unit: "one trap verdict in one run",
      intervals: "95% Wilson score intervals, bounds rounded outwards; verdicts in the same run are not independent, so true uncertainty is wider",
    },
    frame: { source: o.frameSource, definition: "every finished run of a ranked (card or guest) public event, public seeds only, no held event, no embargoed model, no private job", runs: frame.length, sha256: o.sha256Hex(canonicalJson([...frame].sort((a, b) => (a.run < b.run ? -1 : 1)).map((f) => ({ run: f.run, task: f.task, sprung: [...f.sprung].sort() })))) },
    sample: census
      ? {
          seed_text: null,
          random_per_job: null,
          design: "census: every run in the frame (no sampling)",
          runs: sample.length,
          runs_with_a_sprung_trap: sample.filter((s) => s.sprung.length > 0).length,
          random_runs: 0,
          job_versions: new Set(sample.map((s) => s.task)).size,
        }
      : {
      seed_text: AUDIT_SEED_TEXT,
      random_per_job: RANDOM_PER_JOB,
      design: "stratified by job version: every run with a referee-sprung trap, plus a seeded random draw of the rest",
      runs: sample.length,
      runs_with_a_sprung_trap: sample.filter((s) => s.stratum === "sprung_all").length,
      random_runs: sample.filter((s) => s.stratum === "random").length,
      job_versions: new Set(sample.map((s) => s.task)).size,
    },
    coverage: { runs_compared: runsCompared, trap_verdicts_compared: overall.n, not_covered: notCovered, worlds_not_reproduced_exactly: unfaithful },
    overall: summary(overall),
    run_level: { runs: runsCompared, all_trap_verdicts_identical: runsIdentical, agreement: rate3(runsIdentical, runsCompared), ci_95: wilson95(runsIdentical, runsCompared) },
    referee_sprung: { n: sprungByReferee.n, checker_agrees: sprungByReferee.agree, agreement: rate3(sprungByReferee.agree, sprungByReferee.n), ci_95: wilson95(sprungByReferee.agree, sprungByReferee.n) },
    checker_sprung: { n: overall.both + overall.only_checker, referee_agrees: overall.both, agreement: rate3(overall.both, overall.both + overall.only_checker), ci_95: wilson95(overall.both, overall.both + overall.only_checker) },
    ...(under.size ? { referee_under_rules: Object.fromEntries([...under].map(([rules, t]) => [rules, { note: "the prepared referee of a rules version not in force, re-run on every replay; not the published verdicts, not in the agreement figures", ...summary(t) }])) } : {}),
    per_public_trap: [...byPublic].sort((a, b) => a[0].localeCompare(b[0])).map(([id, t]) => ({ public_trap_id: id, ...summary(t) })),
    per_job_trap: [...byTrap.values()].sort((a, b) => `${a.task}/${a.trap}`.localeCompare(`${b.task}/${b.trap}`)).map((t) => ({ task: t.task, trap: t.trap, public_trap_id: publicTrapId(t.task, t.trap), ...summary(t) })),
    per_job: [...byJob].sort((a, b) => a[0].localeCompare(b[0])).map(([task, t]) => ({ task, ...summary(t) })),
    answer_key_scan: keyScan,
    reproduce_check: {
      runs: runsCompared,
      world_and_tool_outputs_identical: runsCompared - unfaithful,
      worlds_not_identical: unfaithfulRuns,
      referee_rerun_identical_verdict: sameVerdict,
      referee_rerun_differs: verdictDiffers,
    },
    adjudicated: (() => {
      const by = (k: Adjudication["outcome"]) => disagreements.filter((d) => d.resolution?.outcome === k).length;
      const wrong = by("referee_wrong_open") + by("referee_wrong_fixed_later");
      return {
        unresolved: disagreements.filter((d) => !d.resolution).length,
        referee_right: by("referee_right"),
        checker_wrong: by("checker_wrong"),
        referee_wrong_open: by("referee_wrong_open"),
        referee_wrong_fixed_later: by("referee_wrong_fixed_later"),
        ambiguous_rule: by("ambiguous_rule"),
        published_verdicts_found_wrong: { k: wrong, n: overall.n, rate: rate3(wrong, overall.n), ci_95: wilson95(wrong, overall.n) },
      };
    })(),
    disagreements,
    runs,
  };
}

export type AuditResult = ReturnType<typeof runAudit>;
