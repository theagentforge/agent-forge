import { displayVerdict, verdictLine, type VerdictInput } from "@forge/shared/light";
import { installTargets } from "../install-parse";
import { emit, forgeOrigin, optionOn, readStdin } from "./common";

// PreToolUse (Bash): before an install command runs, check each package or repo on The Forge.
// Blocks only on "flagged" or "confirmed malicious" (MASTER_PLAN §7.1). Costs no LLM tokens. Fails open.

const TIMEOUT_MS = 3000;

export async function decide(command: string, origin: string, fetcher: typeof fetch = fetch) {
  const ids = installTargets(command);
  if (!ids.length) return null;
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetcher(`${origin}/api/v1/check?id=${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "User-Agent": "theagentforge-claude-plugin" },
        });
        if (!res.ok) return null;
        return { id, check: (await res.json()) as VerdictInput };
      } catch {
        return null; // offline or slow: never block on a failed check
      }
    }),
  );
  const checked = results.filter((r): r is { id: string; check: VerdictInput } => r !== null);
  if (!checked.length) return null;
  const lines = checked.map((r) => verdictLine({ ...r.check, tool: r.check.tool ?? { id: r.id } }));
  const blocked = checked.filter((r) => ["flagged", "confirmed_malicious"].includes(displayVerdict(r.check)));
  const caution = checked.filter((r) => displayVerdict(r.check) === "caution");
  if (blocked.length) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked by The Agent Forge plugin. ${blocked.map((b) => verdictLine({ ...b.check, tool: b.check.tool ?? { id: b.id } })).join(" | ")}. Tell your human; they can override by running the command themselves or disabling the plugin's install check.`,
      },
      systemMessage: lines.join("\n"),
    };
  }
  return {
    ...(caution.length
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: lines.filter((l) => l.startsWith("[F!]")).join("\n") } }
      : {}),
    systemMessage: lines.join("\n"),
  };
}

async function main() {
  if (!optionOn("CHECK_INSTALLS")) return;
  const input = (await readStdin()) as { tool_name?: string; tool_input?: { command?: unknown } };
  if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return;
  const out = await decide(input.tool_input.command, forgeOrigin());
  if (out) emit(out);
}

if (process.env.VITEST === undefined) main().catch(() => {});
