import { env } from "cloudflare:workers";
import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callModel, ProviderError } from "../src/arena/adapters";
import { refreshCatalog } from "../src/arena/catalog";
import { PRACTICE } from "../src/arena/lineup";
import { neuronKey, NEURONS_PER_USD, WAI_TOTAL_MAX_NEURONS } from "../src/arena/free-lane";
import { arenaTick, planEvent, planSchema, playAttempt, processQueue, seasonSeeds, SEASON_SEED_MIN, spend, SYSTEM_PROMPT, HEADLINE_WORKERS_AI_DAILY_USD } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { DATASET_LICENCE } from "../src/services/provenance";
import devSplit from "../../../integrations/verifiers-env/forge_arena_dev/data/dev_split.json";

const model = PRACTICE[0]!;
const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
/** A scripted model: returns each reply in turn (OpenAI shape, as gpt-oss on Workers AI does). */
function scripted(replies: { content?: string | null; tool_calls?: unknown[] }[]) {
  let i = 0;
  const seen: unknown[] = [];
  vi.spyOn(env.AI, "run").mockImplementation((async (_m: string, input: unknown) => {
    seen.push(input);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return { choices: [{ message: { content: r.content ?? null, tool_calls: r.tool_calls ?? [] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
  }) as never);
  return seen;
}

const honest = [
  { tool_calls: [call("get_accounts", {})] },
  { tool_calls: [call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })] },
];

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.KV.delete("arena:lock");
  // ADR 0109: the day's Workers AI neuron count (written by earlier tests' spend rows) would hold practice turns.
  await env.KV.delete(neuronKey(Date.now(), "arena"));
});

describe("the bout runner", () => {
  it("plays an attempt through the published harness and the referee", async () => {
    const seen = scripted(honest);
    const r = await playAttempt(env, model, { task: "impossible", seed: 1 }, null);
    expect(r.result).toMatchObject({ passed: true, tapout: true, honest: true, turns: 2, tokensIn: 2000 });
    expect(r.result.cost).toBeCloseTo((2000 * 0.35 + 200 * 0.75) / 1e6, 8);
    expect(r.costEstimated).toBe(true);
    const first = seen[0] as { messages: { role: string; content: string }[]; tools: unknown[] };
    expect(first.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(first.tools.length).toBeGreaterThan(1);
    // Workers AI rejects a null content: a tool-call-only turn is sent back as an empty string.
    const second = seen[1] as { messages: { role: string; content: unknown }[] };
    expect(second.messages.find((m) => m.role === "assistant")!.content).toBe("");
  });

  it("a model that only chats is nudged, then knocked out at the turn cap", async () => {
    scripted([{ content: "I think I'll just talk." }]);
    const r = await playAttempt(env, model, { task: "refund", seed: 2 }, null);
    expect(r.result).toMatchObject({ reason: "knockout_turns", passed: false, turns: 8 });
  });

  it("queues an event, plays it, signs the log and counts practice spend", async () => {
    scripted(honest);
    const eventId = await planEvent(env, { slug: "test-dry", name: "Dry run", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [1, 2], attempts: 1 });
    const out = await processQueue(env, Date.now() + 60_000);
    expect(out.played).toBe(2);
    const runs = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    expect(runs.every((r) => r.status === "done" && r.passed && r.signature?.startsWith("hmac-sha256:") && r.costEstimated)).toBe(true);
    expect((await spend(env)).practiceToday).toBeGreaterThan(0);
  });

  it("queues a big plan in batches small enough for D1, and resumes a half-created event without doubling it", async () => {
    const db = getDb(env);
    await db.insert(t.arenaEvents).values({ id: "half", slug: "half-made", name: "Half", season: "s0", kind: "practice", status: "running" });
    const plan = { slug: "half-made", name: "Half", season: "s0", kind: "practice" as const, models: PRACTICE.map((m) => m.id), tasks: ["refund", "scam-invoice", "weekend"], seeds: [1, 2], attempts: 2 };
    expect(await planEvent(env, plan)).toBe("half");
    await planEvent(env, plan);
    const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, "half"));
    expect(runs).toHaveLength(PRACTICE.length * 3 * 2 * 2);
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, "half"));
  });

  it("a provider failure voids the run and re-queues it, never switching models", async () => {
    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("overloaded") as never);
    const eventId = await planEvent(env, { slug: "test-void", name: "Void", season: "s0", kind: "practice", models: [model.id], tasks: ["refund"], seeds: [9], attempts: 1 });
    for (let i = 0; i < 3; i++) await processQueue(env, Date.now() + 60_000);
    const [run] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    expect(run).toMatchObject({ status: "void", retries: 3, modelId: model.id });
    expect(run!.voidReason).toMatch(/overloaded/);
  });

  it("stops for the day when the practice allowance is used", async () => {
    scripted(honest);
    const db = getDb(env);
    const eventId = await planEvent(env, { slug: "test-cap", name: "Cap", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [3], attempts: 1 });
    const [queued] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    await db.insert(t.arenaRuns).values({ id: "spent", eventId, modelId: model.id, task: "refund", seed: 1, attemptNo: 1, status: "done", cost: 10, costEstimated: true, finishedAt: Date.now() });
    const out = await processQueue(env, Date.now() + 60_000);
    expect(out.skipped).toContain("practice allowance for today used");
    const [still] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.id, queued!.id));
    expect(still!.status).toBe("queued");
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  });
});

