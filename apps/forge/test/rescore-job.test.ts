import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRACTICE } from "../src/arena/lineup";
import { RESCORE_JOB_KEY, RESCORE_REPORT_KEY, rescoreTick, type RescoreReport } from "../src/arena/rescore-job";
import { planEvent, processQueue } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { queueApprovedApply } from "./rescore-helpers";

// Re-scoring stored runs in the Worker (rules 0.5, ADR 0049): a KV job, a dry report first, then apply.

const model = PRACTICE[0]!;
const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function scripted(replies: { content?: string | null; tool_calls?: unknown[] }[]) {
  let i = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return { choices: [{ message: { content: r.content ?? null, tool_calls: r.tool_calls ?? [] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
  }) as never);
}
const honest = [
  { tool_calls: [call("get_accounts", {})] },
  { tool_calls: [call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })] },
];

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.KV.delete("arena:lock");
  await env.KV.delete(RESCORE_JOB_KEY);
  await env.KV.delete(RESCORE_REPORT_KEY);
});

describe("re-scoring stored runs", () => {
  it("does nothing without a job", async () => {
    expect(await rescoreTick(env)).toBeNull();
  });

  it("a dry run reports no change for honest runs, then clears the job", async () => {
    scripted(honest);
    const eventId = await planEvent(env, { slug: "rs-dry", name: "Rescore dry", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [1, 2], attempts: 1 });
    await processQueue(env, Date.now() + 60_000);
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "dry" }));
    const r = (await rescoreTick(env))!;
    expect(r).toMatchObject({ mode: "dry", checked: 2, done: true, errors: [] });
    expect(r.changed).toEqual([]);
    expect(await env.KV.get(RESCORE_JOB_KEY)).toBeNull();
    expect((await env.KV.get<RescoreReport>(RESCORE_REPORT_KEY, "json"))!.checked).toBe(2);
    await getDb(env).delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  });

  it("a stored verdict that disagrees with the referee is reported in dry mode and fixed, with a note, in apply mode", async () => {
    scripted(honest);
    const eventId = await planEvent(env, { slug: "rs-apply", name: "Rescore apply", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [3], attempts: 1 });
    await processQueue(env, Date.now() + 60_000);
    const db = getDb(env);
    const [run] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    // Simulate a verdict from an older referee: stored as a fail.
    const { rules: _stamp, ...unstamped } = run!.result as Record<string, unknown>;
    await db.update(t.arenaRuns).set({ passed: false, result: { ...unstamped, passed: false } as never }).where(eq(t.arenaRuns.id, run!.id));
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "dry" }));
    const dry = (await rescoreTick(env))!;
    expect(dry.changed).toHaveLength(1);
    expect(dry.changed[0]).toMatchObject({ id: run!.id, applied: false });
    expect((await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.id, run!.id)))[0]!.passed).toBe(false);

    await queueApprovedApply({ events: [eventId] });
    const applied = (await rescoreTick(env))!;
    expect(applied.changed[0]).toMatchObject({ id: run!.id, applied: true });
    const [after] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.id, run!.id));
    expect(after!.passed).toBe(true);
    expect((after!.result as { rescored?: { rules: string } }).rescored?.rules).toMatch(/^rules /);
    // The signed log is untouched.
    expect(after!.signature).toBe(run!.signature);
    expect(JSON.stringify(after!.log)).toBe(JSON.stringify(run!.log));
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  });
});
