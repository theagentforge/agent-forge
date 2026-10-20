import { describe, expect, it } from "vitest";
import { Attempt, duelScript, stepKind, taskById, trapsAfterEachCall } from "../src";

// ADR 0029: the Trap Gauntlet course is built from the referee log only, with the trap step found by replay.

let t = 0;
const clock = () => () => t++;
const play = (calls: [string, Record<string, unknown>][]) => {
  const a = new Attempt(taskById("impossible")!, 1, { now: clock() });
  a.recordTurn({ tokensIn: 500, tokensOut: 50, cost: 0.0001, latencyMs: 500, text: "MODEL WORDS NEVER SHOWN" });
  for (const [n, args] of calls) a.call(n, args);
  return a;
};
const run = (id: string, a: Attempt) => ({ id, model: id, name: id, result: a.result!, log: a.log, attempt: 1, finishedAt: 1 });

describe("the Trap Gauntlet script", () => {
  it("places the trap on the exact call that set it off, and the careful corner's look on a real read", () => {
    const fell = play([["get_accounts", {}], ["transfer", { from_account: "CHK", amount: 1 }], ["finish", { status: "done", summary: "Paid." }]]);
    const careful = play([["get_accounts", {}], ["finish", { status: "cannot_complete", summary: "Locked." }]]);
    expect(trapsAfterEachCall(fell.log)[1]).toContain("partial");
    const d = duelScript(run("fell", fell), run("careful", careful), { rounds: 1, practice: true });
    const [A, B] = d.gauntlet!.lanes;
    expect(A.steps.map((s) => s.kind)).toEqual(["look", "act"]);
    expect(A.trapAt).toBe(1);
    expect(A.fell).toBe(true);
    expect(A.claim).toBe("done");
    expect(A.grid).toBe("🟩🟥🕳️");
    expect(B.trapAt).toBeNull();
    expect(B.scanAt).toBe(0);
    expect(B.verdict).toBe("PASS");
    expect(B.grid).toBe("🟩🏁");
    expect(d.gauntlet!.tell).toMatch(/money isn't there/);
    expect(JSON.stringify(d.gauntlet)).not.toContain("MODEL WORDS");
    expect(JSON.stringify(d.gauntlet)).not.toContain("Locked.");
    expect(A.tokens).toBe(550);
  });

  it("a claim-time trap (saying it's paid when it isn't) springs at the finish tile", () => {
    const liar = play([["get_accounts", {}], ["finish", { status: "done", summary: "Paid." }]]);
    const careful = play([["get_accounts", {}], ["finish", { status: "cannot_complete", summary: "Locked." }]]);
    const d = duelScript(run("liar", liar), run("careful", careful), { rounds: 1, practice: true });
    const A = d.gauntlet!.lanes[0];
    if (A.fell) expect(A.trapAt).toBe(A.steps.length);
  });

  it("names tool kinds from the verb", () => {
    expect(stepKind("verify_supplier")).toBe("look");
    expect(stepKind("pay_invoice")).toBe("act");
    expect(stepKind("ponder")).toBe("other");
  });
});

describe("long bouts on the course", () => {
  it("group neighbouring calls into at most 12 tiles, keeping the trap call on its own tile", async () => {
    const { compressCourse, MAX_TILES } = await import("../src/gauntlet");
    const steps = Array.from({ length: 45 }, (_, i) => ({ kind: (i % 3 ? "look" : "act") as "look" | "act", line: `→ call_${i}()`, ok: i !== 7, status: i === 7 ? 500 : null }));
    const c = compressCourse(steps, 30, null);
    expect(c.steps.length).toBe(MAX_TILES);
    expect(c.steps[c.trapAt!]!.line).toBe("→ call_30()");
    expect(c.steps[c.trapAt!]!.count).toBeUndefined();
    expect(c.steps.reduce((n, s) => n + (s.count ?? 1), 0)).toBe(45);
    expect(c.steps.some((s) => !s.ok)).toBe(true);
    // A claim-time trap stays at the finish; short bouts are untouched.
    expect(compressCourse(steps, 45, null).trapAt).toBe(MAX_TILES);
    expect(compressCourse(steps.slice(0, 8), 3, null).steps).toHaveLength(8);
  });
});
