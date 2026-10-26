import { Attempt, stable } from "./engine";
import { twistById } from "./config";
import { attemptScore } from "./scorecard";
import { taskById } from "./tasks/index";
import { RULES_VERSION } from "./versions";
import type { AttemptResult, EndReason, LogEvent, TaskType } from "./types";

// Re-scoring (rules 0.5): a stored run's referee log replayed through the referee in force now. The world is rebuilt
// from (task, seed) and every logged model turn and tool call is applied again in its logged order, on a clock that
// reads each event's own logged time, under the caps the bout was played with (the `start` event). Only the referee's
// verdict can change; the signed log is never touched. Pure and deterministic: no D1, no network, no Date.now.

export interface StoredRun {
  task: string;
  seed: number;
  /** The event's twist id. Optional: the log's `start` event carries it too; if both are given they must agree. */
  twist?: string | null;
  /** `arena_runs.log`: the referee's JSON log (an array, or the JSON text as D1 stores it). */
  log: LogEvent[] | string;
  /** `arena_runs.result` (object or JSON text). The verdict before; falls back to the log's `finish` event. */
  result?: Partial<AttemptResult> | string | null;
  /** `arena_runs.passed`, if exported; it wins over `result.passed` for the verdict before. */
  passed?: boolean | number | null;
  /** `arena_runs.score`, if exported. */
  score?: number | null;
}

export interface Verdict {
  passed: boolean | null;
  reason: EndReason | null;
  quality: number | null;
  score: number | null;
}

export interface Flip {
  kind: "checkpoint" | "trap";
  id: string;
  label: string;
  /** Checkpoints: passed. Traps: triggered. Null when it wasn't in that verdict at all. */
  before: boolean | null;
  after: boolean | null;
}

export interface Rescore {
  rules: string;
  result: AttemptResult;
  /** The replayed log, for checking only. The stored, signed log stays as it is. */
  log: LogEvent[];
  /** The pass/fail verdict or the end reason differs from the stored one. */
  changed: boolean;
  before: Verdict;
  after: Verdict;
  /** Checkpoints and traps whose outcome differs between the two verdicts. */
  flips: Flip[];
  /**
   * The replay reproduced every logged `start`, `call`, `result`, `hit` and `spin` event exactly. False means the job's
   * world or tools changed since the bout (for example a Hard v3 run from before v3.1), so the model saw something
   * else and the new verdict can't simply replace the old one.
   */
  faithful: boolean;
  mismatch: string | null;
  /**
   * The stored log was a slim export: no `result` or `hit` events (tool outputs, the bulk of a log), and turn text may
   * be gone too. The verdict is the same, since only calls and turns drive the replay, but `faithful` then checks the
   * world, the calls and the spins only, not the tool outputs.
   */
  slim: boolean;
}

/** Events a faithful replay reproduces exactly (as `Attempt.resume` checks). */
const REPLAYED = new Set<LogEvent["type"]>(["start", "call", "result", "hit", "spin"]);
/** Events the referee writes when the attempt ends. */
const ENDING = new Set<LogEvent["type"]>(["checkpoint", "trap", "card", "tapout", "finish"]);