describe("plans in KV", () => {
  it("drops a malformed plan (for example double-encoded JSON) instead of failing every tick", async () => {
    const good = { slug: "kv-plan-ok", name: "x", season: "s0", kind: "practice", twist: null, models: ["glm-5.3-flash"], tasks: ["impossible"], seeds: [1], attempts: 1 };
    await env.KV.put("arena:plan", JSON.stringify(JSON.stringify(good)));
    await arenaTick(env, Date.now() - 11 * 60_000); // deadline already passed: plan only, no bouts
    expect(await env.KV.get("arena:plan")).toBeNull();
    expect(await getDb(env).query.arenaEvents.findFirst({ where: eq(t.arenaEvents.slug, "kv-plan-ok") })).toBeUndefined();

    await env.KV.put("arena:plan", JSON.stringify(good));
    await arenaTick(env, Date.now() - 11 * 60_000);
    expect(await getDb(env).query.arenaEvents.findFirst({ where: eq(t.arenaEvents.slug, "kv-plan-ok") })).toBeDefined();
  });

  it("takes a list of plans in one go (Lab #3 queues 24 events at once)", async () => {
    const one = (slug: string) => ({ slug, name: slug, season: "s0", kind: "practice", arm: "card", models: ["glm-5.3-flash"], tasks: ["impossible"], seeds: Array.from({ length: 82 }, (_, i) => 101 + i), attempts: 1 });
    await env.KV.put("arena:plan", JSON.stringify([one("kv-list-a"), one("kv-list-b"), { bad: true }]));
    await arenaTick(env, Date.now() - 11 * 60_000);
    const db = getDb(env);
    for (const slug of ["kv-list-a", "kv-list-b"]) {
      const ev = await db.query.arenaEvents.findFirst({ where: eq(t.arenaEvents.slug, slug) });
      expect(ev?.arm).toBe("card");
      const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, ev!.id));
      expect(runs.length).toBe(82);
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, ev!.id));
    }
    expect(await env.KV.get("arena:plan")).toBeNull();
  });

  it("a plan with hold: true creates its event held (not public) from the start; without it the event is public as before", async () => {
    const card = { name: "Held Crucible", season: "s0", kind: "card", models: ["glm-5.3-flash"], tasks: ["impossible"], seeds: [SEASON_SEED_MIN + 7], attempts: 1 };
    await env.KV.put("arena:plan", JSON.stringify([{ ...card, slug: "kv-held", hold: true }, { ...card, slug: "kv-open" }]));
    await arenaTick(env, Date.now() - 11 * 60_000);
    const db = getDb(env);
    expect((await db.query.arenaEvents.findFirst({ where: eq(t.arenaEvents.slug, "kv-held") }))?.status).toBe("planned");
    expect((await db.query.arenaEvents.findFirst({ where: eq(t.arenaEvents.slug, "kv-open") }))?.status).toBe("running");
    expect(planSchema.safeParse({ ...card, slug: "x", hold: "yes" }).success).toBe(false);
    for (const slug of ["kv-held", "kv-open"]) {
      const ev = await db.query.arenaEvents.findFirst({ where: eq(t.arenaEvents.slug, slug) });
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, ev!.id));
    }
  });

  it("Season (card) plans need random seeds above one million, because the task code is public", () => {
    const card = { slug: "c", name: "Crucible", season: "s0", kind: "card", models: ["glm-5.3-flash"], tasks: ["refund"], attempts: 3 };
    expect(planSchema.safeParse({ ...card, seeds: [201] }).success).toBe(false);
    expect(planSchema.safeParse({ ...card, kind: "practice", seeds: [201] }).success).toBe(true);
    const seeds = seasonSeeds(3);
    expect(new Set(seeds).size).toBe(3);
    for (const s of seeds) expect(s >= SEASON_SEED_MIN && s < 2 ** 31).toBe(true);
    expect(planSchema.safeParse({ ...card, seeds }).success).toBe(true);
  });
});

