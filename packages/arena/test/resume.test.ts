import { describe, expect, it } from "vitest";
import { Attempt, TASKS, taskById, twistById, type AttemptCheckpoint, type TaskType } from "../src";

// Resumable bouts (ADR 0022): an attempt saved with checkpoint() and rebuilt with Attempt.resume() on a later tick
// ends exactly as if it had been played straight through, and the gap between ticks never counts as bout time.

const SEED = 42;
const flaky = taskById("flaky-supplier") as TaskType<any>;

/** A clock that only moves when the script says so (each "turn" takes 1 second of model time). */
const clock = (start = 0) => {
  const c = { t: start, now: () => c.t };
  return c;
};

type Step = [string, Record<string, unknown>][];
/** Turns for The Flaky Supplier: retries hit the seeded random failures, so the replay must reproduce the RNG too. */
const script = (a: Attempt<any>): Step[] => {
  const s = a.variant.state;
  const order = { sku: s.sku, quantity: s.target - s.stock, idempotency_key: "restock-1" };
  return [
    [["get_inventory", {}]],
    [["place_supplier_order", order]],
    [["place_supplier_order", order], ["list_supplier_orders", {}]],
    [["place_supplier_order", order]],
    [["send_message", { to: s.manager, text: "Ordered once." }]],
    [["finish", { status: "done", summary: "Ordered once." }]],
  ];
};

function playTurns(a: Attempt<any>, c: { t: number }, steps: Step[]) {
  const outs: string[] = [];
  for (const step of steps) {
    c.t += 1000;
    const ko = a.recordTurn({ tokensIn: 100, tokensOut: 10, cost: 0.001, latencyMs: 1000 });
    if (ko) {
      a.end(ko);
      return outs;
    }
    for (const [name, args] of step) {
      outs.push(a.call(name, args).content);
      if (a.done) break;
    }
  }
  return outs;
}

describe("checkpoint and resume", () => {
  it.each([1, 2, 3, 4, 5])("suspended after %i turns, the bout ends exactly as one played straight through", (k) => {
    const c1 = clock();
    const straight = new Attempt(flaky, SEED, { now: c1.now });
    const outsStraight = playTurns(straight, c1, script(straight));

    const c2 = clock();
    const first = new Attempt(flaky, SEED, { now: c2.now });
    const steps = script(first);
    const outs = playTurns(first, c2, steps.slice(0, k));
    const cp = first.checkpoint();
    c2.t += 3_600_000; // an hour until the next tick
    const resumed = Attempt.resume(flaky, SEED, { now: c2.now }, cp);
    outs.push(...playTurns(resumed, c2, steps.slice(k)));

    expect(outs).toEqual(outsStraight);
    expect(resumed.result).toEqual(straight.result);
    expect(resumed.log).toEqual(JSON.parse(JSON.stringify(straight.log)));
  });

  it("round-trips through JSON (it is stored in D1) and can be suspended again", () => {
    const c = clock();
    let a = new Attempt(flaky, SEED, { now: c.now });
    const steps = script(a);
    for (let i = 0; i < steps.length - 1; i++) {
      playTurns(a, c, [steps[i]!]);
      const cp = JSON.parse(JSON.stringify(a.checkpoint())) as AttemptCheckpoint;
      c.t += 60_000;
      a = Attempt.resume(flaky, SEED, { now: c.now }, cp);
      expect(a.turns).toBe(i + 1);
    }
    playTurns(a, c, steps.slice(-1));
    expect(a.result).toMatchObject({ reason: "finished", turns: steps.length, wallMs: steps.length * 1000 });
  });

  it("the time cap counts active time only, never the gap between ticks", () => {
    const twist = twistById("two-minute")!; // 2 minutes of bout time
    const c = clock();
    let a = new Attempt(flaky, SEED, { twist, now: c.now });
    const steps = script(a);
    playTurns(a, c, steps.slice(0, 2));
    const cp = a.checkpoint(); // saved as the tick ends
    c.t += 24 * 3_600_000; // a day between ticks
    a = Attempt.resume(flaky, SEED, { twist, now: c.now }, cp);
    playTurns(a, c, steps.slice(2));
    expect(a.result!.reason).toBe("finished");
    expect(a.result!.wallMs).toBe(steps.length * 1000);

    // But time spent inside ticks adds up across them.
    const c2 = clock();
    let b = new Attempt(flaky, SEED, { twist, now: c2.now });
    playTurns(b, c2, steps.slice(0, 1));
    c2.t += 70_000; // a slow tool or model inside the first tick
    const cp2 = b.checkpoint();
    c2.t += 24 * 3_600_000;
    b = Attempt.resume(flaky, SEED, { twist, now: c2.now }, cp2);
    c2.t += 60_000; // and inside the second
    playTurns(b, c2, steps.slice(1));
    expect(b.result!.reason).toBe("knockout_time");
  });

  it("refuses a checkpoint for another task, seed or twist, or one that no longer replays", () => {
    const c = clock();
    const a = new Attempt(flaky, SEED, { now: c.now });
    playTurns(a, c, script(a).slice(0, 3));
    const cp = a.checkpoint();
    expect(() => Attempt.resume(flaky, SEED + 1, {}, cp)).toThrow(/another task/);
    expect(() => Attempt.resume(TASKS[0]!, SEED, {}, cp)).toThrow(/another task/);
    expect(() => Attempt.resume(flaky, SEED, { twist: twistById("two-minute") }, cp)).toThrow(/another task/);
    const tampered = structuredClone(cp);
    const result = tampered.log.find((e) => e.type === "result")!;
    if (result.type === "result") result.result = { forged: true };
    expect(() => Attempt.resume(flaky, SEED, {}, tampered)).toThrow(/no longer replays/);
  });

  it("a finished attempt has no checkpoint", () => {
    const c = clock();
    const a = new Attempt(flaky, SEED, { now: c.now });
    playTurns(a, c, script(a));
    expect(() => a.checkpoint()).toThrow(/finished/);
  });
});
