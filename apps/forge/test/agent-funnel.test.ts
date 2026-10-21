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
    await bump(env, ["mcp:public:sessions", "mcp:public:sessions", "mcp:public:sessions", "mcp:gauntlet:sessions", "mcp:client:glama", "mcp:client:glama"], now);
    await bump(env, ["a2a:requests", "mcp:public:calls", "mcp:public:calls", "mcp:signed_in:calls", "scan:api", "watch:calls", "mcp:house:sessions"], now);
    // A day outside the 7-day window is never counted.
    await bump(env, ["ai:indexer", "mcp:public:sessions", "mcp:public:calls"], now - 8 * 86_400_000);
    const f = await agentFunnel(env, now);
    expect(f.stages).toMatchObject({ found: 8, connected: 3, used: 5, returned: 1 });
    expect(f.detail).toMatchObject({ mcp_sessions: 2, directory_health_checks: 2, a2a_requests: 1, tool_calls: 3, api_scans: 1, house_mcp_sessions: 1 });
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

  it("/stats shows each step only once it reaches its minimum", async () => {
    const below = (await (await fetchWorker("/stats?format=json&f=below")).json()) as { agent_funnel: { agent_returned_7d: number | null; below_minimum: string[] } };
    expect(below.agent_funnel.agent_returned_7d).toBeNull();
    expect(below.agent_funnel.below_minimum).toContain("agent_returned_7d");
    const page = await (await fetchWorker("/stats?f=below")).text();
    expect(page).toContain('id="agents"');
    expect(page).not.toMatch(/<b>\d+<\/b><span>came back<\/span>/);
    await bump(env, Array.from({ length: 10 }, () => "watch:calls"));
    const at = (await (await fetchWorker("/stats?format=json&f=at")).json()) as { agent_funnel: { agent_returned_7d: number | null } };
    expect(at.agent_funnel.agent_returned_7d).toBeGreaterThanOrEqual(10);
    expect(await (await fetchWorker("/stats?f=at")).text()).toMatch(/<b>\d+<\/b><span>came back<\/span>/);
  });
});
