import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSignedInForgeTool, LINK_LINE_GAP_MS, LINK_LINE_MAX, linkLine, linkLineAllowed, linkPromptEnabled, parseLinkState, personAtSession, type LinkState } from "../src/link-line";
import { linkForSession, sessionOutput } from "../src/hooks/session-start";
import { noteLinked } from "../src/hooks/strain";
import { AGENT_DIRECTED } from "../../../apps/forge/test/wording";

// OA-04 (owner acquisition plan, 28 Oct 2026): one person-facing line at session start, plus /forge:gauntlet.

const ORIGIN = "https://theagentforge.io";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T09:00:00Z");
const here = dirname(fileURLToPath(import.meta.url));

/** Runs one session a day for `days` days (a fake clock) and returns the 1-based session numbers that showed the line. */
function simulate(days: number, opts: { enabled?: boolean; linkedOnDay?: number } = {}) {
  let saved: string | null = null;
  const shownOn: number[] = [];
  for (let d = 0; d < days; d++) {
    const now = T0 + d * DAY;
    if (opts.linkedOnDay === d) noteLinked("mcp__plugin_forge_forge-reports__forge_me", saved, now, (t) => (saved = t));
    const r = linkForSession(parseLinkState(saved), now, opts.enabled ?? true, ORIGIN);
    if (r.line) {
      shownOn.push(d + 1);
      saved = JSON.stringify(r.state);
    }
  }
  return shownOn;
}

