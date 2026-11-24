import { MONITOR_POLICY, MONITOR_USER_AGENT, sha256Hex } from "@forge/shared/drift-monitor";
import type { Fetcher } from "./mcp-client";
import { getMeta, setMeta } from "./store";

// ADR 0151 §5: which remote endpoints exist, read from the official MCP Registry's public REST API the way its
// aggregator guide describes (GET /v0.1/servers, cursor pages of 100, updated_since after the first full pass, the
// latest version of each server only, `status` kept up to date). At most one sync an hour, a few pages each.

export const REGISTRY = "https://registry.modelcontextprotocol.io";
const OFFICIAL = "io.modelcontextprotocol.registry/official";

interface RemoteHeader {
  name?: string;
  isRequired?: boolean;
  default?: string;
  value?: string;
}
interface Remote {
  type?: string;
  url?: string;
  headers?: RemoteHeader[];
  variables?: Record<string, { isRequired?: boolean; default?: string }>;
}
export interface RegistryEntry {
  server: { name?: string; version?: string; remotes?: Remote[] };
  _meta?: Record<string, { status?: string; isLatest?: boolean } | undefined>;
}

export const endpointId = async (name: string, url: string) => (await sha256Hex(`${name}\n${url}`)).slice(0, 32);

/**
 * Why an endpoint can't be polled without configuration, or null. A URL template ({tenant}) or a required header
 * without a default (an API key, typically) means the owner expects the client to supply something: never contacted.
 */
export function needsConfig(r: Remote): string | null {
  const url = r.url ?? "";
  if (!/^https:\/\//i.test(url)) return "url:not_https";
  const vars = [...url.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  if (vars.length) return `variable:${vars.join(",").slice(0, 120)}`;
  const req = (r.headers ?? []).filter((h) => h.isRequired && !h.default && !h.value).map((h) => h.name ?? "?");
  if (req.length) return `header:${req.join(",").slice(0, 120)}`;
  return null;
}

export const UNLIST_SQL = `UPDATE drift_servers SET listed = 0, registry_status = ?2 WHERE registry_name = ?1 AND +listed = 1 AND remote_url NOT IN (SELECT value FROM json_each(?3))`;

/** One page of the Registry into drift_servers. Endpoints a server's latest version no longer lists are kept, unlisted. */
export async function upsertEntries(db: D1Database, entries: RegistryEntry[], now: number) {
  const stmts: D1PreparedStatement[] = [];
  let endpoints = 0;
  for (const e of entries) {
    const name = e.server?.name;
    if (!name) continue;
    const meta = e._meta?.[OFFICIAL];
    if (meta?.isLatest === false) continue;
    const status = meta?.status ?? null;
    const urls: string[] = [];
    if (status !== "deleted") {
      for (const r of e.server.remotes ?? []) {
        if (!r.url || urls.includes(r.url) || r.url.length > 2048) continue;
        urls.push(r.url);
        endpoints++;
        let host = "";
        try {
          host = new URL(r.url).host.toLowerCase();
        } catch {
          host = "";
        }
        const nc = host ? needsConfig(r) : "url:invalid";
        stmts.push(
          db
            .prepare(
              `INSERT INTO drift_servers (id, registry_name, remote_url, host, transport, registry_version, registry_status, listed, needs_config, first_listed_at, last_listed_at, next_poll_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?9, ?9)
               ON CONFLICT(registry_name, remote_url) DO UPDATE SET host = excluded.host, transport = excluded.transport,
                 registry_version = excluded.registry_version, registry_status = excluded.registry_status, listed = 1,
                 next_poll_at = CASE WHEN drift_servers.needs_config IS NOT NULL AND excluded.needs_config IS NULL THEN excluded.next_poll_at ELSE drift_servers.next_poll_at END,
                 needs_config = excluded.needs_config, last_listed_at = excluded.last_listed_at`,
            )
            .bind(await endpointId(name, r.url), name, r.url, host, (r.type ?? "unknown").slice(0, 40), e.server.version?.slice(0, 64) ?? null, status, nc, now),
        );
      }
    }
    // Remotes of this name that its latest version no longer lists (or every remote, for a deleted server). `+listed`
    // keeps SQLite on the (registry_name, remote_url) index: with plain `listed = 1` it chose the (listed, next_poll_at)
    // index, read every row of the table for each server, and D1 refused the hourly sync as overloaded (amendment 2).
    stmts.push(
      db
        .prepare(UNLIST_SQL)
        .bind(name, status, JSON.stringify(urls)),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return endpoints;
}

/** One sync: a few pages, resuming from the saved cursor; after a full pass, only servers updated since it began. */
export async function syncRegistry(db: D1Database, now: number, fetcher: Fetcher, maxPages: number = MONITOR_POLICY.registryPagesPerSync) {
  let pages = 0;
  let endpoints = 0;
  let done = false;
  let cursor = await getMeta(db, "registry_cursor");
  const since = await getMeta(db, "registry_since");
  const passStartedAt = (await getMeta(db, "registry_pass_started_at")) ?? new Date(now).toISOString();
  for (; pages < maxPages; pages++) {
    const url = new URL("/v0.1/servers", REGISTRY);
    url.searchParams.set("limit", "100");
    url.searchParams.set("version", "latest");
    if (cursor) url.searchParams.set("cursor", cursor);
    if (since) url.searchParams.set("updated_since", since);
    const res = await fetcher(url.toString(), { headers: { Accept: "application/json", "User-Agent": MONITOR_USER_AGENT }, signal: AbortSignal.timeout(MONITOR_POLICY.requestTimeoutMs) });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const body = (await res.json()) as { servers?: RegistryEntry[]; metadata?: { nextCursor?: string | null } };
    endpoints += await upsertEntries(db, body.servers ?? [], now);
    const next = body.metadata?.nextCursor ?? null;
    if (next) {
      cursor = next;
      await setMeta(db, "registry_cursor", next, now);
      await setMeta(db, "registry_pass_started_at", passStartedAt, now);
      continue;
    }
    // A full pass (or an updated_since pass) is done: the next sync asks only for what changed since this one began.
    await db.batch([
      db.prepare("DELETE FROM drift_meta WHERE key IN ('registry_cursor', 'registry_pass_started_at')"),
      db.prepare("INSERT INTO drift_meta (key, value, updated_at) VALUES ('registry_since', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(passStartedAt, now),
      db.prepare("INSERT INTO drift_meta (key, value, updated_at) VALUES ('registry_pass_done_at', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(new Date(now).toISOString(), now),
      // The first full pass (no updated_since) is dated once and never moved; /drift/coverage shows it.
      ...(since ? [] : [db.prepare("INSERT OR IGNORE INTO drift_meta (key, value, updated_at) VALUES ('registry_first_pass_done_at', ?1, ?2)").bind(new Date(now).toISOString(), now)]),
    ]);
    done = true;
    pages++;
    break;
  }
  // registry_synced_at: the last sync that finished without an error (a failed one leaves it, and records why).
  await db.batch([
    db.prepare("INSERT INTO drift_meta (key, value, updated_at) VALUES ('registry_synced_at', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(new Date(now).toISOString(), now),
    db.prepare("DELETE FROM drift_meta WHERE key = 'registry_sync_error'"),
  ]);
  return { pages, endpoints, done };
}
