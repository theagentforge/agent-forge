import { VERSION_PATTERN } from "@forge/shared";
import { and, eq } from "drizzle-orm";
import * as t from "../db/schema";
import { newId, type Db } from "./db";

// Published advisories from OSV (osv.dev), the open database that serves PyPI, npm and GitHub advisories plus the
// OpenSSF malicious-package (MAL-) records (crisis-wave plan P1, C1). A check asks OSV about the exact package and
// version; answers are cached in KV for 6 hours and, for tools we know, kept in public_signals (source "osv").
//
// Only identifiers leave this file: advisory ids, aliases, versions, dates and a link we build ourselves. OSV's
// summary and details are third-party free text, and free text echoed to agents is a prompt-injection channel
// (SECURITY_REVIEW.md, finding 1), so they are never read into results.

export const OSV_API = "https://api.osv.dev/v1";
export const OSV_CACHE_SECONDS = 6 * 3600;
const TIMEOUT_MS = 4000;
/** How OSV is reached. Tests swap in recorded responses (test/apply-migrations.ts), so no test touches the network. */
export const osvTransport: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };
/** At most this many advisories per package in a result, newest first; the total is always given. */
export const MAX_ADVISORIES = 25;
/** OSV accepts up to 1,000 queries per querybatch. */
export const OSV_BATCH_MAX = 1000;

export type OsvEcosystem = "npm" | "PyPI";
export interface OsvPackage {
  ecosystem: OsvEcosystem;
  name: string;
}

export interface Advisory {
  id: string;
  /** "malicious": an OpenSSF MAL- record (a published malicious package). "vulnerability": GHSA, PYSEC, CVE… */
  kind: "malicious" | "vulnerability";
  aliases: string[];
  /** True when OSV matched this exact version; null when no version was asked about. */
  affects_version: boolean | null;
  /** Versions OSV lists as fixing it, if any (a malicious release usually has none: the earlier one is the safe one). */
  fixed: string[];
  published: string | null;
  modified: string | null;
  url: string;
  /** True when one of its CVE aliases is on CISA's Known Exploited Vulnerabilities list (services/kev.ts). */
  exploited_in_wild?: boolean;
}

export interface AdvisoryResult {
  source: "osv";
  ecosystem: OsvEcosystem;
  package: string;
  version: string | null;
  checked_at: string;
  total: number;
  advisories: Advisory[];
  /** When the CISA KEV list used for `exploited_in_wild` was downloaded; null when it isn't available yet. */
  kev_as_of?: string | null;
}

const ID_RE = /^[A-Z][A-Z0-9]{1,15}-[A-Za-z0-9._:-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;

/** PEP 503 name normalisation: lower case, runs of "-", "_" and "." become "-". */
export const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The OSV package for a Forge tool id: npm:<name> or pypi:<name>. Other ids have no OSV ecosystem we query. */
export function osvPackageFor(id: string): OsvPackage | null {
  const m = /^(npm|pypi):(.+)$/i.exec(id.trim());
  if (!m) return null;
  const name = m[2]!.trim();
  if (m[1]!.toLowerCase() === "npm") return NPM_NAME.test(name.toLowerCase()) ? { ecosystem: "npm", name: name.toLowerCase() } : null;
  return PYPI_NAME.test(name) && name.length <= 128 ? { ecosystem: "PyPI", name: pypiName(name) } : null;
}

const validVersion = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && VERSION_PATTERN.test(v);
const validDate = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v : null);
const samePackage = (a: { ecosystem?: unknown; name?: unknown } | undefined, pkg: OsvPackage) =>
  !!a && a.ecosystem === pkg.ecosystem && typeof a.name === "string" && (pkg.ecosystem === "PyPI" ? pypiName(a.name) : a.name.toLowerCase()) === pkg.name;

type OsvVuln = {
  id?: unknown;
  aliases?: unknown;
  published?: unknown;
  modified?: unknown;
  affected?: { package?: { ecosystem?: unknown; name?: unknown }; ranges?: { events?: { fixed?: unknown }[] }[] }[];
};

