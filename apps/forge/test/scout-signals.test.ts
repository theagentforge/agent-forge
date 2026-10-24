import { env } from "cloudflare:workers";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { recordToolCheck } from "../src/services/feedback";
import { MISS_KEYS_PER_DAY, missLabel, recordMiss, scanMissLabel, topMisses } from "../src/services/misses";
import { conversionDaily, scoutSignals } from "../src/services/scout-signals";
import { bump, mcpCounters, metaClient } from "../src/services/usage";
import { fetchWorker } from "./helpers";
import "../src/index";

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const misses = async (d: string) =>
  (await getDb(env).select().from(t.usageDaily).where(and(eq(t.usageDaily.day, d), like(t.usageDaily.key, "miss:%")))).map((r) => [r.key, r.n] as [string, number]);

describe("misses: checks and scans that found nothing (ADR 0031 step 1)", () => {
  it("keeps a short, safe label and drops anything that looks like a key", () => {
    expect(missLabel("npm:Some-Package/")).toBe("npm:some-package");
    expect(missLabel("https://example.com/mcp?token=abc#x")).toBe("https://example.com/mcp");
    expect(missLabel("npm:ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4")).toBeNull();
    expect(missLabel("npm:@modelcontextprotocol/server-filesystem-extended")).toBe("npm:@modelcontextprotocol/server-filesystem-extended");
    expect(missLabel("two words")).toBeNull();
    expect(missLabel("x".repeat(121))).toBeNull();
    expect(scanMissLabel("https://Pastebin.com/raw/abc", "unsupported_url")).toBe("pastebin.com");
    expect(scanMissLabel("https://github.com/a/b", "not_found")).toBeNull();
    expect(scanMissLabel("ftp://x.org/a", "unsupported_url")).toBeNull();
  });

  it("counts checks of unknown tools per id per day, but not crawlers or known tools", async () => {
    const now = Date.UTC(2026, 9, 10, 12);
    await recordToolCheck(env, { id: "npm:nobody-has-this" }, now);
    await recordToolCheck(env, { id: "npm:nobody-has-this" }, now);
    await recordToolCheck(env, { id: "npm:crawled" }, now, { userAgent: "Googlebot/2.1" });
    await recordToolCheck(env, { fingerprint: `sha256:${"9".repeat(64)}` }, now);
    expect(await misses(dayOf(now))).toEqual([["miss:check:npm:nobody-has-this", 2]]);
  });

  it("counts scan links on hosts we don't read from, by host only", async () => {
    const res = await fetchWorker(`/api/v1/scan?url=${encodeURIComponent("https://pastebin.example/raw/secret-path")}`, { headers: { "CF-Connecting-IP": "203.0.113.70" } });
    expect(res.status).toBe(400);
    // Counted after the response (waitUntil).
    const rows = await vi.waitFor(async () => {
      const r = await misses(dayOf(Date.now()));
      expect(r).toContainEqual(["miss:scan:pastebin.example", 1]);
      return r;
    });
    expect(JSON.stringify(rows)).not.toContain("secret-path");
  });

  it("stops adding new ids after the daily cap, but still counts ids it already has", async () => {
    const now = Date.UTC(2026, 9, 11, 12);
    const db = getDb(env);
    const d = dayOf(now);
    for (let i = 0; i < MISS_KEYS_PER_DAY; i += 25)
      await db.insert(t.usageDaily).values(Array.from({ length: 25 }, (_, j) => ({ day: d, key: `miss:check:npm:filler-${i + j}`, n: 1 })));
    await recordMiss(env, "check", "npm:one-too-many", { now });
    await recordMiss(env, "check", "npm:filler-7", { now });
    const rows = new Map(await misses(d));
    expect(rows.has("miss:check:npm:one-too-many")).toBe(false);
    expect(rows.get("miss:check:npm:filler-7")).toBe(2);
    expect((await topMisses(env, d, d, 1))[0]).toEqual({ kind: "check", id: "npm:filler-7", n: 2 });
  });
});

