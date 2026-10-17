import { env } from "cloudflare:workers";
import { taskById, type LogEvent } from "@forge/arena";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRACTICE } from "../src/arena/lineup";
import { planEvent, processQueue, type BoutCheckpoint } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";

// Resumable bouts (ADR 0022): a bout still going at a tick's deadline is suspended between turns and carried on by
// a later tick, ending exactly as if it had been played straight through. The clock here only moves while the
// (mocked) model "thinks", so the only time that passes inside a tick is the bout's own.

const model = PRACTICE[0]!;
const SEED = 77;
const TURN_MS = 30_000;
const HOUR = 3_600_000;
const db = getDb(env);
let clock = Date.now();
const now = () => clock;

const call = (name: string, args: unknown, id: string) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const { state } = taskById("flaky-supplier")!.make(SEED) as { state: { sku: string; target: number; stock: number; manager: string } };
const order = { sku: state.sku, quantity: state.target - state.stock, idempotency_key: "restock-1" };
/** Seven turns of The Flaky Supplier; the retries meet its seeded random failures, so the replay must match them. */
const SCRIPT = [
  [call("get_inventory", {}, "c0")],
  [call("place_supplier_order", order, "c1")],
  [call("place_supplier_order", order, "c2"), call("list_supplier_orders", {}, "c3")],
  [call("place_supplier_order", order, "c4")],
  [call("list_supplier_orders", {}, "c5")],
  [call("send_message", { to: state.manager, text: "Ordered once." }, "c6")],
  [call("finish", { status: "done", summary: "Ordered once." }, "c7")],
];

/** A model that replies by how many turns it has had (from the chat it is sent), taking TURN_MS each time. */
function mockModel(fail?: (turn: number) => boolean, failMessage = "429: rate limited, slow down") {
  const inputs: { messages: { role: string; content: unknown }[] }[] = [];
  vi.spyOn(env.AI, "run").mockImplementation((async (_m: string, input: (typeof inputs)[number]) => {
    inputs.push(structuredClone(input));
    const turn = input.messages.filter((m) => m.role === "assistant").length;
    clock += TURN_MS;
    if (fail?.(turn)) throw new Error(failMessage);
    return { choices: [{ message: { content: `turn ${turn}`, tool_calls: SCRIPT[Math.min(turn, SCRIPT.length - 1)] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
  }) as never);
  return inputs;
}

const plan = (slug: string, seeds = [SEED]) => planEvent(env, { slug, name: slug, season: "s0", kind: "practice", models: [model.id], tasks: ["flaky-supplier"], seeds, attempts: 1 });
const runOf = async (eventId: string) => (await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId)))[0]!;
/** One cron tick whose deadline is `window` ms after it starts; the tick starts an hour after the last one. */
const tick = async (window: number) => {
  clock += HOUR;
  return processQueue(env, clock + window, now);
};
/** Model latency is measured on the real clock; everything else must match exactly. */
const comparable = (log: unknown) => (log as LogEvent[]).map((e) => (e.type === "turn" ? { ...e, latencyMs: 0 } : e));
const calls = (log: unknown) => (log as LogEvent[]).filter((e) => e.type === "call").map((e) => e.type === "call" && [e.name, e.args]);

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.KV.delete("arena:lock");
  await db.delete(t.arenaRuns);
});

