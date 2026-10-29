import { and, eq, inArray } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, newId, type Db } from "../services/db";
import { canonicalToolId } from "../services/tools";

// Seeds tool pages from the official MCP Registry (MASTER_PLAN §7.2), labelled "Public signal".
// Each cron run fetches up to MAX_PAGES_PER_RUN pages of 100 (Workers Paid: 15 min CPU per hourly cron run,
// 10,000 subrequests), resuming from the cursor saved in KV. A full backfill of ~20k servers takes a few hours.

export const REGISTRY = "https://registry.modelcontextprotocol.io";
export const PAGE_SIZE = 100;
export const MAX_PAGES_PER_RUN = 60;
const STATE_KEY = "seed:mcp-registry:v1";

export interface RegistryEntry {
  server: {
    name: string;
    title?: string;
    description?: string;
    version?: string;
    repository?: { url?: string; source?: string; subfolder?: string };
    packages?: { registryType?: string; registry_type?: string; identifier?: string; version?: string }[];
    remotes?: { type?: string; url?: string }[];
  };
  _meta?: Record<string, { status?: string; publishedAt?: string; updatedAt?: string; isLatest?: boolean } | undefined>;
}

export interface SeedTool {
  canonicalId: string;
  aliases: string[];
  sourceUrl: string | null;
  publisherGithub: string | null;
  signal: Record<string, unknown>;
  /** The tool kind for a new tool (default mcp_server); an existing tool keeps its own. */
  kind?: string;
}

const OFFICIAL = "io.modelcontextprotocol.registry/official";

/**
 * Maps a registry entry to a tool. The canonical id is the one agents most likely report: the npm package if there is
 * one, else the GitHub repository, else the registry name. Every other form is kept as an alias.
 */
export function toSeedTool(e: RegistryEntry): SeedTool | null {
  const s = e.server;
  if (!s?.name) return null;
  const registryId = canonicalToolId(`mcp-registry:${s.name}`);
  const npm = s.packages?.find((p) => (p.registryType ?? p.registry_type) === "npm" && p.identifier);
  const repoUrl = s.repository?.url && /^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(s.repository.url) ? s.repository.url.replace(/\.git$/, "") : null;
  const githubId = repoUrl
    ? canonicalToolId(`${repoUrl}${s.repository?.subfolder ? `/${s.repository.subfolder.replace(/^\/+|\/+$/g, "")}` : ""}`)
    : null;
  const npmId = npm?.identifier ? canonicalToolId(`npm:${npm.identifier}`) : null;
  // A PyPI package is an alias only (ADR 0108): the canonical choice stays as it was, so no existing page moves, and the
  // PyPI census and the House tester's uvx reports land on this tool instead of a duplicate.
  const pypi = s.packages?.find((p) => (p.registryType ?? p.registry_type) === "pypi" && p.identifier && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p.identifier));
  const pypiId = pypi?.identifier ? canonicalToolId(`pypi:${pypi.identifier}`) : null;
  const canonicalId = npmId ?? githubId ?? registryId;
  const aliases = [...new Set([registryId, githubId, npmId, pypiId].filter((x): x is string => !!x && x !== canonicalId))];
  const meta = e._meta?.[OFFICIAL];
  if (meta?.status === "deleted") return null;
  return {
    canonicalId,
    aliases,
    sourceUrl: repoUrl,
    publisherGithub: repoUrl ? new URL(repoUrl).pathname.split("/")[1]!.toLowerCase() : null,
    signal: {
      registry_name: s.name,
      title: s.title?.slice(0, 120) ?? null,
      description: s.description?.slice(0, 300) ?? null,
      version: s.version ?? null,
      repository: repoUrl,
      packages: (s.packages ?? []).map((p) => ({ type: p.registryType ?? p.registry_type ?? null, id: p.identifier ?? null })).slice(0, 5),
      remote_transports: [...new Set((s.remotes ?? []).map((r) => r.type).filter(Boolean))],
      status: meta?.status ?? null,
      published_at: meta?.publishedAt ?? null,
      updated_at: meta?.updatedAt ?? null,
    },
  };
}

interface SeedState {
  cursor: string | null;
  /** Set once the first full pass finishes; later runs only fetch servers updated since this time. */
  since: string | null;
  passStartedAt: string | null;
}

