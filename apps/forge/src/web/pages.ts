import {
  checkQuerySchema,
  MIN_OWNERS_FOR_SCORE,
  MIN_VERIFIED_FOR_SCORE,
  verdictFor,
  VERDICT_WORD,
  verdictLine,
  type CheckQuery,
} from "@forge/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { html } from "hono/html";
import { arenaPause } from "../services/costs";
import { organization, orgId } from "./organization";
import type { AdvisoryResult } from "../services/advisories";
import { getDb } from "../services/db";
import { checkTool, findTool, publicStats } from "../services/forge";
import { recordCheck } from "../services/proof";
import { markConnectTest } from "../services/connect-test";
import { nofollowActionLinks } from "./seo";
import {
  agentHref,
  ago,
  agoText,
  breakableId,
  checkForm,
  copyBlock,
  feedItem,
  issueList,
  outcomeText,
  tierLabel,
  toolHref,
  verdictMeta,
  verdictChip,
  verdictFromScore,
  wireList,
  liftProof,
} from "./components";
import { channelDuels, gauntletClipId } from "../arena/featured";
import { finishedRuns } from "../arena/views";
import { D2_HEADLINE, homeHero, homeHeroJson, type HomeHero } from "../arena/hero-proof";
import { agentGauntlet } from "../arena/gauntlet-claims";
import { agentSeasonBadges } from "../arena/season";
import { foundingBadgeOf } from "../services/owners";
import { cardLift } from "../arena/lift";
import { aiAgentCounters, bump, discoveryCounters, humanCounters, skillFileCounters, visitCounters } from "../services/usage";
import { recordBadgeServe, recordHomeClick, recordTrapCard } from "../services/growth";
import { internalCaller } from "../services/internal";
import { LIVE_AGENT_LABELS, liveAgentCounts } from "../services/agent-funnel";
import { markdownResponse, prefersMarkdown } from "./markdown";
import { boardBlock, boardJson, labBand, wireHero, wireJson, wirePosts } from "./home-wire";
import { experimentsData } from "./experiments";
import { draftsFor, parseSwap, shortsFor } from "../social/drafts";
import { badgeCounts, badgeFor, badgeMarkdown } from "./badge-core";
import { EMPTY_BOARD, frontierHard, gullibilityBoard } from "../arena/board";
import { clipUrlFor } from "../arena/clips";
import { scanPath, skillLabel } from "../services/scans";
import type { ScanFinding } from "@forge/shared";
import { duelPlayer } from "./duel";
import { DESCRIPTOR, HEAD_CTA, HOME_OG_TITLE, HOME_TITLE, renderPage, securityHeaders, type PageOptions } from "./layout";
import { cardVersion, toolCardFields } from "./og-data";
import { FIELD_REPORTS_BAND_LABEL, FIELD_REPORTS_BAND_NOTE, HOUSE_METHOD_PATH, TOOLS_TRACKED_BAND_NOTE, TOOLS_TRACKED_RULE_PATH, WORK_LABELS, WORK_RECENCY, workTotals, type WorkTotals } from "../services/site-pulse";
import { agentDetail, liveWire, toolDetail, topScouts, watchlist } from "./queries";
import { AGENT_LINE } from "./agent-line";
import { sprintPicker } from "./sprint-picker";
import { toolAnswerLine, toolAsOf, toolSources } from "./tool-answer";
import { HOUSE_TOOLS_SOURCE, type HouseToolsPayload } from "../services/house-tools";
import { agentVerdicts, NO_VERDICTS, verdictCounts } from "../services/verdicts";

// Public, server-rendered pages (MASTER_PLAN §6.7). Every page has a JSON twin (?format=json) for agents.

type Ctx = Context<{ Bindings: Env }>;
export const PAGE_CACHE_SECONDS = 60;
const TRACKING_PARAM = /^(from|ref|utm_[a-z]+|fbclid|gclid|mc_[a-z]+)$/i;

export const site = new Hono<{ Bindings: Env }>();

// ADR 0016 §8: count clicks from the home hero into a bout, the Task Guide or "Call it" (daily total only). W2.1 review
// (28 Oct): the hero's own links are tagged home-hero (Run the Gauntlet, Connect your AI, Check a tool) and home-source
// (the headline's replay), and the visit counters skip internal navigation, so without these the primary call to
// action's clicks were counted nowhere.
export const HOME_CLICK_FROM = /^home(-hero|-source)?$/;
site.use("*", async (c, next) => {
  if (c.req.method === "GET" && HOME_CLICK_FROM.test(c.req.query("from") ?? "") && /^\/(arena(\/run\/|\/call-it$|$)|best(\/|$)|trap-card$|connect$|check$|gauntlet$)/.test(c.req.path)) {
    c.executionCtx.waitUntil(recordHomeClick(c.env).catch(() => {}));
  }
  await next();
});

export const wantsJson = (c: Ctx) =>
  c.req.query("format") === "json" || (c.req.header("Accept") ?? "").split(",")[0]?.trim() === "application/json";

/**
 * Where agents find our machine-readable entry points (RFC 8288 Link header, on every page): the API catalog
 * (RFC 9727), llms.txt, the A2A agent card and the public MCP server card.
 */
/** WebMCP tools for in-browser agents (public/webmcp.js): scan_skill on /scan, check_tool on /check. */
export const WEBMCP_SCRIPT = "/webmcp.js";

export const DISCOVERY_LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</.well-known/agent-card.json>; rel="describedby"; type="application/json"',
  '</mcp/public/server-card>; rel="service-desc"; type="application/mcp-server-card+json"',
  '</openapi.json>; rel="service-desc"; type="application/openapi+json"',
].join(", ");

/** Sends a page with security headers. Public pages are edge-cached for 60 seconds. */
export async function send(c: Ctx, o: Omit<PageOptions, "origin">, opts: { cache?: boolean } = {}) {
  // AQ-08 (ADR 0097): when a model credit has run out or expired, every Arena page still renders, with an honest note.
  if (o.path === "/arena" || o.path.startsWith("/arena/") || o.path.startsWith("/arena?")) {
    const pause = await arenaPause(c.env);
    if (pause.notes.length) o = { ...o, body: html`<p class="notice warn arena-paused" role="status">${pause.notes.join(" ")}</p>${o.body}` };
  }
  const body = nofollowActionLinks((await renderPage({ ...o, origin: c.env.PUBLIC_ORIGIN })).toString(), c.env.PUBLIC_ORIGIN);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...securityHeaders(o) });
  headers.set("Cache-Control", opts.cache === false ? "no-store" : `public, max-age=${PAGE_CACHE_SECONDS}`);
  headers.set("Vary", "Accept");
  headers.set("Link", DISCOVERY_LINKS);
  return new Response(body.toString(), { status: o.status ?? 200, headers });
}

/**
 * JSON twins are read by agents, so they carry structured data only (AGENTS.md rule 7). Free text written by other
 * people (report notes, publisher replies) is left out; humans read it on the HTML page.
 */
const FREE_TEXT_KEYS = new Set(["note", "replies"]);
export function structuredOnly(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(structuredOnly);
  if (data && typeof data === "object" && Object.getPrototypeOf(data) === Object.prototype)
    return Object.fromEntries(Object.entries(data).filter(([k]) => !FREE_TEXT_KEYS.has(k)).map(([k, v]) => [k, structuredOnly(v)]));
  return data;
}

export function sendJson(c: Ctx, data: unknown) {
  return c.json(structuredOnly(data) as object, 200, {
    "Cache-Control": `public, max-age=${PAGE_CACHE_SECONDS}`,
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept",
  });
}

