import type { ToolSpec } from "@forge/arena";
import type { Route } from "./lineup";
import { parsePythonicCalls } from "./pythonic";

// One chat-with-tools call, normalised across OpenRouter and Workers AI. Every request uses the same messages and
// tools; only the transport differs. Provider failures throw ProviderError, which voids the run (never a fallback).

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ModelReply {
  text: string | null;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  /**
   * Dollars: what the turn cost in total. OpenRouter's `usage.cost` (billed to OpenRouter credit) plus, for a turn served
   * on our own key through BYOK, the provider's charge to that key (`byokCost`), so a BYOK bout costs the same as it
   * would have on credit and cost-per-success stays comparable (ADR 0064). For Workers AI, tokens × list price (estimated).
   */
  cost: number;
  /**
   * The part of `cost` billed to our own provider key through OpenRouter BYOK (`usage.cost_details.upstream_inference_cost`),
   * not to OpenRouter credit. Absent when the turn wasn't served on a BYOK key.
   */
  byokCost?: number;
  /**
   * OpenRouter's answer to "was this turn served on our own key?": true (BYOK), false (OpenRouter credit), or absent when
   * the response doesn't say. Read from `usage.is_byok`, or true when an upstream (BYOK) cost is reported.
   */
  byok?: boolean;
  /**
   * A BYOK turn whose upstream cost OpenRouter reported neither in the reply nor in the generation stats: its `cost`
   * leaves out what our key was billed, so it is too low (ADR 0064).
   */
  byokUnpriced?: boolean;
  costEstimated: boolean;
  latencyMs: number;
  provider: string | null;
  /**
   * The model string the provider reported serving (OpenRouter's response `model`), or the Workers AI model id. Stored
   * per run as `arena_runs.model_version` (ADR 0058), so a version change under the same lineup id shows in the data.
   */
  servedModel?: string;
  /** Input tokens read from the provider's prompt cache, when it reports them (part of `tokensIn`, not extra). */
  cachedTokens?: number;
  /** Input tokens written to the prompt cache by this call, when the provider reports them. */
  cacheWriteTokens?: number;
}

/** Default largest reply per turn on Workers AI (practice models); a route can set its own (`maxTokens`). */
export const WORKERS_AI_MAX_TOKENS = 2048;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The provider asked us to slow down (HTTP 429): the bout pauses and carries on later; it isn't a failure. */
    readonly rateLimited = false,
    /**
     * A `:free` variant was refused (402, 403, 404 or 429; ADR 0109): the free lane stops until the next UTC day. It never
     * touches the paid-credit pause note.
     */
    readonly freeLaneStop = false,
  ) {
    super(message);
  }
}

/**
 * Prompt caching (S1, docs/strategy/acquisition-build-framework.md §3). A bout resends the same tools, harness prompt
 * and brief on every turn, then a growing history, so most input tokens are a prefix the provider has just seen.
 * Caching only changes the bill: the text the model reads is byte-for-byte the same, and `tokensIn` (which the token
 * cap counts) still includes every input token. Per OpenRouter's prompt-caching guide (checked 24 Oct 2026):
 *  - OpenAI, Google Gemini (implicit caching), DeepSeek, Mistral and most others cache automatically: nothing to add.
 *  - Anthropic needs `cache_control`. OpenRouter takes it at the top level of the request ("automatic caching": the
 *    breakpoint sits on the last cacheable block and moves forward as the bout grows), so no message is touched.
 *  - Alibaba (Qwen) needs an explicit breakpoint on a content block: the brief (the first user message, after the
 *    tools and harness prompt) is sent as one text block with exactly the same text, plus `cache_control`.
 * Workers AI caches prefixes on the replica that served the call; the `x-session-affinity` header keeps a bout's calls
 * on one replica (Workers AI prompt-caching docs). Its cost here stays estimated at the full input price, which
 * overstates it, so the daily allowances stop early rather than late.
 */
export interface CacheOptions {
  /** Keeps a bout's Workers AI calls on one replica, so its prefix cache is reused. */
  key?: string;
}

export type CacheHint = "top-level" | "brief-breakpoint" | "none";

