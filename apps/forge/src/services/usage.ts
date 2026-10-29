import { and, gte, like, sql } from "drizzle-orm";
import { isLean } from "./ops-mode";
import * as t from "../db/schema";
import { getDb } from "./db";
import { type InternalComponent, internalCaller, internalClient, internalKey } from "./internal";
import { isDirectoryClient } from "./agent-funnel";

/**
 * ADR 0067: a forge_scan call whose `_meta` names a directory, catalogue or checker client (agentrank-probe,
 * mcpscore...) is also counted under this key, and taken off the third-party skill-scan numbers. Calls that don't name
 * their client (the 2025 protocol) can't be told apart. Counted on the call, so a failed scan is taken off too: the
 * error is always toward fewer outside scans, never more.
 */
export const CATALOG_SCAN_KEY = "scan:mcp:catalog";

// Proof of use (Dinike, 16 Oct 2026): how many AI apps connect to the Forge's MCP endpoints, and what they call.
// Daily totals only, in the spirit of the Privacy Policy's "daily count": the request body is read for its JSON-RPC
// method, tool name and client app name, and nothing about the person, IP or session is kept.

/** "house" is a signed-in session by one of our own accounts (ADR 0023 §3): counted apart, never as usage. */
export type McpEndpoint = "public" | "gauntlet" | "signed_in" | "house";
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Client app names as the MCP client reports them ("claude-ai", "cursor"…), squeezed to a safe, short label. */
export const clientLabel = (name: unknown) => {
  const s = typeof name === "string" ? name.toLowerCase().replace(/[^a-z0-9 ._-]/g, "").trim().slice(0, 40) : "";
  return s || "unknown";
};

/**
 * The client app named in a request's `_meta` (MCP 2026-07-28 is stateless, so a call can carry the client identity
 * itself instead of an `initialize`). Any `_meta` key ending in "clientInfo" counts, such as
 * "io.modelcontextprotocol/clientInfo". Null when there is none.
 */
