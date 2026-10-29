import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { agentFunnel, agentFunnelDaily } from "../src/services/agent-funnel";
import { getDb } from "../src/services/db";
import { bump, discoveryCounters } from "../src/services/usage";
import { connectApprovedAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

const settle = () => new Promise((r) => setTimeout(r, 50));
const get = (path: string, headers: Record<string, string> = {}) => ({ method: "GET", url: `https://theagentforge.io${path}`, headers: new Headers(headers) });

describe("agent funnel (found us → connected → used a tool → came back → contributed)", () => {
  it("counts discovery fetches by path, and llms.txt only when it isn't a browser", () => {
    expect(discoveryCounters(get("/.well-known/agent-card.json"))).toEqual(["disc:agent-card"]);
    expect(discoveryCounters(get("/.well-known/agent.json"))).toEqual(["disc:agent-card"]);
    expect(discoveryCounters(get("/.well-known/ai-catalog.json"))).toEqual(["disc:ai-catalog"]);
    expect(discoveryCounters(get("/mcp/public/server-card"))).toEqual(["disc:server-card-public"]);
    expect(discoveryCounters(get("/.well-known/skills/index.json"))).toEqual(["skills:index"]);
    expect(discoveryCounters(get("/.well-known/agent-skills/forge-check/SKILL.md"))).toEqual(["skills:file:forge-check"]);
    expect(discoveryCounters(get("/llms.txt", { accept: "text/plain" }))).toEqual(["disc:llms-txt"]);
    expect(discoveryCounters(get("/llms.txt", { accept: "text/html,application/xhtml+xml" }))).toEqual([]);
    expect(discoveryCounters({ ...get("/.well-known/agent-card.json"), method: "POST" })).toEqual([]);
    expect(discoveryCounters(get("/stats"))).toEqual([]);
  });

  it("adds up each stage, leaving out directory health checks", async () => {
    const now = Date.UTC(2027, 0, 10, 12);
    await bump(env, ["ai:indexer", "ai:live", "ai:coding", "disc:agent-card", "disc:ai-catalog", "skills:index", "skills:file:forge-check", "skillmd:agent"], now);
    // Two Glama health checks and a catalogue probe that names itself: none are agents.
    await bump(env, ["mcp:public:sessions", "mcp:public:sessions", "mcp:public:sessions", "mcp:public:sessions", "mcp:gauntlet:sessions", "mcp:client:glama", "mcp:client:glama", "mcp:client:agentrank-probe"], now);
    await bump(env, ["a2a:requests", "mcp:public:calls", "mcp:public:calls", "mcp:signed_in:calls", "scan:api", "watch:calls", "mcp:house:sessions"], now);
    // A day outside the 7-day window is never counted.
    await bump(env, ["ai:indexer", "mcp:public:sessions", "mcp:public:calls"], now - 8 * 86_400_000);
    // One client app on two days counts as a repeat client; a directory check on one day doesn't.
    await bump(env, ["mcp:client:cursor"], now);
    await bump(env, ["mcp:client:cursor"], now - 86_400_000);
    const f = await agentFunnel(env, now);
    expect(f.stages).toMatchObject({ found: 8, connected: 3, used: 5, returned: 1 });
    expect(f.detail).toMatchObject({ found_with_intent: 5, mcp_client_apps_on_2plus_days: 1 });
    expect(f.detail).toMatchObject({ mcp_sessions: 2, directory_health_checks: 3, a2a_requests: 1, tool_calls: 3, api_scans: 1, house_mcp_sessions: 1 });
    expect(f.rates).toMatchObject({ connected: 37.5, used: 166.7, returned: 20 });
    const daily = await agentFunnelDaily(env, now);
    expect(daily).toHaveLength(14);
    expect(daily.at(-1)).toEqual({ day: "2027-01-10", found: 8, connected: 3, used: 5 });
    expect(daily[5]).toEqual({ day: "2027-01-02", found: 1, connected: 1, used: 1 });
  });

  it("counts reports only from people outside the project: not House, not the founder", async () => {
    const before = (await agentFunnel(env)).stages.contributed;
    const outside = await connectApprovedAgent(profile());
    const tool = (c: string) => ({ tool: { kind: "mcp_server", id: `npm:funnel-${c}`, version: "1.0.0", fingerprint: fp(c) } });
    expect((await postReport(outside.token, report(tool("a")))).status).toBe(201);
    expect((await agentFunnel(env)).stages.contributed).toBe(before + 1);
    const founder = await connectApprovedAgent(profile({ id: Number(env.ADMIN_GITHUB_IDS) }));
    expect((await postReport(founder.token, report(tool("b")))).status).toBe(201);
    expect((await agentFunnel(env)).stages.contributed).toBe(before + 1);
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, outside.human.id));
    expect((await agentFunnel(env)).stages.contributed).toBe(before);
  });

  it("counts agent card fetches, cached copies too", async () => {
    const count = async () => (await agentFunnel(env)).detail.discovery_file_fetches;
    const before = await count();
    for (let i = 0; i < 2; i++) await (await fetchWorker("/.well-known/agent-card.json")).text();
    await settle();
    expect(await count()).toBe(before + 2);
  });

  it("the funnel is internal (F-02): gated as before for /admin, never on /stats", async () => {
    const { outsideStatsData } = await import("../src/web/stats");
    const below = (await outsideStatsData(env)).agent_funnel!;
    expect(below.agent_returned_7d).toBeNull();
    expect(below.below_minimum).toContain("agent_returned_7d");
    await bump(env, Array.from({ length: 10 }, () => "watch:calls"));
    expect((await outsideStatsData(env)).agent_funnel!.agent_returned_7d).toBeGreaterThanOrEqual(10);
    const page = await (await fetchWorker("/stats?f=at")).text();
    expect(page).not.toContain('id="agents"');
    expect(page).not.toMatch(/<span>came back<\/span>/);
    expect(((await (await fetchWorker("/stats?format=json&f=at")).json()) as { agent_funnel: unknown }).agent_funnel).toBeNull();
  });
});

