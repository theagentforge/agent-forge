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
}

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

const toolsParam = (tools: ToolSpec[]) => tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

export async function callModel(
  env: Pick<Env, "AI"> & { OPENROUTER_API_KEY?: string },
  route: Route,
  messages: ChatMessage[],
  tools: ToolSpec[],
  fetcher: typeof fetch = fetch,
): Promise<ModelReply> {
  const t0 = Date.now();
  if (route.kind === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new ProviderError("OPENROUTER_API_KEY is not set", false);
    const res = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://theagentforge.io", "X-Title": "The Forge Arena" },
      body: JSON.stringify({
        model: route.model,
        messages,
        tools: toolsParam(tools),
        tool_choice: "auto",
        temperature: 0,
        // Pinned provider, no fallbacks, no response caching; never used for training (ADR 0014 §9).
        provider: { order: [route.provider], allow_fallbacks: false, data_collection: "deny" },
        usage: { include: true },
      }),
    });
    const body = (await res.json().catch(() => null)) as OpenAiShape | null;
    if (!res.ok || !body?.choices?.[0]) {
      throw new ProviderError(`OpenRouter ${res.status}: ${body?.error?.message ?? "no choices"}`.slice(0, 300), res.status === 429 || res.status >= 500 || res.status === 408, res.status === 429);
    }
    return fromOpenAi(body, Date.now() - t0, body.provider ?? route.provider, false, 0, 0);
  }

  let out: unknown;
  try {
    out = await env.AI.run(route.model as keyof AiModels, { messages, tools: toolsParam(tools), temperature: 0, max_tokens: 2048 } as never);
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
  return reply;
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
  };
}

interface OpenAiShape {
  choices?: { message?: { content?: string | null; reasoning?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  provider?: string;
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
    cost: estimated ? (tokensIn * priceIn + tokensOut * priceOut) / 1e6 : (o.usage?.cost ?? 0),
    costEstimated: estimated,
    latencyMs: ms,
    provider,
  };
}
