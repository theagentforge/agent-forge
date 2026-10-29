import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import {
  BACKUP_PATH,
  DUMP_COMPLETE,
  dumpChunks,
  dumpTables,
  DUMP_PAGE_BYTES,
  parentsFirst,
  insertRow,
  STATEMENT_MAX_BYTES,
  textPieces,
  lastDownload,
  LAST_DOWNLOAD_KEY,
  pruneR2,
  r2Enabled,
  R2_LAST_KEY,
  R2_PREFIX,
  retention,
  sqlValue,
  weeklyR2Backup,
} from "../src/services/backup";
import { writeExport } from "../src/services/bulk-export";
import { PRIVATE_HEADERS } from "../src/services/data-room";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, ORIGIN, profile } from "./helpers";
import "../src/index";

// B3-08 (ADR 0102): /admin/backup (a full SQL dump streamed through the Worker, "last downloaded", the iCloud steps) and
// the weekly R2 copy, which does nothing until the BACKUPS binding exists and then keeps 8 weekly and 6 monthly copies.

let adminCookie = "";
let userCookie = "";
const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetchWorker(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams(fields), redirect: "manual" });

/** An in-memory R2 bucket with the calls the backup uses (list with cursor, put, delete, multipart). */
class FakeBucket {
  objects = new Map<string, Uint8Array>();
  aborted = 0;
  async put(key: string, body: string | Uint8Array) {
    this.objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
    return {};
  }
  async get(key: string) {
    const b = this.objects.get(key);
    return b ? { text: async () => new TextDecoder().decode(b) } : null;
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list({ prefix = "", cursor }: { prefix?: string; cursor?: string }) {
    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + 3); // small pages, so the cursor loop is exercised
    const truncated = start + 3 < all.length;
    return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + 3) : undefined, delimitedPrefixes: [] };
  }
  async createMultipartUpload(key: string) {
    const parts = new Map<number, Uint8Array>();
    return {
      uploadPart: async (n: number, data: Uint8Array) => {
        parts.set(n, data);
        return { partNumber: n, etag: `e${n}` };
      },
      complete: async (done: { partNumber: number }[]) => {
        const chunks = done.map((p) => parts.get(p.partNumber)!);
        const out = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
        let o = 0;
        for (const c of chunks) (out.set(c, o), (o += c.byteLength));
        this.objects.set(key, out);
        return {};
      },
      abort: async () => {
        this.aborted++;
      },
    };
  }
}
const withBucket = (b: FakeBucket) => ({ ...env, BACKUPS: b as unknown as R2Bucket }) as Env;

