import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isDirectoryClient } from "../src/services/agent-funnel";
import { discoveryCounters } from "../src/services/usage";
import { fetchWorker } from "./helpers";
import "../src/index";

// Conversion gaps (traffic review 24 Oct 2026): the addresses agents tried that answered 405, 404 or a bare 401, and
// the directory probes that were being counted as connections.

const host = new URL(env.PUBLIC_ORIGIN).host;
const initialize = (path: string) =>
  fetchWorker(path, {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "doors-test", version: "1" } } } }),
  });

describe("wrong doors", () => {
  it("a plain GET of an MCP endpoint gets its server card, and a browser gets /connect", async () => {
    const card = await fetchWorker("/mcp/public", { headers: { Host: host, Accept: "application/json" } });
    expect(card.status).toBe(200);
    expect(card.headers.get("Content-Type")).toContain("application/mcp-server-card+json");
    expect(((await card.json()) as { remotes: { url: string }[] }).remotes[0]!.url).toBe(`${env.PUBLIC_ORIGIN}/mcp/public`);
    const gauntlet = (await (await fetchWorker("/mcp/gauntlet", { headers: { Host: host } })).json()) as { remotes: { url: string }[] };
    expect(gauntlet.remotes[0]!.url).toBe(`${env.PUBLIC_ORIGIN}/mcp/gauntlet`);
    const browser = await fetchWorker("/mcp/public", { headers: { Host: host, Accept: "text/html,application/xhtml+xml" }, redirect: "manual" });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("Location")).toBe(`${env.PUBLIC_ORIGIN}/connect`);
  });

  it("/mcp/public/mcp is the same endpoint", async () => {
    const res = await initialize("/mcp/public/mcp");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("forge_check");
  });

  it("serves the no-sign-in server card at the older well-known spellings, and counts them as discovery", async () => {
    for (const path of ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp"]) {
      const res = await fetchWorker(path);
      expect(res.status, path).toBe(200);
      expect(((await res.json()) as { name: string }).name).toBe("io.theagentforge/forge-public");
      expect(discoveryCounters({ method: "GET", url: `${env.PUBLIC_ORIGIN}${path}`, headers: new Headers() })).toEqual(["disc:server-card-well-known"]);
    }
  });

  it("a 401 from signed-in /mcp names the endpoint that needs no sign-in, keeping the OAuth challenge", async () => {
    const res = await initialize("/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
    expect(res.headers.get("Link")).toContain(`<${env.PUBLIC_ORIGIN}/mcp/public>; rel="alternate"`);
    const body = (await res.json()) as { error?: string; public_endpoint?: string };
    expect(body.public_endpoint).toBe(`${env.PUBLIC_ORIGIN}/mcp/public`);
    expect((body as { connect_url?: string }).connect_url).toBe(`${env.PUBLIC_ORIGIN}/connect`);
    expect(body.error).toBeTruthy();
  });
});

describe("directory and checker clients", () => {
  it("are told apart from agent apps by name", () => {
    for (const n of ["glama", "agentrank-probe", "talaria-catalog", "mcpscore", "verifymcp-probe", "mcp-indexer", "sniffmcp-crawler", "twr-health", "mcptry-health-check", "awesome-remote-mcp-servers-ci", "musedirectory.ai-scout", "forge-scout", "pingroll", "attestari-watch"])
      expect(isDirectoryClient(n), n).toBe(true);
    for (const n of ["claude-code", "anthropicclaudeai", "cursor", "cursor-vscode", "windsurf", "cline", "codex", "gemini-cli", "goose", "zed", "vscode", "rmcp", "mcpclient", "coda-agent-runtime", "unknown", "shopping-assistant"])
      expect(isDirectoryClient(n), n).toBe(false);
  });
});
