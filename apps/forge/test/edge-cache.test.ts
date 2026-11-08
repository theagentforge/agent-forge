import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRAP_SET } from "../src/arena/benchmark";
import { CACHE_STATE, edgeCacheStats, forStore, lockKey, readStored, refreshStale, RELEASE_PARAM, releaseKey, RENDERED_AT, STALE_SECONDS, swrFreshSeconds } from "../src/web/edge-cache";
import { SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, ORIGIN } from "./helpers";
import "../src/index";

// ADR 0125 (build list 4 Nov, item 13): the slow public pages are served from the edge cache while fresh, served stale
// while one background re-render replaces them, never cached for a signed-in request, and counted on every hit.

const T0 = Date.UTC(2026, 10, 5, 12);
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0";
/** What a real browser sends with a top-level page load from another site. */
const PERSON = { "User-Agent": FIREFOX, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "cross-site", Referer: "https://example.org/" };
let n = 0;
/** A fresh cache key for each test: the home page ignores an unknown parameter. */
const homeUrl = (tag: string) => `/?swr=${tag}-${++n}`;
/** The cache key the middleware uses for a page: its address plus the release it was rendered by. */
const keyUrl = (path: string) => {
  const u = new URL(`${ORIGIN}${path}`);
  u.searchParams.set(RELEASE_PARAM, releaseKey(env, TRAP_SET.version));
  return u.toString();
};
const stored = (path: string) => caches.default.match(new Request(keyUrl(path)));
const renderedAt = async (path: string) => Number((await stored(path))?.headers.get(RENDERED_AT) ?? NaN);
/** Waits for a copy rendered at `at` or later (vi.waitFor moves the faked clock on by its interval while it waits). */
const waitStored = (path: string, at: number) => vi.waitFor(async () => expect(await renderedAt(path)).toBeGreaterThanOrEqual(at), { timeout: 15_000, interval: 50 });
const count = async (key: string) =>
  Number((await env.DB.prepare("select coalesce(sum(n), 0) as n from usage_daily where key = ? and day = ?").bind(key, new Date().toISOString().slice(0, 10)).first<{ n: number }>())?.n ?? 0);
const settle = () => new Promise((r) => setTimeout(r, 300));
/** A planted copy in the cache, as the middleware stores one, rendered at `at`. */
const plant = (path: string, fresh: number, at: number, body = "planted copy") =>
  caches.default.put(new Request(keyUrl(path)), forStore(new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } }), fresh, at));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("which pages, and for how long (ADR 0125)", () => {
  it("lists the slow pages with fresh windows, and leaves files, signed-in pages and the rest out", () => {
    expect(swrFreshSeconds("/")).toBe(60);
    expect(swrFreshSeconds("/arena")).toBe(60);
    expect(swrFreshSeconds("/arena/event/crucible-2-hard")).toBe(300);
    expect(swrFreshSeconds("/arena/event/crucible-2-hard/falls")).toBe(300);
    expect(swrFreshSeconds("/reports/state-of-agent-reliability/2026-q4")).toBe(3600);
    expect(swrFreshSeconds("/press/2026-11")).toBe(3600);
    for (const p of ["/reports/house.json", "/reports/house.csv", "/reports/state-of-agent-reliability/2026-q4.pdf", "/connect", "/dashboard", "/check", "/arena/run/abc", "/og/home.png"])
      expect(swrFreshSeconds(p), p).toBeNull();
  });

  it("a stored copy is fresh, then stale, then expired; browsers get the page's own max-age, counted down", () => {
    const copy = () => forStore(new Response("x", { headers: { "Cache-Control": "public, max-age=60" } }), 60, T0);
    expect(copy().headers.get("Cache-Control")).toBe(`public, max-age=${60 + STALE_SECONDS}`);
    const fresh = readStored(copy(), 60, T0 + 20_000)!;
    expect([fresh.state, fresh.res.headers.get("Cache-Control")]).toEqual(["fresh", "public, max-age=40"]);
    const stale = readStored(copy(), 60, T0 + 61_000)!;
    expect([stale.state, stale.res.headers.get("Cache-Control")]).toEqual(["stale", "public, max-age=0"]);
    expect(readStored(copy(), 60, T0 + (60 + STALE_SECONDS) * 1000)!.state).toBe("expired");
    // A copy stored before this layer (no render time) is left to the plain cache.
    expect(readStored(new Response("x"), 60, T0)).toBeNull();
  });
});