describe("MCP client identity (ADR 0032 item 2)", () => {
  it("reads the client name from a call's _meta, and never for House sessions", () => {
    const call = { method: "tools/call", params: { name: "forge_check", _meta: { "io.modelcontextprotocol/clientInfo": { name: "Kiro", version: "1.2" } } } };
    expect(mcpCounters("public", call)).toEqual(["mcp:public:calls", "mcp:tool:forge_check", "mcp:clientcall:kiro"]);
    expect(mcpCounters("house", call)).toEqual(["mcp:house:calls"]);
    expect(metaClient({ progressToken: 1 })).toBeNull();
    expect(metaClient({ clientInfo: { name: 7 } })).toBeNull();
  });
});

describe("scout signals", () => {
  it("lists yesterday's misses, MCP clients with their first day, and flags names first seen yesterday", async () => {
    // A fixed day far from the real calendar: other tests in this file record real misses "today", which would land
    // in this test's "yesterday" if it fell on the day the suite runs (it did on 24 Oct 2026).
    const now = Date.UTC(2026, 0, 25, 3);
    const yesterday = now - 86_400_000;
    await bump(env, ["mcp:client:old-faithful"], now - 10 * 86_400_000);
    await bump(env, ["mcp:client:old-faithful", "mcp:client:brand-new", "mcp:clientcall:stateless-one", "disc:ai-catalog"], yesterday);
    await recordMiss(env, "check", "npm:wanted-tool", { now: yesterday });
    const s = await scoutSignals(env, now);
    expect(s.day).toBe("2026-01-24");
    expect(s.new_clients).toEqual(["brand-new", "stateless-one"]);
    expect(s.mcp_clients.find((c) => c.name === "old-faithful")).toMatchObject({ first_seen: "2026-01-15", sessions_7d: 1, yesterday: 1, directory: false });
    expect(s.mcp_clients.find((c) => c.name === "stateless-one")).toMatchObject({ calls_7d: 1 });
    expect(s.misses.yesterday).toEqual([{ kind: "check", id: "npm:wanted-tool", n: 1 }]);
    expect(s.discovery_fetches["ai-catalog"]).toBe(1);
    expect(s.funnel_7d).toBeTruthy();
  });

  it("needs the scout-collect workflow's GitHub token", async () => {
    expect((await fetchWorker("/api/v1/ops/scout-signals")).status).toBe(401);
    expect((await fetchWorker("/api/v1/ops/scout-signals", { headers: { Authorization: "Bearer a.b.c" } })).status).toBe(401);
  });

  it("reports the conversion KPI per day: page views and people against AI connections (internal only)", async () => {
    const now = Date.UTC(2027, 2, 10, 12);
    const y = now - 86_400_000;
    await bump(env, [...Array(2000).fill("visit:all"), ...Array(1900).fill("visit:crawler"), ...Array(50).fill("visit:arrivals"), ...Array(10).fill("visit:connect"), "connect:test-passed", "connect:test-passed"], y);
    await bump(env, ["mcp:public:sessions", "mcp:public:sessions", "mcp:public:sessions", "mcp:client:glama", "a2a:requests", "mcp:public:calls"], y);
    await bump(env, [...Array(12).fill("visit:human"), "scan:web"], y);
    const days = await conversionDaily(env, now);
    expect(days).toHaveLength(14);
    expect(days.at(-1)).toEqual({
      day: dayOf(y),
      page_views: 2000,
      crawler_page_views: 1900,
      people: 50,
      humans: 12,
      web_scans: 1,
      report_page_views: 0,
      web_reports: 0,
      connect_page: 10,
      connect_tests_passed: 2,
      connections: 3, // 3 sessions less 1 directory check, plus 1 A2A request
      tool_uses: 2,
      per_1k_page_views: 1.5,
      per_100_people: 6,
      per_100_humans: 25,
    });
    expect(days[0]!.per_1k_page_views).toBeNull();
    expect((await scoutSignals(env, now)).conversion).toHaveLength(14);
  });
});
