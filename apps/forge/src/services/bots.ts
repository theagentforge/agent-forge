// ADR 0124: bots out of the KPIs. One test for "is this request a bot?", used by every counter a crawler or scraper
// could inflate: page visits and arrivals, badge and receipt-badge serves, report-page views, web checks (check
// sources) and the REST check's check-source and tool-check rows. Pages still render normally for bots; only the
// counting changes. Seen 1–3 Nov 2026: a residential-proxy scraper rotating "Firefox/153–157" and "Chrome/153" user
// agents across home ISPs, plus PerplexityBot, Ahrefs, ElevenLabs and ClaudeBot, inflated agent-days, arrivals,
// receipt badges, tool checks and report-page views.
//
// Two surfaces:
// - "page": web pages, badges and images, which only people's browsers should count for. Every rule below applies,
//   plus the script and crawler user agents of BOT_UA (curl, python, an empty user agent...).
// - "api": agent calls (the REST check). Scripts and agent clients are the point here, so curl, python and an empty
//   user agent still count. Only named crawlers, Cloudflare-verified crawlers and fake browsers are left out.
// MCP and A2A calls are never tested: they are not browsers.

/**
 * Crawlers and scripts that never count as a person on a page. Crawlers that don't say "bot" are listed by name (seen
 * in our Cloudflare logs, 18–22 Oct 2026: GoogleOther, meta-externalagent, Ziwei-Seat; 1–3 Nov: Ahrefs, ElevenLabs).
 * AI fetches made while a person waits (ChatGPT-User, Claude-User, Perplexity-User) are counted apart as ai:live.
 */
export const BOT_UA =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|externalagent|externalfetcher|googleother|google-extended|google-inspectiontool|embedly|curl|wget|python|go-http|headless|lighthouse|monitor|scrap|fetcher|httpclient|axios|node-fetch|okhttp|java\/|libwww|-seat\/|ahrefs|semrush|elevenlabs|chatgpt-user|claude-user|perplexity-user|^$/i;

/**
 * Named crawlers, for agent calls too: indexers and SEO tools, never an agent doing a check. Narrower than BOT_UA, so
 * curl, python and the agent clients still count.
 */
export const CRAWLER_UA = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|externalagent|googleother|google-extended|google-inspectiontool|ahrefs|semrush|elevenlabs|-seat\//i;

const DAY = 86_400_000;
/**
 * Stable majors on a known day, for the "impossible version" rule. Both browsers ship a new major every 4 weeks, so the
 * ceiling moves by itself; bump an anchor only if a schedule slips. Chrome 154: 3 Nov 2026. Firefox 157: 20 Oct 2026.
 */
export const BROWSER_ANCHORS = {
  chrome: { major: 154, at: Date.UTC(2026, 10, 3) },
  firefox: { major: 157, at: Date.UTC(2026, 9, 20) },
} as const;
/** How far beyond stable a real browser can be: beta, dev, Canary and Nightly run up to about 3 majors ahead. */
export const BROWSER_HEADROOM = 3;

/** The highest Chrome or Firefox major a real browser can report on a day. */
export function maxBrowserMajor(browser: keyof typeof BROWSER_ANCHORS, now = Date.now()) {
  const a = BROWSER_ANCHORS[browser];
  return a.major + Math.max(0, Math.floor((now - a.at) / (28 * DAY))) + BROWSER_HEADROOM;
}

/** A user agent naming a Chrome or Firefox major that hasn't shipped yet (even as a nightly): made up. */
export function impossibleBrowser(ua: string, now = Date.now()) {
  const chrome = /\bChrome\/(\d{1,4})\./.exec(ua);
  if (chrome && Number(chrome[1]) > maxBrowserMajor("chrome", now)) return true;
  const firefox = /\bFirefox\/(\d{1,4})\b/.exec(ua);
  return !!firefox && Number(firefox[1]) > maxBrowserMajor("firefox", now);
}

/** Every browser in use sends `Mozilla/…` first. */
export const claimsBrowser = (ua: string) => /^Mozilla\/\d/.test(ua);

/**
 * True when a request names a browser but lacks the Sec-Fetch-* headers every current browser sends (Chrome 76+,
 * Firefox 90+, Safari 16.4+, over HTTPS). Scripts copying a browser's user agent rarely copy these.
 */
export function fakeBrowser(headers: Pick<Headers, "get">) {
  if (!claimsBrowser(headers.get("user-agent") ?? "")) return false;
  return !headers.get("sec-fetch-mode") && !headers.get("sec-fetch-dest") && !headers.get("sec-fetch-site");
}

/** Cloudflare's own view, when the request carries it: a verified bot's category and, on Bot Management plans, a score. */
function cloudflareSays(cf: unknown, surface: "page" | "api") {
  if (!cf || typeof cf !== "object") return false;
  const c = cf as { verifiedBotCategory?: unknown; botManagement?: { verifiedBot?: unknown; score?: unknown } };
  const category = typeof c.verifiedBotCategory === "string" ? c.verifiedBotCategory : "";
  const verified = !!category || c.botManagement?.verifiedBot === true;
  // An AI assistant fetching for a person who is waiting (ChatGPT-User, Claude-User) is an agent at work on the API,
  // but never a visit.
  if (verified && (surface === "page" || category !== "AI Assistant")) return true;
  // Bot Management scores 1–29 as automated. Pages only: every agent call is automated by design.
  const score = c.botManagement?.score;
  return surface === "page" && typeof score === "number" && score >= 1 && score < 30;
}

export type BotSurface = "page" | "api";

/**
 * True when a request is most likely a bot, for the counters only (ADR 0124). `page` (the default) for web pages,
 * badges and images; `api` for agent calls, where scripts and agent clients still count.
 */
export function isLikelyBot(req: { headers: Pick<Headers, "get">; cf?: unknown }, surface: BotSurface = "page", now = Date.now()) {
  const ua = req.headers.get("user-agent") ?? "";
  if ((surface === "page" ? BOT_UA : CRAWLER_UA).test(ua)) return true;
  if (cloudflareSays(req.cf, surface)) return true;
  return impossibleBrowser(ua, now) || fakeBrowser(req.headers);
}