/** What a route needs for prompt caching (see CacheOptions). */
export function cacheHint(route: Route): CacheHint {
  if (route.kind !== "openrouter") return "none";
  if (route.model.startsWith("anthropic/")) return "top-level";
  if (route.model.startsWith("qwen/") && route.provider.toLowerCase() === "alibaba") return "brief-breakpoint";
  return "none";
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** Models whose provider refused a cache hint (HTTP 400) in this isolate: sent without one from then on. */
const cacheRefused = new Set<string>();
/** Models whose provider refused the system-prompt breakpoint (ADR 0113): sent with the top-level hint only. */
const systemBreakRefused = new Set<string>();

const toolsParam = (tools: ToolSpec[]) => tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** The OpenRouter request body. With `cache`, the route's cache hint is added and nothing else changes. */
/**
 * The provider options for a `:free` variant (ADR 0109; OpenRouter's model-variant, fallback and provider-selection
 * docs, checked 29 Oct 2026). Billing follows the model that serves the request, and only a `models` fallback list can
 * move a request to another model, so none is sent. `allow_fallbacks: false` keeps it on the variant's own endpoints and
 * `max_price` 0 refuses any endpoint that charges. ADR 0109 Amendment 1 (Dinike, 29 Oct: "Allow, free lane only"): no
 * `data_collection: "deny"` here, so free providers that may train on prompts are allowed. Only public Gauntlet jobs on
 * public seeds may reach this route (free-lane.ts `freeLaneRunAllowed`, checked by the runner before every free turn).
 * Every other route keeps ADR 0014's no-training rule.
 */
export const FREE_PROVIDER = {
  allow_fallbacks: false,
  require_parameters: true,
  max_price: { prompt: 0, completion: 0, request: 0 },
} as const;

/**
 * ADR 0113: with the top-level hint, the system prompt also gets its own breakpoint, so the tools and system prompt
 * (the same for every bout of a job, about 700–1,100 tokens) are cached as their own entry and a later bout of the same
 * job reads them within 5 minutes even when its brief differs. Anthropic allows the two together (the automatic
 * breakpoint takes one of the four slots; prompt-caching docs, checked 29 Oct 2026). The text is unchanged.
 */
export function openRouterBody(route: Extract<Route, { kind: "openrouter" }>, messages: ChatMessage[], tools: ToolSpec[], cache: CacheOptions | null, systemBreak = true) {
  if (route.free) {
    // A free route can only name a `:free` model: anything else would be billed.
    if (!route.model.endsWith(":free")) throw new ProviderError(`free route ${route.model} is not a :free variant`, false);
    return {
      hint: "none" as CacheHint,
      body: { model: route.model, messages, tools: toolsParam(tools), tool_choice: "auto", temperature: 0, provider: FREE_PROVIDER, usage: { include: true } },
    };
  }
  const brief = messages.findIndex((m) => m.role === "user");
  let hint = cache && !cacheRefused.has(route.model) ? cacheHint(route) : "none";
  if (hint === "brief-breakpoint" && brief < 0) hint = "none";
  const sys = hint === "top-level" && systemBreak && !systemBreakRefused.has(route.model) ? messages.findIndex((m) => m.role === "system") : -1;
  const sent =
    hint === "brief-breakpoint"
      ? messages.map((m, i) => (i === brief ? { role: "user" as const, content: [{ type: "text" as const, text: m.content ?? "", cache_control: EPHEMERAL }] } : m))
      : sys >= 0
        ? messages.map((m, i) => (i === sys ? { role: "system" as const, content: [{ type: "text" as const, text: m.content ?? "", cache_control: EPHEMERAL }] } : m))
        : messages;
  return {
    hint,
    systemBreak: sys >= 0,
    body: {
      model: route.model,
      messages: sent,
      tools: toolsParam(tools),
      tool_choice: "auto",
      temperature: 0,
      // Pinned provider, no fallbacks, no response caching; never used for training (ADR 0014 §9).
      provider: { order: [route.provider], allow_fallbacks: false, data_collection: "deny" },
      usage: { include: true },
      ...(hint === "top-level" ? { cache_control: EPHEMERAL } : {}),
    },
  };
}

export async function callModel(
  env: Pick<Env, "AI"> & { OPENROUTER_API_KEY?: string },
  route: Route,
  messages: ChatMessage[],
  tools: ToolSpec[],
  fetcher: typeof fetch = fetch,
  /** Prompt caching on (null: off). The runner decides per event (runner.ts `promptCacheOn`). */
  cache: CacheOptions | null = null,
): Promise<ModelReply> {
  const t0 = Date.now();
  if (route.kind === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new ProviderError("OPENROUTER_API_KEY is not set", false);
    const post = (body: unknown) =>
      fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://theagentforge.io", "X-Title": "The Forge Arena" },
        body: JSON.stringify(body),
      });
    const req = openRouterBody(route, messages, tools, cache);
    let res = await post(req.body);
    if (res.status === 400 && "systemBreak" in req && req.systemBreak) {
      // ADR 0113: the provider refused the system-prompt breakpoint: try once with the top-level hint only.
      console.warn("arena_cache_system_break_refused", route.model, (await res.text().catch(() => "")).slice(0, 200));
      systemBreakRefused.add(route.model);
      res = await post(openRouterBody(route, messages, tools, cache, false).body);
    }
    if (res.status === 400 && req.hint !== "none") {
      // The provider refused the cache hint: send the same request without it (a 400 isn't billed) and stop adding it.
      console.warn("arena_cache_hint_refused", route.model, (await res.text().catch(() => "")).slice(0, 200));
      cacheRefused.add(route.model);
      res = await post(openRouterBody(route, messages, tools, null).body);
    }
    const body = (await res.json().catch(() => null)) as OpenAiShape | null;
    if (route.free && !res.ok && [402, 403, 404, 429].includes(res.status)) {
      // ADR 0109: out of free requests, a free endpoint refused (or none matches the no-training rule): the lane stops
      // until the next UTC day. Never the paid-credit "out of credit" path.
      throw new ProviderError(`OpenRouter free ${res.status}: ${body?.error?.message ?? "refused"}`.slice(0, 300), true, true, true);
    }
    if (!res.ok || !body?.choices?.[0]) {
      const msg = `OpenRouter ${res.status}: ${body?.error?.message ?? "no choices"}`.slice(0, 300);
      // Out of prepaid credit or over the key's limit (402, or 403 "key limit"): the bout pauses until the limit is
      // raised, like a rate limit, rather than being voided.
      const outOfCredit = res.status === 402 || (res.status === 403 && /limit|credit/i.test(msg));
      throw new ProviderError(msg, res.status === 429 || res.status >= 500 || res.status === 408 || outOfCredit, res.status === 429 || outOfCredit);
    }
    let reply = fromOpenAi(body, Date.now() - t0, body.provider ?? route.provider, false, 0, 0);
    // A BYOK turn without its upstream cost would look nearly free: read it from the generation stats instead.
    if (reply.byok === true && !reply.byokCost) {
      const up = typeof body.id === "string" && body.id ? await generationUpstreamCost(env.OPENROUTER_API_KEY, body.id, fetcher) : 0;
      reply = up > 0 ? { ...reply, cost: reply.cost + up, byokCost: up } : { ...reply, byokUnpriced: true };
    }
    return { ...reply, servedModel: typeof body.model === "string" && body.model ? body.model.slice(0, 120) : route.model };
  }

  let out: unknown;
  try {
    const input = { messages, tools: toolsParam(tools), temperature: 0, max_tokens: route.maxTokens ?? WORKERS_AI_MAX_TOKENS };
    out = cache?.key
      ? await env.AI.run(route.model as keyof AiModels, input as never, { extraHeaders: { "x-session-affinity": cache.key } })
      : await env.AI.run(route.model as keyof AiModels, input as never);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // "Capacity temporarily exceeded" and 429s mean "slow down", not a failed bout.
    throw new ProviderError(`Workers AI: ${msg}`.slice(0, 300), true, /\b429\b|rate.?limit|capacity/i.test(msg));
  }
  const ms = Date.now() - t0;
  const o = out as OpenAiShape & LegacyShape;
  const reply = o?.choices?.[0] ? fromOpenAi(o, ms, "cloudflare-workers-ai", true, route.priceIn, route.priceOut) : fromLegacy(o, ms, route);
  // Some models write their tool calls as text (Llama's pythonic format); read them for routes that say so.
  if (route.textToolCalls === "pythonic" && !reply.toolCalls.length) reply.toolCalls = parsePythonicCalls(reply.text, tools);
  return { ...reply, servedModel: route.model };
}