describe("resumable bouts", () => {
  it("a rate limit (429) pauses the bout and leaves that model alone for the tick; it is never a void", async () => {
    mockModel();
    const straight = await plan("resume-429-straight");
    await tick(HOUR);
    const s = await runOf(straight);

    let limited = true;
    mockModel((turn) => turn === 2 && limited);
    const ev = await plan("resume-429");
    const first = await tick(HOUR);
    expect(first).toMatchObject({ played: 0, voided: 0, suspended: 1, rateLimited: 1 });
    const mid = await runOf(ev);
    expect(mid).toMatchObject({ status: "queued", retries: 0, voidReason: null });
    expect((mid.checkpoint as BoutCheckpoint).attempt.turns).toBe(2);

    limited = false;
    expect(await tick(HOUR)).toMatchObject({ played: 1, voided: 0 });
    const r = await runOf(ev);
    expect(r).toMatchObject({ status: "done", passed: s.passed, score: s.score, retries: 0 });
    expect(calls(r.log)).toEqual(calls(s.log));
  });

  it("a bout suspended at the deadline and resumed next tick ends exactly as one played straight through", async () => {
    mockModel();
    const straight = await plan("resume-straight");
    await tick(HOUR);
    const s = await runOf(straight);
    expect(s).toMatchObject({ status: "done", checkpoint: null });

    mockModel();
    const split = await plan("resume-split");
    const first = await tick(TURN_MS * 3 - 1); // the deadline passes during the third turn
    expect(first).toMatchObject({ played: 0, suspended: 1 });
    const mid = await runOf(split);
    expect(mid).toMatchObject({ status: "queued", startedAt: null, result: null, log: null, signature: null });
    const cp = mid.checkpoint as BoutCheckpoint;
    expect(cp).toMatchObject({ v: 1, ticks: 1, attempt: { turns: 3, activeMs: 3 * TURN_MS } });
    // The chat goes on exactly where it stopped: system, brief, then each turn's reply and tool results.
    expect(cp.messages.filter((m) => m.role === "assistant")).toHaveLength(3);

    expect(await tick(HOUR)).toMatchObject({ played: 1, suspended: 0 });
    const r = await runOf(split);
    expect(r).toMatchObject({ status: "done", checkpoint: null, passed: s.passed, score: s.score, cost: s.cost, tokens: s.tokens });
    expect({ ...(r.result as object), modelMs: 0 }).toEqual({ ...(s.result as object), modelMs: 0 });
    expect((r.log as unknown[]).length).toBe((s.log as unknown[]).length);
    expect(calls(r.log)).toEqual(calls(s.log));
    expect(comparable(r.log)).toEqual(comparable(s.log));
    expect(r.signature).toMatch(/^hmac-sha256:/);
  });

  it("the time cap counts the bout's own time, never the hours between ticks", async () => {
    mockModel();
    const ev = await plan("resume-cap");
    await tick(TURN_MS * 2 - 1);
    await tick(TURN_MS * 2 - 1);
    await tick(HOUR);
    const r = await runOf(ev);
    // Two hours of wall clock passed, but the bout used 7 × 30 s of its 5 minutes.
    expect(r.status).toBe("done");
    expect(r.result).toMatchObject({ reason: "finished", turns: SCRIPT.length, wallMs: SCRIPT.length * TURN_MS });
    const ts = (r.log as LogEvent[]).filter((e) => e.type === "turn").map((e) => e.t);
    expect(ts).toEqual(SCRIPT.map((_, i) => (i + 1) * TURN_MS));
  });

  it("a bout can span three or more ticks", async () => {
    mockModel();
    const ev = await plan("resume-three");
    const ticks: BoutCheckpoint[] = [];
    for (let i = 0; i < 3; i++) {
      expect(await tick(TURN_MS * 2 - 1)).toMatchObject({ suspended: 1 });
      ticks.push((await runOf(ev)).checkpoint as BoutCheckpoint);
    }
    expect(ticks.map((c) => [c.ticks, c.attempt.turns])).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ]);
    expect(await tick(HOUR)).toMatchObject({ played: 1 });
    expect((await runOf(ev)).result).toMatchObject({ reason: "finished", turns: 7 });
  });

  it("a provider failure after resuming voids the bout, drops the checkpoint and re-queues it to start clean", async () => {
    // The provider fails once, on the first turn after the bout is resumed.
    let failed = false;
    const inputs = mockModel((turn) => !failed && turn === 2 && (failed = true), "overloaded");
    const ev = await plan("resume-void");
    expect(await tick(TURN_MS * 2 - 1)).toMatchObject({ suspended: 1 }); // two turns, then suspended
    expect((await runOf(ev)).checkpoint).not.toBeNull();
    expect(await tick(TURN_MS / 2)).toMatchObject({ voided: 1, suspended: 0 }); // resumed, then the provider fails
    const v = await runOf(ev);
    expect(v).toMatchObject({ status: "queued", retries: 1, checkpoint: null, startedAt: null });
    expect(v.voidReason).toMatch(/overloaded/);

    inputs.length = 0;
    await tick(HOUR);
    expect(inputs[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]); // from the beginning
    expect((await runOf(ev)).result).toMatchObject({ reason: "finished", turns: 7 });
  });

  it("a run left running by a Worker that died keeps its checkpoint and carries on from it", async () => {
    mockModel();
    const ev = await plan("resume-reaped");
    await tick(TURN_MS * 2 - 1);
    const run = await runOf(ev);
    await db.update(t.arenaRuns).set({ status: "running", startedAt: clock - 30 * 60_000 }).where(eq(t.arenaRuns.id, run.id));
    const inputs = mockModel();
    await tick(HOUR);
    expect(inputs[0]!.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect((await runOf(ev)).result).toMatchObject({ reason: "finished", turns: 7 });
  });

  it("a suspended bout is resumed before newer work of its class is started, even older runs", async () => {
    mockModel();
    const ev = await plan("resume-first");
    await tick(TURN_MS * 2 - 1);
    const fresh = await plan("resume-fresh", [1, 2, 3, 4]);
    await db.update(t.arenaRuns).set({ createdAt: 0 }).where(eq(t.arenaRuns.eventId, fresh)); // first in line by age
    mockModel();
    clock += HOUR;
    let c = clock;
    await processQueue(env, c + HOUR, () => (c += 1));
    const suspended = await runOf(ev);
    const others = await db.select().from(t.arenaRuns).where(inArray(t.arenaRuns.eventId, [fresh]));
    expect(suspended.status).toBe("done");
    expect(others.every((o) => suspended.startedAt! < o.startedAt!)).toBe(true);
  });
});