describe("the link line (OA-04)", () => {
  it("shows on sessions 1, 8 and 15 with a daily session, and never a 4th time", () => {
    expect(simulate(60)).toEqual([1, 8, 15]);
    expect(LINK_LINE_MAX).toBe(3);
    expect(LINK_LINE_GAP_MS).toBe(7 * DAY);
  });

  it("keeps at least 7 days between showings, however many sessions there are in between", () => {
    let state: LinkState = { shown: [] };
    const shown: number[] = [];
    for (let h = 0; h < 24 * 30; h += 5) {
      const r = linkForSession(state, T0 + h * 3_600_000, true, ORIGIN);
      if (r.line) shown.push(h);
      state = r.state;
    }
    expect(shown).toEqual([0, 170, 340]);
  });

  it("never shows when turned off (link_prompt=false or FORGE_LINK_PROMPT=false)", () => {
    expect(simulate(30, { enabled: false })).toEqual([]);
    expect(linkPromptEnabled({})).toBe(true);
    expect(linkPromptEnabled({ CLAUDE_PLUGIN_OPTION_LINK_PROMPT: "false" })).toBe(false);
    expect(linkPromptEnabled({ CLAUDE_PLUGIN_OPTION_LINK_PROMPT: "true", FORGE_LINK_PROMPT: "0" })).toBe(false);
    expect(linkPromptEnabled({ FORGE_LINK_PROMPT: "off" })).toBe(false);
  });

  it("stops for good after a signed-in Forge tool call succeeds", () => {
    expect(simulate(30, { linkedOnDay: 0 })).toEqual([]);
    expect(simulate(30, { linkedOnDay: 3 })).toEqual([1]);
  });

  it("only a tool on the signed-in server (forge-reports) counts as linked", () => {
    for (const t of ["mcp__plugin_forge_forge-reports__forge_report", "mcp__forge-reports__forge_me", "mcp__plugin_forge_forge-reports__arena_start"]) expect(isSignedInForgeTool(t), t).toBe(true);
    for (const t of ["mcp__plugin_forge_forge__forge_check", "mcp__plugin_forge_forge-gauntlet__gauntlet_start", "Bash", "mcp__other__forge-reports", "mcp__evil_forge-reports__x"]) expect(isSignedInForgeTool(t), t).toBe(false);
    let saved: string | null = null;
    expect(noteLinked("mcp__plugin_forge_forge__forge_check", saved, T0, (t) => (saved = t))).toBe(false);
    expect(saved).toBeNull();
    expect(noteLinked("mcp__plugin_forge_forge-reports__forge_report", saved, T0, (t) => (saved = t))).toBe(true);
    expect(parseLinkState(saved).linked_at).toBe(T0);
    expect(noteLinked("mcp__plugin_forge_forge-reports__forge_report", saved, T0 + DAY, (t) => (saved = t))).toBe(false);
  });

  it("recognises the signed-in server under the new plugin name and the old one (ADR 0121 rename)", () => {
    for (const t of ["mcp__plugin_theagentforge_forge-reports__forge_report", "mcp__plugin_theagentforge_forge-reports__forge_me", "mcp__plugin_forge_forge-reports__forge_me"]) expect(isSignedInForgeTool(t), t).toBe(true);
    for (const t of ["mcp__plugin_theagentforge_forge__forge_check", "mcp__plugin_theagentforge_forge-gauntlet__gauntlet_start", "mcp__plugin_theagentforge_forge-reports__authenticate", "mcp__plugin_xtheagentforge_forge-reports__forge_me"]) expect(isSignedInForgeTool(t), t).toBe(false);
  });

  it("the slash commands name themselves under the new plugin name, never the old one", () => {
    for (const f of ["gauntlet.md", "sprint.md"]) {
      const t = readFileSync(join(here, "..", "plugin", "commands", f), "utf8");
      expect(t, f).toContain(`/theagentforge:${f.replace(".md", "")}`);
      expect(t, f).not.toMatch(/(^|[^a-z])\/forge:/);
    }
  });

  it("never shows in a run with no person at it: claude -p (any --output-format), the Agent SDK, CI, or an unknown entrypoint", () => {
    const cli = { CLAUDE_CODE_ENTRYPOINT: "cli" };
    expect(linkLineAllowed(cli, "startup")).toBe(true);
    expect(linkLineAllowed({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }, undefined)).toBe(true);
    for (const ep of ["sdk-cli", "sdk-ts", "sdk-py", "claude-code-github-action", "mcp", "remote", "local-agent", "", "  "]) expect(personAtSession({ CLAUDE_CODE_ENTRYPOINT: ep }), ep).toBe(false);
    expect(personAtSession({})).toBe(false);
    for (const k of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TF_BUILD", "CLAUDE_CODE_ACTION"]) expect(personAtSession({ ...cli, [k]: "true" }), k).toBe(false);
    expect(personAtSession({ ...cli, CI: "false" })).toBe(true);
    expect(personAtSession({ ...cli, CI: "" })).toBe(true);
    // Only a fresh start: never on resume, /clear or a compaction of a running session.
    for (const source of ["resume", "clear", "compact"]) expect(linkLineAllowed(cli, source), source).toBe(false);
    // The opt-outs still win at an interactive terminal.
    expect(linkLineAllowed({ ...cli, FORGE_LINK_PROMPT: "false" }, "startup")).toBe(false);
    expect(linkLineAllowed({ ...cli, CLAUDE_PLUGIN_OPTION_LINK_PROMPT: "false" }, "startup")).toBe(false);
  });

  it("Claude Code's sign-in pseudo-tools on forge-reports don't count as linked, nor another plugin's forge-reports", () => {
    for (const t of ["mcp__plugin_forge_forge-reports__authenticate", "mcp__forge-reports__complete_authentication", "mcp__plugin_evil_forge-reports__forge_me"]) expect(isSignedInForgeTool(t), t).toBe(false);
    let saved: string | null = null;
    expect(noteLinked("mcp__plugin_forge_forge-reports__authenticate", saved, T0, (t) => (saved = t))).toBe(false);
    expect(saved).toBeNull();
  });

  it("goes only to systemMessage (the person), never to additionalContext (the agent)", () => {
    const line = linkLine(ORIGIN);
    const withCard = sessionOutput({ context: ["trap card"], weekly: null, link: line })!;
    expect(withCard.systemMessage).toBe(line);
    expect(JSON.stringify(withCard.hookSpecificOutput)).not.toContain("Link this agent");
    const alone = sessionOutput({ context: [], weekly: null, link: line })!;
    expect(alone).toEqual({ systemMessage: line });
    const weekly = sessionOutput({ context: ["card", "weekly"], weekly: ["Forge weekly check: 1 skill"], link: line })!;
    expect(weekly.systemMessage).toBe(`Forge weekly check: 1 skill\n${line}`);
    expect((weekly.hookSpecificOutput as { additionalContext: string }).additionalContext).not.toContain("Link this agent");
    expect(sessionOutput({ context: [], weekly: null, link: null })).toBeNull();
  });

  it("says the plan's words, with the steps page attributed to the plugin and the way to turn it off", () => {
    expect(linkLine(ORIGIN)).toBe(
      "Link this agent to you on The Agent Forge (30 s): type /mcp, pick forge-reports, choose Authenticate. Steps: https://theagentforge.io/connect?from=plugin&app=claude-code#link-step · Turn this off: link_prompt=false.",
    );
  });

  it("reads a damaged or old state file as empty, and keeps at most 3 timestamps", () => {
    expect(parseLinkState(null)).toEqual({ shown: [] });
    expect(parseLinkState("{nope")).toEqual({ shown: [] });
    expect(parseLinkState(JSON.stringify({ shown: ["x", 1, 2, 3, 4] }))).toEqual({ shown: [2, 3, 4] });
  });

  it("is a plugin setting, on by default", () => {
    const manifest = JSON.parse(readFileSync(join(here, "..", "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { userConfig: Record<string, { type: string; default: unknown }> };
    expect(manifest.userConfig.link_prompt).toMatchObject({ type: "boolean", default: true });
  });
});

describe("the built SessionStart hook (what Claude Code actually runs)", () => {
  const hook = join(here, "..", "release", "forge", "hooks", "session-start.mjs");
  /** Runs the shipped hook with a fresh data folder and returns its stdout (the trap card and weekly check off). */
  const run = (env: Record<string, string>, input: object = { source: "startup" }) => {
    const data = mkdtempSync(join(tmpdir(), "forge-link-"));
    try {
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GITHUB_ACTIONS|GITLAB_CI|BUILDKITE|JENKINS_URL|TF_BUILD|CLAUDE_CODE_ACTION|CLAUDE_CODE_ENTRYPOINT|FORGE_LINK_PROMPT|CLAUDE_PLUGIN_OPTION_.*|VITEST.*)$/.test(k)));
      return execFileSync(process.execPath, [hook], {
        input: JSON.stringify(input),
        env: { ...base, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_TRAP_CARD: "false", CLAUDE_PLUGIN_OPTION_WEEKLY_CHECK: "false", ...env },
        encoding: "utf8",
        timeout: 10_000,
      });
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  };
  it("shows the line to the person at an interactive terminal, in systemMessage only", () => {
    const out = JSON.parse(run({ CLAUDE_CODE_ENTRYPOINT: "cli" })) as Record<string, unknown>;
    expect(out).toEqual({ systemMessage: linkLine(ORIGIN) });
  });

  it("prints nothing for claude -p, the Agent SDK, CI, a resume, or with an opt-out", () => {
    for (const env of <Record<string, string>[]>[{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, { CLAUDE_CODE_ENTRYPOINT: "cli", CI: "true" }, { CLAUDE_CODE_ENTRYPOINT: "cli", FORGE_LINK_PROMPT: "false" }, { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_OPTION_LINK_PROMPT: "false" }, {}])
      expect(run(env), JSON.stringify(env)).toBe("");
    expect(run({ CLAUDE_CODE_ENTRYPOINT: "cli" }, { source: "resume" })).toBe("");
  });
});

describe("/theagentforge:gauntlet (OA-04)", () => {
  const text = readFileSync(join(here, "..", "plugin", "commands", "gauntlet.md"), "utf8");

  it("exists as a plugin command with a description, run through the no-sign-in Gauntlet server", () => {
    expect(text).toMatch(/^---\ndescription: .+\n---\n/);
    expect(text).toContain("/mcp/gauntlet");
    expect(text).toContain("forge-gauntlet");
    for (const tool of ["gauntlet_start", "gauntlet_act", "gauntlet_status"]) expect(text).toContain(tool);
  });

  it("asks the person first, and gives them the claim link privately", () => {
    expect(text).toMatch(/Ask the person to confirm with a yes, and start only after that yes/);
    expect(text).toContain("claim.url");
    expect(text).toMatch(/private/);
  });

  it("holds no imperative wording aimed at other agents (the wording guard)", () => {
    expect(AGENT_DIRECTED.exec(text)?.[0] ?? null).toBeNull();
  });

  it("the build connects the Gauntlet server next to the other two", () => {
    const build = readFileSync(join(here, "..", "build.mjs"), "utf8");
    expect(build).toContain('"forge-gauntlet": { type: "http", url: `${origin}/mcp/gauntlet` }');
  });
});

describe("/theagentforge:sprint and the Sprint offer (ADR 0083)", () => {
  const sprint = readFileSync(join(here, "..", "plugin", "commands", "sprint.md"), "utf8");
  const gauntlet = readFileSync(join(here, "..", "plugin", "commands", "gauntlet.md"), "utf8");

  it("runs one Sprint through the no-sign-in server, after a yes, with the claim link kept private", () => {
    expect(sprint).toMatch(/^---\ndescription: .+\n---\n/);
    expect(sprint).toContain('"mode": "sprint"');
    expect(sprint).toContain("forge-gauntlet");
    expect(sprint).toMatch(/Ask the person to confirm with a yes, and start only after that yes/);
    expect(sprint).toContain("invented sandbox money");
    expect(sprint).toContain("not a Gauntlet score");
    expect(sprint).toContain("not in any sandbox tool call");
  });

  it("/theagentforge:gauntlet offers the Sprint first", () => {
    expect(gauntlet.indexOf("Sprint")).toBeGreaterThan(-1);
    expect(gauntlet.indexOf("offer the Sprint first")).toBeLessThan(gauntlet.indexOf("The full run:"));
  });
});