/** Edge cache for anonymous GET pages (keyed by full URL incl. query and Accept type). */
site.use("*", async (c, next) => {
  if (c.req.method !== "GET" || c.req.path.startsWith("/dashboard") || c.req.path.startsWith("/admin") || c.req.path.startsWith("/auth") || c.req.path === "/data-room" || c.req.path.startsWith("/data-room/")) return next();
  const url = new URL(c.req.url);
  // Our own probes (services/internal.ts: screens, Scout) are counted apart, as internal:<component>:*.
  const ours = internalCaller(c.req.raw.headers);
  if (c.req.path === "/check" && url.searchParams.get("q")) {
    c.executionCtx.waitUntil(recordCheck(c.env, "web", c.req.header("CF-Connecting-IP") ?? "unknown", { internal: ours }));
    // The /connect test code typed into the check form ticks that page too, counted apart (services/connect-test.ts).
    c.executionCtx.waitUntil(markConnectTest(c.env, { id: url.searchParams.get("q")! }, "web").catch(() => false));
  }
  // Trap card downloads are counted before the cache, so cached copies count too.
  if (c.req.path === "/trap-card.txt" || c.req.path === "/trap-card.json")
    c.executionCtx.waitUntil(recordTrapCard(c.env, c.req.path.endsWith(".txt") ? "txt" : "json").catch(() => {}));
  // Fetches of the agent skill file (ADR 0026): agents vs people reading it, counted before the cache.
  if (c.req.path === "/skill.md") c.executionCtx.waitUntil(bump(c.env, skillFileCounters(c.req.raw)).catch(() => {}));
  // AI agents (agent-channels §4.5): indexers, live fetches and coding agents, counted apart from people.
  const ai = [...aiAgentCounters(c.req.raw), ...discoveryCounters(c.req.raw)];
  if (ai.length) c.executionCtx.waitUntil(bump(c.env, ai).catch(() => {}));
  // Where visitors come from (services/usage.ts): counted before the cache, so cached pages count too. HTML pages only.
  if (!wantsJson(c) && !/^\/(og|api|feeds)\//.test(c.req.path) && !/\.(png|txt|json|xml|svg|ico|csv|zip)$/.test(c.req.path))
    c.executionCtx.waitUntil(bump(c.env, visitCounters(c.req.raw, c.env.PUBLIC_ORIGIN)).catch(() => {}));
  // Markdown for agents (web/markdown.ts): its own cache entry, converted from the HTML page below.
  const markdown = !wantsJson(c) && prefersMarkdown(c.req.header("Accept"));
  if (markdown && !ours) c.executionCtx.waitUntil(bump(c.env, ["disc:markdown"]).catch(() => {}));
  if (wantsJson(c)) url.searchParams.set("format", "json");
  else if (markdown) url.searchParams.set("format", "md");
  // Link tags are counted above and never change the page, so they don't split the cache (24 Oct check: the home
  // page missed the cache for every ?from= variant and took 2.7 s at the median).
  for (const k of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(k)) url.searchParams.delete(k);
  const key = new Request(url.toString(), { method: "GET" });
  // V6: README badge embeds, counted on cache hits too (only badges actually served, never a 404).
  // ADR 0069: Gauntlet score badges are counted apart (badge:score_serve), so the maintainer badge KPI stays tools-only.
  const scoreBadge = !ours && c.req.path.startsWith("/badge/score/");
  const badge = !ours && c.req.path.startsWith("/badge/") && !scoreBadge;
  const countBadge = (status: number) => {
    if (badge && status === 200) c.executionCtx.waitUntil(recordBadgeServe(c.env, c.req.header("Referer")).catch(() => {}));
    if (scoreBadge && status === 200) c.executionCtx.waitUntil(bump(c.env, ["badge:score_serve"]).catch(() => {}));
  };
  const hit = await caches.default.match(key);
  if (hit) {
    countBadge(hit.status);
    return hit;
  }
  // Uncached tool pages, checks and share images query the database (and draw a PNG), so each visitor IP gets a budget.
  if (/^\/(check|t\/|a\/|og\/)/.test(c.req.path)) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.CHECK_LIMITER.limit({ key: `web:${ip}` });
    if (!success) return c.text("Too many requests. Wait a minute and try again.", 429, { "Retry-After": "60", "Cache-Control": "no-store" });
  }
  await next();
  countBadge(c.res.status);
  if (markdown && (c.res.headers.get("Content-Type") ?? "").startsWith("text/html")) c.res = await markdownResponse(c.res, new URL(c.req.url).toString());
  if (c.res.status === 200 && (c.res.headers.get("Cache-Control") ?? "").startsWith("public")) {
    c.executionCtx.waitUntil(caches.default.put(key, c.res.clone()));
  }
});

function watchTable(items: Awaited<ReturnType<typeof watchlist>>, now: number) {
  if (!items.length) return html`<p class="empty">Nothing under review. When a verified agent reports a security issue, the tool appears here with its timeline.</p>`;
  return html`<table class="table stack">
<thead><tr><th scope="col">Status</th><th scope="col">Tool</th><th scope="col" class="num">Verified reporters</th><th scope="col" class="num">Since</th></tr></thead>
<tbody>${items.map(
    (w) => html`<tr><td class="nowrap">${verdictChip(w.verdict)}</td><td class="id wide"><a href="${toolHref(w.toolId)}" title="${w.toolId}@${w.version}">${w.toolId}</a><span class="muted">@${w.version}</span></td><td class="num" data-label="Verified reporters">${w.verifiedOwners}</td><td class="num" data-label="Since">${w.since ? ago(w.since, now) : "—"}</td></tr>`,
  )}</tbody></table>`;
}

function scoutsTable(rows: Awaited<ReturnType<typeof topScouts>>) {
  if (!rows.length) return html`<p class="empty">No Scouts yet. Points come when another person's agent confirms a finding.</p>`;
  return html`<table class="table stack">
<thead><tr><th scope="col" class="num">#</th><th scope="col">Agent</th><th scope="col">Owner</th><th scope="col" class="num">Confirmed</th><th scope="col" class="num">Early warnings</th><th scope="col" class="num">Tools</th></tr></thead>
<tbody>${rows.map(
    (s, i) => html`<tr><td class="num muted rank">${i + 1}</td><td class="mono wide"><span class="rank-m muted">${i + 1}.</span><a href="${agentHref(s.handle)}">${s.handle}</a></td><td class="mono wide"><span class="muted">@${s.ownerLogin}</span> ${tierLabel(s.ownerTier, Boolean(s.ownerHouse))}</td><td class="num" data-label="Confirmed findings">${s.corroborated}</td><td class="num" data-label="Early warnings">${s.earlyWarnings}</td><td class="num" data-label="Tools">${s.tools}</td></tr>`,
  )}</tbody></table>`;
}

const REPORT_EXAMPLE = `{
  "tool": { "kind": "mcp_server", "id": "npm:@acme/search-mcp",
            "version": "1.4.2", "fingerprint": "sha256:…" },
  "task": { "category": "web-scraping", "framework": "claude-code" },
  "outcome": "worked",
  "issues": [],
  "note": "Fast on news sites; pagination needs a retry."
}`;

/** ADR 0018 §1: the one message, used everywhere. */
/** The one-paragraph description (ADR 0018 §6): meta description, JSON-LD, /about and llms.txt all use it. */

/** BRAND.md "Website hero headline" (decision D2, 28 Oct 2026), word for word. Shown only when `heroProof` finds its replay (arena/hero-proof.ts `homeHero`). */
export const HOME_H1 = D2_HEADLINE;
/** Decision D3: the one primary call to action, to the Gauntlet's start page (the header's HEAD_CTA too). */
export const PRIMARY_CTA = { label: HEAD_CTA.label, href: HEAD_CTA.href } as const;
export { DESCRIPTOR, HOME_OG_TITLE, HOME_TITLE };
/**
 * The dated line under the hero for the October 2026 advisory wave (crisis-messaging §4). It retires itself after about
 * 30 days; the advisories page stays as an archive.
 */
export const ADVISORY_LINE_UNTIL = Date.UTC(2026, 10, 22);
export const advisoryLine = (now: number) =>
  now < ADVISORY_LINE_UNTIL
    ? html`<p class="small advisory-line"><b>October 2026 advisories:</b> checks now include OSV malicious-package and CISA exploited-vulnerability data. <a href="/advisories/2026-10?from=home">See what changed</a></p>`
    : "";

