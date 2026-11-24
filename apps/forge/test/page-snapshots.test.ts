import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CHECK_CACHE_HEADER } from "../src/api";
import { cachedCheckTool, checkCacheKey, checkKvCache } from "../src/services/forge";
import { installTotals } from "../src/services/install-metrics";
import { releaseCacheUrl } from "../src/web/edge-cache";
import {
  CRON_PAGES,
  isOverload,
  MAX_LIVE_RENDERS,
  onWorkerError,
  pageSnapshots,
  readSnapshot,
  renderStats,
  RETRY_AFTER_SECONDS,
  SNAPSHOT_HEADER,
  snapshotKey,
  writePageSnapshots,
} from "../src/web/page-snapshots";
import { SESSION_COOKIE } from "../src/web/session";
import { connectAgent, fetchWorker, fp, ORIGIN, postReport, report } from "./helpers";

// ADR 0154 (13 Nov audit): heavy public pages are served from KV snapshots written by the hourly cron, one live render
// per page at a time, and overload is 429 with Retry-After, never 500.

const OVERLOAD = "D1_ERROR: D1 DB is overloaded. Too many requests queued.";
const keyFor = (path: string) => snapshotKey(releaseCacheUrl(env, `${ORIGIN}${path}`))!;
const BROWSER = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0" };

