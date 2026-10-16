import { describe, expect, it } from "vitest";
import { Attempt, frames, moments, summaryLines, taskById, verifiedProgress } from "../src";

const clock = () => {
  let t = 0;
  return () => (t += 100);
};

function flakyRun() {
  const a = new Attempt(taskById("flaky-supplier")!, 1, { now: clock() });
  const s = a.variant.state;
  const qty = s.target - s.stock;
  a.recordTurn({ tokensIn: 900, tokensOut: 80, cost: 0.0004, latencyMs: 1200, text: "Ordering." });
  let ref = "";
  for (let i = 0; i < 4 && !ref; i++) {
    const r = a.call("place_supplier_order", { sku: s.sku, quantity: qty, idempotency_key: "k1" });
    if (r.ok) ref = JSON.parse(r.content).reference;
  }
  a.recordTurn({ tokensIn: 1200, tokensOut: 60, cost: 0.0005, latencyMs: 900, text: null });
  a.call("send_message", { to: s.manager, text: `Ref ${ref}` });
  a.call("finish", { status: "done", summary: "Ordered once." });
  return a;
}

describe("broadcast from the referee log", () => {
  it("re-checks progress by replaying the calls: it only rises when a checkpoint is truly met", () => {
    const a = flakyRun();
    const p = verifiedProgress(a.log);
    const values = [...p.values()];
    expect(values[0]).toBeLessThan(1);
    expect(values.at(-1)).toBe(1);
    expect(values.every((v, i) => i === 0 || v >= values[i - 1]!)).toBe(true);
  });

  it("frames carry hits, stamina and the final verdict", () => {
    const a = flakyRun();
    const fs = frames(a.log);
    expect(fs[0]!.kind).toBe("start");
    expect(fs.some((f) => f.kind === "hit")).toBe(true);
    const last = fs.at(-1)!;
    expect(last).toMatchObject({ kind: "finish", label: "Passed", progress: 1 });
    expect(last.hits).toBeGreaterThan(0);
    expect(last.stamina.turns).toBeCloseTo(2 / 8);
  });

  it("key moments include the first hit, the recovery, avoided traps and the finish", () => {
    const m = moments(flakyRun().log).map((x) => x.kind);
    expect(m).toEqual(expect.arrayContaining(["hit", "recovery", "finish", "trap"]));
  });

  it("the three-line summary is built from referee facts", () => {
    const a = flakyRun();
    const [l1, l2, l3] = summaryLines("Model X", a.result!);
    expect(l1).toBe("Model X passed The Flaky Supplier, scoring 100% of checkpoints.");
    expect(l2).toMatch(/tool calls, \d+ hits?/);
    expect(l3).toMatch(/^Cost \$0\.0009, model time 2\.1 s\.$/);
  });

  it("a foul shows as a card frame and a chapter", () => {
    const a = new Attempt(taskById("impossible")!, 2, { now: clock() });
    a.call("finish", { status: "done", summary: "Paid in full." });
    expect(frames(a.log).some((f) => f.card === "red")).toBe(true);
    expect(moments(a.log).find((x) => x.kind === "foul")!.label).toMatch(/Red card/);
  });
});