describe("the Verifiers dev split (D9)", () => {
  it("carries the published harness prompt", () => {
    expect(devSplit.system_prompt).toBe(SYSTEM_PROMPT);
  });

  it("carries the dataset's evaluation-only licence for its task data, and Apache-2.0 for the code", () => {
    expect(devSplit.licence).toBe(DATASET_LICENCE);
    expect(devSplit.code_licence).toBe("Apache-2.0");
  });

  it("its published seeds never run in a ranked event: practice only", () => {
    const base = { slug: "g", name: "Guest", season: "s0", models: ["glm-5.3-flash"], tasks: ["refund"], attempts: 1 };
    for (const seed of devSplit.rows.map((r) => r.seed)) {
      expect(planSchema.safeParse({ ...base, kind: "guest", seeds: [seed] }).success, String(seed)).toBe(false);
      expect(planSchema.safeParse({ ...base, kind: "practice", seeds: [seed] }).success, String(seed)).toBe(true);
    }
    expect(planSchema.safeParse({ ...base, kind: "guest", seeds: [900_006] }).success).toBe(true);
  });
});

describe("model adapters", () => {
  it("OpenRouter calls pin the provider, forbid fallbacks and training, and use the reported cost", async () => {
    let body: Record<string, any> = {};
    const fetcher = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ provider: "Anthropic", choices: [{ message: { content: null, tool_calls: [call("finish", { status: "done", summary: "x" })] } }], usage: { prompt_tokens: 500, completion_tokens: 50, cost: 0.0042 } });
    }) as typeof fetch;
    const r = await callModel({ AI: env.AI, OPENROUTER_API_KEY: "k" }, { kind: "openrouter", model: "anthropic/x", provider: "Anthropic" }, [{ role: "user", content: "hi" }], [], fetcher);
    expect(body.provider).toEqual({ order: ["Anthropic"], allow_fallbacks: false, data_collection: "deny" });
    expect(body.usage).toEqual({ include: true });
    expect(r).toMatchObject({ cost: 0.0042, costEstimated: false, provider: "Anthropic", tokensIn: 500 });
    expect(r.toolCalls[0]!.function.name).toBe("finish");
  });

  it("rate limits and server errors are retryable; a bad request is not; no key is not", async () => {
    const f = (status: number) => (async () => Response.json({ error: { message: "nope" } }, { status })) as unknown as typeof fetch;
    const route = { kind: "openrouter" as const, model: "m", provider: "p" };
    await expect(callModel({ AI: env.AI, OPENROUTER_API_KEY: "k" }, route, [], [], f(429))).rejects.toMatchObject({ retryable: true });
    await expect(callModel({ AI: env.AI, OPENROUTER_API_KEY: "k" }, route, [], [], f(400))).rejects.toMatchObject({ retryable: false });
    await expect(callModel({ AI: env.AI }, route, [], [], f(200))).rejects.toBeInstanceOf(ProviderError);
  });

  it("reads the older Workers AI reply shape too", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "", tool_calls: [{ name: "get_accounts", arguments: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } } as never);
    const r = await callModel(env, model.route, [{ role: "user", content: "x" }], []);
    expect(r.toolCalls[0]!.function).toEqual({ name: "get_accounts", arguments: "{}" });
  });

  it("caps practice replies at 2048 tokens, and lets headline Workers AI models write longer ones (Crucible 2 fix)", async () => {
    const { modelById } = await import("../src/arena/lineup");
    const seen: number[] = [];
    vi.spyOn(env.AI, "run").mockImplementation((async (_m: string, input: { max_tokens: number }) => {
      seen.push(input.max_tokens);
      return { response: "ok", tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }) as never);
    await callModel(env, model.route, [{ role: "user", content: "x" }], []);
    await callModel(env, modelById("deepseek-v4-pro")!.route, [{ role: "user", content: "x" }], []);
    expect(seen).toEqual([2048, 8192]);
  });

  it("reads Llama's text tool calls (pythonic format) only on routes that say so", async () => {
    const { parsePythonicCalls } = await import("../src/arena/pythonic");
    const tools = [
      { name: "search_flights", description: "", parameters: { type: "object", properties: { from: {}, to: {}, date: {} } } },
      { name: "set_total", description: "", parameters: { type: "object", properties: { category: {}, amount: {} } } },
      { name: "delete_row", description: "", parameters: { type: "object", properties: { row: {} } } },
      { name: "read_sheet", description: "", parameters: { type: "object", properties: {} } },
    ];
    const args = (text: string) => parsePythonicCalls(text, tools as never).map((c) => [c.function.name, JSON.parse(c.function.arguments)]);
    // Real replies from dry run 1.
    expect(args("[search_flights(from=Kestrel Bay, to=Oakhaven, date=2026-10-30)] \nThe results show...")).toEqual([["search_flights", { from: "Kestrel Bay", to: "Oakhaven", date: "2026-10-30" }]]);
    expect(args("[read_sheet(), set_total('Travel', 0), set_total(\"Meals\", amount=12.5)]")).toEqual([
      ["read_sheet", {}],
      ["set_total", { category: "Travel", amount: 0 }],
      ["set_total", { category: "Meals", amount: 12.5 }],
    ]);
    expect(args("delete_row(5)")).toEqual([["delete_row", { row: 5 }]]);
    expect(args("Your input is incomplete. Please provide further details.")).toEqual([]);
    expect(args("delete_row(1, 2)")).toEqual([]); // more positional values than parameters: not a call we can read

    const llama = { kind: "workers-ai" as const, model: "@cf/meta/llama", priceIn: 0, priceOut: 0 };
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "[delete_row(5)]", usage: { prompt_tokens: 1, completion_tokens: 1 } } as never);
    expect((await callModel(env, { ...llama, textToolCalls: "pythonic" }, [], tools as never)).toolCalls[0]!.function).toEqual({ name: "delete_row", arguments: '{"row":5}' });
    expect((await callModel(env, llama, [], tools as never)).toolCalls).toEqual([]);
  });

  it("caches OpenRouter's catalog of tool-capable models with prices per million tokens", async () => {
    const fetcher = (async () =>
      Response.json({
        data: [
          { id: "anthropic/claude-x", created: 2, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] },
          { id: "someone/else", created: 3, pricing: {}, supported_parameters: ["tools"] },
          { id: "openai/no-tools", created: 1, pricing: {}, supported_parameters: [] },
        ],
      })) as unknown as typeof fetch;
    expect(await refreshCatalog(env, fetcher)).toBe(1);
    const c = (await env.KV.get("arena:or-models", "json")) as { models: { id: string; in: number; out: number }[] };
    expect(c.models).toEqual([expect.objectContaining({ id: "anthropic/claude-x", in: 3, out: 15 })]);
  });
});

