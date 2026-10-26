import { env } from "cloudflare:workers";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { agentFunnel, isDirectoryClient } from "../src/services/agent-funnel";
import { getDb } from "../src/services/db";
import { internalCaller, internalClient, internalFromMcpBody, internalOf } from "../src/services/internal";
import { recordCheck, sourceHash } from "../src/services/proof";
import { aiAgentCounters, discoveryCounters, humanCounters, mcpCounters, visitCounters } from "../src/services/usage";
import { fetchWorker } from "./helpers";
import "../src/index";

// K7: our own probes (Scout collector, CI install tests, House, screens, our Action) never count as agents. A tag only
// ever leaves traffic out of the counts; it is counted apart as internal:<component>:*.

const host = new URL(env.PUBLIC_ORIGIN).host;
const today = () => new Date().toISOString().slice(0, 10);
const settle = () => new Promise((r) => setTimeout(r, 80));
const h = (o: Record<string, string>) => new Headers(o);

async function sourceRows(ip: string) {
  const source = await sourceHash(env.SESSION_SECRET, today(), ip);
  return getDb(env).select().from(t.checkSources).where(and(eq(t.checkSources.day, today()), eq(t.checkSources.source, source)));
}
async function counter(key: string) {
  const r = await getDb(env).select().from(t.usageDaily).where(and(eq(t.usageDaily.day, today()), eq(t.usageDaily.key, key)));
  return r[0]?.n ?? 0;
}
async function clientRows(name: string) {
  return getDb(env).select().from(t.usageDaily).where(like(t.usageDaily.key, `mcp:client:${name}`));
}

const mcpInit = (name: string, headers: Record<string, string> = {}, ip = "198.51.100.70") =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip, "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } } }),
  });
const mcpCheck = (name: string, headers: Record<string, string>, ip: string) =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip, "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "forge_check", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "forge_check", arguments: { id: "npm:internal-test-tool" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name, version: "1" } } },
    }),
  });

describe("recognising our own callers", () => {
  it("by header, by User-Agent or by MCP client name; unknown components count as other; everyone else is null", () => {
    expect(internalCaller(h({ "X-Forge-Internal": "scout" }))).toBe("scout");
    expect(internalCaller(h({ "x-forge-internal": " Screens " }))).toBe("screens");
    expect(internalCaller(h({ "User-Agent": "theagentforge-internal/house (theagentforge-house-tester)" }))).toBe("house");
    expect(internalCaller(h({ "User-Agent": "theagentforge-action/1 theagentforge-internal/action" }))).toBe("action");
    expect(internalCaller(h({ "X-Forge-Internal": "made-up-name-to-fill-counters" }))).toBe("other");
    expect(internalCaller(h({ "User-Agent": "Mozilla/5.0 Chrome/140" }))).toBeNull();
    expect(internalCaller(h({ "User-Agent": "theagentforge-cli/1.0" }))).toBeNull();
    expect(internalCaller(h({ "X-Forge-Internal": "" }))).toBeNull();
    expect(internalClient("theagentforge-internal-scout")).toBe("scout");
    expect(internalClient("theagentforge-internal/ci-cline")).toBe("ci-cline");
    expect(internalClient("claude-code")).toBeNull();
    expect(internalFromMcpBody({ method: "tools/list", params: { _meta: { "io.modelcontextprotocol/clientInfo": { name: "theagentforge-internal-scout" } } } })).toBe("scout");
    expect(internalFromMcpBody([{ method: "initialize", params: { clientInfo: { name: "cursor" } } }])).toBeNull();
  });

  it("reads the client name from a POST body without consuming it", async () => {
    const req = new Request("https://x/mcp/public", { method: "POST", body: JSON.stringify({ method: "initialize", params: { clientInfo: { name: "theagentforge-internal-scout" } } }) });
    expect(await internalOf(req)).toBe("scout");
    expect(JSON.parse(await req.text()).method).toBe("initialize");
  });

  it("keeps our client names out of the agent counts, old and new (the name pattern stays too)", () => {
    for (const n of ["forge-scout", "theagentforge-house-tester", "theagentforge-internal-scout", "glama", "agentrank-probe"]) expect(isDirectoryClient(n), n).toBe(true);
    for (const n of ["claude-code", "cursor", "cline"]) expect(isDirectoryClient(n), n).toBe(false);
  });
});

