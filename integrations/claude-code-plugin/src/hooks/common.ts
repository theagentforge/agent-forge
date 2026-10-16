import { readFileSync } from "node:fs";
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