describe("stale-while-revalidate on the home page (ADR 0125)", () => {
  it("a fresh hit is served from the cache as is, to people and scrapers alike, with no re-render", async () => {
    const path = homeUrl("fresh");
    const first = await fetchWorker(path);
    expect(first.status).toBe(200);
    expect(first.headers.get(CACHE_STATE)).toBeNull();
    const body = await first.text();
    await waitStored(path, T0);
    vi.setSystemTime(T0 + 30_000);
    const before = edgeCacheStats.refreshes;
    for (const headers of [PERSON, { "User-Agent": "curl/8.0" }]) {
      const hit = await fetchWorker(path, { headers });
      expect(hit.headers.get(CACHE_STATE)).toBe("fresh");
      // Rendered at the top of a minute, the page asked for 60 s; 30 s later a browser may keep it 30 s more.
      expect(hit.headers.get("Cache-Control")).toBe("public, max-age=30");
      expect(await hit.text()).toBe(body);
    }
    // The JSON twin shares the path and is kept the same way.
    const json = `${path}&format=json`;
    expect(await (await fetchWorker(json)).json()).toHaveProperty("hero");
    await waitStored(json, T0 + 30_000);
    expect((await fetchWorker(json)).headers.get(CACHE_STATE)).toBe("fresh");
    await settle();
    expect(edgeCacheStats.refreshes).toBe(before);
  });

  it("a stale hit serves the old copy at once and starts exactly one background re-render", async () => {
    const path = homeUrl("stale");
    const body = await (await fetchWorker(path)).text();
    await waitStored(path, T0);
    const later = T0 + 5 * 60_000;
    vi.setSystemTime(later);
    const before = edgeCacheStats.refreshes;
    const first = await fetchWorker(path, { headers: PERSON });
    expect(first.headers.get(CACHE_STATE)).toBe("stale");
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=0");
    expect(await first.text()).toBe(body);
    // Visitors right behind it get the old copy too while the one refresh runs (or the new copy once it has).
    for (const hit of await Promise.all([fetchWorker(path), fetchWorker(path)])) {
      expect(["stale", "fresh"]).toContain(hit.headers.get(CACHE_STATE));
      if (hit.headers.get(CACHE_STATE) === "stale") expect(await hit.text()).toBe(body);
      else await hit.body?.cancel();
    }
    // The new copy replaces the old one, rendered now, and the next visitor gets it fresh.
    await waitStored(path, later);
    await settle();
    expect(edgeCacheStats.refreshes).toBe(before + 1);
    expect((await fetchWorker(path)).headers.get(CACHE_STATE)).toBe("fresh");
    expect(edgeCacheStats.refreshes).toBe(before + 1);
  });

  it("past the stale window the page renders as usual and is stored again", async () => {
    const path = homeUrl("expired");
    await plant(path, 60, T0 - (60 + STALE_SECONDS + 10) * 1000);
    const res = await fetchWorker(path);
    expect(res.headers.get(CACHE_STATE)).toBeNull();
    expect(await res.text()).not.toBe("planted copy");
    await waitStored(path, T0);
  });

  it("never serves or stores a page for a request with a session cookie", async () => {
    const cookie = { Cookie: `${SESSION_COOKIE}=any.value` };
    // A cached copy exists, but the signed-in request renders its own page.
    const planted = homeUrl("cookie-planted");
    await plant(planted, 60, T0);
    const res = await fetchWorker(planted, { headers: cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get(CACHE_STATE)).toBeNull();
    expect(await res.text()).not.toBe("planted copy");
    // And what it rendered is never stored, on a stale-while-revalidate page or any other public one.
    for (const path of [homeUrl("cookie"), `/about?swr=cookie-${++n}`]) {
      expect((await fetchWorker(path, { headers: cookie })).status).toBe(200);
      await settle();
      expect(await stored(path), path).toBeUndefined();
    }
    // Without the cookie, the same page is stored as usual.
    const anon = homeUrl("anon");
    await (await fetchWorker(anon, { headers: { Cookie: "theme=dark" } })).text();
    await waitStored(anon, T0);
  });

  it("counts visits, link tags and AI agents on fresh and stale hits, and the re-render counts nothing", async () => {
    const path = homeUrl("count");
    await (await fetchWorker(path)).text();
    await waitStored(path, T0);
    const tag = `visit:tag:swr${n}`;
    const tagged = `${path}&from=swr${n}`;
    const [tags0, ai0] = [await count(tag), await count("ai:live:openai")];
    const fresh = await fetchWorker(tagged, { headers: PERSON });
    expect(fresh.headers.get(CACHE_STATE)).toBe("fresh");
    const agent = await fetchWorker(path, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ChatGPT-User/1.0)" } });
    expect(agent.headers.get(CACHE_STATE)).toBe("fresh");
    await vi.waitFor(async () => expect([await count(tag), await count("ai:live:openai")]).toEqual([tags0 + 1, ai0 + 1]), { timeout: 5000, interval: 50 });
    // A stale hit counts the same; the background re-render it starts adds no page view of its own.
    const later = T0 + 2 * 60_000;
    vi.setSystemTime(later);
    await settle();
    const [all0, crawler0] = [await count("visit:all"), await count("visit:crawler")];
    const stale = await fetchWorker(tagged, { headers: PERSON });
    expect(stale.headers.get(CACHE_STATE)).toBe("stale");
    await waitStored(path, later);
    await settle();
    expect(await count(tag)).toBe(tags0 + 2);
    expect(await count("visit:all")).toBe(all0 + 1);
    expect(await count("visit:crawler")).toBe(crawler0);
  });
});

describe("one refresh per page at a time (ADR 0125)", () => {
  it("a second stale hit while the first refresh runs starts none, in this isolate or behind another's lock", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let renders = 0;
    // A 503 leaves the cache as it is, so only the lock is exercised here.
    const render = async () => {
      renders++;
      await gate;
      return new Response("busy", { status: 503 });
    };
    const key = new Request(`${ORIGIN}/?swr=lock-${++n}`);
    const first = refreshStale(key, null, render);
    await refreshStale(key, null, render);
    await vi.waitFor(() => expect(renders).toBe(1), { timeout: 5000, interval: 20 });
    release();
    await first;
    expect(await caches.default.match(lockKey(key))).toBeUndefined();
    // Once it is done, the next stale hit may refresh again.
    await refreshStale(key, null, render);
    expect(renders).toBe(2);
    // Another isolate's lock (in the data centre's cache) also holds it back, and is left in place.
    await caches.default.put(lockKey(key), new Response("1", { headers: { "Cache-Control": "public, max-age=30" } }));
    await refreshStale(key, null, render);
    expect(renders).toBe(2);
    expect(await caches.default.match(lockKey(key))).toBeTruthy();
  });
});

