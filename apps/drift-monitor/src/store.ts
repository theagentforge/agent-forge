import { CANARY_ID } from "@forge/shared/drift-canary";
import { backoffMs, diffTools, MONITOR_POLICY, spreadMs, toolSet, type PollStatus, type ToolState } from "@forge/shared/drift-monitor";
import type { PollOutcome } from "./mcp-client";

// ADR 0151 §1 and §9: how a poll is written. Each poll is one D1 batch (a transaction): the snapshot, the poll row,
// every change event, the per-tool state and the endpoint's status land together or not at all. drift_events,
// drift_polls and drift_snapshots are only ever inserted into (the migration's triggers refuse UPDATE and DELETE).
// Multi-row writes go through json_each, so a server with hundreds of tools is still a handful of statements.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export async function getMeta(db: D1Database, key: string) {
  return (await db.prepare("SELECT value FROM drift_meta WHERE key = ?1").bind(key).first<{ value: string }>())?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string, now: number) {
  await db.prepare("INSERT INTO drift_meta (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, now).run();
}

export interface Endpoint {
  id: string;
  registry_name: string;
  remote_url: string;
  host: string;
  transport: string;
  registry_version: string | null;
  needs_config: string | null;
  last_ok_at: number | null;
  first_observed_at: number | null;
  consecutive_errors: number;
  ok_registry_version: string | null;
  ok_reported_version: string | null;
  ok_snapshot: string | null;
}

const pollRow = (db: D1Database, e: Endpoint, now: number, f: { status: PollStatus; errorClass?: string | null; httpStatus?: number | null; snapshot?: string | null; toolsCount?: number | null; reportedVersion?: string | null; protocolVersion?: string | null; baseline?: boolean; changes?: number; durationMs?: number | null }) =>
  db
    .prepare(
      `INSERT INTO drift_polls (server_id, at, status, error_class, http_status, snapshot, tools_count, registry_version, reported_version, protocol_version, baseline, changes, duration_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(e.id, now, f.status, f.errorClass ?? null, f.httpStatus ?? null, f.snapshot ?? null, f.toolsCount ?? null, e.registry_version, f.reportedVersion ?? null, f.protocolVersion ?? null, f.baseline ? 1 : 0, f.changes ?? 0, f.durationMs ?? null);

/** A skip (opt-out, needs configuration, SSE-only): logged, and the endpoint isn't due again for a while. Nothing is sent. */
export async function recordSkip(db: D1Database, e: Endpoint, status: "skipped_optout" | "skipped_needs_config" | "skipped_sse", now: number) {
  const next = now + (status === "skipped_optout" ? DAY : MONITOR_POLICY.authRecheckDays * DAY);
  await db.batch([
    pollRow(db, e, now, { status }),
    db.prepare("UPDATE drift_servers SET last_status = ?2, last_error_class = NULL, last_http_status = NULL, next_poll_at = ?3 WHERE id = ?1").bind(e.id, status, next),
  ]);
}

export interface Recorded {
  status: PollStatus;
  baseline: boolean;
  changes: number;
  next: number;
}

/** Writes one poll's outcome. */
export async function recordOutcome(db: D1Database, e: Endpoint, out: PollOutcome, now: number, durationMs: number): Promise<Recorded> {
  if (out.status === "ok") {
    const set = await toolSet(out.tools);
    const bytes = new TextEncoder().encode(set.snapshot).byteLength;
    if (bytes > MONITOR_POLICY.maxSnapshotBytes) return recordOutcome(db, e, { status: "error", errorClass: "too_large", httpStatus: out.httpStatus, retryAfterS: null, detail: `snapshot ${bytes} bytes`, sent: out.sent }, now, durationMs);
    const prev = (await db.prepare("SELECT tool AS name, raw_digest AS raw, normalised_digest AS normalised, contract_digest AS contract, description_digest AS description, schema_digest AS schema, output_digest AS output, text, first_seen_at FROM drift_tool_state WHERE server_id = ?1").bind(e.id).all<ToolState & { first_seen_at: number }>()).results;
    const baseline = e.first_observed_at === null;
    const changes = baseline ? [] : diffTools(prev, set.tools);
    const firstSeen = new Map(prev.map((p) => [p.name, p.first_seen_at]));
    const sameVersion = (e.ok_registry_version ?? "") === (e.registry_version ?? "") && (e.ok_reported_version ?? "") === (out.reportedVersion ?? "");
    // Both sides' tool text is kept unless the two together would pass D1's 2 MB row limit (the snapshots still hold it).
    const events = changes.map((c) => {
      const big = (c.before?.text.length ?? 0) + (c.after?.text.length ?? 0) > MONITOR_POLICY.maxSnapshotBytes;
      return {
        tool: c.tool,
        cls: c.change_class,
        dc: c.description_changed ? 1 : 0,
        sc: c.schema_changed ? 1 : 0,
        oc: c.output_schema_changed ? 1 : 0,
        br: c.before?.raw ?? null,
        ar: c.after?.raw ?? null,
        bn: c.before?.normalised ?? null,
        an: c.after?.normalised ?? null,
        bc: c.before?.contract ?? null,
        ac: c.after?.contract ?? null,
        bt: big ? null : (c.before?.text ?? null),
        at: big ? null : (c.after?.text ?? null),
      };
    });
    const state = set.tools.map((t) => ({ n: t.name, r: t.raw, z: t.normalised, c: t.contract, d: t.description, s: t.schema, o: t.output, x: t.text, f: firstSeen.get(t.name) ?? now }));
    const next = now + MONITOR_POLICY.minIntervalHours * HOUR + spreadMs(e.id);
    const stmts: D1PreparedStatement[] = [
      db.prepare("INSERT OR IGNORE INTO drift_snapshots (sha256, body, tools_count, bytes, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(set.snapshotSha, set.snapshot, out.tools.length, bytes, now),
      pollRow(db, e, now, { status: "ok", httpStatus: out.httpStatus, snapshot: set.snapshotSha, toolsCount: out.tools.length, reportedVersion: out.reportedVersion, protocolVersion: out.protocolVersion, baseline, changes: events.length, durationMs }),
    ];
    if (events.length)
      stmts.push(
        db
          .prepare(
            `INSERT INTO drift_events (server_id, poll_id, tool, observed_at, previous_at, change_class, description_changed, schema_changed, output_schema_changed, before_raw, after_raw, before_normalised, after_normalised, before_contract, after_contract, before_text, after_text,
               before_snapshot, after_snapshot, registry_version_before, registry_version_after, reported_version_before, reported_version_after, same_version)
             SELECT ?1, (SELECT max(id) FROM drift_polls WHERE server_id = ?1 AND at = ?2), json_extract(value, '$.tool'), ?2, ?3, json_extract(value, '$.cls'), json_extract(value, '$.dc'), json_extract(value, '$.sc'), json_extract(value, '$.oc'),
               json_extract(value, '$.br'), json_extract(value, '$.ar'), json_extract(value, '$.bn'), json_extract(value, '$.an'), json_extract(value, '$.bc'), json_extract(value, '$.ac'), json_extract(value, '$.bt'), json_extract(value, '$.at'),
               ?4, ?5, ?6, ?7, ?8, ?9, ?10
             FROM json_each(?11) ORDER BY key`,
          )
          .bind(e.id, now, e.last_ok_at, e.ok_snapshot, set.snapshotSha, e.ok_registry_version, e.registry_version, e.ok_reported_version, out.reportedVersion, sameVersion ? 1 : 0, JSON.stringify(events)),
      );
    stmts.push(
      db.prepare("DELETE FROM drift_tool_state WHERE server_id = ?1").bind(e.id),
      db
        .prepare(
          `INSERT INTO drift_tool_state (server_id, tool, raw_digest, normalised_digest, contract_digest, description_digest, schema_digest, output_digest, text, first_seen_at, last_seen_at)
           SELECT ?1, json_extract(value, '$.n'), json_extract(value, '$.r'), json_extract(value, '$.z'), json_extract(value, '$.c'), json_extract(value, '$.d'), json_extract(value, '$.s'), json_extract(value, '$.o'), json_extract(value, '$.x'), json_extract(value, '$.f'), ?2 FROM json_each(?3)`,
        )
        .bind(e.id, now, JSON.stringify(state)),
      db
        .prepare(
          `UPDATE drift_servers SET last_poll_at = ?2, last_ok_at = ?2, last_status = 'ok', last_error_class = NULL, last_http_status = ?3, consecutive_errors = 0, polls_total = polls_total + 1, polls_ok = polls_ok + 1,
             first_observed_at = coalesce(first_observed_at, ?2), ok_registry_version = registry_version, ok_reported_version = ?4, ok_snapshot = ?5, next_poll_at = ?6 WHERE id = ?1`,
        )
        .bind(e.id, now, out.httpStatus, out.reportedVersion, set.snapshotSha, next),
    );
    // The series starts with the first successful poll of a Registry endpoint (never the canary's), and is never moved.
    if (e.id !== CANARY_ID) stmts.push(db.prepare("INSERT OR IGNORE INTO drift_meta (key, value, updated_at) VALUES ('series_started_at', ?1, ?2)").bind(new Date(now).toISOString(), now));
    await db.batch(stmts);
    return { status: "ok", baseline, changes: events.length, next };
  }

  if (out.status === "auth_required") {
    const next = now + MONITOR_POLICY.authRecheckDays * DAY;
    await db.batch([
      pollRow(db, e, now, { status: "auth_required", httpStatus: out.httpStatus, durationMs }),
      db.prepare("UPDATE drift_servers SET last_poll_at = ?2, last_status = 'auth_required', last_error_class = NULL, last_http_status = ?3, consecutive_errors = 0, polls_total = polls_total + 1, next_poll_at = ?4 WHERE id = ?1").bind(e.id, now, out.httpStatus, next),
    ]);
    return { status: "auth_required", baseline: false, changes: 0, next };
  }

  const n = e.consecutive_errors + 1;
  const next = now + backoffMs(n, out.retryAfterS);
  const errorClass = out.status === "rate_limited" ? null : out.errorClass;
  await db.batch([
    pollRow(db, e, now, { status: out.status, errorClass, httpStatus: out.httpStatus, durationMs }),
    db.prepare("UPDATE drift_servers SET last_poll_at = ?2, last_status = ?3, last_error_class = ?4, last_http_status = ?5, consecutive_errors = ?6, polls_total = polls_total + 1, next_poll_at = ?7 WHERE id = ?1").bind(e.id, now, out.status, errorClass, out.httpStatus, n, next),
  ]);
  return { status: out.status, baseline: false, changes: 0, next };
}
