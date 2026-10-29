import { isAnyHeldOutSeed, isPracticeOnly, TASKS, type ToolSpec } from "@forge/arena";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import type { ChatMessage, ModelReply } from "./adapters";
import { ALL_MODELS, type ArenaModel, type Route } from "./lineup";

// B3-13 (ADR 0109): the free-model Arena lane. Practice bouts on OpenRouter `:free` model variants and on Workers AI
// inside Cloudflare's free daily allocation, with hard caps enforced here, per request, so nothing is ever billed:
//  - OpenRouter free variants: at most 900 requests a UTC day and 18 a minute (OpenRouter allows 1,000 and 20 for an
//    account that has bought $10 of credit). A 402, 404 or 429 stops the lane until the next UTC day. A free request is
//    sent only for a `:free` model id, with no fallback models, `allow_fallbacks: false` and a zero `max_price`, so
//    OpenRouter can't serve it on a paid model (adapters.ts). A reply that reports any cost also stops the lane.
//  - Workers AI: Cloudflare includes 10,000 neurons a day (reset 00:00 UTC) and bills beyond that on Workers Paid.
//    Practice turns stop below 9,000 neurons a day, counting every Workers AI call the Worker makes (Arena bouts of
//    any kind, Moltbook replies and challenges, note moderation), estimated from Cloudflare's published per-model
//    rates. Ranked Workers AI turns stop at the total line (ADR 0113: 9,500 plus any explicit paid allowance, 0 by
//    default) and wait with their checkpoint; practice also leaves room for ranked bouts that are waiting.
// The lane's own bouts are queued by free-lane-queue.ts (production only).

/** OpenRouter's free-variant limits for an account that has bought at least $10 of credit, less a 10% margin. */
export const OR_FREE_DAILY_MAX = 900;
export const OR_FREE_PER_MINUTE = 18;
/** Cloudflare's free Workers AI allocation, and the line practice turns may not cross (a 1,000-neuron margin). */
export const WAI_FREE_NEURONS = 10_000;
export const WAI_DAILY_MAX_NEURONS = 9_000;
/** $0.011 per 1,000 neurons (Workers AI pricing page, checked 29 Oct 2026). */
export const NEURONS_PER_USD = 1_000 / 0.011;
/** A practice Workers AI bout isn't started with less than this left today (the cheapest lane bout uses about 110). */
export const WAI_MIN_START_NEURONS = 250;
/**
 * ADR 0113: the line no Workers AI use may take the day past, ranked bouts included: the free 10,000 less a 500 margin
 * (staging shares the account's allocation, and estimates round). Practice stops earlier (WAI_DAILY_MAX_NEURONS, less
 * the ranked reserve); ranked turns, Moltbook and moderation may use the rest.
 */
export const WAI_TOTAL_MAX_NEURONS = 9_500;
/**
 * ADR 0113: neurons a day that ranked (card, guest, weekly) Workers AI turns may use beyond the free allocation, billed
 * at $0.011 per 1,000 on Workers Paid. 0: nothing is billed. Dinike's decision; a Hard-tier DeepSeek V4 Pro bout uses
 * about 30,000–130,000 neurons, so a Hard ranked event on Workers AI needs an allowance here (or waits, a turn at a
 * time, inside the free allocation). Raise it for a named event, then set it back.
 */
export const WAI_PAID_DAILY_NEURONS = 0;
/**
 * Staging (and any non-production Worker) shares the account's free 10,000 neurons but keeps its own counters, so it
 * gets a small line of its own for everything (practice, ranked, moderation): production's 9,500 plus this stays under
 * the free allocation with room for the uncapped Moltbook challenge solver (production only, about 4 neurons a call).
 */
