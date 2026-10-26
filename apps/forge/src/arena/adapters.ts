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
  /** Dollars. OpenRouter's `usage.cost`; for Workers AI, tokens × list price (estimated). */
  cost: number;
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

const toolsParam = (tools: ToolSpec[]) => tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** The OpenRouter request body. With `cache`, the route's cache hint is added and nothing else changes. */
export function openRouterBody(route: Extract<Route, { kind: "openrouter" }>, messages: ChatMessage[], tools: ToolSpec[], cache: CacheOptions | null) {
  const brief = messages.findIndex((m) => m.role === "user");
  let hint = cache && !cacheRefused.has(route.model) ? cacheHint(route) : "none";
  if (hint === "brief-breakpoint" && brief < 0) hint = "none";
  const sent =
    hint === "brief-breakpoint"
      ? messages.map((m, i) => (i === brief ? { role: "user" as const, content: [{ type: "text" as const, text: m.content ?? "", cache_control: EPHEMERAL }] } : m))
      : messages;
  return {
    hint,
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
    if (res.status === 400 && req.hint !== "none") {
      // The provider refused the cache hint: send the same request without it (a 400 isn't billed) and stop adding it.
      console.warn("arena_cache_hint_refused", route.model, (await res.text().catch(() => "")).slice(0, 200));
      cacheRefused.add(route.model);
      res = await post(openRouterBody(route, messages, tools, null).body);
    }
    const body = (await res.json().catch(() => null)) as OpenAiShape | null;
    if (!res.ok || !body?.choices?.[0]) {
      const msg = `OpenRouter ${res.status}: ${body?.error?.message ?? "no choices"}`.slice(0, 300);
      // Out of prepaid credit or over the key's limit (402, or 403 "key limit"): the bout pauses until the limit is
      // raised, like a rate limit, rather than being voided.
      const outOfCredit = res.status === 402 || (res.status === 403 && /limit|credit/i.test(msg));
      throw new ProviderError(msg, res.status === 429 || res.status >= 500 || res.status === 408 || outOfCredit, res.status === 429 || outOfCredit);
    }
    return { ...fromOpenAi(body, Date.now() - t0, body.provider ?? route.provider, false, 0, 0), servedModel: typeof body.model === "string" && body.model ? body.model.slice(0, 120) : route.model };
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
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null };
  provider?: string;
  model?: string;
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
  return {
    text: m.content ?? null,
    toolCalls: (m.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      type: "function",
      function: { name: c.function?.name ?? "", arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}) },
    })),
    tokensIn,
    tokensOut,
    // OpenRouter's `usage.cost` is what the generation was billed, cache reads and writes included.
    cost: estimated ? (tokensIn * priceIn + tokensOut * priceOut) / 1e6 : (o.usage?.cost ?? 0),
    costEstimated: estimated,
    latencyMs: ms,
    provider,
    ...cacheCounts(o.usage),
  };
}

/** Cached-token counts from `usage.prompt_tokens_details`, only when the provider reports them. */
function cacheCounts(u: OpenAiShape["usage"]): Pick<ModelReply, "cachedTokens" | "cacheWriteTokens"> {
  const d = u?.prompt_tokens_details;
  return {
    ...(typeof d?.cached_tokens === "number" ? { cachedTokens: d.cached_tokens } : {}),
    ...(typeof d?.cache_write_tokens === "number" ? { cacheWriteTokens: d.cache_write_tokens } : {}),
  };
}
