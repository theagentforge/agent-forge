import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_ANCHORS, impossibleBrowser, isLikelyBot, maxBrowserMajor } from "../src/services/bots";
import { houseInstall } from "../src/services/install-ids";
import { OPS_MODE_KEY, resetOpsModeCache } from "../src/services/ops-mode";
import { recordCheck } from "../src/services/proof";
import { receiptToken, RECEIPT_SCHEMA } from "../src/services/receipts";
import { bump, likelyPerson, visitCounters } from "../src/services/usage";
import { LONG_EDGE_CACHE, shareOnlyLink } from "../src/web/pages";
import { fetchWorker, ORIGIN } from "./helpers";
import "../src/index";

// ADR 0124: numbers an acquirer can trust. Bots see every page as usual but add nothing to the people and agent KPIs,
// and the cost guard's lean mode never stops a metric write.

const NOW = Date.UTC(2026, 10, 4, 12);
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
/** What a real browser sends with a top-level page load. */
const NAV = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "cross-site" };
const h = (o: Record<string, string>) => new Headers(o);
const today = () => new Date().toISOString().slice(0, 10);
const count = async (key: string) =>
  Number((await env.DB.prepare("select coalesce(sum(n), 0) as n from usage_daily where key = ? and day = ?").bind(key, today()).first<{ n: number }>())?.n ?? 0);
const sources = async () => Number((await env.DB.prepare("select count(*) as n from check_sources where day = ?").bind(today()).first<{ n: number }>())?.n ?? 0);
const settle = () => new Promise((r) => setTimeout(r, 60));

afterEach(async () => {
  await env.KV.delete(OPS_MODE_KEY);
  resetOpsModeCache();
});

