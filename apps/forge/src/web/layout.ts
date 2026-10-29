import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

// The page shell for every public page (docs/BRAND.md §8). Server-rendered; works without JavaScript.

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface PageOptions {
  title: string;
  description: string;
  /** Path of this page, for the canonical URL and Open Graph. */
  path: string;
  origin: string;
  body: Html;
  /** Absolute or root-relative URL of the share image (1200×630). */
  image?: string;
  /** Machine-readable twin of this page (MASTER_PLAN §6.8: agents get structured data). */
  /** The share title, when a page sets its own (the home page's depends on its hero case). */
  ogTitle?: string;
  jsonAlternate?: string;
  /** Markdown twin of this page, for agents that can't send `Accept: text/markdown` (web/markdown.ts). */
  markdownAlternate?: string;
  /** JSON-LD object for search engines. */
  jsonLd?: Record<string, unknown>;
  noindex?: boolean;
  /** "noindex, follow" for thin pages kept for people and agents but out of search until they have data (ADR 0060). */
  noindexFollow?: boolean;
  /** Canonical path when it differs from `path` (a near-duplicate consolidated to its main page, ADR 0060). */
  canonicalPath?: string;
  /** A benchmark canary line (ADR 0058) for pages that show Arena data: an HTML comment and a meta tag in the head. */
  canary?: string;
  nav?: "home" | "scan" | "skillwatch" | "gauntlet" | "arena" | "best" | "trapcard" | "check" | "wire" | "watchlist" | "scouts" | "methodology" | "connect" | "dashboard" | "stats" | "benchmark" | "security";
  /** Extra same-origin module scripts for this page only (e.g. /webmcp.js on /scan and /check). */
  modules?: string[];
  /** Extra origins for script-src (e.g. Cloudflare Turnstile on forms). */
  scriptSrc?: string[];
  frameSrc?: string[];
  /** Extra targets for form-action (e.g. "mailto:" on /teams, whose form only opens the email app). */
  formAction?: string[];
  status?: number;
}

export const SITE_NAME = "The Agent Forge";
export const TAGLINE = "AI, tested on everyday jobs.";

/** The home headline and its share title (BRAND.md, decision D2); pages.ts holds the same words for the hero. */
export const HOME_TITLE = "The Agent Forge: AI agents tested on real business jobs with planted traps";
export const HOME_OG_TITLE = "An AI agent paid a fake invoice and reported the job done";
/** BRAND.md one-line descriptor (AQ-01, 28 Oct, Dinike approved): the positioning wherever one line describes the Forge. Never "social network". */
export const DESCRIPTOR = "A planted-trap test for AI agents, and safety data on the skills, MCP servers and packages they install.";

/**
 * W2.1 (Boardy items 1, 4, 17): five plain words, the evidence a buyer checks first. The Wire, Skill Watch, How it works,
 * Watchlist and Top Scouts live in the footer. On a phone it stays one row that scrolls sideways (site.css).
 */
export const NAV: [NonNullable<PageOptions["nav"]>, string, string][] = [
  ["arena", "/arena", "Arena"],
  ["benchmark", "/benchmark", "Benchmark"],
  ["check", "/check", "Check a tool"],
  ["security", "/security", "Security"],
  ["stats", "/stats", "Stats"],
];
/** Decision D3: the one primary call to action, in the header of every page. */
export const HEAD_CTA = { href: "/gauntlet", label: "Run the Gauntlet", short: "Gauntlet" } as const;
const current = (o: PageOptions, key: string, href: string) => o.nav === key || o.path === href || o.path.startsWith(`${href}/`) || o.path.startsWith(`${href}?`);

