import { describe, expect, it } from "vitest";
import { HARD3_TASKS, HARD_TASKS, TASKS, taskById } from "../src";

describe("Hard v3 registry (ADR 0021 amendment 3)", () => {
  it("registers six v3 jobs, all Hard tier with their own caps, kept apart from v2 and Normal", () => {
    expect(HARD3_TASKS.map((t) => t.id)).toEqual(["refund-hard3", "scam-invoice-hard3", "weekend-hard3", "spreadsheet-hard3", "flaky-supplier-hard3", "impossible-hard3"]);
    for (const t of HARD3_TASKS) {
      expect(t.tier).toBe("hard");
      expect(t.caps?.ms).toBeLessThanOrEqual(30 * 60_000);
      expect(taskById(t.id)).toBe(t);
    }
    const ids = new Set([...TASKS, ...HARD_TASKS, ...HARD3_TASKS].map((t) => t.id));
    expect(ids.size).toBe(18);
  });
});

import { Attempt } from "../src";
import { evaluate } from "../src/tasks/calculator";

describe("the Hard v3 calculator (amendment 4)", () => {
  it("does arithmetic, rounding and refuses anything else", () => {
    expect(evaluate("round(222.10 * 72.35 / 277.65, 2)")).toBe(57.87);
    expect(evaluate("$48.15 * 0.8")).toBeCloseTo(38.52);
    expect(evaluate("round(2.675, 2)")).toBe(2.68);
    expect(evaluate("-(3 + 4) * 2 % 5")).toBe(-4);
    expect(evaluate("min(3, 1.5, 2) + max(1, 2) + abs(-1)")).toBe(4.5);
    for (const bad of ["process.exit()", "1/0", "2 +", "constructor", "1;2", "x * 2"]) expect(() => evaluate(bad)).toThrow();
  });
  it("is on every v3 job, read-only, and answers in one call", () => {
    for (const t of HARD3_TASKS) {
      const a = new Attempt(t, 402);
      expect(a.toolSpecs().map((s) => s.name)).toContain("calculate");
      const out = a.call("calculate", { expressions: ["1.1 + 2.2", "oops("] });
      expect(out.ok).toBe(true);
      expect(JSON.parse(out.content)).toEqual([{ expression: "1.1 + 2.2", result: 3.3 }, expect.objectContaining({ expression: "oops(" })]);
    }
  });
});