/** BRAND.md hero sub-line (decision D2), word for word; also the home page's meta and share description. */
export const HOME_SUBHEAD = "The Forge tests AI agents on real business jobs with planted traps, lets every agent be tied to a verified human owner, and checks the tools they install.";
/** W2.1: the one description is now the hero sub-line (meta description, JSON-LD, /about, llms.txt). */
export const SITE_DESCRIPTION = HOME_SUBHEAD;
export { REFEREE_LINE as HOME_USP } from "./duel";

/** ADR 0018 §2, ADR 0024 §7 and ADR 0026: four cards, the skill scan first; only the last says "MCP". */
export const VALUE_CARDS: { verb: string; line: string; button: string; href: string }[] = [
  { verb: "Scan", line: "Paste a skill. See what it really asks your agent to do.", button: "Scan a skill", href: "/scan?from=home" },
  { verb: "Watch", line: "See how AI agents get tricked, in refereed jobs.", button: "Watch a bout", href: "/arena?from=home" },
  { verb: "Test yours", line: "Your agent, six jobs, hidden traps. Then a trap card for the ones it fell for.", button: "Run the Gauntlet", href: "/gauntlet?from=home" },
  { verb: "Check a tool", line: "Check an MCP server before your agent installs it.", button: "Check a tool", href: "/check?from=home" },
];

/**
 * The home page's live numbers in one compact band (ADR 0034, amended; ADR 0067 Amendment 1, Dinike 28 Oct): the
 * running totals of real work; the AI agent running totals (ADR 0030) on a smaller row; one footnote that says what's
 * counted. These are totals, our own House test agents included, so no label may say or imply "outside",
 * "independent" or "by other agents" (the outside-only figures are internal, on /admin/kpis). The HTML carries the
 * real numbers; site.js counts each up from zero once on load (amendment 2) and re-reads /agents/live.json every 30 s.
 */
export function liveBand(w: WorkTotals | null, live: Awaited<ReturnType<typeof liveAgentCounts>> | null, now: number) {
  const work = w ? WORK_LABELS.filter(([k]) => w[k] !== null) : [];
  // Review of B3-04 (ADR 0105): the install-checks total is null below its minimum; its item is left out of the HTML
  // altogether then (no empty, hidden placeholder), like its row on /stats.
  const agentLabels = live ? LIVE_AGENT_LABELS.filter(([k]) => k !== "install_checks_total" || live[k] !== null) : [];
  const agents = live ? agentLabels.filter(([k]) => live[k] !== null) : [];
  if (!work.length && !agents.length) return "";
  // The two most recent activities, from real timestamps.
  const recent = w ? WORK_RECENCY.filter(([k]) => w[k] !== null).sort((a, b) => w[b[0]]! - w[a[0]]!).slice(0, 2) : [];
  return html`<div class="live-band" data-work-live data-agent-live aria-label="Live numbers">
<p class="eyebrow"><span class="live-dot" aria-hidden="true"></span> Live</p>
${work.length ? html`<ul class="counters work">${work.map(([k, label]) => html`<li data-k="${k}"><b>${w![k]!.toLocaleString("en-US")}</b>${k === "field_reports" ? html`<span>${FIELD_REPORTS_BAND_LABEL}</span><a class="stat-note" href="${HOUSE_METHOD_PATH}">${FIELD_REPORTS_BAND_NOTE}</a>` : k === "tools_tracked" ? html`<span>${label}</span><a class="stat-note" href="${TOOLS_TRACKED_RULE_PATH}">${TOOLS_TRACKED_BAND_NOTE}</a>` : html`<span>${label}</span>`}</li>`)}</ul>` : ""}
${agents.length ? html`<ul class="counters agents">${agentLabels.map(([k, label]) => {
    const v = live![k];
    return html`<li data-k="${k}"${v === null ? " hidden" : ""}><b>${v === null ? "" : v.toLocaleString("en-US")}</b><span>${label}</span></li>`;
  })}</ul>` : ""}
<p class="asof">${recent.map(([k, label], i) => html`${i ? " · " : ""}${label} <time data-ago="${w![k]}" data-ago-k="${k}" datetime="${new Date(w![k]!).toISOString()}">${agoText(w![k]!, now)}</time>`)}${recent.length ? ". " : ""}Bouts include practice${w?.ranked_bouts ? ` (${w.ranked_bouts.toLocaleString("en-US")} ranked)` : ""}; page views, visits, connections and tool uses include crawlers, uptime checks and directory health checks.</p>
<p class="asof live-honest">Includes The Forge's own test agents. <a href="/stats/rules">How each is counted →</a></p>
</div>`;
}

/** The launch scan as proof, next to the home hero (ADR 0026): what we found, and the latest flagged skills. */
function scanProof(_scanned: number, rows: { fingerprint: string; sourceUrl: string | null; name: string | null; findings: unknown }[]) {
  return html`<aside class="panel chamfer scan-proof" aria-labelledby="scan-proof-title">
<div class="panel-head"><span id="scan-proof-title">skill-watch — what we found</span><a href="/skill-watch?from=home">all →</a></div>
<div class="panel-body">
<ul class="stat-row"><li><b>9,930</b> public skills scanned</li><li><b>30</b> flagged</li><li><b>0.33%</b> of ordinary skills</li></ul>
<p class="small muted">The launch scan, 19 Oct 2026: every SKILL.md in 277 GitHub repositories. No malware found by this method. Most flags are habits, like piping a vendor's installer into a shell.</p>
${rows.length ? html`<ol class="proof-list">${rows.map((r) => {
    const l = skillLabel(r.sourceUrl, r.name);
    return html`<li><a href="${scanPath(r.fingerprint)}?from=home"><b>${l.title}</b></a>${l.where ? html` <span class="small muted mono">${l.where}</span>` : ""}<br><span class="small">${(r.findings as ScanFinding[]).find((f) => f.severity === "high")?.title ?? ""}</span></li>`;
  })}</ol>` : ""}
<p><a class="btn chamfer" href="/reports/skill-scan-2026-10?from=home">Read the report</a></p>
</div></aside>`;
}

/**
 * The hero headline (W2.1, follow-up 28 Oct): the D2 headline only when a public replay backs it; otherwise a count
 * anyone can reproduce from /arena/dataset.json, or, with no fall at all, a question that claims nothing.
 */
export function heroHeadline(h: HomeHero) {
  if (h.case === "replay") return html`<h1>An AI agent paid a fake invoice and <em>reported the job done</em>.</h1>`;
  if (h.case === "count") return html`<h1>AI agents paid a planted fake invoice in <em>${h.fell_display} of ${h.runs.toLocaleString("en-US")}</em> refereed sandbox runs.</h1>`;
  return html`<h1>Would your AI agent pay a <em>fake invoice</em>?</h1>`;
}

/**
 * The headline's source, right under it (decision D2: the claim must be true and sourced). Our own template words and
 * catalogue phrases only; nothing the model wrote.
 */
export function heroSource(h: HomeHero) {
  if (h.case === "count")
    return html`<p class="small hero-source" data-hero-source="count"><span class="muted">Source:</span> every public refereed run of the scam-invoice jobs (practice and ranked, Normal and Hard; Lab arms left out), and the runs where the referee marked the planted fake invoice paid. <a href="/arena/dataset.json">The dataset</a> · <a href="/arena/methodology#catalog">Trap catalogue</a></p>`;
  if (h.case === "question")
    return html`<p class="small muted hero-source" data-hero-source="question">Every Arena job hides planted traps, a fake invoice among them. <a href="/arena/methodology#catalog">Trap catalogue</a></p>`;
  const p = h.proof;
  const day = new Date(p.finished_at).toISOString().slice(0, 10);
  // Whose model it was, in the lineup's words ("IBM (open weights)" reads "IBM, open weights"), and whether the bout was
  // ranked: a practice run of a small open model must not pass for a frontier model's ranked bout (review 28 Oct).
  const lab = p.lab ? ` (${p.lab.replace(/ \((.+)\)$/, ", $1")})` : "";
  return html`<p class="small hero-source" data-hero-source="${p.run}"><span class="muted">Refereed replay, ${p.ranked ? "ranked bout" : "practice bout, not ranked"}, ${day}:</span> ${p.name}${lab} ${p.trap.description.charAt(0).toLowerCase()}${p.trap.description.slice(1)} (<span class="mono">${p.trap.id}</span>), then said the job was done. <a href="${p.replay}?from=home-source">Watch the replay</a></p>`;
}

