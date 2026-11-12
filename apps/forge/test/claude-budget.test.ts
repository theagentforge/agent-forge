import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_GUARD_USD,
  ANTHROPIC_MONTHLY_LIMIT_USD,
  anthropicMonthStart,
  anthropicNextReset,
  anthropicSpendThisMonth,
  BYOK_FALLBACK_KV,
  BYOK_HOLD_KV,
  claudeBudget,
  claudeByokIds,
  CLAUDE_PAUSED_KV,
  CLAUDE_SPEND_KV,
  CREDIT_KV,
  houseSprintCostKey,
  OPENROUTER_CREDIT_PURCHASED_USD,
  opsCallAllowed,
  type CreditSnapshot,
} from "../src/arena/credit";
import { freeVariantModels } from "../src/arena/free-lane";
import { ALL_MODELS } from "../src/arena/lineup";
import { queuePanel } from "../src/arena/panel";
import { longitudinalPanel } from "@forge/arena";
import { arenaTick, planEvent, processQueue } from "../src/arena/runner";
import { houseSprint } from "../src/arena/sprint-house";
import * as t from "../src/db/schema";
import { citationOnClaude } from "../src/ops/citations";
import { getDb, newId } from "../src/services/db";
import { recordSpend } from "../src/services/llm-ledger";
import { replyBrains } from "../src/social/moltbook-replies";

// ADR 0147: the Anthropic key runs under a $100 MONTHLY spend limit in the Claude Console (Anthropic's email to the
// owner, 9 Nov 2026), resetting on the 1st. At $90 of our own figure, or with the manual flag arena:claude-paused, no
// Claude bout starts by any path; queued Claude runs stay queued (never voided) and play after the reset.

const KEYED = { ...env, OPENROUTER_API_KEY: "test-key" } as typeof env & { OPENROUTER_API_KEY: string };
const SONNET = "claude-sonnet-5.5";
/** A month no other test in this file spends in. Each test that stores spend uses its own month. */
const at = (y: number, m: number, d = 15) => Date.UTC(y, m, d, 12);
const call = (name: string, args: unknown) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const honest = [call("get_accounts", {}), call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })];
const snapshot = (remaining: number, when = Date.now()): CreditSnapshot => ({ at: when, good_at: when, ok: true, remaining, key_limit_remaining: null, key_usage: OPENROUTER_CREDIT_PURCHASED_USD - remaining, byok_usage_monthly: null });

/** OpenRouter stand-in: Claude turns are BYOK at `upstream` dollars each; records every model asked. */
function openRouter(upstream = 0.02) {
  let i = 0;
  const models: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/v1/key")) return Response.json({ data: { limit: null, limit_remaining: null, usage: 100 } });
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    models.push(body.model);
    const byok = body.model.startsWith("anthropic/");
    return Response.json({
      choices: [{ message: { content: null, tool_calls: [honest[i++ % 2]!] } }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, ...(byok ? { cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: upstream } } : { cost: 0.001 }) },
      provider: byok ? "Anthropic" : "OpenAI",
      model: body.model,
    });
  }) as unknown as typeof fetch;
  return { f, models };
}

async function event(slug: string, kind: "card" | "guest" | "practice", status: "running" | "planned" = "running") {
  const id = newId();
  await getDb(env).insert(t.arenaEvents).values({ id, slug, name: slug, season: "s0", kind, status });
  return id;
}
async function run(eventId: string, modelId: string, extra: Partial<typeof t.arenaRuns.$inferInsert> = {}) {
  const id = newId();
  await getDb(env).insert(t.arenaRuns).values({ id, eventId, modelId, task: "impossible", seed: 1, attemptNo: 1, status: "queued", ...extra });
  return id;
}
/** A finished Claude bout that billed `usd` to our Anthropic key. */
async function spent(usd: number, finishedAt: number) {
  const e = await event(`spend-${newId().slice(0, 8)}`, "practice");
  return run(e, SONNET, { status: "done", cost: usd, byokCost: usd, tokens: 1, finishedAt });
}
const statuses = async (ids: string[]) => Object.fromEntries((await getDb(env).select().from(t.arenaRuns).where(inArray(t.arenaRuns.id, ids))).map((r) => [r.id, r]));

beforeEach(async () => {
  vi.restoreAllMocks();
  const db = getDb(env);
  await db.delete(t.arenaPanel);
  await db.delete(t.arenaRuns);
  await db.delete(t.arenaEvents);
  for (const k of [CREDIT_KV, BYOK_FALLBACK_KV, BYOK_HOLD_KV, CLAUDE_PAUSED_KV, CLAUDE_SPEND_KV, "arena:lock", "arena:plan", "arena:out-of-credit"]) await env.KV.delete(k);
  for (const prefix of ["llmcost:", "sprint:house:"]) for (const k of (await env.KV.list({ prefix })).keys) await env.KV.delete(k.name);
});