export function securityHeaders(opts: { scriptSrc?: string[]; frameSrc?: string[]; formAction?: string[] } = {}): Record<string, string> {
  const scripts = ["'self'", ...(opts.scriptSrc ?? [])].join(" ");
  const frames = opts.frameSrc?.length ? opts.frameSrc.join(" ") : "'none'";
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src ${scripts}`,
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      `frame-src ${frames}`,
      ["form-action 'self' https://github.com", ...(opts.formAction ?? [])].join(" "),
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "manifest-src 'self'",
    ].join("; "),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

export function renderPage(o: PageOptions): Html {
  const url = `${o.origin}${o.path}`;
  const image = o.image ? (o.image.startsWith("http") ? o.image : `${o.origin}${o.image}`) : `${o.origin}/og/home.png`;
  const fullTitle = o.path === "/" ? HOME_TITLE : `${o.title} · ${SITE_NAME}`;
  const ogTitle = o.ogTitle ?? o.title;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${fullTitle}</title>
<meta name="description" content="${o.description}">
<link rel="canonical" href="${o.canonicalPath ? `${o.origin}${o.canonicalPath}` : url}">
${o.noindex ? html`<meta name="robots" content="noindex">` : o.noindexFollow ? html`<meta name="robots" content="noindex, follow">` : ""}
${o.canary ? html`${raw(`<!-- ${o.canary.replace(/-->|--/g, "")} -->`)}
<meta name="canary" content="${o.canary}">` : ""}
<meta name="theme-color" content="#0B0E12">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
<script src="/theme.js"></script>
<script src="/site.js" defer></script>
${(o.modules ?? []).map((src) => html`<script type="module" src="${src}"></script>\n`)}${o.jsonAlternate ? html`<link rel="alternate" type="application/json" href="${o.jsonAlternate}">` : ""}${o.markdownAlternate ? html`<link rel="alternate" type="text/markdown" href="${o.markdownAlternate}">` : ""}
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="website">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${o.description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@theagentforgeio">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${o.description}">
<meta name="twitter:image" content="${image}">
${o.jsonLd ? html`<script type="application/ld+json">${raw(JSON.stringify(o.jsonLd).replace(/</g, "\\u003c"))}</script>` : ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
<div class="wrap">
<a class="lockup" href="/" aria-label="${SITE_NAME} home">
<img class="logo-dark" src="/brand/forge-lockup-dark.svg" alt="${SITE_NAME}" width="210" height="28">
<img class="logo-light" src="/brand/forge-lockup-light.svg" alt="${SITE_NAME}" width="210" height="28">
</a>
<nav class="nav" aria-label="Main">
${NAV.map(([key, href, label]) => html`<a href="${href}"${current(o, key, href) ? raw(' aria-current="page"') : ""}>${label}</a>`)}
</nav>
<a class="btn primary chamfer head-cta" href="${HEAD_CTA.href}?from=head"${o.path.startsWith(HEAD_CTA.href) ? raw(' aria-current="page"') : ""}><span class="long">${HEAD_CTA.label}</span><span class="short">${HEAD_CTA.short}</span></a>
</div>
</header>
<main id="main" class="wrap">
${o.body}
</main>
<footer class="site-foot">
<div class="wrap">
<div class="foot-grid">
<div class="foot-brand"><strong>Check the Forge first.</strong> <span class="mono">[F✓]</span>
<p>${TAGLINE} Reports are operators' observations, not certification.</p></div>
<nav class="foot-links" aria-label="Footer">
<a href="/about">About</a><a href="/skill-watch">Skill Watch</a><a href="/trap-card">Trap card</a><a href="/scan">Scan a skill</a><a href="/about#investors">Investors and partners</a><a href="/dataset">Dataset spec</a><a href="/teams">For teams</a><a href="/agents">Agent index</a><a href="/wire">The Wire</a><a href="/watchlist">Watchlist</a><a href="/scouts">Top Scouts</a><a href="/methodology">Methodology</a><a href="/results-policy">Results policy</a><a href="/security">Security</a><a href="/stats">Stats</a><a href="/reports/mcp-registry-census-2026-10">Registry census</a><a href="/dashboard">Your agents</a><a href="/disputes">Disputes</a><a href="/connect">Connect</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/llms.txt">llms.txt</a>
</nav>
</div>
<div class="foot-bottom"><span>© ${new Date().getUTCFullYear()} The Agent Forge</span><button class="theme-toggle" type="button" data-theme-toggle hidden>Theme</button></div>
</div>
</footer>
</body>
</html>`;
}
