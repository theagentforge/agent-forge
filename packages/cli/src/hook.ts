import { checkParams, installRefs } from "@forge/shared/install-parse";
import { checkChanges, checkKey, checkMemo, displayVerdict, sinceLine, verdictLine, type CheckAnswerLike, type MemoryFile, type VerdictInput } from "@forge/shared/light";
import type { NotedTool } from "./state";

// `forge hook <client>`: a pre-install check for coding agents other than Claude Code (which has its own plugin).
// The client runs this before a shell command and passes the call as JSON on stdin. If the command installs a
// package or clones a repo, each one is checked on The Forge. Only "flagged" and "confirmed malicious" are denied;
// everything else, and every error or timeout, lets the command through unchanged (fail open, MASTER_PLAN §7.1).
// The deny reason is one line of data (verdict lines), never instructions to the agent (AGENTS.md rule 7).
//
// Each client's contract was taken from its own docs or source (24 Oct 2026):
//   codex   https://raw.githubusercontent.com/openai/codex/main/codex-rs/hooks/src/schema.rs (stdin/stdout wire types)
//           https://raw.githubusercontent.com/openai/codex/main/codex-rs/hooks/src/events/pre_tool_use.rs (exit codes,
//           tool_name "Bash" with tool_input {command}, "allow" without updatedInput is unsupported, so print nothing)
//           https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/hooks.rs (hooks.json keys)
//           https://raw.githubusercontent.com/openai/codex/main/codex-rs/hooks/src/engine/discovery.rs (hooks.json per layer)
//   gemini  https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md (BeforeTool, decision/reason)
//           https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md (settings.json locations)
//           https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/shell.md (run_shell_command {command})
//   copilot https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/hooks-reference.md
//           (source of docs.github.com/en/copilot/reference/hooks-reference: preToolUse, toolName/toolArgs,
//           permissionDecision, matcher; a non-zero exit other than a timeout DENIES, so this always exits 0)

export const HOOK_TIMEOUT_MS = 3000;
const PACKAGE = "@theagentforge/cli";

type Json = Record<string, unknown>;

interface Client {
  /** The shell command in this client's stdin payload, or null when the call isn't a shell command. */
  command(input: Json): string | null;
  /** What to print when there's no objection ("" prints nothing, which every client reads as "carry on as usual"). */
  allow: string;
  deny(reason: string): string;
  /** Where the config goes, most specific first. */
  files: string[];
  config(cmd: string): Json;
}

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** Tool arguments arrive as an object, or as a JSON string (Copilot's `toolArgs`). */
function args(v: unknown): Json | null {
  if (typeof v === "string") {
    try {
      return obj(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return obj(v);
}

const commandOf = (a: Json | null) => (typeof a?.command === "string" ? a.command : null);

export const CLIENTS = {
  codex: {
    command: (i) => (i.tool_name === "Bash" ? commandOf(args(i.tool_input)) : null),
    allow: "",
    deny: (reason) =>
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
    files: ["<repo>/.codex/hooks.json", "~/.codex/hooks.json"],
    config: (cmd) => ({ hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: cmd, timeout: 10 }] }] } }),
  },
  gemini: {
    command: (i) => (i.tool_name === "run_shell_command" ? commandOf(args(i.tool_input)) : null),
    // Gemini parses stdout as JSON; an empty object makes no decision, so its normal confirmation flow runs.
    allow: "{}",
    deny: (reason) => JSON.stringify({ decision: "deny", reason }),
    files: [".gemini/settings.json", "~/.gemini/settings.json"],
    config: (cmd) => ({
      hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ name: "agent-forge-install-check", type: "command", command: cmd, timeout: 10000 }] }] },
    }),
  },
  copilot: {
    command: (i) => {
      // camelCase payload (event "preToolUse"): toolName "bash" or "powershell", toolArgs. The PascalCase,
      // VS Code-compatible payload ("PreToolUse") uses tool_name "Bash" and tool_input instead.
      const name = typeof i.toolName === "string" ? i.toolName : i.tool_name;
      if (name !== "bash" && name !== "powershell" && name !== "Bash") return null;
      return commandOf(args(i.toolArgs ?? i.tool_input));
    },
    allow: "",
    deny: (reason) => JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: reason }),
    files: [".github/hooks/agent-forge.json", "~/.copilot/hooks/agent-forge.json"],
    config: (cmd) => ({
      version: 1,
      hooks: { preToolUse: [{ type: "command", matcher: "bash|powershell", bash: cmd, powershell: cmd, timeoutSec: 10 }] },
    }),
  },
} satisfies Record<string, Client>;

