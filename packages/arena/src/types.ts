// Shared types for the Arena (code name Crucible; ADR 0012–0014). Everything here is pure and deterministic.

/** JSON Schema for a tool's arguments (the subset OpenAI-style function calling uses). */
export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>;
  required?: string[];
  additionalProperties?: false;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** What a tool handler returns: a result for the model, or an error (a "hit" on the broadcast). */
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string; status?: number };

export interface ToolContext<S> {
  state: S;
  /** Deterministic random number in [0, 1) for this attempt. */
  rand: () => number;
  /** How many times this tool has been called so far in the attempt (0 on the first call). */
  callIndex: number;
  /** Every call so far, for idempotency checks. */
  calls: { name: string; args: Record<string, unknown> }[];
}

export interface ToolDef<S> extends ToolSpec {
  /** Tools that only read state. Repeating them is cheap; repeating a write is what traps catch. */
  readOnly?: boolean;
  /** Planted trap shown to viewers in advance (ADR 0013 §3 "the trap icon shown in advance"). */
  trapHint?: string;
  run: (args: Record<string, unknown>, ctx: ToolContext<S>) => ToolOutcome;
}

export interface Checkpoint {
  id: string;
  label: string;
  /** Weight in the quality score. */
  weight: number;
  /** Every critical checkpoint must pass for the attempt to pass. */
  critical: boolean;
  passed: boolean;
}

export interface TrapResult {
  id: string;
  label: string;
  triggered: boolean;
}

/** The model's own claim, from its call to `finish`. Never used for scoring, only compared with the check. */
export interface FinishClaim {
  status: "done" | "cannot_complete";
  summary: string;
}

export interface TaskVariant<S> {
  /** Plain-English brief given to the model (the "task card" shown to viewers). */
  brief: string;
  state: S;
  /** True when the honest answer is to tap out (the task can't be done as asked). */
  impossible: boolean;
}

export interface TaskType<S = any> {
  id: string;
  title: string;
  /** Shown on the task card and in the Task Guide ("for tasks like this"). */
  summary: string;
  world: "shop" | "bank" | "airline" | "inbox" | "calendar" | "spreadsheet" | "travel";
  /** Plain-English names of planted traps, shown before the bout. */
  traps: { id: string; label: string }[];
  make: (seed: number) => TaskVariant<S>;
  tools: (variant: TaskVariant<S>) => ToolDef<S>[];
  referee: (variant: TaskVariant<S>, finalState: S, calls: CallRecord[], claim: FinishClaim | null) => { checkpoints: Checkpoint[]; traps: TrapResult[] };
  /** Hard jobs (ADR 0021) are longer, so they get their own stamina; twists still multiply it. */
  caps?: Caps;
  /** "hard": the harder tier built so frontier models can still fall for traps (ADR 0021). Default "normal". */
  tier?: "normal" | "hard";
}

export interface CallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

/** A twist of the week (ADR 0014 §5): applies equally to every model, announced before the bout. */
export interface Twist {
  id: string;
  label: string;
  /** Multiplies the attempt's caps. */
  caps?: Partial<Record<keyof Caps, number>>;
}

export interface Caps {
  /** Model turns (one model reply = one turn). */
  turns: number;
  toolCalls: number;
  /** Tokens in plus out across the attempt. */
  tokens: number;
  /** Wall-clock milliseconds. */
  ms: number;
}

/** One line of the referee's log. The broadcast draws only from these (ADR 0013 §3). */
export type LogEvent =
  | { t: number; type: "start"; task: string; seed: number; twist: string | null; caps: Caps; brief: string; traps: { id: string; label: string }[] }
  | { t: number; type: "turn"; n: number; tokensIn: number; tokensOut: number; cost: number; latencyMs: number; provider: string | null; text: string | null }
  | { t: number; type: "call"; n: number; name: string; args: Record<string, unknown> }
  | { t: number; type: "result"; n: number; name: string; ok: true; result: unknown }
  | { t: number; type: "hit"; n: number; name: string; ok: false; error: string; status?: number; repeat: boolean }
  | { t: number; type: "spin"; n: number; name: string; count: number }
  | { t: number; type: "checkpoint"; id: string; label: string; passed: boolean; critical: boolean }
  | { t: number; type: "trap"; id: string; label: string; triggered: boolean }
  | { t: number; type: "card"; color: "yellow" | "red"; reason: string; at: number | null }
  | { t: number; type: "tapout"; summary: string; honest: boolean }
  | { t: number; type: "finish"; claim: FinishClaim | null; reason: EndReason; passed: boolean; quality: number };

export type EndReason = "finished" | "knockout_turns" | "knockout_tool_calls" | "knockout_tokens" | "knockout_time" | "model_error" | "void";

/** The referee's verdict on one attempt. */
export interface AttemptResult {
  task: string;
  seed: number;
  twist: string | null;
  reason: EndReason;
  passed: boolean;
  quality: number;
  trapsAvoided: number;
  trapsTotal: number;
  /** Claim matches the check (done and passed, or cannot_complete on an impossible task). */
  honest: boolean;
  tapout: boolean;
  checkpoints: Checkpoint[];
  traps: TrapResult[];
  cards: { color: "yellow" | "red"; reason: string }[];
  turns: number;
  toolCalls: number;
  hits: number;
  spins: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  modelMs: number;
  wallMs: number;
}
