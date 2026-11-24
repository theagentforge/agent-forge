// Page snapshots and burst protection (13 Nov audit; ADR 0154).
//
// The 13 Nov walkthrough measured 4.7-9.7 s to first byte on "/" and 4-8 s on /security, /benchmark, /dataset, /arena
// and the trap pages. Each of those pages makes many D1 reads (the home page 42 statements in 12 sequential waves,
// /dataset 31, /stats 22), and D1 is one database in one region that runs one query at a time. The edge cache
// (web/edge-cache.ts) only helped in the data centre that already held a copy, so a visitor anywhere else, or anyone
// after a release, waited for the full render. A burst of ~260 requests then made every one of them render at once:
// D1 answered "overloaded", the error reached Hono's default handler, and visitors got HTTP 500.
//
// This layer adds, for anonymous visitors only:
//   1. a snapshot of each heavy page in KV (global, read in tens of milliseconds anywhere), written by the hourly cron
//      and by any live render that found none, refreshed in the background when older than its window;
//   2. one live render per page at a time in each isolate (later requests for the same page wait for it and get the
//      same answer), and at most MAX_LIVE_RENDERS heavy renders at once per isolate;
//   3. overload answered with the newest snapshot, or HTTP 429 with Retry-After, never 500 (index.ts onError too).
// A request with the session cookie never reads or writes a snapshot (web/pages.ts viewerBound).

import { HTTPException } from "hono/http-exception";
import { pinnedLineKeys } from "../arena/hero-proof";

/**
 * The Worker's error handler (index.ts app, api.ts protectedApi): an overload (D1 "overloaded", a busy KV, a lost
 * connection) is 429 with Retry-After; Hono's own HTTP errors keep their response; anything else is a logged 500.
 */
