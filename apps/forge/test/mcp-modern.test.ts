import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { isModernRequest, mcpCounters } from "../src/services/usage";
import { fetchWorker } from "./helpers";
import "../src/index";

// MCP 2026-07-28 (ADR 0032 item 2, proposal #161): stateless, no initialize; each request carries the protocol
// version, client capabilities and client info in `_meta`.
const host = new URL(env.PUBLIC_ORIGIN).host;
const meta = (name: string) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name, version: "1.0" },
});
const modern = (client: string, method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta(client) } }),
  });
async function result(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}
const today = () => new Date().toISOString().slice(0, 10);
const count = async (key: string) =>
  Number((await getDb(env).select().from(t.usageDaily).where(and(eq(t.usageDaily.day, today()), eq(t.usageDaily.key, key))))[0]?.n ?? 0);

describe("MCP 2026-07-28 on /mcp/public", () => {
  it("answers server/discover, tools/list and tools/call without an initialize", async () => {
    const d = await result(await modern("probe-a", "server/discover"));
    expect(d.result.supportedVersions).toContain("2026-07-28");
    expect(d.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("the-agent-forge-public");
    const l = await result(await modern("probe-a", "tools/list"));
    expect(l.result.tools.map((x: { name: string }) => x.name)).toContain("forge_traps");
    const c = await result(await modern("probe-a", "tools/call", { name: "forge_traps", arguments: {} }, { "Mcp-Name": "forge_traps" }));
    expect(JSON.parse(c.result.content[0].text).card_version).toBeTruthy();
  });

  it("counts a 2026 client's tool list as its session and names it, without counting 2025 tool lists", async () => {
    const before = await count("mcp:public:sessions");
    await result(await modern("Probe-Modern", "tools/list"));
    await result(await modern("Probe-Modern", "tools/call", { name: "forge_traps", arguments: {} }, { "Mcp-Name": "forge_traps" }));
    await vi.waitFor(async () => {
      expect(await count("mcp:public:sessions")).toBe(before + 1);
      expect(await count("mcp:client:probe-modern")).toBe(1);
      expect(await count("mcp:clientcall:probe-modern")).toBe(1);
    });
    expect(mcpCounters("public", { method: "tools/list", params: {} })).toEqual([]);
    expect(mcpCounters("public", { method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } })).toEqual([]);
    expect(mcpCounters("house", { method: "tools/list", params: { _meta: meta("x") } })).toEqual(["mcp:house:sessions"]);
    expect(isModernRequest({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" })).toBe(true);
    expect(isModernRequest({ progressToken: 1 })).toBe(false);
  });

  it("advertises 2026-07-28 in the server card", async () => {
    const card = (await (await fetchWorker("/mcp/public/server-card")).json()) as { remotes: { supportedProtocolVersions: string[] }[] };
    expect(card.remotes[0]!.supportedProtocolVersions[0]).toBe("2026-07-28");
  });
});