export function metaClient(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  for (const [k, v] of Object.entries(meta).slice(0, 20)) {
    if (/clientinfo$/i.test(k) && v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string") return clientLabel((v as { name: string }).name);
  }
  return null;
}

/** The raw client name in a request's `_meta` (before squeezing), for spotting our own callers. */
function metaClientName(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return null;
  for (const [k, v] of Object.entries(meta).slice(0, 20)) if (/clientinfo$/i.test(k) && v && typeof v === "object") return (v as { name?: unknown }).name;
  return null;
}

/** True for a 2026-07-28-era request: its `_meta` carries the per-request protocol version, so there's no `initialize`. */
export function isModernRequest(meta: unknown) {
  if (!meta || typeof meta !== "object") return false;
  return Object.entries(meta).some(([k, v]) => /protocolversion$/i.test(k) && typeof v === "string" && v >= "2026");
}

/**
 * The counters one MCP request adds: a session per `initialize`, a call per `tools/call` (background traffic like
 * pings isn't use). A 2026-07-28 client never sends `initialize`, so its `tools/list` (every client fetches the tool
 * list once before using a tool) counts as its session, with the client name from `_meta`. A call that names its
 * client in `_meta` also adds `mcp:clientcall:<name>`. First-seen client names are worked out from these daily rows
 * (services/scout-signals.ts).
 */
export function mcpCounters(endpoint: McpEndpoint, body: unknown, internal: InternalComponent | null = null): string[] {
  const msgs = (Array.isArray(body) ? body : [body]).slice(0, 10) as { method?: unknown; params?: { name?: unknown; clientInfo?: { name?: unknown }; _meta?: unknown } }[];
  const keys: string[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    // Our own callers (services/internal.ts), by header or by client name, add only `internal:<component>:*`: never a
    // session, a client name or a tool call in the agent counts.
    const ours = internal ?? internalClient(m.params?.clientInfo?.name) ?? internalClient(metaClientName(m.params?._meta));
    if (ours) {
      if (m.method === "initialize" || (m.method === "tools/list" && isModernRequest(m.params?._meta))) keys.push(internalKey(ours, "sessions"));
      if (m.method === "tools/call") keys.push(internalKey(ours, "calls"));
      continue;
    }
    // House sessions add only their own totals, never the app or tool lists people outside the project make.
    const house = endpoint === "house";
    if (m.method === "initialize") keys.push(`mcp:${endpoint}:sessions`, ...(house ? [] : [`mcp:client:${clientLabel(m.params?.clientInfo?.name)}`]));
    if (m.method === "tools/list" && isModernRequest(m.params?._meta))
      keys.push(`mcp:${endpoint}:sessions`, ...(house ? [] : [`mcp:client:${metaClient(m.params?._meta) ?? "unknown"}`]));
    if (m.method === "tools/call" && typeof m.params?.name === "string" && /^[a-z_]{1,40}$/.test(m.params.name)) {
      const meta = house ? null : metaClient(m.params._meta);
      keys.push(`mcp:${endpoint}:calls`, ...(house ? [] : [`mcp:tool:${m.params.name}`]), ...(meta ? [`mcp:clientcall:${meta}`] : []));
      if (!house && meta && m.params.name === "forge_scan" && isDirectoryClient(meta)) keys.push(CATALOG_SCAN_KEY);
    }
  }
  return keys;
}

export async function bump(env: Env, keys: string[], now = Date.now()) {
  if (!keys.length || (await isLean(env))) return;
  const db = getDb(env);
  const d = day(now);
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  await db
    .insert(t.usageDaily)
    .values([...counts].map(([key, n]) => ({ day: d, key, n })))
    .onConflictDoUpdate({ target: [t.usageDaily.day, t.usageDaily.key], set: { n: sql`${t.usageDaily.n} + excluded.n` } });
}

/**
 * Reads a POSTed MCP request's body (without consuming the original) and counts it. Never throws. `internal` is set
 * for our own callers (services/internal.ts), whose traffic is counted apart.
 */
export async function recordMcp(env: Env, endpoint: McpEndpoint, request: Request, now = Date.now(), internal: InternalComponent | null = null) {
  try {
    if (request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > 65_536) return;
    await bump(env, mcpCounters(endpoint, JSON.parse(await request.text()), internal ?? internalCaller(request.headers)), now);
  } catch {
    // Not JSON, or the database is busy: usage counts must never break the endpoint.
  }
}

/** Totals over the last `days` days (today included) for /stats and the ops digest. */
export async function usageStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), like(t.usageDaily.key, "mcp:%")))
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  const top = (prefix: string) =>
    rows
      .filter((r) => r.key.startsWith(prefix))
      .map((r) => ({ name: r.key.slice(prefix.length), n: Number(r.n) }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, 5);
  return {
    days,
    mcp_sessions: get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions"),
    mcp_sessions_public: get("mcp:public:sessions"),
    mcp_sessions_gauntlet: get("mcp:gauntlet:sessions"),
    mcp_sessions_signed_in: get("mcp:signed_in:sessions"),
    mcp_tool_calls: get("mcp:public:calls") + get("mcp:gauntlet:calls") + get("mcp:signed_in:calls"),
    /** Our own signed-in sessions (House and founder accounts), never part of the totals above. */
    house_mcp_sessions: get("mcp:house:sessions"),
    house_mcp_tool_calls: get("mcp:house:calls"),
    top_clients: top("mcp:client:"),
    top_tools: top("mcp:tool:"),
  };
}

// Where visitors come from (Dinike, 17 Oct 2026: "are our X posts working?"). Daily totals only, like the MCP counts:
// the referring site is reduced to a fixed source label and a link's own `?from=`/`?ref=`/`utm_source` tag to a short
// label. No IP, no path, no cookie, nothing about the person. Bots and link-preview fetchers aren't counted.

