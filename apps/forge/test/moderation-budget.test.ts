import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { MODERATION_DAILY_CAP, takeModerationBudget } from "../src/services/moderation";
import { sweepPendingNotes } from "../src/services/moderation-sweep";
import { connectAgent, postReport, report } from "./helpers";
import "../src/index";

const guard = vi.fn(async () => ({ response: "safe" }));
const today = () => `mod-count:${new Date().toISOString().slice(0, 10)}`;
beforeEach(async () => {
  guard.mockClear();
  guard.mockResolvedValue({ response: "safe" });
  vi.spyOn(env.AI, "run").mockImplementation(guard as never);
  await env.KV.delete(today());
});

describe("moderation cost guard", () => {
  it("counts each call and stops at the daily cap", async () => {
    const now = Date.UTC(2026, 9, 15, 12);
    const key = "mod-count:2026-10-15";
    await env.KV.put(key, String(MODERATION_DAILY_CAP - 1));
    expect(await takeModerationBudget(env.KV, now)).toBe(true);
    expect(await takeModerationBudget(env.KV, now)).toBe(false);
    expect(await takeModerationBudget(env.KV, now + 86400_000)).toBe(true);
  });

  it("holds a note as pending once the allowance is spent, without calling the model", async () => {
    await env.KV.put(today(), String(MODERATION_DAILY_CAP));
    const { token } = await connectAgent();
    const res = await postReport(token, report({ note: "Worked first time." }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ counted: true, note_status: "pending_moderation" });
    expect(guard).not.toHaveBeenCalled();
  });

  it("the hourly sweep moderates pending notes when allowance returns", async () => {
    await env.KV.put(today(), String(MODERATION_DAILY_CAP));
    const { token } = await connectAgent();
    await postReport(token, report({ note: "Fine note." }));
    await postReport(token, report({ note: "Bad note.", tool: { ...report().tool, version: "9.9.9" } }));
    expect(await sweepPendingNotes(env)).toEqual({ checked: 0, approved: 0, rejected: 0 });

    await env.KV.delete(today());
    guard.mockImplementation((async (_m: unknown, input: { messages: { content: string }[] }) => ({
      response: input.messages[0]?.content.startsWith("Bad") ? "unsafe\nS1" : "safe",
    })) as never);
    const out = await sweepPendingNotes(env);
    expect(out.rejected).toBe(1);
    expect(out.approved).toBeGreaterThanOrEqual(1);
    const pending = await getDb(env).select().from(t.reports).where(eq(t.reports.moderationState, "pending"));
    expect(pending).toHaveLength(0);
    const rejected = await getDb(env).select().from(t.reports).where(eq(t.reports.moderationState, "rejected"));
    expect(rejected.map((r) => r.note)).toEqual([null]);
  });
});
