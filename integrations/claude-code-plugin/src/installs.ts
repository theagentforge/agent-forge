import { draftLine, draftUrl, fieldDraft, registryFingerprint, type FieldDraft } from "@forge/shared/light";
import { MAX_DRAFTS, REDRAFT_AFTER_MS } from "./report-draft";

// One-step field reports after an install (retention plan, 26 Oct 2026). The pre-install hook notes each tool it
// checked, keyed by a local hash of the command; the PostToolUse hooks add whether that command worked; the Stop hook
// turns finished installs of tools the Forge knows into ready-made drafts. Pure functions; the hooks do the file I/O.
// Nothing here sends a report: the owner confirms each draft (the /report link, or a yes before forge_report).

export interface PendingInstall {
  session: string;
  /** commandHash() of the install command, never the command itself. */
  cmd: string;
  at: number;
  id: string;
  kind: string | null;
  /** The version the command pinned (name@1.2.3, name==1.2.3), if any. */
  pinned: string | null;
  /** True when the Forge knows the tool (only those get a draft). */
  known: boolean;
  /** The version and fingerprint the Forge's answer was on. */
  check_version: string | null;
  check_fp: string | null;
  outcome?: "worked" | "failed";
}

export interface InstallsFile {
  items: PendingInstall[];
}

/** Pending installs are kept for a week, at most this many. */
export const MAX_PENDING = 50;
const KEEP_MS = 7 * 86_400_000;

export function parseInstalls(text: string | null): InstallsFile {
  try {
    const f = JSON.parse(text ?? "") as InstallsFile;
    return { items: Array.isArray(f?.items) ? f.items.filter((i) => i && typeof i.id === "string" && typeof i.cmd === "string") : [] };
  } catch {
    return { items: [] };
  }
}

export function addInstalls(f: InstallsFile, items: PendingInstall[], now: number): InstallsFile {
  const fresh = f.items.filter((i) => now - i.at < KEEP_MS && !items.some((n) => n.session === i.session && n.cmd === i.cmd && n.id === i.id));
  return { items: [...fresh, ...items].slice(-MAX_PENDING) };
}

/** Records whether an install command worked. Returns true when a pending install matched. */
export function markOutcome(f: InstallsFile, session: string, cmd: string, ok: boolean): boolean {
  let hit = false;
  for (const i of f.items)
    if (i.session === session && i.cmd === cmd && !i.outcome) {
      i.outcome = ok ? "worked" : "failed";
      hit = true;
    }
  return hit;
}

export const ledgerKey = (id: string) => `tool:${id}`;

/** This session's finished installs worth a draft: known tools, one per id, not drafted in the last 3 days. */
export function draftableInstalls(f: InstallsFile, session: string, ledger: Record<string, number>, now: number, room = MAX_DRAFTS): PendingInstall[] {
  const out: PendingInstall[] = [];
  for (const i of [...f.items].reverse()) {
    if (out.length >= room) break;
    if (i.session !== session || !i.outcome || !i.known) continue;
    if (out.some((o) => o.id === i.id)) continue;
    if (now - (ledger[ledgerKey(i.id)] ?? 0) < REDRAFT_AFTER_MS) continue;
    out.push(i);
  }
  return out;
}

export interface InstallDraft {
  draft: FieldDraft;
  url: string;
  line: string;
}

/**
 * The draft for one install. The version and fingerprint come from the Forge's answer when the command pinned that
 * same version; otherwise from the registry (npm: sha256 of dist.integrity, as the House does; PyPI: its sha256 of the
 * sdist); otherwise they
 * are left for the /report page to ask.
 */
export async function installDraft(
  i: PendingInstall,
  origin: string,
  deps: { fetch: typeof fetch; sha256Hex: (s: string) => string; signal?: AbortSignal },
): Promise<InstallDraft | null> {
  let version: string | null = null;
  let fingerprint: string | null = null;
  if (i.pinned && i.pinned === i.check_version && i.check_fp) [version, fingerprint] = [i.check_version, i.check_fp];
  else if (i.id.startsWith("npm:") || i.id.startsWith("pypi:")) {
    const r = await registryFingerprint(i.id, i.pinned ?? undefined, deps);
    // The Forge's own fingerprint for that version wins, so the report lands on the version others reported on.
    if (r) [version, fingerprint] = [r.version, r.version === i.check_version && i.check_fp ? i.check_fp : r.fingerprint];
  }
  const draft = fieldDraft({
    id: i.id,
    kind: i.kind ?? undefined,
    version,
    fingerprint,
    outcome: i.outcome,
    issues: i.outcome === "failed" ? ["install_failed"] : [],
    note: i.outcome === "failed" ? "Drafted from the install step: the install command failed." : "Drafted from the install step: the install command succeeded.",
    framework: "claude-code",
  });
  return draft ? { draft, url: draftUrl(origin, draft), line: draftLine(draft) } : null;
}