const parse = <T>(v: T | string): T => (typeof v === "string" ? (JSON.parse(v) as T) : v);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function rescore(run: StoredRun, opts: { task?: TaskType } = {}): Rescore {
  const stored = parse(run.log);
  if (!Array.isArray(stored) || !stored.length) throw new Error("The run has no log.");
  const start = stored[0]!;
  if (start.type !== "start") throw new Error("The log doesn't begin with a start event.");
  if (start.task !== run.task || start.seed !== run.seed) throw new Error(`The log is for ${start.task}/${start.seed}, not ${run.task}/${run.seed}.`);
  if (run.twist !== undefined && (run.twist ?? null) !== start.twist) throw new Error(`The log's twist (${start.twist}) isn't the run's (${run.twist}).`);
  const task = opts.task ?? taskById(run.task);
  if (!task || task.id !== run.task) throw new Error(`Unknown task ${run.task}.`);

  // The bout's own caps, already multiplied by its twist: the twist is passed by id only, so it isn't applied twice.
  const twist = start.twist ? { id: start.twist, label: twistById(start.twist)?.label ?? start.twist } : null;
  let clock = 0;
  const a = new Attempt(task, run.seed, { twist, caps: start.caps, now: () => clock });
  for (const e of stored) {
    if (a.done) break;
    if (e.type === "turn") {
      clock = e.t;
      const ko = a.recordTurn({
        tokensIn: e.tokensIn,
        tokensOut: e.tokensOut,
        cost: e.cost,
        latencyMs: e.latencyMs,
        provider: e.provider,
        text: e.text ?? null,
        cachedTokens: e.cachedTokens,
        cacheWriteTokens: e.cacheWriteTokens,
      });
      if (ko) a.end(ko);
    } else if (e.type === "call") {
      clock = e.t;
      a.call(e.name, e.args);
    }
  }
  const storedFinish = stored.findLast((e) => e.type === "finish");
  if (!a.done) {
    // Out of turns (the runner ends it between turns), or a stored reason a replay can't see.
    clock = stored.find((e) => ENDING.has(e.type))?.t ?? clock;
    a.end(storedFinish?.type === "finish" ? storedFinish.reason : "knockout_turns");
  }
  const result = json(a.result!);
  const log = json(a.log);

  const was = run.result ? parse(run.result) : null;
  const passedCol = run.passed === null || run.passed === undefined ? undefined : Boolean(run.passed);
  const fin = storedFinish?.type === "finish" ? storedFinish : null;
  const before: Verdict = {
    passed: passedCol ?? was?.passed ?? fin?.passed ?? null,
    reason: was?.reason ?? fin?.reason ?? null,
    quality: was?.quality ?? fin?.quality ?? null,
    score: run.score ?? null,
  };
  const after: Verdict = { passed: result.passed, reason: result.reason, quality: result.quality, score: attemptScore(result) };

  const slim = stored.some((e) => e.type === "call") && !stored.some((e) => e.type === "result" || e.type === "hit");
  const compared = slim ? new Set<LogEvent["type"]>(["start", "call", "spin"]) : REPLAYED;
  const replayed = (l: LogEvent[]) => l.filter((e) => compared.has(e.type)).map(({ t: _t, ...e }) => stable(e));
  const x = replayed(stored);
  const y = replayed(log);
  const at = x.findIndex((e, i) => e !== y[i]);
  const i = at === -1 && x.length !== y.length ? Math.min(x.length, y.length) : at;
  const mismatch = i === -1 ? null : `replayed event ${i + 1} differs: logged ${(x[i] ?? "nothing").slice(0, 160)}, replayed ${(y[i] ?? "nothing").slice(0, 160)}`;

  return {
    rules: RULES_VERSION,
    result,
    log,
    changed: before.passed !== after.passed || before.reason !== after.reason,
    before,
    after,
    flips: flips(was, stored, result),
    faithful: mismatch === null,
    mismatch,
    slim,
  };
}

/** One plain line on why a verdict changed, for the re-score list. */
export function rescoreWhy(r: Pick<Rescore, "before" | "after" | "flips" | "faithful">) {
  const parts: string[] = [];
  if (r.before.reason !== r.after.reason) parts.push(`ended ${r.after.reason} (was ${r.before.reason})`);
  for (const f of r.flips) {
    if (f.kind === "checkpoint") parts.push(`${f.after ? "now passes" : "now fails"}: ${f.label}`);
    else parts.push(`${f.after ? "trap now sprung" : "trap no longer sprung"}: ${f.label}`);
  }
  if (!r.faithful) parts.push("replay not faithful: the job's world or tools changed since this bout");
  return parts.join("; ") || "no change";
}

function flips(was: Partial<AttemptResult> | null, stored: LogEvent[], now: AttemptResult): Flip[] {
  // Before: the stored result's lists, or else the referee's own events in the stored log.
  const cps = was?.checkpoints ?? stored.flatMap((e) => (e.type === "checkpoint" ? [{ id: e.id, label: e.label, passed: e.passed }] : []));
  const trs = was?.traps ?? stored.flatMap((e) => (e.type === "trap" ? [{ id: e.id, label: e.label, triggered: e.triggered }] : []));
  const out: Flip[] = [];
  const diff = (kind: Flip["kind"], a: { id: string; label: string; v: boolean }[], b: { id: string; label: string; v: boolean }[]) => {
    const old = new Map(a.map((c) => [c.id, c]));
    const fresh = new Map(b.map((c) => [c.id, c]));
    for (const id of new Set([...old.keys(), ...fresh.keys()])) {
      const o = old.get(id);
      const n = fresh.get(id);
      if (o?.v !== n?.v) out.push({ kind, id, label: (n ?? o)!.label, before: o?.v ?? null, after: n?.v ?? null });
    }
  };
  diff("checkpoint", cps.map((c) => ({ id: c.id, label: c.label, v: c.passed })), now.checkpoints.map((c) => ({ id: c.id, label: c.label, v: c.passed })));
  diff("trap", trs.map((c) => ({ id: c.id, label: c.label, v: c.triggered })), now.traps.map((c) => ({ id: c.id, label: c.label, v: c.triggered })));
  return out;
}
