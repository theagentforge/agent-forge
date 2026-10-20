import { describe, expect, it } from "vitest";
import { report, score } from "../tool-selection.mjs";

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
});
