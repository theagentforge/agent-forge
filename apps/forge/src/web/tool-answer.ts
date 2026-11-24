import { html } from "hono/html";
import { desc, eq } from "drizzle-orm";
import type { CheckResult } from "../services/forge";
import { osvPackageFor } from "../services/advisories";
import { OUTCOME_TEXT, type HouseOutcome } from "../services/house-report";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { dayLabel } from "./experiments";

// The tool page's answer line for answer engines (citations issue #234): one dated sentence with what the page already
// shows (the check's security status, field reports on the version, published advisories that match and when they were
// checked), a visible date and a short source list. It claims nothing the page didn't already: counts, versions, dates
// and advisory ids, never a safety judgement. 13 Nov walkthrough (ADR 0152): it leads the page, gives the security
// status in the API's own words, and with no field reports says what we do know (House install test, registry listing).

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const n = (x: number) => x.toLocaleString("en-US");

type Check = Pick<CheckResult, "version" | "outcome_breakdown" | "public_signals_summary" | "security_status"> & Partial<Pick<CheckResult, "advisories_checked">>;

/** What we know about a tool besides field reports: the House tester's latest install test and its registry listing. */
export interface ToolKnown {
  install?: { night: string; version: string | null; outcome: HouseOutcome; tools: number | null } | null;
  registry?: { source: string; version: string | null; status: string | null; fetchedAt: number } | null;
}

/** The newest date the page's data comes from: the latest report or status change, or the advisory check. */
export function toolAsOf(check: Pick<Check, "public_signals_summary"> & Partial<Check>, times: number[]): number {
  const checked = check.public_signals_summary ? Date.parse(check.public_signals_summary.checked_at) : NaN;
  const all = [...times, Number.isFinite(checked) ? checked : 0].filter((x) => x > 0);
  return all.length ? Math.max(...all) : Date.now();
}

/** security_status in words, as the API and the MCP answer give it. */
export const SECURITY_TEXT: Record<CheckResult["security_status"], string> = {
  clear: "clear",
  unknown: "unknown",
  caution: "caution (a security report is under review)",
  flagged: "flagged",
  confirmed_malicious: "confirmed malicious",
};

const REGISTRY_NAME: Record<string, string> = {
  "mcp-registry": "the official MCP Registry",
  "mcp-reference": "the MCP project's reference servers",
  "pypi-mcp": "PyPI's sitemap (a name match)",
  smithery: "Smithery's registry",
  "ai-stack": "our watch list of AI packages",
};

/**
 * "As of 25 Oct 2026, security status for npm:x@1.2.0: clear. 3 field reports: 2 worked, 1 failed. No published
 * advisory matches (OSV, checked 24 Oct 2026)." Counts in words, outcomes with no reports left out, dates in prose
 * form (site audit 29 Oct, §3.12 and §5 item 5). With no field reports, the House install test and the registry
 * listing follow, when we have them.
 */
export function toolAnswerLine(toolId: string, check: Check, asOf: number, known: ToolKnown = {}): string {
  const b = check.outcome_breakdown;
  const count = b.worked + b.partial + b.failed;
  const on = check.version ? `${toolId}@${check.version}` : toolId;
  const parts = ([["worked", b.worked], ["partial", b.partial], ["failed", b.failed]] as const).filter(([, x]) => x > 0).map(([w, x]) => `${n(x)} ${w}`).join(", ");
  const reports = count ? `${n(count)} field ${count === 1 ? "report" : "reports"}: ${parts}` : "No field reports on this version yet";
  const s = check.public_signals_summary;
  let adv: string;
  if (s) {
    const base = s.total ? `${n(s.total)} published ${s.total === 1 ? "advisory matches" : "advisories match"}` : "No published advisory matches";
    adv = `${base} (${[s.version ? null : "any version", `OSV, checked ${dayLabel(s.checked_at.slice(0, 10))}`].filter(Boolean).join(", ")})`;
  } else
    adv = osvPackageFor(toolId)
      ? // An npm or PyPI package whose OSV lookup didn't answer this time (review ADR 0118): say so, never "no lookup".
        "The advisory lookup didn't answer this time, so advisories aren't shown"
      : "No advisory lookup for this kind of tool (npm and PyPI packages only)";
  const out = [`As of ${dayLabel(day(asOf))}, security status for ${on}: ${securityWords(check)}.`, `${reports}.`, `${adv}.`];
  if (!count && known.install) {
    const i = known.install;
    const tools = i.outcome === "worked" && i.tools != null ? ` (${n(i.tools)} ${i.tools === 1 ? "tool" : "tools"})` : "";
    out.push(`House install test (${dayLabel(i.night)}${i.version ? `, v${i.version}` : ""}): ${OUTCOME_TEXT[i.outcome]}${tools}.`);
  }
  if (!count && known.registry) {
    const r = known.registry;
    const details = [r.version ? `latest version ${r.version}` : null, r.status ? `status ${r.status}` : null].filter(Boolean).join(", ");
    out.push(`Listed in ${REGISTRY_NAME[r.source] ?? r.source} (read ${dayLabel(day(r.fetchedAt))})${details ? `: ${details}` : ""}.`);
  }
  return out.join(" ");
}

