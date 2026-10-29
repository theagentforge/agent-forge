import { inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import { canonicalToolId } from "../services/tools";
import { upsertSeedTools, type SeedTool } from "./mcp-registry";

// The PyPI part of the tools-tracked census (B3-14, ADR 0108): every PyPI project whose name marks it as an MCP package
// ("mcp" as a whole word in the name: mcp-server-fetch and weather-mcp match; fastmcp does not).
//
// Source and its rules: pypi.org/robots.txt disallows /simple/ and /pypi/*/json for crawlers, so the census reads
// neither. It reads only PyPI's published sitemap (robots.txt: "Sitemap: https://pypi.org/sitemap.xml"): an index of
// 256 bucket files listing every /project/<name>/ page. A bucket is fetched again only when its <lastmod> changes.
// A few buckets an hour, identified by User-Agent; nothing is fetched while a pass has nothing to do.
//
// Write volume: only names the Forge doesn't track yet are written (one tool row and one signal each). A name already
// tracked (as its own page, as an alias, or as the PyPI package of an MCP Registry server) is left alone.

export const SITEMAP_INDEX = "https://pypi.org/sitemap.xml";
const BUCKET_URL = /^https:\/\/pypi\.org\/[0-9a-f]{2}\.sitemap\.xml$/;
export const BUCKETS_PER_RUN = 4;
/** How often the sitemap index is re-read for changed buckets. */
export const INDEX_EVERY_MS = 7 * 86_400_000;
const STATE_KEY = "seed:pypi-mcp:v1";
const UA = "theagentforge-census/1 (+https://theagentforge.io/stats/rules#tools_tracked)";

/** "mcp" as a whole word in a PyPI name (PEP 503 separators). */
export const MCP_NAME = /(^|[-_.])mcp($|[-_.])/i;

interface State {
  /** Bucket URL → the <lastmod> we last processed. */
  done: Record<string, string>;
  /** Buckets still to read in this pass, with the <lastmod> they had when queued. */
  queue: [string, string][];
  indexReadAt: number | null;
}

/** The buckets in a sitemap index, with their <lastmod>. Only pypi.org bucket URLs are accepted. */
export function parseSitemapIndex(xml: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]*)<\/lastmod>)?/g)) {
    const loc = m[1]!.trim();
    if (BUCKET_URL.test(loc)) out.push([loc, (m[2] ?? "").trim()]);
  }
  return out;
}

/** The MCP-named projects in one bucket (PEP 503 names, deduplicated). */
export function mcpNamesIn(xml: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>https:\/\/pypi\.org\/project\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/<\/loc>/g)) {
    if (MCP_NAME.test(m[1]!)) out.add(canonicalToolId(`pypi:${m[1]}`));
  }
  return [...out];
}

export function pypiSeedTool(canonicalId: string): SeedTool {
  const name = canonicalId.slice("pypi:".length);
  return {
    canonicalId,
    aliases: [],
    sourceUrl: `https://pypi.org/project/${name}/`,
    publisherGithub: null,
    kind: "mcp_server",
    signal: {
      title: `${name} (PyPI)`,
      description: "A PyPI project with \"mcp\" as a word in its name, listed in PyPI's public sitemap. A name match: it may be an MCP server, client, SDK or adapter. Listed, not reviewed.",
      match: "name",
      package: { type: "pypi", id: name },
      registry_url: `https://pypi.org/project/${name}/`,
    },
  };
}

/** PyPI ids the Forge already tracks: as a tool, an alias, or the PyPI package of an MCP Registry server. */
export async function trackedPypi(db: Db, ids: string[]) {
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    for (const r of await db.select({ id: t.tools.canonicalId }).from(t.tools).where(inArray(t.tools.canonicalId, chunk))) have.add(r.id);
    for (const r of await db.select({ id: t.toolAliases.alias }).from(t.toolAliases).where(inArray(t.toolAliases.alias, chunk))) have.add(r.id);
  }
  return have;
}

