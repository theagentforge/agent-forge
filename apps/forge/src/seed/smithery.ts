import { inArray } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import { canonicalToolId } from "../services/tools";
import { upsertSeedTools, type SeedTool } from "./mcp-registry";

// The Smithery part of the tools-tracked census (B3-14, ADR 0108). Smithery's registry API (GET api.smithery.ai/servers,
// documented at smithery.ai/docs) needs an API key on every call, so this seeder does nothing until Dinike creates a
// Smithery account, accepts its terms and sets the key as the SMITHERY_API_KEY secret in Cloudflare. No key, no calls.
//
// Use: the documented listing endpoint only, 100 servers a page, at most PAGES_PER_RUN pages an hour, one full pass a
// week, identified by User-Agent. Each tool links back to its Smithery page.
//
// Duplicates: a server whose homepage is a GitHub repository the Forge already tracks (as a page or an alias, e.g. an
// MCP Registry server) gets a `smithery:<name>` alias and a "smithery" signal on that tool, never a second page. Write
// volume: servers already linked to their Smithery name are skipped on later passes.

export const SMITHERY_API = "https://api.smithery.ai/servers";
export const PAGE_SIZE = 100;
export const PAGES_PER_RUN = 5;
export const PASS_EVERY_MS = 7 * 86_400_000;
const STATE_KEY = "seed:smithery:v1";
const UA = "theagentforge-census/1 (+https://theagentforge.io/stats/rules#tools_tracked)";
const QUALIFIED = /^@?[A-Za-z0-9][\w.-]{0,99}(\/[A-Za-z0-9][\w.-]{0,99})?$/;

export interface SmitheryServer {
  qualifiedName?: string;
  displayName?: string;
  description?: string;
  homepage?: string | null;
  remote?: boolean;
  verified?: boolean;
  isDeployed?: boolean;
  useCount?: number;
  createdAt?: string;
}

interface State {
  page: number;
  passStartedAt: number | null;
  lastPassAt: number | null;
  totalCount: number | null;
}

/** smithery:<qualified name>, lower case. */
export const smitheryId = (qn: string) => canonicalToolId(`smithery:${qn}`);
export const smitheryPage = (qn: string) => `https://smithery.ai/server/${qn.split("/").map(encodeURIComponent).join("/")}`;

/** The GitHub repository a homepage points at, as a Forge id (github.com/owner/repo), or null. */
export function githubRepoId(homepage: string | null | undefined) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(homepage ?? "");
  return m ? canonicalToolId(`https://github.com/${m[1]}/${m[2]}`) : null;
}

export function toSmitherySeed(s: SmitheryServer): SeedTool | null {
  const qn = s.qualifiedName?.trim();
  if (!qn || !QUALIFIED.test(qn)) return null;
  const sid = smitheryId(qn);
  const gh = githubRepoId(s.homepage);
  const canonicalId = gh ?? sid;
  return {
    canonicalId,
    aliases: canonicalId === sid ? [] : [sid],
    sourceUrl: gh ? `https://${gh}` : smitheryPage(qn),
    publisherGithub: gh ? gh.split("/")[1]! : null,
    kind: "mcp_server",
    signal: {
      title: s.displayName?.slice(0, 120) ?? qn,
      description: s.description?.slice(0, 300) ?? null,
      smithery_name: qn,
      registry_url: smitheryPage(qn),
      remote: typeof s.remote === "boolean" ? s.remote : null,
      verified: typeof s.verified === "boolean" ? s.verified : null,
      created_at: s.createdAt ?? null,
      repository: gh ? `https://${gh}` : null,
    },
  };
}