describe("only 200s are cached (ADR 0125)", () => {
  it("never stores a 404, and a stale copy whose page is now gone is dropped", async () => {
    const missing = `/arena/event/no-such-event-${++n}`;
    expect((await fetchWorker(missing)).status).toBe(404);
    await settle();
    expect(await stored(missing)).toBeUndefined();
    // A copy of an event page that has since gone (held, say) is served once while it re-renders, then removed.
    const gone = `/arena/event/gone-event-${++n}`;
    await plant(gone, 300, T0 - 600_000);
    const res = await fetchWorker(gone);
    expect(res.headers.get(CACHE_STATE)).toBe("stale");
    expect(await res.text()).toBe("planted copy");
    await vi.waitFor(async () => expect(await stored(gone)).toBeUndefined(), { timeout: 10_000, interval: 50 });
    expect((await fetchWorker(gone)).status).toBe(404);
  });
});

describe("a release never serves the previous release's pages (diligence review, 7 Nov)", () => {
  it("the cache key carries the deployed version id and the Trap Set version", () => {
    expect(releaseKey({ CF_VERSION_METADATA: { id: "v-123" } }, "1.3")).toBe("v-123.ts1.3");
    expect(releaseKey({}, "1.3")).toBe("local.ts1.3");
    expect(releaseKey({ CF_VERSION_METADATA: { id: "v-124" } }, "1.3")).not.toBe(releaseKey({ CF_VERSION_METADATA: { id: "v-123" } }, "1.3"));
  });

  // Boardy, 7 Nov: /benchmark itself is never edge-cached now (boardy-8nov.test.ts), so this uses the home page.
  it("a copy stored under another release is never served, fresh or stale; this release's copy is", async () => {
    const path = homeUrl("rel");
    // The previous release's fresh copy, under its own key.
    const old = new URL(`${ORIGIN}${path}`);
    old.searchParams.set(RELEASE_PARAM, "previous-release.ts1.2");
    await caches.default.put(new Request(old.toString()), forStore(new Response("previous release", { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } }), 300, T0 - 1000));
    const res = await fetchWorker(path);
    expect(res.headers.get(CACHE_STATE)).toBeNull();
    expect(await res.text()).not.toBe("previous release");
    // A visitor can't ask for the old copy by naming its release.
    const forged = await fetchWorker(`${path}&${RELEASE_PARAM}=previous-release.ts1.2`);
    expect(await forged.text()).not.toBe("previous release");
    // This release's own copy is stored and served.
    await waitStored(path, T0);
    expect((await fetchWorker(path)).headers.get(CACHE_STATE)).toBe("fresh");
  });
});
