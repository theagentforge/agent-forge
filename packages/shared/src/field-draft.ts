import { FRAMEWORKS, ISSUES, NOTE_MAX_LENGTH, OUTCOMES, TOOL_KINDS, type Framework, type Issue, type Outcome, type ToolKind } from "./constants";

// One-step field reports (retention plan, 26 Oct 2026): after a check of a tool the agent then installs or uses, the
// plugin and the CLI make a ready-made draft. Nothing is ever filed by the draft itself: the owner confirms it with one
// action, either on the pre-filled /report page (GitHub sign-in, one click: apps/forge/src/web/contribute.ts) or by a
// signed-in forge_report / POST /api/v1/report after a yes. Filing goes through the same validation, note scan and
// moderation as every report. The text is data (AGENTS.md rule 7): "Field report draft for npm:x@1.2.3: …".

/** The tool ids a report accepts (TOOL_ID_PATTERN in report.ts, which needs zod). PyPI since 26 Oct (ADR 0056). */
export const ID_RE =
  /^(?:npm:(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*|pypi:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|github\.com\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9_.-]+(?:\/[a-z0-9_.@-]+)*|mcp-registry:[a-z0-9][a-z0-9._/-]*|https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._~%@+-]*)*)$/i;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const FP_RE = /^sha256:[0-9a-f]{64}$/;

export interface FieldDraftInput {
  id: string;
  kind?: string;
  /** The exact version used, with its fingerprint; both or neither (the /report page asks for missing ones). */
  version?: string | null;
  fingerprint?: string | null;
  outcome?: string | null;
  issues?: string[];
  note?: string | null;
  framework?: string;
  category?: string;
}

/** The report body as forge_report and POST /api/v1/report take it (minus what only the owner can add). */
export interface FieldDraft {
  tool: { kind: ToolKind; id: string; version: string; fingerprint: string };
  task: { category: string; framework: Framework };
  outcome: Outcome | null;
  issues: Issue[];
  note?: string;
}

/** Notes may not hold links, paths or keys (the server rejects the whole report); drafts keep them short and plain. */
const cleanNote = (s: string | null | undefined) =>
  (s ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX_LENGTH);

/** A draft from what the caller knows, or null when the tool id isn't one the Forge accepts. Never throws. */
export function fieldDraft(i: FieldDraftInput): FieldDraft | null {
  const id = i.id.trim();
  if (!ID_RE.test(id) || id.length > 512) return null;
  const kind = (TOOL_KINDS as readonly string[]).includes(i.kind ?? "") ? (i.kind as ToolKind) : "mcp_server";
  const pinned = !!i.version && VERSION_RE.test(i.version) && i.version.length <= 128 && !!i.fingerprint && FP_RE.test(i.fingerprint);
  const outcome = (OUTCOMES as readonly string[]).includes(i.outcome ?? "") ? (i.outcome as Outcome) : null;
  const issues = [...new Set((i.issues ?? []).filter((x): x is Issue => (ISSUES as readonly string[]).includes(x)))];
  const note = cleanNote(i.note);
  const framework = (FRAMEWORKS as readonly string[]).includes(i.framework ?? "") ? (i.framework as Framework) : "other";
  const category = /^[a-z0-9][a-z0-9-]{0,39}$/.test(i.category ?? "") ? i.category! : "general";
  return {
    tool: { kind, id, version: pinned ? i.version! : "", fingerprint: pinned ? i.fingerprint! : "" },
    task: { category, framework },
    outcome,
    issues,
    ...(note ? { note } : {}),
  };
}

/** True when the draft has everything a report needs (an outcome and a pinned version), so one click can file it. */
export const draftComplete = (d: FieldDraft) => !!d.outcome && !!d.tool.version && !!d.tool.fingerprint;

/** The pre-filled /report link the owner opens to review and file (same parameters as the server's reportUrl). */
export function draftUrl(origin: string, d: FieldDraft): string {
  const q = new URLSearchParams({ tool: d.tool.id, kind: d.tool.kind });
  if (d.tool.version && d.tool.fingerprint) {
    q.set("version", d.tool.version);
    q.set("fp", d.tool.fingerprint);
  }
  if (d.outcome) q.set("outcome", d.outcome);
  if (d.issues.length) q.set("issues", d.issues.join(","));
  if (d.note) q.set("note", d.note);
  return `${origin}/report?${q}`;
}

