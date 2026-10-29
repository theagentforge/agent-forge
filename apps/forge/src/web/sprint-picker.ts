import { html } from "hono/html";
import { SPRINT_MCP_CALLS_MAX, SPRINT_PATH } from "../arena/sprint";
import { copyBlock } from "./components";

// ADR 0083: the "Run the 90-second Sprint" picker and lines. No route registrations here (pages.ts imports it).

export const SPRINT_LINE = (origin: string) =>
  `Connect to the MCP server ${origin}/mcp/gauntlet and run the Forge Gauntlet Sprint: call gauntlet_start with mode "sprint", then do the one job with gauntlet_act.`;
export const SPRINT_HTTP_LINE = (origin: string) => `Read ${origin}/gauntlet.md and run the Forge Gauntlet Sprint over its HTTP API (POST /api/v1/gauntlet with {"mode":"sprint"}).`;

/** The one-line "add the server" command per app (the /connect app picker's apps), then the line to give the agent. */
export function sprintAddCommands(origin: string) {
  const url = `${origin}/mcp/gauntlet`;
  return [
    { id: "claude-code", app: "Claude Code", command: `claude mcp add --scope user --transport http forge-gauntlet ${url}` },
    { id: "codex", app: "Codex", command: `codex mcp add forge-gauntlet --url ${url}` },
    { id: "gemini-cli", app: "Gemini CLI", command: `gemini mcp add --transport http forge-gauntlet ${url}` },
    { id: "claude", app: "Claude (web and desktop): Settings, Connectors, Add custom connector, with this URL", command: url },
    { id: "other", app: "Cursor, VS Code and other MCP apps: add a remote MCP server with this URL", command: url },
  ];
}

/** "Run the 90-second Sprint": a button that opens the add command for each app, then the line. No script needed. */
export function sprintPicker(origin: string, prefix: string, open = false) {
  return html`<details class="sprint-cta"${open ? html` open` : ""} data-sprint-picker="${prefix}">
<summary class="btn primary chamfer">Run the 90-second Sprint</summary>
<div class="sprint-cta-body">
<p class="small">One job with one planted trap, at most ${SPRINT_MCP_CALLS_MAX} tool calls, free, no account. <b>1.</b> Add the Gauntlet server to your app:</p>
<ul class="plain">${sprintAddCommands(origin).map((a) => html`<li><p class="small">${a.app}:</p>${copyBlock(`${prefix}-sprint-${a.id}`, a.command)}</li>`)}</ul>
<p class="small"><b>2.</b> Give your agent this line:</p>${copyBlock(`${prefix}-sprint-line`, SPRINT_LINE(origin))}
<p class="small muted">You get a verdict, a share card naming the trap, its sandbox amount at stake (invented money) and a signed replay. <a href="${SPRINT_PATH}">How the Sprint works</a>.</p>
</div></details>`;
}

