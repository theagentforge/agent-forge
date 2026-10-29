// B3-08 (ADR 0102): backups outside D1 Time Travel.
// 1. A SQL dump of the whole D1 database, streamed through the Worker to a founder admin (/admin/backup), who keeps a
//    copy in iCloud Drive once a month. Streamed page by page, each page capped in rows and bytes (never the whole database in memory), so it stays within
//    the Worker's 128 MB memory; the work per page is small, so CPU stays well inside the request limit. The dump ends
//    with a "complete" line: a file without it was cut off and must not be trusted.
// 2. A weekly copy to the R2 bucket `forge-backups`, through an optional `BACKUPS` binding. R2 isn't enabled on the
//    account yet, so wrangler.jsonc has no binding and everything here is a no-op until it is added
//    (docs/runbooks/backups.md has the exact snippet). Keeps the 8 newest weekly copies and the first copy of each of
//    the 6 newest months.

import { exportIndex, isoWeek, readExportFile, readManifest } from "./bulk-export";

export const BACKUP_PATH = "/admin/backup";
export const LAST_DOWNLOAD_KEY = "backup:last_download";
export const R2_LAST_KEY = "backup:r2:last";
export const DUMP_FORMAT = "forge-d1-dump/1";
export const DUMP_COMPLETE = "-- forge-d1-dump: complete";
/**
 * At most this many rows per read from D1. D1 allows 1,000 queries per Worker invocation (Workers Paid), and each page
 * is one query, so pages are large: about 2,000 rows a query lets the dump read 1.5 million+ rows in one request.
 */
export const DUMP_PAGE_ROWS = 2000;
/**
 * And at most about this many bytes per read (review of ADR 0102, ADR 0106): a row can be up to 2 MB in D1 (Arena runs
 * carry their log and checkpoint), so a page of rows could otherwise need hundreds of MB once escaped, past the
 * Worker's 128 MB. The same query sizes each page from the rows' stored lengths; a row larger than this is read alone.
 */
export const DUMP_PAGE_BYTES = 4 * 1024 * 1024;
export const KEEP_WEEKLY = 8;
export const KEEP_MONTHLY = 6;
export const R2_PREFIX = "backup/";
/** R2 multipart parts: at least 5 MiB, all the same size except the last. */
export const R2_PART_BYTES = 8 * 1024 * 1024;

// --- The SQL dump -----------------------------------------------------------------------------------------------------

/** Tables D1 or SQLite own (D1 refuses reads of _cf_*); they are never dumped. */
export const skipTable = (name: string) => name.startsWith("_cf_") || name.startsWith("sqlite_");

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** One value as a SQL literal. D1 returns blobs as arrays of bytes (or ArrayBuffers). */
export function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;
  if (bytes) return `X'${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * D1 refuses any SQL statement over 100 KB ("Statement too long"), also when importing a file, and a row can be up to
 * 2 MB. So a row whose INSERT would pass STATEMENT_MAX_BYTES is written as an INSERT with its long text values empty,
 * then UPDATEs that append each value in pieces of at most TEXT_PIECE_CHARS (review of ADR 0102, ADR 0106). Rows are
 * inserted in rowid order, so the row just inserted is the one with the largest rowid. Indexes and triggers are created
 * after all rows, so the empty values never meet a unique index or a trigger.
 */
export const STATEMENT_MAX_BYTES = 90_000;
export const TEXT_PIECE_CHARS = 10_000;
const LONG_TEXT = 1_000;
const enc8 = new TextEncoder();

/** Splits a string into pieces of at most `n` UTF-16 units, never between the two halves of a surrogate pair. */
export function textPieces(v: string, n = TEXT_PIECE_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < v.length; ) {
    let end = Math.min(i + n, v.length);
    const c = v.charCodeAt(end - 1);
    if (end < v.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(v.slice(i, end));
    i = end;
  }
  return out;
}

/** One row as SQL: a single INSERT, or for a large row an INSERT plus appending UPDATEs, each under 100 KB. */
export function insertRow(table: string, colList: string, cols: string[], values: unknown[]): string {
  const line = `INSERT INTO ${table} ${colList} VALUES (${values.map(sqlValue).join(", ")});\n`;
  if (line.length * 3 <= STATEMENT_MAX_BYTES || enc8.encode(line).byteLength <= STATEMENT_MAX_BYTES) return line;
  const later: [string, string][] = [];
  const first = values.map((v, i) => {
    if (typeof v !== "string" || v.length <= LONG_TEXT) return sqlValue(v);
    later.push([cols[i]!, v]);
    return "''";
  });
  let out = `INSERT INTO ${table} ${colList} VALUES (${first.join(", ")});\n`;
  for (const [col, v] of later) {
    const c = quoteIdent(col);
    for (const piece of textPieces(v)) out += `UPDATE ${table} SET ${c} = ${c} || ${sqlValue(piece)} WHERE rowid = (SELECT max(rowid) FROM ${table});\n`;
  }
  return out;
}

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export async function schemaRows(db: D1Database) {
  const { results } = await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name").all<SchemaRow>();
  return results.filter((r) => !skipTable(r.name) && !skipTable(r.tbl_name));
}

/** The tables a dump holds, in order. */
export async function dumpTables(db: D1Database) {
  return (await schemaRows(db)).filter((r) => r.type === "table").map((r) => r.name);
}

/** The tables skipTable leaves out, in SQL (D1 refuses reads of _cf_*). */
const NOT_OURS = String.raw`m.name NOT LIKE '\_cf\_%' ESCAPE '\' AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\'`;

