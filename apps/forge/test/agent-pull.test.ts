import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CHECK_PROMPT, PUBLIC_INSTRUCTIONS, TRAP_CARD_RESOURCE } from "../src/mcp-public";
import { AGENT_DIRECTED } from "./wording";
import { seedReferenceServers } from "../src/seed/reference-servers";
import { nameTerm } from "../src/services/forge";
import { fetchWorker } from "./helpers";
import "../src/index";

// Agent-to-agent pull improvements (research 23 Oct 2026): server instructions, a check that's never a dead end, and
// errors an agent can act on.

const host = new URL(env.PUBLIC_ORIGIN).host;
const mcp = (method: string, params: Record<string, unknown> = {}) =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(params.name || params.uri ? { "Mcp-Name": String(params.name ?? params.uri) } : {}) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "pull-test", version: "1" } } },
    }),
  });
async function result(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any };
}
const api = async (q: string) => (await fetchWorker(`/api/v1/check?${q}`)).json() as Promise<any>;

describe("agent pull: what an agent gets back", () => {
  it("the public MCP server sends its instructions", async () => {
    const d = await result(await mcp("server/discover"));
    expect(JSON.stringify(d.result)).toContain(PUBLIC_INSTRUCTIONS.slice(0, 60));
  });

  it("a tool we don't know reads as insufficient, not clear-and-done, and a bare name returns candidates", async () => {
    await seedReferenceServers(env);
    const unknown = await api("id=npm:not-a-real-package-xyz");
    expect(unknown).toMatchObject({ known: false, verdict: "insufficient", candidates: [] });

    const bare = await api("id=filesystem");
    expect(bare.known).toBe(false);
    expect(bare.candidates.map((c: { id: string }) => c.id)).toContain("npm:@modelcontextprotocol/server-filesystem");
    expect(bare.candidates.length).toBeLessThanOrEqual(5);
    const lens = bare.candidates.map((c: { id: string }) => c.id.length);
    expect(lens).toEqual([...lens].sort((a: number, b: number) => a - b)); // shortest (the package itself) first

    const known = await api("id=npm:@modelcontextprotocol/server-memory");
    expect(known).toMatchObject({ known: true, verdict: "insufficient" });
    expect(known.candidates).toBeUndefined();

    const viaMcp = await result(await mcp("tools/call", { name: "forge_check", arguments: { id: "sequential" } }));
    expect(JSON.parse(viaMcp.result.content[0].text).candidates[0].id).toBe("npm:@modelcontextprotocol/server-sequential-thinking");
  });

  it("offers a check-before-install prompt and the trap card as a resource, both pulled by the person", async () => {
    const p = await result(await mcp("prompts/list"));
    expect(p.result.prompts.map((x: { name: string }) => x.name)).toContain("check-before-install");
    expect(AGENT_DIRECTED.exec(CHECK_PROMPT.description)).toBeNull();
    expect(AGENT_DIRECTED.exec(TRAP_CARD_RESOURCE.description)).toBeNull();
    const g = await result(await mcp("prompts/get", { name: "check-before-install", arguments: { what: "npm:left-pad" } }));
    expect(g.result.messages[0].content.text).toContain("Before installing npm:left-pad");
    const r = await result(await mcp("resources/read", { uri: "forge://trap-card" }));
    expect(r.result.contents[0].text).toMatch(/^Checks for my AI assistant \(Forge trap card v/);
  });

  it("every check carries where a field report goes, as data", async () => {
    const c = await api("id=npm:not-a-real-package-xyz");
    expect(c.contribute).toEqual({ tool: "forge_report", mcp_server: `${env.PUBLIC_ORIGIN}/mcp`, auth: "github_oauth", human_verified: true });
  });

  it("an invalid query says which forms are accepted, with an example", async () => {
    const res = await fetchWorker("/api/v1/check?id=a&url=https://x.dev");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_query", accepted: { fingerprint: "sha256:<64 hex>" }, example: { id: "npm:@modelcontextprotocol/server-filesystem" } });
  });

  it("finds the searchable part of an id", () => {
    expect(nameTerm("npm:@modelcontextprotocol/server-filesystem")).toBe("server-filesystem");
    expect(nameTerm("github.com/upstash/context7")).toBe("context7");
    expect(nameTerm("context7")).toBe("context7");
    expect(nameTerm("https://github.com/owner/repo/tree/main/src")).toBe("repo");
    expect(nameTerm("ab")).toBeNull();
    expect(nameTerm("50%_off")).toBe("50_off");
  });
});