/** Ids (canonical or alias) the Forge already tracks, mapped to the tool's canonical id. */
async function owners(db: Db, ids: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    for (const r of await db.select({ id: t.tools.canonicalId }).from(t.tools).where(inArray(t.tools.canonicalId, chunk))) out.set(r.id, r.id);
    const aliased = await db
      .select({ alias: t.toolAliases.alias, toolId: t.toolAliases.toolId })
      .from(t.toolAliases)
      .where(inArray(t.toolAliases.alias, chunk));
    if (aliased.length) {
      const tools = await db.select({ id: t.tools.id, canonicalId: t.tools.canonicalId }).from(t.tools).where(inArray(t.tools.id, [...new Set(aliased.map((a) => a.toolId))]));
      const byId = new Map(tools.map((x) => [x.id, x.canonicalId]));
      for (const a of aliased) if (!out.has(a.alias) && byId.has(a.toolId)) out.set(a.alias, byId.get(a.toolId)!);
    }
  }
  return out;
}

/** Files one page: skips servers already linked to their Smithery name, merges the rest into tools we already track. */
export async function addSmitheryPage(db: Db, servers: SmitheryServer[], now: number) {
  const seeds = servers.map(toSmitherySeed).filter((x): x is SeedTool => !!x);
  if (!seeds.length) return { added: 0, merged: 0, skipped: 0 };
  const sids = seeds.map((s) => (s.canonicalId.startsWith("smithery:") ? s.canonicalId : s.aliases[0]!));
  const known = await owners(db, sids);
  const todo = seeds.filter((_, i) => !known.has(sids[i]!));
  const ghOwners = await owners(db, todo.map((s) => s.canonicalId).filter((id) => id.startsWith("github.com/")));
  let merged = 0;
  const resolved = todo.map((s) => {
    const owner = ghOwners.get(s.canonicalId);
    if (!owner || owner === s.canonicalId) {
      if (owner) merged++;
      return s;
    }
    merged++;
    return { ...s, canonicalId: owner, aliases: [...new Set([s.canonicalId, ...s.aliases])] };
  });
  const unique = [...new Map(resolved.map((s) => [s.canonicalId, s])).values()];
  if (unique.length) await upsertSeedTools(db, unique, now, "smithery");
  return { added: unique.length - merged, merged, skipped: seeds.length - todo.length };
}

/** One hourly step. Off without the SMITHERY_API_KEY secret. */
export async function seedSmithery(env: Env, now = Date.now(), fetcher: typeof fetch = fetch, perRun = PAGES_PER_RUN) {
  const key = env.SMITHERY_API_KEY;
  if (!key) return { skipped: "no_key" as const };
  const state: State = (await env.KV.get<State>(STATE_KEY, "json")) ?? { page: 1, passStartedAt: null, lastPassAt: null, totalCount: null };
  if (state.passStartedAt === null) {
    if (state.lastPassAt && now - state.lastPassAt < PASS_EVERY_MS) return { skipped: "up_to_date" as const };
    state.passStartedAt = now;
    state.page = 1;
  }
  const db = getDb(env);
  let pages = 0;
  let added = 0;
  let merged = 0;
  let error: number | null = null;
  while (pages < perRun) {
    const u = new URL(SMITHERY_API);
    u.searchParams.set("page", String(state.page));
    u.searchParams.set("pageSize", String(PAGE_SIZE));
    const res = await fetcher(u.toString(), { headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": UA } });
    if (!res.ok) {
      error = res.status; // 401/403: the key is wrong or revoked; 429: too fast. Either way, stop and try next hour.
      break;
    }
    const body = (await res.json()) as { servers?: SmitheryServer[]; pagination?: { totalPages?: number; totalCount?: number } };
    const r = await addSmitheryPage(db, body.servers ?? [], now);
    added += r.added;
    merged += r.merged;
    pages++;
    state.totalCount = body.pagination?.totalCount ?? state.totalCount;
    const last = !body.servers?.length || state.page >= (body.pagination?.totalPages ?? state.page);
    if (last) {
      state.passStartedAt = null;
      state.lastPassAt = now;
      state.page = 1;
      break;
    }
    state.page++;
  }
  if (pages) await env.KV.put(STATE_KEY, JSON.stringify(state));
  return { pages, added, merged, page: state.page, total_count: state.totalCount, ...(error ? { error } : {}) };
}

