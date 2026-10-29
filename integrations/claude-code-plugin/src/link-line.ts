// OA-04 (owner acquisition plan, 28 Oct 2026; Dinike approved D7): one line at session start, to the person only,
// that shows how to link this agent to them. It goes in `systemMessage` (shown to the user in Claude Code, never put
// in the model's context, as the claim line in ADR 0055), never in `additionalContext`.
// - At most LINK_LINE_MAX times in total, at least LINK_LINE_GAP_MS apart, on a fresh interactive start only (never in
//   `claude -p`, the Agent SDK or CI, where the hook's output is read by a program, often another agent).
// - Never again once a signed-in Forge tool call has succeeded on this machine (a local flag, set by the PostToolUse
//   hook in hooks/strain.ts), or when the person turned it off (`link_prompt` in /plugin, or FORGE_LINK_PROMPT=false).
// Only timestamps are kept, in the plugin's data folder. Nothing is sent anywhere.

export const LINK_LINE_MAX = 3;
export const LINK_LINE_GAP_MS = 7 * 86_400_000;

/** Where the line's steps are spelled out on the website (`from=plugin` attributes a website sign-in, ADR 0073). */
export const linkStepsUrl = (origin: string) => `${origin}/connect?from=plugin&app=claude-code#link-step`;

/** The line itself: for the person, in plain words (the plan's wording, plus the steps page). */
export const linkLine = (origin: string) =>
  `Link this agent to you on The Agent Forge (30 s): type /mcp, pick forge-reports, choose Authenticate. Steps: ${linkStepsUrl(origin)} · Turn this off: link_prompt=false.`;

export interface LinkState {
  /** When the line was shown (ms), oldest first. */
  shown: number[];
  /** When a signed-in Forge tool call first succeeded here (ms): the agent is linked, so the line stops for good. */
  linked_at?: number;
}

export function parseLinkState(text: string | null): LinkState {
  try {
    const j = JSON.parse(text ?? "") as Partial<LinkState>;
    const shown = Array.isArray(j.shown) ? j.shown.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(-LINK_LINE_MAX) : [];
    return { shown, ...(typeof j.linked_at === "number" ? { linked_at: j.linked_at } : {}) };
  } catch {
    return { shown: [] };
  }
}

/** True when this session should show the line. */
export function linkLineDue(state: LinkState, now: number, enabled: boolean): boolean {
  if (!enabled || state.linked_at !== undefined || state.shown.length >= LINK_LINE_MAX) return false;
  const last = state.shown.at(-1);
  return last === undefined || now - last >= LINK_LINE_GAP_MS;
}

/** Off when the plugin setting `link_prompt` is false, or the person set FORGE_LINK_PROMPT=false (or 0, off, no). */
export function linkPromptEnabled(env: Record<string, string | undefined>): boolean {
  const off = (v: string | undefined) => v !== undefined && /^(false|0|off|no)$/i.test(v.trim());
  return !off(env.CLAUDE_PLUGIN_OPTION_LINK_PROMPT) && !off(env.FORGE_LINK_PROMPT);
}

/**
 * Claude Code's own entrypoints where a person sits at the session and sees `systemMessage` (the CLI in a terminal,
 * the VS Code extension, the desktop app). Claude Code sets CLAUDE_CODE_ENTRYPOINT for every process it starts:
 * `cli` for an interactive terminal session, `sdk-cli` for `claude -p` (so also `--output-format json` and
 * `stream-json`), `sdk-ts` / `sdk-py` for the Agent SDK, `claude-code-github-action` in CI. In a non-interactive run the
 * hook's output is part of what the calling program (often another agent's shell) reads, so the line is never shown
 * there; nor when the entrypoint is unknown or missing.
 */
export const PERSON_ENTRYPOINTS = new Set(["cli", "claude-vscode", "claude-desktop"]);

/** CI and other automation flags: no person is reading, whatever the entrypoint says. */
const AUTOMATION_ENV = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TF_BUILD", "CLAUDE_CODE_ACTION"];

/** True when this session has a person at it: an interactive Claude Code entrypoint, outside CI. */
export function personAtSession(env: Record<string, string | undefined>): boolean {
  const set = (v: string | undefined) => v !== undefined && v.trim() !== "" && !/^(false|0)$/i.test(v.trim());
  if (AUTOMATION_ENV.some((k) => set(env[k]))) return false;
  return PERSON_ENTRYPOINTS.has((env.CLAUDE_CODE_ENTRYPOINT ?? "").trim());
}

/**
 * Whether this SessionStart may show the line: the person hasn't turned it off, a person is at the session, and the
 * session is a fresh start (not a resume, /clear or compaction of one already running).
 */
export function linkLineAllowed(env: Record<string, string | undefined>, source: unknown): boolean {
  return linkPromptEnabled(env) && personAtSession(env) && (source === undefined || source === "startup");
}

/** Claude Code's own pseudo-tools on a server that still needs sign-in: calling them doesn't mean the agent is linked. */
const AUTH_PSEUDO_TOOLS = new Set(["authenticate", "complete_authentication"]);

/**
 * A tool on the signed-in Forge server (`forge-reports`, the address `/mcp`). Claude Code names MCP tools
 * `mcp__<server>__<tool>`, and this plugin's servers `mcp__plugin_forge_<server>__<tool>`. That server lists no tools
 * until the person has signed in, so a successful call to one means this agent is linked; except Claude Code's own
 * `authenticate` / `complete_authentication` pseudo-tools, which it offers on a server that still needs sign-in
 * (`authenticate` only returns a sign-in link).
 */
export function isSignedInForgeTool(toolName: string): boolean {
  const m = /^mcp__(?:plugin_forge_)?forge-reports__([a-z_]+)$/i.exec(toolName);
  return !!m && !AUTH_PSEUDO_TOOLS.has(m[1]!.toLowerCase());
}

/** The state after a session decided whether to show the line. */
export const markShown = (state: LinkState, now: number): LinkState => ({ ...state, shown: [...state.shown, now].slice(-LINK_LINE_MAX) });
export const markLinked = (state: LinkState, now: number): LinkState => (state.linked_at !== undefined ? state : { ...state, linked_at: now });
