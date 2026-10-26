import { registryFingerprint } from "@forge/shared/light";
import { canonicalToolId } from "./tools";

// Fingerprints from the package registries (ADR 0056). A field report is pinned to a version's fingerprint, and on
// 26 Oct that was where filing stopped: a person on /report, or an agent with only a package id and version, had no
// way to know "sha256:<64 hex>". For npm and PyPI ids the Forge now looks it up itself, the same way the House, the
// plugin and the CLI do (npm: sha256 of dist.integrity; PyPI: PyPI's sha256 of the sdist). Ids and versions only are
// sent; answers are kept in KV for a day.

const TIMEOUT_MS = 4000;
const CACHE_SECONDS = 86_400;

/** How the registries are reached. Tests swap in recorded answers (test/apply-migrations.ts). */
export const registryTransport: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };

const sha256Hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** True for the ids whose fingerprint the Forge can look up. */
export const registryId = (id: string) => /^(npm|pypi):/i.test(id.trim());

/** The version and fingerprint for an npm: or pypi: id at a version (the latest without one). Null when unknown. Never throws. */
export async function lookupFingerprint(env: Pick<Env, "KV">, id: string, version: string | undefined) {
  if (!registryId(id)) return null;
  const key = `regfp:${canonicalToolId(id)}@${version ?? "latest"}`;
  try {
    const hit = await env.KV.get<{ version: string; fingerprint: string }>(key, "json");
    if (hit) return hit;
  } catch {}
  const r = await registryFingerprint(canonicalToolId(id), version, { fetch: registryTransport.fetch, sha256Hex, signal: AbortSignal.timeout(TIMEOUT_MS) });
  // "latest" moves, so only a pinned version's answer is kept.
  if (r && version) await env.KV.put(key, JSON.stringify(r), { expirationTtl: CACHE_SECONDS }).catch(() => {});
  return r;
}

/**
 * A report body with the fingerprint filled in from the registry, when the id is npm: or pypi:, a version is given and
 * the fingerprint isn't. Anything else is returned as it came, for the schema to judge.
 */
export async function withRegistryFingerprint(env: Pick<Env, "KV">, input: unknown): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const tool = (input as { tool?: unknown }).tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return input;
  const { id, version, fingerprint } = tool as { id?: unknown; version?: unknown; fingerprint?: unknown };
  if (typeof id !== "string" || !registryId(id) || typeof version !== "string" || !version.trim() || (fingerprint !== undefined && fingerprint !== "" && fingerprint !== null)) return input;
  const r = await lookupFingerprint(env, id, version.trim());
  if (!r) return input;
  return { ...input, tool: { ...tool, version: r.version, fingerprint: r.fingerprint } };
}
