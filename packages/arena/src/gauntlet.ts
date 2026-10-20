import { Attempt, FINISH_TOOL } from "./engine";
import { taskById } from "./tasks/index";
import type { AttemptResult, CallRecord, LogEvent } from "./types";

// The Trap Gauntlet (ADR 0029): each corner of a duel as a run along a course, one tile per real tool call. Drawn
// only from the referee's log. The exact step where a trap went off comes from replaying the logged calls in a fresh
// sandbox (same seed) and re-running the referee after each call, as the broadcast does for verified progress.
// Model-written text (turn text, the finish summary) is never shown; tool names and arguments are, as in the feed.

export type StepKind = "look" | "act" | "other";

export interface GauntletStep {
  kind: StepKind;
  /** The call as shown in the terminal, e.g. `→ pay_invoice(id: "INV-3")`. */
  line: string;
  ok: boolean;
  /** HTTP-style status of a failed call, when the sandbox gave one. */
  status: number | null;
  /** On long bouts, neighbouring calls share one tile; this is how many (absent means 1). */
  count?: number;
}

/** Tiles on one course at most; longer bouts (Hard jobs make 40+ calls) group neighbouring calls. */
export const MAX_TILES = 12;

/**
 * Groups neighbouring calls so a long bout fits the course: the trap call and the careful corner's check keep their
 * own tile, and the calls before and after share the remaining tiles in proportion. A group is a "look" only if all
 * its calls are, "ok" only if all are, and shows its first call with "+N more".
 */
export function compressCourse(steps: GauntletStep[], trapAt: number | null, scanAt: number | null, max = MAX_TILES) {
  if (steps.length <= max) return { steps, trapAt, scanAt };
  const pivot = trapAt !== null && trapAt < steps.length ? trapAt : scanAt;
  const chunk = (from: number, to: number, tiles: number): GauntletStep[] => {
    const len = to - from;
    if (len <= 0) return [];
    const k = Math.max(1, Math.min(tiles, len));
    const out: GauntletStep[] = [];
    for (let c = 0; c < k; c++) {
      const a = from + Math.floor((c * len) / k);
      const b = from + Math.floor(((c + 1) * len) / k);
      const group = steps.slice(a, b);
      const n = group.length;
      out.push({
        kind: group.every((g) => g.kind === group[0]!.kind) ? group[0]!.kind : group.some((g) => g.kind === "act") ? "act" : "other",
        line: n > 1 ? `${group[0]!.line} +${n - 1} more` : group[0]!.line,
        ok: group.every((g) => g.ok),
        status: group.find((g) => !g.ok)?.status ?? null,
        ...(n > 1 ? { count: n } : {}),
      });
    }
    return out;
  };
  if (pivot === null) return { steps: chunk(0, steps.length, max), trapAt: trapAt === steps.length ? max : trapAt, scanAt };
  const before = pivot, after = steps.length - pivot - 1;
  const room = max - 1;
  let tb = before ? Math.max(1, Math.round((room * before) / (before + after))) : 0;
  if (after && tb >= room) tb = room - 1;
  const ta = room - tb;
  const head = chunk(0, pivot, tb);
  const tail = chunk(pivot + 1, steps.length, ta);
  const out = [...head, steps[pivot]!, ...tail];
  const at = head.length;
  return {
    steps: out,
    trapAt: trapAt === null ? null : trapAt === steps.length ? out.length : at,
    scanAt: scanAt === null ? null : at,
  };
}

export interface GauntletLane {
  id: string;
  model: string;
  name: string;
  house: number;
  steps: GauntletStep[];
  /** Index into `steps` where the shown trap went off; `steps.length` means at the finish (a false claim). */
  trapAt: number | null;
  /** Index into `steps` where this corner looked before passing the trap (a real read or check call). */
  scanAt: number | null;
  claim: "done" | "cannot_complete" | null;
  verdict: "PASS" | "FAIL" | "KO";
  fell: boolean;
  caught: boolean;
  /** For the terminal header: totals from the referee log. */
  turns: number;
  tokens: number;
  cost: number;
  provider: string | null;
  /** Wordle-style result line, e.g. "🟩🟩🟥🟩🕳️". */
  grid: string;
}

export interface Gauntlet {
  task: string;
  seed: number;
  /** The shown trap, in plain words, without the "Hidden trap:" prefix. */
  tell: string | null;
  lanes: [GauntletLane, GauntletLane];
}

const LOOK = /^(get|list|read|search|lookup|look_up|check|verify|find|view|fetch|inspect|open|show|query|describe|compare|validate|confirm)/i;
const ACT = /^(pay|send|refund|book|order|place|delete|remove|transfer|update|create|cancel|issue|approve|submit|reserve|purchase|buy|write|set|add|edit|move|archive|merge|post)/i;
export const stepKind = (name: string): StepKind => (LOOK.test(name) ? "look" : ACT.test(name) ? "act" : "other");

/** Replays the logged calls and returns, for each non-finish call in order, the set of traps triggered so far. */
export function trapsAfterEachCall(log: LogEvent[]): string[][] {
  const start = log.find((e) => e.type === "start");
  if (!start || start.type !== "start") return [];
  const task = taskById(start.task);
  if (!task) return [];
  let t = 0;
  const a = new Attempt(task, start.seed, { caps: { ...start.caps, toolCalls: Number.MAX_SAFE_INTEGER }, now: () => t++ });
  const calls: CallRecord[] = [];
  const out: string[][] = [];
  for (const e of log) {
    if (e.type !== "call" || e.name === FINISH_TOOL.name) continue;
    const r = a.call(e.name, e.args);
    calls.push({ name: e.name, args: e.args, ok: r.ok });
    out.push(task.referee(a.variant, a.state, calls, null).traps.filter((x) => x.triggered).map((x) => x.id));
  }
  return out;
}

