// Caches OpenRouter's public model catalog (no key needed) in KV, so a session can check exact model ids, list
// prices and tool support before choosing a lineup. Runs hourly with the registry seeding.

import { ALL_MODELS } from "./lineup";

export const CATALOG_KEY = "arena:or-models";
const LABS = ["anthropic/", "openai/", "google/", "deepseek/", "meta/", "meta-llama/", "qwen/", "mistralai/", "moonshotai/", "z-ai/"]; // xAI excluded (ADR 0013 §7)

interface OrModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/** Each embargoed model's OpenRouter endpoints (providers, prices, data policy), for choosing its pinned provider (K2). */
export const ENDPOINTS_KEY = "arena:or-endpoints";

export async function refreshCatalog(env: Pick<Env, "KV">, fetcher: typeof fetch = fetch) {
  const res = await fetcher("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const { data } = (await res.json()) as { data: OrModel[] };
  const rows = data
    .filter((m) => LABS.some((p) => m.id.startsWith(p)) && m.supported_parameters?.includes("tools"))
    .map((m) => ({
      id: m.id,
      name: m.name,
      created: m.created,
      context: m.context_length,
      // $ per million tokens.
      in: Math.round(Number(m.pricing?.prompt ?? 0) * 1e6 * 1000) / 1000,
      out: Math.round(Number(m.pricing?.completion ?? 0) * 1e6 * 1000) / 1000,
    }))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  await env.KV.put(CATALOG_KEY, JSON.stringify({ at: new Date().toISOString(), models: rows }), { expirationTtl: 3 * 86400 });
  const endpoints: Record<string, unknown> = {};
  for (const m of ALL_MODELS.filter((x) => x.embargoed && x.route.kind === "openrouter")) {
    const r = await fetcher(`https://openrouter.ai/api/v1/models/${m.route.model}/endpoints`).catch(() => null);
    const body = r?.ok ? ((await r.json().catch(() => null)) as { data?: { endpoints?: { provider_name?: string; tag?: string; pricing?: unknown; supported_parameters?: string[]; status?: number }[] } } | null) : null;
    endpoints[m.route.model] = (body?.data?.endpoints ?? []).map((e) => ({ provider: e.provider_name, tag: e.tag, pricing: e.pricing, tools: e.supported_parameters?.includes("tools") ?? null, tool_choice: e.supported_parameters?.includes("tool_choice") ?? null, status: e.status }));
  }
  if (Object.keys(endpoints).length) await env.KV.put(ENDPOINTS_KEY, JSON.stringify({ at: new Date().toISOString(), endpoints }), { expirationTtl: 3 * 86400 });
  return rows.length;
}

/** Notable releases (STATUS 0f): tool-capable models from the big labs added to OpenRouter in the last 8 days. */
export async function newReleases(env: Pick<Env, "KV">, now = Date.now()) {
  const c = (await env.KV.get(CATALOG_KEY, "json")) as { models: { id: string; name?: string; created?: number; in: number; out: number }[] } | null;
  const since = (now - 8 * 86_400_000) / 1000;
  // An embargoed model (K2) is never named on a public surface, and /api/v1/arena/status shows these.
  const hidden = new Set(ALL_MODELS.filter((x) => x.embargoed && x.route.kind === "openrouter").map((x) => x.route.model));
  return (c?.models ?? []).filter((m) => (m.created ?? 0) >= since && !hidden.has(m.id)).map((m) => ({ id: m.id, name: m.name ?? m.id, in: m.in, out: m.out }));
}