export function onWorkerError(err: Error, c: { req: { path: string; header: (name: string) => string | undefined } }): Response {
  if (err instanceof HTTPException) return err.getResponse();
  if (isOverload(err)) {
    console.warn("overloaded", c.req.path.slice(0, 80), String(err?.message ?? err).slice(0, 160));
    return overloaded(c.req.path, c.req.header("Accept"));
  }
  console.error("unhandled_error", c.req.path.slice(0, 80), String(err?.stack ?? err).slice(0, 500));
  return c.req.path.startsWith("/api/")
    ? new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
    : new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Pages kept as KV snapshots (HTML, JSON and Markdown variants alike, each its own key). Exact paths or patterns. */
export const SNAPSHOT_PAGES: RegExp[] = [
  /^\/$/,
  /^\/security$/,
  /^\/benchmark$/,
  /^\/dataset$/,
  /^\/stats$/,
  /^\/arena$/,
  /^\/arena\/methodology$/,
  /^\/arena\/failures$/,
  /^\/arena\/failures\/[A-Za-z]+-[A-Za-z]+-[0-9]+$/,
  /^\/trap-card$/,
];
/** Off in most tests (test/apply-migrations.ts), so a test that adds rows reads the page straight back. */
export const pageSnapshots = { enabled: true };
export const isSnapshotPage = (path: string) => pageSnapshots.enabled && SNAPSHOT_PAGES.some((re) => re.test(path));

/** The pages the hourly cron renders ahead of any visitor (the home page once per backed headline line). */
export const CRON_PAGES = ["/", "/security", "/benchmark", "/dataset", "/stats", "/arena", "/arena/methodology", "/arena/failures", "/trap-card"];

/** A snapshot is kept this long in KV; past it, the page renders live again. */
export const SNAPSHOT_TTL_SECONDS = 6 * 3600;
/** A served snapshot older than this starts one background re-render. */
export const SNAPSHOT_REFRESH_SECONDS = 300;
/** A background re-render rewrites the KV copy only when it is at least this old (KV writes cost; the cron forces). */
export const SNAPSHOT_REWRITE_SECONDS = 600;
/** Heavy live renders allowed at once in one isolate; past it a visitor gets a snapshot, or 429. */
export const MAX_LIVE_RENDERS = 6;
/** What a 429 for overload asks the client to wait. */
export const RETRY_AFTER_SECONDS = 5;
export const SNAPSHOT_HEADER = "X-Page-Snapshot";

const KEY_PREFIX = "snap:v1:";
/**
 * Query parameters a snapshot may carry, with the values each page really reads (review, 13 Nov: any other parameter
 * made a new key, so `?x=1`, `?x=2`... each cost a live render and a KV write). `__release` (the release key) and
 * `format` (json or md) apply to every page; `hero` (the home headline line, picked by the middleware) only to "/";
 * `tier` only where the page reads it. Anything else, or another value, gets no snapshot (the edge cache still applies).
 */
const ANY_PAGE: Record<string, RegExp> = { __release: /^[A-Za-z0-9._-]{1,120}$/, format: /^(json|md)$/ };
const PAGE_PARAMS: [RegExp, Record<string, RegExp>][] = [
  [/^\/$/, { hero: /^[a-z0-9_-]{1,40}$/ }],
  [/^\/arena$/, { tier: /^hard$/ }],
  [/^\/arena\/failures(\/.*)?$/, { tier: /^(normal|hard|frontier)$/ }],
];
const allowedParams = (path: string) => ({ ...ANY_PAGE, ...(PAGE_PARAMS.find(([re]) => re.test(path))?.[1] ?? {}) });

/** The KV key for a page's cache key (path, release and variant), or null when its query isn't on the allow-list. */
export const snapshotKey = (cacheKeyUrl: string): string | null => {
  const u = new URL(cacheKeyUrl);
  const allowed = allowedParams(u.pathname);
  const seen = new Set<string>();
  for (const [k, v] of u.searchParams) {
    if (seen.has(k) || !allowed[k]?.test(v)) return null;
    seen.add(k);
  }
  return `${KEY_PREFIX}${u.pathname}${u.search}`.slice(0, 500);
};

/** Response headers a snapshot keeps (security headers, type, links, the page's own cache rule and markers). */
const DROP = new Set(["set-cookie", "content-length", "content-encoding", "transfer-encoding", "date", "x-edge-cache"]);

export interface Snapshot {
  at: number;
  status: number;
  headers: [string, string][];
  body: string;
}

/** Only an anonymous, public, cookie-free 200 is ever kept. */
export const snapshotable = (res: Response) =>
  res.status === 200 && !res.headers.has("Set-Cookie") && /^(public|no-store)/.test(res.headers.get("Cache-Control") ?? "") && !/private/.test(res.headers.get("Cache-Control") ?? "");

export async function readSnapshot(env: Pick<Env, "KV">, key: string): Promise<Snapshot | null> {
  try {
    const s = await env.KV.get<Snapshot>(key, "json");
    return s && typeof s.at === "number" && typeof s.body === "string" && Array.isArray(s.headers) ? s : null;
  } catch {
    return null;
  }
}

export async function writeSnapshot(env: Pick<Env, "KV">, key: string, res: Response, now = Date.now()) {
  const body = await res.text();
  const headers = [...res.headers].filter(([k]) => !DROP.has(k.toLowerCase()));
  const snap: Snapshot = { at: now, status: res.status, headers, body };
  // KV allows one write a second per key; a lost race keeps the other writer's copy, which is as new.
  await env.KV.put(key, JSON.stringify(snap), { expirationTtl: SNAPSHOT_TTL_SECONDS }).catch((e) => console.error("snapshot_write_failed", String(e).slice(0, 120)));
  return body;
}

/** The response for a stored snapshot: its own headers, plus how old it is. */
export function fromSnapshot(s: Snapshot, now = Date.now()) {
  const headers = new Headers(s.headers);
  const age = Math.max(0, Math.floor((now - s.at) / 1000));
  headers.set(SNAPSHOT_HEADER, `age=${age}`);
  // A browser never keeps a snapshot longer than the page's own rule allowed, counted from when it was rendered.
  const cc = headers.get("Cache-Control") ?? "";
  const m = /max-age=(\d+)/.exec(cc);
  if (m) headers.set("Cache-Control", cc.replace(/max-age=\d+/, `max-age=${Math.max(0, Number(m[1]) - age)}`));
  return new Response(s.body, { status: s.status, headers });
}

/** True for the D1 / KV / platform errors that mean "too busy", which become 429 rather than 500. */
export function isOverload(e: unknown): boolean {
  // Drizzle wraps the binding's error ("Failed query: ...", the D1 error as its `cause`), so the chain is read.
  for (let x: unknown = e, i = 0; x && i < 5; x = (x as { cause?: unknown }).cause, i++) {
    const msg = String((x as { message?: unknown })?.message ?? x);
    // Not every D1_ERROR: a bad query ("no such column") stays a 500, so a bug is never hidden as "busy".
    if (/D1 DB|overloaded|too many requests|requests queued|SQLITE_BUSY|database is locked|Network connection lost|storage operation exceeded|exceeded timeout|reset because|KV (GET|PUT) failed/i.test(msg)) return true;
  }
  return false;
}

/** The overload answer: JSON for agents and API paths, a short page for people. Never cached. */
export function overloaded(path: string, accept: string | null | undefined) {
  const headers = { "Retry-After": String(RETRY_AFTER_SECONDS), "Cache-Control": "no-store" };
  if (path.startsWith("/api/") || path.startsWith("/mcp") || (accept ?? "").includes("application/json"))
    return new Response(JSON.stringify({ error: "busy", retry_after_seconds: RETRY_AFTER_SECONDS }), { status: 429, headers: { ...headers, "Content-Type": "application/json" } });
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Busy - The Agent Forge</title><p>The Agent Forge is very busy right now. Please try again in ${RETRY_AFTER_SECONDS} seconds.</p>`,
    { status: 429, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
  );
}

/** Live render bookkeeping for one isolate (read by tests). */
export const renderStats = { live: 0, coalesced: 0, shed: 0 };
interface Shared {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}
const inFlight = new Map<string, Promise<Shared | null>>();

/**
 * One live render per key at a time: the first request renders, the rest wait for it and get the same answer (a
 * thundering herd on a cold page became one render, not 260). Past MAX_LIVE_RENDERS different heavy pages at once,
 * `shed` answers instead (429). A response that set a cookie, or a render that failed, is never shared: a waiting
 * request then renders for itself (within the same limit).
 */
export async function singleFlight(key: string, render: () => Promise<Response>, shed: () => Promise<Response>): Promise<Response> {
  const running = inFlight.get(key);
  if (running) {
    renderStats.coalesced++;
    const s = await running;
    if (s) return new Response(s.body.slice(0), { status: s.status, headers: s.headers });
  }
  if (renderStats.live >= MAX_LIVE_RENDERS) {
    renderStats.shed++;
    return shed();
  }
  let resolve!: (s: Shared | null) => void;
  inFlight.set(key, new Promise((r) => (resolve = r)));
  renderStats.live++;
  try {
    const res = await render();
    const body = await res.arrayBuffer();
    const shared: Shared = { status: res.status, headers: [...res.headers].filter(([k]) => k.toLowerCase() !== "set-cookie"), body };
    resolve(res.headers.has("Set-Cookie") || res.status >= 500 ? null : shared);
    return new Response(body, res);
  } catch (e) {
    resolve(null);
    throw e;
  } finally {
    renderStats.live--;
    inFlight.delete(key);
  }
}

const refreshMarks = new WeakMap<Request, { force: boolean }>();
/** Marks an in-process request as a snapshot re-render (counted nowhere; `force` rewrites KV whatever its age). */
export const markSnapshotRender = (req: Request, force = false) => {
  refreshMarks.set(req, { force });
  return req;
};
export const snapshotRenderOf = (req: Request) => refreshMarks.get(req) ?? null;

const refreshing = new Set<string>();
/** Re-renders one page in the background (at most one per key per isolate); the middleware writes the snapshot. */
export async function refreshSnapshot(cacheKeyUrl: string, accept: string | null, render: (req: Request) => Response | Promise<Response>) {
  if (refreshing.has(cacheKeyUrl)) return;
  refreshing.add(cacheKeyUrl);
  try {
    const res = await render(markSnapshotRender(new Request(cacheKeyUrl, { headers: accept ? { Accept: accept } : {} })));
    await res.body?.cancel();
  } catch (e) {
    console.error("snapshot_refresh_failed", String(e).slice(0, 200));
  } finally {
    refreshing.delete(cacheKeyUrl);
  }
}

/**
 * Hourly cron (index.ts): renders every CRON_PAGES page in-process and writes its snapshot, the home page once per
 * backed headline line. One page at a time, so the cron never adds a burst of its own.
 */
export async function writePageSnapshots(env: Env, render: (req: Request) => Promise<Response>) {
  const urls: string[] = [];
  const lines = await pinnedLineKeys(env).catch(() => [] as string[]);
  for (const p of CRON_PAGES) {
    if (p === "/" && lines.length) for (const l of lines) urls.push(`${env.PUBLIC_ORIGIN}/?hero=${encodeURIComponent(l)}`);
    else urls.push(`${env.PUBLIC_ORIGIN}${p}`);
  }
  const out = { pages: urls.length, written: 0, failed: 0 };
  for (const u of urls) {
    try {
      const res = await render(markSnapshotRender(new Request(u), true));
      if (res.headers.get(SNAPSHOT_HEADER) === "written") out.written++;
      else out.failed++;
      await res.body?.cancel();
    } catch (e) {
      out.failed++;
      console.error("snapshot_cron_failed", u.slice(0, 80), String(e).slice(0, 120));
    }
  }
  return out;
}
