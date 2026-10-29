import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseMemory, serializeMemory, TRAP_CARD_VERSION, trapCardText, WEEKLY_MAX_SKILLS, weeklyCheck, type LocalSkill, type MemoryFile } from "@forge/shared/light";
import { linkLine, linkLineAllowed, linkLineDue, markShown, parseLinkState, type LinkState } from "../link-line";
import { emit, forgeOrigin, linkStatePath, memoryPath, optionOn, readStdin, readText, sha256Hex, writeText } from "./common";

// SessionStart (ADR 0017 §1): adds the person's trap card to the session as context, because hooks are the one
// channel that is guaranteed to load. The same generic card as theagentforge.io/trap-card; off with `trap_card`.
//
// Once a week (retention plan, 26 Oct 2026; off with `weekly_check`) it also runs the weekly pass in
// packages/shared/src/weekly.ts: the installed skills' fingerprints go to /api/v1/watch (the REST twin of
// forge_watch), and the tools this machine checked most recently are checked again. What changed since the last
// answer is added as data. Only fingerprints and tool ids are sent; skill names and the memory stay on this machine.

export function sessionContext(): string {
  return `The Agent Forge plugin: the user's trap card (v${TRAP_CARD_VERSION}), checks the user set for this assistant.\n${trapCardText()}`;
}

const SKILL_MAX_BYTES = 262_144;

/** The weekly lines, or null when the pass isn't due or the Forge couldn't be reached (it runs again next session). */
export async function weeklyPass(d: { origin: string; fetch: typeof fetch; now: number; memory: MemoryFile; skills: LocalSkill[] }): Promise<string[] | null> {
  const r = await weeklyCheck({ ...d, sha256Hex, userAgent: "theagentforge-claude-plugin" });
  return r ? r.lines : null;
}

/** SKILL.md files in the usual places: the user's skills folder and the project's. */
export function findSkills(dirs: string[]): LocalSkill[] {
  const out: LocalSkill[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.length >= WEEKLY_MAX_SKILLS) return out;
      const text = readText(join(dir, name, "SKILL.md"));
      if (text !== null && text.length <= SKILL_MAX_BYTES) out.push({ label: name, text });
    }
  }
  return out;
}

/**
 * What the hook prints. The trap card and the weekly lines go to the session as context (data); the weekly lines and
 * the OA-04 link line go to `systemMessage`, which Claude Code shows to the person. The link line never goes into
 * `additionalContext`, so it never reaches the agent.
 */
export function sessionOutput(d: { context: string[]; weekly: string[] | null; link: string | null }): Record<string, unknown> | null {
  const toPerson = [...(d.weekly ?? []), ...(d.link ? [d.link] : [])];
  if (!d.context.length && !toPerson.length) return null;
  return {
    ...(d.context.length ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: d.context.join("\n\n") } } : {}),
    ...(toPerson.length ? { systemMessage: toPerson.join("\n") } : {}),
  };
}

/** The link line for this session, if due, and the state to save (OA-04). */
export function linkForSession(state: LinkState, now: number, enabled: boolean, origin: string): { line: string | null; state: LinkState } {
  if (!linkLineDue(state, now, enabled)) return { line: null, state };
  return { line: linkLine(origin), state: markShown(state, now) };
}

async function main() {
  const input = (await readStdin()) as { cwd?: unknown; source?: unknown };
  const context: string[] = [];
  if (optionOn("TRAP_CARD")) context.push(sessionContext());
  let weekly: string[] | null = null;
  if (optionOn("WEEKLY_CHECK")) {
    const now = Date.now();
    const memory = parseMemory(readText(memoryPath()));
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const project = typeof input.cwd === "string" ? input.cwd : process.env.CLAUDE_PROJECT_DIR;
    const dirs = [...(home ? [join(home, ".claude", "skills")] : []), ...(project ? [join(project, ".claude", "skills")] : [])];
    weekly = await weeklyPass({ origin: forgeOrigin(), fetch, now, memory, skills: findSkills(dirs) }).catch(() => null);
    if (weekly) writeText(memoryPath(), serializeMemory(memory, now));
  }
  if (weekly?.length) context.push(`The Agent Forge plugin, weekly check (data from theagentforge.io; skill names stay on this machine):\n${weekly.join("\n")}`);
  const link = linkForSession(parseLinkState(readText(linkStatePath())), Date.now(), linkLineAllowed(process.env, input.source), forgeOrigin());
  if (link.line) writeText(linkStatePath(), JSON.stringify(link.state));
  const out = sessionOutput({ context, weekly, link: link.line });
  if (out) emit(out);
}

if (process.env.VITEST === undefined) main().catch(() => {});
