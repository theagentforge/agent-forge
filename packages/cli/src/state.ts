import { isAbsolute, join } from "node:path";

// Where the CLI keeps its memory of earlier answers ("since your last check") and the field report drafts its hook
// noted. A cache, by each platform's convention: $XDG_CACHE_HOME (or ~/.cache) on Linux and other Unixes,
// ~/Library/Caches on macOS, %LOCALAPPDATA% on Windows. FORGE_CACHE_DIR overrides it. Nothing in it is ever sent.

export const MEMORY_FILE = "memory.json";
export const DRAFTS_FILE = "drafts.json";

export function cacheDir(env: Record<string, string | undefined>, platform: string, home: string): string {
  if (env.FORGE_CACHE_DIR) return env.FORGE_CACHE_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "theagentforge", "Cache");
  if (platform === "darwin") return join(home, "Library", "Caches", "theagentforge");
  // XDG: a relative value is invalid and must be ignored.
  const xdg = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, ".cache");
  return join(xdg, "theagentforge");
}

/** A tool the hook or `check` saw, kept for `forge report` (no command text, no paths). */
export interface NotedTool {
  id: string;
  kind: string | null;
  pinned: string | null;
  check_version: string | null;
  check_fp: string | null;
  /** Which client's hook saw it ("codex", "gemini", "copilot"), or "check". */
  via: string;
  at: string;
}

export const MAX_NOTED = 30;
const KEEP_MS = 14 * 86_400_000;

export function parseNoted(text: string | null): NotedTool[] {
  try {
    const list = JSON.parse(text ?? "") as { items?: NotedTool[] };
    return Array.isArray(list?.items) ? list.items.filter((i) => i && typeof i.id === "string" && typeof i.at === "string") : [];
  } catch {
    return [];
  }
}

/** Adds tools (newest last), one entry per id and pinned version, dropping old ones. */
export function noteTools(list: NotedTool[], add: NotedTool[], now: number): string {
  const keyOf = (t: NotedTool) => `${t.id}@${t.pinned ?? "*"}`;
  const fresh = list.filter((t) => now - Date.parse(t.at) < KEEP_MS && !add.some((a) => keyOf(a) === keyOf(t)));
  return JSON.stringify({ items: [...fresh, ...add].slice(-MAX_NOTED) });
}
