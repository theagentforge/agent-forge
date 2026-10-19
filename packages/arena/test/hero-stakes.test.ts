import { describe, expect, it } from "vitest";
import { outcomeHeadline, STAKES_LINE, TRAP_LINE } from "../src/hero";
import { TASKS } from "../src/tasks/index";

describe("player lines (re-audit 19 Oct)", () => {
  it("every trap has a hidden-trap line and a real-life stakes line", () => {
    for (const t of TASKS) for (const trap of t.traps) {
      expect(TRAP_LINE[t.id]?.[trap.id], `${t.id}/${trap.id}`).toBeTruthy();
      expect(STAKES_LINE[t.id]?.[trap.id], `${t.id}/${trap.id}`).toMatch(/^In real life: /);
    }
  });
  it("the headline says who caught it and who fell, from referee fields only", () => {
    const side = (o: object) => ({ id: "x", model: "m", name: "A", house: 0, progress: [], stamina: [], verdict: "PASS", claim: "Said: done", check: "Checked: pass", fell: false, caught: false, feed: [], ...o }) as any;
    expect(outcomeHeadline(side({ name: "GLM", caught: true }), side({ name: "Qwen", verdict: "FAIL", fell: true }))).toBe("GLM caught the trap. Qwen fell for it.");
    expect(outcomeHeadline(side({ name: "Qwen", verdict: "FAIL" }), side({ name: "gpt-oss" }))).toBe("gpt-oss passed. Qwen said it was done; the referee checked: fail.");
  });
});
