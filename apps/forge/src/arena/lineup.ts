import type { Division } from "@forge/arena";
import { EMBARGOED_LINEUP } from "./lineup-embargoed";

// Who fights. Every headline model runs through the OpenRouter key with a pinned provider (ADR 0014 §8–9).
// Workers AI models are for the practice dry run only: they measure real token use per bout on our own harness at
// near-zero cost, before any OpenRouter spend. Practice results are published, labelled, and never ranked.

export type Route =
  | {
      kind: "openrouter";
      model: string;
      provider: string;
      /**
       * An OpenRouter `:free` variant (ADR 0109): sent with no provider order, no fallbacks and a zero price cap, so it is
       * served free or not at all. Its own lineup entry, never merged with the paid model's rows.
       */
      free?: true;
    }
  | {
      kind: "workers-ai";
      model: string;
      priceIn: number;
      priceOut: number;
      /** The model writes tool calls as text in this format, which Workers AI doesn't parse (see arena/pythonic.ts). */
      textToolCalls?: "pythonic";
      /**
       * Largest reply per turn. Default 2048 (practice). Headline models get more: at 2048, DeepSeek V4 Pro's replies
       * were cut off mid-reasoning 13-20 times a Hard bout in Crucible 2, costing turns that OpenRouter models (no
       * per-reply cap) don't spend, so its results weren't comparable (23 Oct).
       */
      maxTokens?: number;
    };

export interface ArenaModel {
  id: string;
  name: string;
  /** Lab named in plain text, "not affiliated" (ADR 0013 §3). */
  lab: string;
  division: Division | "practice";
  route: Route;
  /** Kept so old runs still resolve, but no longer entered in new events or listed as tested. */
  retired?: true;
  /**
   * Run, stored and refereed, but never shown: no public page, API, feed, share card, clip or social draft reads its
   * runs or lists the model (K2). Lifted only on Dinike's word, by deleting this flag.
   */
  embargoed?: true;
}

/** Practice lineup: Cloudflare Workers AI list prices in $ per million tokens (checked 15 Oct 2026). */
export const PRACTICE: ArenaModel[] = [
  // gpt-oss-120b was dropped after dry run 1: Workers AI serves it through the Responses API format, not chat messages.
  { id: "gpt-oss-120b", name: "gpt-oss-120b", lab: "OpenAI (open weights)", division: "practice", retired: true, route: { kind: "workers-ai", model: "@cf/openai/gpt-oss-120b", priceIn: 0.35, priceOut: 0.75 } },
  { id: "llama-4-scout", name: "Llama 4 Scout", lab: "Meta (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/meta/llama-4-scout-17b-16e-instruct", priceIn: 0.27, priceOut: 0.85, textToolCalls: "pythonic" } },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", lab: "Z.ai", division: "practice", route: { kind: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", priceIn: 0.15, priceOut: 0.5 } },
  { id: "gemma-4-26b", name: "Gemma 4 26B", lab: "Google (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/google/gemma-4-26b-a4b-it", priceIn: 0.1, priceOut: 0.3 } },
  { id: "qwen3-30b", name: "Qwen3 30B", lab: "Alibaba (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/qwen/qwen3-30b-a3b-fp8", priceIn: 0.0509, priceOut: 0.335 } },
  // Added 15 Oct 2026 so practice covers open models from many labs and countries (Dinike: "we should test all the
  // models"). Prices checked in the Workers AI catalog the same day. EuroLLM and Apertus list no price yet, so they are
  // estimated at Mistral Small's rate, which overstates their cost, so the daily cap stops early rather than late.
  // Both were retired on their first runs: Workers AI refused Apertus ("This account is not allowed to access") and
  // EuroLLM ("AI model does not have config").
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", lab: "DeepSeek (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/deepseek-ai/deepseek-v4-flash-0731", priceIn: 0.44, priceOut: 1.32 } },
  { id: "kimi-k2.6", name: "Kimi K2.6", lab: "Moonshot AI (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/moonshotai/kimi-k2.6", priceIn: 0.95, priceOut: 4 } },
  { id: "glm-5.3", name: "GLM 5.3", lab: "Z.ai (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/zai-org/glm-5.3", priceIn: 1.4, priceOut: 4.4 } },
  { id: "qwen3.8-27b", name: "Qwen3.8 27B", lab: "Alibaba (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/qwen/qwen3.8-27b", priceIn: 0.45, priceOut: 3.2 } },
  { id: "mistral-small-3.1", name: "Mistral Small 3.1", lab: "Mistral AI (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/mistralai/mistral-small-3.1-24b-instruct", priceIn: 0.351, priceOut: 0.555 } },
  { id: "nemotron-3-120b", name: "Nemotron 3 120B", lab: "NVIDIA (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/nvidia/nemotron-3-120b-a12b", priceIn: 0.5, priceOut: 1.5 } },
  { id: "llama-3.3-70b", name: "Llama 3.3 70B", lab: "Meta (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", priceIn: 0.293, priceOut: 2.253 } },
  { id: "granite-4-micro", name: "Granite 4.0 Micro", lab: "IBM (open weights)", division: "practice", route: { kind: "workers-ai", model: "@cf/ibm-granite/granite-4.0-h-micro", priceIn: 0.017, priceOut: 0.112 } },
  // Added 20 Oct 2026 (Dinike: "add frontier models"): the low-cost models agent builders use most (OpenRouter token
  // share and app defaults, researched 20 Oct). Through the OpenRouter key, so they count toward the monthly cap, each
  // pinned to the lab's own servers (DeepSeek's own API fails our no-data-collection rule, so DeepInfra, which doesn't
  // train on prompts). Prices from the OpenRouter catalog on 20 Oct, in $ per million tokens: Luna 0.20/1.20,
  // V4.1 Flash 0.14/0.42, Gemini 3.8 Flash 0.825/4.125, Haiku 5.5 0.10/0.50.
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", lab: "OpenAI", division: "practice", route: { kind: "openrouter", model: "openai/gpt-5.6-luna", provider: "openai" } },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", lab: "DeepSeek (open weights)", division: "practice", route: { kind: "openrouter", model: "deepseek/deepseek-v4.1-flash", provider: "deepinfra" } },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", lab: "Google", division: "practice", route: { kind: "openrouter", model: "google/gemini-3.8-flash", provider: "google-vertex" } },
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", lab: "Anthropic", division: "practice", route: { kind: "openrouter", model: "anthropic/claude-haiku-5.5", provider: "anthropic" } },
  // B3-13 (ADR 0109): the free-model lane. OpenRouter's tool-capable `:free` variants from the labs we cover, read from
  // the cached catalog on 29 Oct 2026 (arena:or-models: these two were the only ones). Separate entries from any paid
  // or Workers AI row of the same model: a free variant can differ (context, endpoints, quantisation).
  { id: "gemma-4-26b-free", name: "Gemma 4 26B (free variant)", lab: "Google (open weights)", division: "practice", route: { kind: "openrouter", model: "google/gemma-4-26b-a4b-it:free", provider: "free", free: true } },
  { id: "gemma-4-31b-free", name: "Gemma 4 31B (free variant)", lab: "Google (open weights)", division: "practice", route: { kind: "openrouter", model: "google/gemma-4-31b-it:free", provider: "free", free: true } },
  { id: "eurollm-9b", name: "EuroLLM 9B", lab: "EuroLLM project (open weights)", division: "practice", retired: true, route: { kind: "workers-ai", model: "@cf/utter-project/eurollm-9b-it", priceIn: 0.351, priceOut: 0.555 } },
  { id: "apertus-8b", name: "Apertus 8B", lab: "Swiss AI Initiative (open weights)", division: "practice", retired: true, route: { kind: "workers-ai", model: "@cf/swiss-ai/apertus-v1.5-8b", priceIn: 0.351, priceOut: 0.555 } },
];

