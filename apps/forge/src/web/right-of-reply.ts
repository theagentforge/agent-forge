import { html } from "hono/html";

// Maintainer right of reply (conversion review, 26 Oct 2026; ADR 0065). A scan or answer page that shows a matched
// pattern in a GitHub repository says, plainly, how its maintainer replies: verify with GitHub on the dispute page,
// where a person reviews the reply or fix (disputes are listed for admins on /admin/kpis). Publishing replies on the
// scan page isn't built, so the line doesn't promise it. It's drawn only on pages that already show a public scan, and
// names nothing a page doesn't. (Until 2 Nov 2026 it stayed off for repositories in the launch scan's disclosure window.)

/**
 * owner/repo (lower case) for a raw.githubusercontent.com source, else null. Decoded, so a percent-encoded or
 * upper-case spelling names the same repository. Anything that doesn't parse cleanly gets no line.
 */
export function repoOf(sourceUrl: string | null | undefined): string | null {
  try {
    const u = new URL(sourceUrl ?? "");
    if (u.protocol !== "https:" || u.hostname !== "raw.githubusercontent.com") return null;
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length < 4 || !parts.slice(0, 2).every((p) => /^[A-Za-z0-9_.-]+$/.test(p))) return null;
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Where the line links: the dispute page for this repository and scan, which asks for GitHub sign-in. */
export function rightOfReplyHref(repo: string, fingerprint: string) {
  return `/disputes?tool=${encodeURIComponent(`github.com/${repo.toLowerCase()}`)}&scan=${fingerprint.replace(/^sha256:/, "")}&from=maintainer`;
}

/** True when the maintainer line may show for this scan: a public scan with a matched pattern in a GitHub repository. */
export function showsRightOfReply(scan: { sourceUrl: string | null; verdict: string; public: boolean }) {
  return !!repoOf(scan.sourceUrl) && scan.public && scan.verdict !== "clear";
}

/** The line itself, or "" when it mustn't show. */
export function rightOfReply(scan: { sourceUrl: string | null; verdict: string; public: boolean; fingerprint: string }) {
  if (!showsRightOfReply(scan)) return "";
  const repo = repoOf(scan.sourceUrl)!;
  return html`<p class="notice right-of-reply" id="maintainer">Maintain this repository? <a rel="nofollow" href="${rightOfReplyHref(repo, scan.fingerprint)}">Verify with GitHub to reply to these findings or report a fix</a>. A person reviews every reply and aims to answer within 7 days.</p>`;
}