const SOURCES: [RegExp, string][] = [
  [/(^|\.)(t\.co|x\.com|twitter\.com)$/, "x"],
  [/(^|\.)news\.ycombinator\.com$/, "hn"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, "linkedin"],
  [/(^|\.)bsky\.app$/, "bluesky"],
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave)\.[a-z.]+$|(^|\.)search\.brave\.com$/, "search"],
  [/(^|\.)(chatgpt\.com|claude\.ai|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com)$/, "ai-chat"],
];
// Crawlers that don't say "bot" are listed by name (seen in our Cloudflare logs, 18–22 Oct 2026: GoogleOther,
// meta-externalagent, Ziwei-Seat), so "visitors" means people again.
const BOT_UA =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|externalagent|externalfetcher|googleother|google-extended|google-inspectiontool|embedly|curl|wget|python|go-http|headless|lighthouse|monitor|scrap|fetcher|httpclient|axios|node-fetch|okhttp|java\/|libwww|-seat\/|^$/i;

/**
 * True when a page request looks like a person's browser: not a crawler or script user agent, not one of our own
 * probes. For daily counters bumped on a plain GET (ADR 0065), so crawlers that ignore robots.txt don't inflate them.
 */
export const likelyPerson = (headers: Pick<Headers, "get">) => !BOT_UA.test(headers.get("user-agent") ?? "") && !internalCaller(headers);

/** Source label for a Referer header: "direct" when there is none, "internal" for our own pages, "other" otherwise. */
export function sourceLabel(referer: string | null | undefined, origin: string) {
  if (!referer) return "direct";
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === new URL(origin).hostname || host.endsWith(".theagentforge.io")) return "internal";
  return SOURCES.find(([re]) => re.test(host))?.[1] ?? "other";
}

/**
 * The counters one page view adds. Every GET page view counts in the gross total, `visit:all` (Dinike, 23 Oct: "I want
 * to see the full gross large number"), and crawlers also in `visit:crawler`. People arriving from outside the site
 * (not crawlers, not our own internal navigation) also count as `visit:arrivals`, by source and link tag.
 */