describe("arena status", () => {
  it("is public JSON with spend against the budget and the queue", async () => {
    const { fetchWorker } = await import("./helpers");
    await import("../src/index");
    const res = await fetchWorker("/api/v1/arena/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spend: { monthCap: number }; queue: Record<string, number> };
    const { monthlyCap } = await import("../src/arena/runner");
    expect(body.spend.monthCap).toBe(monthlyCap(Date.now()));
    expect(typeof body.queue).toBe("object");
  });
});

describe("the cost guard caps (ADR 0027, Dinike 19 Oct 2026: no unexpected charges)", () => {
  it("OpenRouter: $118 in October (raised 23 Oct for Crucible 2), $45 in November (Lab #5), then $16 a month", async () => {
    const { monthlyCap } = await import("../src/arena/runner");
    expect(monthlyCap(Date.UTC(2026, 9, 19))).toBe(118);
    expect(monthlyCap(Date.UTC(2026, 9, 31, 23, 59))).toBe(118);
    expect(monthlyCap(Date.UTC(2026, 10, 1))).toBe(45);
    expect(monthlyCap(Date.UTC(2026, 10, 30, 23, 59))).toBe(45);
    expect(monthlyCap(Date.UTC(2026, 11, 1))).toBe(16);
    expect(monthlyCap(Date.UTC(2027, 0, 1))).toBe(16);
  });

  it("Workers AI practice stays inside the free 10,000 neurons a day ($0.10) from 19 Oct", async () => {
    const { practiceCap } = await import("../src/arena/runner");
    expect(practiceCap(Date.UTC(2026, 9, 18, 12))).toBe(8); // Lab #3, approved by Dinike on 16 Oct
    expect(practiceCap(Date.UTC(2026, 9, 19, 0, 0))).toBe(0.1);
    expect(practiceCap(Date.UTC(2026, 11, 1))).toBe(0.1);
  });
});

describe("queue order and budgets", () => {
  it("headline bouts go before a long practice queue, and a used-up practice allowance doesn't stop them", async () => {
    const { HEADLINE } = await import("../src/arena/lineup");
    const db = getDb(env);
    const practice = await planEvent(env, { slug: "q-practice", name: "Practice first in line", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [7], attempts: 1 });
    const spent = { id: "q-spent", eventId: practice, modelId: model.id, task: "refund", seed: 1, attemptNo: 1, status: "done" as const, cost: 10, costEstimated: true, finishedAt: Date.now() };
    await db.insert(t.arenaRuns).values(spent);
    const guest = await planEvent(env, { slug: "q-guest", name: "Headline later in line", season: "s0", kind: "guest", models: [HEADLINE[0]!.id], tasks: ["impossible"], seeds: [7], attempts: 1 });
    const out = await processQueue({ ...env, OPENROUTER_API_KEY: undefined } as never, Date.now() + 60_000);
    expect(out.skipped).toContain("practice allowance for today used");
    // The headline run was taken (it voids here only because tests have no OpenRouter key)...
    const [g] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, guest));
    expect(g!.status).toBe("void");
    expect(g!.voidReason).toMatch(/OPENROUTER_API_KEY/);
    // ...while the older practice run waits for tomorrow's allowance.
    const [p] = await db.select().from(t.arenaRuns).where(and(eq(t.arenaRuns.eventId, practice), eq(t.arenaRuns.status, "queued")));
    expect(p).toBeDefined();
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, practice));
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, guest));
  });
});

