import { describe, expect, it } from "vitest";
import { deltas, report, score } from "../tool-selection.mjs";

// The tool-selection report (agent-channels §4.1): accuracy on requests that fit, false triggers on those that don't.

const rows = [
  { i: 0, expect: ["forge_check"], chose: "forge_check", correct: true },
  { i: 1, expect: ["forge_scan"], chose: "web_search", correct: false },
  { i: 2, expect: ["forge_traps"], chose: "arena_results", correct: false },
  { i: 3, expect: ["forge_check"], chose: "error", correct: false },
  { i: 20, expect: "none", chose: "none", correct: true },
  { i: 21, expect: "none", chose: "forge_check", correct: false },
];

describe("the tool-selection report", () => {
  it("scores right picks, misses, wrong Forge tools, false triggers and errors apart", () => {
    expect(score(rows)).toEqual({ accuracy: 1 / 3, missed: 1, wrongTool: 1, falseTriggers: 1, nFit: 3, nNot: 2, errors: 1 });
  });

  it("renders one summary row per model and one line per request", () => {
    const md = report("2026-10-20", [{ model: "claude-sonnet-5.5", rows, cost: 0.1234 }]);
    expect(md).toContain("| claude-sonnet-5.5 | 33% (1 of 3) | 1 | 1 | 1 of 2 | 1 | $0.123 |");
    expect(md).toContain("| 2 | forge_scan | ✗ web_search |");
    expect(md).toContain("| 22 | none of ours | ✗ forge_check |");
    expect(md.split("\n").filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(30);
  });

  it("ADR 0133: labels each description set and states before → after, accepting only a rise with no new false triggers", () => {
    const better = rows.map((r) => (r.i === 1 ? { ...r, chose: "forge_scan", correct: true } : r));
    const runs = [
      { model: "gpt-6.1-sol", set: "after", rows: better, cost: 0.1 },
      { model: "gpt-6.1-sol", set: "before", rows, cost: 0.1 },
    ];
    expect(deltas(runs)).toEqual([{ model: "gpt-6.1-sol", before: { right: 1, of: 3, falseTriggers: 1 }, after: { right: 2, of: 3, falseTriggers: 1 }, accept: true }]);
    const md = report("2026-11-06", runs);
    expect(md).toContain("| gpt-6.1-sol (after) | 67% (2 of 3)");
    expect(md).toContain("right tool 1 of 3 → 2 of 3; false triggers 1 → 1. Accuracy rose and false triggers didn't");
    const worse = [{ ...runs[0], rows: better.map((r) => (r.i === 20 ? { ...r, chose: "forge_scan", correct: false } : r)) }, runs[1]];
    expect(deltas(worse)[0].accept).toBe(false);
  });
});
