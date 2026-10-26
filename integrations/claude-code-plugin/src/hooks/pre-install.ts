import {
  CLAIM_LINE_EVERY_MS,
  checkChanges,
  claimLine,
  checkKey,
  checkMemo,
  displayVerdict,
  parseMemory,
  receiptOf,
  serializeMemory,
  sinceLine,
  verdictLine,
  type CheckAnswerLike,
  type MemoryFile,
  type VerdictInput,
} from "@forge/shared/light";
import { checkParams, installRefs, type InstallRef } from "@forge/shared/install-parse";
import { addInstalls, parseInstalls, type PendingInstall } from "../installs";
import { safeSessionId } from "../strain-state";
import { claimShownPath, commandHash, emit, forgeOrigin, installsPath, memoryPath, optionOn, readStdin, readText, writeText } from "./common";

// PreToolUse (Bash): before an install command runs, check each package or repo on The Forge.
// Blocks only on "flagged" or "confirmed malicious" (MASTER_PLAN §7.1). Costs no LLM tokens. Fails open.
// On a repeat check it says what changed since the last answer this machine got (kept in the plugin's data folder,
// never sent), and each tool's lines end with the answer's signed receipt link.

const TIMEOUT_MS = 3000;

type Answer = VerdictInput & CheckAnswerLike & { tool: { id: string; kind?: string } | null; fingerprint?: string | null };
export interface Checked {
  ref: InstallRef;
  check: Answer;
}

export interface DecideContext {
  /** The local memory of earlier answers; updated in place with this run's answers. */
  memory?: MemoryFile;
  now?: number;
  /** Filled with the answers, for the caller to note pending installs. */
  checked?: Checked[];
}

export async function decide(command: string, origin: string, fetcher: typeof fetch = fetch, ctx: DecideContext = {}) {
  const refs = installRefs(command);
  if (!refs.length) return null;
  const results = await Promise.all(
    refs.map(async (ref): Promise<Checked | null> => {
      try {
        // The pinned version (npm name@1.2.3, pip name==1.2.3) lets an advisory for that version flag it.
        const res = await fetcher(`${origin}/api/v1/check?${checkParams(ref)}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "User-Agent": "theagentforge-claude-plugin" },
        });
        if (!res.ok) return null;
        return { ref, check: (await res.json()) as Answer };
      } catch {
        return null; // offline or slow: never block on a failed check
      }
    }),
  );
  const checked = results.filter((r): r is Checked => r !== null);
  if (!checked.length) return null;
  ctx.checked?.push(...checked);
  const at = new Date(ctx.now ?? Date.now()).toISOString();
  const line = (r: Checked) => verdictLine({ ...r.check, tool: r.check.tool ?? { id: r.ref.id } });
  const subject = (r: Checked) => `${r.check.tool?.id ?? r.ref.id}${r.ref.version ? `@${r.ref.version}` : ""}`;
  // "Since your last check", per tool, from the local memory; then the memory is updated with this answer.
  const since = checked.map((r) => {
    if (!ctx.memory) return null;
    const key = checkKey(r.ref.id, r.ref.version);
    const next = checkMemo(r.check, at);
    const c = checkChanges(ctx.memory.checks[key], next);
    ctx.memory.checks[key] = next;
    return { changed: !!c?.changed, text: sinceLine(c) };
  });
  const block = checked.map((r, i) => {
    const receipt = receiptOf(r.check, origin);
    return [line(r), ...(since[i] ? [`  ${since[i]!.text}`] : []), ...(receipt ? [`  receipt: ${receipt}`] : [])].join("\n");
  });
  const blocked = checked.filter((r) => ["flagged", "confirmed_malicious"].includes(displayVerdict(r.check)));
  const caution = checked.filter((r) => displayVerdict(r.check) === "caution");
  if (blocked.length) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked by The Agent Forge plugin: ${blocked.map(line).join(" | ")}. Overrides: the person runs the command themselves, or turns off the plugin's install check (check_installs).`,
      },
      systemMessage: block.join("\n"),
    };
  }
  // For the agent: caution lines, and what changed since the last check (data only).
  const context = [
    ...caution.map(line),
    ...checked.flatMap((r, i) => (since[i]?.changed ? [`${subject(r)}: ${since[i]!.text}`] : [])),
  ];
  return {
    ...(context.length ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context.join("\n") } } : {}),
    systemMessage: block.join("\n"),
  };
}

/**
 * ADR 0055: after a finished check, one plain line for the person (in `systemMessage`, which Claude Code shows to the
 * user; never in the agent's context), at most once a week. `lastShown` is the time it was last shown, from a local file.
 */
export function withClaimLine<T extends { systemMessage?: string }>(out: T, origin: string, lastShown: number | null, now: number): { out: T; shown: boolean } {
  if (!out.systemMessage || (lastShown !== null && now - lastShown < CLAIM_LINE_EVERY_MS)) return { out, shown: false };
  return { out: { ...out, systemMessage: `${out.systemMessage}\n${claimLine(origin, "plugin")}` }, shown: true };
}

/** When the claim line was last shown on this machine, or null. */
export function parseClaimShown(text: string | null): number | null {
  try {
    const at = (JSON.parse(text ?? "null") as { shown_at?: unknown } | null)?.shown_at;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Pending installs for the one-step field report drafts (src/installs.ts). */
export function pendingInstalls(checked: Checked[], session: string, command: string, now: number): PendingInstall[] {
  return checked.map((r) => ({
    session,
    cmd: commandHash(command),
    at: now,
    id: r.check.tool?.id ?? r.ref.id,
    kind: r.check.tool?.kind ?? null,
    pinned: r.ref.version ?? null,
    known: r.check.known === true,
    check_version: r.check.version ?? null,
    check_fp: typeof r.check.fingerprint === "string" ? r.check.fingerprint : null,
  }));
}

async function main() {
  if (!optionOn("CHECK_INSTALLS")) return;
  const input = (await readStdin()) as { session_id?: unknown; tool_name?: string; tool_input?: { command?: unknown } };
  if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return;
  const command = input.tool_input.command;
  if (!installRefs(command).length) return;
  const now = Date.now();
  const memory = parseMemory(readText(memoryPath()));
  const checked: Checked[] = [];
  const out = await decide(command, forgeOrigin(), fetch, { memory, now, checked });
  if (checked.length) {
    writeText(memoryPath(), serializeMemory(memory, now));
    if (optionOn("REPORT_DRAFTS")) {
      const session = safeSessionId(input.session_id);
      writeText(installsPath(), JSON.stringify(addInstalls(parseInstalls(readText(installsPath())), pendingInstalls(checked, session, command, now), now)));
    }
  }
  if (!out) return;
  const claim = withClaimLine(out, forgeOrigin(), parseClaimShown(readText(claimShownPath())), now);
  if (claim.shown) writeText(claimShownPath(), JSON.stringify({ shown_at: now }));
  emit(claim.out);
}

if (process.env.VITEST === undefined) main().catch(() => {});