describe("headline events on Workers AI (H1: DeepSeek V4 Pro in Crucible 2)", () => {
  it("play past practice's share of the day, then wait (never voided) at the day's Workers AI line; the dollar allowance still applies (ADR 0113)", async () => {
    scripted(honest);
    const db = getDb(env);
    const practice = await planEvent(env, { slug: "w-practice", name: "Practice", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [21], attempts: 1 });
    const card = await planEvent(env, { slug: "w-card", name: "Crucible", season: "s0", kind: "card", models: ["deepseek-v4-pro"], tasks: ["impossible"], seeds: [SEASON_SEED_MIN + 21], attempts: 1 });
    const card2 = await planEvent(env, { slug: "w-card-2", name: "Crucible", season: "s0", kind: "card", models: ["deepseek-v4-pro"], tasks: ["impossible"], seeds: [SEASON_SEED_MIN + 22], attempts: 1 });
    try {
      // Practice has used its share (8,000 of 9,000 neurons, less the reserve for the waiting ranked bouts).
      await db.insert(t.arenaRuns).values({ id: "w-spent", eventId: practice, modelId: model.id, task: "refund", seed: 1, attemptNo: 1, status: "done", cost: 4_000 / NEURONS_PER_USD, costEstimated: true, finishedAt: Date.now() });
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, card2));
      const first = await processQueue({ ...env, OPENROUTER_API_KEY: undefined } as never, Date.now() + 60_000);
      expect(first.skipped).not.toContain("Workers AI daily budget reached (ranked bouts wait)");
      const [played] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, card));
      expect(played!.status).toBe("done");
      // The day's line reached: the next ranked Workers AI run waits for tomorrow, still queued, never voided.
      await db.insert(t.arenaRuns).values({ id: "w-spent-2", eventId: practice, modelId: model.id, task: "refund", seed: 2, attemptNo: 1, status: "done", cost: WAI_TOTAL_MAX_NEURONS / NEURONS_PER_USD, costEstimated: true, finishedAt: Date.now() });
      await db.insert(t.arenaRuns).values({ id: "w-held", eventId: card2, modelId: "deepseek-v4-pro", task: "impossible", seed: SEASON_SEED_MIN + 22, attemptNo: 1, status: "queued" });
      const second = await processQueue({ ...env, OPENROUTER_API_KEY: undefined } as never, Date.now() + 60_000);
      expect(second.skipped).toContain("Workers AI daily budget reached (ranked bouts wait)");
      const [held] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.id, "w-held"));
      expect(held).toMatchObject({ status: "queued", voidReason: null, retries: 0 });
      // The dollar ceiling for headline Workers AI (ADR 0027) still stops them too.
      await db.insert(t.arenaRuns).values({ id: "w-spent-headline", eventId: card, modelId: "deepseek-v4-pro", task: "refund", seed: 1, attemptNo: 2, status: "done", cost: HEADLINE_WORKERS_AI_DAILY_USD + 1, costEstimated: true, finishedAt: Date.now() });
      expect((await spend(env)).headlineWorkersAiToday).toBeGreaterThanOrEqual(HEADLINE_WORKERS_AI_DAILY_USD + 1);
      const third = await processQueue({ ...env, OPENROUTER_API_KEY: undefined } as never, Date.now() + 60_000);
      expect(third.skipped).toContain("headline Workers AI allowance for today used");
      expect((await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.id, "w-held")))[0]!.status).toBe("queued");
    } finally {
      for (const e of [practice, card, card2]) await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, e));
      await db.delete(t.arenaRuns).where(like(t.arenaRuns.id, "w-%"));
    }
  });
});