/** One OSV record, reduced to identifiers. Null when it isn't a well-formed record about this package. */
export function parseOsvVuln(v: OsvVuln, pkg: OsvPackage, version: string | null): Advisory | null {
  if (typeof v?.id !== "string" || !ID_RE.test(v.id)) return null;
  const affected = (Array.isArray(v.affected) ? v.affected : []).filter((a) => samePackage(a?.package, pkg));
  if (!affected.length) return null;
  const aliases = (Array.isArray(v.aliases) ? v.aliases : []).filter((a): a is string => typeof a === "string" && ID_RE.test(a)).slice(0, 10);
  const fixed = [
    ...new Set(affected.flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed))).filter(validVersion)),
  ].slice(0, 10);
  return {
    id: v.id,
    kind: v.id.startsWith("MAL-") || aliases.some((a) => a.startsWith("MAL-")) ? "malicious" : "vulnerability",
    aliases,
    affects_version: version ? true : null,
    fixed,
    published: validDate(v.published),
    modified: validDate(v.modified),
    url: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`,
  };
}

// Which copy of one advisory to keep when OSV lists it under several ids (GHSA-… and PYSEC-… for the same CVE).
const ID_RANK = ["MAL-", "GHSA-", "PYSEC-"];
const rank = (id: string) => {
  const i = ID_RANK.findIndex((p) => id.startsWith(p));
  return i < 0 ? ID_RANK.length : i;
};

/**
 * One entry per advisory: a record whose id is an alias of one already kept is folded into it (aliases and fixed
 * versions merged). On 24 Oct `pypi:litellm` listed 24 records that were 12 advisories, each twice.
 */
export function mergeAliases(list: Advisory[]): Advisory[] {
  const ordered = [...list].sort((a, b) => (a.kind === b.kind ? rank(a.id) - rank(b.id) : a.kind === "malicious" ? -1 : 1));
  const kept: Advisory[] = [];
  const owner = new Map<string, Advisory>();
  for (const a of ordered) {
    const into = [a.id, ...a.aliases].map((id) => owner.get(id)).find(Boolean);
    if (into) {
      into.aliases = [...new Set([...into.aliases, a.id, ...a.aliases])].filter((id) => id !== into.id).slice(0, 10);
      into.fixed = [...new Set([...into.fixed, ...a.fixed])];
      if (a.affects_version) into.affects_version = true;
      if (a.modified && (!into.modified || a.modified > into.modified)) into.modified = a.modified;
    } else {
      const copy = { ...a, aliases: [...a.aliases], fixed: [...a.fixed] };
      kept.push(copy);
      for (const id of [a.id, ...a.aliases]) if (!owner.has(id)) owner.set(id, copy);
      continue;
    }
    for (const id of [a.id, ...a.aliases]) if (!owner.has(id)) owner.set(id, into);
  }
  return kept;
}

/** One entry per advisory, newest first, malicious records ahead of vulnerabilities, capped; keeps the total. */
function summarise(pkg: OsvPackage, version: string | null, raw: Advisory[], now: number): AdvisoryResult {
  const list = mergeAliases(raw);
  const sorted = [...list].sort((a, b) => (a.kind === b.kind ? (b.modified ?? "").localeCompare(a.modified ?? "") : a.kind === "malicious" ? -1 : 1));
  return { source: "osv", ecosystem: pkg.ecosystem, package: pkg.name, version, checked_at: new Date(now).toISOString(), total: list.length, advisories: sorted.slice(0, MAX_ADVISORIES) };
}

const cacheKey = (pkg: OsvPackage, version: string | null) => `osv:q:${pkg.ecosystem}:${pkg.name}:${version ?? "*"}`;

/**
 * Asks OSV about one package, and one version when given (then only advisories affecting that version come back).
 * Cached for 6 hours. Returns null when OSV can't be reached: "not checked", never "clear". Never throws.
 */
export async function queryAdvisories(
  env: Pick<Env, "KV">,
  pkg: OsvPackage,
  version: string | null,
  opts: { fetcher?: typeof fetch; now?: number } = {},
): Promise<AdvisoryResult | null> {
  const now = opts.now ?? Date.now();
  const v = version && validVersion(version) ? version : null;
  try {
    const hit = await env.KV.get<AdvisoryResult>(cacheKey(pkg, v), "json");
    if (hit) return hit;
  } catch {}
  try {
    const res = await (opts.fetcher ?? osvTransport.fetch)(`${OSV_API}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: { name: pkg.name, ecosystem: pkg.ecosystem }, ...(v ? { version: v } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { vulns?: OsvVuln[] };
    const list = (Array.isArray(body.vulns) ? body.vulns : []).map((x) => parseOsvVuln(x, pkg, v)).filter((x): x is Advisory => !!x);
    const result = summarise(pkg, v, list, now);
    await env.KV.put(cacheKey(pkg, v), JSON.stringify(result), { expirationTtl: OSV_CACHE_SECONDS }).catch(() => {});
    return result;
  } catch {
    return null;
  }
}