describe("the counters our callers add", () => {
  it("MCP: an internal session or call adds only internal:* keys, never a client name, session or tool", () => {
    const init = (name: string) => ({ method: "initialize", params: { clientInfo: { name } } });
    expect(mcpCounters("public", init("claude-ai"))).toEqual(["mcp:public:sessions", "mcp:client:claude-ai"]);
    expect(mcpCounters("public", init("theagentforge-internal-scout"))).toEqual(["internal:scout:sessions"]);
    expect(mcpCounters("public", init("claude-ai"), "ci-cline")).toEqual(["internal:ci-cline:sessions"]);
    expect(mcpCounters("public", { method: "tools/call", params: { name: "forge_check" } }, "screens")).toEqual(["internal:screens:calls"]);
    const modern = { method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "theagentforge-internal-scout" } } } };
    expect(mcpCounters("public", modern)).toEqual(["internal:scout:sessions"]);
  });

  it("site: gross page views only; no arrivals, AI-agent, discovery or people counts", () => {
    const req = (path: string, headers: Record<string, string>, method = "GET") => ({ method, url: `${env.PUBLIC_ORIGIN}${path}`, headers: h(headers) });
    const tag = { "X-Forge-Internal": "screens", "User-Agent": "Mozilla/5.0 (iPhone) Safari/604.1 theagentforge-internal/screens" };
    expect(visitCounters(req("/arena?from=screens", tag), env.PUBLIC_ORIGIN)).toEqual(["visit:all"]);
    expect(visitCounters(req("/arena?from=x", { "User-Agent": "Mozilla/5.0 Safari/604.1" }), env.PUBLIC_ORIGIN)).toContain("visit:arrivals");
    expect(aiAgentCounters(req("/", { ...tag, "User-Agent": "claude-code/2 theagentforge-internal/scout" }))).toEqual([]);
    expect(discoveryCounters(req("/.well-known/agent-card.json", { "User-Agent": "theagentforge-internal/scout" }))).toEqual(["internal:scout:fetches"]);
    expect(discoveryCounters(req("/.well-known/agent-card.json", {}))).toEqual(["disc:agent-card"]);
    expect(humanCounters(req("/v", { ...tag, "sec-fetch-site": "same-origin" }, "POST"), env.PUBLIC_ORIGIN)).toEqual([]);
  });

  it("recordCheck: an internal check never makes a check source; it adds internal:<component>:checks", async () => {
    const before = await counter("internal:house:checks");
    await recordCheck(env, "mcp", "198.51.100.71", { internal: "house" });
    expect(await sourceRows("198.51.100.71")).toHaveLength(0);
    expect(await counter("internal:house:checks")).toBe(before + 1);
    await recordCheck(env, "mcp", "198.51.100.72");
    expect(await sourceRows("198.51.100.72")).toHaveLength(1);
  });
});

describe("end to end", () => {
  it("REST check: tagged makes no check source; a normal one still does; the answer is the same", async () => {
    const before = await counter("internal:scout:checks");
    const tagged = await fetchWorker("/api/v1/check?id=npm:internal-rest-a", { headers: { "CF-Connecting-IP": "198.51.100.73", "X-Forge-Internal": "scout" } });
    const plain = await fetchWorker("/api/v1/check?id=npm:internal-rest-b", { headers: { "CF-Connecting-IP": "198.51.100.74" } });
    expect(tagged.status).toBe(200);
    expect(plain.status).toBe(200);
    const a = (await tagged.json()) as Record<string, unknown>;
    const b = (await plain.json()) as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    await settle();
    expect(await sourceRows("198.51.100.73")).toHaveLength(0);
    expect(await sourceRows("198.51.100.74")).toHaveLength(1);
    expect(await counter("internal:scout:checks")).toBe(before + 1);
  });

  it("public MCP: a tagged session adds no client name; a tagged forge_check adds no check source; normal ones do", async () => {
    // The Scout collector's own probe, by client name alone.
    expect((await mcpInit("theagentforge-internal-scout")).status).toBe(200);
    // A CI install test, by header, with an ordinary client name.
    expect((await mcpInit("cline-k7-test", { "X-Forge-Internal": "ci-cline" })).status).toBe(200);
    // An ordinary agent.
    expect((await mcpInit("k7-real-agent")).status).toBe(200);
    await settle();
    expect(await clientRows("theagentforge-internal-scout")).toHaveLength(0);
    expect(await clientRows("cline-k7-test")).toHaveLength(0);
    expect(await clientRows("k7-real-agent")).toHaveLength(1);
    expect(await counter("internal:scout:sessions")).toBeGreaterThanOrEqual(1);
    expect(await counter("internal:ci-cline:sessions")).toBeGreaterThanOrEqual(1);

    const r1 = await mcpCheck("theagentforge-internal-scout", {}, "198.51.100.75");
    const r2 = await mcpCheck("k7-real-agent", {}, "198.51.100.76");
    expect(await r1.text()).toContain("security_status");
    expect(await r2.text()).toContain("security_status");
    await settle();
    expect(await sourceRows("198.51.100.75")).toHaveLength(0);
    expect(await sourceRows("198.51.100.76")).toHaveLength(1);
    expect(await counter("internal:scout:checks")).toBeGreaterThanOrEqual(1);
    expect(await counter("mcp:clientcall:theagentforge-internal-scout")).toBe(0);
  });

  it("the funnel shows our probes apart and never in a stage", async () => {
    const f = await agentFunnel(env);
    expect(f.detail.internal_requests).toBeGreaterThan(0);
    expect(f.detail.internal_by_component.scout).toBeGreaterThan(0);
  });
});