/**
 * Headline lineup, filled in once the OpenRouter catalog has been read (cron caches it in KV `arena:or-models`)
 * and Dinike has confirmed the Heavyweight choice (DINIKE_TODO). Empty until then, so nothing can spend by accident.
 */
export const HEADLINE: ArenaModel[] = [
  // Heavyweight at launch: each lab's everyday workhorse (ADR 0014 §10, DRY-RUN-1), confirmed by Dinike on 15 Oct.
  // Newest workhorse version in the OpenRouter catalog on 15 Oct; each pinned to the lab's own servers, no fallbacks.
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", lab: "Anthropic", division: "heavyweight", route: { kind: "openrouter", model: "anthropic/claude-sonnet-5.5", provider: "anthropic" } },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", lab: "OpenAI", division: "heavyweight", route: { kind: "openrouter", model: "openai/gpt-6.1-sol", provider: "openai" } },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", lab: "Google", division: "heavyweight", route: { kind: "openrouter", model: "google/gemini-4-argon", provider: "google-vertex" } },
  { id: "mistral-large-4", name: "Mistral Large 4", lab: "Mistral AI", division: "heavyweight", route: { kind: "openrouter", model: "mistralai/mistral-large-4-0", provider: "mistral" } },
  // DeepSeek's own API is filtered out by our no-data-collection rule (OpenRouter 404, 15 Oct), so DeepSeek's workhorse
  // runs on Cloudflare Workers AI: the same model (V4 Pro 0813), no training on prompts. Its cost is estimated at list
  // price, so it counts toward the practice allowance; its runs in headline events are still headline results.
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", lab: "DeepSeek (open weights)", division: "heavyweight", route: { kind: "workers-ai", model: "@cf/deepseek-ai/deepseek-v4-pro-0813", priceIn: 1.32, priceOut: 3.96, maxTokens: 8192 } },
  { id: "qwen3.8-max", name: "Qwen3.8 Max", lab: "Alibaba", division: "heavyweight", route: { kind: "openrouter", model: "qwen/qwen3.8-max-0902", provider: "alibaba" } },
  // Embargoed entries (K2) live in their own file, which the public mirror replaces with an empty list.
  ...EMBARGOED_LINEUP,
];

export const ALL_MODELS = [...PRACTICE, ...HEADLINE];
/** Models whose runs no public surface may read (K2). */
export const EMBARGOED_MODEL_IDS = ALL_MODELS.filter((m) => m.embargoed).map((m) => m.id);
export const isEmbargoed = (id: string) => EMBARGOED_MODEL_IDS.includes(id);
/** Every model currently entered and public, for the "Which models we test" list. */
export const testedModels = () => ALL_MODELS.filter((m) => !m.retired && !m.embargoed);
export const modelById = (id: string) => ALL_MODELS.find((m) => m.id === id) ?? null;