/** Every table's columns and foreign-key parents, in two queries (D1 counts every query against the 1,000 limit). */
export async function tableInfo(db: D1Database) {
  const [cols, fks] = await Promise.all([
    db.prepare(`SELECT m.name AS t, p.name AS c FROM sqlite_master AS m, pragma_table_info(m.name) AS p WHERE m.type = 'table' AND ${NOT_OURS} ORDER BY m.name, p.cid`).all<{ t: string; c: string }>(),
    db.prepare(`SELECT m.name AS t, f."table" AS parent FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f WHERE m.type = 'table' AND ${NOT_OURS}`).all<{ t: string; parent: string }>(),
  ]);
  const columns = new Map<string, string[]>();
  for (const r of cols.results) columns.set(r.t, [...(columns.get(r.t) ?? []), r.c]);
  const parents = new Map<string, Set<string>>();
  for (const r of fks.results) parents.set(r.t, (parents.get(r.t) ?? new Set()).add(r.parent));
  return { columns, parents };
}

/**
 * The tables in an order where every table comes after the tables its foreign keys point to (a cycle or a reference to
 * a missing table keeps the remaining tables in name order). Self-references don't count.
 */
export async function parentsFirst<T extends { name: string }>(db: D1Database, tables: T[], parents?: Map<string, Set<string>>): Promise<T[]> {
  const names = new Set(tables.map((x) => x.name));
  const of = parents ?? (await tableInfo(db)).parents;
  const deps = new Map(tables.map((tb) => [tb.name, [...(of.get(tb.name) ?? [])].filter((p) => p !== tb.name && names.has(p))]));
  const out: T[] = [];
  const done = new Set<string>();
  let left = [...tables];
  while (left.length) {
    const ready = left.filter((x) => deps.get(x.name)!.every((p) => done.has(p)));
    const take = ready.length ? ready : [left[0]!];
    for (const x of take) (out.push(x), done.add(x.name));
    left = left.filter((x) => !done.has(x.name));
  }
  return out;
}

/**
 * The dump as text pieces: header, every table's CREATE, then each table's INSERTs, parents first, then indexes,
 * triggers and views, then the complete line. Rows are read by rowid range, one query per page: up to `pageRows` rows
 * and about `pageBytes` bytes (a window sum over the rows' stored lengths), so nothing large is held between pages.
 */
export async function* dumpChunks(db: D1Database, now = Date.now(), pageRows = DUMP_PAGE_ROWS, pageBytes = DUMP_PAGE_BYTES): AsyncGenerator<string> {
  const schema = await schemaRows(db);
  const tables = schema.filter((r) => r.type === "table");
  const info = await tableInfo(db);
  yield `-- ${DUMP_FORMAT}\n-- The Agent Forge: full SQL dump of D1, made ${new Date(now).toISOString()}\n-- Restore: docs/runbooks/backups.md (into a new, empty D1 database)\nPRAGMA defer_foreign_keys=TRUE;\n`;
  // Every table first, then the rows parents-first (review of ADR 0102, ADR 0106): D1 always enforces foreign keys, and
  // an INSERT into a table whose parent table doesn't exist yet fails with "no such table", deferred or not.
  for (const tb of tables) yield `\n${tb.sql};\n`;
  const counts: Record<string, number> = {};
  for (const tb of await parentsFirst(db, tables, info.parents)) {
    const name = quoteIdent(tb.name);
    const cs = info.columns.get(tb.name) ?? [];
    const size = cs.length ? cs.map((c) => `coalesce(length(CAST(${quoteIdent(c)} AS BLOB)), 0)`).join(" + ") : "0";
    // The LIMIT applies before the window sums; a page is the rows whose running size fits, and always the first row.
    // The LIMIT applies before the window sums; a page runs to the last row whose running size fits (always at least the
    // first row), read as one rowid range (a range on the rowid, so each page reads only its own rows).
    const pageSql = (first: boolean) =>
      `WITH p AS (SELECT r, sum(sz) OVER (ORDER BY r) AS cum, row_number() OVER (ORDER BY r) AS k FROM (SELECT rowid AS r, ${size} AS sz FROM ${name}${first ? "" : " WHERE rowid > ?3"} ORDER BY rowid LIMIT ?1)) ` +
      `SELECT (SELECT count(*) FROM p) AS __forge_planned, t.rowid AS __forge_rowid, t.* FROM ${name} AS t WHERE ${first ? "" : "t.rowid > ?3 AND "}t.rowid <= (SELECT max(r) FROM p WHERE cum <= ?2 OR k = 1) ORDER BY t.rowid`;
    let last: number | null = null;
    let rows = 0;
    for (;;) {
      const stmt = last === null ? db.prepare(pageSql(true)).bind(pageRows, pageBytes) : db.prepare(pageSql(false)).bind(pageRows, pageBytes, last);
      const raw = await stmt.raw<unknown[]>({ columnNames: true });
      const [cols, ...data] = raw as [string[], ...unknown[][]];
      if (!cols || !data.length) break;
      const colList = `(${cols.slice(2).map(quoteIdent).join(", ")})`;
      let out = "";
      for (const r of data) out += insertRow(name, colList, cols.slice(2), r.slice(2));
      rows += data.length;
      last = Number(data[data.length - 1]![1]);
      yield out;
      const planned = Number(data[0]![0]);
      if (planned < pageRows && data.length === planned) break; // the table's last rows
    }
    counts[tb.name] = rows;
  }
  for (const r of schema.filter((x) => x.type !== "table")) yield `${r.sql};\n`;
  yield `\n-- rows: ${JSON.stringify(counts)}\n${DUMP_COMPLETE} (${tables.length} tables)\n`;
}

