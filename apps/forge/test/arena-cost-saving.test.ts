import { env } from "cloudflare:workers";
import { HARD3_TASKS, TASKS, type LogEvent, type ToolSpec } from "@forge/arena";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheHint, callModel, openRouterBody, type ChatMessage } from "../src/arena/adapters";
import { lastHeadlineSlot, weeklyTask } from "../src/arena/headline-slot";
import { ALL_MODELS, modelById, PRACTICE } from "../src/arena/lineup";
import { arenaTick, planEvent, playAttempt, processQueue, PROMPT_CACHE_FROM, promptCacheOn, rulesInForceSince, solvedPairs, SYSTEM_PROMPT } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";

// S1 (acquisition-build-framework §3, approved 23 Oct): spend less per run. Prompt caching where a provider supports
// it, with the model's input unchanged; no more plain practice on a job a model has already got right 3 of 3; and
// Hard v3 only inside planned events.

const db = getDb(env);
const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const honest = [
  { tool_calls: [call("get_accounts", {})] },
  { tool_calls: [call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })] },
];
/**
 * A scripted Workers AI model that also records the options (third argument) of each call. It replies by how many
 * turns the chat it's sent has had, so bouts played side by side in different lanes each follow the script.
 */
function scripted(replies: { tool_calls?: unknown[] }[], usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 100 }) {
  const seen: { model: string; input: { messages: ChatMessage[] }; options: unknown }[] = [];
  vi.spyOn(env.AI, "run").mockImplementation((async (m: string, input: { messages: ChatMessage[] }, options?: unknown) => {
    seen.push({ model: m, input: structuredClone(input), options });
    const turn = input.messages.filter((x) => x.role === "assistant").length;
    const r = replies[Math.min(turn, replies.length - 1)]!;
    return { choices: [{ message: { content: null, tool_calls: r.tool_calls ?? [] } }], usage };
  }) as never);
  return seen;
}

/** A bout's chat partway through: harness prompt, brief, a tool call and its result, a nudge. */
const CHAT: ChatMessage[] = [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: "Refund the customer for the damaged items only. Ünïcode, quotes \" and newlines\nstay as they are." },
  { role: "assistant", content: "", tool_calls: [call("list_tickets", {}, "c1")] as never },
  { role: "tool", tool_call_id: "c1", content: '{"tickets":[1,2,3]}' },
  { role: "user", content: "Please continue: use the tools, and call finish when you're done." },
];
const TOOLS: ToolSpec[] = [{ name: "list_tickets", description: "List tickets", parameters: { type: "object", properties: {} } }];
/** The text of every message, in order, however its content is shaped. */
const texts = (ms: { role: string; content?: unknown }[]) =>
  ms.map((m) => [m.role, typeof m.content === "string" || m.content === null ? m.content : (m.content as { text: string }[]).map((p) => p.text).join("")]);

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.KV.delete("arena:lock");
});

