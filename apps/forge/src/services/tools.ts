import type { ToolKind } from "@forge/shared";

// Canonical tool ids: MASTER_PLAN §6.5 id forms. Case-insensitive hosts and owners are lowercased.

export function canonicalToolId(id: string): string {
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();
  const gh = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/.exec(lower);
  if (gh) return `github.com/${gh[1]!.replace(/\.git$/, "").replace(/\/+$/, "")}`;
  if (lower.startsWith("github.com/") || lower.startsWith("npm:") || lower.startsWith("mcp-registry:"))
    return lower.replace(/\/+$/, "");
  // PEP 503: PyPI names are case-insensitive and treat runs of "-", "_" and "." alike (ADR 0056: reportable now).
  if (lower.startsWith("pypi:")) return `pypi:${lower.slice(5).trim().replace(/[-_.]+/g, "-")}`;
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return trimmed; // not a real URL: look it up as typed (finds nothing) instead of failing the request
    }
  }
  return trimmed;
}

const VERSION_RE = /^[0-9][0-9A-Za-z.+_!-]{0,63}$/;

/**
 * A version written into the id itself: `npm:name@1.2.3`, `npm:@scope/name@1.2.3`, `pypi:name==1.2.3` or
 * `pypi:name@1.2.3` (24 Oct production check: these read as unknown, missing a malicious-package record).
 */
export function splitInlineVersion(id: string): { id: string; version: string | null } {
  const m = /^(npm|pypi):(.+)$/i.exec(id.trim());
  if (!m) return { id, version: null };
  const body = m[2]!;
  const eq = /^(.+?)\s*===?\s*(.+)$/.exec(body);
  if (eq && m[1]!.toLowerCase() === "pypi" && VERSION_RE.test(eq[2]!)) return { id: `${m[1]}:${eq[1]}`, version: eq[2]! };
  const at = body.lastIndexOf("@");
  if (at > 0 && VERSION_RE.test(body.slice(at + 1))) return { id: `${m[1]}:${body.slice(0, at)}`, version: body.slice(at + 1) };
  return { id, version: null };
}

/** The version a registry page URL names, if any: npmjs.com/package/<name>/v/<version>, pypi.org/project/<name>/<version>. */
export function versionFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  if (host === "www.npmjs.com" || host === "npmjs.com") {
    const v = parts.indexOf("v");
    return parts[0] === "package" && v > 1 && VERSION_RE.test(parts[v + 1] ?? "") ? parts[v + 1]! : null;
  }
  if (host === "pypi.org" || host === "www.pypi.org") return parts[0] === "project" && VERSION_RE.test(parts[2] ?? "") ? parts[2]! : null;
  return null;
}

/** Maps a pasted web URL to the canonical id it most likely refers to. */
export function canonicalFromUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.trim();
  }
  const host = u.host.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "github.com" && parts.length >= 2) return `github.com/${parts.join("/")}`.toLowerCase();
  if ((host === "www.npmjs.com" || host === "npmjs.com") && parts[0] === "package" && parts.length >= 2) {
    const v = parts.indexOf("v");
    return `npm:${parts.slice(1, v > 1 ? v : undefined).join("/")}`.toLowerCase();
  }
  if ((host === "pypi.org" || host === "www.pypi.org") && parts[0] === "project" && parts[1]) return `pypi:${parts[1]}`.toLowerCase();
  return canonicalToolId(url);
}

/** The GitHub owner (user or organisation) a tool belongs to, when its id says so. */
export function publisherFromId(canonicalId: string): string | null {
  const m = /^github\.com\/([^/]+)\//.exec(canonicalId);
  return m?.[1] ?? null;
}

export const toolPageUrl = (origin: string, canonicalId: string) =>
  `${origin}/t/${encodeURIComponent(canonicalId)}`;

export type { ToolKind };
