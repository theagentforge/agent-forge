import selection from "../../../../lab/005-trap-card-v11-frontier/selection.json";

// Forge Lab #5 (lab/005-trap-card-v11-frontier/PREREGISTRATION.md): trap card v1.1 on the Hard jobs frontier models
// fail most often. The pairs are frozen in selection.json before any run; one event per arm and pair, the same 30
// seeds in the same order in every arm. Queued from 1 Nov 2026, inside November's budget.

export const LAB5_SEEDS = Array.from({ length: 30 }, (_, i) => 5001 + i);
export const LAB5_ARMS = ["none", "card", "card11"] as const;

export function lab5Plans() {
  return selection.selected.flatMap((p) =>
    LAB5_ARMS.map((arm) => ({
      slug: `lab5-${arm}-${p.model}-${p.task}`.replace(/\./g, "-"),
      name: `Lab #5: ${p.model} × ${p.task}, arm ${arm}`,
      season: "s0",
      kind: "practice" as const,
      arm,
      models: [p.model],
      tasks: [p.task],
      seeds: LAB5_SEEDS,
      attempts: 1,
    })),
  );
}

/** About what Lab #5 costs: measured cost per attempt × attempts, +6% (v1.0) and +9% (v1.1) for the longer prompts. */
export const lab5Estimate = () =>
  Math.round(selection.selected.reduce((s, p) => s + p.costPerAttempt * LAB5_SEEDS.length * (1 + 1.06 + 1.09), 0) * 100) / 100;
