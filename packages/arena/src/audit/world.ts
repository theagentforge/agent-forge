import { rng, subSeed } from "../rng";
import { taskById } from "../tasks/index";
import type { LogEvent, TaskType, ToolDef } from "../types";

// The world rebuild (ADR 0136): a public job's sandbox rebuilt from (task, seed) and every logged tool call applied
// again in its logged order, WITHOUT the engine's Attempt class and without the referee. It mirrors the engine's
// documented tool contract (one random stream per attempt, a per-tool call index, the tool-call cap, spin events) so
// the rebuilt world events can be compared with the logged ones byte for byte (canonical JSON, timestamps aside).
//
// It is shared by the referee audit (which reads the final sandbox state, never the referee's verdict) and by
// `forge:reproduce` (which proves the world and every tool output match the replay). It never calls `task.referee`.

/** One call as the audit sees it: what was asked and whether the world accepted it. */
export interface WorldCall {
  n: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface WorldRebuild {
  task: string;
  seed: number;
  /** The starting world (the variant's state before any call). */
  start: unknown;
  /** The sandbox after every logged call. */
  final: unknown;
  calls: WorldCall[];
  claim: { status: "done" | "cannot_complete"; summary: string } | null;
  /** Every rebuilt start/call/result/hit/spin event equals the logged one (canonical JSON, without `t`). */
  faithful: boolean;
  /** The first differing event, 1-based, and both sides (cut to 200 characters each). */
  mismatch: { at: number; logged: string; rebuilt: string } | null;
  /** How many world events were compared, and whether tool outputs were in the log (a slim export has none). */
  compared: number;
  slim: boolean;
}

const WORLD_EVENTS = new Set(["start", "call", "result", "hit", "spin"]);
const SPIN_AT = 3;
const FINISH = "finish";

/** JSON with object keys sorted at every level (RFC 8785 for the values a replay holds). */
export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(walk).join(",")}]`;
    if (x && typeof x === "object") return `{${Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${walk((x as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(x ?? null);
  };
  return walk(JSON.parse(JSON.stringify(v ?? null)));
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function runTool<S>(tool: ToolDef<S> | undefined, name: string, args: Record<string, unknown>, ctx: Parameters<ToolDef<S>["run"]>[1]) {
  if (!tool) return { ok: false as const, error: `Unknown tool "${name}".`, status: 404 };
  try {
    return tool.run(args, ctx);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Tool failed.", status: 400 };
  }
}

/**
 * Rebuilds the world of a logged attempt. Throws when the job isn't public (its world isn't published) or the log
 * doesn't begin with a start event for this job.
 */
export function rebuildWorld(log: readonly LogEvent[], opts: { task?: TaskType } = {}): WorldRebuild {
  const start = log[0];
  if (!start || start.type !== "start") throw new Error("The log doesn't begin with a start event.");
  const task = opts.task ?? taskById(start.task);
  if (!task) throw new Error(`Job ${start.task} isn't a public job, so its world isn't published.`);
  const variant = task.make(start.seed);
  const state = structuredClone(variant.state) as unknown;
  const tools = new Map(task.tools(variant).map((t) => [t.name, t as ToolDef<unknown>]));
  const rand = rng(subSeed(start.seed, `${task.id}:tools`));
  const perTool = new Map<string, number>();
  const counts = new Map<string, number>();
  const ctxCalls: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
  const calls: WorldCall[] = [];
  const out: Record<string, unknown>[] = [
    { type: "start", task: task.id, seed: start.seed, twist: start.twist, caps: start.caps, brief: variant.brief, traps: task.traps },
  ];
  let claim: WorldRebuild["claim"] = null;
  let ended = false;
  for (const e of log) {
    if (ended) break;
    if (e.type !== "call") continue;
    const args = (e.args && typeof e.args === "object" && !Array.isArray(e.args) ? e.args : {}) as Record<string, unknown>;
    const n = ctxCalls.length + 1;
    out.push({ type: "call", n, name: e.name, args });
    if (e.name === FINISH) {
      claim = { status: args.status === "cannot_complete" ? "cannot_complete" : "done", summary: String(args.summary ?? "").slice(0, 500) };
      ctxCalls.push({ name: e.name, args, ok: true });
      calls.push({ n, name: e.name, args, ok: true });
      ended = true;
      break;
    }
    // The tool-call cap: the call that reaches it is logged, never run, and ends the attempt.
    if (ctxCalls.length >= start.caps.toolCalls) {
      ended = true;
      break;
    }
    const key = `${e.name}:${canonicalJson(args)}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const callIndex = perTool.get(e.name) ?? 0;
    perTool.set(e.name, callIndex + 1);
    if (count >= SPIN_AT) out.push({ type: "spin", n, name: e.name, count });
    const r = runTool(tools.get(e.name), e.name, args, { state, rand, callIndex, calls: ctxCalls });
    ctxCalls.push({ name: e.name, args, ok: r.ok });
    calls.push({ n, name: e.name, args: json(args), ok: r.ok });
    out.push(r.ok ? { type: "result", n, name: e.name, ok: true, result: r.result } : { type: "hit", n, name: e.name, ok: false, error: r.error, status: r.status, repeat: count > 1 });
  }
  const slim = log.some((e) => e.type === "call") && !log.some((e) => e.type === "result" || e.type === "hit");
  const keep = slim ? new Set(["start", "call", "spin"]) : WORLD_EVENTS;
  const strip = (e: Record<string, unknown>) => {
    const { t: _t, ...rest } = e;
    return canonicalJson(rest);
  };
  const logged = log.filter((e) => keep.has(e.type)).map((e) => strip(e as unknown as Record<string, unknown>));
  const rebuilt = out.filter((e) => keep.has(e.type as string)).map(strip);
  let at = logged.findIndex((x, i) => x !== rebuilt[i]);
  if (at === -1 && logged.length !== rebuilt.length) at = Math.min(logged.length, rebuilt.length);
  return {
    task: task.id,
    seed: start.seed,
    start: json(variant.state),
    final: json(state),
    calls,
    claim,
    faithful: at === -1,
    mismatch: at === -1 ? null : { at: at + 1, logged: (logged[at] ?? "nothing").slice(0, 200), rebuilt: (rebuilt[at] ?? "nothing").slice(0, 200) },
    compared: logged.length,
    slim,
  };
}