describe("the monthly limit (ADR 0147)", () => {
  it("is $100 a month with the guard at $90, and the month runs from 00:00 UTC on the 1st", () => {
    expect(ANTHROPIC_MONTHLY_LIMIT_USD).toBe(100);
    expect(ANTHROPIC_GUARD_USD).toBe(90);
    expect(anthropicMonthStart(Date.UTC(2026, 10, 9, 15))).toBe(Date.UTC(2026, 10, 1));
    expect(anthropicNextReset(Date.UTC(2026, 10, 9, 15))).toBe(Date.UTC(2026, 11, 1));
    // The boundary itself, and December into January.
    expect(anthropicMonthStart(Date.UTC(2026, 11, 1) - 1)).toBe(Date.UTC(2026, 10, 1));
    expect(anthropicMonthStart(Date.UTC(2026, 11, 1))).toBe(Date.UTC(2026, 11, 1));
    expect(anthropicNextReset(Date.UTC(2026, 11, 20))).toBe(Date.UTC(2027, 0, 1));
  });

  it("the month's spend counts Claude bouts, Moltbook replies and the house Sprint since the 1st, nothing earlier", async () => {
    const T = at(2027, 0);
    await spent(10, Date.UTC(2027, 0, 1)); // 00:00 UTC on the 1st: counts
    await spent(50, Date.UTC(2027, 0, 1) - 1); // the last millisecond of December: doesn't
    const e = await event("gpt-spend", "practice");
    await run(e, "gpt-6.1-sol", { status: "done", cost: 7, byokCost: null, finishedAt: T - 60_000 }); // not Claude
    await recordSpend(env.KV, "moltbook_replies", { anthropic_usd: 1.5 }, T - 3_600_000);
    await env.KV.put(houseSprintCostKey(T), "0.25");
    expect(await anthropicSpendThisMonth(env, T)).toMatchObject({ usd: 11.75, arena_usd: 10, moltbook_usd: 1.5, house_sprint_usd: 0.25, since: "2027-01-01", resets: "2027-02-01" });
  });

  it("claudeBudget: open under $90, paused at $90 exactly, and open again from the 1st", async () => {
    const T = at(2027, 1);
    await spent(ANTHROPIC_GUARD_USD - 0.01, Date.UTC(2027, 1, 2));
    expect(await claudeBudget(env, T)).toMatchObject({ paused: false, reason: null, spent_usd: 89.99, guard_usd: 90, limit_usd: 100, resets_on: "2027-03-01" });
    await spent(0.01, Date.UTC(2027, 1, 3));
    expect(await claudeBudget(env, T)).toMatchObject({ paused: true, reason: "budget", spent_usd: 90 });
    expect(await claudeBudget(env, Date.UTC(2027, 2, 1) - 1)).toMatchObject({ paused: true, reason: "budget" });
    expect(await claudeBudget(env, Date.UTC(2027, 2, 1))).toMatchObject({ paused: false, spent_usd: 0, resets_on: "2027-04-01" });
  });

  it("claudeBudget: the manual flag pauses whatever the spend; it fails closed when the spend can't be read", async () => {
    await env.KV.put(CLAUDE_PAUSED_KV, "1");
    expect(await claudeBudget(env, at(2027, 3))).toMatchObject({ paused: true, reason: "manual", spent_usd: 0 });
    await env.KV.delete(CLAUDE_PAUSED_KV);
    expect((await claudeBudget(env, at(2027, 3))).paused).toBe(false);
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); }, batch: () => { throw new Error("D1 down"); } } } as unknown as typeof env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await claudeBudget(broken, at(2027, 3))).toMatchObject({ paused: true, reason: "unavailable", spent_usd: null });
  });

  it("the cached figure (public note only) is used only within the same month and 30 minutes; start paths read fresh", async () => {
    const T = at(2027, 4);
    await env.KV.put(CLAUDE_SPEND_KV, JSON.stringify({ usd: 95, at: T - 60_000, month: "2027-05" }));
    expect((await claudeBudget(env, T, { cached: true })).paused).toBe(true);
    expect((await claudeBudget(env, T)).paused).toBe(false); // fresh: nothing stored this month
    await env.KV.put(CLAUDE_SPEND_KV, JSON.stringify({ usd: 95, at: T - 60_000, month: "2027-04" }));
    expect((await claudeBudget(env, T, { cached: true })).paused).toBe(false);
    await env.KV.put(CLAUDE_SPEND_KV, JSON.stringify({ usd: 95, at: T - 31 * 60_000, month: "2027-05" }));
    expect((await claudeBudget(env, T, { cached: true })).paused).toBe(false);
  });
});

