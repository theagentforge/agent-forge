import { Attempt, FINISH_TOOL } from "./engine";
import { money } from "./rng";
import { taskById } from "./tasks/index";
import type { AttemptResult, LogEvent } from "./types";

// The broadcast is drawn only from the referee's log (ADR 0013 §3). To show a progress bar of *verified*
// checkpoints, the log's tool calls are replayed in a fresh sandbox (same seed, so flaky failures repeat exactly)
// and the referee re-checks the state after every call. The replay must reproduce the logged outcome.

export interface Frame {
  /** Index in the log. */
  i: number;
  t: number;
  kind: "start" | "think" | "call" | "result" | "hit" | "spin" | "card" | "tapout" | "finish";
  label: string;
  detail: string | null;
  /** Share of checkpoint weight passed so far, re-checked by the referee (0–1). */
  progress: number;
  /** Stamina used so far against the caps (0–1 each). */
  stamina: { turns: number; toolCalls: number; tokens: number };
  hits: number;
  spins: number;
  card: "yellow" | "red" | null;
}

export interface Moment {
  frame: number;
  kind: "trap" | "foul" | "recovery" | "tapout" | "finish" | "knockout" | "hit";
  label: string;
}

const short = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Replays the log's calls and returns the referee's progress after each call (by call number). */
export function verifiedProgress(log: LogEvent[]): Map<number, number> {
  const start = log.find((e) => e.type === "start");
  const out = new Map<number, number>();
  if (!start || start.type !== "start") return out;
  const task = taskById(start.task);
  if (!task) return out;
  let t = 0;
  const a = new Attempt(task, start.seed, { caps: { ...start.caps, toolCalls: Number.MAX_SAFE_INTEGER }, now: () => t++ });
  const calls: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
  for (const e of log) {
    if (e.type !== "call" || e.name === FINISH_TOOL.name) continue;
    const r = a.call(e.name, e.args);
    calls.push({ name: e.name, args: e.args, ok: r.ok });
    const { checkpoints } = task.referee(a.variant, a.state, calls, null);
    const total = checkpoints.reduce((s, c) => s + c.weight, 0) || 1;
    out.set(e.n, checkpoints.reduce((s, c) => s + (c.passed ? c.weight : 0), 0) / total);
  }
  return out;
}

export function frames(log: LogEvent[]): Frame[] {
  const start = log.find((e) => e.type === "start");
  const caps = start?.type === "start" ? start.caps : { turns: 1, toolCalls: 1, tokens: 1, ms: 1 };
  const progress = verifiedProgress(log);
  const out: Frame[] = [];
  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;
  let hits = 0;
  let spins = 0;
  let p = 0;
  log.forEach((e, i) => {
    let kind: Frame["kind"] | null = null;
    let label = "";
    let detail: string | null = null;
    let card: Frame["card"] = null;
    switch (e.type) {
      case "start":
        kind = "start";
        label = "Bell";
        detail = e.brief;
        break;
      case "turn":
        turns++;
        tokens += e.tokensIn + e.tokensOut;
        kind = "think";
        label = `Turn ${e.n}`;
        detail = e.text ? short(e.text, 240) : null;
        break;
      case "call":
        if (e.name !== FINISH_TOOL.name) toolCalls++;
        kind = "call";
        label = e.name;
        detail = short(e.args);
        break;
      case "result":
        p = progress.get(e.n) ?? p;
        kind = "result";
        label = `${e.name} ✓`;
        detail = short(e.result);
        break;
      case "hit":
        hits++;
        p = progress.get(e.n) ?? p;
        kind = "hit";
        label = `${e.name} failed${e.status ? ` (${e.status})` : ""}`;
        detail = e.error;
        break;
      case "spin":
        spins++;
        kind = "spin";
        label = `Spinning wheels: ${e.name} ×${e.count}`;
        break;
      case "card":
        kind = "card";
        card = e.color;
        label = `${e.color === "red" ? "Red" : "Yellow"} card`;
        detail = e.reason;
        break;
      case "tapout":
        kind = "tapout";
        label = e.honest ? "Honest tap-out" : "Tap-out";
        detail = e.summary;
        break;
      case "finish":
        kind = "finish";
        p = e.quality;
        label = e.passed ? "Passed" : e.reason.startsWith("knockout") ? "Knockout" : "Failed";
        detail = e.claim ? `Claimed: ${e.claim.status === "done" ? "done" : "can't be done"}. “${short(e.claim.summary, 200)}”` : "No claim (ran out)";
        break;
      default:
        break;
    }
    if (!kind) return;
    out.push({
      i,
      t: e.t,
      kind,
      label,
      detail,
      progress: Math.round(p * 100) / 100,
      stamina: { turns: Math.min(1, turns / caps.turns), toolCalls: Math.min(1, toolCalls / caps.toolCalls), tokens: Math.min(1, tokens / caps.tokens) },
      hits,
      spins,
      card,
    });
  });
  return out;
}

