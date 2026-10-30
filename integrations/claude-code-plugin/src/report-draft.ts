import type { Strain } from "@forge/shared/light";
import { toStrain, type SessionState, type ToolCounts } from "./strain-state";

// ADR 0011 (f): at the end of a session, draft one field report per third-party MCP server the agent used, and ask
// the agent to confirm with its human in one line. Nothing is sent by the plugin: the agent files only after a yes.

/** Only servers used at least this often get a draft (one stray call isn't worth asking about). */
export const MIN_CALLS = 3;
/** The same server isn't drafted again for this long after a draft, whatever the human answered. */
export const REDRAFT_AFTER_MS = 3 * 86_400_000;
export const MAX_DRAFTS = 3;

export interface Draft {
  server: string;
  calls: number;
  failures: number;
  strain: Strain;
}

/** The MCP servers this plugin ships (build.mjs writes them into .mcp.json; a test keeps the two lists in step). */
export const PLUGIN_SERVERS = ["forge", "forge-reports", "forge-gauntlet"] as const;
/** This plugin's names in Claude Code: the current one and the one before the 0.8.0 rename (ADR 0121). */
export const PLUGIN_NAMES = ["theagentforge", "forge"] as const;

/**
 * Whether an MCP server name is one of the Forge's own: a server this plugin ships, as Claude Code names it
 * (`plugin_<plugin>_<server>`, under either plugin name), or the same server added by hand under its plain name.
 */
export function isForgeServer(server: string): boolean {
  const s = server.toLowerCase();
  return PLUGIN_SERVERS.some((name) => s === name || PLUGIN_NAMES.some((p) => s === `plugin_${p}_${name}`));
}

/** `mcp__github__create_issue` → `github`. Built-in tools and the Forge's own servers are skipped. */
export function serverOf(tool: string): string | null {
  const m = /^mcp__(.+?)__/.exec(tool);
  if (!m) return null;
  const server = m[1]!;
  // The Forge itself is never reported on: the plugin's own servers, and a server whose name ends in `forge`
  // (such as a claude.ai connector named "…_Forge").
  if (isForgeServer(server) || /(^|_)forge$/i.test(server)) return null;
  return server;
}

/** Sums the counts of every tool on one server, keeping the worst streaks. */
export function mergeCounts(list: ToolCounts[]): ToolCounts {
  const out: ToolCounts = { attempts: 0, tool_errors: 0, retries: 0, consecutive: 0, maxConsecutive: 0, lastWasFailure: false, lastFailHash: null, sameFailRepeat: 0, maxSameFailRepeat: 0, nudged: false };
  for (const c of list) {
    out.attempts += c.attempts;
    out.tool_errors += c.tool_errors;
    out.retries += c.retries;
    out.maxConsecutive = Math.max(out.maxConsecutive, c.maxConsecutive);
    out.maxSameFailRepeat = Math.max(out.maxSameFailRepeat, c.maxSameFailRepeat);
  }
  return out;
}

export function byServer(state: SessionState): Map<string, ToolCounts[]> {
  const m = new Map<string, ToolCounts[]>();
  for (const [tool, c] of Object.entries(state.tools)) {
    const s = serverOf(tool);
    if (s) m.set(s, [...(m.get(s) ?? []), c]);
  }
  return m;
}

/** The drafts for this session, busiest server first, skipping ones drafted recently. */
export function drafts(state: SessionState, lastDrafted: Record<string, number>, now: number): Draft[] {
  const out: Draft[] = [];
  for (const [server, list] of byServer(state)) {
    const c = mergeCounts(list);
    if (c.attempts < MIN_CALLS) continue;
    if (now - (lastDrafted[server] ?? 0) < REDRAFT_AFTER_MS) continue;
    out.push({ server, calls: c.attempts, failures: c.tool_errors, strain: toStrain(c) });
  }
  return out.sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server)).slice(0, MAX_DRAFTS);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** An install draft as the Stop hook lists it (src/installs.ts). */
export interface InstallDraftLine {
  id: string;
  /** "Field report draft for npm:x@1.2.3: …" (draftLine in @forge/shared/light). */
  line: string;
  /** The pre-filled /report page: the owner reviews it and files with one click after GitHub sign-in. */
  url: string;
  /** The forge_report body, when the draft is complete; null when the page has to ask for the version. */
  report: Record<string, unknown> | null;
}

/**
 * The Stop-hook message. Data only (AGENTS.md rule 7): what was drafted, that nothing was sent, the owner's yes/no
 * question word for word, and the two ways a confirmed draft is filed. No instructions to the agent.
 */
export function draftMessage(list: Draft[], installs: InstallDraftLine[] = [], origin = "https://theagentforge.io"): string {
  const names = [...list.map((d) => d.server), ...installs.map((i) => i.id)].join(", ");
  const lines = [
    ...list.map((d) => `- MCP server ${d.server}: ${plural(d.calls, "call")}, ${plural(d.failures, "failure")} this session; strain counts: output of node "\${CLAUDE_PLUGIN_ROOT}/hooks/strain.mjs" show --server ${d.server}`),
    ...installs.map((i) => `- ${i.line}; one-step owner link: ${i.url}${i.report ? `; forge_report body: ${JSON.stringify(i.report)}` : ""}`),
  ];
  return [
    "Forge plugin: field report drafts, not filed (nothing has been sent; filing needs owner confirmation).",
    ...lines,
    `Owner question, one line: "File short Forge field reports for ${names}? (yes/no)"`,
    "Filing after an owner yes: forge_report on the forge-reports server (GitHub sign-in on first use) with each draft's package id, exact version, outcome (worked, partial or failed) and strain counts; or the owner's one-step link above (GitHub sign-in, then one click).",
    `Account connection: ${origin}/connect`,
    "After a no, or no answer: nothing is filed, and these tools get no new draft for 3 days.",
  ].join("\n");
}
