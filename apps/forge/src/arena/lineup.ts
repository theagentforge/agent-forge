import type { Division } from "@forge/arena";

// Who fights. Every headline model runs through the OpenRouter key with a pinned provider (ADR 0014 §8–9).
// Workers AI models are for the practice dry run only: they measure real token use per bout on our own harness at
// near-zero cost, before any OpenRouter spend. Practice results are published, labelled, and never ranked.

export type Route =
  | { kind: "openrouter"; model: string; provider: string }
  | {
      kind: "workers-ai";
      model: string;
      priceIn: number;
      priceOut: number;
      /** The model writes tool calls as text in this format, which Workers AI doesn't parse (see arena/pythonic.ts). */
      textToolCalls?: "pythonic";
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
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", lab: "DeepSeek (open weights)", division: "heavyweight", route: { kind: "workers-ai", model: "@cf/deepseek-ai/deepseek-v4-pro-0813", priceIn: 1.32, priceOut: 3.96 } },
  { id: "qwen3.8-max", name: "Qwen3.8 Max", lab: "Alibaba", division: "heavyweight", route: { kind: "openrouter", model: "qwen/qwen3.8-max-0902", provider: "alibaba" } },
];

export const ALL_MODELS = [...PRACTICE, ...HEADLINE];
/** Every model currently entered, for the "Which models we test" list. */
export const testedModels = () => ALL_MODELS.filter((m) => !m.retired);
export const modelById = (id: string) => ALL_MODELS.find((m) => m.id === id) ?? null;