describe("prompt caching (S1)", () => {
  it("Anthropic routes get one top-level cache hint and the messages are sent exactly as they are", () => {
    const r = modelById("claude-sonnet-5.5")!.route;
    if (r.kind !== "openrouter") throw new Error("expected an OpenRouter route");
    const { hint, body } = openRouterBody(r, CHAT, TOOLS, {});
    expect(hint).toBe("top-level");
    expect((body as Record<string, unknown>).cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(body.messages)).toBe(JSON.stringify(CHAT));
    expect(JSON.stringify(body.messages)).not.toContain("cache_control");
  });

  it("Alibaba (Qwen) gets an explicit breakpoint on the brief, with the brief's text unchanged", () => {
    const r = modelById("qwen3.8-max")!.route;
    if (r.kind !== "openrouter") throw new Error("expected an OpenRouter route");
    const { hint, body } = openRouterBody(r, CHAT, TOOLS, {});
    expect(hint).toBe("brief-breakpoint");
    expect(body.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: CHAT[1]!.content, cache_control: { type: "ephemeral" } }] });
    // Every other message is the very same object, and every message's text is identical.
    for (const i of [0, 2, 3, 4]) expect(body.messages[i]).toBe(CHAT[i]);
    expect(texts(body.messages)).toEqual(texts(CHAT));
    expect("cache_control" in body).toBe(false);
  });

  it("providers that cache by themselves (OpenAI, Google, DeepSeek, Mistral) get no cache hint at all", () => {
    for (const id of ["gpt-6.1-sol", "gemini-4-argon", "mistral-large-4", "gpt-5.6-luna", "deepseek-v4.1-flash", "gemini-3.8-flash"]) {
      const r = modelById(id)!.route;
      if (r.kind !== "openrouter") throw new Error(`${id}: expected an OpenRouter route`);
      expect(cacheHint(r)).toBe("none");
      const { body } = openRouterBody(r, CHAT, TOOLS, {});
      expect(JSON.stringify(body)).not.toContain("cache_control");
      expect(JSON.stringify(body.messages)).toBe(JSON.stringify(CHAT));
    }
  });

  it("with caching off, no route carries a cache hint; with it on, no route's text changes", () => {
    for (const m of ALL_MODELS) {
      if (m.route.kind !== "openrouter") {
        expect(cacheHint(m.route)).toBe("none");
        continue;
      }
      const off = openRouterBody(m.route, CHAT, TOOLS, null);
      expect(JSON.stringify(off.body)).not.toContain("cache_control");
      expect(JSON.stringify(off.body.messages)).toBe(JSON.stringify(CHAT));
      const on = openRouterBody(m.route, CHAT, TOOLS, {});
      expect(texts(on.body.messages)).toEqual(texts(CHAT));
      // Everything but the hint is the same request.
      const { cache_control: _hint, messages: _m, ...rest } = on.body as Record<string, unknown>;
      const { messages: _m2, ...restOff } = off.body as Record<string, unknown>;
      expect(rest).toEqual(restOff);
    }
  });

  it("records cached-token counts and keeps OpenRouter's billed cost", async () => {
    let sent: Record<string, unknown> = {};
    const fetcher = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        provider: "Anthropic",
        choices: [{ message: { content: "ok", tool_calls: [] } }],
        usage: { prompt_tokens: 12_000, completion_tokens: 80, cost: 0.0051, prompt_tokens_details: { cached_tokens: 11_000, cache_write_tokens: 900 } },
      });
    }) as typeof fetch;
    const r = await callModel({ AI: env.AI, OPENROUTER_API_KEY: "k" }, modelById("claude-sonnet-5.5")!.route, CHAT, TOOLS, fetcher, {});
    expect(sent.cache_control).toEqual({ type: "ephemeral" });
    expect(r).toMatchObject({ tokensIn: 12_000, cachedTokens: 11_000, cacheWriteTokens: 900, cost: 0.0051, costEstimated: false });
  });

  it("if a provider refuses the cache hint, the same request goes again without it, and later calls skip it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(b);
      if (JSON.stringify(b).includes("cache_control")) return Response.json({ error: { message: "unknown field cache_control" } }, { status: 400 });
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.001 } });
    }) as typeof fetch;
    const r = { kind: "openrouter" as const, model: "qwen/test-refuses-cache", provider: "alibaba" };
    await callModel({ AI: env.AI, OPENROUTER_API_KEY: "k" }, r, CHAT, TOOLS, fetcher, {});
    await callModel({ AI: env.AI, OPENROUTER_API_KEY: "k" }, r, CHAT, TOOLS, fetcher, {});
    expect(bodies.map((b) => JSON.stringify(b).includes("cache_control"))).toEqual([true, false, false]);
    expect(texts(bodies[1]!.messages as ChatMessage[])).toEqual(texts(CHAT));
  });

  it("Workers AI calls carry a session-affinity key (prefix caching) only when caching is on, with the same input", async () => {
    const seen = scripted([{ tool_calls: [] }], { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } });
    const m = PRACTICE.find((x) => x.id === "glm-5.3-flash")!;
    const on = await callModel(env, m.route, CHAT, TOOLS, fetch, { key: "run-1" });
    await callModel(env, m.route, CHAT, TOOLS);
    expect(seen[0]!.options).toEqual({ extraHeaders: { "x-session-affinity": "run-1" } });
    expect(seen[1]!.options).toBeUndefined();
    expect(seen[0]!.input).toEqual(seen[1]!.input);
    expect(on).toMatchObject({ cachedTokens: 40, costEstimated: true });
    // Still estimated at the full input price: it overstates, so the daily allowances stop early, never late.
    expect(on.cost).toBeCloseTo((50 * 0.15 + 5 * 0.5) / 1e6, 10);
  });

  it("a bout logs the cached tokens of each turn, and the token cap still counts every input token", async () => {
    scripted(honest, { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } });
    const r = await playAttempt(env, PRACTICE[0]!, { task: "impossible", seed: 1 }, null);
    const turns = r.log.filter((e): e is Extract<LogEvent, { type: "turn" }> => e.type === "turn");
    expect(turns.map((x) => x.cachedTokens)).toEqual([900, 900]);
    expect(r.result.tokensIn).toBe(2000);
  });

  it("is on for practice, and for ranked events only if queued after it started, so a running event stays alike", () => {
    expect(promptCacheOn({ kind: "practice", createdAt: 0 })).toBe(true);
    expect(promptCacheOn({ kind: "card", createdAt: PROMPT_CACHE_FROM - 1 })).toBe(false);
    expect(promptCacheOn({ kind: "guest", createdAt: PROMPT_CACHE_FROM - 1 })).toBe(false);
    expect(promptCacheOn({ kind: "card", createdAt: PROMPT_CACHE_FROM })).toBe(true);
  });

  it("the runner turns it on per event: every model in one event gets the same setting", async () => {
    const seen = scripted(honest);
    const deepseek = modelById("deepseek-v4-pro")!; // a headline model on Workers AI
    await db.insert(t.arenaEvents).values([
      { id: "ev-old-card", slug: "old-card", name: "Old card", season: "s0", kind: "card", status: "running", createdAt: PROMPT_CACHE_FROM - 86_400_000 },
      { id: "ev-new-card", slug: "new-card", name: "New card", season: "s0", kind: "card", status: "running", createdAt: PROMPT_CACHE_FROM + 1 },
    ]);
    await db.insert(t.arenaRuns).values([
      { id: "run-old", eventId: "ev-old-card", modelId: deepseek.id, task: "impossible", seed: 1_000_001, attemptNo: 1, status: "queued" },
      { id: "run-new", eventId: "ev-new-card", modelId: deepseek.id, task: "impossible", seed: 1_000_001, attemptNo: 1, status: "queued" },
    ]);
    await processQueue(env, Date.now() + 60_000);
    const byRun = (key: string | undefined) => seen.filter((s) => (s.options as { extraHeaders?: Record<string, string> } | undefined)?.extraHeaders?.["x-session-affinity"] === key);
    expect(byRun("run-new").length).toBe(2);
    expect(byRun("run-old").length).toBe(0);
    expect(seen.filter((s) => s.options === undefined).length).toBe(2); // the old card's two turns
    await db.delete(t.arenaRuns).where(inArray(t.arenaRuns.eventId, ["ev-old-card", "ev-new-card"]));
  });
});