export function visitCounters(req: { method: string; url: string; headers: Headers }, origin: string): string[] {
  if (req.method !== "GET") return [];
  // Our own probes (services/internal.ts) stay in the gross page views only, like everything else, and nowhere else.
  if (internalCaller(req.headers)) return ["visit:all"];
  if (BOT_UA.test(req.headers.get("user-agent") ?? "")) return ["visit:all", "visit:crawler"];
  // People opening /connect, from anywhere (our own pages included): the step before an AI connects.
  const connect = new URL(req.url).pathname === "/connect" ? ["visit:connect"] : [];
  const source = sourceLabel(req.headers.get("referer"), origin);
  if (source === "internal") return ["visit:all", ...connect];
  const q = new URL(req.url).searchParams;
  const tag = (q.get("from") ?? q.get("ref") ?? q.get("utm_source") ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return ["visit:all", ...connect, "visit:arrivals", `visit:src:${source}`, ...(tag ? [`visit:tag:${tag}`] : [])];
}

/**
 * People, measured the only way crawlers rarely fake (Dinike, 23 Oct: the site shows every visit; internally we measure
 * real people against crawlers): site.js sends one empty beacon per page load, and the Worker counts it per day as
 * `visit:human` and by kind of page. Browsers driven by automation (navigator.webdriver) don't send it; bot user agents
 * and other sites' pages aren't counted. Nothing about the person is kept.
 */
export function humanCounters(req: { method: string; headers: Headers }, origin: string): string[] {
  if (req.method !== "POST" || BOT_UA.test(req.headers.get("user-agent") ?? "") || internalCaller(req.headers)) return [];
  const site = req.headers.get("sec-fetch-site");
  const from = req.headers.get("origin") ?? req.headers.get("referer") ?? "";
  if (site ? site !== "same-origin" : !from.startsWith(origin)) return [];
  let path = "/";
  try {
    path = new URL(req.headers.get("referer") ?? origin).pathname;
  } catch {
    // no page known: counted as "other"
  }
  return ["visit:human", `visit:human:${humanPageKind(path)}`];
}

/** The kind of page a person was on, for `visit:human:<kind>`. */
export const humanPageKind = (path: string) =>
  path === "/"
    ? "home"
    : path.startsWith("/reports/")
      ? "report"
      : path === "/connect"
        ? "connect"
        : path.startsWith("/scan") || path === "/skill-watch"
          ? "scan"
          : /^\/(arena|best|gauntlet|trap-card|lab)(\/|$)/.test(path)
            ? "arena"
            : /^\/(t|tools)\//.test(path)
              ? "tool"
              : "other";

/** Arrivals by source and by link tag over the last `days` days, for the ops digest and /api/v1/growth. */
export async function visitStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), like(t.usageDaily.key, "visit:%")))
    .groupBy(t.usageDaily.key);
  const list = (prefix: string) =>
    rows
      .filter((r) => r.key.startsWith(prefix))
      .map((r) => ({ name: r.key.slice(prefix.length), n: Number(r.n) }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const n = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  return { days, page_views: n("visit:all"), crawler_page_views: n("visit:crawler"), arrivals: n("visit:arrivals"), by_source: list("visit:src:"), by_tag: list("visit:tag:").slice(0, 10) };
}

// AI agent traffic (docs/launch/agent-channels.md §4.5): AI user agents are dropped from visit counts as bots, so
// they're counted here instead, in three groups. Indexers build AI search; live fetches happen while a person waits for
// an answer; coding agents are tools like Claude Code. Daily totals by group, agent and kind of page; nothing else.
const AI_AGENTS: [RegExp, "indexer" | "live" | "coding", string][] = [
  [/OAI-SearchBot/i, "indexer", "openai"],
  [/Claude-SearchBot/i, "indexer", "anthropic"],
  [/PerplexityBot/i, "indexer", "perplexity"],
  [/ChatGPT-User/i, "live", "openai"],
  [/Claude-User/i, "live", "anthropic"],
  [/Perplexity-User/i, "live", "perplexity"],
  [/claude-code|claude-cli/i, "coding", "claude-code"],
  [/\bcursor\b/i, "coding", "cursor"],
  [/\bcodex\b/i, "coding", "codex"],
  [/windsurf|codeium/i, "coding", "windsurf"],
];

/** The kind of page an AI agent fetched, for the counters. */
export const aiPageKind = (path: string) =>
  path.startsWith("/tools/") ? "tools" : path === "/llms.txt" ? "llms" : path === "/skill.md" || path.startsWith("/.well-known/agent-skills/") || path.startsWith("/.well-known/skills/") ? "skills" : path.startsWith("/scan/") ? "scan" : path.startsWith("/.well-known/") ? "discovery" : "other";

export function aiAgentCounters(req: { method: string; url: string; headers: Headers }): string[] {
  if (req.method !== "GET" || internalCaller(req.headers)) return [];
  const ua = req.headers.get("user-agent") ?? "";
  const hit = AI_AGENTS.find(([re]) => re.test(ua));
  if (!hit) return [];
  const [, group, name] = hit;
  return [`ai:${group}`, `ai:${group}:${name}`, `ai:${group}:page:${aiPageKind(new URL(req.url).pathname)}`];
}

/**
 * Fetches of the files agents discover us by, for the agent funnel's first stage. Counted in the site middleware,
 * before the edge cache, so cached copies count too. llms.txt read in a browser isn't counted.
 */
export function discoveryCounters(req: { method: string; url: string; headers: Headers }): string[] {
  if (req.method !== "GET") return [];
  const path = new URL(req.url).pathname;
  // Our own Scout collector reads these files every day for listing health: counted apart, never as discovery.
  const ours = internalCaller(req.headers);
  if (ours) return [internalKey(ours, "fetches")];
  if (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json") return ["disc:agent-card"];
  if (path === "/.well-known/ai-catalog.json") return ["disc:ai-catalog"];
  if (path === "/.well-known/ard.json") return ["disc:ard"];
  if (path === "/.well-known/api-catalog") return ["disc:api-catalog"];
  if (path === "/mcp/public/server-card") return ["disc:server-card-public"];
  if (path === "/mcp/gauntlet/server-card") return ["disc:server-card-gauntlet"];
  if (path === "/.well-known/mcp.json" || path === "/.well-known/mcp/server-card.json" || path === "/.well-known/mcp") return ["disc:server-card-well-known"];
  if (path === "/.well-known/agent-skills/index.json" || path === "/.well-known/skills/index.json") return ["skills:index"];
  const file = /^\/\.well-known\/(agent-skills|skills)\/([a-z0-9-]+)\/SKILL\.md$/.exec(path);
  if (file) return [`skills:file:${file[2]}`];
  if (path === "/llms.txt" && !/text\/html/.test(req.headers.get("accept") ?? "")) return ["disc:llms-txt"];
  return [];
}

/** AI agent traffic over the last `days` days, for the ops digest and /api/v1/growth. */
export async function aiAgentStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), like(t.usageDaily.key, "ai:%")))
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  const group = (g: string) => ({
    total: get(`ai:${g}`),
    by_agent: Object.fromEntries(rows.filter((r) => r.key.startsWith(`ai:${g}:`) && !r.key.includes(":page:")).map((r) => [r.key.slice(`ai:${g}:`.length), Number(r.n)])),
    by_page: Object.fromEntries(rows.filter((r) => r.key.startsWith(`ai:${g}:page:`)).map((r) => [r.key.slice(`ai:${g}:page:`.length), Number(r.n)])),
  });
  return { days, indexers: group("indexer"), live_fetches: group("live"), coding_agents: group("coding") };
}

