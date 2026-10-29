import { html } from "hono/html";
import type { CheckResult } from "../services/forge";
import { osvPackageFor } from "../services/advisories";
import { dayLabel } from "./experiments";

// The tool page's answer line for answer engines (citations issue #234): one dated sentence with what the page already
// shows (field reports on the version, published advisories that match), a visible date and a short source list. It
// claims nothing the page didn't already: counts, versions and advisory ids, never a safety judgement.

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const n = (x: number) => x.toLocaleString("en-US");

type Check = Pick<CheckResult, "version" | "outcome_breakdown" | "public_signals_summary">;

/** The newest date the page's data comes from: the latest report or status change, or the advisory check. */
export function toolAsOf(check: Check, times: number[]): number {
  const checked = check.public_signals_summary ? Date.parse(check.public_signals_summary.checked_at) : NaN;
  const all = [...times, Number.isFinite(checked) ? checked : 0].filter((x) => x > 0);
  return all.length ? Math.max(...all) : Date.now();
}

/**
 * "As of 25 Oct 2026, 3 field reports on npm:x@1.2.0: 2 worked, 1 failed. 1 published advisory matches." Counts in
 * words, outcomes with no reports left out, the date in prose form (site audit 29 Oct, §3.12 and §5 item 5).
 */
export function toolAnswerLine(toolId: string, check: Check, asOf: number): string {
  const b = check.outcome_breakdown;
  const count = b.worked + b.partial + b.failed;
  const on = check.version ? `${toolId}@${check.version}` : toolId;
  const parts = ([["worked", b.worked], ["partial", b.partial], ["failed", b.failed]] as const).filter(([, x]) => x > 0).map(([w, x]) => `${n(x)} ${w}`).join(", ");
  const reports = count ? `${n(count)} field ${count === 1 ? "report" : "reports"} on ${on}: ${parts}` : `no field reports on ${on} yet`;
  const s = check.public_signals_summary;
  const adv = s
    ? s.total
      ? `${n(s.total)} published ${s.total === 1 ? "advisory matches" : "advisories match"}${s.version ? "" : " (any version)"}`
      : `No published advisory matches${s.version ? "" : " (any version)"}`
    : osvPackageFor(toolId)
      ? // An npm or PyPI package whose OSV lookup didn't answer this time (review ADR 0118): say so, never "no lookup".
        "The advisory lookup didn't answer this time, so advisories aren't shown"
      : "No advisory lookup for this kind of tool (npm and PyPI packages only)";
  return `As of ${dayLabel(day(asOf))}, ${reports}. ${adv}.`;
}

/** The OSV page listing a package's advisories. */
const osvList = (ecosystem: string, pkg: string) => `https://osv.dev/list?ecosystem=${encodeURIComponent(ecosystem)}&q=${encodeURIComponent(pkg)}`;

/** The short "Sources" list: report counts, then each matching OSV advisory (or the OSV query that found none). */
export function toolSources(check: Check, totalReports: number, asOf: number) {
  const b = check.outcome_breakdown;
  const onVersion = b.worked + b.partial + b.failed;
  const s = check.public_signals_summary;
  return html`<section aria-labelledby="sources"><h2 id="sources">Sources</h2>
<ul class="small">
<li><a href="#reports">Field reports</a>: ${n(onVersion)} on ${check.version ? `v${check.version}` : "the latest version"}, ${n(totalReports)} on this page in all. Data as of <time datetime="${new Date(asOf).toISOString()}">${day(asOf)}</time>.</li>
${s
  ? html`${s.advisories.map((a) => html`<li>OSV: <a class="mono" href="${a.url}" rel="nofollow noopener">${a.id}</a> (${a.kind === "malicious" ? "malicious-package record" : "vulnerability"}${a.published ? `, published ${a.published.slice(0, 10)}` : ""})</li>`)}${s.total > s.advisories.length ? html`<li>OSV: ${n(s.total - s.advisories.length)} more for ${s.package}</li>` : ""}
<li>OSV query for ${s.ecosystem} ${s.package}${s.version ? `@${s.version}` : ""}, checked ${s.checked_at.slice(0, 10)}: <a href="${osvList(s.ecosystem, s.package)}" rel="nofollow noopener">${s.total ? `${n(s.total)} matched` : "no match"}</a></li>`
  : ""}
<li><a href="/methodology">How scores and verdicts are counted</a></li>
</ul></section>`;
}
