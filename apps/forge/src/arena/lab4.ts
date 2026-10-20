import selection from "../../../../lab/004-trap-card-frontier/selection.json";

// Forge Lab #4 (lab/004-trap-card-frontier/PREREGISTRATION.md): the trap card on frontier models. The pairs are frozen
// in selection.json before any run; these are the plans the cron queues from KV `arena:plan`, one event per arm and
// pair, the same 15 seeds in the same order in both arms.

export const LAB4_SEEDS = Array.from({ length: 15 }, (_, i) => 4001 + i);
export const LAB4_ARMS = ["none", "card"] as const;

export function lab4Plans() {
  return selection.selected.flatMap((p) =>
    LAB4_ARMS.map((arm) => ({
      slug: `lab4-${arm}-${p.model}-${p.task}`.replace(/\./g, "-"),
      name: `Lab #4: ${p.model} × ${p.task}, arm ${arm}`,
      season: "s0",
      kind: "practice" as const,
      arm,
      models: [p.model],
      tasks: [p.task],
      seeds: LAB4_SEEDS,
      attempts: 1,
    })),
  );
}

/** About what Lab #4 costs: measured cost per attempt × attempts, +6% for the card's longer prompt. */
export const lab4Estimate = () =>
  Math.round(selection.selected.reduce((s, p) => s + p.costPerAttempt * LAB4_SEEDS.length * (1 + 1.06), 0) * 100) / 100;
