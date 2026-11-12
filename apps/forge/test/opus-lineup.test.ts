import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openRouterBody } from "../src/arena/adapters";
import { ANTHROPIC_GUARD_USD, BYOK_FALLBACK_KV, BYOK_HOLD_KV, claudeByokIds, CONTAMINATION_TEST_1, CREDIT_KV, creditModelIds, FILLER_MODELS, isClaudeByok, OPENROUTER_CREDIT_PURCHASED_USD, type CreditSnapshot } from "../src/arena/credit";
import { weeklyModels } from "../src/arena/headline-slot";
import { HEADLINE, modelById, testedModels } from "../src/arena/lineup";
import { processQueue } from "../src/arena/runner";
import { houseSprintModel } from "../src/arena/sprint-house";
import { rankedModelIds } from "../src/arena/views";
import * as t from "../src/db/schema";
import { getDb, newId } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0064 Amendment 3 (5 Nov 2026): Claude Opus 5.5 joins the lineup on our Anthropic key (BYOK). It never runs on
// OpenRouter credit, waits under the monthly Anthropic budget guard (ADR 0147) like every Claude bout, leaves the weekly lineup and the house
// Sprint as they were, and stays off public lists until it has a finished ranked run.

const OPUS = "claude-opus-5.5";
const KEYED = { ...env, OPENROUTER_API_KEY: "test-key" } as typeof env & { OPENROUTER_API_KEY: string };
const call = (name: string, args: unknown) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const honest = [call("get_accounts", {}), call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })];
const snapshot = (remaining: number, at = Date.now()): CreditSnapshot => ({ at, good_at: at, ok: true, remaining, key_limit_remaining: null, key_usage: OPENROUTER_CREDIT_PURCHASED_USD - remaining, byok_usage_monthly: null });

function openRouter(usage: Record<string, unknown>) {
  let i = 0;
  const models: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/v1/key")) return Response.json({ data: { limit: null, limit_remaining: null, usage: 100 } });
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    models.push(body.model);
    return Response.json({ choices: [{ message: { content: null, tool_calls: [honest[i++ % 2]!] } }], usage: { prompt_tokens: 1000, completion_tokens: 50, ...usage }, provider: "Anthropic", model: body.model });
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

beforeEach(async () => {
  vi.restoreAllMocks();
  const db = getDb(env);
  await db.delete(t.arenaPanel);
  await db.delete(t.arenaRuns);
  await db.delete(t.arenaEvents);
  for (const k of [CREDIT_KV, BYOK_FALLBACK_KV, BYOK_HOLD_KV, "arena:lock", "arena:out-of-credit"]) await env.KV.delete(k);
});

describe("Claude Opus 5.5 in the lineup", () => {
  it("is a Heavyweight Anthropic flagship pinned to provider anthropic with no fallbacks (our BYOK key)", () => {
    const m = modelById(OPUS)!;
    expect(m).toMatchObject({ name: "Claude Opus 5.5", lab: "Anthropic", division: "heavyweight", flagship: true, route: { kind: "openrouter", model: "anthropic/claude-opus-5.5", provider: "anthropic" } });
    expect(m.embargoed).toBeUndefined();
    expect(m.retired).toBeUndefined();
    if (m.route.kind !== "openrouter") throw new Error("not OpenRouter");
    const { body, hint } = openRouterBody(m.route, [{ role: "user", content: "hi" }], [], {});
    expect(body.provider).toEqual({ order: ["anthropic"], allow_fallbacks: false, data_collection: "deny" });
    expect(hint).toBe("top-level"); // Anthropic prompt caching, as for Sonnet
    expect(isClaudeByok(m)).toBe(true);
    expect(claudeByokIds()).toContain(OPUS);
    expect(creditModelIds()).not.toContain(OPUS);
    expect(creditModelIds(true)).toContain(OPUS); // counted as a credit spender only while a BYOK fallback is flagged
  });

  it("leaves the weekly lineup, contamination test 1, the filler models and the house Sprint as they were", () => {
    expect(weeklyModels()).toEqual(["claude-sonnet-5.5", "gpt-6.1-sol", "gemini-4-argon", "mistral-large-4", "deepseek-v4-pro", "qwen3.8-max"]);
    expect(CONTAMINATION_TEST_1.models).not.toContain(OPUS);
    expect(FILLER_MODELS).not.toContain(OPUS);
    for (let d = 0; d < 60; d++) expect(houseSprintModel(Date.UTC(2026, 9, 1 + d, 10))?.id).not.toBe(OPUS);
    // Listed after Sonnet, so the six workhorses keep their order for every test and plan that slices the lineup.
    expect(HEADLINE.findIndex((m) => m.id === OPUS)).toBeGreaterThan(HEADLINE.findIndex((m) => m.id === "qwen3.8-max"));
  });

  it("plays on our key while the month's Anthropic budget lasts and never starts once it reaches the guard", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify(snapshot(50)));
    const before = Date.UTC(2027, 1, 10); // a month no other test spends in
    const e = await event("opus-held-batch", "card", "planned");
    const early = await run(e, OPUS);
    const ok = openRouter({ cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: 0.04 } });
    await processQueue(KEYED, before + 60_000, () => before, ok.f);
    const [done] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, early));
    expect(done!.status).toBe("done");
    expect(done!.byokCost).toBeGreaterThan(0);
    expect(ok.models.every((m) => m === "anthropic/claude-opus-5.5")).toBe(true);
    // The month's spend at the guard: no Opus call at all, the bout waits (queued, not voided).
    const spendRun = await run(e, "claude-sonnet-5.5", { status: "done", finishedAt: before - 60_000, byokCost: ANTHROPIC_GUARD_USD, cost: ANTHROPIC_GUARD_USD });
    const late = await run(e, OPUS, { seed: 2 });
    const after = openRouter({ cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: 0.04 } });
    const out = await processQueue(KEYED, before + 60_000, () => before, after.f);
    const [waiting] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, late));
    expect(waiting!.status).toBe("queued");
    expect(after.models).toEqual([]);
    expect(out.skipped).toContain("paused: claude budget");
    await getDb(env).delete(t.arenaRuns).where(eq(t.arenaRuns.id, spendRun));
  });

  it("a turn billed to OpenRouter credit pauses the Opus bout after that turn and holds every Claude bout", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify(snapshot(50)));
    const e = await event("opus-fallback", "card");
    const id = await run(e, OPUS);
    const { f, models } = openRouter({ cost: 0.05, is_byok: false });
    await processQueue(KEYED, Date.now() + 60_000, () => Date.now(), f);
    const [row] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, id));
    expect(row!.status).toBe("queued");
    expect(row!.checkpoint).not.toBeNull();
    expect(models.filter((m) => m === "anthropic/claude-opus-5.5")).toHaveLength(1);
    expect(await env.KV.get(BYOK_HOLD_KV)).not.toBeNull();
    expect((await env.KV.get<{ model: string }>(BYOK_FALLBACK_KV, "json"))?.model).toBe(OPUS);
  });
});