describe("home page live agent numbers (ADR 0030): everything counted, labelled as such", () => {
  it("includes our House sessions and directory health checks, hides zeros, and /stats and the home band say so (ADR 0067 Amendment 1)", async () => {
    const { liveAgentCounts } = await import("../src/services/agent-funnel");
    const before = await liveAgentCounts(env);
    await bump(env, ["mcp:public:sessions", "mcp:client:glama", "mcp:house:sessions", "mcp:house:calls", "disc:agent-card", "visit:all", "visit:all"]);
    const after = await liveAgentCounts(env);
    // Gross page views, crawlers included, are the first number in the row.
    expect((after.page_views_total ?? 0) - (before.page_views_total ?? 0)).toBe(2);
    // On production, 15–23 Oct from Cloudflare's own counts are included (72,176 HTML views before the Worker counted).
    const { PAGE_VIEWS_BACKFILL } = await import("../src/services/agent-funnel");
    expect(Object.values(PAGE_VIEWS_BACKFILL).reduce((a, b) => a + b, 0)).toBe(72176);
    if (env.ENVIRONMENT === "production") expect(after.page_views_total).toBeGreaterThanOrEqual(72178);
    // Glama's session isn't subtracted, and the House session and call are added.
    expect((after.agent_connections_total ?? 0) - (before.agent_connections_total ?? 0)).toBe(2);
    expect((after.agent_tool_uses_total ?? 0) - (before.agent_tool_uses_total ?? 0)).toBe(1);
    expect((after.agent_visits_total ?? 0) - (before.agent_visits_total ?? 0)).toBe(1);
    expect(after.includes_house_and_directory_checks).toBe(true);
    const live = (await (await fetchWorker("/agents/live.json?t=1")).json()) as Record<string, unknown>;
    expect(live.agent_connections_total).toBeGreaterThan(0);
    // The traffic totals are on /stats, in the "our own test agents included" totals table.
    const stats = await (await fetchWorker("/stats?t=live", { headers: { Accept: "text/html" } })).text();
    expect(stats).toContain("traffic numbers also include crawlers and uptime checks");
    expect(stats).toMatch(/<td>AI connections \(House and directory checks included\)<\/td><td class="num">[\d,]+<\/td>/);
    expect(stats).toMatch(/<td>Page views \(gross, crawlers included\)<\/td><td class="num">[\d,]+<\/td>/);
    const home = await (await fetchWorker("/?t=live", { headers: { Accept: "text/html" } })).text();
    // ADR 0067 Amendment 1: the home band shows them again, as totals, with the honest footnote and no outside claim.
    // Site audit 29 Oct: one stat strip; the agent totals are its second row, the caveats its one caption.
    const start = home.indexOf('<div class="stat-strip');
    const band = home.slice(start, home.indexOf("</div>\n</div>", start) + 13);
    expect(band).toContain("data-agent-live");
    expect(band).toMatch(/<ul class="ss-secondary">.*<li data-k="agent_connections_total"><b>[\d,]+<\/b><span>AI connections<\/span><\/li>/);
    expect(band).toContain("the second row also counts crawlers, uptime checks and directory health checks");
    expect(band).toContain("Includes the Forge's own test agents");
    expect(band).not.toMatch(/outside|independent|by other agents|people arriving|human visits/i);
  });

  it("are running totals: a visit a month ago still counts, where the 7-day funnel drops it", async () => {
    const { liveAgentCounts } = await import("../src/services/agent-funnel");
    const dec1 = Date.UTC(2026, 11, 1, 12);
    const before = await liveAgentCounts(env, dec1);
    const weekBefore = (await agentFunnel(env, dec1)).stages.found;
    await bump(env, ["disc:ai-catalog", "a2a:requests"], Date.UTC(2026, 10, 1, 12));
    const after = await liveAgentCounts(env, dec1);
    expect((after.agent_visits_total ?? 0) - (before.agent_visits_total ?? 0)).toBe(1);
    expect((after.agent_connections_total ?? 0) - (before.agent_connections_total ?? 0)).toBe(1);
    expect(after.since).toBe("2026-10-20");
    expect((await agentFunnel(env, dec1)).stages.found).toBe(weekBefore);
  });
});

