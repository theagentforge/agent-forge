import { TRAP_SET } from "../arena/benchmark";
// Stale-while-revalidate for the slow public pages (build list 4 Nov, item 13; ADR 0125).
//
// The site middleware (web/pages.ts) keeps public pages in caches.default. The Cache API has no stale-while-revalidate:
// a copy is dropped at its max-age, and the next visitor waits for a full render (2-5 s on the home page, Arena event
// pages, reports and the press page in the 4 Nov audit). For the pages listed in SWR_PAGES the middleware instead:
//   1. stores the copy with the time it was rendered (RENDERED_AT) and keeps it for its fresh window plus STALE_SECONDS;
//   2. serves a copy younger than the page's fresh window as is;
//   3. serves an older copy at once, and re-renders it in the background (ctx.waitUntil), one refresh per page at a
//      time (an in-memory set per isolate, plus a 30-second lock entry in the same cache for the data centre);
//   4. past the stale window the copy is gone (or ignored), and the page renders as usual.
// Only anonymous 200 responses marked `public` are stored; a request with a session cookie never reads or stores a
// page (web/pages.ts). Counters run in the middleware before any of this, so cached copies count as before. A
// background refresh is not a visit: its request is marked (isRefresh) and counts nothing.

/** Path pattern and fresh window (seconds), from how often each page's data changes. Pages only, no file extensions. */
export const SWR_PAGES: [RegExp, number][] = [
  // The home page and the Arena front page: live totals, the Wire and the latest bouts.
  [/^\/$/, 60],
  [/^\/arena$/, 60],
  // An event's bouts and falls change only when a bout in it finishes; the benchmark when a ranked bout does.
  [/^\/arena\/event\/[^/.]+(\/falls)?$/, 300],
  [/^\/benchmark$/, 300],
  // Reports (live previews and nightly runs) and the press page.
  [/^\/reports\/[^.]+$/, 3600],
  [/^\/press\/[^.]+$/, 3600],
];

/**
 * The release a cached page belongs to (diligence review, 7 Nov): the deployed Worker version's id, which Workers Builds
 * changes on every deploy, plus the Trap Set version for builds without one (local and tests). It is part of every
 * page's cache key (RELEASE_PARAM), so after a release no page, /benchmark and /benchmark/validity included, is served
 * from the previous release's copy, fresh or stale; old copies are simply never looked up again and age out.
 */
export const RELEASE_PARAM = "__release";
export function releaseKey(env: { CF_VERSION_METADATA?: { id?: string } }, trapSet: string) {
  const id = env.CF_VERSION_METADATA?.id;
  return `${typeof id === "string" && id ? id : "local"}.ts${trapSet}`;
}

/** A page's cache key for this release (what the site middleware stores it under). */
export function releaseCacheUrl(env: { CF_VERSION_METADATA?: { id?: string } }, url: string) {
  const u = new URL(url);
  u.searchParams.set(RELEASE_PARAM, releaseKey(env, TRAP_SET.version));
  return u.toString();
}

/**
 * Drops this data centre's cached copies of these pages: the copy under this release's key, and the plain address
 * (share images and receipt badges, which keep their own keys). Every purge after a hide, revoke or claim goes here.
 */
export async function purgePages(env: { CF_VERSION_METADATA?: { id?: string } }, urls: string[]) {
  await Promise.all(urls.flatMap((u) => [u, releaseCacheUrl(env, u)]).map((u) => caches.default.delete(new Request(u)).catch(() => false)));
}

/** How long past its fresh window a copy may still be served while a new one renders. */
export const STALE_SECONDS = 86_400;
export const RENDERED_AT = "X-Rendered-At";
/** The Cache-Control the page itself sent (the stored copy carries a longer one for the edge). */
const ORIGINAL_CC = "X-Page-Cache-Control";
/** What a visitor gets: fresh (a cached copy), stale (a cached copy, refreshing) or miss. */
export const CACHE_STATE = "X-Edge-Cache";
const LOCK_SECONDS = 30;

