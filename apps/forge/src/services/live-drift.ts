import { CANARY_ID } from "@forge/shared/drift-canary";
import { CHANGE_CLASSES, comparePins, MONITOR_POLICY, optedOut, PIN_MATCHES, toolSet, type Pin, type PinMatch } from "@forge/shared/drift-monitor";
import { plainToolName, sha256Of, textLike, urlProblem } from "@forge/shared";
import { z } from "zod";
import { RECEIPT_SCHEMA, receiptToken } from "./receipts";

// ADR 0151: what the site publishes from the live drift monitor (apps/drift-monitor writes the tables).
// - Always public: the policy page (/drift/monitor), the opt-out list and coverage counts (/drift/coverage): how many
//   remote servers the Registry lists and how many we attempted, reached, found needing auth, errored or skipped.
// - Behind LIVE_DRIFT_PUBLIC (unset = off; Dinike's call, as new public figures): change totals and samples, the
//   whitespace-only share, and the gateway API (/api/drift/*, forge_watch `servers`). Off: 404 except a founder preview.
// Every agent-facing answer is structured data with the observation time and a signed receipt.

export const LIVE_DRIFT_CONTRACT = "forge.live-drift/v1";
/** A pinned digest as the API gives it: "sha256:<64 hex>" (the prefix is optional on input). */
export const DIGEST = /^(sha256:)?[0-9a-fA-F]{64}$/;
/** Pins: tool name to a digest (of the call's `match` kind), or to {digest, match} naming its own kind. */
export const pinsSchema = z
  .record(z.string().min(1).max(200), z.union([z.string().regex(DIGEST), z.object({ digest: z.string().regex(DIGEST), match: z.enum(PIN_MATCHES) })]))
  .refine((p) => Object.keys(p).length <= 500, "at most 500 pinned tools");
export const liveDriftReleased = (env: { LIVE_DRIFT_PUBLIC?: string }) => (env.LIVE_DRIFT_PUBLIC ?? "").trim().toLowerCase() === "on";
/**
 * Third-party tool text (snapshot bodies, the before/after text of change events) is a second, separate switch:
 * LIVE_DRIFT_TEXT_PUBLIC (unset = off). With it off, the released API serves digests and change classes only; a
 * signed-in founder still sees the text. CC0 covers the Registry's metadata, not a server's own tool text (ADR 0151).
 */
