import { KEYS_PATH } from "@forge/arena";
import type { Context } from "hono";
import { MCP_SERVER_VERSION, SERVER_ICON_PATH, SERVERS } from "../server-info";
import { keySet } from "../services/replay-keys";
import { site } from "./pages";

// Discovery files (docs/launch/agent-channels.md §4.4): an AI Catalog at /.well-known/ai-catalog.json listing an MCP
// Server Card (SEP-2127, Final) for each of our MCP servers. A card says where to connect and which protocol
// versions are served, never what the tools are (tools are listed at runtime). Public, read-only, CORS-open.

export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
// 2026-07-28 is served by createMcpHandler (agents SDK, MCP SDK v2): stateless, client identity in each request's _meta.
export const PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
// The MIT connection-files repo that directories point to (ADR 0033), the same as the MCP Registry listing.
const REPOSITORY = { url: "https://github.com/theagentforge/forge-mcp", source: "github" };
export { SERVERS };

export function serverCard(origin: string, s: (typeof SERVERS)[number]) {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: s.name,
    version: MCP_SERVER_VERSION,
    title: s.title,
    description: s.description,
    websiteUrl: `${origin}${s.websitePath}`,
    repository: REPOSITORY,
    icons: [{ src: `${origin}${SERVER_ICON_PATH}`, mimeType: "image/svg+xml" }],
    remotes: [{ type: "streamable-http", url: `${origin}${s.path}`, supportedProtocolVersions: PROTOCOL_VERSIONS }],
  };
}

export function aiCatalog(origin: string) {
  const host = new URL(origin).hostname;
  return {
    specVersion: "1.0",
    entries: SERVERS.map((s) =>
      s.key === "signed-in"
        ? { identifier: `urn:air:${host}:mcp:forge`, type: "application/mcp-server-card+json", data: serverCard(origin, s) }
        : { identifier: `urn:air:${host}:mcp:${s.name.split("/")[1]}`, type: "application/mcp-server-card+json", url: `${origin}${s.path}/server-card` },
    ),
  };
}

export const WELL_KNOWN_MCP = ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp"];

const open = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" };
const json = (c: Context<{ Bindings: Env }>, body: unknown, type: string) => c.body(JSON.stringify(body), 200, { ...open, "Content-Type": `${type}; charset=utf-8` });

