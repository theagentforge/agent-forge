import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentFunnel, agentFunnelDaily, clientKind, liveAgentCounts } from "../src/services/agent-funnel";
import { growthKpis } from "../src/services/kpis";
import { connectSteps, conversionDaily, scoutSignals } from "../src/services/scout-signals";
import { bump, mcpCounters } from "../src/services/usage";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0050 (issues #171 and #224, brief #235): our numbers count only real use. Our own probes are never a client,
// monitors (names that connect but never call a tool under their name) are kept apart as catalog coverage, and the
// headline demand number is tool calls from outside clients.

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const n = (key: string, times: number) => Array<string>(times).fill(key);

/** One day as the brief described it: two monitors, claude.ai and Claude Code, Glama, our old probe name, a scanner. */
async function seedDay(at: number) {
  await bump(env, [
    ...n("mcp:public:sessions", 12),
    ...n("mcp:client:mcpbeat", 5),
    ...n("mcp:client:histor", 2),
    ...n("mcp:client:anthropicclaudeai", 2),
    "mcp:client:claude-code",
    "mcp:client:glama",
    "mcp:client:forge-scout",
    ...n("mcp:public:calls", 6),
    ...n("mcp:clientcall:claude-code", 3),
    "mcp:clientcall:squatch-mcp-scanner",
    "a2a:requests",
  ], at);
}

describe("what a client name is (ADR 0050)", () => {
  it("monitors connect without a tool call under their name; agent apps and nameless clients never are", () => {
    expect(clientKind("mcpbeat", 177, 0)).toBe("monitor");
    expect(clientKind("histor", 59, 0)).toBe("monitor");
    expect(clientKind("coda-agent-runtime", 23, 0)).toBe("monitor");
    expect(clientKind("claude-code", 28, 56)).toBe("agent");
    // claude.ai's 2025-protocol calls don't carry its name, so 0 named calls proves nothing.
    for (const app of ["anthropicclaudeai", "claude-ai", "cursor", "cursor-vscode", "visual studio code", "codex-mcp-client", "gemini-cli", "goose", "clinecore"]) expect(clientKind(app, 9, 0), app).toBe("agent");
    expect(clientKind("unknown", 7, 0)).toBe("agent");
    expect(clientKind("new-agent", 3, 1)).toBe("agent");
    expect(clientKind("glama", 294, 0)).toBe("directory");
    expect(clientKind("squatch-mcp-scanner", 4, 2)).toBe("directory");
    expect(clientKind("forge-scout", 4, 0)).toBe("ours");
    expect(clientKind("theagentforge-internal-scout", 1, 1)).toBe("ours");
  });

  it("the collector's old client name now counts as our own probe, never as a session or client", () => {
    expect(mcpCounters("public", { method: "initialize", params: { clientInfo: { name: "forge-scout" } } })).toEqual(["internal:scout:sessions"]);
    expect(mcpCounters("public", { method: "initialize", params: { clientInfo: { name: "mcpbeat" } } })).toEqual(["mcp:public:sessions", "mcp:client:mcpbeat"]);
  });
});

describe("the funnel and the conversion counts leave monitors out (ADR 0050)", () => {
  const now = Date.UTC(2027, 4, 20, 12);

  it("connected, used and tool calls from outside clients, with monitors and catalogs on their own line", async () => {
    await seedDay(now);
    // A client that called a tool 3 days ago is an agent today; one whose only call was 8 days ago is a monitor.
    await bump(env, ["mcp:clientcall:returning-agent"], now - 3 * DAY);
    await bump(env, ["mcp:clientcall:old-caller"], now - 8 * DAY);
    await bump(env, ["mcp:public:sessions", "mcp:client:returning-agent", "mcp:public:sessions", "mcp:client:old-caller"], now);
    const f = await agentFunnel(env, now);
    // 14 sessions less 2 directory (glama, forge-scout) less 8 monitor (mcpbeat 5, histor 2, old-caller 1), plus 1 A2A.
    expect(f.stages.connected).toBe(5);
    expect(f.detail).toMatchObject({ directory_health_checks: 2, monitor_sessions: 8, own_client_sessions: 1, tool_calls: 6 });
    // 6 calls less the scanner's 1 named call, plus 1 A2A request.
    expect(f.detail.outside_tool_calls).toBe(6);
    expect(f.stages.used).toBe(6);
    expect(f.detail.monitors_and_catalogs).toEqual({ clients: 5, sessions: 9, calls: 1 });
    const daily = await agentFunnelDaily(env, now);
    expect(daily.at(-1)).toMatchObject({ day: dayOf(now), connected: 5, used: 6 });
    // The home page's running totals still include everything, monitors too.
    const live = await liveAgentCounts(env, now);
    expect(live.agent_connections_total).toBeGreaterThanOrEqual(14 + 1);
  });

  it("a window that ends yesterday doesn't take in today's counts", async () => {
    const at = Date.UTC(2027, 6, 1, 12);
    await bump(env, ["mcp:public:calls", "mcp:public:calls"], at);
    await bump(env, ["mcp:public:calls"], at - DAY);
    expect((await agentFunnel(env, at - DAY, 1)).detail.tool_calls).toBe(1);
    expect((await agentFunnel(env, at, 1)).detail.tool_calls).toBe(2);
  });

  it("conversion per day keeps its old fields and adds agent connections, outside calls and the /connect steps", async () => {
    const at = Date.UTC(2027, 8, 10, 12);
    const y = at - DAY;
    await seedDay(y);
    await bump(env, [...n("visit:human", 20), ...n("visit:human:connect", 8), "connect:tile:claude", "connect:tile:developers", ...n("connect:copied:claude", 3), "connect:copied:claude-code", "connect:copied:test-prompt", ...n("connect:code-shown", 2), "connect:test-passed", "connect:test-passed:mcp", "connect:test-passed:web"], y);
    await bump(env, ["mcp:clientcall:fresh-agent-x", "mcp:public:sessions", "mcp:client:theagentforge-internal-ci"], y);
    const d = (await conversionDaily(env, at)).at(-1)!;
    expect(d).toMatchObject({
      day: dayOf(y),
      connections: 11, // the old reading: 12 sessions less 2 directory checks, plus 1 A2A request
      agent_connections: 4, // less the 7 monitor sessions too
      monitor_sessions: 7,
      outside_tool_calls: 6,
      tool_uses: 7,
      per_100_humans: 55,
      agent_per_100_humans: 20,
      outside_calls_per_100_humans: 30,
      connect_humans: 8,
      connect_tiles: 2,
      connect_tiles_by_app: { claude: 1, developers: 1 },
      connect_copied: 4,
      connect_copied_by_app: { claude: 3, "claude-code": 1, "test-prompt": 1 },
      connect_test_prompt_copied: 1, // copying the test question is counted apart from install copies
      connect_code_shown: 2,
      connect_tests_passed: 1,
      connect_tests_passed_by_channel: { mcp: 1, web: 1 },
    });
    const s = await scoutSignals(env, at);
    expect(s.mcp_clients.map((c) => c.name)).not.toContain("forge-scout");
    // A name first seen yesterday is listed, unless it's one of ours (an older untagged row, say).
    expect(s.new_clients).toContain("fresh-agent-x");
    expect(s.new_clients).not.toContain("theagentforge-internal-ci");
    expect(s.mcp_clients.map((c) => c.name)).not.toContain("theagentforge-internal-ci");
    expect(s.mcp_clients.find((c) => c.name === "mcpbeat")).toMatchObject({ kind: "monitor", directory: false });
    expect(s.mcp_clients.find((c) => c.name === "anthropicclaudeai")).toMatchObject({ kind: "agent" });
    expect(s.mcp_clients.find((c) => c.name === "glama")).toMatchObject({ kind: "directory", directory: true });
    expect(s.monitors_and_catalogs_7d).toEqual({ clients: 4, sessions: 8, calls: 1 });
    expect(s.outside_tool_calls_7d).toBe(6);
    expect(s.connect_steps_7d.steps.map((x) => [x.step, x.n])).toEqual([
      ["opened /connect", 8],
      ["chose an app tile", 2],
      ["copied a command or pressed an install link", 4],
      ["saw the test code", 2],
      ["test passed", 1],
    ]);
    expect(s.connect_steps_7d.biggest_drop).toBe("opened /connect → copied a command or pressed an install link");
  });

  it("names the step with the biggest drop, and none when nobody came", () => {
    const day = (h: number, c: number, s: number, p: number) => ({ connect_humans: h, connect_tiles: 0, connect_copied: c, connect_code_shown: s, connect_tests_passed: p });
    expect(connectSteps([day(10, 9, 8, 0)]).biggest_drop).toBe("saw the test code → test passed");
    expect(connectSteps([day(0, 0, 0, 0)]).biggest_drop).toBeNull();
    expect(connectSteps([day(10, 5, 0, 0)]).steps[2]).toMatchObject({ n: 5, pct_of_step_before: null });
  });
});

describe("the KPIs say what they measure (ADR 0050)", () => {
  it("replaces the conversion KPI with agent connections, keeps the old reading, and adds outside tool calls", async () => {
    const at = Date.UTC(2027, 10, 15, 12);
    await seedDay(at - DAY);
    await bump(env, ["mcp:public:calls", "mcp:public:calls"], at - 2 * DAY);
    await bump(env, n("visit:human", 50), at - DAY);
    const k = await growthKpis(env, at);
    const byId = (id: string) => k.kpis.find((x) => x.id === id)!;
    expect(k.kpis.find((x) => x.id === "conversion")).toBeUndefined();
    const conv = byId("conversion_agents");
    expect(conv).toMatchObject({ name: "Agent connections per 100 people", value: 8, unit: "per 100" });
    expect(conv.definition).toContain("monitors");
    expect(conv.detail).toMatchObject({ connections: 4, people: 50, previous_definition: { id: "conversion", connections: 11, value: 22 } });
    const calls = byId("outside_tool_calls");
    expect(calls).toMatchObject({ value: 8, unit: "in 7 days", status: "below" });
    expect(calls.detail).toMatchObject({ yesterday: 6, mcp_tool_calls_all: 8 });
  });

  it("tool calls from outside apps are counted internally (F-02: /admin), never on /stats", async () => {
    const { outsideStatsData } = await import("../src/web/stats");
    expect("agent_outside_calls_7d" in (await outsideStatsData(env)).agent_funnel!).toBe(true);
    await bump(env, n("mcp:public:calls", 30));
    expect((await outsideStatsData(env)).agent_funnel!.agent_outside_calls_7d).toBeGreaterThanOrEqual(25);
    const page = await (await fetchWorker("/stats?t=real-use-2")).text();
    expect(page).not.toContain("tool calls from outside apps");
    // The gross twin counts them, with our own calls.
    expect(page).toMatch(/<tr data-k="ai_tool_calls_7d"><td>[^<]*ours included[^<]*<\/td><td class="num">[\d,]+<\/td>/);
  });
});