describe("isLikelyBot", () => {
  it("names the crawlers seen inflating the KPIs (1–3 Nov), on pages and agent calls alike", () => {
    for (const ua of [
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
      "ElevenLabs/1.0",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    ]) {
      expect(isLikelyBot({ headers: h({ "user-agent": ua, ...NAV }) }, "page", NOW), ua).toBe(true);
      expect(isLikelyBot({ headers: h({ "user-agent": ua, ...NAV }) }, "api", NOW), ua).toBe(true);
    }
  });

  it("current browsers with Sec-Fetch headers are people; the same user agent without them is a fake browser", () => {
    for (const ua of [FIREFOX, CHROME, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"]) {
      expect(isLikelyBot({ headers: h({ "user-agent": ua, ...NAV }) }, "page", NOW), ua).toBe(false);
      expect(isLikelyBot({ headers: h({ "user-agent": ua }) }, "page", NOW), ua).toBe(true);
      expect(isLikelyBot({ headers: h({ "user-agent": ua }) }, "api", NOW), ua).toBe(true);
    }
  });

  it("a Chrome or Firefox major that hasn't shipped, even as a nightly, is made up; the ceiling moves with the date", () => {
    expect(maxBrowserMajor("chrome", BROWSER_ANCHORS.chrome.at)).toBe(BROWSER_ANCHORS.chrome.major + 3);
    expect(maxBrowserMajor("chrome", BROWSER_ANCHORS.chrome.at + 56 * 86_400_000)).toBe(BROWSER_ANCHORS.chrome.major + 5);
    expect(impossibleBrowser(CHROME, NOW)).toBe(false);
    expect(impossibleBrowser(FIREFOX, NOW)).toBe(false);
    expect(impossibleBrowser(CHROME.replace("Chrome/153", "Chrome/171"), NOW)).toBe(true);
    expect(impossibleBrowser(FIREFOX.replaceAll("155", "190"), NOW)).toBe(true);
    // Even with every browser header in place.
    expect(isLikelyBot({ headers: h({ "user-agent": CHROME.replace("Chrome/153", "Chrome/171"), ...NAV }) }, "page", NOW)).toBe(true);
  });

  it("agent calls keep scripts and agent clients; pages don't", () => {
    for (const ua of ["curl/8.7.1", "python-requests/2.32", "node", "claude-code/2.4.1", "theagentforge-cli/0.6.0", ""]) {
      expect(isLikelyBot({ headers: h({ "user-agent": ua }) }, "api", NOW), ua).toBe(false);
    }
    expect(isLikelyBot({ headers: h({ "user-agent": "curl/8.7.1" }) }, "page", NOW)).toBe(true);
    expect(isLikelyBot({ headers: h({}) }, "page", NOW)).toBe(true);
  });

  it("uses Cloudflare's verdict when the request carries one", () => {
    const req = (cf: unknown) => ({ headers: h({ "user-agent": FIREFOX, ...NAV }), cf });
    expect(isLikelyBot(req({ verifiedBotCategory: "Search Engine Crawler" }), "page", NOW)).toBe(true);
    expect(isLikelyBot(req({ verifiedBotCategory: "Search Engine Crawler" }), "api", NOW)).toBe(true);
    // An AI assistant fetching while a person waits is an agent at work, never a visit.
    expect(isLikelyBot(req({ verifiedBotCategory: "AI Assistant" }), "page", NOW)).toBe(true);
    expect(isLikelyBot(req({ verifiedBotCategory: "AI Assistant" }), "api", NOW)).toBe(false);
    expect(isLikelyBot(req({ botManagement: { verifiedBot: true, score: 1 } }), "page", NOW)).toBe(true);
    // A Bot Management score marks automation: pages only, since every agent call is automated.
    expect(isLikelyBot(req({ botManagement: { verifiedBot: false, score: 5 } }), "page", NOW)).toBe(true);
    expect(isLikelyBot(req({ botManagement: { verifiedBot: false, score: 5 } }), "api", NOW)).toBe(false);
    expect(isLikelyBot(req({ botManagement: { verifiedBot: false, score: 88 }, verifiedBotCategory: "" }), "page", NOW)).toBe(false);
  });

  it("drives the visit counters and likelyPerson", () => {
    const visit = (headers: Record<string, string>) => ({ method: "GET", url: `${ORIGIN}/arena?from=x`, headers: h({ referer: "https://t.co/x", ...headers }) });
    // A bot's tagged arrival from outside is also counted as left out by the filter (diligence review, 7 Nov).
    expect(visitCounters(visit({ "user-agent": FIREFOX }), ORIGIN)).toEqual(["visit:all", "visit:crawler", "bot:excluded:tagged_arrival"]);
    expect(visitCounters(visit({ "user-agent": FIREFOX, ...NAV }), ORIGIN)).toContain("visit:arrivals");
    expect(likelyPerson({ headers: h({ "user-agent": CHROME }) })).toBe(false);
    expect(likelyPerson({ headers: h({ "user-agent": CHROME, ...NAV }) })).toBe(true);
  });
});

describe("bots out of the KPIs (ADR 0124)", () => {
  it("a scraper's page views count as crawler views only; a person's as an arrival", async () => {
    const before = { crawler: await count("visit:crawler"), arrivals: await count("visit:arrivals") };
    await fetchWorker("/about", { headers: { "User-Agent": FIREFOX, Referer: "https://example.org/" } });
    await settle();
    expect(await count("visit:crawler")).toBe(before.crawler + 1);
    expect(await count("visit:arrivals")).toBe(before.arrivals);
    await fetchWorker("/about", { headers: { "User-Agent": FIREFOX, Referer: "https://example.org/", ...NAV } });
    await settle();
    expect(await count("visit:arrivals")).toBe(before.arrivals + 1);
  });

  it("a REST check from a fake browser or a crawler adds no check source; an agent's script still does", async () => {
    const check = (ua: string, ip: string) => fetchWorker("/api/v1/check?id=npm:bots-test-pkg", { headers: { "User-Agent": ua, "CF-Connecting-IP": ip } });
    const before = await sources();
    expect((await check(FIREFOX, "198.51.100.71")).status).toBe(200);
    expect((await check("Mozilla/5.0 (compatible; ClaudeBot/1.0)", "198.51.100.72")).status).toBe(200);
    await settle();
    expect(await sources()).toBe(before);
    await check("python-requests/2.32", "198.51.100.73");
    await settle();
    expect(await sources()).toBe(before + 1);
  });

  it("a web check (/check?q=) from a bot adds no check source", async () => {
    const before = await sources();
    await fetchWorker("/check?q=npm:bots-web-pkg", { headers: { "User-Agent": "Mozilla/5.0 (compatible; PerplexityBot/1.0)", "CF-Connecting-IP": "198.51.100.74" } });
    await settle();
    expect(await sources()).toBe(before);
    await fetchWorker("/check?q=npm:bots-web-pkg", { headers: { "User-Agent": CHROME, "CF-Connecting-IP": "198.51.100.75", ...NAV } });
    await settle();
    expect(await sources()).toBe(before + 1);
  });

  it("receipt badges: people counted on every serve (edge cache hits too), bots never; kept a week at the edge", async () => {
    const token = await receiptToken(env.REPORT_SIGNING_KEY, { v: RECEIPT_SCHEMA, kind: "scan", subject: `sha256:${"c".repeat(64)}`, version: null, verdict: "clear", rules: "x", source: null, at: "2026-11-04T03:00Z" });
    const img = { "User-Agent": CHROME, "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "cross-site" };
    const before = await count("receipt:badge");
    const first = await fetchWorker(`/r/${token}/badge.svg`, { headers: img });
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe(`${LONG_EDGE_CACHE}, immutable`);
    await first.text();
    await settle();
    // Served from caches.default now, with a made-up parameter that no longer splits the cache.
    expect(await caches.default.match(new Request(`${ORIGIN}/r/${token}/badge.svg`))).toBeTruthy();
    await (await fetchWorker(`/r/${token}/badge.svg?n=2`, { headers: img })).text();
    await (await fetchWorker(`/r/${token}/badge.svg`, { headers: { "User-Agent": FIREFOX } })).text();
    await (await fetchWorker(`/r/${token}/badge.svg`, { headers: { "User-Agent": "AhrefsBot/7.0" } })).text();
    await settle();
    expect(await count("receipt:badge")).toBe(before + 2);
  });

  it("report-page views from crawlers aren't counted", async () => {
    const before = await count("contribute:report-page");
    const q = `/report?tool=npm:bots-report&kind=mcp_server&version=1.0.0&fp=${encodeURIComponent(`sha256:${"d".repeat(64)}`)}`;
    expect((await fetchWorker(q, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" } })).status).toBe(200);
    await settle();
    expect(await count("contribute:report-page")).toBe(before);
    await (await fetchWorker(q, { headers: { "User-Agent": CHROME, ...NAV } })).text();
    await settle();
    expect(await count("contribute:report-page")).toBe(before + 1);
  });
});

describe("scraper relief (ADR 0124)", () => {
  it("only a lone share tag on a scan or Arena page is redirected", () => {
    const u = (p: string) => new URL(`${ORIGIN}${p}`);
    expect(shareOnlyLink(u(`/scan/${"a".repeat(64)}?from=share`))).toBe(true);
    expect(shareOnlyLink(u(`/scan/${"a".repeat(64)}?from=share-x`))).toBe(true);
    expect(shareOnlyLink(u("/arena/run/abc?from=share-li"))).toBe(true);
    expect(shareOnlyLink(u("/arena?from=Share"))).toBe(true);
    expect(shareOnlyLink(u(`/scan/${"a".repeat(64)}?from=share&format=json`))).toBe(false);
    expect(shareOnlyLink(u("/arena?from=home"))).toBe(false);
    expect(shareOnlyLink(u("/t/npm:x?from=share"))).toBe(false);
    expect(shareOnlyLink(u("/og/scan/abc.png?from=share"))).toBe(false);
  });

  it("counts the share tag, then 301s to the bare page, which counts the arrival once", async () => {
    const path = `/scan/${"e".repeat(64)}`;
    const before = { tag: await count("visit:tag:share-x"), arrivals: await count("visit:arrivals"), x: await count("visit:src:x") };
    const res = await fetchWorker(`${path}?from=share-x`, { redirect: "manual", headers: { "User-Agent": CHROME, Referer: "https://t.co/abc", ...NAV } });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(path);
    await settle();
    expect(await count("visit:tag:share-x")).toBe(before.tag + 1);
    expect(await count("visit:arrivals")).toBe(before.arrivals);
    // The browser follows with the same Referer: one arrival from X, as before the redirect existed.
    await (await fetchWorker(path, { headers: { "User-Agent": CHROME, Referer: "https://t.co/abc", ...NAV } })).text();
    await settle();
    expect(await count("visit:arrivals")).toBe(before.arrivals + 1);
    expect(await count("visit:src:x")).toBe(before.x + 1);
    // A bot is redirected too, and counts nothing.
    const bot = await fetchWorker(`${path}?from=share`, { redirect: "manual", headers: { "User-Agent": "AhrefsBot/7.0", Referer: "https://t.co/abc" } });
    expect(bot.status).toBe(301);
    await settle();
    expect(await count("visit:tag:share")).toBe(0);
  });

  it("share images are kept a day by browsers and a week at the edge, and extra parameters don't redraw them", async () => {
    const res = await fetchWorker("/og/trap-card.png?utm_source=x&junk=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(LONG_EDGE_CACHE);
    expect(LONG_EDGE_CACHE).toMatch(/max-age=86400.*s-maxage=604800.*stale-while-revalidate/);
    await res.arrayBuffer();
    await settle();
    expect(await caches.default.match(new Request(`${ORIGIN}/og/trap-card.png`))).toBeTruthy();
  });
});

describe("lean mode never stops a metric write (ADR 0124)", () => {
  it("counters and check sources are written while lean (costly work still stops: test/cost-guard.test.ts)", async () => {
    await env.KV.put(OPS_MODE_KEY, "lean");
    resetOpsModeCache();
    await bump(env, ["test:lean-kept"]);
    expect(await count("test:lean-kept")).toBe(1);
    const before = await sources();
    await recordCheck(env, "api", "198.51.100.76");
    expect(await sources()).toBe(before + 1);
  });
});

describe("House install IDs (ADR 0124)", () => {
  it("an install ID listed in HOUSE_INSTALL_IDS counts as House; nothing is House by default", () => {
    const id = "3f1c2b9e-8a4d-4c6e-9b7a-1d2e3f4a5b6c";
    expect(houseInstall({}, id)).toBeNull();
    expect(houseInstall({ HOUSE_INSTALL_IDS: "" }, id)).toBeNull();
    expect(houseInstall({ HOUSE_INSTALL_IDS: ` other, ${id.toUpperCase()} ` }, id)).toBe("house");
    expect(houseInstall({ HOUSE_INSTALL_IDS: id }, "not-an-id")).toBeNull();
    expect(houseInstall({ HOUSE_INSTALL_IDS: id }, undefined)).toBeNull();
  });
});