const MAX_GRID = 12;

function grid(steps: GauntletStep[], trapAt: number | null, end: string): string {
  const cells = steps.map((s, i) => (i === trapAt ? "🟥" : s.ok ? "🟩" : "🟨"));
  // Long runs are squeezed by keeping the first, the trap step and the last few, so the trap always shows.
  let shown = cells;
  if (cells.length > MAX_GRID) {
    const keep = new Set<number>([0, 1, cells.length - 1, cells.length - 2, cells.length - 3]);
    if (trapAt !== null && trapAt < cells.length) [trapAt - 1, trapAt, trapAt + 1].forEach((i) => i >= 0 && i < cells.length && keep.add(i));
    for (let i = 0; keep.size < MAX_GRID && i < cells.length; i++) keep.add(Math.round((i * (cells.length - 1)) / (MAX_GRID - 1)));
    shown = [...keep].sort((x, y) => x - y).map((i) => cells[i]!);
  }
  return `${shown.join("")}${end}`;
}

type Run = { id: string; model: string; name: string; house: number; result: AttemptResult; log: LogEvent[]; verdict: "PASS" | "FAIL" | "KO"; fell: boolean; caught: boolean };

function lane(run: Run, trap: string | null, otherTrapFraction: number | null, callLine: (n: string, a: Record<string, unknown>) => string): GauntletLane {
  const steps: GauntletStep[] = [];
  const byN = new Map<number, GauntletStep>();
  let claim: GauntletLane["claim"] = null;
  let turns = 0;
  let tokens = 0;
  let cost = 0;
  let provider: string | null = null;
  for (const e of run.log) {
    if (e.type === "turn") {
      turns++;
      tokens += e.tokensIn + e.tokensOut;
      cost += e.cost;
      provider ??= e.provider;
    } else if (e.type === "call" && e.name !== FINISH_TOOL.name) {
      const s: GauntletStep = { kind: stepKind(e.name), line: callLine(e.name, e.args), ok: true, status: null };
      steps.push(s);
      byN.set(e.n, s);
    } else if (e.type === "hit") {
      const s = byN.get(e.n);
      if (s) [s.ok, s.status] = [false, e.status ?? null];
    } else if (e.type === "finish") claim = e.claim?.status ?? null;
  }
  // Where the shown trap went off: the first call after which the referee sees it triggered; else, if the result
  // says it triggered (a claim-time trap such as saying "paid" when it isn't), at the finish.
  let trapAt: number | null = null;
  if (trap && run.result.traps.some((t) => t.id === trap && t.triggered)) {
    const after = trapsAfterEachCall(run.log);
    const i = after.findIndex((ids) => ids.includes(trap));
    trapAt = i >= 0 ? i : steps.length;
  }
  // The careful corner's look at the trap: the last read/check call at or before the point where the trap sits on
  // the course (where the other corner fell, scaled to this run's length), or before its first action after that.
  let scanAt: number | null = null;
  if (trapAt === null && run.verdict === "PASS" && steps.length) {
    const pos = Math.min(steps.length - 1, Math.max(0, Math.round((otherTrapFraction ?? 0.55) * (steps.length - 1))));
    for (let i = pos; i >= 0 && scanAt === null; i--) if (steps[i]!.kind === "look") scanAt = i;
    if (scanAt === null) for (let i = pos; i < steps.length && scanAt === null; i++) if (steps[i]!.kind === "look") scanAt = i;
  }
  const end = run.verdict === "KO" ? "💤" : run.fell ? "🕳️" : run.verdict === "PASS" ? "🏁" : "❌";
  const shareGrid = grid(steps, trapAt, end);
  const course = compressCourse(steps, trapAt, scanAt);
  return {
    id: run.id,
    model: run.model,
    name: run.name,
    house: run.house,
    steps: course.steps,
    trapAt: course.trapAt,
    scanAt: course.scanAt,
    claim,
    verdict: run.verdict,
    fell: run.fell,
    caught: run.caught,
    turns,
    tokens,
    cost: Math.round(cost * 1e5) / 1e5,
    provider,
    grid: shareGrid,
  };
}

/** The course for one duel. `trap` is the trap the two corners handled differently (or the task's first). */
export function gauntletScript(
  a: Run,
  b: Run,
  trap: string | null,
  tell: string | null,
  callLine: (n: string, a: Record<string, unknown>) => string,
): Gauntlet {
  const start = a.log.find((e) => e.type === "start");
  // Lay the careful corner's trap tile where the other corner fell, so both reach it at the same moment.
  const first = (r: Run) => {
    const l = lane(r, trap, null, callLine);
    return l.trapAt === null ? null : l.trapAt / Math.max(1, l.steps.length);
  };
  const fa = first(a);
  const fb = first(b);
  return {
    task: a.result.task,
    seed: start?.type === "start" ? start.seed : 0,
    tell: tell ? tell.replace(/^Hidden trap: /, "") : null,
    lanes: [lane(a, trap, fb, callLine), lane(b, trap, fa, callLine)],
  };
}
