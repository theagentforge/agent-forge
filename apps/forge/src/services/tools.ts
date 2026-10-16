import type { ToolKind } from "@forge/shared";

// Canonical tool ids: MASTER_PLAN §6.5 id forms. Case-insensitive hosts and owners are lowercased.

export function canonicalToolId(id: string): string {
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();
  const gh = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/.exec(lower);
  if (gh) return `github.com/${gh[1]!.replace(/\.git$/, "").replace(/\/+$/, "")}`;
  if (lower.startsWith("github.com/") || lower.startsWith("npm:") || lower.startsWith("mcp-registry:"))
    return lower.replace(/\/+$/, "");
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
  if ((host === "www.npmjs.com" || host === "npmjs.com") && parts[0] === "package" && parts.length >= 2)
    return `npm:${parts.slice(1).join("/")}`.toLowerCase();
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