// Skill checks (ADR 0026), the launch metric: scans by where they came from, weekly-watch check-ins (agents coming
// back by themselves) and fetches of /skill.md by agents (the nearest thing to an install count). Daily totals only.

export type ScanChannel = "web" | "api" | "mcp" | "a2a";
export const scanCounters = (channel: ScanChannel, verdict: string) => [`scan:${channel}`, `scan:verdict:${verdict.replace(/[^a-z]/g, "")}`];
export const watchCounters = (fingerprints: number) => ["watch:calls", ...Array<string>(Math.min(Math.max(fingerprints, 0), 100)).fill("watch:fingerprints")];

const CRAWLER_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|lighthouse|monitor/i;
/** A fetch of the agent skill file: a browser (someone reading it), an agent (curl, fetch tools, MCP clients), or a crawler (not counted). */
export function skillFileCounters(req: { method: string; headers: Headers }): string[] {
  if (req.method !== "GET" || CRAWLER_UA.test(req.headers.get("user-agent") ?? "") || internalCaller(req.headers)) return [];
  return [/text\/html/.test(req.headers.get("accept") ?? "") ? "skillmd:browser" : "skillmd:agent"];
}

/** Skill-check totals over the last `days` days, for /stats, /api/v1/growth and the ops digest. */
export async function skillStats(env: Env, now = Date.now(), days = 7) {
  const db = getDb(env);
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), sql`(${t.usageDaily.key} like 'scan:%' or ${t.usageDaily.key} like 'watch:%' or ${t.usageDaily.key} like 'skillmd:%' or ${t.usageDaily.key} like 'a2a:%')`))
    .groupBy(t.usageDaily.key);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  return {
    days,
    /** ADR 0067: forge_scan calls by named directory and checker clients are taken off (CATALOG_SCAN_KEY). */
    scans: Math.max(0, get("scan:web") + get("scan:api") + get("scan:mcp") + get("scan:a2a") - get(CATALOG_SCAN_KEY)),
    scans_by_channel: { web: get("scan:web"), api: get("scan:api"), mcp: get("scan:mcp"), a2a: get("scan:a2a") },
    scans_flagged: get("scan:verdict:flagged"),
    watch_checkins: get("watch:calls"),
    watch_fingerprints: get("watch:fingerprints"),
    skill_file_agent_fetches: get("skillmd:agent"),
    skill_file_browser_views: get("skillmd:browser"),
    /** Requests from other agents over A2A (/a2a), and how many asked for each skill. */
    a2a_requests: get("a2a:requests"),
    a2a_by_skill: { check_tool: get("a2a:skill:check-tool"), scan_skill: get("a2a:skill:scan-skill"), trap_card: get("a2a:skill:trap-card"), arena_results: get("a2a:skill:arena-results") },
  };
}
