// Caches OpenRouter's public model catalog (no key needed) in KV, so a session can check exact model ids, list
// prices and tool support before choosing a lineup. Runs hourly with the registry seeding.

export const CATALOG_KEY = "arena:or-models";
const LABS = ["anthropic/", "openai/", "google/", "deepseek/", "meta-llama/", "qwen/", "mistralai/", "moonshotai/", "z-ai/"]; // xAI excluded (ADR 0013 §7)

interface OrModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

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
  return rows.length;
}

/** Notable releases (STATUS 0f): tool-capable models from the big labs added to OpenRouter in the last 8 days. */
export async function newReleases(env: Pick<Env, "KV">, now = Date.now()) {
  const c = (await env.KV.get(CATALOG_KEY, "json")) as { models: { id: string; name?: string; created?: number; in: number; out: number }[] } | null;
  const since = (now - 8 * 86_400_000) / 1000;
  return (c?.models ?? []).filter((m) => (m.created ?? 0) >= since).map((m) => ({ id: m.id, name: m.name ?? m.id, in: m.in, out: m.out }));
}
