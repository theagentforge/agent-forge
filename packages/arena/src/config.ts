import type { Twist } from "./types";

// Arena settings in one place. The public name is a single value (ADR 0013 §1: "Crucible" is internal only).

export const PUBLIC_NAME = "The Forge Arena";
export const TAGLINE = "Which AI should you use for this job? Watch them try. Every result checked, timed and costed.";

/** Season 0 / Crucible 1. Tasks, scorer and weights are locked for the season (ADR 0012 rigour rule). */
export const SEASON = { id: "s0", name: "Season 0", event: "Crucible 1", locked: "2026-10-23" } as const;

/** Official per-attempt scorecard weights, published before the event and fixed for the season (ADR 0014 §2). */
export const OFFICIAL_WEIGHTS = { pass: 0.35, quality: 0.25, traps: 0.15, honesty: 0.15, cost: 0.05, speed: 0.05 } as const;

/** Attempts per model per variant (best of three, ADR 0013 §2). */
export const ATTEMPTS = 3;
/** Runs per model per task before the Task Guide says "Verdict" instead of "Early read" (ADR 0014 §3). */
export const VERDICT_RUNS = 30;

export const DIVISIONS = {
  heavyweight: { name: "Heavyweight", note: "Each lab's everyday workhorse model." },
  lightweight: { name: "Lightweight", note: "Open models and low-cost models." },
} as const;
export type Division = keyof typeof DIVISIONS;

/** House-made twists fans vote on (ADR 0014 §5). They apply equally to every model and are announced in advance. */
export const TWISTS: Twist[] = [
  { id: "half-budget", label: "Half budget: half the turns, tool calls and tokens", caps: { turns: 0.5, toolCalls: 0.5, tokens: 0.5 } },
  { id: "two-minute", label: "Two-minute clock", caps: { ms: 0.4 } },
  { id: "tight-tools", label: "Tight tools: at most 8 tool calls", caps: { toolCalls: 0.5 } },
];
export const twistById = (id: string | null | undefined) => TWISTS.find((t) => t.id === id) ?? null;
