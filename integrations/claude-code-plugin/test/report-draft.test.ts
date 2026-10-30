import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { draftMessage, drafts, isForgeServer, MIN_CALLS, PLUGIN_NAMES, PLUGIN_SERVERS, REDRAFT_AFTER_MS, serverOf } from "../src/report-draft";
import { emptyState, NUDGE_TEXT, recordFailure, recordSuccess } from "../src/strain-state";
import { AGENT_DIRECTED } from "../../../apps/forge/test/wording";

const NOW = 1_800_000_000_000;
const here = dirname(fileURLToPath(import.meta.url));

function session() {
  const s = emptyState();
  for (let i = 0; i < 5; i++) recordSuccess(s, "mcp__github__create_issue", NOW);
  for (let i = 0; i < 3; i++) recordFailure(s, "mcp__github__search", "h", NOW);
  recordSuccess(s, "mcp__linear__list", NOW);
  for (let i = 0; i < 9; i++) recordSuccess(s, "Bash", NOW);
  for (let i = 0; i < 9; i++) recordSuccess(s, "mcp__plugin_forge_forge__forge_check", NOW);
  return s;
}

describe("report drafts", () => {
  it("groups MCP tools by server and skips built-ins and the Forge itself", () => {
    expect(serverOf("mcp__github__create_issue")).toBe("github");
    expect(serverOf("mcp__claude_ai_Linear__list")).toBe("claude_ai_Linear");
    expect(serverOf("Bash")).toBeNull();
    expect(serverOf("mcp__forge__forge_check")).toBeNull();
    expect(serverOf("mcp__plugin_forge_forge__forge_report")).toBeNull();
  });

  it("skips every server the plugin ships, under the new and the old plugin name (ADR 0121)", () => {
    for (const p of ["theagentforge", "forge"]) {
      expect(serverOf(`mcp__plugin_${p}_forge__forge_check`)).toBeNull();
      expect(serverOf(`mcp__plugin_${p}_forge-reports__forge_report`)).toBeNull();
      expect(serverOf(`mcp__plugin_${p}_forge-reports__forge_me`)).toBeNull();
      expect(serverOf(`mcp__plugin_${p}_forge-gauntlet__gauntlet_start`)).toBeNull();
      expect(serverOf(`mcp__PLUGIN_${p.toUpperCase()}_FORGE-REPORTS__forge_me`)).toBeNull();
    }
    // The same servers added by hand under their plain names.
    expect(serverOf("mcp__forge-reports__forge_report")).toBeNull();
    expect(serverOf("mcp__forge-gauntlet__gauntlet_start")).toBeNull();
    // Other plugins' and other people's servers are still drafted.
    expect(serverOf("mcp__plugin_other_forge-reports__x")).toBe("plugin_other_forge-reports");
    expect(serverOf("mcp__plugin_theagentforge_github__x")).toBe("plugin_theagentforge_github");
    expect(serverOf("mcp__forge-reportsx__x")).toBe("forge-reportsx");
    expect(serverOf("mcp__my-forge-gauntlet__x")).toBe("my-forge-gauntlet");
  });

  it("skips exactly the servers build.mjs ships in the plugin's .mcp.json", () => {
    const shipped = Object.keys(JSON.parse(readFileSync(join(here, "..", "release", "forge", ".mcp.json"), "utf8")).mcpServers);
    expect([...shipped].sort()).toEqual([...PLUGIN_SERVERS].sort());
    for (const server of shipped) {
      expect(isForgeServer(server), server).toBe(true);
      for (const p of PLUGIN_NAMES) expect(serverOf(`mcp__plugin_${p}_${server}__any_tool`), `${p} ${server}`).toBeNull();
    }
  });

  it("leaves the plugin's own servers out of the end-of-session drafts", () => {
    const s = session();
    for (const p of PLUGIN_NAMES) {
      for (let i = 0; i < 5; i++) recordSuccess(s, `mcp__plugin_${p}_forge-reports__forge_report`, NOW);
      for (let i = 0; i < 5; i++) recordFailure(s, `mcp__plugin_${p}_forge-gauntlet__gauntlet_act`, "g", NOW);
      for (let i = 0; i < 5; i++) recordSuccess(s, `mcp__plugin_${p}_forge__forge_check`, NOW);
    }
    expect(drafts(s, {}, NOW).map((x) => x.server)).toEqual(["github"]);
  });

  it(`drafts only servers with at least ${MIN_CALLS} calls, with merged strain counts`, () => {
    const d = drafts(session(), {}, NOW);
    expect(d.map((x) => x.server)).toEqual(["github"]);
    expect(d[0]).toMatchObject({ calls: 8, failures: 3 });
    expect(d[0]!.strain).toMatchObject({ source: "hook", attempts: 8, tool_errors: 3, loop_detected: true });
  });

  it("doesn't draft the same server again within 3 days", () => {
    expect(drafts(session(), { github: NOW - 1000 }, NOW)).toEqual([]);
    expect(drafts(session(), { github: NOW - REDRAFT_AFTER_MS }, NOW)).toHaveLength(1);
  });

  it("gives the owner's one-line yes/no as data and says nothing was sent", () => {
    const m = draftMessage(drafts(session(), {}, NOW));
    expect(m).toContain("nothing has been sent; filing needs owner confirmation");
    expect(m).toContain('Owner question, one line: "File short Forge field reports for github? (yes/no)"');
    expect(m).toContain("MCP server github: 8 calls, 3 failures this session");
    expect(m).toContain("show --server github");
    expect(m).toContain("https://theagentforge.io/connect");
    expect(m).not.toMatch(AGENT_DIRECTED);
  });

  it("lists install drafts with their one-step owner link and report body", () => {
    const report = { tool: { kind: "mcp_server", id: "npm:x", version: "1.2.3", fingerprint: `sha256:${"c".repeat(64)}` }, outcome: "worked" };
    const m = draftMessage([], [{ id: "npm:x", line: "Field report draft for npm:x@1.2.3: outcome worked; issues none; not filed; filing needs owner confirmation", url: "https://theagentforge.io/report?tool=npm%3Ax", report }]);
    expect(m).toContain("- Field report draft for npm:x@1.2.3: outcome worked; issues none; not filed; filing needs owner confirmation; one-step owner link: https://theagentforge.io/report?tool=npm%3Ax; forge_report body: {");
    expect(m).toContain('"File short Forge field reports for npm:x? (yes/no)"');
    expect(m).not.toMatch(AGENT_DIRECTED);
  });

  it("words the loop nudge as data, not instructions", () => {
    expect(NUDGE_TEXT).toContain("failed 3 times in a row");
    expect(NUDGE_TEXT).not.toMatch(AGENT_DIRECTED);
    expect(NUDGE_TEXT).not.toMatch(/\b(check it|file a report|retry once|ask your human)\b/i);
  });
});
