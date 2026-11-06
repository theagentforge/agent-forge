import { type SQL, sql } from "drizzle-orm";
import { FAILURE_CLASSES, failureClass, TAXONOMY_VERSION } from "./census";
import { getDb } from "./db";
import { findTool } from "./forge";
import { FAMILIES } from "./house-results";
import { LICENCE_ID, LICENCE_PATH } from "./provenance";
import { ORIGINS } from "./tool-history";
import { canonicalToolId } from "./tools";

// ADR 0141 (moat audit 5 Nov, item 11, Boardy's Q3 "the record as a dependency"): one MCP server's dated record, as a
// versioned, no-auth contract (`forge.server-history/v1`) for GET /api/v1/history/{server} and the forge_server_history
// tool on /mcp/requests. Three sections, read from the tables of migrations 0038 and 0040:
//   - install_outcomes: what the House tester got when it installed each version, by date (house_results for the
//     nightly top-500 and the weekly sweep; tool_history_queue for the backfill), every row labelled with its family
//     and origin; counts are per family, never added across families;
//   - definitions: the tool-definition set per version (tool_description_history) as a sha256 and counts, with the
//     publish date (where known) kept apart from when we observed it;
//   - changes: consecutive definition sets compared (tool_definition_drift): change class, major-version flags and
//     the scanner rule ids the new text matched (ids only; a match is a pattern for a person to read, not a finding).
// Hashes, counts, dates and ids only: the tool text stays buyer-only (ADR 0134 §7). Structured data (AGENTS.md rule 7).
// Every query is keyed by an index (house_results_server from 0051, the queue's and drift's primary keys, history's
// tool_id key), and every list is paged.

export const HISTORY_CONTRACT = "forge.server-history/v1";
/** Additive changes raise the minor number; anything that removes or renames a field is a new contract (v2). */
export const HISTORY_CONTRACT_VERSION = "1.0.0";
export const HISTORY_ROUTE = "/api/v1/history";
export const HISTORY_DOCS_PATH = "/history-api";
export const HISTORY_SECTIONS = ["install_outcomes", "definitions", "changes"] as const;
export type HistorySection = (typeof HISTORY_SECTIONS)[number];
export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 200;
export const HISTORY_MAX_OFFSET = 50_000;
/** Edge and browser cache: the data changes at most a few times a day (House runs, backfill runs, the hourly drift job). */
export const HISTORY_CACHE_SECONDS = 900;
/** House ids searched for one server (its own id, canonical id, aliases and backfill-set entries). */
const MAX_IDS = 25;