/** Key-moment chapters: trap caught or fallen for, fouls, recovery after a hit, tap-out, finish. */
export function moments(log: LogEvent[], fs = frames(log)): Moment[] {
  const out: Moment[] = [];
  const failed = new Set<string>();
  fs.forEach((f, idx) => {
    const e = log[f.i]!;
    if (e.type === "hit" && !failed.has(e.name)) {
      failed.add(e.name);
      out.push({ frame: idx, kind: "hit", label: `First failed call: ${e.name}` });
    }
    if (e.type === "result" && failed.has(e.name)) {
      failed.delete(e.name);
      out.push({ frame: idx, kind: "recovery", label: `Recovered: ${e.name} worked on retry` });
    }
    if (e.type === "card") out.push({ frame: idx, kind: "foul", label: `${e.color === "red" ? "Red" : "Yellow"} card: ${e.reason}` });
    if (e.type === "tapout") out.push({ frame: idx, kind: "tapout", label: e.honest ? "Honest tap-out" : "Tap-out" });
    if (e.type === "finish") out.push({ frame: idx, kind: e.reason.startsWith("knockout") ? "knockout" : "finish", label: f.label });
  });
  // Trap verdicts carry no frame of their own; they point at the finish frame.
  const fin = fs.findIndex((f) => f.kind === "finish");
  for (const e of log) if (e.type === "trap") out.push({ frame: fin, kind: "trap", label: `${e.triggered ? "Fell for" : "Avoided"}: ${e.label}` });
  return out;
}

/** Three plain lines built only from referee events (ADR 0014 §6). */
export function summaryLines(modelName: string, r: AttemptResult): [string, string, string] {
  const task = taskById(r.task);
  const fell = r.traps.filter((t) => t.triggered).map((t) => t.label.toLowerCase());
  const line1 = r.passed
    ? `${modelName} passed ${task?.title ?? r.task}${r.tapout ? " with an honest tap-out" : ""}, scoring ${Math.round(r.quality * 100)}% of checkpoints.`
    : r.reason.startsWith("knockout")
      ? `${modelName} was knocked out (${r.reason.replace("knockout_", "").replace("_", " ")} ran out) on ${task?.title ?? r.task}.`
      : `${modelName} failed ${task?.title ?? r.task}${fell.length ? `: ${fell.join("; ")}` : ""}.`;
  const line2 = `${r.toolCalls} tool calls, ${r.hits} failed${r.spins ? `, ${r.spins} spinning wheels` : ""}, ${r.turns} turns.`;
  const line3 = `${r.cards.length ? `${r.cards.map((c) => `${c.color} card`).join(", ")}. ` : ""}Cost ${r.cost < 0.01 ? `$${r.cost.toFixed(4)}` : money(Math.round(r.cost * 100))}, model time ${(r.modelMs / 1000).toFixed(1)} s.`;
  return [line1, line2, line3];
}

/** Playback length for a replay: the condensed cut gives every frame the same short beat. */
export const condensedSeconds = (fs: Frame[]) => Math.min(90, Math.max(20, fs.length * 2));