/** The report body for a signed-in filing; null until the draft is complete. */
export function draftReport(d: FieldDraft): Record<string, unknown> | null {
  if (!draftComplete(d)) return null;
  return { tool: d.tool, task: d.task, outcome: d.outcome, issues: d.issues, ...(d.note ? { note: d.note } : {}) };
}

/** One line of data: "Field report draft for npm:x@1.2.3: outcome worked; issues none; not filed; filing needs owner confirmation". */
export function draftLine(d: FieldDraft): string {
  const subject = `${d.tool.id}${d.tool.version ? `@${d.tool.version}` : ""}`;
  const parts = [
    `outcome ${d.outcome ?? "not set"}`,
    `issues ${d.issues.length ? d.issues.join(", ") : "none"}`,
    ...(d.note ? [`note "${d.note.replace(/"/g, "'")}"`] : []),
    ...(d.tool.version ? [] : ["version and fingerprint not known here (the report page asks for them)"]),
    "not filed; filing needs owner confirmation",
  ];
  return `Field report draft for ${subject}: ${parts.join("; ")}`;
}

/** The fingerprint the House uses for an npm version: sha256 of npm's `dist.integrity` string (integrations/house). */
export async function npmVersionFingerprint(
  name: string,
  version: string | undefined,
  deps: { fetch: typeof fetch; sha256Hex: (s: string) => string | Promise<string>; signal?: AbortSignal },
): Promise<{ version: string; fingerprint: string } | null> {
  try {
    const res = await deps.fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version ?? "latest")}`, {
      headers: { Accept: "application/json" },
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (!res.ok) return null;
    const meta = (await res.json()) as { version?: unknown; dist?: { integrity?: unknown } };
    if (typeof meta.version !== "string" || !VERSION_RE.test(meta.version) || typeof meta.dist?.integrity !== "string") return null;
    return { version: meta.version, fingerprint: `sha256:${await deps.sha256Hex(meta.dist.integrity)}` };
  } catch {
    return null;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The fingerprint for a PyPI version (ADR 0056): PyPI's own sha256 of the version's source distribution, or of its
 * first file by name when there is no sdist. No version: the latest release.
 */
export async function pypiVersionFingerprint(
  name: string,
  version: string | undefined,
  deps: { fetch: typeof fetch; signal?: AbortSignal },
): Promise<{ version: string; fingerprint: string } | null> {
  try {
    const path = version ? `${encodeURIComponent(name)}/${encodeURIComponent(version)}` : encodeURIComponent(name);
    const res = await deps.fetch(`https://pypi.org/pypi/${path}/json`, { headers: { Accept: "application/json" }, ...(deps.signal ? { signal: deps.signal } : {}) });
    if (!res.ok) return null;
    const meta = (await res.json()) as { info?: { version?: unknown }; urls?: { packagetype?: unknown; filename?: unknown; digests?: { sha256?: unknown } }[] };
    const v = meta.info?.version;
    if (typeof v !== "string" || !VERSION_RE.test(v) || v.length > 128) return null;
    const files = (Array.isArray(meta.urls) ? meta.urls : []).filter((f) => typeof f?.digests?.sha256 === "string" && HEX64.test(f.digests.sha256 as string) && typeof f.filename === "string");
    const pick = files.find((f) => f.packagetype === "sdist") ?? [...files].sort((a, b) => String(a.filename).localeCompare(String(b.filename)))[0];
    return pick ? { version: v, fingerprint: `sha256:${pick.digests!.sha256 as string}` } : null;
  } catch {
    return null;
  }
}

/** The registry fingerprint for an npm: or pypi: id (null for other ids, or when the registry can't be read). */
export async function registryFingerprint(
  id: string,
  version: string | undefined,
  deps: { fetch: typeof fetch; sha256Hex: (s: string) => string | Promise<string>; signal?: AbortSignal },
): Promise<{ version: string; fingerprint: string } | null> {
  if (id.startsWith("npm:")) return npmVersionFingerprint(id.slice(4), version, deps);
  if (id.startsWith("pypi:")) return pypiVersionFingerprint(id.slice(5), version, deps);
  return null;
}
