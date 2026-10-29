import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { clientLabel, mcpCounters, recordMcp, sourceLabel, usageStats, visitCounters, visitStats } from "../src/services/usage";
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
    // F-02 (ADR 0082): the outside-only 7-day connections are internal (gated as before, on /admin), never on /stats.
    const { outsideStatsData } = await import("../src/web/stats");
    const shown = (await usageStats(env)).mcp_sessions;
    if (shown < 25) {
      const below = (await outsideStatsData(env)).usage!;
      expect(below.mcp_sessions).toBeNull();
      expect(below.below_minimum).toContain("mcp_sessions");
    }
    for (let i = shown; i < 25; i++) await recordMcp(env, "public", new Request("https://x/mcp/public", { method: "POST", body: JSON.stringify(init("test-client")) }));
    expect((await outsideStatsData(env)).usage!.mcp_sessions).toBeGreaterThanOrEqual(25);
    const stats = await (await fetchWorker("/stats?c=at")).text();
    expect(stats).not.toContain('id="connections"');
    expect(((await (await fetchWorker("/stats?format=json&c=at")).json()) as { usage: unknown }).usage).toBeNull();
  });
});

describe("where visitors come from (daily totals only)", () => {
  const origin = "https://theagentforge.io";
  const req = (url: string, headers: Record<string, string> = {}) => ({ method: "GET", url, headers: new Headers(headers) });
  it("maps the referring site to a fixed label and keeps only a short link tag", () => {
    expect(sourceLabel(null, origin)).toBe("direct");
    expect(sourceLabel("https://t.co/abc", origin)).toBe("x");
    expect(sourceLabel("https://news.ycombinator.com/item?id=1", origin)).toBe("hn");
    expect(sourceLabel("https://old.reddit.com/r/LocalLLaMA/", origin)).toBe("reddit");
    expect(sourceLabel("https://www.google.com/", origin)).toBe("search");
    expect(sourceLabel("https://theagentforge.io/arena", origin)).toBe("internal");
    expect(sourceLabel("https://someblog.example/post", origin)).toBe("other");
    expect(visitCounters(req(`${origin}/arena?from=X-Launch!`, { referer: "https://t.co/x", "user-agent": "Mozilla/5.0" }), origin)).toEqual(["visit:all", "visit:arrivals", "visit:src:x", "visit:tag:x-launch"]);
    expect(visitCounters(req(`${origin}/connect`, { "user-agent": "Mozilla/5.0", referer: `${origin}/` }), origin)).toEqual(["visit:all", "visit:connect"]);
  });
  it("doesn't count bots, link previews or moving between our own pages", () => {
    expect(visitCounters(req(`${origin}/`, { "user-agent": "Twitterbot/1.0" }), origin)).toEqual(["visit:all", "visit:crawler"]);
    expect(visitCounters(req(`${origin}/`, { "user-agent": "Mozilla/5.0", referer: `${origin}/arena` }), origin)).toEqual(["visit:all"]);
    expect(visitCounters({ ...req(`${origin}/`), method: "POST" }, origin)).toEqual([]);
  });
  it("a page view is counted (cached or not) and shows in /api/v1/growth", async () => {
    const headers = { "user-agent": "Mozilla/5.0", referer: "https://news.ycombinator.com/" };
    await fetchWorker("/about?from=hn-launch", { headers });
    await fetchWorker("/about?from=hn-launch", { headers });
    await fetchWorker("/about", { headers: { "user-agent": "Mozilla/5.0 (compatible; GoogleOther)" } });
    await vi.waitFor(async () => {
      const g = (await (await fetchWorker("/api/v1/growth")).json()) as Record<string, unknown>;
      // Public: the gross number only. The people-only breakdown is internal (scout signals).
      expect(g.page_views_7d as number).toBeGreaterThanOrEqual(3);
      for (const k of ["arrivals_7d", "arrivals_by_source_7d", "arrivals_by_tag_7d", "crawler_page_views_7d"]) expect(g, k).not.toHaveProperty(k);
      const v = await visitStats(env);
      expect(v.by_source.find((s) => s.name === "hn")?.n).toBe(2);
      expect(v.by_tag).toContainEqual({ name: "hn-launch", n: 2 });
      expect(v.crawler_page_views).toBeGreaterThanOrEqual(1);
    });
  });
});
