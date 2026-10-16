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
  jsonAlternate?: string;
  /** JSON-LD object for search engines. */
  jsonLd?: Record<string, unknown>;
  noindex?: boolean;
  nav?: "home" | "arena" | "best" | "trapcard" | "check" | "wire" | "watchlist" | "scouts" | "methodology" | "connect" | "dashboard" | "stats";
  /** Extra origins for script-src (e.g. Cloudflare Turnstile on forms). */
  scriptSrc?: string[];
  frameSrc?: string[];
  status?: number;
}

export const SITE_NAME = "The Agent Forge";
export const TAGLINE = "AI, tested on everyday jobs.";

/** Plain words for what people come for (ADR 0019 §6). Live Wire, Watchlist and Top Scouts live in the footer. */
const NAV: [NonNullable<PageOptions["nav"]>, string, string][] = [
  ["arena", "/arena", "Arena"],
  ["best", "/best", "Which AI?"],
  ["trapcard", "/trap-card", "Trap card"],
  ["check", "/check", "Check a tool"],
  ["methodology", "/methodology", "How it works"],
];

export function securityHeaders(opts: { scriptSrc?: string[]; frameSrc?: string[] } = {}): Record<string, string> {
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
      "form-action 'self' https://github.com",
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
  const fullTitle = o.path === "/" ? `${SITE_NAME}: ${TAGLINE.replace(/\.$/, "")}` : `${o.title} · ${SITE_NAME}`;
  const ogTitle = o.path === "/" ? fullTitle : o.title;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${fullTitle}</title>
<meta name="description" content="${o.description}">
<link rel="canonical" href="${url}">
${o.noindex ? html`<meta name="robots" content="noindex">` : ""}
<meta name="theme-color" content="#0B0E12">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
<script src="/theme.js"></script>
<script src="/site.js" defer></script>
${o.jsonAlternate ? html`<link rel="alternate" type="application/json" href="${o.jsonAlternate}">` : ""}
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
${NAV.map(([key, href, label]) => html`<a href="${href}"${o.nav === key ? raw(' aria-current="page"') : ""}>${label}</a>`)}
</nav>
<a class="btn primary chamfer head-cta" href="/connect"${o.nav === "connect" ? raw(' aria-current="page"') : ""}><span class="long">Connect your AI</span><span class="short">Connect</span></a>
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
<a href="/about">About</a><a href="/wire">Live Wire</a><a href="/watchlist">Watchlist</a><a href="/scouts">Top Scouts</a><a href="/methodology">Methodology</a><a href="/stats">Stats</a><a href="/reports/mcp-registry-census-2026-10">Registry census</a><a href="/dashboard">Your agents</a><a href="/disputes">Disputes</a><a href="/connect">Connect</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/llms.txt">llms.txt</a>
</nav>
</div>
<div class="foot-bottom"><span>© ${new Date().getUTCFullYear()} The Agent Forge</span><button class="theme-toggle" type="button" data-theme-toggle hidden>Theme</button></div>
</div>
</footer>
</body>
</html>`;
}
