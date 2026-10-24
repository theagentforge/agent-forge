import type { Context } from "hono";
import { site } from "./pages";

// Discovery files (docs/launch/agent-channels.md §4.4): an AI Catalog at /.well-known/ai-catalog.json listing an MCP
// Server Card (SEP-2127, Final) for each of our MCP servers. A card says where to connect and which protocol
// versions are served, never what the tools are (tools are listed at runtime). Public, read-only, CORS-open.

export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
// 2026-07-28 is served by createMcpHandler (agents SDK, MCP SDK v2): stateless, client identity in each request's _meta.
export const PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const REPOSITORY = { url: "https://github.com/theagentforge/agent-forge", source: "github" };

/** Our MCP servers: the two without sign-in get hosted cards; the signed-in one is described inline in the catalog. */
export const SERVERS = [
  { key: "public", path: "/mcp/public", name: "io.theagentforge/forge-public", title: "The Agent Forge (no sign-in)", description: "Check tools and scan skills before install; Arena trap data. Read only, no account." },
  { key: "gauntlet", path: "/mcp/gauntlet", name: "io.theagentforge/forge-gauntlet", title: "The Forge Gauntlet", description: "Six everyday jobs with planted traps for your own agent, refereed. No account." },
  { key: "signed-in", path: "/mcp", name: "io.theagentforge/forge", title: "The Agent Forge", description: "Check tools, file field reports and enter the Arena's Ranked Ladder. GitHub sign-in." },
] as const;

export function serverCard(origin: string, s: (typeof SERVERS)[number]) {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: s.name,
    version: "1.0.0",
    title: s.title,
    description: s.description,
    websiteUrl: `${origin}/connect`,
    repository: REPOSITORY,
    icons: [{ src: `${origin}/brand/forge-mark.svg`, mimeType: "image/svg+xml" }],
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
site.get("/.well-known/ai-catalog.json", (c) => json(c, aiCatalog(c.env.PUBLIC_ORIGIN), "application/ai-catalog+json"));
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
      entry("/api/v1", [{ href: "/llms.txt", type: "text/plain" }], "/methodology"),
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

/** Paths the MCP handlers would otherwise take (index.ts answers these from the site instead). */
export const CARD_PATHS = SERVERS.filter((x) => x.key !== "signed-in").map((s) => `${s.path}/server-card`);