/** The dump as a byte stream that reads the next page only when the reader wants more (backpressure). */
export function dumpStream(db: D1Database, now = Date.now(), onDone?: (bytes: number) => Promise<void>) {
  const it = dumpChunks(db, now);
  const enc = new TextEncoder();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await it.next();
        if (next.done) {
          await onDone?.(bytes).catch(() => {});
          controller.close();
          return;
        }
        const b = enc.encode(next.value);
        bytes += b.byteLength;
        controller.enqueue(b);
      } catch (e) {
        // A cut-off file has no complete line, so it can't be mistaken for a whole backup.
        console.error("backup_dump_failed", String(e));
        controller.error(e);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}

export const dumpFileName = (now: number) => `forge-d1-${new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}.sql`;

// --- "Last downloaded" (KV, no migration) ------------------------------------------------------------------------------

export interface LastDownload {
  started_at: string;
  by: string;
  file: string;
  completed_at: string | null;
  bytes: number | null;
}

export async function recordDownloadStart(env: Env, by: string, file: string, now = Date.now()) {
  const v: LastDownload = { started_at: new Date(now).toISOString(), by, file, completed_at: null, bytes: null };
  await env.KV.put(LAST_DOWNLOAD_KEY, JSON.stringify(v));
  return v;
}

export async function recordDownloadDone(env: Env, v: LastDownload, bytes: number, now = Date.now()) {
  await env.KV.put(LAST_DOWNLOAD_KEY, JSON.stringify({ ...v, completed_at: new Date(now).toISOString(), bytes }));
}

export const lastDownload = (env: Env) => env.KV.get<LastDownload>(LAST_DOWNLOAD_KEY, "json");

// --- The weekly R2 copy (off until the BACKUPS binding exists) ---------------------------------------------------------

/** True only when the R2 bucket is bound. This is the flag: no binding, no R2 work at all. */
export const r2Enabled = (env: Env) => !!env.BACKUPS;

/**
 * Retention: from backup ids (UTC dates, YYYY-MM-DD), the ones to keep: the 8 newest, plus the first backup of each of
 * the 6 newest months. Everything else is deleted.
 */
export function retention(ids: string[], keepWeekly = KEEP_WEEKLY, keepMonthly = KEEP_MONTHLY) {
  const sorted = [...new Set(ids)].sort();
  const keep = new Set(sorted.slice(-keepWeekly));
  const firstOfMonth = new Map<string, string>();
  for (const id of sorted) if (!firstOfMonth.has(id.slice(0, 7))) firstOfMonth.set(id.slice(0, 7), id);
  for (const id of [...firstOfMonth.values()].slice(-keepMonthly)) keep.add(id);
  return { keep: sorted.filter((x) => keep.has(x)), remove: sorted.filter((x) => !keep.has(x)) };
}

const BACKUP_ID = /^\d{4}-\d{2}-\d{2}$/;

