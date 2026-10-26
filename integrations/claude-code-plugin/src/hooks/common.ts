import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Shared helpers for the hook scripts. Every hook fails open: if anything goes wrong, Claude Code carries on.

export async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

/** The Forge origin this plugin build talks to (baked in at build time: staging or production). */
export function forgeOrigin(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(readFileSync(join(here, "..", "forge.json"), "utf8")) as { origin?: string };
    if (cfg.origin && /^https:\/\/[a-z0-9.-]+$/.test(cfg.origin)) return cfg.origin;
  } catch {}
  return "https://theagentforge.io";
}

/** Plugin settings arrive as CLAUDE_PLUGIN_OPTION_<KEY>. Booleans default to on. */
export const optionOn = (key: string) => (process.env[`CLAUDE_PLUGIN_OPTION_${key}`] ?? "true").toLowerCase() !== "false";

export const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj));

/** Where the plugin keeps its local files (Claude Code's per-plugin data directory, else ~/.claude-forge). */
export const dataRoot = () => process.env.CLAUDE_PLUGIN_DATA || join(process.env.HOME || process.env.USERPROFILE || ".", ".claude-forge");

/** A local file's text, or null. Never throws. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Writes a local file (creating its folder). Never throws: a hook carries on without its memory. */
export function writeText(file: string, text: string) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  } catch {}
}

/** The local memory of earlier answers ("since your last check", packages/shared/src/since.ts). */
export const memoryPath = () => join(dataRoot(), "memory.json");
/** Install commands checked this week, waiting for their outcome and a field report draft (src/installs.ts). */
export const installsPath = () => join(dataRoot(), "installs.json");

/** When the "claim your agent's profile" line was last shown here (ADR 0055; at most weekly). */
export const claimShownPath = () => join(dataRoot(), "claim-line.json");

/** A short local hash of a shell command, so the hooks can match an install to its outcome without storing it. */
export const commandHash = (command: string) => createHash("sha256").update(command).digest("hex").slice(0, 16);

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