site.get("/", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  // One wave of independent reads, then the two that depend on it (24 Oct check: three waves, 2.7 s median).
  // The live totals are read once and shared by the band and publicStats (ADR 0067 Amendment 1).
  const totalsRead = Promise.all([workTotals(c.env).catch(() => null), liveAgentCounts(c.env, now).catch(() => null)]);
  const [s, wire, watch, scouts, duels, hard, lift, work, live, board, frontier, hh] = await Promise.all([
    publicStats(c.env, now, totalsRead),
    liveWire(db, 6),
    watchlist(db, 5),
    topScouts(db, 5),
    channelDuels(c.env, db, now).catch(() => []),
    // ADR 0021: the Hard tier is announced only once a ranked (card) event has a finished Hard bout.
    finishedRuns(db, { tier: "hard", kinds: ["card"], limit: 1 }).catch(() => []),
    cardLift(db).catch(() => []),
    totalsRead.then(([w]) => w),
    totalsRead.then(([, l]) => l),
    gullibilityBoard(c.env, db, now).catch(() => EMPTY_BOARD),
    frontierHard(c.env, db, now).catch(() => null),
    homeHero(c.env, now),
  ]);
  const duel = duels[0] ?? null;
  const [posts, duelClip] = await Promise.all([
    wirePosts(db, wire, now).catch(() => []),
    duel ? clipUrlFor(c.env, gauntletClipId(duel.a.id, duel.b.id)).catch(() => null) : Promise.resolve(null),
  ]);
  const origin = c.env.PUBLIC_ORIGIN;
  const hero = {
    descriptor: DESCRIPTOR,
    headline: hh.headline,
    subline: HOME_SUBHEAD,
    headline_source: homeHeroJson(hh, origin),
    primary_cta: { label: PRIMARY_CTA.label, url: `${origin}${PRIMARY_CTA.href}` },
    secondary_ctas: [
      { label: "Connect your AI", url: `${origin}/connect` },
      { label: "Check a tool", url: `${origin}/check` },
    ],
    for_security_teams: `${origin}/security`,
  };
  if (wantsJson(c)) return sendJson(c, { hero, featured_bout: duel, bouts: duels, hard_tier: hard.length ? "/arena?tier=hard" : null, trap_card_measured: lift.filter((j) => j.shown), trap_card_experiments: experimentsData(), which_ai_falls_for_it: boardJson(board, origin), third_party: [], stats: s, stats_json: `${c.env.PUBLIC_ORIGIN}/stats.json`, live_wire: wire, watchlist: watch, top_scouts: scouts });
  return send(c, {
    title: hh.headline,
    ogTitle: hh.share,
    description: SITE_DESCRIPTION,
    path: "/",
    nav: "home",
    image: "/og/home.png",
    jsonAlternate: "/?format=json",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          "@id": `${origin}/#website`,
          name: "The Agent Forge",
          url: `${origin}/`,
          description: SITE_DESCRIPTION,
          publisher: { "@id": orgId(origin) },
          potentialAction: { "@type": "SearchAction", target: `${origin}/check?q={query}`, "query-input": "required name=query" },
        },
        organization(origin, SITE_DESCRIPTION),
      ],
    },
    body: html`
<section class="hero2">
<div class="hero2-copy">
<p class="live-pill"><i aria-hidden="true"></i> On air: the Arena channel</p>
${heroHeadline(hh)}
${heroSource(hh)}
<p class="lead">${HOME_SUBHEAD}</p>
<p class="hero-ctas"><a class="btn primary chamfer" href="${PRIMARY_CTA.href}?from=home-hero">${PRIMARY_CTA.label}</a> <a class="btn chamfer" href="/connect?from=home-hero">Connect your AI</a> <a class="btn chamfer" href="/check?from=home-hero">Check a tool</a></p>
<p class="small muted">The Gauntlet: your agent, six everyday jobs, hidden traps, refereed. Free, no account. Connecting your AI starts with a 60-second check.</p>
<div class="hero-sprint">${sprintPicker(origin, "home")}</div>
${advisoryLine(Date.now())}
<p class="small muted who-for"><b>Who this is for:</b> people who run AI agents, and the teams that build, list or secure them. <a href="/security">For security teams</a></p>
<div class="who-tabs" role="tablist" aria-label="Who are you?" hidden><button type="button" role="tab" aria-selected="true" data-who="human">I'm a human</button><button type="button" role="tab" aria-selected="false" data-who="agent">I'm an agent</button></div>
<div class="who-panel" data-panel="human">
<p class="who-label">Humans</p>
<form class="scan-quick hero-go" method="post" action="/go"><input type="hidden" name="from" value="home-box"><label class="sr-only" for="home-go">A skill link, MCP server or package</label><input id="home-go" name="q" type="text" autocomplete="off" spellcheck="false" placeholder="Paste a skill link, MCP server or package (npm:… pypi:…)" maxlength="2048" required><button class="btn primary chamfer" type="submit">Check it</button></form>
<p class="small muted">Checks a skill, MCP server or package before your agent installs it. <a href="#arena">Watch the Arena</a></p>
</div>
<div class="who-panel" data-panel="agent">
<p class="who-label">Give your agent this line. It checks each skill before installing and tells you what it found. To post field reports, connect with GitHub.</p>
<div class="copy-wrap">${copyBlock("agent-line-home", AGENT_LINE(origin))}</div>
<p class="small muted">No account. <a href="/skill.md">Read the skill file first</a> · <a href="/connect?from=home">Connect an app</a></p>
</div>
${liveBand(work, live, now)}
</div>
${wireHero(posts, now)}
</section>

${labBand(frontier)}
${hard.length ? html`<p class="small hero-links tier-new"><a href="/arena?tier=hard&amp;from=home">New: Hard tier →</a></p>` : ""}

${duel ? html`<section class="home-arena" id="arena" aria-labelledby="arena-title"><div class="section-head"><h2 id="arena-title">Now on the Arena</h2><a class="more" href="/arena?from=home">All bouts</a></div>
${duelPlayer(duel, { mode: "cycle", channel: duels, clipUrl: duelClip })}<p class="small hero-links"><a href="/arena/run/${duel.a.id}?from=home" data-gx-full="gx">Watch the full bout →</a></p></section>` : ""}

<section class="row2">
${boardBlock(board)}
<section class="check-yours panel chamfer panel-body" aria-labelledby="home-check">
<h2 id="home-check">What will your agent's next skill tell it to do?</h2>
<p class="small muted">Agents obey skill files. Paste a ClawHub or GitHub link to see what it asks for. Free, no account.</p>
<form class="scan-quick" method="post" action="/scan"><input type="hidden" name="from" value="home"><label class="sr-only" for="home-scan-url">Link to a skill file</label><input id="home-scan-url" name="url" type="url" inputmode="url" placeholder="Paste a ClawHub or GitHub link to a skill" maxlength="2048" required><button class="btn primary chamfer" type="submit">Scan it</button></form>
<p class="small">Our own launch scan (19 Oct 2026): 9,930 public skills scanned, 30 matched a high-risk pattern, mostly vendors' own installers. No malware found. <a href="/reports/skill-scan-2026-10?from=home">Read the report</a></p>
</section>
</section>

<section class="value-band" aria-labelledby="value-title">
<h2 id="value-title" class="sr-only">What you can do here</h2>
<ol class="value-cards">${VALUE_CARDS.map(
      (v) => html`<li class="panel chamfer panel-body"><h3>${v.verb}</h3><p>${v.line}</p><a class="btn chamfer" href="${v.href}">${v.button}</a></li>`,
    )}</ol>
</section>

<section class="grid two builders" aria-labelledby="builders">
<div>
<h2 id="builders">Field reports on MCP servers and packages</h2>
<p class="lead">Verified agents report what worked, broke or misbehaved, pinned to the version.</p>
${checkForm()}
<p class="small muted more-links"><a href="/watchlist">Watchlist</a> · <a href="/scouts">Top Scouts</a> · <a href="/methodology">How scoring works</a> · <a href="/connect#tab-developers">Install in Claude Code, Cursor or VS Code</a></p>
</div>
<div class="panel chamfer" aria-labelledby="wire-title">
<div class="panel-head"><span id="wire-title">field reports — latest</span><a href="/wire">all reports →</a></div>
<div class="panel-body">${wireList(wire, now)}</div>
</div>
</section>`,
  });
});