/** MCP Registry servers that ship a PyPI package: PyPI id → tool row id (read from their stored registry signal). */
export async function registryPypi(db: Db) {
  const rows = await db.all<{ tool_id: string; id: string | null }>(
    sql`SELECT s.tool_id AS tool_id, json_extract(j.value, '$.id') AS id FROM public_signals s, json_each(s.payload, '$.packages') j WHERE s.source = 'mcp-registry' AND json_extract(j.value, '$.type') = 'pypi'`,
  );
  const out = new Map<string, string>();
  for (const r of rows) if (r.id) out.set(canonicalToolId(`pypi:${r.id}`), r.tool_id);
  return out;
}

/**
 * Files new names: names an MCP Registry server already ships get an alias on that server's tool (no new page); the rest
 * become `pypi:<name>` tools with a "pypi-mcp" public signal.
 */
export async function addPypiNames(db: Db, names: string[], now: number, registry?: Map<string, string>) {
  const have = await trackedPypi(db, names);
  const fresh = names.filter((n) => !have.has(n));
  if (!fresh.length) return { added: 0, aliased: 0 };
  const reg = registry ?? (await registryPypi(db));
  const toAlias = fresh.filter((n) => reg.has(n));
  if (toAlias.length) await db.batch(toAlias.map((n) => db.insert(t.toolAliases).values({ alias: n, toolId: reg.get(n)! }).onConflictDoNothing()) as never);
  const toAdd = fresh.filter((n) => !reg.has(n));
  for (let i = 0; i < toAdd.length; i += 90) await upsertSeedTools(db, toAdd.slice(i, i + 90).map(pypiSeedTool), now, "pypi-mcp");
  return { added: toAdd.length, aliased: toAlias.length };
}

/** One hourly step: re-read the index once a week, then a few changed buckets. */
export async function seedPypiMcp(env: Env, now = Date.now(), fetcher: typeof fetch = fetch, perRun = BUCKETS_PER_RUN) {
  const state: State = (await env.KV.get<State>(STATE_KEY, "json")) ?? { done: {}, queue: [], indexReadAt: null };
  if (!state.queue.length) {
    if (state.indexReadAt && now - state.indexReadAt < INDEX_EVERY_MS) return { skipped: "up_to_date" as const };
    const res = await fetcher(SITEMAP_INDEX, { headers: { "User-Agent": UA, Accept: "application/xml" } });
    if (!res.ok) throw new Error(`pypi sitemap ${res.status}`);
    state.queue = parseSitemapIndex(await res.text()).filter(([u, mod]) => state.done[u] !== mod || !mod);
    state.indexReadAt = now;
  }
  const db = getDb(env);
  let registry: Map<string, string> | undefined;
  let added = 0;
  let aliased = 0;
  let buckets = 0;
  while (state.queue.length && buckets < perRun) {
    const [url, mod] = state.queue[0]!;
    const res = await fetcher(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
    if (!res.ok) break; // try again next hour
    const names = mcpNamesIn(await res.text());
    registry ??= await registryPypi(db);
    const r = await addPypiNames(db, names, now, registry);
    added += r.added;
    aliased += r.aliased;
    state.done[url] = mod;
    state.queue.shift();
    buckets++;
  }
  await env.KV.put(STATE_KEY, JSON.stringify(state));
  return { buckets, added, aliased, left: state.queue.length };
}

/** How many tools came from each census source (for the counting rule and the ADR's numbers). */
export async function censusBySource(db: Db) {
  const rows = await db
    .select({ source: t.publicSignals.source, n: sql<number>`count(DISTINCT ${t.publicSignals.toolId})` })
    .from(t.publicSignals)
    .where(inArray(t.publicSignals.source, ["mcp-registry", "pypi-mcp", "smithery"]))
    .groupBy(t.publicSignals.source);
  return Object.fromEntries(rows.map((r) => [r.source, Number(r.n)]));
}

