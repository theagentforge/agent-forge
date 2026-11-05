// What each of our MCP servers says about itself, in one place: serverInfo in the initialize (and server/discover)
// answer, the MCP Server Cards (web/discovery.ts) and the MCP Registry listing (integrations/registry/server.json) all
// read from here or are checked against it (test/discovery.test.ts). Catalogs such as Glama and mcpbeat show
// serverInfo, so it carries the same title, description, website and icon as the cards (ADR 0052).

/** The MCP server version: the same in serverInfo, every Server Card and the MCP Registry listing. */
export const MCP_SERVER_VERSION = "0.5.1";
export const SERVER_ICON_PATH = "/brand/forge-mark.svg";

/**
 * ADR 0123: one Arena-first sentence on every surface (serverInfo, Server Cards, the A2A Agent Card, the MCP Registry
 * listing and the forge-mcp manifests), the MCP Registry's own wording; each surface adds only what is its own.
 */
export const ARENA_FIRST = "See which AI models fall for traps in real jobs, and check MCP servers or skills before install.";

/** Our MCP servers: the two without sign-in get hosted cards; the signed-in one is described inline in the catalog. */
export const SERVERS = [
  { key: "public", path: "/mcp/public", serverName: "the-agent-forge-public", name: "io.theagentforge/forge-public", title: "The Agent Forge (no sign-in)", description: ARENA_FIRST, websitePath: "/connect" },
  { key: "gauntlet", path: "/mcp/gauntlet", serverName: "the-agent-forge-gauntlet", name: "io.theagentforge/forge-gauntlet", title: "The Forge Gauntlet", description: "See whether your own agent falls for the traps AI models fall for: six refereed jobs. No account.", websitePath: "/gauntlet" },
  // ADR 0131: anonymous test requests, kept off /mcp/public so that endpoint stays read-only.
  { key: "requests", path: "/mcp/requests", serverName: "the-agent-forge-requests", name: "io.theagentforge/forge-requests", title: "The Agent Forge test requests", description: "Queue a public npm or PyPI MCP server at an exact version for the House tester's next sweep, and read its dated result. No account.", websitePath: "/request-a-test" },
  { key: "signed-in", path: "/mcp", serverName: "the-agent-forge", name: "io.theagentforge/forge", title: "The Agent Forge", description: ARENA_FIRST, websitePath: "/connect" },
] as const;

export type ServerKey = (typeof SERVERS)[number]["key"];

/** The MCP `Implementation` object (serverInfo) for one of our servers. Its `name` stays what clients already know. */
export function serverInfo(origin: string, key: ServerKey) {
  const s = SERVERS.find((x) => x.key === key)!;
  return {
    name: s.serverName,
    title: s.title,
    version: MCP_SERVER_VERSION,
    description: s.description,
    websiteUrl: `${origin}${s.websitePath}`,
    icons: [{ src: `${origin}${SERVER_ICON_PATH}`, mimeType: "image/svg+xml" }],
  };
}