export const STAGING_WAI_MAX_NEURONS = 300;
const isProduction = (env: Pick<Env, "ENVIRONMENT">) => env.ENVIRONMENT === "production";
/** The day's total Workers AI line for this Worker (ADR 0113), before any paid ranked allowance. */
export const waiTotalLine = (env: Pick<Env, "ENVIRONMENT">) => (isProduction(env) ? WAI_TOTAL_MAX_NEURONS : STAGING_WAI_MAX_NEURONS);
/** The practice line for this Worker, before the ranked reserve. */
export const waiPracticeLine = (env: Pick<Env, "ENVIRONMENT">) => (isProduction(env) ? WAI_DAILY_MAX_NEURONS : STAGING_WAI_MAX_NEURONS);
/** Paid ranked neurons a day: production only (staging never bills). */
export const waiPaidAllowance = (env: Pick<Env, "ENVIRONMENT">) => (isProduction(env) ? WAI_PAID_DAILY_NEURONS : 0);
/** Practice keeps this much of the day free for queued ranked Workers AI bouts (their stored cost per bout), at most. */
export const WAI_RANKED_RESERVE_MAX = 6_000;
/** A ranked Workers AI bout with no stored history is reserved at this (a Normal DeepSeek V4 Pro bout uses about 1,000). */
export const DEFAULT_RANKED_BOUT_NEURONS = 1_000;

/**
 * Neurons per million input and output tokens, from Cloudflare's Workers AI pricing page (checked 29 Oct 2026), for
 * every Workers AI model the Worker calls. A model missing here is counted at UNKNOWN_RATES, which overstates it.
 */