describe("no more plain practice on a job a model has already got right 3 of 3 (S1)", () => {
  const m = PRACTICE[0]!.id;
  /** Finished runs of `m` at one task and seed, in a new event. */
  async function history(id: string, task: string, seed: number, passed: boolean[], ev: Partial<typeof t.arenaEvents.$inferInsert> = {}, finishedAt = Date.now()) {
    await db.insert(t.arenaEvents).values({ id, slug: id, name: id, season: "s0", kind: "practice", status: "running", ...ev });
    await db.insert(t.arenaRuns).values(passed.map((p, i) => ({ id: `${id}-${i}`, eventId: id, modelId: m, task, seed, attemptNo: i + 1, status: "done" as const, passed: p, finishedAt })));
  }
  const runsOf = async (eventId: string) => db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));

  it("counts 3 of 3 on one version of the job, under the rules in force now, in plain conditions only", async () => {
    await history("h-solved", "refund", 5, [true, true, true]);
    await history("h-two", "weekend", 5, [true, true]);
    await history("h-miss", "spreadsheet", 5, [true, false, true]);
    await history("h-spread", "flaky-supplier", 1, [true, true]);
    await db.insert(t.arenaRuns).values({ id: "h-spread-x", eventId: "h-spread", modelId: m, task: "flaky-supplier", seed: 2, attemptNo: 1, status: "done", passed: true, finishedAt: Date.now() });
    await history("h-old", "scam-invoice", 5, [true, true, true], {}, rulesInForceSince() - 1);
    await history("h-lab", "impossible", 5, [true, true, true], { arm: "card" });
    await history("h-twist", "refund-hard", 5, [true, true, true], { twist: "some-twist" });
    await history("h-ranked", "refund-hard3", 1_000_003, [true, true, true], { kind: "card" });
    const solved = await solvedPairs(env, [m], ["refund", "weekend", "spreadsheet", "flaky-supplier", "scam-invoice", "impossible", "refund-hard", "refund-hard3"]);
    // Ranked bouts are plain conditions too, so they count as evidence; the tier is part of the job (task id).
    expect([...solved].sort()).toEqual([`${m}:refund`, `${m}:refund-hard3`]);
  });

  it("a plain practice plan leaves solved jobs out; ranked and Lab plans are queued exactly as written", async () => {
    await history("p-solved", "scam-invoice", 9, [true, true, true]);
    const plain = await planEvent(env, { slug: "p-plain", name: "p", season: "s0", kind: "practice", models: [m], tasks: ["scam-invoice", "weekend"], seeds: [1, 2], attempts: 3 });
    expect((await runsOf(plain)).map((r) => r.task)).toEqual(Array(6).fill("weekend"));
    const lab = await planEvent(env, { slug: "p-lab", name: "p", season: "s0", kind: "practice", arm: "card", models: [m], tasks: ["scam-invoice"], seeds: [1, 2], attempts: 1 });
    expect(await runsOf(lab)).toHaveLength(2);
    const card = await planEvent(env, { slug: "p-card", name: "p", season: "s0", kind: "card", models: [m], tasks: ["scam-invoice"], seeds: [1_000_010], attempts: 3 });
    expect(await runsOf(card)).toHaveLength(3);
    await db.delete(t.arenaRuns).where(inArray(t.arenaRuns.eventId, [plain, lab, card]));
  });

  it("the runner drops queued plain practice of a job once it's solved, and still plays ranked, Lab and paused bouts", async () => {
    scripted(honest);
    await history("q-solved", "impossible", 4, [true, true, true]);
    await db.insert(t.arenaEvents).values([
      { id: "q-plain", slug: "q-plain", name: "q", season: "s0", kind: "practice", status: "running" },
      { id: "q-lab", slug: "q-lab", name: "q", season: "s0", kind: "practice", status: "running", arm: "none" },
      { id: "q-card", slug: "q-card", name: "q", season: "s0", kind: "card", status: "running", createdAt: PROMPT_CACHE_FROM - 1 },
    ]);
    const queued = (id: string, eventId: string, extra: Partial<typeof t.arenaRuns.$inferInsert> = {}) => ({ id, eventId, modelId: m, task: "impossible", seed: 11, attemptNo: 1, status: "queued" as const, ...extra });
    await db.insert(t.arenaRuns).values([
      queued("q-p1", "q-plain"),
      queued("q-p2", "q-plain", { attemptNo: 2 }),
      queued("q-p3", "q-plain", { attemptNo: 3, task: "weekend" }),
      queued("q-l1", "q-lab"),
      queued("q-c1", "q-card", { seed: 1_000_011 }),
    ]);
    const out = await processQueue(env, Date.now() + 60_000);
    expect(out.solved).toBe(2);
    const left = await db.select().from(t.arenaRuns).where(inArray(t.arenaRuns.eventId, ["q-plain", "q-lab", "q-card"]));
    expect(left.map((r) => [r.id, r.status]).sort()).toEqual([
      ["q-c1", "done"],
      ["q-l1", "done"],
      ["q-p3", "done"],
    ]);
    await db.delete(t.arenaRuns).where(inArray(t.arenaRuns.eventId, ["q-plain", "q-lab", "q-card", "q-solved"]));
  });
});

describe("Hard v3 runs only inside planned events (S1)", () => {
  it("nothing queues bouts by itself except the weekly headline bout, and that is always a Normal job", async () => {
    const hard3 = new Set(HARD3_TASKS.map((x) => x.id));
    const normal = new Set(TASKS.map((x) => x.id));
    // A year of weekly slots: the published rule picks from the six Normal jobs, never Hard v3.
    for (let w = 0; w < 52; w++) {
      const slot = lastHeadlineSlot(Date.UTC(2026, 10, 1) + w * 7 * 86_400_000)!;
      expect(normal.has(weeklyTask(slot).id)).toBe(true);
      expect(hard3.has(weeklyTask(slot).id)).toBe(false);
    }
    // A tick with no plan in KV queues nothing (staging: the weekly bout is production only).
    const before = (await db.select({ id: t.arenaEvents.id }).from(t.arenaEvents)).length;
    await env.KV.delete("arena:plan");
    await arenaTick(env, Date.now() - 11 * 60_000);
    expect((await db.select({ id: t.arenaEvents.id }).from(t.arenaEvents)).length).toBe(before);
  });
});
