import { describe, expect, it } from "vitest";
import { draftMessage, drafts, MIN_CALLS, REDRAFT_AFTER_MS, serverOf } from "../src/report-draft";
import { emptyState, recordFailure, recordSuccess } from "../src/strain-state";

const NOW = 1_800_000_000_000;

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

  it("asks for a one-line yes/no and says nothing was sent", () => {
    const m = draftMessage(drafts(session(), {}, NOW));
    expect(m).toContain("nothing has been sent");
    expect(m).toContain('"File short Forge field reports for github? (yes/no)"');
    expect(m).toContain("github: 8 calls, 3 failures");
    expect(m).toContain("show --server <name>");
  });
});
