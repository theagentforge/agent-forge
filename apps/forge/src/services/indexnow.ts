import { agentIndexOpen } from "./agent-index-gate";
import { getDb } from "./db";
import { sitemapPaths } from "../web/answers";

// IndexNow (Bing, Yandex, Seznam, Naver and others; https://www.indexnow.org): we tell search engines which pages are
// new or changed, instead of waiting to be crawled. 23 Oct traffic: Bingbot fetched 2 pages in a week while AI crawlers
// fetched 44,000, and Bing's index feeds Copilot and, by most reports, ChatGPT search. Production only; once a day.
// The key is public by design: search engines check it at https://<host>/<key>.txt.

const KEY = "indexnow:key";
const LAST = "indexnow:last";
/** When we last tried, sent or not: a refused send (429 on 23 Oct, for 10,000 URLs at once) waits a day too. */
const TRIED = "indexnow:tried";
const ENDPOINT = "https://api.indexnow.org/indexnow";
/**
 * IndexNow allows 10,000 URLs per request, but a new key that sends thousands at once is refused as possible spam
 * (429). So the first send is the static pages and the newest answer pages, and later sends are the pages changed
 * since, newest first, capped. The sitemap covers the rest.
 */
export const INDEXNOW_FIRST = 100;
export const INDEXNOW_MAX = 1_000;
const DAY = 20 * 3_600_000;

/** Our IndexNow key (32 hex characters), made once and kept in KV. */
export async function indexNowKey(env: Pick<Env, "KV">) {
  const have = await env.KV.get(KEY);
  if (have && /^[a-f0-9]{32}$/.test(have)) return have;
  const key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.KV.put(KEY, key);
  return key;
}

/**
 * Sends the sitemap's pages that are new since the last send (the first time, the static pages and the newest answer
 * pages), at most one try every 20 hours, sent or refused. Returns what it did. Never throws.
 */
export async function pingIndexNow(env: Env, now = Date.now(), fetcher: typeof fetch = fetch) {
  try {
    if (env.ENVIRONMENT !== "production") return { skipped: "not_production" };
    const last = Number((await env.KV.get(LAST)) ?? 0);
    const tried = Number((await env.KV.get(TRIED)) ?? 0);
    if (now - Math.max(last, tried) < DAY) return { skipped: "too_soon" };
    await env.KV.put(TRIED, String(now));
    const origin = env.PUBLIC_ORIGIN;
    const rows = await sitemapPaths(getDb(env), { agentIndex: await agentIndexOpen(env) });
    // Static pages (no date) first, then the newest.
    const at = (r: { lastmod?: number }) => r.lastmod ?? Number.MAX_SAFE_INTEGER;
    const newest = (a: { lastmod?: number }, b: { lastmod?: number }) => at(b) - at(a);
    const pick = last ? rows.filter((r) => (r.lastmod ?? 0) > last) : rows;
    const urls = [...pick].sort(newest).slice(0, last ? INDEXNOW_MAX : INDEXNOW_FIRST).map((r) => origin + r.path);
    if (!urls.length) {
      await env.KV.put(LAST, String(now));
      return { sent: 0 };
    }
    const key = await indexNowKey(env);
    const host = new URL(origin).host;
    const res = await fetcher(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: `${origin}/${key}.txt`, urlList: urls }),
    });
    // 200 and 202 are success; anything else is logged and tried again in a day.
    if (res.status === 200 || res.status === 202) await env.KV.put(LAST, String(now));
    return { sent: urls.length, status: res.status };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}