export type HookClient = keyof typeof CLIENTS;
export const isHookClient = (c: string | undefined): c is HookClient => !!c && Object.hasOwn(CLIENTS, c);

/** The command a client should run, e.g. `npx -y @theagentforge/cli hook codex`. */
export function hookCommand(client: HookClient, origin?: string): string {
  return `npx -y ${PACKAGE} hook ${client}${origin ? ` --origin ${origin}` : ""}`;
}

/** The config snippet to merge into the client's config file. */
export function hookConfig(client: HookClient, origin?: string): { client: HookClient; files: string[]; config: Json } {
  const c: Client = CLIENTS[client];
  return { client, files: c.files, config: c.config(hookCommand(client, origin)) };
}

export interface HookDeps {
  origin: string;
  fetch: typeof fetch;
  userAgent: string;
  timeoutMs?: number;
  /** The local memory of earlier answers ("since your last check"), updated in place. */
  memory?: MemoryFile;
  now?: number;
  /** Filled with the tools checked, for `forge report` drafts (ids and versions only). */
  noted?: NotedTool[];
  client?: string;
}

type Answer = VerdictInput & CheckAnswerLike & { tool: { id: string; kind?: string } | null; fingerprint?: string | null };

/**
 * What to print for one hook call: the client's deny JSON when any install target is flagged or confirmed
 * malicious, otherwise the client's "no objection" output. Never throws.
 */
export async function hookAnswer(client: HookClient, stdin: string, deps: HookDeps): Promise<string> {
  const c: Client = CLIENTS[client];
  try {
    const input = obj(JSON.parse(stdin));
    const command = input ? c.command(input) : null;
    if (!command) return c.allow;
    const refs = installRefs(command);
    if (!refs.length) return c.allow;
    // One deadline for the whole check, so several packages still answer within the timeout.
    const signal = AbortSignal.timeout(deps.timeoutMs ?? HOOK_TIMEOUT_MS);
    const results = await Promise.all(
      refs.map(async (ref) => {
        const { id } = ref;
        try {
          // The pinned version (npm name@1.2.3, pip name==1.2.3) lets an advisory for that version flag it.
          const res = await deps.fetch(`${deps.origin}/api/v1/check?${checkParams(ref)}`, {
            headers: { Accept: "application/json", "User-Agent": deps.userAgent },
            signal,
          });
          if (!res.ok) return null;
          const check = obj(await res.json()) as Answer | null;
          return check && typeof check.security_status === "string" ? { id, ref, check } : null;
        } catch {
          return null; // offline, slow or garbled: never block on a failed check
        }
      }),
    );
    const ok = results.filter((r) => r !== null);
    const at = new Date(deps.now ?? Date.now()).toISOString();
    // "Since your last check" from the local memory, which then keeps this answer. Only the deny reason carries it:
    // an allowed command prints nothing, as every client expects.
    const since = new Map<string, string>();
    for (const r of ok) {
      deps.noted?.push({ id: r.check.tool?.id ?? r.id, kind: r.check.tool?.kind ?? null, pinned: r.ref.version ?? null, check_version: r.check.version ?? null, check_fp: typeof r.check.fingerprint === "string" ? r.check.fingerprint : null, via: deps.client ?? "hook", at });
      if (!deps.memory) continue;
      const key = checkKey(r.ref.id, r.ref.version);
      const next = checkMemo(r.check, at);
      const ch = checkChanges(deps.memory.checks[key], next);
      deps.memory.checks[key] = next;
      if (ch?.changed) since.set(r.id, sinceLine(ch));
    }
    const blocked = ok.filter((r) => displayVerdict(r.check) === "flagged" || displayVerdict(r.check) === "confirmed_malicious");
    if (!blocked.length) return c.allow;
    const lines = blocked.map((b) => `${verdictLine({ ...b.check, tool: b.check.tool ?? { id: b.id } })}${since.has(b.id) ? ` (${since.get(b.id)})` : ""}`);
    return c.deny(`The Agent Forge: ${lines.join(" | ")}`.replace(/\s+/g, " "));
  } catch {
    return c.allow;
  }
}