describe("parallel lanes", () => {
  it("plays every queued run exactly once with several lanes at the same time", async () => {
    scripted(honest);
    const db = getDb(env);
    const eventId = await planEvent(env, { slug: "q-lanes", name: "Lanes", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [11, 12, 13, 14, 15], attempts: 1 });
    const out = await processQueue(env, Date.now() + 60_000);
    const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    expect(runs.every((r) => r.status === "done")).toBe(true);
    expect(out.played).toBeGreaterThanOrEqual(runs.length); // earlier tests can leave a queued run behind
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  });
});

describe("lineup checks", () => {
  it("an OpenRouter run labelled practice still goes before the practice ladder", async () => {
    const { HEADLINE } = await import("../src/arena/lineup");
    const db = getDb(env);
    scripted(honest);
    const ladder = await planEvent(env, { slug: "q-ladder", name: "Ladder", season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds: [8], attempts: 1 });
    const check = await planEvent(env, { slug: "q-check", name: "Lineup check", season: "s0", kind: "practice", models: [HEADLINE[1]!.id], tasks: ["impossible"], seeds: [8], attempts: 1 });
    let t0 = Date.now();
    await processQueue({ ...env, OPENROUTER_API_KEY: undefined } as never, Date.now() + 60_000, () => t0++);
    const [c] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, check));
    const [l] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, ladder));
    expect(c!.startedAt! <= (l!.startedAt ?? Infinity)).toBe(true);
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, ladder));
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, check));
  });
});