describe("public lists before Opus's first ranked run", () => {
  // A fresh query string each time: public pages are kept in the edge cache (web/edge-cache.ts).
  let n = 0;
  const modelsSection = async () => {
    const res = await fetchWorker(`/arena?opus=${n++}`, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    return body.slice(body.indexOf('id="h-models"'));
  };

  it("is entered (tested) but not listed or counted on /arena until it has a finished ranked run", async () => {
    expect(testedModels().map((m) => m.id)).toContain(OPUS);
    const main = HEADLINE.filter((m) => !m.retired && !m.embargoed && !m.flagship).length;
    // Queued and held runs don't count.
    const held = await event("opus-planned", "card", "planned");
    await run(held, OPUS, { status: "done", finishedAt: Date.now() - 60_000, passed: true, score: 1 });
    await run(await event("opus-queued", "card"), OPUS);
    expect((await rankedModelIds(getDb(env))).has(OPUS)).toBe(false);
    let s = await modelsSection();
    expect(s).not.toContain("Claude Opus 5.5");
    expect(s).toContain(`${main} main,`);
    // Bouts actually played and refereed (on our key, under the month's budget guard).
    await env.KV.put(CREDIT_KV, JSON.stringify(snapshot(50)));
    const T = Date.now();
    const play = () => processQueue(KEYED, T + 60_000, () => T, openRouter({ cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: 0.04 } }).f);
    // (The queued card run would be played below; drop it so each step tests one thing.)
    await getDb(env).delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, (await getDb(env).select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, "opus-queued")))[0]!.id));
    // A practice run isn't a ranked run either.
    await run(await event("opus-practice", "practice"), OPUS);
    await play();
    expect((await rankedModelIds(getDb(env))).has(OPUS)).toBe(false);
    // A finished run in a ranked (card) event that isn't held: listed and counted.
    const ranked = await run(await event("opus-ranked", "card"), OPUS);
    await play();
    expect((await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, ranked)))[0]!.status).toBe("done");
    expect((await rankedModelIds(getDb(env))).has(OPUS)).toBe(true);
    s = await modelsSection();
    expect(s).toContain("<b>Claude Opus 5.5</b>");
    expect(s).toContain(`${main + 1} main,`);
  });
});