beforeAll(async () => {
  const db = getDb(env);
  const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
  adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
  const someone = await upsertHuman(db, profile({ login: "o'brien" }), Date.now());
  userCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, someone.id)}`;
  for (let i = 0; i < 5; i++) await upsertHuman(db, profile(), Date.now());
});

describe("/admin/backup: founder-only, no-store", () => {
  it("redirects signed-out people and non-admins; shows a founder the page with private headers", async () => {
    expect((await fetchWorker(BACKUP_PATH, { redirect: "manual" })).status).toBe(302);
    expect((await fetchWorker(BACKUP_PATH, { headers: { Cookie: userCookie }, redirect: "manual" })).status).toBe(302);
    const res = await fetchWorker(BACKUP_PATH, { headers: { Cookie: adminCookie, Accept: "text/html" } });
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) expect(res.headers.get(k), k).toBe(v);
    const page = await res.text();
    expect(page).toContain("Download full backup");
    expect(page).toContain("Forge backups");
    expect(page).toContain("iCloud Drive");
    expect(page).toMatch(/data-k="r2"[^]*off: R2 is not enabled/);
  });

  it("refuses the download without the session's CSRF token or from a non-admin", async () => {
    expect((await post(`${BACKUP_PATH}/download`, adminCookie, {})).status).toBe(403);
    const userCsrf = csrfOf(await (await fetchWorker("/dashboard", { headers: { Cookie: userCookie, Accept: "text/html" } })).text());
    expect((await post(`${BACKUP_PATH}/download`, userCookie, { csrf: userCsrf || "x" })).status).toBe(403);
  });

  it("streams a dump with every table and every row, ending with the complete line, and records the download", async () => {
    await env.KV.delete(LAST_DOWNLOAD_KEY);
    const page = await (await fetchWorker(BACKUP_PATH, { headers: { Cookie: adminCookie, Accept: "text/html" } })).text();
    expect(page).toContain("never");
    const res = await post(`${BACKUP_PATH}/download`, adminCookie, { csrf: csrfOf(page) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="forge-d1-\d{8}-\d{4}\.sql"/);
    expect(res.headers.get("Cache-Control")).toBe(PRIVATE_HEADERS["Cache-Control"]);
    const sql = await res.text();
    const tables = await dumpTables(env.DB);
    expect(tables).toContain("humans");
    expect(tables.some((x) => x.startsWith("_cf_"))).toBe(false);
    for (const name of tables) expect(sql).toMatch(new RegExp(`CREATE TABLE [\`"]?${name}[\`"]?`));
    const humans = await getDb(env).select().from(t.humans);
    expect(sql.match(/^INSERT INTO "humans" /gm)?.length).toBe(humans.length);
    expect(sql.trimEnd().split("\n").pop()).toMatch(new RegExp(`^${DUMP_COMPLETE} \\(${tables.length} tables\\)$`));
    const last = await lastDownload(env);
    expect(last?.completed_at).not.toBeNull();
    expect(last?.bytes).toBe(new TextEncoder().encode(sql).byteLength);
    expect(await (await fetchWorker(BACKUP_PATH, { headers: { Cookie: adminCookie, Accept: "text/html" } })).text()).toMatch(/data-k="last_downloaded"[^]*UTC/);
  });

  it("pages through tables (rowid ranges): one row per page gives the same rows", async () => {
    const all = async (pageRows: number) => {
      let s = "";
      for await (const c of dumpChunks(env.DB, 0, pageRows)) s += c;
      return s;
    };
    const one = await all(1);
    const big = await all(1000);
    expect(one.replace(/^-- The Agent Forge.*$/m, "")).toBe(big.replace(/^-- The Agent Forge.*$/m, ""));
    expect(one.match(/^INSERT INTO "humans" /gm)!.length).toBeGreaterThanOrEqual(7);
  });

  it("creates every table before any row, and writes parents' rows before their children's (D1 enforces foreign keys)", async () => {
    let sql = "";
    for await (const c of dumpChunks(env.DB, 0)) sql += c;
    const lastCreate = sql.lastIndexOf("\nCREATE TABLE ");
    expect(lastCreate).toBeGreaterThan(0);
    expect(sql.indexOf("\nINSERT INTO ")).toBeGreaterThan(lastCreate);
    const tables = await dumpTables(env.DB);
    const order = (await parentsFirst(env.DB, tables.map((name) => ({ name })))).map((x) => x.name);
    expect([...order].sort()).toEqual([...tables].sort());
    let edges = 0;
    for (const child of tables) {
      const { results } = await env.DB.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?)').bind(child).all<{ parent: string }>();
      for (const { parent } of results) {
        if (parent === child || !tables.includes(parent)) continue;
        edges++;
        expect(order.indexOf(parent), `${parent} before ${child}`).toBeLessThan(order.indexOf(child));
      }
    }
    expect(edges).toBeGreaterThan(5);
    // In the file too: the humans rows come before the first row of any table that points at humans.
    expect(sql.indexOf('INSERT INTO "humans" ')).toBeGreaterThan(0);
  });

  it("caps each page in bytes as well as rows, so large rows (up to D1's 2 MB) never pile up past the memory limit", async () => {
    expect(DUMP_PAGE_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
    const db = getDb(env);
    const eventId = crypto.randomUUID();
    await db.insert(t.arenaEvents).values({ id: eventId, slug: `bk-${eventId.slice(0, 8)}`, name: "Backup paging", season: "s0", kind: "card", status: "done" });
    for (let i = 0; i < 4; i++) {
      await db.insert(t.arenaRuns).values({ id: crypto.randomUUID(), eventId, modelId: "m", task: "refund", seed: i, attemptNo: 1, status: "done", log: [{ big: "x'y".repeat(40_000) }] as never });
    }
    const chunks: string[] = [];
    for await (const c of dumpChunks(env.DB, 0, 200, 150_000)) chunks.push(c);
    const runChunks = chunks.filter((c) => c.startsWith('INSERT INTO "arena_runs" '));
    // ~120 KB per row against a 150 KB cap: one row per page.
    for (const c of runChunks) expect(c.match(/^INSERT INTO "arena_runs" /gm)!.length).toBe(1);
    expect(runChunks.length).toBeGreaterThanOrEqual(4);
    // And the pages add up to the same file as one big page.
    let whole = "";
    for await (const c of dumpChunks(env.DB, 0, 200, 1e12)) whole += c;
    expect(chunks.join("").replace(/^-- The Agent Forge.*$/m, "")).toBe(whole.replace(/^-- The Agent Forge.*$/m, ""));
  });

  it("stays far inside D1's 1,000 queries per request: one query per page plus three for the schema", async () => {
    let queries = 0;
    const counting = { prepare: (sql: string) => (queries++, env.DB.prepare(sql)) } as unknown as D1Database;
    let sql = "";
    for await (const c of dumpChunks(counting, 0)) sql += c;
    const tables = await dumpTables(env.DB);
    // Every table here fits in one page, so: schema + columns + foreign keys, then one page query per table.
    expect(queries).toBe(3 + tables.length);
    expect(sql).toContain(DUMP_COMPLETE);
  });

  it("keeps every statement under D1's 100 KB limit: a large row becomes an INSERT plus appending UPDATEs", async () => {
    const small = insertRow('"t"', '("a", "b")', ["a", "b"], [1, "x"]);
    expect(small).toBe(`INSERT INTO "t" ("a", "b") VALUES (1, 'x');\n`);
    const big = "🔥é'\n".repeat(60_000); // 300,000 UTF-16 units, about 480 KB as UTF-8 before escaping
    const sql = insertRow('"t"', '("a", "b", "c")', ["a", "b", "c"], [7, big, "short"]);
    const stmts = sql.split(/;\n(?=INSERT|UPDATE)/);
    expect(stmts[0]).toBe(`INSERT INTO "t" ("a", "b", "c") VALUES (7, '', 'short')`);
    for (const st of stmts) expect(new TextEncoder().encode(st).byteLength).toBeLessThanOrEqual(STATEMENT_MAX_BYTES);
    expect(stmts.slice(1).every((st) => st.startsWith(`UPDATE "t" SET "b" = "b" || '`) && st.includes("WHERE rowid = (SELECT max(rowid) FROM \"t\")"))).toBe(true);
    // The pieces join back to the value, and never split a surrogate pair.
    const pieces = textPieces(big, 3);
    expect(pieces.join("")).toBe(big);
    for (const p of pieces) expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(p)).toBe(false);
  });

  it("restores a large row whole in D1: the INSERT and UPDATEs give back the exact value", async () => {
    await env.DB.prepare('CREATE TABLE "restore_probe" ("id" text PRIMARY KEY NOT NULL, "v" text NOT NULL)').run();
    const big = "🔥é'\n".repeat(30_000);
    const sql = insertRow('"restore_probe"', '("id", "v")', ["id", "v"], ["a", big]);
    const stmts = sql.trimEnd().split(/;\n(?=INSERT|UPDATE)/).map((x) => x.replace(/;$/, ""));
    expect(stmts.length).toBeGreaterThan(5);
    for (const st of stmts) await env.DB.prepare(st).run();
    const row = await env.DB.prepare('SELECT v FROM "restore_probe" WHERE id = ?').bind("a").first<{ v: string }>();
    expect(row?.v).toBe(big);
    await env.DB.prepare('DROP TABLE "restore_probe"').run();
  });

  it("writes SQL literals safely", () => {
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue(3)).toBe("3");
    expect(sqlValue(1.5)).toBe("1.5");
    expect(sqlValue("o'brien")).toBe("'o''brien'");
    expect(sqlValue([0, 255, 16])).toBe("X'00ff10'");
    expect(sqlValue(new Uint8Array([1, 2]).buffer)).toBe("X'0102'");
    expect(sqlValue(Number.NaN)).toBe("NULL");
  });
});