async function listAll(bucket: R2Bucket, prefix: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await bucket.list({ prefix, cursor });
    keys.push(...r.objects.map((o) => o.key));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Backup ids in the bucket, and which are complete (their manifest, written last, exists). */
export async function r2Backups(bucket: R2Bucket) {
  const keys = await listAll(bucket, R2_PREFIX);
  const ids = new Map<string, boolean>();
  for (const k of keys) {
    const id = k.slice(R2_PREFIX.length).split("/")[0] ?? "";
    if (!BACKUP_ID.test(id)) continue;
    ids.set(id, (ids.get(id) ?? false) || k === `${R2_PREFIX}${id}/manifest.json`);
  }
  return { keys, ids };
}

/** Deletes every backup retention doesn't keep, and incomplete ones other than `today` (R2 deletes up to 1,000 keys a call). */
export async function pruneR2(bucket: R2Bucket, today: string) {
  const { keys, ids } = await r2Backups(bucket);
  const complete = [...ids].filter(([, ok]) => ok).map(([id]) => id);
  const { remove } = retention(complete);
  const drop = new Set([...remove, ...[...ids].filter(([id, ok]) => !ok && id !== today).map(([id]) => id)]);
  const doomed = keys.filter((k) => drop.has(k.slice(R2_PREFIX.length).split("/")[0] ?? ""));
  for (let i = 0; i < doomed.length; i += 1000) await bucket.delete(doomed.slice(i, i + 1000));
  return [...drop].sort();
}

/** Streams the dump into R2 with a multipart upload in fixed-size parts; returns the bytes written. */
async function putDump(bucket: R2Bucket, key: string, db: D1Database, now: number, partBytes = R2_PART_BYTES) {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/sql; charset=utf-8" } });
  const parts: R2UploadedPart[] = [];
  const enc = new TextEncoder();
  let buf = new Uint8Array(partBytes);
  let fill = 0;
  let total = 0;
  const flush = async () => {
    parts.push(await upload.uploadPart(parts.length + 1, buf.slice(0, fill)));
    buf = new Uint8Array(partBytes);
    fill = 0;
  };
  try {
    for await (const chunk of dumpChunks(db, now)) {
      let b = enc.encode(chunk);
      total += b.byteLength;
      while (b.byteLength) {
        const take = Math.min(b.byteLength, partBytes - fill);
        buf.set(b.subarray(0, take), fill);
        fill += take;
        b = b.subarray(take);
        if (fill === partBytes) await flush();
      }
    }
    if (fill || !parts.length) await flush();
    await upload.complete(parts);
  } catch (e) {
    await upload.abort().catch(() => {});
    throw e;
  }
  return total;
}

/**
 * Hourly cron: once per ISO week, when R2 is bound and this week's bulk export exists, writes `backup/<date>/`: the D1
 * dump, the week's export files (copied from KV) and a manifest (last, so a backup without one is incomplete), then
 * prunes. Without the binding it returns at once and touches nothing.
 */
export async function weeklyR2Backup(env: Env, now = Date.now()) {
  const bucket = env.BACKUPS;
  if (!bucket) return { enabled: false as const };
  const week = isoWeek(now);
  const last = await env.KV.get<{ week: string }>(R2_LAST_KEY, "json");
  if (last?.week === week) return { enabled: true as const, written: false, week };
  // The bulk export is written in the first hourly run of the week; wait for it so the copy holds this week's.
  const entry = (await exportIndex(env)).find((x) => x.week === week && x.trigger === "weekly");
  if (!entry) return { enabled: true as const, written: false, week, waiting_for: "weekly_export" };
  const manifest = await readManifest(env, entry.export_id);
  if (!manifest) return { enabled: true as const, written: false, week, waiting_for: "weekly_export" };
  const id = new Date(now).toISOString().slice(0, 10);
  const dir = `${R2_PREFIX}${id}/`;
  const dumpBytes = await putDump(bucket, `${dir}d1.sql`, env.DB, now);
  const files = [];
  for (const f of [...manifest.files.map((x) => x.name), "manifest.json"]) {
    const file = await readExportFile(env, manifest.export_id, f);
    if (!file) throw new Error(`export file missing: ${f}`);
    await bucket.put(`${dir}export/${f}`, file.body, { httpMetadata: { contentType: file.type } });
    files.push(f);
  }
  await bucket.put(`${dir}manifest.json`, JSON.stringify({ format: DUMP_FORMAT, backup_id: id, week, created_at: new Date(now).toISOString(), d1_dump: { key: `${dir}d1.sql`, bytes: dumpBytes }, export_id: manifest.export_id, export_files: files }, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.KV.put(R2_LAST_KEY, JSON.stringify({ week, id, at: new Date(now).toISOString(), dump_bytes: dumpBytes }));
  const pruned = await pruneR2(bucket, id);
  return { enabled: true as const, written: true, week, id, dump_bytes: dumpBytes, pruned };
}

export const r2Last = (env: Env) => env.KV.get<{ week: string; id: string; at: string; dump_bytes: number }>(R2_LAST_KEY, "json");