/**
 * ADR 0152: the status in words. A "clear" with no advisory source checked says so ("not flagged, advisories not
 * checked"), so the page never reads "clear" where nothing was looked up.
 */
export function securityWords(check: Pick<Check, "security_status" | "advisories_checked">): string {
  if (check.security_status === "clear" && check.advisories_checked === false) return "not flagged, advisories not checked";
  return SECURITY_TEXT[check.security_status];
}

/** The tool page's <title>: the id, then the security status and the report count ("npm:x: security clear, 3 field reports"). */
export function toolPageTitle(toolId: string, check: Pick<Check, "security_status" | "outcome_breakdown" | "advisories_checked">): string {
  const b = check.outcome_breakdown;
  const count = b.worked + b.partial + b.failed;
  const status = check.security_status === "caution" ? "caution" : securityWords(check);
  return `${toolId}: security ${status}, ${count ? `${n(count)} field ${count === 1 ? "report" : "reports"}` : "no field reports yet"}`;
}

/** The House tester's newest install test of an npm or PyPI tool (either family), or null. Never throws. */
export async function latestInstallTest(db: Db, toolId: string): Promise<ToolKnown["install"]> {
  if (!osvPackageFor(toolId)) return null;
  try {
    const row = await db
      .select({ night: t.houseResults.night, version: t.houseResults.version, outcome: t.houseResults.outcome, tools: t.houseResults.tools })
      .from(t.houseResults)
      .where(eq(t.houseResults.server, toolId))
      .orderBy(desc(t.houseResults.night))
      .limit(1)
      .get();
    // A test error isn't a result about the tool (the House Report doesn't count it against it either).
    if (!row || !(row.outcome in OUTCOME_TEXT) || row.outcome === "error") return null;
    return { night: row.night, version: row.version, outcome: row.outcome as HouseOutcome, tools: row.tools };
  } catch {
    return null;
  }
}

/** The registry listing among a tool's public signals: the newest one whose source isn't in `skip` (OSV, House scan). */
export function registryListing(signals: { source: string; payload: unknown; fetchedAt: number }[], skip: string[]): ToolKnown["registry"] {
  const s = signals.filter((x) => !skip.includes(x.source)).sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  if (!s) return null;
  const p = (s.payload ?? {}) as { version?: unknown; status?: unknown };
  return { source: s.source, version: typeof p.version === "string" ? p.version : null, status: typeof p.status === "string" ? p.status : null, fetchedAt: s.fetchedAt };
}

/** The OSV page listing a package's advisories. */
const osvList = (ecosystem: string, pkg: string) => `https://osv.dev/list?ecosystem=${encodeURIComponent(ecosystem)}&q=${encodeURIComponent(pkg)}`;

/** The short "Sources" list: report counts, then each matching OSV advisory (or the OSV query that found none). */
export function toolSources(check: Pick<Check, "version" | "outcome_breakdown" | "public_signals_summary">, totalReports: number, asOf: number) {
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
<li><a href="/terms#results">What a result is, and isn't</a> (Terms, section 10)</li>
</ul></section>`;
}
