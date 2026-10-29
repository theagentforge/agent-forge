import { html } from "hono/html";
import heldFile from "../seed/skill-scan-held.json";
import { NOTICE_ENDS, type SeedFile } from "../services/skill-seed";

// Maintainer right of reply (conversion review, 26 Oct 2026; ADR 0065). The launch scan's held results go public when
// the notice period ends (NOTICE_ENDS, 2 Nov). From then, a scan or answer page that shows a matched pattern in a GitHub
// repository says, plainly, how its maintainer replies: verify with GitHub on the dispute page, where a person reviews
// the reply or fix (disputes are listed for admins on /admin/kpis). Publishing replies on the scan page isn't built, so
// the line doesn't promise it.
//
// It never reveals held content early: it's drawn only on pages that already show a public scan, and for a repository
// with held rows it stays off until NOTICE_ENDS whatever the scan's flag says. The line names nothing a page doesn't.

const held = heldFile as unknown as SeedFile;
/** Repositories (owner/repo, lower case) with rows held until NOTICE_ENDS. Empty in the public mirror's stub. */
export const HELD_REPOS: ReadonlySet<string> = new Set(held.rows.map((r) => held.repos[r[0]]?.[0]?.toLowerCase()).filter((x): x is string => !!x));

/**
 * owner/repo (lower case) for a raw.githubusercontent.com source, else null. Parsed and decoded the way the hold's own
 * matcher reads it (skill-seed.ts githubFile), so a percent-encoded or upper-case spelling of a held repository is
 * still recognised as held. Anything that doesn't parse cleanly gets no line.
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

/** True when the maintainer line may show for this scan at `now`. */
export function showsRightOfReply(scan: { sourceUrl: string | null; verdict: string; public: boolean }, now = Date.now()) {
  const repo = repoOf(scan.sourceUrl);
  if (!repo || !scan.public || scan.verdict === "clear") return false;
  return !(HELD_REPOS.has(repo) && now < NOTICE_ENDS);
}

/** The line itself, or "" when it mustn't show. */
export function rightOfReply(scan: { sourceUrl: string | null; verdict: string; public: boolean; fingerprint: string }, now = Date.now()) {
  if (!showsRightOfReply(scan, now)) return "";
  const repo = repoOf(scan.sourceUrl)!;
  return html`<p class="notice right-of-reply" id="maintainer">Maintain this repository? <a rel="nofollow" href="${rightOfReplyHref(repo, scan.fingerprint)}">Verify with GitHub to reply to these findings or report a fix</a>. A person reviews every reply and aims to answer within 7 days.</p>`;
}