// Fetches are counted in the site middleware, before the cache (services/usage.ts discoveryCounters).
// Replay format v2 (ADR 0066): the public Ed25519 keys that sign replay seals, with key ids and rotation rules.
site.get(KEYS_PATH, async (c) => c.json(await keySet(c.env), 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
site.get("/.well-known/ai-catalog.json", (c) => json(c, aiCatalog(c.env.PUBLIC_ORIGIN), "application/ai-catalog+json"));
// ARD v0.91 (26 Aug 2026) moved the AI Catalog to /.well-known/ard.json; registries such as Ora's directory, HF Discover
// and the apis.io grader crawl that path. The same document under both paths.
export const ARD_PATH = "/.well-known/ard.json";
site.get(ARD_PATH, (c) => json(c, aiCatalog(c.env.PUBLIC_ORIGIN), "application/ai-catalog+json"));
for (const s of SERVERS.filter((x) => x.key !== "signed-in"))
  site.get(`${s.path}/server-card`, (c) => json(c, serverCard(c.env.PUBLIC_ORIGIN, s), "application/mcp-server-card+json"));
// Older well-known spellings some clients and directories try first (Worker logs, 23 Oct). The no-sign-in card.
for (const path of WELL_KNOWN_MCP)
  site.get(path, (c) => json(c, serverCard(c.env.PUBLIC_ORIGIN, SERVERS[0]), "application/mcp-server-card+json"));

/**
 * The API catalog (RFC 9727): one linkset entry per API we offer, each pointing at what describes it. Served at
 * /.well-known/api-catalog as application/linkset+json, and linked from every page (pages.ts DISCOVERY_LINKS).
 */
export function apiCatalog(origin: string) {
  const entry = (anchor: string, desc: { href: string; type: string }[], doc: string) => ({
    anchor: `${origin}${anchor}`,
    "service-desc": desc.map((d) => ({ href: `${origin}${d.href}`, type: d.type })),
    "service-doc": [{ href: `${origin}${doc}`, type: "text/html" }],
  });
  return {
    linkset: [
      entry("/mcp/public", [{ href: "/mcp/public/server-card", type: "application/mcp-server-card+json" }], "/connect"),
      entry("/mcp/gauntlet", [{ href: "/mcp/gauntlet/server-card", type: "application/mcp-server-card+json" }], "/gauntlet"),
      entry("/a2a", [{ href: "/.well-known/agent-card.json", type: "application/json" }], "/connect"),
      // The OpenAPI 3.1 spec first (web/openapi.ts); llms.txt stays as a second, plain-text description.
      entry("/api/v1", [{ href: "/openapi.json", type: "application/openapi+json" }, { href: "/llms.txt", type: "text/plain" }], "/methodology"),
    ],
  };
}
site.get("/.well-known/api-catalog", (c) =>
  c.body(JSON.stringify(apiCatalog(c.env.PUBLIC_ORIGIN)), 200, {
    ...open,
    "Content-Type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    Link: '</.well-known/api-catalog>; rel="api-catalog"',
  }),
);

/**
 * OpenAI's plugin directory checks domain ownership with a token served here (docs/launch/directory-submissions.md).
 * The token is shown in Dinike's OpenAI dashboard and isn't secret; it's stored in KV `openai:apps-challenge`.
 */
export const OPENAI_CHALLENGE_KEY = "openai:apps-challenge";
site.get("/.well-known/openai-apps-challenge", async (c) => {
  const token = (await c.env.KV.get(OPENAI_CHALLENGE_KEY))?.trim();
  if (!token || !/^[A-Za-z0-9._-]{8,200}$/.test(token)) return c.text("Not found", 404, { "Cache-Control": "no-store" });
  return c.text(token, 200, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
});

/**
 * security.txt (RFC 9116), read by security scanners: where to report a vulnerability, the same contact as SECURITY.md
 * in the public code repo. Expires is required and must stay under a year away, so it is always 180 days ahead.
 */
export const SECURITY_TXT_PATH = "/.well-known/security.txt";
export function securityTxt(origin: string, now = Date.now()) {
  const expires = new Date(now + 180 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    "Contact: mailto:hello@theagentforge.io",
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${origin}${SECURITY_TXT_PATH}`,
    "Policy: https://github.com/theagentforge/agent-forge/blob/main/SECURITY.md",
    "",
  ].join("\n");
}
site.get(SECURITY_TXT_PATH, (c) =>
  c.body(securityTxt(c.env.PUBLIC_ORIGIN), 200, { ...open, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" }),
);

/**
 * CORS preflights for the public, read-only discovery files. A plain GET needs none, but a browser-based agent that
 * adds a header (MCP-Protocol-Version, If-None-Match) asks first, and got a 404 page (26 Oct check).
 */
export const PREFLIGHT_PATHS = [
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
  "/.well-known/ai-catalog.json",
  ARD_PATH,
  "/.well-known/api-catalog",
  "/.well-known/agent-skills/index.json",
  SECURITY_TXT_PATH,
  ...WELL_KNOWN_MCP,
  "/openapi.json",
  "/llms.txt",
  "/skill.md",
  "/trap-card.json",
  "/trap-card.txt",
];
for (const path of PREFLIGHT_PATHS)
  site.options(path, (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    }),
  );

/** Paths the MCP handlers would otherwise take (index.ts answers these from the site instead). */
export const CARD_PATHS = SERVERS.filter((x) => x.key !== "signed-in").map((s) => `${s.path}/server-card`);
