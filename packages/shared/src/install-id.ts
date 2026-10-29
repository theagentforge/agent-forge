// B3-09 (ADR 0103): the anonymous, opt-out install ID that the CLI, its hooks (Codex, Gemini CLI, Copilot CLI) and the
// Claude Code plugin send with install-time checks, so The Forge can tell whether an install comes back on a later day.
// Modelled on Next.js telemetry (https://nextjs.org/telemetry): anonymous, off with an environment variable, and a debug
// mode that prints what would be sent and sends nothing.
//
// The ID is a random UUID v4 made on this machine. It holds no machine data and is never derived from a name, email or
// path. It lives in a small local file and is sent only as the `forge-install-id` header on /api/v1/check. The server
// keeps only a keyed hash of it with the first and last day it was seen and the client kind (apps/forge
// services/install-ids.ts).

export const INSTALL_ID_HEADER = "forge-install-id";
export const INSTALL_ID_FILE = "install-id.json";
export const PRIVACY_INSTALL_ID_URL = "https://theagentforge.io/privacy#install-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isInstallId = (v: unknown): v is string => typeof v === "string" && UUID_V4.test(v);

/** An environment flag that is set to anything but "", "0" or "false". */
const on = (v: string | undefined) => v !== undefined && !["", "0", "false"].includes(v.trim().toLowerCase());

/** Why no ID is sent, or null when one may be. */
export type InstallIdOff = "FORGE_NO_ANALYTICS" | "DO_NOT_TRACK" | "CI" | "disabled";

/**
 * The environment's opt-out, or null. FORGE_NO_ANALYTICS and DO_NOT_TRACK (https://consoledonottrack.com) turn it off;
 * so does CI: a CI runner is a fresh machine each run, so its ID would never come back and would only add noise (and
 * this keeps our own CI out of the return numbers).
 */
export function installIdEnvOff(env: Record<string, string | undefined>): InstallIdOff | null {
  if (on(env.FORGE_NO_ANALYTICS)) return "FORGE_NO_ANALYTICS";
  if (on(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  if (on(env.CI)) return "CI";
  return null;
}

export const installIdDebug = (env: Record<string, string | undefined>) => on(env.FORGE_TELEMETRY_DEBUG);

export interface InstallIdState {
  /** false after `forge telemetry disable` (or the plugin's setting). */
  enabled: boolean;
  id: string | null;
}

export function parseInstallIdState(text: string | null): InstallIdState {
  try {
    const s = JSON.parse(text ?? "") as { enabled?: unknown; id?: unknown };
    return { enabled: s?.enabled !== false, id: isInstallId(s?.id) ? s.id : null };
  } catch {
    return { enabled: true, id: null };
  }
}

export const serializeInstallIdState = (s: InstallIdState) => `${JSON.stringify(s.enabled ? { enabled: true, id: s.id } : { enabled: false })}\n`;

export interface InstallIdPlan {
  /** The ID to send, or null (off, or debug). */
  send: string | null;
  /** The ID this machine has (also in debug mode, so debug shows the real one), or null when off. */
  id: string | null;
  /** The file text to write first, when a new ID was made; send it only if the write worked. */
  save: string | null;
  /** True the first time: show the one-line notice. */
  notice: boolean;
  /** FORGE_TELEMETRY_DEBUG: print what would be sent, send nothing. */
  debug: boolean;
  off: InstallIdOff | null;
}

/** What to do with the install ID on one check, from the local file and the environment. Pure; never throws. */
export function planInstallId(stateText: string | null, env: Record<string, string | undefined>, newId: () => string): InstallIdPlan {
  const state = parseInstallIdState(stateText);
  const off = installIdEnvOff(env) ?? (state.enabled ? null : "disabled");
  if (off) return { send: null, id: null, save: null, notice: false, debug: false, off };
  let id = state.id;
  let save: string | null = null;
  if (!id) {
    const made = newId();
    if (!isInstallId(made)) return { send: null, id: null, save: null, notice: false, debug: false, off: null };
    id = made;
    save = serializeInstallIdState({ enabled: true, id });
  }
  const debug = installIdDebug(env);
  return { send: debug ? null : id, id, save, notice: save !== null, debug, off: null };
}

/** The one-line first-run notice (for the person: the CLI prints it on stderr, the plugin in its user-only message). */
export function installIdNotice(how: string): string {
  return `The Agent Forge: checks now send a random install ID so we can count return use (we store no IP address or package list with it; Cloudflare's request logs keep each request, its address naming the package and this ID, with the IP address for up to 7 days). Turn off: ${how}, or set FORGE_NO_ANALYTICS=1. ${PRIVACY_INSTALL_ID_URL}`;
}

/** The FORGE_TELEMETRY_DEBUG line: what would have been sent. */
export function installIdDebugLine(id: string, client: string, url: string): string {
  return `forge telemetry debug (nothing sent): would send header ${INSTALL_ID_HEADER}: ${id} (client ${client}) with ${url}`;
}
