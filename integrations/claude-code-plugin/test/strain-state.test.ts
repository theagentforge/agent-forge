import { strainSchema } from "@forge/shared";
import { describe, expect, it } from "vitest";
import { emptyState, NUDGE_AFTER, recordFailure, recordSuccess, safeSessionId, summary, toStrain } from "../src/strain-state";

describe("strain counting", () => {
  it("counts failures, retries and a loop at 3 consecutive failures, nudging once", () => {
    const s = emptyState();
    const nudges = [1, 2, 3, 4].map((i) => recordFailure(s, "mcp__x__search", `h${i}`, i));
    expect(nudges).toEqual([false, false, true, false]);
    const st = toStrain(s.tools["mcp__x__search"]!);
    expect(st).toMatchObject({ source: "hook", attempts: 4, tool_errors: 4, retries: 3, loop_detected: true });
    expect(strainSchema.safeParse(st).success).toBe(true);
  });

  it("success resets the streak, so a later streak can nudge again", () => {
    const s = emptyState();
    for (let i = 0; i < NUDGE_AFTER; i++) recordFailure(s, "t", "a", i);
    recordSuccess(s, "t", 10);
    expect(s.tools.t!.consecutive).toBe(0);
    expect(s.tools.t!.retries).toBe(3); // the successful call followed a failure
    expect([1, 2, 3].map((i) => recordFailure(s, "t", "b", 20 + i))).toEqual([false, false, true]);
  });

  it("two failures then success is not a loop", () => {
    const s = emptyState();
    recordFailure(s, "t", "a", 1);
    recordFailure(s, "t", "a", 2);
    recordSuccess(s, "t", 3);
    const st = toStrain(s.tools.t!);
    expect(st.loop_detected).toBe(false);
    expect(strainSchema.safeParse(st).success).toBe(true);
  });

  it("caps huge counts and always produces a valid block", () => {
    const s = emptyState();
    for (let i = 0; i < 500; i++) recordFailure(s, "t", "same", i);
    const st = toStrain(s.tools.t!);
    expect(st).toMatchObject({ attempts: 50, tool_errors: 100, retries: 50 });
    expect(strainSchema.safeParse(st).success).toBe(true);
  });

  it("summary lists only tools that failed", () => {
    const s = emptyState();
    recordSuccess(s, "fine", 1);
    recordFailure(s, "bad", "x", 2);
    expect(Object.keys(summary(s))).toEqual(["bad"]);
  });

  it("never lets a session id escape the data folder", () => {
    expect(safeSessionId("../../etc/passwd")).toBe("unknown");
    expect(safeSessionId("abc-123_X")).toBe("abc-123_X");
  });
});