function fromLegacy(o: (OpenAiShape & LegacyShape) | null, ms: number, route: Extract<Route, { kind: "workers-ai" }>): ModelReply {
  // Older Workers AI shape: { response, tool_calls: [{ name, arguments }], usage }.
  const calls = (o?.tool_calls ?? []).map((c, i) => ({
    id: `call_${i}`,
    type: "function" as const,
    function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) },
  }));
  const tokensIn = o?.usage?.prompt_tokens ?? 0;
  const tokensOut = o?.usage?.completion_tokens ?? 0;
  return {
    text: typeof o?.response === "string" ? o.response : null,
    toolCalls: calls,
    tokensIn,
    tokensOut,
    cost: (tokensIn * route.priceIn + tokensOut * route.priceOut) / 1e6,
    costEstimated: true,
    latencyMs: ms,
    provider: "cloudflare-workers-ai",
    ...cacheCounts(o?.usage),
  };
}

interface OpenAiShape {
  choices?: { message?: { content?: string | null; reasoning?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; is_byok?: boolean; cost_details?: { upstream_inference_cost?: number | null } | null; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null };
  provider?: string;
  model?: string;
  /** OpenRouter's generation id. */
  id?: string;
  error?: { message?: string };
}

interface LegacyShape {
  response?: unknown;
  tool_calls?: { name: string; arguments?: unknown }[];
}

function fromOpenAi(o: OpenAiShape, ms: number, provider: string, estimated: boolean, priceIn: number, priceOut: number): ModelReply {
  const m = o.choices![0]!.message ?? {};
  const tokensIn = o.usage?.prompt_tokens ?? 0;
  const tokensOut = o.usage?.completion_tokens ?? 0;
  const byok = estimated ? {} : byokOf(o.usage);
  return {
    text: m.content ?? null,
    toolCalls: (m.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      type: "function",
      function: { name: c.function?.name ?? "", arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}) },
    })),
    tokensIn,
    tokensOut,
    // OpenRouter's `usage.cost` is what the generation was billed to credit, cache reads and writes included; a BYOK
    // turn adds what the provider billed our own key (ADR 0064).
    cost: estimated ? (tokensIn * priceIn + tokensOut * priceOut) / 1e6 : (o.usage?.cost ?? 0) + (byok.byokCost ?? 0),
    costEstimated: estimated,
    latencyMs: ms,
    provider,
    ...cacheCounts(o.usage),
    ...(estimated ? {} : byok),
  };
}