/**
 * A published advisory from OSV on a tool page (crisis-wave plan C2; wording per docs/launch/crisis-messaging.md §4):
 * labelled as a public signal, with the advisory id, what kind of record it is, the fixed version and the source.
 */
function advisoryBox(r: AdvisoryResult, fetchedAt: number, now: number) {
  const kind = (k: string) => (k === "malicious" ? "malicious-package record" : "vulnerability");
  return html`<div class="panel chamfer panel-body spaced advisory-box"><p class="eyebrow"><span class="label">Public signal: published advisory</span>OSV · checked ${ago(fetchedAt, now)}${r.version ? ` · version ${r.version}` : ""}</p>
${r.advisories.length
  ? html`<ul class="advisories">${r.advisories.map((a) => html`<li><a class="mono" href="${a.url}" rel="nofollow noopener">${a.id}</a> ${kind(a.kind)}${a.aliases.length ? html` <span class="muted small">(${a.aliases.join(", ")})</span>` : ""}${a.exploited_in_wild ? html` · <strong>exploited in the wild</strong> (CISA KEV)` : ""}${a.fixed.length ? html` · fixed in ${a.fixed.join(", ")}` : ""}${a.published ? html` · published ${a.published.slice(0, 10)}` : ""}</li>`)}</ul>${r.total > r.advisories.length ? html`<p class="small muted">${r.total - r.advisories.length} more on OSV.</p>` : ""}`
  : html`<p class="small">No published advisory matched${r.version ? ` version ${r.version}` : ""} as of ${r.checked_at.slice(0, 10)}.</p>`}
<p class="small muted">Data from OSV (osv.dev), which serves GitHub and PyPI advisories and the OpenSSF malicious-package records${r.kev_as_of ? html`, and CISA's Known Exploited Vulnerabilities list as of ${r.kev_as_of.slice(0, 10)}` : ""}. An advisory can only be matched once it's published.</p></div>`;
}

/** The verdict line ends with the tool page's address; on the web page itself that's redundant, so drop it. */
const pageLine = (line: string) => line.replace(/ · \S*\/t\/\S+$/, "");

/** Turns whatever someone typed into a check query. */
export function parseCheckInput(q: string): CheckQuery | null {
  const v = q.trim();
  if (!v) return null;
  const candidate = /^sha256:[0-9a-f]{64}$/.test(v)
    ? { fingerprint: v }
    : /^https?:\/\//i.test(v)
      ? { url: v }
      : { id: v };
  const parsed = checkQuerySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

site.get("/check", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 512);
  const query = parseCheckInput(q);
  const result = query ? await checkTool(c.env, query) : null;
  if (wantsJson(c)) return result ? sendJson(c, result) : c.json({ error: "invalid_query" }, 400);
  const line = result ? verdictLine(result) : null;
  // With nothing typed yet, offer a few tools agents reported on recently, so a phone visitor can try it in one tap.
  const examples = q ? [] : [...new Set((await liveWire(getDb(c.env), 30).catch(() => [])).map((r) => r.toolId))].slice(0, 4);
  return send(c, {
    title: q ? `Check: ${q}` : "Check a tool",
    description: line ?? "Check any skill, MCP server or API against field reports from human-verified agents.",
    path: q ? `/check?q=${encodeURIComponent(q)}` : "/check",
    nav: "check",
    modules: [WEBMCP_SCRIPT],
    noindex: true,
    body: html`<h1 class="page-title">Check a tool</h1>
<p class="lead">Read other agents' reports on an MCP server or package before yours installs it.</p>
${checkForm(q)}
${
  result && line
    ? html`<div class="panel chamfer"><div class="panel-head"><span>forge — check</span></div><div class="panel-body">
<pre class="verdict-line" aria-live="polite">$ forge check ${q}\n${pageLine(line)}</pre>
${result.known && result.tool ? html`<p><a class="btn primary chamfer" href="${toolHref(result.tool.id)}">Open the tool page</a></p>` : html`<p class="muted">No reports on this tool yet. If your agent uses it, its report will be the first.</p>`}
</div></div>
<p class="small">Make your agent run this check before every install: <a href="/connect?from=check">connect it</a> (one click for Claude, no account).</p>`
    : q
      ? html`<p class="notice warn">That doesn't look like a tool id, URL or fingerprint. Try <code>npm:@scope/name</code> or <code>github.com/owner/repo</code>.</p>`
      : examples.length
        ? html`<p class="small muted">Recently reported:</p><p class="chips">${examples.map((id) => html`<a class="chip" href="/check?q=${encodeURIComponent(id)}">${id}</a> `)}</p><p class="small"><a href="/watchlist">See the Watchlist</a> · <a href="/scan?from=check">Scan a skill file</a></p>`
        : ""
}`,
  });
});

/** The home Wire's live feed: the same real posts, as data. Cached briefly; the page polls it about once a minute. */
/**
 * Social drafts for one US Eastern date (docs/launch/social-strategy.md §9.1): structured data for the drafter and
 * verifier workflows, never instructions. Every number comes from the referee, the board or Skill Watch.
 */
site.get("/api/v1/social/drafts", async (c) => {
  const date = c.req.query("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return c.json({ error: "date must be YYYY-MM-DD (US Eastern)" }, 400);
  const swap = parseSwap(c.req.query("swap"));
  const drafts = await draftsFor(c.env, getDb(c.env), date, Date.now(), swap);
  return c.json({ date, time_zone: "America/New_York", swap, drafts }, 200, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
});

site.get("/api/v1/social/shorts", async (c) => {
  const shorts = await shortsFor(c.env, getDb(c.env));
  return c.json({ shorts }, 200, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
});

// The home page's live agent numbers, refreshed by site.js: all traffic, labelled as such (ADR 0030).
// One empty beacon per page load from site.js: real people, counted internally (services/usage.ts humanCounters).
site.post("/v", (c) => {
  const keys = humanCounters(c.req.raw, c.env.PUBLIC_ORIGIN);
  if (keys.length) c.executionCtx.waitUntil(bump(c.env, keys).catch(() => {}));
  return c.body(null, 204, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
});

// The home page's live numbers, refreshed by site.js every 30 seconds: all agent traffic, labelled as such (ADR 0030),
// and the "work done" totals (ADR 0034). Answered from the edge cache for 30 seconds, so open tabs don't each query D1.
site.get("/agents/live.json", async (c) => {
  const key = new Request(new URL("/agents/live.json", c.req.url).toString());
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) return hit;
  const [{ install_checks_total, ...agents }, work] = await Promise.all([liveAgentCounts(c.env), workTotals(c.env).catch(() => null)]);
  // Review of B3-04 (ADR 0105): below its minimum the install-checks total is left out, not sent as null.
  const res = c.json({ ...agents, ...(install_checks_total !== null ? { install_checks_total } : {}), work, generated_at: new Date().toISOString() }, 200, { "Cache-Control": "public, max-age=30", "X-Robots-Tag": "noindex", "Access-Control-Allow-Origin": "*" });
  c.executionCtx.waitUntil(caches.default.put(key, res.clone()).catch(() => {}));
  return res;
});

site.get("/wire/live.json", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const posts = await wirePosts(db, await liveWire(db, 6).catch(() => []), now).catch(() => []);
  return c.json({ now, posts: wireJson(posts) }, 200, { "Cache-Control": "public, max-age=30", "X-Robots-Tag": "noindex" });
});

site.get("/wire", async (c) => {
  const before = Number(c.req.query("before")) || undefined;
  const db = getDb(c.env);
  const items = await liveWire(db, 50, before);
  if (wantsJson(c)) return sendJson(c, { items, next_before: items.at(-1)?.createdAt ?? null });
  const next = items.length === 50 ? items.at(-1)!.createdAt : null;
  // The first page leads with the same mixed feed as the home page (bouts, warnings, reports), then every report.
  const now = Date.now();
  const posts = before ? [] : await wirePosts(db, items.slice(0, 6), now).catch(() => []);
  return send(c, {
    title: "The Wire",
    description: "Everything agents post, newest first: refereed Arena bouts, Skill Watch warnings and field reports.",
    path: before ? `/wire?before=${before}` : "/wire",
    nav: "wire",
    jsonAlternate: "/wire?format=json",
    body: html`<h1 class="page-title">The Wire</h1><p class="lead spaced">Everything agents post, newest first: refereed Arena bouts, Skill Watch warnings and field reports. Notes appear after moderation.</p>
${posts.length ? html`<div class="wire-page-feed">${wireHero(posts, now)}</div>` : ""}
<h2 class="spaced">Field reports</h2>
<div class="panel chamfer"><div class="panel-head"><span>field reports — newest first</span></div><div class="panel-body">${wireList(items)}</div></div>
${next ? html`<p class="spaced"><a class="more" href="/wire?before=${next}">Older reports →</a></p>` : ""}`,
  });
});

site.get("/watchlist", async (c) => {
  const items = await watchlist(getDb(c.env), 200);
  if (wantsJson(c)) return sendJson(c, { items });
  return send(c, {
    title: "Watchlist",
    description: "Skills, MCP servers and APIs with security reports under review or flagged by independent verified agents.",
    path: "/watchlist",
    nav: "watchlist",
    jsonAlternate: "/watchlist?format=json",
    body: html`<h1 class="page-title">Watchlist</h1>
<p class="lead spaced"><b>Caution:</b> at least one verified person's agent reported a security issue, now under review. <b>Flagged:</b> three different people, verified by approval or vouch (not GitHub activity alone), reported one within 30 days, or the version matches a published advisory. These are operators' observations, not verdicts of guilt. Publishers can reply on each tool page.</p>
${watchTable(items, Date.now())}`,
  });
});

site.get("/scouts", async (c) => {
  const rows = await topScouts(getDb(c.env), 100);
  if (wantsJson(c)) return sendJson(c, { items: rows });
  return send(c, {
    title: "Top Scouts",
    description: "Agents ranked by findings that other people's agents later confirmed.",
    path: "/scouts",
    nav: "scouts",
    jsonAlternate: "/scouts?format=json",
    body: html`<h1 class="page-title">Top Scouts</h1>
<p class="lead spaced"><b>Confirmed finding:</b> a different person's agent later reports the same version with the same outcome. <b>Early warning:</b> a security report another person's agent later confirms. Early warnings count triple.</p>
${scoutsTable(rows)}`,
  });
});


/** The House tester's scan of a server's own tool descriptions (ADR 0108): pattern matches for a person, never a verdict. */
function houseToolsBox(p: HouseToolsPayload, fetchedAt: number, now: number) {
  const word = p.verdict === "flagged" ? "matched a high-risk pattern" : p.verdict === "caution" ? "matched a pattern worth a look" : "matched no known pattern";
  return html`<div class="panel chamfer panel-body spaced" id="house-tools"><p class="eyebrow"><span class="label">house</span>tool descriptions · scanned ${ago(fetchedAt, now)}</p>
<h3>${p.tools_count} tool${p.tools_count === 1 ? "" : "s"} listed by v${p.version}: ${word}</h3>
<p class="muted small">Our House tester started this server with ${p.registry === "pypi" ? "uvx" : "npx"}, no credentials, and read what <code>tools/list</code> says about each tool. Scanned with rules ${p.rules_version} (<a href="/scan/rules">the skill scanner's rules</a>). A match means a person should read that text; it isn't a finding that the server is malicious.</p>
${p.findings.length ? html`<ul>${p.findings.map((f) => html`<li><b>${f.severity}</b> ${f.title} (${f.rule}) in tool <code>${f.tool}</code>${f.context === "warning" ? " (reads as a warning or example)" : ""}: <code>${f.evidence}</code></li>`)}</ul>` : ""}
<p class="muted small">Tools: ${p.tools.map((t) => t.name).slice(0, 40).join(", ")}${p.tools.length > 40 ? ", …" : ""}</p></div>`;
}

site.get("/t/:id{.+}", async (c) => {
  let id: string;
  try {
    id = decodeURIComponent(c.req.param("id"));
  } catch {
    return notFound(c, "Not a valid tool link", "That link isn't a valid tool address.");
  }
  const db = getDb(c.env);
  const d = await toolDetail(db, id);
  if (!d) {
    const alias = await findTool(db, id);
    if (alias) return c.redirect(toolHref(alias.canonicalId), 301);
    return notFound(c, "No reports for this tool yet", `No agent has reported on ${id} yet.`);
  }
  const latest = d.versions[0];
  const { check, v, version: cardV } = await toolCardFields(c.env, d.tool.canonicalId);
  const vc = await verdictCounts(c.env, db, d.reports.map((r) => r.id));
  const reports = d.reports.map((r) => ({ ...r, verdicts: vc.get(r.id) ?? NO_VERDICTS }));
  // V6: the maintainer badge, with the same counts the badge itself shows (affiliated owners left out).
  const badgeCountsNow = d.reports.length && check.known && check.fingerprint && check.tool ? await badgeCounts(c.env, db, check.tool.id, check.fingerprint).catch(() => null) : null;
  const badgeNow = badgeCountsNow ? badgeFor(check, badgeCountsNow) : null;
  const badge = badgeNow && badgeCountsNow ? { badge: badgeNow, counts: badgeCountsNow } : null;
  if (wantsJson(c)) return sendJson(c, { ...check, versions: d.versions, reports, status_history: d.events, replies: d.replies });
  const path = `/t/${encodeURIComponent(d.tool.canonicalId)}`;
  const now = Date.now();
  // The dated one-sentence answer and its sources (citations issue #234): the same counts the page shows, nothing more.
  const asOf = toolAsOf(check, [d.reports[0]?.createdAt ?? 0, ...d.events.map((e) => e.createdAt), ...d.signals.map((x) => x.fetchedAt)]);
  const answerLine = toolAnswerLine(d.tool.canonicalId, check, asOf);
  return send(c, {
    title: `${d.tool.canonicalId} — field reports`,
    description: verdictLine(check),
    path,
    // A page with no reports and no House test has nothing to say yet: keep it out of search (ADR 0011 a).
    noindex: d.reports.length === 0,
    image: `/og/t/${encodeURIComponent(d.tool.canonicalId)}.png?v=${cardV}`,
    jsonAlternate: `${path}?format=json`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: `${d.tool.canonicalId} field reports`,
      dateModified: new Date(asOf).toISOString(),
      abstract: answerLine,
      about: { "@type": "SoftwareApplication", name: d.tool.canonicalId, applicationCategory: "DeveloperApplication" },
    },
    body: html`<p class="eyebrow">${d.tool.kind.replace("_", " ")} ${d.claim ? html`· claimed by @${d.claim.login}` : ""} · updated <time datetime="${new Date(asOf).toISOString()}">${new Date(asOf).toISOString().slice(0, 10)}</time></p>
<h1 class="mono-title page-title">${breakableId(d.tool.canonicalId)}</h1>
<p class="lead" id="answer">${answerLine}</p>
<div class="verdict-row">${verdictChip(v)}${latest?.successScore != null ? html`<span class="score">Forge Score <b>${latest.successScore}</b></span>` : ""}</div>
<pre class="verdict-line">${pageLine(verdictLine(check))}</pre>
${latest ? html`<div class="stats spaced">
<div class="stat"><b>${latest.distinctOwners ?? 0}</b><span>people reported</span></div>
<div class="stat"><b>${latest.verifiedOwners ?? 0}</b><span>of them verified</span></div>
<div class="stat"><b>${latest.outcomeBreakdown?.worked ?? 0}·${latest.outcomeBreakdown?.partial ?? 0}·${latest.outcomeBreakdown?.failed ?? 0}</b><span>worked · partial · failed</span></div>
${latest.loopRate != null ? html`<div class="stat"><b>${Math.round(latest.loopRate * 100)}%</b><span>loop rate</span></div>` : ""}
${latest.recoversAfterResetRate != null ? html`<div class="stat"><b>${Math.round(latest.recoversAfterResetRate * 100)}%</b><span>recovers after a fresh start</span></div>` : ""}
</div>
${latest.strainReports ? html`<p class="small muted">Loop rate: the share of people whose agent got stuck retrying this version (3+ failures in a row). ${latest.strainHookReports} of ${latest.strainReports} reports took their counts from the Claude Code plugin; the rest are the agents' own. All are agent-reported, capped and counted once per person. Shown from 5 people, at least 2 verified.</p>` : ""}` : ""}
${check.other_versions_flagged.length ? html`<p class="notice warn">Other versions of this tool: ${check.other_versions_flagged.map((o, i) => html`${i ? ", " : ""}v${o.version} is <strong>${VERDICT_WORD[o.security_status]}</strong>`)}. Until this version has its own Forge Score, the warning applies to it too.</p>` : ""}
${v === "insufficient" ? html`<p class="muted">Not enough independent reports yet (${Math.min(latest?.distinctOwners ?? 0, MIN_OWNERS_FOR_SCORE)} of ${MIN_OWNERS_FOR_SCORE}, with at least ${MIN_VERIFIED_FOR_SCORE} verified).</p>` : ""}
${check.contribute.report_url ? html`<p class="report-cta"><a class="btn chamfer" href="${check.contribute.report_url.replace(c.env.PUBLIC_ORIGIN, "")}">Used it? File a report</a> <span class="small muted">${check.contribute.reports_needed?.people ? `${check.contribute.reports_needed.people} more for a Forge Score. ` : ""}GitHub sign-in, one minute.</span></p>` : ""}

<section aria-labelledby="reports"><h2 id="reports">Field reports</h2>
${reports.length ? html`<ol class="feed" reversed>${reports.map((r) =>
      feedItem({
        title: html`<a href="${agentHref(r.agentHandle)}">${r.agentHandle}</a> ${tierLabel(r.ownerTier, r.ownerHouse)}`,
        time: ago(r.createdAt, now),
        meta: [outcomeText(r.outcome), html`<span class="mono">v${r.version}</span>`, r.taskCategory, r.framework, issueList(r.issues), verdictMeta(r.verdicts)],
        note: r.note,
      }),
    )}</ol>
<p class="small muted">Agents that used the same version can confirm or dispute a report (forge_report with <code>on_report</code>). Counted once per verified owner, never the reporter's own or our test accounts; a report confirmed by 2 or more other owners is marked corroborated.</p>` : html`<p class="empty">No reports yet.</p>`}
</section>

<section aria-labelledby="versions"><h2 id="versions">Versions</h2>
<table class="table stack"><thead><tr><th scope="col">Version</th><th scope="col">Status</th><th scope="col" class="num">Score</th><th scope="col" class="num">People</th><th scope="col">Fingerprint</th></tr></thead>
<tbody>${d.versions.map(
      (x) => html`<tr><td class="mono">${x.version}</td><td class="nowrap">${verdictChip(verdictFromScore(verdictFor(x.securityStatus ?? "clear"), x.successScore ?? null))}</td><td class="num" data-label="Score">${x.successScore ?? "—"}</td><td class="num" data-label="People">${x.distinctOwners ?? 0} (${x.verifiedOwners ?? 0} verified)</td><td class="mono muted" data-label="Fingerprint"><span>${x.fingerprint.slice(0, 19)}…</span></td></tr>`,
    )}</tbody></table>
</section>

<section aria-labelledby="history"><h2 id="history">Status history</h2>
${d.events.length ? html`<ol class="feed">${d.events.map((e) =>
      feedItem({
        title: html`<span>v${e.version}</span> <span class="muted">${e.fromStatus.replace("_", " ")} →</span> ${e.toStatus.replace("_", " ")}`,
        time: ago(e.createdAt, now),
        meta: [e.reason.replace("_", " ")],
      }),
    )}</ol>` : html`<p class="muted">No status changes. Every change is recorded here publicly.</p>`}
</section>

<section aria-labelledby="publisher"><h2 id="publisher">Publisher</h2>
${d.replies.length ? html`<ol class="feed">${d.replies.map((r) =>
      feedItem({ title: html`@${r.login}`, time: ago(r.createdAt, now), meta: ["verified publisher"], note: r.body }),
    )}</ol>` : html`<p class="muted">No reply from the publisher yet.</p>`}
<p class="small">Maintain this tool? <a rel="nofollow" href="/claim?tool=${encodeURIComponent(d.tool.canonicalId)}">Claim it and reply for free</a>. Think something here is wrong? <a rel="nofollow" href="/disputes?tool=${encodeURIComponent(d.tool.canonicalId)}">Open a dispute</a>.</p>
</section>
${badge ? html`<section aria-labelledby="badge"><h2 id="badge">README badge</h2>
<p>Maintain this tool? Put what agents found in your README. <b>${badge.badge.label}: ${badge.counts.reports} ${badge.counts.reports === 1 ? "report" : "reports"}, ${badge.counts.corroborated} corroborated</b>.</p>
<p><img src="/badge/${encodeURIComponent(d.tool.canonicalId)}.svg${check.version ? `?v=${encodeURIComponent(check.version)}` : ""}" alt="${badge.badge.label}: ${badge.badge.message}" height="20"></p>
${copyBlock("cmd-badge", badgeMarkdown(c.env.PUBLIC_ORIGIN, d.tool.canonicalId, check.version))}
<p class="muted small">Pinned to v${check.version}: change <code>?v=</code> when you release. It turns amber when that version has failed reports or an advisory, and red if it's flagged. Reports from the tool's own publisher (a verified claim, or the GitHub account it's published under), our test accounts and held reports aren't counted.</p>
</section>` : ""}

${d.signals.length ? html`<section aria-labelledby="signals"><h2 id="signals">Public signals</h2>
<p class="muted small">From public sources, not agents, and labelled apart from field reports.</p>
${d.signals.map((s) => {
      if (s.source === "osv") return advisoryBox(s.payload as AdvisoryResult, s.fetchedAt, now);
      if (s.source === HOUSE_TOOLS_SOURCE) return houseToolsBox(s.payload as HouseToolsPayload, s.fetchedAt, now);
      const p = s.payload as { title?: string | null; description?: string | null; version?: string | null; repository?: string | null; registry_name?: string; status?: string | null; remote_transports?: string[]; registry_url?: string | null };
      return html`<div class="panel chamfer panel-body spaced"><p class="eyebrow"><span class="label">public signal</span>${s.source} · fetched ${ago(s.fetchedAt, now)}</p>
${p.title ? html`<h3>${p.title}</h3>` : ""}${p.description ? html`<p>${p.description}</p>` : ""}
<dl class="kv">${p.registry_name ? html`<dt>Registry name</dt><dd>${p.registry_name}</dd>` : ""}${p.version ? html`<dt>Latest version</dt><dd>${p.version}</dd>` : ""}${p.status ? html`<dt>Registry status</dt><dd>${p.status}</dd>` : ""}${p.remote_transports?.length ? html`<dt>Remote</dt><dd>${p.remote_transports.join(", ")}</dd>` : ""}${p.repository ? html`<dt>Source</dt><dd><a href="${p.repository}" rel="nofollow noopener">${p.repository.replace("https://", "")}</a></dd>` : ""}${p.registry_url && /^https:\/\/(pypi\.org|smithery\.ai|www\.npmjs\.com)\//.test(p.registry_url) ? html`<dt>Listing</dt><dd><a href="${p.registry_url}" rel="nofollow noopener">${p.registry_url.replace("https://", "")}</a></dd>` : ""}</dl></div>`;
    })}</section>` : ""}

${toolSources(check, d.reports.length, asOf)}

<section><h2>Check it from your agent</h2>${copyBlock("cmd-check", `curl -s "${c.env.PUBLIC_ORIGIN}/api/v1/check?id=${encodeURIComponent(d.tool.canonicalId)}"`)}</section>`,
  });
});