/** A D1 binding that counts statements, can wait before each one, and can fail some or all of them. */
function wrappedDb(opts: { delayMs?: number; fail?: (sql: string) => boolean; hang?: (sql: string) => Promise<void> | null } = {}) {
  const s = { selects: 0, statements: 0, sql: [] as string[] };
  const stmt = (sql: string, st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function") return v;
        if (prop === "bind") return (...a: unknown[]) => stmt(sql, (v as (...x: unknown[]) => D1PreparedStatement).apply(target, a));
        if (["all", "raw", "run", "first"].includes(String(prop)))
          return async (...a: unknown[]) => {
            s.statements++;
            s.sql.push(sql);
            if (/^\s*select/i.test(sql)) s.selects++;
            const wait = opts.hang?.(sql);
            if (wait) await wait;
            if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
            if (opts.fail?.(sql)) throw new Error(OVERLOAD);
            return (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
          };
        return v.bind(target);
      },
    });
  const db = new Proxy(env.DB, {
    get(target, prop, recv) {
      if (prop === "prepare") return (sql: string) => stmt(sql, target.prepare(sql));
      if (prop === "batch")
        return async (list: D1PreparedStatement[]) => {
          s.statements += list.length;
          if (opts.fail?.("batch")) throw new Error(OVERLOAD);
          return target.batch(list);
        };
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { env: { ...env, DB: db } as Env, s };
}

async function call(e: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, e, ctx);
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { res, body };
}

beforeAll(() => {
  pageSnapshots.enabled = true;
});
afterAll(() => {
  pageSnapshots.enabled = false;
  checkKvCache.enabled = false;
});

describe("KV page snapshots (ADR 0154)", () => {
  it("a heavy page renders live once, then is served from its snapshot with its own headers", async () => {
    await env.KV.delete(keyFor("/benchmark"));
    const first = await call(env, "/benchmark", { headers: BROWSER });
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get(SNAPSHOT_HEADER)).toBeNull();
    const snap = await readSnapshot(env, keyFor("/benchmark"));
    expect(snap?.body).toBe(first.body);
    // Served from KV without a single D1 read for the page: the counting database sees no select before the answer.
    const counted = wrappedDb();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/benchmark`, { headers: BROWSER }) as never, counted.env, ctx);
    expect(counted.s.selects).toBe(0);
    expect(res.status).toBe(200);
    expect(res.headers.get(SNAPSHOT_HEADER)).toMatch(/^age=\d+$/);
    expect(await res.text()).toBe(first.body);
    // /benchmark keeps its no-store rule and its Trap Set and build headers (Boardy, 7 Nov).
    expect(res.headers.get("Cache-Control")).toBe(first.res.headers.get("Cache-Control"));
    expect(res.headers.get("X-Trap-Set-Version")).toBe(first.res.headers.get("X-Trap-Set-Version"));
    expect(res.headers.get("Content-Security-Policy")).toBe(first.res.headers.get("Content-Security-Policy"));
    await waitOnExecutionContext(ctx);
  });

  it("only the bare path and each page's own parameters get a snapshot: ?junk=1 writes no KV key", async () => {
    const rel = (p: string) => releaseCacheUrl(env, `${ORIGIN}${p}`);
    expect(snapshotKey(rel("/stats"))).not.toBeNull();
    expect(snapshotKey(rel("/stats?format=json"))).not.toBeNull();
    expect(snapshotKey(rel("/arena?tier=hard"))).not.toBeNull();
    expect(snapshotKey(rel("/arena/failures?tier=frontier"))).not.toBeNull();
    expect(snapshotKey(rel("/?hero=invoice"))).not.toBeNull();
    for (const p of ["/stats?junk=1", "/stats?format=xml", "/arena?tier=weird", "/security?tier=hard", "/stats?hero=invoice", "/stats?format=json&format=md"])
      expect(snapshotKey(rel(p)), p).toBeNull();
    const before = (await env.KV.list({ prefix: "snap:v1:" })).keys.length;
    const { res } = await call(env, "/stats?junk=1", { headers: BROWSER });
    expect(res.status).toBe(200);
    const keys = (await env.KV.list({ prefix: "snap:v1:" })).keys.map((k) => k.name);
    expect(keys.filter((k) => k.includes("junk"))).toEqual([]);
    expect(keys.length).toBe(before);
  });

  it("a request with the session cookie never reads or writes a snapshot", async () => {
    const key = keyFor("/benchmark");
    await env.KV.put(key, JSON.stringify({ at: Date.now(), status: 200, headers: [["content-type", "text/html; charset=utf-8"]], body: "PLANTED COPY" }));
    const signedIn = await call(env, "/benchmark", { headers: { ...BROWSER, Cookie: `${SESSION_COOKIE}=not-a-real-session` } });
    expect(signedIn.body).not.toContain("PLANTED COPY");
    expect(signedIn.res.headers.get(SNAPSHOT_HEADER)).toBeNull();
    expect((await readSnapshot(env, key))?.body).toBe("PLANTED COPY");
    const anonymous = await call(env, "/benchmark", { headers: BROWSER });
    expect(anonymous.body).toBe("PLANTED COPY");
    await env.KV.delete(key);
  });

  it("the hourly cron writes a snapshot of every listed page, counted as no visit", async () => {
    for (const p of CRON_PAGES) await env.KV.delete(keyFor(p));
    const ctx = createExecutionContext();
    const r = await writePageSnapshots(env, async (req) => worker.fetch(req as never, env, ctx));
    await waitOnExecutionContext(ctx);
    expect(r).toEqual({ pages: CRON_PAGES.length, written: CRON_PAGES.length, failed: 0 });
    for (const p of CRON_PAGES.filter((x) => x !== "/")) expect((await readSnapshot(env, keyFor(p)))?.status, p).toBe(200);
  });

  it("a snapshot is served while D1 is overloaded", async () => {
    const ctx = createExecutionContext();
    await writePageSnapshots(env, async (req) => worker.fetch(req as never, env, ctx));
    await waitOnExecutionContext(ctx);
    const down = wrappedDb({ fail: () => true });
    const { res, body } = await call(down.env, "/benchmark", { headers: BROWSER });
    expect(res.status).toBe(200);
    expect(res.headers.get(SNAPSHOT_HEADER)).toMatch(/^age=/);
    expect(body).toContain("<html");
  });
});

describe("overload is 429 with Retry-After, never 500 (ADR 0154)", () => {
  it("classifies D1's overload errors, and only those, as overload", () => {
    for (const m of [OVERLOAD, "D1 DB is overloaded. Requests queued for too long.", "D1_ERROR: Network connection lost.", "D1 DB storage operation exceeded timeout which caused object to be reset."])
      expect(isOverload(new Error(m)), m).toBe(true);
    for (const m of ["Cannot read properties of undefined", "boom", "D1_ERROR: no such column: x"]) expect(isOverload(new Error(m)), m).toBe(false);
    // Drizzle wraps the binding's error: the cause is read.
    expect(isOverload(new Error("Failed query: select 1", { cause: new Error(OVERLOAD) }))).toBe(true);
    const ctx = { req: { path: "/x", header: () => undefined } };
    expect(onWorkerError(new Error("boom"), ctx).status).toBe(500);
    expect(onWorkerError(new HTTPException(418), ctx).status).toBe(418);
    const busy = onWorkerError(new Error(OVERLOAD), ctx);
    expect([busy.status, busy.headers.get("Retry-After"), busy.headers.get("Cache-Control")]).toEqual([429, String(RETRY_AFTER_SECONDS), "no-store"]);
  });

  it("with every D1 call failing, pages and the check API answer 429 (or a page that copes), never 500", async () => {
    const down = wrappedDb({ fail: () => true });
    const paths = ["/?down=1", "/stats?down=1", "/security?down=1", "/dataset?down=1", "/arena?down=1", "/arena/failures?down=1", "/trap-card?down=1", "/api/v1/check?id=npm:overload-test", "/api/v1/stats"];
    for (const p of paths) {
      const { res } = await call(down.env, p, { headers: { ...BROWSER, "CF-Connecting-IP": "203.0.113.90" } });
      expect(res.status, p).not.toBe(500);
      if (res.status === 429) expect(res.headers.get("Retry-After"), p).toBe(String(RETRY_AFTER_SECONDS));
    }
    const check = await call(down.env, "/api/v1/check?id=npm:overload-test-2", { headers: { "CF-Connecting-IP": "203.0.113.91" } });
    expect(check.res.status).toBe(429);
    expect(JSON.parse(check.body)).toEqual({ error: "busy", retry_after_seconds: RETRY_AFTER_SECONDS });
    const home = await call(down.env, "/?down=2", { headers: BROWSER });
    expect(home.res.status).toBe(429);
    expect(home.res.headers.get("Content-Type")).toContain("text/html");
  });

  it("a burst on a cold page renders it once: 40 concurrent visitors share one render, none gets 500", async () => {
    const slow = wrappedDb({ delayMs: 15 });
    const one = wrappedDb();
    await call(one.env, "/dataset?burst=solo", { headers: BROWSER });
    const before = renderStats.coalesced;
    const results = await Promise.all(Array.from({ length: 40 }, () => call(slow.env, "/dataset?burst=herd", { headers: BROWSER })));
    expect(results.map((r) => r.res.status).every((s) => s === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect(renderStats.coalesced - before).toBeGreaterThanOrEqual(39);
    // One render's reads (plus the snapshot look-ups' none): far below 40 renders' worth.
    expect(slow.s.selects).toBeLessThanOrEqual(one.s.selects + 5);
  });

  it(`past ${MAX_LIVE_RENDERS} different heavy renders at once, the rest get 429 with Retry-After`, async () => {
    const slow = wrappedDb({ delayMs: 40 });
    const results = await Promise.all(Array.from({ length: MAX_LIVE_RENDERS + 4 }, (_, i) => call(slow.env, `/dataset?wide=${i}`, { headers: BROWSER })));
    const statuses = results.map((r) => r.res.status);
    expect(statuses).not.toContain(500);
    expect(statuses.filter((s) => s === 200).length).toBe(MAX_LIVE_RENDERS);
    for (const r of results.filter((x) => x.res.status === 429)) expect(r.res.headers.get("Retry-After")).toBe(String(RETRY_AFTER_SECONDS));
  });
});

describe("checks: a KV copy, and install checks counted on arrival (ADR 0154)", () => {
  it("the same question asked again from another data centre is answered from KV, without D1", async () => {
    checkKvCache.enabled = true;
    const first = await call(env, "/api/v1/check?id=npm:express&version=4.18.2", { headers: { "CF-Connecting-IP": "203.0.113.10" } });
    expect(first.res.headers.get(CHECK_CACHE_HEADER)).toBe("miss");
    // Same question, keys in another order: a different edge-cache entry, the same KV entry.
    const counted = wrappedDb();
    const second = await call(counted.env, "/api/v1/check?version=4.18.2&id=npm:express", { headers: { "CF-Connecting-IP": "203.0.113.11" } });
    expect(second.res.headers.get(CHECK_CACHE_HEADER)).toBe("kv");
    const a = JSON.parse(first.body);
    const b = JSON.parse(second.body);
    expect(b.security_status).toBe(a.security_status);
    expect(b.public_signals_summary).toEqual(a.public_signals_summary);
    // Only the counters touch D1 (the tool-check counter looks the tool up); the check read no version or score.
    expect(counted.s.sql.filter((q) => /from "tool_(versions|scores)"|public_signals/i.test(q))).toEqual([]);
    checkKvCache.enabled = false;
  });

  it("an install-time check is counted before the look-up finishes (a hook that gives up at its timeout still counts)", async () => {
    const before = await installTotals(env);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Every read of the tools table waits until released: the look-up is "slow" for as long as the test likes.
    const slow = wrappedDb({ hang: (sql) => (/from "tools"/i.test(sql) ? gate : null), fail: (sql) => /from "tools"/i.test(sql) });
    const ctx = createExecutionContext();
    const pending = worker.fetch(new Request(`${ORIGIN}/api/v1/check?id=npm:slow-install-check`, { headers: { "User-Agent": "theagentforge-claude-plugin", "CF-Connecting-IP": "203.0.113.20" } }) as never, slow.env, ctx);
    await vi.waitFor(async () => expect((await installTotals(env)).by_client.plugin.all_time.checked).toBe(before.by_client.plugin.all_time.checked + 1), { timeout: 5000, interval: 50 });
    release();
    const res = await pending;
    await res.text();
    await waitOnExecutionContext(ctx);
    // The look-up then failed (overload): the check stays counted once, with no outcome.
    expect(res.status).toBe(429);
    const after = await installTotals(env);
    expect(after.by_client.plugin.all_time.checked).toBe(before.by_client.plugin.all_time.checked + 1);
    expect(after.by_client.plugin.all_time.blocked).toBe(before.by_client.plugin.all_time.blocked);
  });

  it("a filed report drops the kept check results for its tool", async () => {
    checkKvCache.enabled = true;
    const id = "npm:forget-check-test";
    await cachedCheckTool(env, { id });
    await cachedCheckTool(env, { id, version: "1.0.0" });
    expect(await env.KV.get(checkCacheKey({ id }))).not.toBeNull();
    const a = await connectAgent();
    const res = await postReport(a.token, report({ tool: { kind: "mcp_server", id, version: "1.0.0", fingerprint: fp("9") } }));
    expect(res.status).toBeLessThan(300);
    expect(await env.KV.get(checkCacheKey({ id }))).toBeNull();
    expect(await env.KV.get(checkCacheKey({ id, version: "1.0.0" }))).toBeNull();
    checkKvCache.enabled = false;
  });

  it("a check of a known tool takes at most three D1 waves on the critical path", async () => {
    await fetchWorker("/api/v1/check?id=npm:express", { headers: { "CF-Connecting-IP": "203.0.113.30" } });
    const counted = wrappedDb();
    await call(counted.env, "/api/v1/check?id=npm:express&n=waves", { headers: { "CF-Connecting-IP": "203.0.113.31" } });
    // tools + alias (together), versions (together), score/others/aliases (together), plus three counter writes.
    expect(counted.s.statements).toBeLessThanOrEqual(12);
  });
});