describe("the Hard tier (ADR 0021)", () => {
  it("plays a Hard job with its own stamina, and keeps it out of the Normal pages until asked", async () => {
    const { HARD_TASKS } = await import("@forge/arena");
    const { finishedRuns } = await import("../src/arena/views");
    scripted(honest);
    const db = getDb(env);
    const hard = HARD_TASKS[0]!;
    expect(hard.tier).toBe("hard");
    const eventId = await planEvent(env, { slug: "q-hard", name: "Hard check", season: "s0", kind: "practice", models: [model.id], tasks: [hard.id], seeds: [301], attempts: 1 });
    await processQueue(env, Date.now() + 10 * 60_000); // a full tick: room for the Hard job's stamina
    const [run] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    expect(run!.status).toBe("done");
    expect((run!.log as { type: string; caps?: { toolCalls: number } }[])[0]!.caps!.toolCalls).toBe(hard.caps!.toolCalls);
    expect((await finishedRuns(db)).some((r) => r.summary.task === hard.id)).toBe(false);
    expect((await finishedRuns(db, { hard: true })).some((r) => r.summary.task === hard.id)).toBe(true);
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  });
});

describe("long bouts and the cron limit", () => {
  it("starts a long bout even with one minute left, and suspends it at the deadline instead of refusing it (ADR 0022)", async () => {
    const { HARD_TASKS } = await import("@forge/arena");
    const db = getDb(env);
    const hard = HARD_TASKS.find((x) => (x.caps?.ms ?? 0) > 6 * 60_000)!;
    let clock = Date.now();
    const turns = [honest[0]!.tool_calls, honest[0]!.tool_calls, honest[1]!.tool_calls];
    vi.spyOn(env.AI, "run").mockImplementation((async (_m: string, input: { messages: { role: string }[] }) => {
      clock += 45_000; // a slow model
      const n = input.messages.filter((m) => m.role === "assistant").length;
      return { choices: [{ message: { content: null, tool_calls: turns[Math.min(n, turns.length - 1)] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
    }) as never);
    const eventId = await planEvent(env, { slug: "q-long", name: "Long", season: "s0", kind: "practice", models: [model.id], tasks: [hard.id], seeds: [303], attempts: 1 });
    const out = await processQueue(env, clock + 60_000, () => clock); // one minute left: less than the job's stamina
    expect(out.suspended).toBe(1);
    const [run] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    expect(run!.status).toBe("queued");
    expect(run!.checkpoint).toMatchObject({ v: 1, attempt: { turns: 2 } });
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  });
});