/**
 * BYOK accounting from OpenRouter's usage object (usage accounting docs, checked 26 Oct 2026): `cost` is what our
 * OpenRouter account was charged (for a BYOK request, only OpenRouter's BYOK fee, 5% at most);
 * `cost_details.upstream_inference_cost` is what the upstream provider charged our own key. The upstream figure is
 * added to the turn's cost only when the turn really was BYOK: never when `is_byok` is false (a credit turn that
 * happens to report an upstream figure would otherwise be counted twice), and, when `is_byok` isn't reported, only when
 * the credit charge is no more than a fee-sized fraction of the upstream figure.
 */
export const BYOK_FEE_MAX_SHARE = 0.1;
/**
 * A Claude (BYOK) reply that was billed to OpenRouter credit instead of our key (ADR 0064 Amendment 2): OpenRouter said
 * so (`is_byok` false, usage type "Credits"), or it charged credit without reporting a BYOK cost.
 */
export const billedToCredit = (r: Pick<ModelReply, "byok" | "byokCost" | "cost" | "costEstimated">) =>
  !r.costEstimated && (r.byok === false || (r.byok === undefined && !r.byokCost && r.cost > 0));
export function byokOf(u: OpenAiShape["usage"]): Pick<ModelReply, "byok" | "byokCost"> {
  const up = Number(u?.cost_details?.upstream_inference_cost ?? 0);
  const upstream = Number.isFinite(up) && up > 0 ? up : 0;
  if (u?.is_byok === false) return { byok: false };
  if (u?.is_byok === true) return { byok: true, ...(upstream > 0 ? { byokCost: upstream } : {}) };
  const charged = Number(u?.cost ?? 0);
  if (upstream > 0 && Number.isFinite(charged) && charged <= upstream * BYOK_FEE_MAX_SHARE) return { byok: true, byokCost: upstream };
  return {};
}

/**
 * The upstream (BYOK) cost of one generation from OpenRouter's generation stats (GET /api/v1/generation?id=), for a
 * turn that says it was BYOK but carries no upstream cost in its usage object. The stats can lag a moment behind the
 * reply, so a 404 is asked once more after a second. 0 when it can't be read.
 */
export async function generationUpstreamCost(key: string, id: string, fetcher: typeof fetch = fetch, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<number> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetcher(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.status === 404 && i === 0) {
        await wait(1000);
        continue;
      }
      if (!res.ok) return 0;
      const j = (await res.json().catch(() => null)) as { data?: { upstream_inference_cost?: unknown } } | null;
      const v = Number(j?.data?.upstream_inference_cost ?? 0);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Cached-token counts from `usage.prompt_tokens_details`, only when the provider reports them. */
function cacheCounts(u: OpenAiShape["usage"]): Pick<ModelReply, "cachedTokens" | "cacheWriteTokens"> {
  const d = u?.prompt_tokens_details;
  return {
    ...(typeof d?.cached_tokens === "number" ? { cachedTokens: d.cached_tokens } : {}),
    ...(typeof d?.cache_write_tokens === "number" ? { cacheWriteTokens: d.cache_write_tokens } : {}),
  };
}
