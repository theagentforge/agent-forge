import type { TaskType } from "../types";
import type { TrapEntry } from "../traps";

// The public mirror's copy of packages/arena/src/private/index.ts: private job families aren't published (ADR 0040),
// and neither are the held-out seeds (ADR 0058), so the mirror has none and its held-out panel is empty.
export const PRIVATE_TASKS: TaskType[] = [];
export const PRIVATE_TRAP_CATALOG: TrapEntry[] = [];
export const HELDOUT_PANEL_VERSION = "none";
export const HELDOUT_SEEDS: Record<string, { normal: number[]; hard: number[] }> = {};