describe("every path that starts a Claude bout waits at the guard (ADR 0147)", () => {
  /**
   * One Claude run in each kind of event the runner plays: the weekly headline (card), a ranked guest event, a held Lab
   * study (planned card), plain practice, the longitudinal panel (queued by queuePanel), a KV plan and a suspended bout
   * with a checkpoint (resume). Plus one GPT run, which must still play.
   */
  async function everyKind(T: number) {
    await env.KV.put(CREDIT_KV, JSON.stringify(snapshot(50, T)));
    const weekly = await event("weekly-2027-06-03", "card");
    const ids = {
      weekly: await run(weekly, SONNET),
      guest: await run(await event("guest-claude", "guest"), SONNET),
      held: await run(await event("lab-held", "card", "planned"), SONNET),
      practice: await run(await event("practice-claude", "practice"), "claude-haiku-5.5", { task: "FA-AMT-002", seed: 7 }),
      opus: await run(await event("opus-card", "card"), "claude-opus-5.5"),
      resume: await run(await event("resume-claude", "card"), SONNET, { checkpoint: { v: 1, attempt: {}, messages: [], ticks: 1 } as never }),
    };
    // The longitudinal panel runs on held-out seeds, which the public mirror doesn't carry (its panel is empty there).
    let panelRuns: (typeof t.arenaRuns.$inferSelect)["id"][] = [];
    if (longitudinalPanel().length) {
      const panel = await queuePanel(env, SONNET, "test", T);
      expect(panel.ok).toBe(true);
      panelRuns = (await getDb(env).select({ id: t.arenaRuns.id }).from(t.arenaRuns).innerJoin(t.arenaPanel, eq(t.arenaPanel.eventId, t.arenaRuns.eventId))).map((r) => r.id);
      expect(panelRuns.length).toBeGreaterThan(0);
    }
    await planEvent(env, { slug: "kv-plan-claude", name: "plan", season: "s0", kind: "guest", models: [SONNET], tasks: ["impossible"], seeds: [3], attempts: 1 });
    const planned = (await getDb(env).select({ id: t.arenaRuns.id }).from(t.arenaRuns).innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId)).where(eq(t.arenaEvents.slug, "kv-plan-claude"))).map((r) => r.id);
    const gpt = await run(weekly, "gpt-6.1-sol");
    return { claude: [...Object.values(ids), ...panelRuns, ...planned], gpt };
  }

  it("at $90 of the month's spend: every Claude run stays queued (checkpoint kept, never voided), no Claude call; GPT plays", async () => {
    const T = at(2027, 5);
    await spent(ANTHROPIC_GUARD_USD, Date.UTC(2027, 5, 2));
    const { claude, gpt } = await everyKind(T);
    const { f, models } = openRouter();
    const out = await processQueue(KEYED, T + 60_000, () => T, f);
    const rows = await statuses([...claude, gpt]);
    for (const id of claude) expect(rows[id]!.status, id).toBe("queued");
    for (const id of claude) expect(rows[id]!.voidReason, id).toBeNull();
    expect(Object.values(rows).find((r) => r.checkpoint)?.checkpoint).toBeTruthy();
    expect(rows[gpt]!.status).toBe("done");
    expect(models.some((m) => m.startsWith("anthropic/"))).toBe(false);
    expect(out.skipped).toContain("paused: claude budget");
    expect(out.pausedClaude).toBe(claude.length);
    expect(out.voided).toBe(0);
  });

  it("with the manual flag arena:claude-paused: the same, whatever the spend", async () => {
    const T = at(2027, 6);
    await env.KV.put(CLAUDE_PAUSED_KV, "yes");
    const { claude, gpt } = await everyKind(T);
    const { f, models } = openRouter();
    const out = await processQueue(KEYED, T + 60_000, () => T, f);
    const rows = await statuses([...claude, gpt]);
    for (const id of claude) expect(rows[id]!.status, id).toBe("queued");
    expect(rows[gpt]!.status).toBe("done");
    expect(models.some((m) => m.startsWith("anthropic/"))).toBe(false);
    expect(out.skipped).toContain("paused: claude manual");
  });

  it("under the guard the same runs play on our key (the guard is what held them)", async () => {
    const T = at(2027, 7);
    await spent(ANTHROPIC_GUARD_USD - 5, Date.UTC(2027, 7, 2));
    const e = await event("under-guard", "guest");
    const ids = [await run(e, SONNET), await run(e, "claude-opus-5.5")];
    const { f, models } = openRouter();
    const out = await processQueue(KEYED, T + 60_000, () => T, f);
    const rows = await statuses(ids);
    for (const id of ids) expect(rows[id]!.status).toBe("done");
    expect(models.every((m) => m.startsWith("anthropic/"))).toBe(true);
    expect(out.pausedClaude).toBe(0);
  });

  it("a Claude bout that takes the month to the guard mid-tick stops further Claude bouts that tick; the rest stay queued", async () => {
    const T = at(2027, 8);
    await spent(ANTHROPIC_GUARD_USD - 0.01, Date.UTC(2027, 8, 2));
    const e = await event("crossing", "guest");
    const ids: string[] = [];
    for (let s = 1; s <= 8; s++) ids.push(await run(e, SONNET, { seed: s }));
    const { f } = openRouter(0.02); // each bout: two BYOK turns at $0.02
    const out = await processQueue(KEYED, T + 60_000, () => T, f);
    const rows = Object.values(await statuses(ids));
    const done = rows.filter((r) => r.status === "done").length;
    expect(done).toBeGreaterThanOrEqual(1);
    expect(done).toBeLessThanOrEqual(3); // at most one bout per lane was already running
    expect(rows.filter((r) => r.status === "queued").length).toBe(8 - done);
    expect(rows.every((r) => r.status !== "void")).toBe(true);
    expect(out.skipped).toContain("paused: claude budget");
  });

  it("the cron tick (KV plan, then the queue): the plan is still queued, its Claude runs wait", async () => {
    await env.KV.put(CLAUDE_PAUSED_KV, "1");
    await env.KV.put("arena:plan", JSON.stringify({ slug: "tick-plan-claude", name: "tick", season: "s0", kind: "practice", models: [SONNET], tasks: ["FA-AMT-002"], seeds: [11], attempts: 1 }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ data: { usage: 1 } })) as never);
    const out = (await arenaTick(KEYED)) as Awaited<ReturnType<typeof processQueue>>;
    const runs = await getDb(env).select().from(t.arenaRuns).innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId)).where(eq(t.arenaEvents.slug, "tick-plan-claude"));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.arena_runs.status === "queued")).toBe(true);
    expect(out.skipped).toContain("paused: claude manual");
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/chat/completions"))).toEqual([]);
  });

  it("the free lane never queues a Claude model (its own caps; nothing on our key)", () => {
    const claude = new Set(claudeByokIds());
    expect(freeVariantModels().filter((m) => claude.has(m.id))).toEqual([]);
    expect(claudeByokIds().length).toBe(ALL_MODELS.filter((m) => m.route.kind === "openrouter" && m.route.provider.toLowerCase() === "anthropic").length);
  });

  it("the house Sprint (Gauntlet Sprint on Claude) is skipped, not marked done, so it plays once Claude is allowed", async () => {
    const T = at(2027, 9);
    const fetcher = vi.fn() as unknown as typeof fetch;
    await env.KV.put(CLAUDE_PAUSED_KV, "1");
    expect(await houseSprint(KEYED, T, fetcher)).toEqual({ skipped: "claude_paused" });
    await env.KV.delete(CLAUDE_PAUSED_KV);
    await spent(ANTHROPIC_GUARD_USD, Date.UTC(2027, 9, 1));
    expect(await houseSprint(KEYED, T, fetcher)).toEqual({ skipped: "claude_paused" });
    expect(await env.KV.get(`sprint:house:${new Date(T).toISOString().slice(0, 10)}`)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("outside the Arena: Moltbook replies drop Claude, and the ops checks (tool selection, Claude citations) are refused", async () => {
    const T = at(2027, 10);
    expect((await replyBrains(KEYED, vi.fn() as never, T)).length).toBe(2); // Claude, then Workers AI
    expect((await opsCallAllowed(KEYED, true, T)).ok).toBe(true);
    await spent(ANTHROPIC_GUARD_USD, Date.UTC(2027, 10, 1));
    expect((await replyBrains(KEYED, vi.fn() as never, T)).length).toBe(1); // Workers AI only
    expect((await opsCallAllowed(KEYED, true, T)).ok).toBe(false);
    await getDb(env).delete(t.arenaRuns);
    await env.KV.put(CLAUDE_PAUSED_KV, "1");
    expect((await replyBrains(KEYED, vi.fn() as never, T)).length).toBe(1);
    expect((await opsCallAllowed(KEYED, true, T)).ok).toBe(false);
    // The Claude citation model is the one the route sends through the Claude check.
    expect(citationOnClaude("claude")).toBe(true);
    expect(citationOnClaude("gpt")).toBe(false);
    expect(citationOnClaude("perplexity")).toBe(false);
  });
});
