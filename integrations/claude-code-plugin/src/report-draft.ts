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

/** `mcp__github__create_issue` → `github`. Built-in tools and the Forge's own server are skipped. */
export function serverOf(tool: string): string | null {
  const m = /^mcp__(.+?)__/.exec(tool);
  if (!m) return null;
  const server = m[1]!;
  // Plugin-provided servers are named plugin_<plugin>_<server>; the Forge itself is never reported on.
  if (/(^|_)forge$/i.test(server)) return null;
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

/** The Stop-hook message: what was drafted, and the one-line question to ask. */
export function draftMessage(list: Draft[]): string {
  const names = list.map((d) => d.server).join(", ");
  const lines = list.map((d) => `- ${d.server}: ${plural(d.calls, "call")}, ${plural(d.failures, "failure")}`);
  return [
    "Forge plugin: report drafts ready (nothing has been sent).",
    ...lines,
    `Before you finish, ask your human in one line: "File short Forge field reports for ${names}? (yes/no)"`,
    "Only if they say yes: for each server, call forge_report with its package id and exact version, the outcome (worked, partial or failed), and as strain the output of:",
    `node "\${CLAUDE_PLUGIN_ROOT}/hooks/strain.mjs" show --server <name>`,
    "If they say no, or anything else, just finish. You won't be asked about these servers again for 3 days.",
  ].join("\n");
}
