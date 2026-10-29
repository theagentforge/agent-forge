import { html } from "hono/html";
import responsesFile from "../seed/maintainer-responses.json";

// Maintainer responses on launch-scan entries (28 Oct 2026; disclosure-window-end runbook, "Maintainer fixes").
// When a maintainer fixes a flagged file or corrects us, the entry keeps its original result (it was true of the commit
// we scanned) and adds, beside it: the maintainer's response with a link to the fix, and our own rescan of the current
// file. Nothing here is drawn before an entry's public_from (2 Nov 00:00 UTC for the held repositories), and only on
// a page that already shows a public scan. The public mirror gets an empty stub until then.

export interface MaintainerResponse {
  repo: string;
  path: string;
  /** The fingerprint we scanned (sha256:<hex>); the response shows on that scan's page. */
  fingerprint: string;
  scanned_commit: string;
  /** ISO date-time; the response stays off before it. */
  public_from: string;
  response: { date: string; thread_url: string; fix_label: string; fix_url: string; fix_commit: string; fix_date: string; note?: string };
  rescan: { date: string; commit: string; fingerprint: string; verdict: "clear" | "caution" | "flagged"; rules_version: string };
}
export interface ResponsesFile {
  note?: string;
  entries: MaintainerResponse[];
}

let source: ResponsesFile = responsesFile as unknown as ResponsesFile;
/** Tests only: swap the responses (null restores the bundled file). */
export function useResponsesFile(file: ResponsesFile | null) {
  source = file ?? (responsesFile as unknown as ResponsesFile);
}
export const bundledResponses = () => responsesFile as unknown as ResponsesFile;

/** The response for this scan, if one may show at `now`. */
export function responseFor(scan: { fingerprint: string; public: boolean }, now = Date.now()): MaintainerResponse | null {
  if (!scan.public) return null;
  const e = source.entries.find((x) => x.fingerprint === scan.fingerprint);
  if (!e) return null;
  const from = Date.parse(e.public_from);
  return Number.isFinite(from) && now >= from ? e : null;
}

const short = (sha: string) => sha.slice(0, 12);
const fmt = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const VERDICT: Record<string, string> = { clear: "clear, no known pattern matched", caution: "caution, a medium-risk pattern matched", flagged: "flagged, a high-risk pattern matched" };
const fileAt = (e: MaintainerResponse, commit: string) => `https://github.com/${e.repo}/blob/${commit}/${e.path}`;

/** The section on the scan page, or "" when it mustn't show. `verdict` is the scanned commit's own result. */
export function maintainerResponse(scan: { fingerprint: string; public: boolean; verdict: string }, now = Date.now()) {
  const e = responseFor(scan, now);
  if (!e) return "";
  const r = e.response;
  // Only a clear rescan earns "fixed": when the pattern still matches, the page says the file changed, and no more.
  const cleared = e.rescan.verdict === "clear";
  return html`<section class="panel maintainer-response" id="maintainer-response"><h2>Maintainer response</h2>
<ul>
<li><b>Result at the scanned commit</b> <a class="mono" href="${fileAt(e, e.scanned_commit)}" rel="nofollow">${short(e.scanned_commit)}</a>: ${VERDICT[scan.verdict] ?? scan.verdict} (the lines above).</li>
<li><b>Maintainer response (${fmt(r.date)}):</b> ${cleared ? "fixed in" : "changed the file in"} <a href="${r.fix_url}" rel="nofollow">${r.fix_label}</a> (commit <a class="mono" href="https://github.com/${e.repo}/commit/${r.fix_commit}" rel="nofollow">${r.fix_commit.slice(0, 7)}</a>, ${fmt(r.fix_date)}). <a href="${r.thread_url}" rel="nofollow">The thread</a>.${r.note ? html` ${r.note}` : ""}</li>
<li><b>Rescan at the current commit</b> <a class="mono" href="${fileAt(e, e.rescan.commit)}" rel="nofollow">${short(e.rescan.commit)}</a> (${fmt(e.rescan.date)}, rules ${e.rescan.rules_version}): ${VERDICT[e.rescan.verdict] ?? e.rescan.verdict}${cleared ? "" : ". The pattern still matches in the current file; read the lines at that commit"}.</li>
</ul>
<p class="small muted">A match was a reason to read the line, not a verdict on the author, and we found no sign of malice. ${cleared ? "A clear rescan means no known pattern matched, not proof the file is safe." : "The maintainer's change did not clear the rescan. That is a pattern match in the current text, not a finding that the change failed or that the file is unsafe."}</p></section>`;
}
