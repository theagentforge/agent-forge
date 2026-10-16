import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clientLabel, mcpCounters, recordMcp, usageStats } from "../src/services/usage";
import { fetchWorker } from "./helpers";

const init = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } } });

describe("usage counts (proof of use, daily totals only)", () => {
  it("counts a session per initialize and a call per tools/call, never background traffic", () => {
    expect(mcpCounters("public", init("claude-ai"))).toEqual(["mcp:public:sessions", "mcp:client:claude-ai"]);
    expect(mcpCounters("signed_in", { method: "tools/call", params: { name: "forge_check" } })).toEqual(["mcp:signed_in:calls", "mcp:tool:forge_check"]);
    expect(mcpCounters("public", [{ method: "tools/list" }, { method: "notifications/initialized" }, { method: "ping" }])).toEqual([]);
    expect(mcpCounters("public", { method: "tools/call", params: { name: "../../etc" } })).toEqual([]);
    expect(clientLabel("Cursor <script>")).toBe("cursor script");
    expect(clientLabel(undefined)).toBe("unknown");
  });

  it("adds up across requests and days, and stores nothing about who connected", async () => {
    const day1 = Date.UTC(2026, 9, 16, 10);
    const post = (body: unknown) => new Request("https://x/mcp/public", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    await recordMcp(env, "public", post(init("claude-ai")), day1);
    await recordMcp(env, "public", post(init("claude-ai")), day1);
    await recordMcp(env, "signed_in", post([init("cursor"), { method: "tools/call", params: { name: "forge_check" } }]), day1 + 86_400_000);
    await recordMcp(env, "public", new Request("https://x/mcp/public", { method: "POST", body: "not json" }), day1);
    const u = await usageStats(env, day1 + 86_400_000);
    expect(u.mcp_sessions).toBe(3);
    expect(u.mcp_sessions_signed_in).toBe(1);
    expect(u.mcp_tool_calls).toBe(1);
    expect(u.top_clients[0]).toEqual({ name: "claude-ai", n: 2 });
    const cols = await env.DB.prepare("select name from pragma_table_info('usage_daily')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name).sort()).toEqual(["day", "key", "n"]);
  });

  it("the public MCP endpoint counts a real initialize, and /stats shows connections", async () => {
    const res = await fetchWorker("/mcp/public", {
      method: "POST",
      headers: { Host: new URL(env.PUBLIC_ORIGIN).host, "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify(init("test-client")),
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    const u = await usageStats(env);
    expect(u.top_clients.some((c) => c.name === "test-client")).toBe(true);
    // A refused request (no sign-in on /mcp) isn't a connection.
    const before = (await usageStats(env)).mcp_sessions_signed_in;
    const refused = await fetchWorker("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init("anon")) });
    expect(refused.status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect((await usageStats(env)).mcp_sessions_signed_in).toBe(before);
    const stats = await (await fetchWorker("/stats")).text();
    expect(stats).toContain('id="connections"');
    const json = (await (await fetchWorker("/stats?format=json")).json()) as { usage: { mcp_sessions: number } };
    expect(json.usage.mcp_sessions).toBeGreaterThan(0);
  });
});