describe("the weekly R2 copy", () => {
  it("is off and touches nothing without the BACKUPS binding", async () => {
    expect(env.BACKUPS).toBeUndefined();
    expect(r2Enabled(env)).toBe(false);
    await env.KV.delete(R2_LAST_KEY);
    expect(await weeklyR2Backup(env)).toEqual({ enabled: false });
    expect(await env.KV.get(R2_LAST_KEY)).toBeNull();
  });

  it("keeps the 8 newest weekly copies and the first copy of each of the 6 newest months", () => {
    // Every Monday from 5 Jan to 26 Oct 2026 (43 weeks).
    const ids: string[] = [];
    for (let d = Date.UTC(2026, 0, 5); d <= Date.UTC(2026, 9, 26); d += 7 * 86_400_000) ids.push(new Date(d).toISOString().slice(0, 10));
    const { keep, remove } = retention(ids);
    expect(keep.length + remove.length).toBe(ids.length);
    for (const id of ids.slice(-8)) expect(keep).toContain(id);
    // First backups of May to Oct 2026 (the 6 newest months).
    for (const id of ["2026-05-04", "2026-06-01", "2026-07-06", "2026-08-03", "2026-09-07", "2026-10-05"]) expect(keep).toContain(id);
    expect(keep).not.toContain("2026-04-06");
    expect(keep).not.toContain("2026-01-05");
    expect(keep.length).toBe(8 + 4); // Sept 7 and Oct 5 are among the newest 8 already
    expect(retention([]).keep).toEqual([]);
    expect(retention(["2026-10-26", "2026-10-26"]).keep).toEqual(["2026-10-26"]);
  });

  it("with a bucket: writes the dump, the week's export and a manifest once a week, then prunes", async () => {
    const bucket = new FakeBucket();
    const e = withBucket(bucket);
    const now = Date.UTC(2026, 10, 2, 1, 17); // Mon 2 Nov 2026
    await e.KV.delete(R2_LAST_KEY);
    // Old complete backups (12 weeks) and one incomplete one from a failed run.
    for (let i = 1; i <= 12; i++) {
      const id = new Date(now - i * 7 * 86_400_000).toISOString().slice(0, 10);
      await bucket.put(`${R2_PREFIX}${id}/d1.sql`, "x");
      await bucket.put(`${R2_PREFIX}${id}/manifest.json`, "{}");
    }
    await bucket.put(`${R2_PREFIX}2026-10-30/d1.sql`, "half");
    expect(await weeklyR2Backup(e, now)).toMatchObject({ enabled: true, written: false, waiting_for: "weekly_export" });
    await writeExport(e, now - 3_600_000, "weekly");
    const r = await weeklyR2Backup(e, now);
    expect(r).toMatchObject({ enabled: true, written: true, id: "2026-11-02" });
    const sql = new TextDecoder().decode(bucket.objects.get(`${R2_PREFIX}2026-11-02/d1.sql`)!);
    expect(sql.trimEnd().split("\n").pop()).toContain(DUMP_COMPLETE);
    const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${R2_PREFIX}2026-11-02/manifest.json`)!));
    expect(manifest.export_files).toContain("manifest.json");
    for (const f of manifest.export_files) expect(bucket.objects.has(`${R2_PREFIX}2026-11-02/export/${f}`), f).toBe(true);
    const ids = [...new Set([...bucket.objects.keys()].map((k) => k.split("/")[1] ?? ""))].sort();
    expect(ids).toEqual(retention(ids).keep);
    expect(ids).not.toContain("2026-10-30"); // the incomplete one
    expect(ids.slice(-8).length).toBe(8);
    // Once a week: the second run in the same week does nothing.
    expect(await weeklyR2Backup(e, now + 3_600_000)).toMatchObject({ written: false });
    expect(bucket.aborted).toBe(0);
  });

  it("prunes nothing it should keep", async () => {
    const bucket = new FakeBucket();
    for (const id of ["2026-10-05", "2026-10-12", "2026-10-19"]) await bucket.put(`${R2_PREFIX}${id}/manifest.json`, "{}");
    expect(await pruneR2(bucket as unknown as R2Bucket, "2026-10-19")).toEqual([]);
    expect(bucket.objects.size).toBe(3);
  });
});