/** One advisory's full record from OSV (for querybatch hits, which come back as ids only). Cached for 6 hours. */
async function vulnById(env: Pick<Env, "KV">, id: string, fetcher: typeof fetch): Promise<OsvVuln | null> {
  if (!ID_RE.test(id)) return null;
  const key = `osv:v:${id}`;
  try {
    const hit = await env.KV.get<OsvVuln>(key, "json");
    if (hit) return hit;
  } catch {}
  try {
    const res = await fetcher(`${OSV_API}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = (await res.json()) as OsvVuln;
    // Keep only the fields parseOsvVuln reads, so no free text is ever stored.
    const slim: OsvVuln = { id: v.id, aliases: v.aliases, published: v.published, modified: v.modified, affected: (v.affected ?? []).map((a) => ({ package: a.package, ranges: (a.ranges ?? []).map((r) => ({ events: (r.events ?? []).map((e) => ({ fixed: e.fixed })) })) })) };
    await env.KV.put(key, JSON.stringify(slim), { expirationTtl: OSV_CACHE_SECONDS }).catch(() => {});
    return slim;
  } catch {
    return null;
  }
}

/**
 * Asks OSV about many exact versions at once (querybatch), then reads the full record of each advisory found.
 * One entry per item, in order: the advisories affecting that version ([] for none), or null when OSV couldn't be
 * reached for it. Never throws.
 */
export async function queryAdvisoriesBatch(
  env: Pick<Env, "KV">,
  items: { pkg: OsvPackage; version: string }[],
  opts: { fetcher?: typeof fetch; now?: number } = {},
): Promise<(AdvisoryResult | null)[]> {
  const fetcher = opts.fetcher ?? osvTransport.fetch;
  const now = opts.now ?? Date.now();
  const out: (AdvisoryResult | null)[] = items.map(() => null);
  for (let start = 0; start < items.length; start += OSV_BATCH_MAX) {
    const chunk = items.slice(start, start + OSV_BATCH_MAX);
    let results: { vulns?: { id?: unknown }[] }[] | null = null;
    try {
      const res = await fetcher(`${OSV_API}/querybatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: chunk.map((i) => ({ package: { name: i.pkg.name, ecosystem: i.pkg.ecosystem }, version: i.version })) }),
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      });
      if (res.ok) results = ((await res.json()) as { results?: { vulns?: { id?: unknown }[] }[] }).results ?? null;
    } catch {}
    if (!results) continue;
    for (let i = 0; i < chunk.length; i++) {
      const ids = (results[i]?.vulns ?? []).map((v) => v.id).filter((id): id is string => typeof id === "string" && ID_RE.test(id));
      const vulns = await Promise.all(ids.slice(0, MAX_ADVISORIES).map((id) => vulnById(env, id, fetcher)));
      const list = vulns.map((v) => (v ? parseOsvVuln(v, chunk[i]!.pkg, chunk[i]!.version) : null)).filter((x): x is Advisory => !!x);
      out[start + i] = { ...summarise(chunk[i]!.pkg, chunk[i]!.version, list, now), total: ids.length };
    }
  }
  return out;
}

/** Keeps the latest OSV answer for a tool we know in public_signals (source "osv"), replacing the previous one. */
export async function recordAdvisories(db: Db, toolId: string, result: AdvisoryResult, now = Date.now()) {
  // A cached answer is already stored: write only when OSV was asked afresh.
  const have = await db.query.publicSignals.findFirst({ where: and(eq(t.publicSignals.toolId, toolId), eq(t.publicSignals.source, "osv")) });
  if (have && (have.payload as AdvisoryResult).checked_at === result.checked_at && (have.payload as AdvisoryResult).version === result.version) return;
  await db.delete(t.publicSignals).where(and(eq(t.publicSignals.toolId, toolId), eq(t.publicSignals.source, "osv")));
  await db.insert(t.publicSignals).values({ id: newId(), toolId, source: "osv", payload: result, fetchedAt: now });
}