export const WAI_NEURON_RATES: Record<string, { in: number; out: number }> = {
  "@cf/zai-org/glm-5.3-flash": { in: 13_636, out: 45_455 },
  "@cf/google/gemma-4-26b-a4b-it": { in: 9_091, out: 27_273 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { in: 31_876, out: 50_488 },
  "@cf/deepseek-ai/deepseek-v4-flash-0731": { in: 40_000, out: 120_000 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { in: 120_000, out: 360_000 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 4_625, out: 30_475 },
  "@cf/qwen/qwen3.8-27b": { in: 40_909, out: 290_909 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { in: 24_545, out: 77_273 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 26_668, out: 204_805 },
  "@cf/meta/llama-guard-3-8b": { in: 44_003, out: 2_730 },
  "@cf/moonshotai/kimi-k2.6": { in: 86_364, out: 363_636 },
  "@cf/zai-org/glm-5.3": { in: 127_273, out: 400_000 },
  "@cf/nvidia/nemotron-3-120b-a12b": { in: 45_455, out: 136_364 },
  "@cf/ibm-granite/granite-4.0-h-micro": { in: 1_542, out: 10_158 },
  "@cf/openai/gpt-oss-120b": { in: 31_818, out: 68_182 },
};
export const UNKNOWN_RATES = { in: 130_000, out: 610_000 };

/** A model's neuron rates: the published table, or its list price in the lineup if that is higher. */
export function neuronRates(model: string, priceIn = 0, priceOut = 0) {
  const r = WAI_NEURON_RATES[model] ?? UNKNOWN_RATES;
  return { in: Math.max(r.in, priceIn * NEURONS_PER_USD), out: Math.max(r.out, priceOut * NEURONS_PER_USD) };
}
export const neuronsFor = (rates: { in: number; out: number }, tokensIn: number, tokensOut: number) => (tokensIn * rates.in + tokensOut * rates.out) / 1e6;

/**
 * The Workers AI practice models in the lane: the ones that finish jobs, cheapest per bout first (practice runs on
 * production up to 19 Oct: GLM 5.3 Flash 208 of 210 passed, about 120 neurons a bout; Gemma 4 26B 332 of 519, about
 * 110; Mistral Small 3.1 147 of 182, about 180; DeepSeek V4 Flash 210 of 210, about 390). Granite 4.0 Micro (5%)
 * and Llama 4 Scout (12%) rarely finish a job, so they are left out.
 */
export const WAI_LANE_IDS = ["glm-5.3-flash", "gemma-4-26b", "mistral-small-3.1", "deepseek-v4-flash"] as const;

/** An OpenRouter free-variant entry (ADR 0109): its own model id, never merged with a paid row. */
export const isFreeVariant = (m: Pick<ArenaModel, "route">) => m.route.kind === "openrouter" && m.route.free === true;
export const isFreeRoute = (r: Route) => r.kind === "openrouter" && r.free === true;
/** The free-variant models the lane plays: never retired, never embargoed. */
export const freeVariantModels = () => ALL_MODELS.filter((m) => isFreeVariant(m) && !m.retired && !m.embargoed);
export const freeVariantIds = () => freeVariantModels().map((m) => m.id);
export const waiLaneModels = () => WAI_LANE_IDS.map((id) => ALL_MODELS.find((m) => m.id === id)).filter((m): m is ArenaModel => !!m && m.route.kind === "workers-ai" && !m.retired && !m.embargoed);

/** What run pages and the methodology say about free-variant bouts (ADR 0109 Amendment 1). */
export const FREE_TRAINING_LABEL = "provider may train on prompts (public jobs only)";

/**
 * ADR 0109 Amendment 1: free providers may train on prompts, so a free-variant bout may only ever be one of the six public
 * Gauntlet jobs (TASKS) on a public seed, in a plain practice event: never a held-out seed, a private family, a Lab arm
 * or twist, a held ("planned") event or a longitudinal-panel event. Returns why not, or null when allowed.
 */
export function freeLaneRunRefusal(run: { task: string; seed: number; heldOut?: boolean | null }, event: { kind: string; status: string; arm?: string | null; twist?: string | null; panel?: boolean } | null): string | null {
  if (!TASKS.some((x) => x.id === run.task)) return "not a public Gauntlet job";
  if (isPracticeOnly(run.task)) return "private job family";
  if (run.heldOut || isAnyHeldOutSeed(run.seed)) return "held-out seed";
  if (!event) return "no event";
  if (event.kind !== "practice") return "not a practice event";
  if (event.status === "planned") return "held event";
  if (event.arm || event.twist) return "Lab arm or twist";
  if (event.panel) return "longitudinal panel";
  return null;
}

/** How a model is served, as model lists and run pages say it (ADR 0109). */
export function routeLabel(m: Pick<ArenaModel, "route">): string {
  if (m.route.kind === "workers-ai") return "Workers AI";
  return m.route.free ? "free variant via OpenRouter" : "via OpenRouter";
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const dayStart = (now: number) => Date.parse(`${utcDay(now)}T00:00:00Z`);
const secondsToDayEnd = (now: number) => Math.max(60, Math.ceil((dayStart(now) + 86_400_000 - now) / 1000) + 3_600);

export const orKey = (now: number) => `freelane:or:${utcDay(now)}`;
export const orPauseKey = (now: number) => `freelane:or:pause:${utcDay(now)}`;
/** Neurons counted today per source: arena (every Workers AI bout turn), moltbook, moderation (ADR 0113), claims (ADR 0120). */
export type NeuronSource = "arena" | "moltbook" | "moderation" | "claims";
export const neuronKey = (now: number, source: NeuronSource) => `freelane:wai:${utcDay(now)}:${source}`;
/** The moderation call counter (services/moderation.ts) and the neurons each call is counted at (about 15 used). */
export const moderationKey = (now: number) => `mod-count:${utcDay(now)}`;
export const NEURONS_PER_MODERATION = 50;

interface OrState {
  count: number;
  /** Times (ms) of the most recent requests, for the per-minute cap across ticks. */
  recent: number[];
}
export interface LanePause {
  reason: string;
  at: string;
}

const kvNum = async (kv: KVNamespace, key: string) => {
  const v = Number((await kv.get(key).catch(() => null)) ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** Requests sent to free variants today, as the finished and suspended runs show them (a floor under the KV count). */
async function storedFreeRequests(env: Env, now: number) {
  const ids = freeVariantIds();
  if (!ids.length) return 0;
  const [r] = await getDb(env)
    .select({ n: sql<number>`coalesce(sum(coalesce(json_extract(${t.arenaRuns.result}, '$.turns'), json_extract(${t.arenaRuns.checkpoint}, '$.attempt.turns'), 0)), 0)` })
    .from(t.arenaRuns)
    .where(and(inArray(t.arenaRuns.modelId, ids), sql`coalesce(${t.arenaRuns.finishedAt}, ${t.arenaRuns.startedAt}, 0) >= ${dayStart(now)}`));
  return Number(r?.n ?? 0);
}

/** Neurons spent today by finished Workers AI bouts, from their stored list-price estimates (a floor under KV). */
async function storedNeurons(env: Env, now: number) {
  const [r] = await getDb(env)
    .select({ c: sql<number>`coalesce(sum(${t.arenaRuns.cost}), 0)` })
    .from(t.arenaRuns)
    .where(and(eq(t.arenaRuns.costEstimated, true), eq(t.arenaRuns.status, "done"), gte(t.arenaRuns.finishedAt, dayStart(now))));
  return Number(r?.c ?? 0) * NEURONS_PER_USD;
}

/**
 * Moderation's neurons today: its own counter (ADR 0113: each call's real or estimated neurons), or, for calls counted
 * before that, NEURONS_PER_MODERATION a call.
 */
async function moderationNeurons(kv: KVNamespace, now: number) {
  const metered = await kvNum(kv, neuronKey(now, "moderation"));
  return metered > 0 ? metered : (await kvNum(kv, moderationKey(now))) * NEURONS_PER_MODERATION;
}

/** What the Worker's other Workers AI calls used today (Moltbook, moderation), from their KV counters. */
async function otherNeurons(kv: KVNamespace, now: number) {
  return (await kvNum(kv, neuronKey(now, "moltbook"))) + (await moderationNeurons(kv, now)) + (await kvNum(kv, neuronKey(now, "claims")));
}

/** Neurons counted today by source, and in total: every Workers AI call the Worker makes (ADR 0113). */
export async function waiUsage(env: Env, now = Date.now()) {
  const kv = env.KV;
  const arena = Math.max(await kvNum(kv, neuronKey(now, "arena")), await storedNeurons(env, now).catch(() => 0));
  const moltbook = await kvNum(kv, neuronKey(now, "moltbook"));
  const moderation = await moderationNeurons(kv, now);
  // ADR 0120: the claim verifier's optional LLM pass (off unless CLAIMS_LLM is "on").
  const claims = await kvNum(kv, neuronKey(now, "claims"));
  return { arena, moltbook, moderation, claims, total: arena + moltbook + moderation + claims };
}

/**
 * Whether a Workers AI call outside the Arena that may use `need` neurons fits under today's total line (ADR 0113).
 * `ownMax`: the source's own daily line, if it has one.
 */
export async function waiRoom(env: Env, source: Exclude<NeuronSource, "arena">, need: number, ownMax = Number.POSITIVE_INFINITY, now = Date.now()) {
  const u = await waiUsage(env, now).catch(() => null);
  // Fails closed: if the counters can't be read, nothing that could be billed is sent.
  if (!u) return false;
  return u.total + need <= waiTotalLine(env) && u[source] + need <= ownMax;
}

type WaiUsage = { prompt_tokens?: number; completion_tokens?: number; neurons?: number };

/**
 * Counts a Workers AI call made outside the Arena: Workers AI's own `usage.neurons` when it reports it (it does for
 * current models, checked 29 Oct 2026), else its tokens at the model's published rates.
 */
export async function countNeurons(kv: KVNamespace, source: Exclude<NeuronSource, "arena">, model: string, usage: WaiUsage | null | undefined, fallback: { tokensIn: number; tokensOut: number }, now = Date.now()) {
  const reported = Number(usage?.neurons ?? 0);
  const tin = Number(usage?.prompt_tokens ?? 0);
  const tout = Number(usage?.completion_tokens ?? 0);
  const known = tin > 0 || tout > 0;
  const n = Number.isFinite(reported) && reported > 0 ? reported : neuronsFor(neuronRates(model), known ? tin : fallback.tokensIn, known ? tout : fallback.tokensOut);
  const key = neuronKey(now, source);
  await kv.put(key, String((await kvNum(kv, key)) + n), { expirationTtl: 3 * 86_400 }).catch(() => {});
  return n;
}

/** A wrapper around the AI binding that counts every call's neurons under `source` (Moltbook). */
export function meteredAi(env: Pick<Env, "AI" | "KV">, source: "moltbook", onCount?: (neurons: number) => void | Promise<void>): Ai {
  return {
    run: async (model: string, input: { messages?: { content?: unknown }[]; max_tokens?: number }, opts?: unknown) => {
      const out = (await (env.AI.run as (m: string, i: unknown, o?: unknown) => Promise<unknown>)(model, input, opts)) as { usage?: WaiUsage } | null;
      const chars = JSON.stringify(input?.messages ?? input ?? "").length;
      const n = await countNeurons(env.KV, source, model, out?.usage, { tokensIn: Math.ceil(chars / 3), tokensOut: input?.max_tokens ?? 4096 });
      await onCount?.(n);
      return out;
    },
  } as unknown as Ai;
}

/** The per-turn gate a bout's runner asks before and after each model call (runner.ts playBout). */
export interface TurnGate {
  /** False: don't send this turn now (the bout is suspended and carries on later). */
  before(messages: ChatMessage[], tools: ToolSpec[]): Promise<boolean>;
  /** After a reply, or with null after a failed call. */
  after(reply: ModelReply | null): Promise<void>;
}

export interface LaneMeterOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** No turn waits for a per-minute slot past this time. */
  deadline?: number;
}

/**
 * One tick's view of the lane's caps. Only one Arena tick runs at a time (KV `arena:lock`), so the counts held here
 * are the truth for the tick; they are written to KV after every request and read back (with the stored runs as a
 * floor) at the next tick.
 */
export class LaneMeter {
  private or: OrState = { count: 0, recent: [] };
  private orPaused: LanePause | null = null;
  /** Neurons the arena has counted today (KV), and the other sources'. */
  private arenaNeurons = 0;
  private other = 0;
  /** Neurons practice leaves today for queued ranked Workers AI bouts (ADR 0113). */
  private rankedReserveN = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deadline: number;
  private day: string;

  private constructor(
    private readonly env: Env,
    o: LaneMeterOptions,
  ) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.deadline = o.deadline ?? Number.POSITIVE_INFINITY;
    this.day = utcDay(this.now());
  }

  static async load(env: Env, o: LaneMeterOptions = {}) {
    const m = new LaneMeter(env, o);
    await m.reload();
    return m;
  }

  private async reload() {
    const now = this.now();
    this.day = utcDay(now);
    const kv = this.env.KV;
    const s = (await kv.get<OrState>(orKey(now), "json").catch(() => null)) ?? { count: 0, recent: [] };
    const stored = await storedFreeRequests(this.env, now).catch(() => 0);
    this.or = { count: Math.max(Number(s.count) || 0, stored), recent: Array.isArray(s.recent) ? s.recent.filter((x) => typeof x === "number") : [] };
    this.orPaused = (await kv.get<LanePause>(orPauseKey(now), "json").catch(() => null)) ?? null;
    this.arenaNeurons = Math.max(await kvNum(kv, neuronKey(now, "arena")), await storedNeurons(this.env, now).catch(() => 0));
    this.other = await otherNeurons(kv, now);
    this.rankedReserveN = await rankedReserve(this.env, now).catch(() => WAI_RANKED_RESERVE_MAX);
  }

  /** A new UTC day began during the tick: start the day's counts afresh. */
  private async rollover() {
    if (utcDay(this.now()) !== this.day) await this.reload();
  }

  get orRequestsToday() {
    return this.or.count;
  }
  get neuronsToday() {
    return this.arenaNeurons + this.other;
  }
  get orPause() {
    return this.orPaused;
  }
  get rankedReserve() {
    return this.rankedReserveN;
  }
  /** The line practice Workers AI turns may not take the day past: the practice line less the ranked reserve. */
  get practiceLine() {
    return Math.max(0, waiPracticeLine(this.env) - this.rankedReserveN);
  }
  /** The line ranked Workers AI turns may not take the day past: the total line plus any explicit paid allowance. */
  get rankedLine() {
    return waiTotalLine(this.env) + waiPaidAllowance(this.env);
  }

  /** New free-variant bouts may start. */
  orOpen() {
    return !this.orPaused && this.or.count < OR_FREE_DAILY_MAX;
  }
  /** New practice Workers AI bouts may start. */
  waiOpen() {
    return this.neuronsToday + WAI_MIN_START_NEURONS <= this.practiceLine;
  }
  /** Ranked Workers AI bouts may start or carry on (ADR 0113); when false they wait, suspended, never voided. */
  waiRankedOpen() {
    return this.neuronsToday + WAI_MIN_START_NEURONS <= this.rankedLine;
  }

  /** Stops free-variant requests until the next UTC day (a 402, 404 or 429, or a reply that cost money). */
  async pauseOr(reason: string) {
    const now = this.now();
    this.orPaused = { reason: reason.slice(0, 200), at: new Date(now).toISOString() };
    console.warn("arena_free_lane_paused", JSON.stringify(this.orPaused));
    await this.env.KV.put(orPauseKey(now), JSON.stringify(this.orPaused), { expirationTtl: secondsToDayEnd(now) }).catch(() => {});
  }

  /** Takes one free-variant request from today's allowance and this minute's, waiting for a slot if needed. */
  private async takeOrRequest(): Promise<boolean> {
    await this.rollover();
    for (;;) {
      if (!this.orOpen()) return false;
      const now = this.now();
      this.or.recent = this.or.recent.filter((x) => x > now - 60_000);
      if (this.or.recent.length < OR_FREE_PER_MINUTE) {
        // Counted before the request is sent, with no await in between, so parallel lanes can't both take the last one.
        this.or.count++;
        this.or.recent.push(now);
        const snapshot: OrState = { count: this.or.count, recent: this.or.recent.slice(-OR_FREE_PER_MINUTE) };
        await this.env.KV.put(orKey(now), JSON.stringify(snapshot), { expirationTtl: 3 * 86_400 }).catch(() => {});
        return true;
      }
      const wait = this.or.recent[0]! + 60_000 - now + 50;
      if (now + wait >= this.deadline) return false;
      await this.sleep(wait);
    }
  }

  private async addNeurons(n: number) {
    this.arenaNeurons += n;
    await this.env.KV.put(neuronKey(this.now(), "arena"), String(this.arenaNeurons), { expirationTtl: 3 * 86_400 }).catch(() => {});
  }

  /** The gate for one run, or null when its route has no lane cap. `practice`: the run is in a practice event. */
  gateFor(model: ArenaModel, practice: boolean): TurnGate | null {
    const route = model.route;
    if (route.kind === "openrouter") {
      if (!route.free) return null;
      return {
        before: () => this.takeOrRequest(),
        after: async (reply) => {
          if (reply && reply.cost > 0) {
            console.error("arena_free_lane_billed", model.id, reply.cost);
            await this.pauseOr(`a free-variant reply reported a cost of $${reply.cost}`);
          }
        },
      };
    }
    const rates = neuronRates(route.model, route.priceIn, route.priceOut);
    let reserved = 0;
    return {
      before: async (messages, tools) => {
        await this.rollover();
        const tokensIn = Math.ceil(JSON.stringify(messages).length / 3 + JSON.stringify(tools).length / 3);
        reserved = neuronsFor(rates, tokensIn, route.maxTokens ?? 2048);
        // ADR 0113: ranked turns are held too, at the total line plus any explicit paid allowance; a held ranked bout
        // waits with its checkpoint and carries on when the day's allocation allows (never voided).
        return this.neuronsToday + reserved <= (practice ? this.practiceLine : this.rankedLine);
      },
      after: async (reply) => {
        const n = reply && (reply.tokensIn > 0 || reply.tokensOut > 0) ? neuronsFor(rates, reply.tokensIn, reply.tokensOut) : reserved;
        await this.addNeurons(n);
      },
    };
  }
}

/**
 * ADR 0113: neurons practice leaves for the ranked Workers AI bouts that are waiting (queued or running in a card,
 * guest or weekly event): each at its model's average stored neurons per bout (60 days; DEFAULT_RANKED_BOUT_NEURONS
 * with no history), WAI_RANKED_RESERVE_MAX at most.
 */
export async function rankedReserve(env: Env, now = Date.now()) {
  const wai = ALL_MODELS.filter((m) => m.route.kind === "workers-ai").map((m) => m.id);
  if (!wai.length) return 0;
  const db = getDb(env);
  const waiting = await db
    .select({ model: t.arenaRuns.modelId, n: sql<number>`count(*)` })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(inArray(t.arenaRuns.status, ["queued", "running"]), inArray(t.arenaRuns.modelId, wai), sql`${t.arenaEvents.kind} != 'practice'`))
    .groupBy(t.arenaRuns.modelId);
  if (!waiting.length) return 0;
  const avg = await db
    .select({ model: t.arenaRuns.modelId, usd: sql<number>`avg(${t.arenaRuns.cost})` })
    .from(t.arenaRuns)
    .where(and(eq(t.arenaRuns.status, "done"), eq(t.arenaRuns.costEstimated, true), inArray(t.arenaRuns.modelId, waiting.map((w) => w.model)), gte(t.arenaRuns.finishedAt, now - 60 * 86_400_000)))
    .groupBy(t.arenaRuns.modelId);
  const per = new Map(avg.map((a) => [a.model, Number(a.usd) * NEURONS_PER_USD]));
  const total = waiting.reduce((s, w) => s + Number(w.n) * (per.get(w.model) || DEFAULT_RANKED_BOUT_NEURONS), 0);
  return Math.min(WAI_RANKED_RESERVE_MAX, Math.round(total));
}

/** Today's lane usage for /admin/costs (reads KV and stored runs; never calls a provider). */
export async function freeLaneUsage(env: Env, now = Date.now()) {
  const m = await LaneMeter.load(env, { now: () => now });
  const ids = freeVariantIds();
  const wai = waiLaneModels().map((x) => x.id);
  const db = getDb(env);
  const bouts = async (models: string[]) =>
    models.length
      ? Number(
          (
            await db
              .select({ n: sql<number>`count(*)` })
              .from(t.arenaRuns)
              .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
              .where(and(eq(t.arenaRuns.status, "done"), inArray(t.arenaRuns.modelId, models), eq(t.arenaEvents.kind, "practice"), gte(t.arenaRuns.finishedAt, dayStart(now))))
          )[0]?.n ?? 0,
        )
      : 0;
  const catalog = (await env.KV.get<{ at: string; models: { id: string }[] }>(FREE_CATALOG_KEY, "json").catch(() => null)) ?? null;
  const inLane = new Set(freeVariantModels().map((x) => (x.route.kind === "openrouter" ? x.route.model : "")));
  return {
    day: utcDay(now),
    openrouter_free: {
      requests_today: m.orRequestsToday,
      daily_max: OR_FREE_DAILY_MAX,
      per_minute_max: OR_FREE_PER_MINUTE,
      paused: m.orPause,
      models: ids,
      bouts_today: await bouts(ids),
      catalog_at: catalog?.at ?? null,
      catalog_not_in_lane: catalog ? catalog.models.map((x) => x.id).filter((id) => !inLane.has(id)) : null,
    },
    workers_ai: {
      neurons_today: Math.round(m.neuronsToday),
      daily_max: m.practiceLine,
      total_max: m.rankedLine,
      ranked_reserve: m.rankedReserve,
      paid_allowance: waiPaidAllowance(env),
      ranked_open: m.waiRankedOpen(),
      free_allocation: WAI_FREE_NEURONS,
      open: m.waiOpen(),
      models: wai,
      bouts_today: await bouts(wai),
    },
  };
}

/** OpenRouter's tool-capable free variants (any lab but xAI, embargoed models left out), cached by the catalog cron. */
export const FREE_CATALOG_KEY = "arena:or-free-models";