export const swrFreshSeconds = (path: string) => SWR_PAGES.find(([re]) => re.test(path))?.[1] ?? null;

/** Background refreshes started in this isolate (read by test/edge-cache.test.ts). */
export const edgeCacheStats = { refreshes: 0 };

const refreshes = new WeakSet<Request>();
/** True for the in-process request of a background refresh: the middleware counts nothing for it. */
export const isRefresh = (req: Request) => refreshes.has(req);

/** The copy to store: the page's own response, kept at the edge for its fresh window plus the stale window. */
export function forStore(res: Response, fresh: number, now = Date.now()) {
  const out = new Response(res.body, res);
  out.headers.set(ORIGINAL_CC, res.headers.get("Cache-Control") ?? "");
  out.headers.set(RENDERED_AT, String(now));
  out.headers.set("Cache-Control", `public, max-age=${fresh + STALE_SECONDS}`);
  return out;
}

/**
 * A stored copy's state, and the response to send for it: the page's own Cache-Control, its max-age counted down by
 * the copy's age (0 once stale), so a browser never keeps a copy longer than the page asked for. Null for a copy
 * stored without a render time (before this layer), which the middleware serves as before.
 */
export function readStored(hit: Response, fresh: number, now = Date.now()) {
  const at = Number(hit.headers.get(RENDERED_AT));
  if (!hit.headers.has(RENDERED_AT) || !Number.isFinite(at)) return null;
  const age = Math.max(0, Math.floor((now - at) / 1000));
  const state = age < fresh ? "fresh" : age < fresh + STALE_SECONDS ? "stale" : "expired";
  const original = hit.headers.get(ORIGINAL_CC) || "public, max-age=60";
  const maxAge = Number(/max-age=(\d+)/.exec(original)?.[1] ?? 60);
  const res = new Response(hit.body, hit);
  res.headers.set("Cache-Control", original.replace(/max-age=\d+/, `max-age=${state === "fresh" ? Math.max(0, maxAge - age) : 0}`));
  res.headers.delete(ORIGINAL_CC);
  res.headers.set(CACHE_STATE, state);
  return { state, res } as const;
}

/** The lock entry's key: under /admin, which the page cache never looks up, so no visitor's URL can read it. */
export const lockKey = (key: Request) => new Request(`${new URL(key.url).origin}/admin/__edge-lock/${encodeURIComponent(key.url)}`);
const inFlight = new Set<string>();

/**
 * Re-renders a stale page in the background, at most one refresh per page at a time. `render` runs the request through
 * the site in-process; its middleware stores the new copy (awaited).
 */
export async function refreshStale(key: Request, accept: string | null, render: (req: Request) => Response | Promise<Response>) {
  if (inFlight.has(key.url)) return;
  inFlight.add(key.url);
  const lock = lockKey(key);
  let locked = false;
  try {
    // Another isolate in this data centre is already refreshing it.
    if (await caches.default.match(lock)) return;
    await caches.default.put(lock, new Response("1", { headers: { "Cache-Control": `public, max-age=${LOCK_SECONDS}` } }));
    locked = true;
    edgeCacheStats.refreshes++;
    // The cache key's own URL (tracking tags already out) and the visitor's Accept, so the middleware works out the
    // same key, renders the same variant (HTML, JSON or Markdown) and stores it.
    const req = new Request(key.url, { headers: accept ? { Accept: accept } : {} });
    refreshes.add(req);
    const res = await render(req);
    await res.body?.cancel();
    // A page that is gone or no longer cacheable (an event held, a page switched to no-store) loses its stale copy;
    // a failure (5xx, 429) keeps it until its window ends.
    const stored = res.status === 200 && (res.headers.get("Cache-Control") ?? "").startsWith("public");
    if (!stored && res.status < 500 && res.status !== 429) await caches.default.delete(key);
  } catch (e) {
    console.error("edge_refresh_failed", String(e).slice(0, 200));
  } finally {
    inFlight.delete(key.url);
    if (locked) await caches.default.delete(lock).catch(() => false);
  }
}
