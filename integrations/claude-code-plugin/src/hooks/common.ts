import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_ID_FILE, INSTALL_ID_HEADER, installIdDebugLine, installIdNotice, planInstallId } from "@forge/shared/light";

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

/** The OA-04 link line's local state: when it was shown, and whether a signed-in Forge call has succeeded here. */
export const linkStatePath = () => join(dataRoot(), "link-line.json");

/** A short local hash of a shell command, so the hooks can match an install to its outcome without storing it. */
export const commandHash = (command: string) => createHash("sha256").update(command).digest("hex").slice(0, 16);

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** B3-09: the random install ID file (a random UUID v4; packages/shared/src/install-id.ts). */
export const installIdPath = () => join(dataRoot(), INSTALL_ID_FILE);

/**
 * B3-09 (ADR 0103): the install ID header for this hook's checks, and the one-line first-run notice for the person.
 * Off with the plugin setting `install_id`, FORGE_NO_ANALYTICS=1, DO_NOT_TRACK=1 or CI. FORGE_TELEMETRY_DEBUG=1 writes
 * what would be sent to stderr and sends nothing. Never throws; any failure means no header.
 */
export function installIdFor(origin: string, env: Record<string, string | undefined> = process.env): { headers: Record<string, string>; notice: string | null } {
  try {
    if (!optionOn("INSTALL_ID")) return { headers: {}, notice: null };
    const p = planInstallId(readText(installIdPath()), env, () => randomUUID());
    if (!p.id) return { headers: {}, notice: null };
    if (p.save) {
      writeText(installIdPath(), p.save);
      if (readText(installIdPath()) !== p.save) return { headers: {}, notice: null }; // not saved: not stable, so not sent
    }
    if (p.debug) process.stderr.write(`${installIdDebugLine(p.id, "plugin", `${origin}/api/v1/check`)}\n`);
    return { headers: p.send ? { [INSTALL_ID_HEADER]: p.send } : {}, notice: p.notice ? installIdNotice('the plugin setting "Random install ID"') : null };
  } catch {
    return { headers: {}, notice: null };
  }
}