/** An MCP server on npm or PyPI, without a version (the House and census ids). */
const SERVER_ID = /^(npm:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*|pypi:[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?)$/;
const HAS_VERSION = /^(npm:(@[^/@]+\/)?[^@]+@.+|pypi:[^=@]+(==|@).+)$/i;

export const FAMILY_NOTES = {
  [FAMILIES.top500]: "The House tester's nightly run of the 500 most-downloaded no-setup npm MCP servers in the official MCP Registry; one row per server per UTC night.",
  [FAMILIES.sweep]: "The House tester's weekly sweep of every no-setup npm and PyPI server, a seventh a day; one row per server per UTC day it was tested.",
  backfill: "The tool-history backfill (ADR 0134): each stable version published since 2025-09-01, installed once in the same sandbox; date is the UTC day we ran it, published_at the registry's publish date.",
} as const;
export const ORIGIN_NOTES = {
  post: "Filed by the House run itself.",
  kv_copy: "Copied unchanged from the run's stored copy (nights before 5 Nov 2026).",
  [ORIGINS.nightly]: "Seen by the House tester's nightly or sweep run; first_seen is the first time we saw it, not a publish date.",
  [ORIGINS.carried]: "Carried over from the definition sets stored before 5 Nov 2026; first_seen is when we stored it.",
  [ORIGINS.backfill]: "Installed by the backfill; first_seen and published_at are the registry's publish date, observed_at is when we ran it.",
} as const;

export type HistoryQuery = { section: HistorySection | "all"; offset: number; limit: number };
export type HistoryInputError = { error: "invalid_server" | "invalid_query"; field: string; detail: string };

/** The server id as the House and census write it, or why it isn't one. Pure. */
export function parseServer(raw: string): { ok: true; id: string; given: string } | { ok: false; error: HistoryInputError } {
  const given = raw.trim();
  if (!given || given.length > 230) return { ok: false, error: { error: "invalid_server", field: "server", detail: "expected npm:<name>, npm:@<scope>/<name> or pypi:<name>" } };
  if (HAS_VERSION.test(given)) return { ok: false, error: { error: "invalid_server", field: "server", detail: "the server id without a version: the record covers every version" } };
  const id = canonicalToolId(given);
  if (!SERVER_ID.test(id)) return { ok: false, error: { error: "invalid_server", field: "server", detail: "expected npm:<name>, npm:@<scope>/<name> or pypi:<name>" } };
  return { ok: true, id, given };
}

/** Section, offset and limit from query values (strings or numbers). Pure. */
export function parseQuery(q: { section?: unknown; offset?: unknown; limit?: unknown }): { ok: true; query: HistoryQuery } | { ok: false; error: HistoryInputError } {
  const bad = (field: string, detail: string) => ({ ok: false as const, error: { error: "invalid_query" as const, field, detail } });
  const section = q.section === undefined || q.section === "" ? "all" : String(q.section);
  if (section !== "all" && !(HISTORY_SECTIONS as readonly string[]).includes(section)) return bad("section", `one of all, ${HISTORY_SECTIONS.join(", ")}`);
  const int = (v: unknown, dflt: number) => (v === undefined || v === "" ? dflt : /^\d{1,6}$/.test(String(v)) ? Number(v) : NaN);
  const offset = int(q.offset, 0);
  const limit = int(q.limit, HISTORY_DEFAULT_LIMIT);
  if (!Number.isInteger(offset) || offset > HISTORY_MAX_OFFSET) return bad("offset", `an integer from 0 to ${HISTORY_MAX_OFFSET}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) return bad("limit", `an integer from 1 to ${HISTORY_MAX_LIMIT}`);
  if (offset > 0 && section === "all") return bad("offset", "an offset needs one section (section=install_outcomes, definitions or changes)");
  return { ok: true, query: { section: section as HistoryQuery["section"], offset, limit } };
}

/** The canonical URL of one page (also the edge-cache key): only the contract's own parameters, in a fixed order. */
export function historyUrl(origin: string, server: string, q: Partial<HistoryQuery> = {}) {
  const u = new URL(`${origin}${HISTORY_ROUTE}/${encodeURIComponent(server)}`);
  if (q.section && q.section !== "all") u.searchParams.set("section", q.section);
  if (q.offset) u.searchParams.set("offset", String(q.offset));
  if (q.limit && q.limit !== HISTORY_DEFAULT_LIMIT) u.searchParams.set("limit", String(q.limit));
  return u.toString();
}

/** The tool page path (the same as web/components toolHref; kept here so this service imports no page code). */
const toolHref = (canonicalId: string) => `/t/${encodeURIComponent(canonicalId)}`;
const iso = (ms: unknown) => (ms === null || ms === undefined || ms === "" ? null : new Date(Number(ms)).toISOString());
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const inList = (ids: string[]): SQL => sql.join(
  ids.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * Every House id this server's rows may be filed under: the canonical id, and any backfill-set entry of its tool page
 * that is a spelling of the same id. Only spellings of the asked id (review, 6 Nov): a tool page's other aliases name
 * other packages (an MCP Registry entry with an npm and a PyPI package is one page), whose install outcomes are not
 * this server's. A function of the canonical id alone, never of how it was typed, so the edge-cache key (the canonical
 * URL) and the `next` links always describe the same rows. No alias lookup: tool_aliases has no tool_id index.
 */
async function serverIds(env: Env, id: string) {
  const db = getDb(env);
  const tool = (await findTool(db, id)) ?? null;
  const ids = new Set([id]);
  if (tool) {
    const backfill = (await db.all(sql`SELECT server FROM tool_history_servers WHERE tool_id = ${tool.id} LIMIT ${MAX_IDS}`)) as { server: string }[];
    for (const r of backfill) if (canonicalToolId(r.server) === id) ids.add(r.server);
  }
  return { tool, ids: [...ids].slice(0, MAX_IDS) };
}

const page = (total: number, q: HistoryQuery, section: HistorySection, origin: string, server: string, items: unknown[]) => ({
  total,
  offset: q.section === section ? q.offset : 0,
  limit: q.limit,
  next: (q.section === section ? q.offset : 0) + items.length < total ? historyUrl(origin, server, { section, offset: (q.section === section ? q.offset : 0) + items.length, limit: q.limit }) : null,
  items,
});

async function installOutcomes(env: Env, ids: string[], q: HistoryQuery, origin: string, server: string) {
  const db = getDb(env);
  const IN = inList(ids);
  const house = (await db.all(
    sql`SELECT family, outcome, count(*) AS n, min(night) AS first, max(night) AS last, max(probed_at) AS at FROM house_results WHERE server IN (${IN}) GROUP BY family, outcome`,
  )) as { family: string; outcome: string; n: number; first: string; last: string; at: number }[];
  const queue = (await db.all(
    sql`SELECT status, coalesce(reason, '') AS reason, count(*) AS n, min(strftime('%Y-%m-%d', coalesce(observed_at, offered_at) / 1000, 'unixepoch')) AS first,
          max(strftime('%Y-%m-%d', coalesce(observed_at, offered_at) / 1000, 'unixepoch')) AS last, max(observed_at) AS at
        FROM tool_history_queue WHERE server IN (${IN}) GROUP BY status, reason`,
  )) as { status: string; reason: string; n: number; first: string | null; last: string | null; at: number | null }[];
  const blankClasses = () => Object.fromEntries(Object.keys(FAILURE_CLASSES).map((c) => [c, 0])) as Record<string, number>;
  const families: Record<string, unknown> = {};
  for (const fam of [FAMILIES.top500, FAMILIES.sweep]) {
    const rows = house.filter((r) => r.family === fam);
    const byClass = blankClasses();
    let installed = 0;
    for (const r of rows) {
      const c = failureClass(r.outcome);
      if (c) byClass[c] = (byClass[c] ?? 0) + Number(r.n);
      else installed += Number(r.n);
    }
    const tested = rows.reduce((a, r) => a + Number(r.n), 0);
    families[fam] = tested
      ? { status: "measured", tested, installed, failed: tested - installed, failed_by_class: byClass, first_date: rows.map((r) => r.first).sort()[0]!, last_date: rows.map((r) => r.last).sort().at(-1)! }
      : { status: "not_yet_measured", tested: 0 };
  }
  {
    const done = queue.filter((r) => r.status === "done" || r.status === "failed");
    const byClass = blankClasses();
    for (const r of queue.filter((x) => x.status === "failed")) byClass[r.reason || "other"] = (byClass[r.reason || "other"] ?? 0) + Number(r.n);
    const tested = done.reduce((a, r) => a + Number(r.n), 0);
    const installed = queue.filter((r) => r.status === "done").reduce((a, r) => a + Number(r.n), 0);
    const pending = queue.filter((r) => r.status === "pending").reduce((a, r) => a + Number(r.n), 0);
    const excluded = Object.fromEntries(queue.filter((r) => r.status === "excluded").map((r) => [r.reason, Number(r.n)]));
    const dates = done.flatMap((r) => [r.first, r.last]).filter((d): d is string => !!d).sort();
    families.backfill = tested
      ? { status: "measured", tested, installed, failed: tested - installed, failed_by_class: byClass, first_date: dates[0] ?? null, last_date: dates.at(-1) ?? null, pending, excluded_by_reason: excluded }
      : { status: pending || Object.keys(excluded).length ? "queued" : "not_yet_measured", tested: 0, pending, excluded_by_reason: excluded };
  }
  const houseTotal = house.reduce((a, r) => a + Number(r.n), 0);
  const queueTotal = queue.filter((r) => r.status === "done" || r.status === "failed").reduce((a, r) => a + Number(r.n), 0);
  const total = houseTotal + queueTotal;
  const offset = q.section === "install_outcomes" ? q.offset : 0;
  const rows = total
    ? ((await db.all(
        sql`SELECT * FROM (
              SELECT night AS date, family, origin, version, outcome, '' AS reason, tools AS tools_count, probed_at AS observed_at, NULL AS published_at, server FROM house_results WHERE server IN (${IN})
              UNION ALL
              SELECT strftime('%Y-%m-%d', coalesce(observed_at, offered_at) / 1000, 'unixepoch') AS date, 'backfill' AS family, 'backfill' AS origin, version, outcome, coalesce(reason, '') AS reason,
                     tools_count, coalesce(observed_at, offered_at) AS observed_at, published_at, server
              FROM tool_history_queue WHERE server IN (${IN}) AND status IN ('done', 'failed')
            ) ORDER BY date DESC, family, observed_at DESC, version DESC, server LIMIT ${q.limit} OFFSET ${offset}`,
      )) as Record<string, unknown>[])
    : [];
  const items = rows.map((r) => {
    const outcome = (r.outcome as string | null) ?? null;
    const cls = r.family === "backfill" ? (r.reason ? String(r.reason) : null) : outcome === null ? "test_error" : failureClass(outcome);
    return {
      date: r.date as string,
      family: r.family as string,
      origin: r.origin as string,
      version: (r.version as string | null) ?? null,
      outcome,
      installed: cls === null,
      failure_class: cls,
      tools_count: num(r.tools_count),
      observed_at: iso(r.observed_at),
      published_at: iso(r.published_at),
    };
  });
  const at = Math.max(0, ...house.map((r) => Number(r.at ?? 0)), ...queue.map((r) => Number(r.at ?? 0)));
  return { section: { status: total ? "measured" : "not_yet_measured", taxonomy: TAXONOMY_VERSION, families, ...page(total, q, "install_outcomes", origin, server, items) }, at };
}

async function definitions(env: Env, toolId: string | null, q: HistoryQuery, origin: string, server: string) {
  if (!toolId) return { section: { status: "not_yet_measured", by_origin: {}, versions: 0, ...page(0, q, "definitions", origin, server, []) }, at: 0 };
  const db = getDb(env);
  const sum = (await db.all(
    sql`SELECT origin, count(*) AS n, count(DISTINCT version) AS versions, max(last_seen) AS seen, max(coalesce(observed_at, 0)) AS observed FROM tool_description_history WHERE tool_id = ${toolId} GROUP BY origin`,
  )) as { origin: string; n: number; versions: number; seen: number; observed: number }[];
  const total = sum.reduce((a, r) => a + Number(r.n), 0);
  const versions = Number(((await db.all(sql`SELECT count(DISTINCT version) AS n FROM tool_description_history WHERE tool_id = ${toolId}`)) as { n: number }[])[0]?.n ?? 0);
  const offset = q.section === "definitions" ? q.offset : 0;
  // Never tool_list or findings: those hold the tool text (buyer-only, ADR 0134 §7).
  const rows = total
    ? ((await db.all(
        sql`SELECT version, server, origin, description_sha256, tools_count, descriptions_count, rules_version, first_seen, observed_at, last_seen, published_at FROM (
              SELECT h.version, h.server, h.origin, h.description_sha256, h.tools_count, h.descriptions_count, h.rules_version, h.first_seen, h.observed_at, h.last_seen, h.id,
                CASE WHEN h.origin = 'backfill' THEN h.first_seen ELSE (SELECT q.published_at FROM tool_history_queue q WHERE q.server = h.server AND q.version = h.version) END AS published_at
              FROM tool_description_history h WHERE h.tool_id = ${toolId}
            ) ORDER BY coalesce(published_at, first_seen) DESC, version DESC, origin, id LIMIT ${q.limit} OFFSET ${offset}`,
      )) as Record<string, unknown>[])
    : [];
  const items = rows.map((r) => ({
    version: r.version as string,
    // The House id the set was read from: a tool page can hold more than one package (see notes.scope).
    server: r.server as string,
    origin: r.origin as string,
    description_sha256: r.description_sha256 as string,
    tools_count: Number(r.tools_count),
    descriptions_count: Number(r.descriptions_count),
    rules_version: r.rules_version as string,
    first_seen: iso(r.first_seen),
    published_at: iso(r.published_at),
    observed_at: iso(r.observed_at ?? r.first_seen),
    last_seen: iso(r.last_seen),
  }));
  const by_origin = Object.fromEntries(sum.map((r) => [r.origin, { sets: Number(r.n), versions: Number(r.versions) }]));
  const at = Math.max(0, ...sum.map((r) => Math.max(Number(r.seen ?? 0), Number(r.observed ?? 0))));
  return { section: { status: total ? "measured" : "not_yet_measured", by_origin, versions, ...page(total, q, "definitions", origin, server, items) }, at };
}

async function changes(env: Env, toolId: string | null, hasDefinitions: boolean, q: HistoryQuery, origin: string, server: string) {
  const empty = (status: string) => ({ section: { status, pairs: 0, changed: 0, changed_without_major_bump: 0, with_new_rule_ids: 0, computed_at: null, ...page(0, q, "changes", origin, server, []) }, at: 0 });
  if (!toolId || !hasDefinitions) return empty("not_yet_measured");
  const db = getDb(env);
  const state = ((await db.all(sql`SELECT computed_at FROM tool_drift_state WHERE tool_id = ${toolId}`)) as { computed_at: number }[])[0];
  if (!state) return empty("not_yet_computed");
  const s = ((await db.all(
    sql`SELECT count(*) AS pairs, sum(change_class != 'none') AS changed, sum(change_class != 'none' AND NOT major_bump) AS no_major, sum(json_array_length(new_text_rules) > 0) AS rules, max(computed_at) AS at FROM tool_definition_drift WHERE tool_id = ${toolId}`,
  )) as Record<string, number | null>[])[0]!;
  const total = Number(s.pairs ?? 0);
  const offset = q.section === "changes" ? q.offset : 0;
  const rows = total
    ? ((await db.all(
        sql`SELECT seq, from_version, to_version, from_sha256, to_sha256, from_published_at, to_published_at, change_class, tools_added, tools_removed, descriptions_changed, schemas_changed,
              major_bump, zero_major, same_version, untested_between, new_text_rules, computed_at
            FROM tool_definition_drift WHERE tool_id = ${toolId} ORDER BY seq DESC LIMIT ${q.limit} OFFSET ${offset}`,
      )) as Record<string, unknown>[])
    : [];
  const items = rows.map((r) => {
    let rules: unknown = [];
    try {
      rules = JSON.parse(String(r.new_text_rules ?? "[]"));
    } catch {
      rules = [];
    }
    return {
      seq: Number(r.seq),
      from_version: r.from_version as string,
      to_version: r.to_version as string,
      from_sha256: r.from_sha256 as string,
      to_sha256: r.to_sha256 as string,
      from_published_at: iso(r.from_published_at),
      to_published_at: iso(r.to_published_at),
      change_classes: r.change_class === "none" ? [] : String(r.change_class).split(";"),
      tools_added: Number(r.tools_added),
      tools_removed: Number(r.tools_removed),
      descriptions_changed: Number(r.descriptions_changed),
      schemas_changed: Number(r.schemas_changed),
      major_bump: !!Number(r.major_bump),
      zero_major: !!Number(r.zero_major),
      same_version: !!Number(r.same_version),
      untested_between: Number(r.untested_between),
      // Scanner rule ids only (never matched text); a match is a pattern for a person to read, not a finding.
      new_rule_ids: Array.isArray(rules) ? rules.filter((x): x is string => typeof x === "string") : [],
    };
  });
  const at = Math.max(Number(s.at ?? 0), Number(state.computed_at ?? 0));
  return {
    section: { status: "measured", pairs: total, changed: Number(s.changed ?? 0), changed_without_major_bump: Number(s.no_major ?? 0), with_new_rule_ids: Number(s.rules ?? 0), computed_at: iso(state.computed_at), ...page(total, q, "changes", origin, server, items) },
    at,
  };
}

/** One server's record under the v1 contract. Depends on the canonical id only (`given` is not read; see serverIds). */
export async function serverHistory(env: Env, server: { id: string; given?: string }, q: HistoryQuery) {
  const origin = env.PUBLIC_ORIGIN;
  const { tool, ids } = await serverIds(env, server.id);
  const want = (s: HistorySection) => q.section === "all" || q.section === s;
  const io = await installOutcomes(env, ids, q, origin, server.id);
  const defs = await definitions(env, tool?.id ?? null, q, origin, server.id);
  const ch = await changes(env, tool?.id ?? null, defs.section.total > 0, q, origin, server.id);
  const at = Math.max(io.at, defs.at, ch.at);
  const measured = io.section.total > 0 || defs.section.total > 0;
  return {
    contract: HISTORY_CONTRACT,
    contract_version: HISTORY_CONTRACT_VERSION,
    data_kind: "server_history",
    server: server.id,
    status: measured ? "measured" : "not_yet_measured",
    data_as_of: at ? new Date(at).toISOString() : null,
    tool_url: tool ? `${origin}${toolHref(tool.canonicalId)}` : null,
    request: { section: q.section, offset: q.offset, limit: q.limit, url: historyUrl(origin, server.id, q) },
    ...(want("install_outcomes") ? { install_outcomes: io.section } : {}),
    ...(want("definitions") ? { definitions: defs.section } : {}),
    ...(want("changes") ? { changes: ch.section } : {}),
    notes: {
      families: FAMILY_NOTES,
      origins: ORIGIN_NOTES,
      counts_never_added_across_families: true,
      tool_text: "not_in_public_tier",
      scope: "install_outcomes: this server id only. definitions and changes: the tool page's definition sets, which can include another npm or PyPI package listed with it in the MCP Registry (each definitions row names its server)",
      rule_ids: "scanner rule ids the new text of added or changed tools matched and the old text did not; a match is a pattern to read, not a finding",
      docs: `${origin}${HISTORY_DOCS_PATH}`,
      openapi: `${origin}/openapi.json`,
    },
    licence: { id: LICENCE_ID, url: `${origin}${LICENCE_PATH}` },
  };
}

export type ServerHistory = Awaited<ReturnType<typeof serverHistory>>;