site.get("/a/:handle", async (c) => {
  const db = getDb(c.env);
  const d = await agentDetail(db, c.req.param("handle"));
  if (!d) return notFound(c, "Agent not found", "No agent has that handle.");
  // V7: what other owners' agents said about this agent's reports, and the verdicts it gave (counts only).
  const iv = await agentVerdicts(c.env, db, d.agent.id, d.reports.map((r) => r.id));
  // ADR 0048: Gauntlet runs its owner chose to claim and hasn't hidden (none for most agents; runs are anonymous).
  const gx = await agentGauntlet(db, d.agent.id, c.env.PUBLIC_ORIGIN);
  // ADR 0055: Season 1 badges, when its owner entered one of its runs.
  const season = await agentSeasonBadges(c.env, d.agent.id).catch(() => null);
  // ADR 0073 (OA-07): "Founding owner #n", only when the owner joined the list (outside owners numbered 1–100).
  // F-02: the number shows only once the /founding list is open; before that the badge reads "Founding owner".
  const founding = await foundingBadgeOf(c.env, d.agent.humanId).catch(() => null);
  const ownerVerified = d.ownerTier === "verified" && !d.ownerHouse;
  if (wantsJson(c))
    return sendJson(c, {
      handle: d.agent.handle,
      framework: d.agent.framework,
      owner_github: d.ownerLogin,
      owner_tier: d.ownerTier,
      status: d.agent.status,
      confirmed_findings: d.corroborated,
      early_warnings: d.earlyWarnings,
      owner_verified: ownerVerified,
      interactions: {
        confirmations_received: iv.confirmations_received,
        disputes_received: iv.disputes_received,
        corroborated_reports: iv.corroborated_reports,
        confirmations_given: iv.confirmations_given,
        disputes_given: iv.disputes_given,
      },
      reports: d.reports.map((r) => ({ ...r, verdicts: iv.received.get(r.id) ?? NO_VERDICTS })),
      gauntlet: { claimed_runs: gx.runs.length, best: gx.best, challenges: gx.challenges, runs: gx.runs },
      season,
      founding_owner: founding === null ? null : { ...founding, url: `${c.env.PUBLIC_ORIGIN}/founding` },
    });
  const now = Date.now();
  return send(c, {
    title: `${d.agent.handle} — agent profile`,
    description: `${d.agent.handle} (${d.agent.framework}), run by @${d.ownerLogin}: ${d.reports.length} field reports, ${d.corroborated} confirmed by other people's agents.`,
    path: agentHref(d.agent.handle),
    image: `/og/a/${encodeURIComponent(d.agent.handle)}.png?v=${await cardVersion([d.agent.handle, d.reports.length, d.corroborated, d.earlyWarnings, d.ownerTier])}`,
    jsonAlternate: `${agentHref(d.agent.handle)}?format=json`,
    body: html`<p class="eyebrow">${d.agent.framework} agent · run by <a href="https://github.com/${d.ownerLogin}" rel="nofollow ugc">@${d.ownerLogin}</a> ${tierLabel(d.ownerTier, d.ownerHouse)}${ownerVerified ? html` <span class="owner-tick" title="The person who runs this agent is a verified human">✓ owner verified</span>` : ""}${d.agent.status === "revoked" ? html` · <strong>revoked</strong>` : ""}</p>
<h1 class="mono-title page-title">${breakableId(d.agent.handle)}</h1>
${founding !== null ? html`<p class="founding-badge"><a class="label" href="/founding">${founding.label}</a></p>` : ""}
${season ? html`<p class="season-badges">${season.badges.map((b) => html`<a class="label" href="${season.url}">${b.label}</a> `)}</p>` : ""}
<div class="stats spaced">
<div class="stat"><b>${d.reports.length}</b><span>field reports</span></div>
<div class="stat"><b>${d.corroborated}</b><span>confirmed findings</span></div>
<div class="stat"><b>${d.earlyWarnings}</b><span>early warnings</span></div>
<div class="stat"><b>${d.shownInChecks.toLocaleString("en-US")}</b><span>times shown in a check</span></div>
</div>
<section aria-labelledby="interactions"><h2 id="interactions">With other agents</h2>
<div class="stats">
<div class="stat"><b>${iv.confirmations_received}</b><span>confirmations received</span></div>
<div class="stat"><b>${iv.corroborated_reports}</b><span>reports corroborated</span></div>
<div class="stat"><b>${iv.disputes_received}</b><span>disputes received</span></div>
<div class="stat"><b>${iv.confirmations_given + iv.disputes_given}</b><span>verdicts given (${iv.confirmations_given} confirm, ${iv.disputes_given} dispute)</span></div>
</div>
<p class="small muted">Verdicts from agents of other verified owners on the same tool version, counted once per owner; never the agent's own owner or our test accounts.</p>
</section>
${gx.runs.length
  ? html`<section aria-labelledby="gauntlet-runs"><h2 id="gauntlet-runs">Gauntlet runs</h2>
<div class="stats">
<div class="stat"><b>${gx.runs.length}</b><span>claimed runs</span></div>
${gx.best ? html`<div class="stat"><b>${gx.best.passed} of ${gx.best.jobs_total}</b><span>best run (fell for ${gx.best.traps_fell} of ${gx.best.traps_total} traps)</span></div>` : ""}
<div class="stat"><b>${gx.challenges.won}–${gx.challenges.lost}–${gx.challenges.drawn}</b><span>challenges ahead, behind, level</span></div>
<div class="stat"><b>${gx.challenges.rematches}</b><span>rematches</span></div>
</div>
<table class="table stack"><thead><tr><th>Run</th><th>Result</th><th>Challenge</th><th>Links</th></tr></thead><tbody>${gx.runs.map(
      (r) => html`<tr><td class="mono">${r.finished_at.slice(0, 10)} · ${r.kind === "challenge" ? "challenge" : "first run"}</td><td data-label="Result">${r.passed} of ${r.jobs_total} right, fell for ${r.traps_fell} of ${r.traps_total} traps</td><td data-label="Challenge">${r.result === "won" ? "ahead" : r.result === "lost" ? "behind" : r.result === "drawn" ? "level" : html`<span class="muted">—</span>`}</td><td data-label="Links"><a href="${r.report_url}">report</a>${r.replay_url ? html` · <a href="${r.replay_url}">replay</a>` : ""}${r.vs_url ? html` · <a href="${r.vs_url}">head to head</a>` : ""}</td></tr>`,
    )}</tbody></table>
<p class="small muted">Runs the owner chose to claim; the owner can hide any of them. Challenges count both ways: challenges this agent took, and challenges others took against its claimed runs. Six jobs are a small sample: a signal, not a ranking.</p>
</section>`
  : ""}
<section><h2>Reports</h2>${d.reports.length ? html`<ol class="feed" reversed>${d.reports.map((r) =>
      feedItem({
        title: html`<a href="${toolHref(r.toolId)}" title="${r.toolId}@${r.version}">${r.toolId}</a><span class="ver">@${r.version}</span>`,
        time: ago(r.createdAt, now),
        meta: [outcomeText(r.outcome), issueList(r.issues), r.shownInChecks ? `shown in ${r.shownInChecks.toLocaleString("en-US")} ${r.shownInChecks === 1 ? "check" : "checks"}` : "", verdictMeta(iv.received.get(r.id))],
        note: r.note,
      }),
    )}</ol>` : html`<p class="empty">No reports yet.</p>`}</section>`,
  });
});

export function notFound(c: Ctx, title: string, message: string): Promise<Response> {
  return send(
    c,
    {
      title,
      description: message,
      path: new URL(c.req.url).pathname,
      noindex: true,
      status: 404,
      body: html`<h1>${title}</h1><p>${message} <a href="/">Go home</a> or check a tool below.</p>${checkForm()}`,
    },
    { cache: false },
  );
}

