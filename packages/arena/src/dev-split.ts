import { Attempt, DEFAULT_CAPS } from "./engine";
import { TASKS } from "./tasks/index";

// The public dev split (D9, ADR 0057): a small, fixed set of practice-only Normal-tier variants, published in the
// Prime Intellect Verifiers format (integrations/verifiers-env). The seeds sit below the Season minimum (1,000,000), so
// no ranked event can draw them, and no held-out panel may use them: they are public by design. The task code is
// already public; private families never appear here.

export const DEV_SPLIT = {
  version: "dev-1",
  /** Fixed, published seeds: practice-only, never ranked, never held out. */
  seeds: [900_001, 900_002, 900_003, 900_004, 900_005],
  tasks: TASKS.map((t) => t.id),
} as const;

export const isDevSplitSeed = (seed: number) => (DEV_SPLIT.seeds as readonly number[]).includes(seed);

/**
 * A fresh seed for a Proving Ground or Gauntlet bout (1,000 to 1,000,999): drawn at random, never a dev-split seed,
 * since those worlds and their reference plays are published.
 */
export function freshBoutSeed(random: () => number = Math.random): number {
  for (;;) {
    const s = 1000 + Math.floor(random() * 1_000_000);
    if (!isDevSplitSeed(s)) return s;
  }
}

/** One dev-split row: everything the Verifiers environment needs to rebuild the world offline. */
export function devSplitRows() {
  return TASKS.flatMap((task) =>
    DEV_SPLIT.seeds.map((seed) => {
      const a = new Attempt(task, seed);
      return {
        id: `${task.id}-${seed}`,
        task: task.id,
        title: task.title,
        seed,
        impossible: a.variant.impossible,
        brief: a.variant.brief,
        tools: a.toolSpecs(),
        caps: { toolCalls: (task.caps ?? DEFAULT_CAPS).toolCalls },
        traps: task.traps,
        state: a.variant.state,
      };
    }),
  );
}