export const liveDriftTextReleased = (env: { LIVE_DRIFT_TEXT_PUBLIC?: string }) => (env.LIVE_DRIFT_TEXT_PUBLIC ?? "").trim().toLowerCase() === "on";
/** What one answer may include. */
export interface DriftView {
  text: boolean;
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

async function meta(db: D1Database) {
  const rows = (await db.prepare("SELECT key, value FROM drift_meta WHERE key IN ('series_started_at', 'registry_synced_at', 'registry_first_pass_done_at', 'poll_first_pass_done_at')").all<{ key: string; value: string }>()).results;
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return {
    series_started_at: m.get("series_started_at") ?? null,
    registry_synced_at: m.get("registry_synced_at") ?? null,
    registry_first_pass_done_at: m.get("registry_first_pass_done_at") ?? null,
    poll_first_pass_done_at: m.get("poll_first_pass_done_at") ?? null,
  };
}

/**
 * What the drift record covers. Endpoints that need sign-in, keys, headers or URL variables, and HTTP+SSE-only ones, are
 * not observed, so the record covers publicly reachable remote servers only. The drift canary (our own fixture) is in no
 * count.
 */
export const COVERAGE_SCOPE = {
  observed: "remote MCP servers in the official MCP Registry that answer tools/list over Streamable HTTP without sign-in",
  not_observed: ["servers needing sign-in (401 or 403)", "servers needing an API key, a header or URL variables", "servers on the HTTP+SSE transport only", "opted-out servers"],
  excluded_from_every_count: ["the drift canary (our own fixture at /drift/canary/mcp)"],
} as const;

export interface Coverage {
  data_kind: "forge_live_drift_coverage";
  contract: typeof LIVE_DRIFT_CONTRACT;
  /** The first successful poll. Nothing in this series is older; null until the monitor has run. */
  series_started_at: string | null;
  registry_synced_at: string | null;
  /** The Registry's first full read (every page once); null while in progress. */
  registry_first_pass_done_at: string | null;
  /** The first full polling pass: every endpoint we may contact tried at least once, after the Registry's first full read; null while in progress. */
  poll_first_pass_done_at: string | null;
  /** What the record covers and leaves out (ADR 0151 amendment 2). */
  scope: typeof COVERAGE_SCOPE;
  last_poll_at: string | null;
  counts: {
    /** Distinct Registry server names whose latest version lists at least one remote endpoint. */
    servers_listed: number;
    endpoints_listed: number;
    /** Endpoints we sent at least one request to. */
    endpoints_attempted: number;
    /** Endpoints that answered tools/list at least once. */
    endpoints_reached: number;
    /** By the endpoint's latest status. */
    auth_required: number;
    errored: number;
    rate_limited: number;
    opted_out: number;
    needs_config_declared: number;
    sse_not_polled: number;
    not_yet_attempted: number;
  };
  errors_by_class: Record<string, number>;
  /** Only when change figures are released (or in a founder's preview); null otherwise. */
  changes: ChangeTotals | null;
}

export interface ChangeTotals {
  events: number;
  by_class: Record<string, number>;
  whitespace_only: number;
  /** Share of all change events that are whitespace-only (0 to 1, 4 decimals); null with no events. */
  whitespace_only_share: number | null;
  /** Events under the same Registry version and the same version the server reported, both sides. */
  same_version: number;
  same_version_excluding_whitespace: number;
  endpoints_with_changes_excluding_whitespace: number;
  first_event_at: string | null;
  last_event_at: string | null;
}

export async function changeTotals(db: D1Database): Promise<ChangeTotals> {
  const [byClass, x] = await Promise.all([
    db.prepare("SELECT change_class AS k, count(*) AS n FROM drift_events WHERE server_id != ?1 GROUP BY change_class").bind(CANARY_ID).all<{ k: string; n: number }>(),
    db
      .prepare(
        `SELECT count(*) AS events, coalesce(sum(same_version), 0) AS same_version, coalesce(sum(CASE WHEN same_version = 1 AND change_class != 'whitespace_only' THEN 1 ELSE 0 END), 0) AS same_version_nws,
           count(DISTINCT CASE WHEN change_class != 'whitespace_only' THEN server_id END) AS endpoints, min(observed_at) AS first, max(observed_at) AS last FROM drift_events WHERE server_id != ?1`,
      )
      .bind(CANARY_ID)
      .first<{ events: number; same_version: number; same_version_nws: number; endpoints: number; first: number | null; last: number | null }>(),
  ]);
  const by_class = Object.fromEntries(CHANGE_CLASSES.map((k) => [k, 0])) as Record<string, number>;
  for (const r of byClass.results) by_class[r.k] = r.n;
  const events = x?.events ?? 0;
  return {
    events,
    by_class,
    whitespace_only: by_class.whitespace_only ?? 0,
    whitespace_only_share: events ? Math.round(((by_class.whitespace_only ?? 0) / events) * 10_000) / 10_000 : null,
    same_version: x?.same_version ?? 0,
    same_version_excluding_whitespace: x?.same_version_nws ?? 0,
    endpoints_with_changes_excluding_whitespace: x?.endpoints ?? 0,
    first_event_at: iso(x?.first),
    last_event_at: iso(x?.last),
  };
}

export async function coverage(env: Pick<Env, "DB">, withChanges: boolean): Promise<Coverage> {
  const db = env.DB;
  const live = "listed = 1 AND coalesce(registry_status, '') NOT IN ('deleted', 'canary')";
  const [m, c, errs] = await Promise.all([
    meta(db),
    db
      .prepare(
        `SELECT count(DISTINCT registry_name) AS servers, count(*) AS endpoints,
           coalesce(sum(CASE WHEN polls_total > 0 THEN 1 ELSE 0 END), 0) AS attempted,
           coalesce(sum(CASE WHEN last_ok_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS reached,
           coalesce(sum(CASE WHEN last_status = 'auth_required' THEN 1 ELSE 0 END), 0) AS auth,
           coalesce(sum(CASE WHEN last_status = 'error' THEN 1 ELSE 0 END), 0) AS errored,
           coalesce(sum(CASE WHEN last_status = 'rate_limited' THEN 1 ELSE 0 END), 0) AS limited,
           coalesce(sum(CASE WHEN last_status = 'skipped_optout' THEN 1 ELSE 0 END), 0) AS optout,
           coalesce(sum(CASE WHEN needs_config IS NOT NULL THEN 1 ELSE 0 END), 0) AS needs_config,
           coalesce(sum(CASE WHEN needs_config IS NULL AND transport != 'streamable-http' THEN 1 ELSE 0 END), 0) AS sse,
           coalesce(sum(CASE WHEN polls_total = 0 AND last_status IS NULL THEN 1 ELSE 0 END), 0) AS pending,
           max(last_poll_at) AS last_poll
         FROM drift_servers WHERE ${live}`,
      )
      .first<Record<string, number | null>>(),
    db.prepare(`SELECT last_error_class AS k, count(*) AS n FROM drift_servers WHERE ${live} AND last_status = 'error' GROUP BY last_error_class`).all<{ k: string | null; n: number }>(),
  ]);
  const n = (k: string) => Number(c?.[k] ?? 0);
  return {
    data_kind: "forge_live_drift_coverage",
    contract: LIVE_DRIFT_CONTRACT,
    ...m,
    scope: COVERAGE_SCOPE,
    last_poll_at: iso(c?.last_poll ?? null),
    counts: {
      servers_listed: n("servers"),
      endpoints_listed: n("endpoints"),
      endpoints_attempted: n("attempted"),
      endpoints_reached: n("reached"),
      auth_required: n("auth"),
      errored: n("errored"),
      rate_limited: n("limited"),
      opted_out: n("optout"),
      needs_config_declared: n("needs_config"),
      sse_not_polled: n("sse"),
      not_yet_attempted: n("pending"),
    },
    errors_by_class: Object.fromEntries(errs.results.map((r) => [r.k ?? "unknown", r.n])),
    changes: withChanges ? await changeTotals(db) : null,
  };
}

/** The description inside a stored tool text (the contract canonical JSON), or null. */
const descriptionOf = (text: string | null) => {
  if (!text) return null;
  try {
    const d = (JSON.parse(text) as { description?: unknown }).description;
    return typeof d === "string" ? d : null;
  } catch {
    return null;
  }
};

/**
 * ADR 0151 amendment 2: the canary's latest polls and change events, for the founder's /admin/drift page. Our own
 * fixture's text only; never part of coverage or change totals.
 */
export async function canaryStatus(env: Pick<Env, "DB">) {
  const db = env.DB;
  const [row, polls, events, metaRows] = await Promise.all([
    db.prepare("SELECT remote_url, last_poll_at, last_ok_at, last_status, last_error_class, polls_total, polls_ok, first_observed_at FROM drift_servers WHERE id = ?1").bind(CANARY_ID).first<Record<string, number | string | null>>(),
    db.prepare("SELECT at, status, error_class, snapshot, baseline, changes, reported_version FROM drift_polls WHERE server_id = ?1 ORDER BY id DESC LIMIT 10").bind(CANARY_ID).all<{ at: number; status: string; error_class: string | null; snapshot: string | null; baseline: number; changes: number; reported_version: string | null }>(),
    db
      .prepare("SELECT tool, observed_at, previous_at, change_class, same_version, reported_version_before, reported_version_after, before_snapshot, after_snapshot, before_text, after_text FROM drift_events WHERE server_id = ?1 ORDER BY id DESC LIMIT 10")
      .bind(CANARY_ID)
      .all<{ tool: string; observed_at: number; previous_at: number | null; change_class: string; same_version: number; reported_version_before: string | null; reported_version_after: string | null; before_snapshot: string | null; after_snapshot: string; before_text: string | null; after_text: string | null }>(),
    db.prepare("SELECT key, value FROM drift_meta WHERE key IN ('registry_sync_error', 'registry_cursor', 'registry_synced_at')").all<{ key: string; value: string }>(),
  ]);
  return {
    endpoint: row ? { url: row.remote_url, last_poll_at: iso(row.last_poll_at as number | null), last_status: row.last_status, last_error_class: row.last_error_class, polls_total: row.polls_total, polls_ok: row.polls_ok, baseline_at: iso(row.first_observed_at as number | null) } : null,
    polls: polls.results.map((p) => ({ at: iso(p.at), status: p.status, error_class: p.error_class, snapshot: p.snapshot, baseline: !!p.baseline, changes: p.changes, reported_version: p.reported_version })),
    events: events.results.map((e) => ({
      tool: e.tool,
      observed_at: iso(e.observed_at),
      previous_at: iso(e.previous_at),
      change_class: e.change_class,
      same_version: !!e.same_version,
      versions: [e.reported_version_before, e.reported_version_after],
      before_snapshot: e.before_snapshot,
      after_snapshot: e.after_snapshot,
      before_description: descriptionOf(e.before_text),
      after_description: descriptionOf(e.after_text),
    })),
    registry: Object.fromEntries(metaRows.results.map((r) => [r.key, r.value])),
  };
}

export async function optouts(env: Pick<Env, "DB">) {
  const rows = (await env.DB.prepare("SELECT kind, value, added_at, note FROM drift_optouts ORDER BY added_at, id").all<{ kind: string; value: string; added_at: number; note: string | null }>()).results;
  return rows.map((r) => ({ kind: r.kind, value: r.value, added_at: iso(r.added_at), note: r.note }));
}

// --- The gateway API ----------------------------------------------------------------------------------------------

interface EndpointRow {
  id: string;
  registry_name: string;
  remote_url: string;
  host: string;
  transport: string;
  registry_version: string | null;
  listed: number;
  last_status: string | null;
  last_poll_at: number | null;
  last_ok_at: number | null;
  first_observed_at: number | null;
  ok_registry_version: string | null;
  ok_reported_version: string | null;
  ok_snapshot: string | null;
}

/** A server is named by its Registry name (io.github.owner/name) or one of its remote URLs. */
export function parseServerParam(raw: string | undefined | null): { ok: true; by: "url" | "registry_name"; value: string } | { ok: false; error: { error: "invalid_server"; needed: string; examples: string[] } } {
  const v = (raw ?? "").trim();
  const bad = { ok: false as const, error: { error: "invalid_server" as const, needed: "server: a Registry name or an https remote URL", examples: ["io.github.owner/server-name", "https://mcp.example.com/mcp"] } };
  if (!v || v.length > 2048) return bad;
  // ADR 0157: a plain URL or Registry name only (no spaces, control or direction characters, nothing that reads as an
  // instruction), since an unknown server's name used to be echoed and signed.
  if (/^https:\/\//i.test(v)) return urlProblem(v) === null ? { ok: true, by: "url", value: v } : bad;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(v) && v.length <= 200 && !textLike(v)) return { ok: true, by: "registry_name", value: v };
  return bad;
}

/** The endpoints of a server, each marked when an opt-out names it (an opted-out endpoint's data is never answered). */
async function endpointsOf(db: D1Database, by: "url" | "registry_name", value: string) {
  const col = by === "url" ? "remote_url" : "registry_name";
  const list = (await db.prepare("SELECT kind, value FROM drift_optouts").all<{ kind: string; value: string }>()).results;
  const rows = (
    await db
      .prepare(`SELECT id, registry_name, remote_url, host, transport, registry_version, listed, last_status, last_poll_at, last_ok_at, first_observed_at, ok_registry_version, ok_reported_version, ok_snapshot FROM drift_servers WHERE ${col} = ?1 ORDER BY listed DESC, remote_url LIMIT 10`)
      .bind(value)
      .all<EndpointRow>()
  ).results;
  return rows.map((r) => ({ ...r, opted_out: optedOut(r, list) }));
}

async function digestsOf(db: D1Database, id: string) {
  return (
    await db
      .prepare("SELECT tool AS name, raw_digest AS raw, normalised_digest AS normalised, contract_digest AS contract, last_seen_at FROM drift_tool_state WHERE server_id = ?1 ORDER BY tool")
      .bind(id)
      .all<{ name: string; raw: string; normalised: string; contract: string; last_seen_at: number }>()
  ).results;
}

export const RECENT_EVENTS = 20;

async function eventsOf(db: D1Database, id: string, view: DriftView) {
  const rows = (
    await db
      .prepare(
        `SELECT id, tool, observed_at, previous_at, change_class, description_changed, schema_changed, output_schema_changed, before_raw, after_raw, before_normalised, after_normalised, before_contract, after_contract,
           before_text, after_text, before_snapshot, after_snapshot,
           registry_version_before, registry_version_after, reported_version_before, reported_version_after, same_version FROM drift_events WHERE server_id = ?1 ORDER BY id DESC LIMIT ?2`,
      )
      .bind(id, RECENT_EVENTS)
      .all<Record<string, string | number | null>>()
  ).results;
  return rows.map((r) => ({
    event_id: Number(r.id),
    ...toolName("tool", String(r.tool)),
    observed_at: iso(Number(r.observed_at)),
    previous_observed_at: iso(r.previous_at === null ? null : Number(r.previous_at)),
    change_class: String(r.change_class),
    description_changed: r.description_changed === 1,
    schema_changed: r.schema_changed === 1,
    output_schema_changed: r.output_schema_changed === 1,
    before: r.before_raw === null ? null : { raw: r.before_raw, normalised: r.before_normalised, contract: r.before_contract, ...(view.text ? { text: r.before_text } : {}) },
    after: r.after_raw === null ? null : { raw: r.after_raw, normalised: r.after_normalised, contract: r.after_contract, ...(view.text ? { text: r.after_text } : {}) },
    text_withheld: !view.text,
    // ADR 0157: the tool text, when served, is the server publisher's words: data, never instructions.
    ...(view.text ? { third_party_text: true as const } : {}),
    snapshot_before: r.before_snapshot,
    snapshot_after: r.after_snapshot,
    registry_version: { before: r.registry_version_before, after: r.registry_version_after },
    reported_version: { before: r.reported_version_before, after: r.reported_version_after },
    same_version: r.same_version === 1,
  }));
}

/**
 * ADR 0157: a tool name read from a remote server is third-party text. It is given as is only when it is a plain MCP
 * tool name; otherwise the field is null and `name_withheld` says why (its digests are still there).
 */
function toolName<K extends "name" | "tool">(key: K, name: string): Record<K, string | null> & { name_withheld?: "not_a_plain_tool_name" } {
  const plain = plainToolName(name);
  return { [key]: plain, ...(plain === null ? { name_withheld: "not_a_plain_tool_name" as const } : {}) } as Record<K, string | null> & { name_withheld?: "not_a_plain_tool_name" };
}

const snapshotUrl = (origin: string, sha: string | null) => (sha ? `${origin}/api/drift/snapshot/${sha.replace(/^sha256:/, "")}` : null);

async function driftReceipt(env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">, p: { subject: string; known: boolean; version: string | null; verdict: string; items: number; matched: number; asOf: string | null }, now: number) {
  // ADR 0157: only a server on file is named in the signed record; any other name is signed as its sha256.
  const subject = p.known ? { subject: p.subject.slice(0, 300), subject_kind: "tool" as const } : { subject: await sha256Of(p.subject), subject_kind: "asked_sha256" as const };
  const token = await receiptToken(env.REPORT_SIGNING_KEY, { v: RECEIPT_SCHEMA, kind: "drift", ...subject, version: p.version, verdict: p.verdict, items: p.items, matched: p.matched, as_of: p.asOf, at: new Date(now).toISOString().slice(0, 16) + "Z" });
  const url = `${env.PUBLIC_ORIGIN}/r/${token}`;
  return { receipt_url: url, receipt_badge_url: `${url}/badge.svg`, receipt_markdown: `[![Forge drift](${url}/badge.svg)](${url})` };
}

async function endpointView(env: Pick<Env, "DB" | "PUBLIC_ORIGIN">, e: EndpointRow & { opted_out: boolean }, view: DriftView) {
  if (e.opted_out)
    return { url: e.remote_url, transport: e.transport, listed: e.listed === 1, status: "opted_out", first_observed_at: null, last_attempt_at: null, last_observed_at: null, registry_version: null, reported_version: null, snapshot: null, snapshot_url: null, tools: [], recent_changes: [] };
  const tools = await digestsOf(env.DB, e.id);
  return {
    url: e.remote_url,
    transport: e.transport,
    listed: e.listed === 1,
    status: e.last_status ?? "not_yet_attempted",
    first_observed_at: iso(e.first_observed_at),
    last_attempt_at: iso(e.last_poll_at),
    /** When the digests below were observed (the last successful tools/list). */
    last_observed_at: iso(e.last_ok_at),
    registry_version: e.ok_registry_version,
    reported_version: e.ok_reported_version,
    snapshot: e.ok_snapshot,
    snapshot_url: snapshotUrl(env.PUBLIC_ORIGIN, e.ok_snapshot),
    tools: tools.map((t) => ({ ...toolName("name", t.name), digest: t.raw, digest_normalised: t.normalised, digest_contract: t.contract })),
    recent_changes: await eventsOf(env.DB, e.id, view),
  };
}

const latestObserved = (eps: { last_observed_at: string | null }[]) => eps.map((e) => e.last_observed_at).filter((x): x is string => !!x).sort().at(-1) ?? null;

/** GET /api/drift/tool: one server's current per-tool digests and its recent change events. */
export async function serverDrift(env: Pick<Env, "DB" | "PUBLIC_ORIGIN" | "REPORT_SIGNING_KEY">, q: { by: "url" | "registry_name"; value: string }, view: DriftView = { text: false }, now = Date.now()) {
  const [rows, m] = await Promise.all([endpointsOf(env.DB, q.by, q.value), meta(env.DB)]);
  const endpoints = await Promise.all(rows.map((e) => endpointView(env, e, view)));
  const observed = latestObserved(endpoints);
  const subject = rows[0]?.registry_name ?? q.value;
  return {
    data_kind: "forge_live_drift_server" as const,
    contract: LIVE_DRIFT_CONTRACT,
    server: subject,
    known: rows.length > 0,
    answered_at: new Date(now).toISOString(),
    observed_at: observed,
    series_started_at: m.series_started_at,
    method: {
      digest: "sha256 of canonical JSON of {name, description, inputSchema} (keys sorted)",
      digest_normalised: "the same with whitespace collapsed in the description and in schema descriptions",
      digest_contract: "sha256 of canonical JSON of {name, description, inputSchema, outputSchema} (Kuadrant/mcp-gateway #1633's four fields; absent outputSchema is null)",
      poll_interval_hours: MONITOR_POLICY.minIntervalHours,
    },
    text_withheld: !view.text,
    endpoints,
    share: await driftReceipt(env, { subject, known: rows.length > 0, version: rows[0]?.ok_reported_version ?? rows[0]?.ok_registry_version ?? null, verdict: !rows.length ? "not_monitored" : observed ? "observed" : "not_observed", items: endpoints.reduce((s, e) => s + e.tools.length, 0), matched: 0, asOf: observed }, now),
  };
}

/** Hold-on-change: per endpoint, which pinned tools still have the same digest. hold is true when anything differs. */
export async function holdCheck(env: Pick<Env, "DB" | "PUBLIC_ORIGIN" | "REPORT_SIGNING_KEY">, q: { by: "url" | "registry_name"; value: string }, pins: Record<string, Pin>, match: PinMatch = "normalised", now = Date.now()) {
  const [rows, m] = await Promise.all([endpointsOf(env.DB, q.by, q.value), meta(env.DB)]);
  const endpoints = await Promise.all(
    rows.map(async (e) => {
      const tools = e.opted_out ? [] : await digestsOf(env.DB, e.id);
      const observed = !e.opted_out && e.last_ok_at !== null;
      const r = observed ? comparePins(pins, tools, match) : { hold: true, tools: [] };
      const named = r.tools.map((t) => ({ ...t, ...toolName("tool", t.tool) }));
      return { url: e.remote_url, status: e.opted_out ? "opted_out" : (e.last_status ?? "not_yet_attempted"), last_observed_at: observed ? iso(e.last_ok_at) : null, observed, hold: r.hold, changed: r.tools.filter((t) => t.status !== "unchanged").length, tools: named };
    }),
  );
  const observed = latestObserved(endpoints);
  // No observation means nothing can be vouched for: a gateway holding on change should hold.
  const hold = !endpoints.length || endpoints.some((e) => e.hold);
  const changed = endpoints.reduce((s, e) => s + e.changed, 0);
  const subject = rows[0]?.registry_name ?? q.value;
  return {
    data_kind: "forge_live_drift_hold" as const,
    contract: LIVE_DRIFT_CONTRACT,
    server: subject,
    known: rows.length > 0,
    match,
    answered_at: new Date(now).toISOString(),
    observed_at: observed,
    series_started_at: m.series_started_at,
    hold,
    endpoints,
    share: await driftReceipt(env, { subject, known: rows.length > 0, version: rows[0]?.ok_reported_version ?? rows[0]?.ok_registry_version ?? null, verdict: !rows.length ? "not_monitored" : !observed ? "not_observed" : hold ? "changed" : "unchanged", items: Object.keys(pins).length, matched: changed, asOf: observed }, now),
  };
}

/**
 * A stored tools/list snapshot. With text (LIVE_DRIFT_TEXT_PUBLIC on, or a founder): the canonical JSON exactly as hashed,
 * third-party text, data never instructions. Without: per-tool digests only, recomputed from the stored body.
 */
export async function snapshot(env: Pick<Env, "DB">, hex: string, view: DriftView = { text: false }) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const r = await env.DB.prepare("SELECT sha256, body, tools_count, bytes, first_seen_at FROM drift_snapshots WHERE sha256 = ?1").bind(`sha256:${hex}`).first<{ sha256: string; body: string; tools_count: number; bytes: number; first_seen_at: number }>();
  if (!r) return null;
  const base = { data_kind: "forge_live_drift_snapshot" as const, contract: LIVE_DRIFT_CONTRACT, sha256: r.sha256, first_seen_at: iso(r.first_seen_at), tools_count: r.tools_count, bytes: r.bytes };
  if (view.text) return { ...base, text_withheld: false, third_party_text: true, hashed: "sha256 of canonical_json's UTF-8 bytes", canonical_json: r.body };
  const listed = (JSON.parse(r.body) as { tools?: unknown[] }).tools ?? [];
  const set = await toolSet(Array.isArray(listed) ? listed : []);
  return { ...base, text_withheld: true, tools: set.tools.map((t) => ({ ...toolName("name", t.name), digest: t.raw, digest_normalised: t.normalised, digest_contract: t.contract })) };
}