export async function upsertSeedTools(db: Db, items: SeedTool[], now: number, source = "mcp-registry") {
  if (!items.length) return 0;
  const ids = items.map((i) => i.canonicalId);
  const existing = await db.select().from(t.tools).where(inArray(t.tools.canonicalId, ids));
  const byId = new Map(existing.map((x) => [x.canonicalId, x]));
  const stmts = [];
  const toolIds: string[] = [];
  for (const it of items) {
    const prev = byId.get(it.canonicalId);
    const toolId = prev?.id ?? newId();
    toolIds.push(toolId);
    const refs = [...new Set([...(prev?.registryRefs ?? []), ...it.aliases])];
    stmts.push(
      prev
        ? db.update(t.tools).set({ sourceUrl: prev.sourceUrl ?? it.sourceUrl, registryRefs: refs, publisherGithub: prev.publisherGithub ?? it.publisherGithub }).where(eq(t.tools.id, toolId))
        : db.insert(t.tools).values({ id: toolId, kind: it.kind ?? "mcp_server", canonicalId: it.canonicalId, sourceUrl: it.sourceUrl, registryRefs: refs, publisherGithub: it.publisherGithub, createdAt: now }),
    );
  }
  items.forEach((it, i) => {
    for (const alias of it.aliases) {
      stmts.push(db.insert(t.toolAliases).values({ alias, toolId: toolIds[i]! }).onConflictDoNothing());
    }
  });
  // Each seeder replaces only its own signal, so a tool seeded from two sources (or holding OSV advisories) keeps both.
  // In chunks: D1 binds at most 100 parameters per statement (a page is 100 tools, plus the source).
  for (let i = 0; i < toolIds.length; i += 90)
    stmts.push(db.delete(t.publicSignals).where(and(inArray(t.publicSignals.toolId, toolIds.slice(i, i + 90)), eq(t.publicSignals.source, source))));
  items.forEach((it, i) =>
    stmts.push(db.insert(t.publicSignals).values({ id: newId(), toolId: toolIds[i]!, source, payload: it.signal, fetchedAt: now })),
  );
  await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  return items.length;
}

/** One seeding step. Returns how many tools were written. */
export async function seedFromRegistry(env: Env, now = Date.now(), fetcher: typeof fetch = fetch) {
  const state: SeedState = (await env.KV.get<SeedState>(STATE_KEY, "json")) ?? { cursor: null, since: null, passStartedAt: null };
  const url = new URL("/v0.1/servers", REGISTRY);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("version", "latest");
  if (state.cursor) url.searchParams.set("cursor", state.cursor);
  if (state.since) url.searchParams.set("updated_since", state.since);
  const passStartedAt = state.passStartedAt ?? new Date(now).toISOString();

  const res = await fetcher(url.toString(), { headers: { Accept: "application/json", "User-Agent": "theagentforge-seeder" } });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const body = (await res.json()) as { servers?: RegistryEntry[]; metadata?: { nextCursor?: string | null } };
  const items = (body.servers ?? []).map(toSeedTool).filter((x): x is SeedTool => x !== null);
  // The same canonical id can appear twice in one page (e.g. two registry names for one npm package).
  const unique = [...new Map(items.map((i) => [i.canonicalId, i])).values()];
  const written = await upsertSeedTools(getDb(env), unique, now);

  const next = body.metadata?.nextCursor ?? null;
  const nextState: SeedState = next
    ? { cursor: next, since: state.since, passStartedAt }
    : { cursor: null, since: passStartedAt, passStartedAt: null };
  await env.KV.put(STATE_KEY, JSON.stringify(nextState));
  return { written, done: !next };
}

/** One cron run: keep paging until the registry has nothing new or the per-run page budget is spent. */
export async function seedRun(env: Env, maxPages = MAX_PAGES_PER_RUN, fetcher: typeof fetch = fetch) {
  let written = 0;
  let pages = 0;
  for (; pages < maxPages; pages++) {
    let step;
    try {
      step = await seedFromRegistry(env, Date.now(), fetcher);
    } catch (e) {
      // Transient registry errors: stop and resume from the saved cursor next hour.
      console.error("seed_page_failed", String(e));
      break;
    }
    written += step.written;
    if (step.done) {
      pages++;
      break;
    }
  }
  return { written, pages };
}
