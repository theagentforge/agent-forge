import { LOOP_MIN_FAILURES, STRAIN_CAPS, type Strain } from "@forge/shared/light";

// Per-session failure counting for agent strain (MASTER_PLAN §6.10). Pure functions; the hook does the file I/O.
// Only counts ever leave the machine. Tool inputs are reduced to a local hash, used to spot repeated calls.

export interface ToolCounts {
  attempts: number;
  tool_errors: number;
  retries: number;
  consecutive: number;
  maxConsecutive: number;
  lastWasFailure: boolean;
  lastFailHash: string | null;
  sameFailRepeat: number;
  maxSameFailRepeat: number;
  nudged: boolean;
}

export interface SessionState {
  tools: Record<string, ToolCounts>;
  updatedAt: number;
}

export const NUDGE_AFTER = 3;
export const NUDGE_TEXT =
  "This tool has failed 3 times in a row. Check it on the Forge, file a report, then retry once in a fresh context or ask your human.";

export const emptyState = (): SessionState => ({ tools: {}, updatedAt: 0 });

const fresh = (): ToolCounts => ({
  attempts: 0,
  tool_errors: 0,
  retries: 0,
  consecutive: 0,
  maxConsecutive: 0,
  lastWasFailure: false,
  lastFailHash: null,
  sameFailRepeat: 0,
  maxSameFailRepeat: 0,
  nudged: false,
});

/** Records a failed call. Returns true when the fixed nudge should be shown (once per failure streak). */
export function recordFailure(state: SessionState, tool: string, inputHash: string, now: number): boolean {
  const c = (state.tools[tool] ??= fresh());
  c.attempts++;
  if (c.lastWasFailure) c.retries++;
  c.tool_errors++;
  c.consecutive++;
  c.maxConsecutive = Math.max(c.maxConsecutive, c.consecutive);
  c.sameFailRepeat = c.lastWasFailure && c.lastFailHash === inputHash ? c.sameFailRepeat + 1 : 1;
  c.maxSameFailRepeat = Math.max(c.maxSameFailRepeat, c.sameFailRepeat);
  c.lastWasFailure = true;
  c.lastFailHash = inputHash;
  state.updatedAt = now;
  if (c.consecutive >= NUDGE_AFTER && !c.nudged) {
    c.nudged = true;
    return true;
  }
  return false;
}

/** Records a successful call: a call right after a failure is a retry; success ends the failure streak. */
export function recordSuccess(state: SessionState, tool: string, now: number) {
  const c = (state.tools[tool] ??= fresh());
  c.attempts++;
  if (c.lastWasFailure) c.retries++;
  c.consecutive = 0;
  c.lastWasFailure = false;
  c.lastFailHash = null;
  c.nudged = false;
  state.updatedAt = now;
}

/** The §6.5 strain block for one tool, capped and internally consistent. */
export function toStrain(c: ToolCounts): Strain {
  const tool_errors = Math.min(c.tool_errors, STRAIN_CAPS.tool_errors);
  const retries = Math.min(c.retries, STRAIN_CAPS.retries, tool_errors);
  const loop = c.maxConsecutive >= LOOP_MIN_FAILURES || c.maxSameFailRepeat >= LOOP_MIN_FAILURES;
  return {
    source: "hook",
    attempts: Math.max(1, Math.min(c.attempts, STRAIN_CAPS.attempts)),
    tool_errors,
    retries,
    loop_detected: loop && (tool_errors >= LOOP_MIN_FAILURES || retries >= LOOP_MIN_FAILURES - 1),
    context_reset: false,
    outcome_after_reset: "none",
    escalated_to_human: false,
  };
}

/** Tools that had at least one failure this session, with their strain blocks. */
export function summary(state: SessionState): Record<string, Strain> {
  const out: Record<string, Strain> = {};
  for (const [tool, c] of Object.entries(state.tools)) if (c.tool_errors > 0) out[tool] = toStrain(c);
  return out;
}

/** Session ids become file names: keep them boring. */
export const safeSessionId = (id: unknown) =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "unknown";
