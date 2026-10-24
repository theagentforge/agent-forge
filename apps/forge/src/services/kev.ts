// CISA's Known Exploited Vulnerabilities catalog (crisis-wave plan P1, C3): the CVEs CISA has seen exploited in the
// wild. Read once a day from the hourly cron and kept in KV as a list of CVE ids only. A check marks an OSV advisory
// `exploited_in_wild` when one of its CVE aliases is on the list. Nothing else from the feed is kept.

import type { AdvisoryResult } from "./advisories";

export const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const KEY = "kev:ids";
const TRIED = "kev:tried";
const EVERY_MS = 20 * 3_600_000;
const CVE = /^CVE-\d{4}-\d{4,7}$/;
/** The catalog has well over a thousand entries; a much shorter list means a broken download, so it's not stored. */
export const KEV_MIN_ENTRIES = 500;

/** How CISA is reached. Tests swap in a recorded feed (test/apply-migrations.ts). */
export const kevTransport: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };

export interface KevList {
  updated: string;
  catalog_version: string | null;
  ids: string[];
}

/**
 * Downloads the catalog at most once every 20 hours and stores its CVE ids. Returns what it did. Never throws; on any
 * failure the previous list stays and it tries again in an hour.
 */
export async function refreshKev(env: Pick<Env, "KV">, now = Date.now(), fetcher: typeof fetch = kevTransport.fetch) {
  try {
    const tried = Number((await env.KV.get(TRIED)) ?? 0);
    if (now - tried < EVERY_MS) return { skipped: "too_soon" };
    // Until this one succeeds, the next attempt is due in an hour rather than 20.
    await env.KV.put(TRIED, String(now - EVERY_MS + 3_600_000));
    const res = await fetcher(KEV_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `status ${res.status}` };
    const body = (await res.json()) as { catalogVersion?: unknown; vulnerabilities?: { cveID?: unknown }[] };
    const list = Array.isArray(body?.vulnerabilities) ? body.vulnerabilities : [];
    const ids = [...new Set(list.map((v) => v?.cveID).filter((id): id is string => typeof id === "string" && CVE.test(id)))].sort();
    if (ids.length < KEV_MIN_ENTRIES) return { error: `only ${ids.length} entries` };
    const entry: KevList = { updated: new Date(now).toISOString(), catalog_version: typeof body.catalogVersion === "string" ? body.catalogVersion.slice(0, 32) : null, ids };
    await env.KV.put(KEY, JSON.stringify(entry));
    await env.KV.put(TRIED, String(now));
    return { stored: ids.length };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

/** Marks each advisory whose id or a CVE alias is on the KEV list, and says how fresh the list is. */
export function markExploited(r: AdvisoryResult, kev: Set<string>, asOf: string | null): AdvisoryResult {
  return {
    ...r,
    advisories: r.advisories.map((a) => ({ ...a, exploited_in_wild: [a.id, ...a.aliases].some((id) => kev.has(id)) })),
    kev_as_of: asOf,
  };
}

/** The KEV list in one read: its CVE ids and when it was downloaded. */
export async function kevState(env: Pick<Env, "KV">): Promise<{ ids: Set<string>; updated: string | null }> {
  try {
    const list = await env.KV.get<KevList>(KEY, "json");
    return { ids: new Set(list?.ids ?? []), updated: list?.updated ?? null };
  } catch {
    return { ids: new Set(), updated: null };
  }
}
