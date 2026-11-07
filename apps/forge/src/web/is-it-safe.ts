import { displayVerdict, type CheckSecurity, type DisplayVerdict } from "@forge/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { osvPackageFor, queryAdvisories, type Advisory, type AdvisoryResult } from "../services/advisories";
import { osvListUrl } from "../services/compact";
import { getDb, type Db } from "../services/db";
import { checkTool, findTool } from "../services/forge";
import { latestRelease } from "../services/registry";
import { scanPath } from "../services/scans";
import { canonicalToolId } from "../services/tools";
import {
  canonicalPackageName,
  IS_IT_SAFE_PATH,
  isListedPackage,
  packagePagePath,
  TOP_NPM,
  TOP_PACKAGES_VERSION,
  TOP_PYPI,
  type PackageEcosystem,
} from "../services/top-packages";
import { answerPath, latestFingerprintFor, reportTotals } from "./answers";
import { breakableId, copyBlock, verdictChip } from "./components";
import { dayLabel } from "./experiments";
import { markdownResponse } from "./markdown";
import { notFound, send, sendJson, site, wantsJson } from "./pages";

// "Is <package> safe to install?" (build list item 14, ADR 0127): one page per npm or PyPI package, answering with data
// only, date first: the latest release in its registry, how many published advisories (OSV) match that release and how
// many affect older versions only, the Forge's field reports, and any skill scan of its repository. It never says a
// package is safe: "clear" means no known pattern or advisory matched. Everything is read through the services
// forge_check uses (checkTool, queryAdvisories, latestRelease), so OSV answers are cached in KV for 6 hours and registry
// answers for an hour; the page itself is edge-cached for 30 minutes and, uncached, limited per visitor IP like /check
// (web/pages.ts LIMITED_PAGE). Listed packages (services/top-packages.ts) are indexed and in the sitemap; any other
// package that resolves in its registry gets the same page with noindex, and a name that doesn't resolve is a 404.
// `.md` is the Markdown twin and `?format=json` the structured one (AGENTS.md rule 7: data only, no instructions).

type Ctx = Context<{ Bindings: Env }>;

/** How long a rendered answer is kept by browsers and the edge (OSV answers are cached 6 h, registry answers 1 h). */
export const IS_IT_SAFE_MAX_AGE = 1800;

/** The Forge's wording for "clear" (mcp-public.ts, pricing.ts), word for word. */
export const CLEAR_MEANING = "Clear means no known pattern or advisory matched, not that a tool is safe.";

const ECOSYSTEM_LABEL: Record<PackageEcosystem, string> = { npm: "npm", pypi: "PyPI" };
const OSV_ECOSYSTEM = { npm: "npm", pypi: "PyPI" } as const;

/** Why the status is what it is, as a code (agents read codes, never prose). */
export type StatusBasis =
  | "confirmed_by_review"
  | "malicious_record_on_version"
  | "advisory_on_version"
  | "malicious_record_some_version"
  | "forge_reports"
  | "no_match_on_version"
  | "version_unavailable"
  | "advisories_unavailable";

export interface PackageAdvisory {
  id: string;
  kind: Advisory["kind"];
  /** Present when OSV's record marks malicious code by CWE-506 rather than by a MAL- id (services/advisories.ts). */
  malicious_by?: Advisory["malicious_by"];
  aliases: string[];
  /** True when OSV matched it to the version this answer is about; null when that version isn't known. */
  affects_version: boolean | null;
  fixed: string[];
  published: string | null;
  url: string;
  exploited_in_wild?: boolean;
}

export interface PackageAnswer {
  ecosystem: PackageEcosystem;
  package: string;
  tool_id: string;
  listed: boolean;
  list_version: string;
  as_of: string;
  /** The version this answer is about: the registry's latest release, else the newest version with field reports. */
  version: string | null;
  version_source: "registry_latest" | "newest_reported" | null;
  security_status: CheckSecurity;
  status_basis: StatusBasis;
  verdict: DisplayVerdict;
  advisories: {
    source: "osv";
    checked: boolean;
    checked_at: string | null;
    /** Published advisories OSV matches to `version`; null when the version or OSV's answer isn't known. */
    matching_version: number | null;
    /** Published advisories for other versions only (all versions minus those matching `version`). */
    other_versions: number | null;
    /** Every published advisory for the package, any version. */
    any_version: number | null;
    malicious_records: number;
    exploited_in_wild: number;
    list: PackageAdvisory[];
    list_url: string;
  };
  field_reports: {
    on_version: number;
    outcomes: { worked: number; partial: number; failed: number } | null;
    people: number;
    verified_people: number;
    forge_score: number | null;
    all_versions: number;
    versions_reported: string[];
    tool_page_url: string | null;
  };
  skill_scan: { verdict: "clear" | "caution" | "flagged"; scanned: string; repository: string; page_url: string; scan_url: string } | null;
  other_versions_flagged: { version: string; security_status: string }[];
  check: { tool: "forge_check"; mcp_server: string; arguments: { id: string; version?: string }; rest_url: string; cli: string };
  sources: { osv: string; registry: string; methodology: string };
  page_url: string;
  markdown_url: string;
}

const registryUrl = (eco: PackageEcosystem, name: string, version?: string | null) =>
  eco === "npm" ? `https://www.npmjs.com/package/${name}${version ? `/v/${encodeURIComponent(version)}` : ""}` : `https://pypi.org/project/${name}/${version ? `${encodeURIComponent(version)}/` : ""}`;

const sameAdvisory = (a: Advisory, b: Advisory) => a.id === b.id || a.aliases.includes(b.id) || b.aliases.includes(a.id);

/** Skill scan of the package's GitHub repository, when the tool on file has one as its id or an alias. */
async function repoScan(db: Db, origin: string, toolId: string, canonicalId: string) {
  const aliases = await db.select({ alias: t.toolAliases.alias }).from(t.toolAliases).where(eq(t.toolAliases.toolId, toolId)).limit(20);
  const gh = [canonicalId, ...aliases.map((a) => a.alias)].find((x) => /^github\.com\/[^/]+\/[^/]+/.test(x));
  if (!gh) return null;
  const repo = gh.split("/").slice(0, 3).join("/");
  const fp = await latestFingerprintFor(db, repo);
  if (!fp) return null;
  const row = await db.query.skillScans.findFirst({ where: eq(t.skillScans.fingerprint, fp) });
  return row ? { verdict: row.verdict, scanned: new Date(row.lastSeen).toISOString(), repository: repo, page_url: `${origin}${answerPath(repo)}`, scan_url: `${origin}${scanPath(fp)}` } : null;
}

/**
 * The answer for one package, or null when it isn't on the list and doesn't resolve in its registry (a 404: no pages
 * for junk names). A listed package always has an answer, saying "unknown" for what couldn't be read. Never throws on
 * an unreachable OSV or registry.
 */
export async function packageAnswer(env: Env, ecosystem: PackageEcosystem, name: string, now = Date.now()): Promise<PackageAnswer | null> {
  const listed = isListedPackage(ecosystem, name);
  const id = `${ecosystem}:${name}`;
  const pkg = osvPackageFor(id);
  if (!pkg) return null;
  const latest = await latestRelease(env, id);
  if (!latest && !listed) return null;
  const db = getDb(env);
  const origin = env.PUBLIC_ORIGIN;
  // With the latest release known, the check asks OSV about that version and the any-version query runs alongside (a
  // different cache key). Without it, the check itself asks OSV about every version, so that query is read after it.
  const checkP = checkTool(env, latest ? { id, version: latest.version } : { id });
  const [check, all] = latest ? await Promise.all([checkP, queryAdvisories(env, pkg, null)]) : [await checkP, null as AdvisoryResult | null];
  const anyVersion = all ?? (!latest ? await queryAdvisories(env, pkg, null) : null);

  const version = latest?.version ?? check.version ?? null;
  const ps = check.public_signals_summary;
  const onVersion = ps && version && ps.version === version ? ps : null;

  // ADR 0123's rule for the version an install gets today: OSV answered for it and nothing matched is "clear", not
  // "unknown". And the reverse: nothing checked (OSV didn't answer) and no Forge Score is "unknown", never "clear".
  let status = check.security_status;
  if (status === "unknown" && onVersion && onVersion.total === 0) status = "clear";
  if (status === "clear" && !onVersion && check.forge_score == null) status = "unknown";
  const malOnVersion = !!onVersion?.advisories.some((a) => a.kind === "malicious");
  const basis: StatusBasis =
    status === "confirmed_malicious"
      ? "confirmed_by_review"
      : status === "flagged"
        ? malOnVersion ? "malicious_record_on_version" : "forge_reports"
        : status === "caution"
          ? onVersion?.total ? "advisory_on_version" : !onVersion && ps?.advisories.some((a) => a.kind === "malicious") ? "malicious_record_some_version" : "forge_reports"
          : status === "clear"
            ? "no_match_on_version"
            : !version ? "version_unavailable" : "advisories_unavailable";

  // One list: the advisories matching the version first, then the rest of the package's, each marked.
  const matched = onVersion?.advisories ?? [];
  const rest = (anyVersion?.advisories ?? (!onVersion && ps ? ps.advisories : [])).filter((a) => !matched.some((m) => sameAdvisory(a, m)));
  const list: PackageAdvisory[] = [
    ...matched.map((a) => ({ a, affects: true as boolean | null })),
    ...rest.map((a) => ({ a, affects: onVersion ? false : null })),
  ]
    .slice(0, 25)
    .map(({ a, affects }) => ({ id: a.id, kind: a.kind, ...(a.malicious_by ? { malicious_by: a.malicious_by } : {}), aliases: a.aliases, affects_version: affects, fixed: a.fixed, published: a.published, url: a.url, ...(a.exploited_in_wild ? { exploited_in_wild: true } : {}) }));
  const anyTotal = anyVersion?.total ?? (!onVersion && ps ? ps.total : null);

  // Field reports on this exact version, and on every version (counted in the database, held reports left out).
  const sameVersion = !!version && check.version === version;
  const onVersionReports = sameVersion ? check.reports_for_this_version : 0;
  const tool = check.known ? await findTool(db, canonicalToolId(id)) : undefined;
  const [totals, scan] = tool ? await Promise.all([reportTotals(db, tool.id), repoScan(db, origin, tool.id, tool.canonicalId).catch(() => null)]) : [null, null];

  const path = packagePagePath(ecosystem, name);
  const cli = `npx @theagentforge/cli check ${id}${version ? `@${version}` : ""}`;
  const restUrl = `${origin}/api/v1/check?id=${encodeURIComponent(id)}${version ? `&version=${encodeURIComponent(version)}` : ""}`;
  const people = sameVersion ? check.distinct_owners : 0;
  const forgeScore = sameVersion ? check.forge_score : null;
  return {
    ecosystem,
    package: name,
    tool_id: id,
    listed,
    list_version: TOP_PACKAGES_VERSION,
    as_of: new Date(now).toISOString(),
    version,
    version_source: latest ? "registry_latest" : version ? "newest_reported" : null,
    security_status: status,
    status_basis: basis,
    verdict: displayVerdict({ security_status: status, forge_score: forgeScore }),
    advisories: {
      source: "osv",
      checked: !!(onVersion ?? anyVersion ?? ps),
      checked_at: (onVersion ?? anyVersion ?? ps)?.checked_at ?? null,
      matching_version: onVersion ? onVersion.total : null,
      other_versions: onVersion && anyVersion ? Math.max(0, anyVersion.total - onVersion.total) : null,
      any_version: anyTotal,
      malicious_records: list.filter((a) => a.kind === "malicious").length,
      exploited_in_wild: list.filter((a) => a.exploited_in_wild).length,
      list,
      list_url: osvListUrl({ ecosystem: OSV_ECOSYSTEM[ecosystem], package: pkg.name }),
    },
    field_reports: {
      on_version: onVersionReports,
      outcomes: onVersionReports ? check.outcome_breakdown : null,
      people,
      verified_people: sameVersion ? check.verified_owners : 0,
      forge_score: forgeScore,
      all_versions: totals?.total ?? 0,
      versions_reported: (totals?.versions ?? []).slice(0, 10),
      tool_page_url: check.page_url,
    },
    skill_scan: scan,
    other_versions_flagged: check.other_versions_flagged,
    check: { tool: "forge_check", mcp_server: `${origin}/mcp/public`, arguments: { id, ...(version ? { version } : {}) }, rest_url: restUrl, cli },
    sources: { osv: osvListUrl({ ecosystem: OSV_ECOSYSTEM[ecosystem], package: pkg.name }), registry: registryUrl(ecosystem, name), methodology: `${origin}/methodology` },
    page_url: `${origin}${path}`,
    markdown_url: `${origin}${path}.md`,
  };
}

const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const day = (iso: string) => dayLabel(iso.slice(0, 10));
const word = (x: number | null, one: string, many: string) => (x === 1 ? one : many);

/** Published advisories for the package, any version (0 when none or not known). */
const historyCount = (a: PackageAnswer) => Math.max(a.advisories.any_version ?? 0, a.advisories.list.length);

/** The status in words on the page (diligence review, 7 Nov): never a bare "clear" over a package's advisory history. */
export const NO_MATCH_STATUS = "No advisory matches this version";
export function statusLabel(a: PackageAnswer): string {
  if (a.security_status === "clear" && historyCount(a) > 0) return NO_MATCH_STATUS;
  return a.security_status === "confirmed_malicious" ? "confirmed malicious" : a.security_status;
}

/** The question a page asks: about one exact version, the one the page is about. */
export const pageQuestion = (a: Pick<PackageAnswer, "tool_id" | "version">) => `Is ${a.tool_id}${a.version ? ` ${a.version}` : ""} safe to install?`;

/** OSV's record type in words. A CWE-506 record is shown as malicious code, never as a vulnerability. */
export function advisoryKind(x: Pick<PackageAdvisory, "kind" | "malicious_by">): string {
  if (x.kind !== "malicious") return "vulnerability";
  return x.malicious_by === "cwe_506" ? "malicious-code record (CWE-506: embedded malicious code)" : "malicious-package record";
}

/** The one-paragraph answer, date first. Counts, versions and sources only; never a safety promise. */
export function answerSentence(a: PackageAnswer): string {
  const reg = ECOSYSTEM_LABEL[a.ecosystem];
  const out: string[] = [];
  out.push(
    a.version_source === "registry_latest"
      ? `As of ${day(a.as_of)}, the latest release of ${a.package} on ${reg} is ${a.version}.`
      : a.version
        ? `As of ${day(a.as_of)}, the ${reg} registry didn't answer; the newest version of ${a.package} with field reports is ${a.version}.`
        : `As of ${day(a.as_of)}, the ${reg} registry didn't answer, so the latest version of ${a.package} isn't known here.`,
  );
  const adv = a.advisories;
  if (!adv.checked) out.push("The advisory lookup (OSV) didn't answer this time, so no advisories are counted.");
  else if (adv.matching_version !== null) {
    const m = adv.matching_version;
    out.push(
      `${m ? `${plural(m, "published advisory", "published advisories")} (OSV) ${m === 1 ? "matches" : "match"}` : "No published advisory (OSV) matches"} ${a.version}${adv.other_versions !== null ? `; ${plural(adv.other_versions, "more affects", "more affect")} older versions only` : ""}.`,
    );
  } else out.push(`${adv.any_version ? `${plural(adv.any_version, "published advisory", "published advisories")} (OSV) ${adv.any_version === 1 ? "exists" : "exist"} for some versions` : "No published advisory (OSV) exists for any version"}.`);
  const f = a.field_reports;
  if (a.version) {
    if (f.on_version && f.outcomes)
      out.push(`${plural(f.on_version, "field report")} on ${a.version}: ${f.outcomes.worked} worked, ${f.outcomes.partial} partly, ${f.outcomes.failed} failed, from ${plural(f.people, "person", "people")} (${f.verified_people} verified).`);
    else out.push(`No field reports on ${a.version} yet${f.all_versions ? ` (${plural(f.all_versions, "report")} on other versions)` : ""}.`);
  }
  out.push(`Security status: ${statusLabel(a)}.`);
  return out.join(" ");
}

/** What the status means here, and what it doesn't. */
export function statusMeaning(a: PackageAnswer): string {
  const v = a.version ?? "the version in use";
  switch (a.status_basis) {
    case "confirmed_by_review":
      return `Confirmed malicious: a person at the Forge reviewed the evidence on ${v} and confirmed it.`;
    case "malicious_record_on_version":
      return `Flagged: a published OSV record of malicious code matches ${v}. A flag is evidence to read, and the record is linked below.`;
    case "advisory_on_version":
      return `Caution: ${plural(a.advisories.matching_version ?? 0, "published advisory", "published advisories")} (OSV) ${a.advisories.matching_version === 1 ? "matches" : "match"} ${v}. Each is linked below with its fixed versions, if any.`;
    case "malicious_record_some_version":
      return "Caution: a published OSV record of malicious code exists for some version of this package, and the version in use couldn't be read here, so it may be the affected one.";
    case "forge_reports":
      return `${a.security_status === "flagged" ? "Flagged" : "Caution"}: field reports or a review on the Forge raised a security concern about ${a.version ? v : "a version of this package"}. The tool page has the reports and the status history.`;
    case "no_match_on_version": {
      const h = historyCount(a);
      if (h > 0)
        return `${NO_MATCH_STATUS}: ${plural(h, "published advisory", "published advisories")} (OSV) for ${a.package} ${h === 1 ? "exists" : "exist"}, and none matched ${v}; no field report flagged it, as of ${day(a.advisories.checked_at ?? a.as_of)}. Each is listed below. ${CLEAR_MEANING}`;
      return `Clear: no published advisory (OSV) matched ${v} and no field report flagged it, as of ${day(a.advisories.checked_at ?? a.as_of)}. ${CLEAR_MEANING}`;
    }
    case "version_unavailable":
      return "Unknown: the registry didn't answer, so the version an install would get couldn't be checked. Unknown is not clear.";
    case "advisories_unavailable":
      return "Unknown: the advisory lookup (OSV) didn't answer, so nothing was checked. Unknown is not clear.";
  }
}

const forgeOrg = (origin: string) => ({ "@type": "Organization", name: "The Agent Forge", url: `${origin}/about` });

function renderPage(c: Ctx, a: PackageAnswer) {
  const origin = c.env.PUBLIC_ORIGIN;
  const path = packagePagePath(a.ecosystem, a.package);
  const question = pageQuestion(a);
  const answer = answerSentence(a);
  const reg = ECOSYSTEM_LABEL[a.ecosystem];
  const adv = a.advisories;
  const f = a.field_reports;
  const stat = (value: string, label: string) => html`<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  return send(
    c,
    {
      title: question,
      description: answer.slice(0, 300),
      path,
      nav: "check",
      // Only listed packages are indexed; any other package that resolves is reachable but kept out of search.
      noindexFollow: !a.listed,
      jsonAlternate: `${path}?format=json`,
      markdownAlternate: `${path}.md`,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: question,
        description: answer,
        url: `${origin}${path}`,
        dateModified: a.as_of,
        inLanguage: "en",
        isPartOf: { "@type": "WebSite", name: "The Agent Forge", url: origin },
        publisher: forgeOrg(origin),
        about: { "@type": "SoftwareSourceCode", name: a.package, url: a.sources.registry },
      },
      body: html`<p class="eyebrow">${reg} package · data as of <time datetime="${a.as_of}">${day(a.as_of)}</time></p>
<h1 class="page-title">${question}</h1>
<p class="lead" id="answer">${answer}</p>
<p class="small mono muted">${breakableId(a.tool_id)}</p>
<div class="stats spaced">
${stat(a.version ?? "unknown", a.version_source === "registry_latest" ? `latest on ${reg}` : "version")}
${stat(adv.matching_version === null ? "—" : n(adv.matching_version), `${word(adv.matching_version, "advisory", "advisories")} matching ${a.version ?? "the version"}`)}
${adv.other_versions === null
  ? stat(adv.any_version === null ? "—" : n(adv.any_version), `${word(adv.any_version, "advisory", "advisories")}, any version`)
  : stat(n(adv.other_versions), `${word(adv.other_versions, "advisory", "advisories")} on older versions only`)}
${stat(n(f.on_version), `${word(f.on_version, "field report", "field reports")}${a.version ? ` on ${a.version}` : ""}`)}
</div>

<section aria-labelledby="status"><h2 id="status">What the status means</h2>
<p>Security status: <strong>${statusLabel(a)}</strong> · Forge verdict: ${verdictChip(a.verdict)}</p>
<p>${statusMeaning(a)}</p>
<p class="small muted">Advisories are matched to one exact version. An advisory can only be matched once it is published, and field reports need 5 people, at least 2 verified, before a version gets a Forge Score (<a href="/methodology">methodology</a>).</p>
${a.other_versions_flagged.length ? html`<p class="notice warn">Other versions under review or flagged on the Forge: ${a.other_versions_flagged.slice(0, 5).map((o, i) => html`${i ? ", " : ""}${o.version} (${o.security_status})`)}.</p>` : ""}
</section>

<section aria-labelledby="advisories"><h2 id="advisories">Published advisories (OSV)</h2>
${!adv.checked
  ? html`<p>The advisory lookup didn't answer this time. <a href="${adv.list_url}" rel="nofollow noopener">Search OSV for ${a.package}</a>.</p>`
  : adv.list.length
    ? html`<table class="table stack"><thead><tr><th scope="col">Advisory</th><th scope="col">Kind</th><th scope="col">${a.version ? `Matches ${a.version}` : "Matches the version"}</th><th scope="col">Fixed in</th><th scope="col">Published</th></tr></thead>
<tbody>${adv.list.map(
        (x) => html`<tr><td class="wide"><a class="mono" href="${x.url}" rel="nofollow noopener">${x.id}</a>${x.aliases.length ? html` <span class="muted small">${x.aliases.slice(0, 3).join(", ")}</span>` : ""}</td><td data-label="Kind">${advisoryKind(x)}${x.exploited_in_wild ? html` · <strong>exploited in the wild</strong> (CISA KEV)` : ""}</td><td data-label="Matches">${x.affects_version === null ? "not known" : x.affects_version ? "yes" : "no"}</td><td data-label="Fixed in">${x.fixed.length ? x.fixed.join(", ") : "—"}</td><td data-label="Published">${x.published ? x.published.slice(0, 10) : "—"}</td></tr>`,
      )}</tbody></table>
${(adv.any_version ?? 0) > adv.list.length ? html`<p class="small muted">${n((adv.any_version ?? 0) - adv.list.length)} more on <a href="${adv.list_url}" rel="nofollow noopener">OSV</a>.</p>` : ""}`
    : html`<p>No published advisory for ${a.package} on OSV, any version, as of ${day(adv.checked_at ?? a.as_of)}.</p>`}
<p class="small muted">Data from OSV (osv.dev), which serves the GitHub and PyPI advisory databases and the OpenSSF malicious-package records; checked ${adv.checked_at ? day(adv.checked_at) : "—"}.</p>
</section>

<section aria-labelledby="reports"><h2 id="reports">Field reports on the Forge</h2>
${f.on_version && f.outcomes
  ? html`<p>${plural(f.on_version, "report")} on ${a.version}: ${f.outcomes.worked} worked, ${f.outcomes.partial} partly, ${f.outcomes.failed} failed, from ${plural(f.people, "person", "people")} (${f.verified_people} verified)${f.forge_score !== null ? html`, Forge Score ${f.forge_score}` : ""}.</p>`
  : html`<p>No field reports on ${a.version ?? "this package"} yet.</p>`}
${f.all_versions ? html`<p class="small">${plural(f.all_versions, "report")} in all, on ${f.versions_reported.length === 1 ? "version" : "versions"} ${f.versions_reported.join(", ")}.</p>` : ""}
${f.tool_page_url ? html`<p class="small"><a href="${f.tool_page_url.replace(origin, "")}">Every report, version and status change</a>.</p>` : ""}
<p class="small muted">Field reports come from AI agents whose owners signed in with GitHub, after real use of an exact version.</p>
</section>

${a.skill_scan
  ? html`<section aria-labelledby="scan"><h2 id="scan">Skill scan</h2>
<p>The newest public scan of a skill file in <span class="mono">${a.skill_scan.repository}</span> (${day(a.skill_scan.scanned)}): ${a.skill_scan.verdict === "clear" ? "no risky pattern matched" : a.skill_scan.verdict === "flagged" ? "a high-risk pattern matched" : "a medium-risk pattern matched"}. <a href="${a.skill_scan.page_url.replace(origin, "")}">The scan answer</a> · <a href="${a.skill_scan.scan_url.replace(origin, "")}">full scan record</a>.</p>
</section>`
  : ""}

<section aria-labelledby="check"><h2 id="check">Check the exact version you install</h2>
<p>Advisories and reports belong to one version. Check the version in your lockfile from a terminal:</p>
${copyBlock("cmd-check", a.check.cli)}
<p class="small">From an AI agent, with no account: <code>forge_check</code> on <code>${a.check.mcp_server}</code> with <code>${JSON.stringify(a.check.arguments)}</code>, or the <a href="${a.check.rest_url}" rel="nofollow">check API</a>. <a href="/connect?from=is-it-safe">Connect your agent</a> to check before every install.</p>
</section>

<section aria-labelledby="sources"><h2 id="sources">Sources</h2>
<ul class="small">
<li>OSV advisories for ${OSV_ECOSYSTEM[a.ecosystem]} ${a.package}: <a href="${a.sources.osv}" rel="nofollow noopener">osv.dev</a></li>
<li>The ${reg} page: <a href="${a.sources.registry}" rel="nofollow noopener">${a.sources.registry.replace(/^https:\/\//, "")}</a>${a.version ? html` (<a href="${registryUrl(a.ecosystem, a.package, a.version)}" rel="nofollow noopener">${a.version}</a>)` : ""}</li>
<li><a href="/methodology">How field reports, scores and statuses are counted</a></li>
<li>This answer as data: <a href="${path}?format=json">JSON</a> · <a href="${path}.md">Markdown</a></li>
</ul>
<p class="small muted">${a.listed ? html`One of the ${n(TOP_NPM.length + TOP_PYPI.length)} commonly installed packages the Forge answers for (list of ${TOP_PACKAGES_VERSION}). ` : ""}<a href="${IS_IT_SAFE_PATH}">All packages</a>. Publisher? <a href="mailto:disputes@theagentforge.io?subject=${encodeURIComponent(a.tool_id)}">Reply or dispute</a>.</p>
</section>`,
    },
    { maxAge: IS_IT_SAFE_MAX_AGE },
  );
}

async function indexPage(c: Ctx, markdown: boolean) {
  const origin = c.env.PUBLIC_ORIGIN;
  const entry = (eco: PackageEcosystem) => (name: string) => ({ ecosystem: eco, package: name, tool_id: `${eco}:${name}`, url: `${origin}${packagePagePath(eco, name)}`, markdown: `${origin}${packagePagePath(eco, name)}.md` });
  if (wantsJson(c) && !markdown)
    return sendJson(c, { list_version: TOP_PACKAGES_VERSION, counts: { npm: TOP_NPM.length, pypi: TOP_PYPI.length }, packages: [...TOP_NPM.map(entry("npm")), ...TOP_PYPI.map(entry("pypi"))], url_pattern: `${origin}${IS_IT_SAFE_PATH}/{ecosystem}/{package}` }, IS_IT_SAFE_MAX_AGE);
  const links = (eco: PackageEcosystem, names: readonly string[]) => html`<p class="chips">${names.map((name) => html`<a class="chip" href="${packagePagePath(eco, name)}">${name}</a> `)}</p>`;
  const res = await send(
    c,
    {
      title: "Is it safe to install? npm and PyPI packages",
      description: `Published advisories (OSV) on the latest release and field reports from AI agents for ${n(TOP_NPM.length)} npm and ${n(TOP_PYPI.length)} PyPI packages, each with its date and sources.`,
      path: IS_IT_SAFE_PATH,
      nav: "check",
      jsonAlternate: `${IS_IT_SAFE_PATH}?format=json`,
      markdownAlternate: `${IS_IT_SAFE_PATH}.md`,
      jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Is it safe to install? npm and PyPI packages", url: `${origin}${IS_IT_SAFE_PATH}`, isPartOf: { "@type": "WebSite", name: "The Agent Forge", url: origin }, publisher: forgeOrg(origin) },
      body: html`<p class="eyebrow">Package answers · list of ${TOP_PACKAGES_VERSION}</p>
<h1 class="page-title">Is it safe to install?</h1>
<p class="lead">For each package: its latest release, how many published advisories (OSV) match that release and how many affect older versions only, and the Forge's field reports from AI agents. Data, dated and sourced; never a promise. ${CLEAR_MEANING}</p>
<section aria-labelledby="npm"><h2 id="npm">npm (${n(TOP_NPM.length)})</h2>${links("npm", TOP_NPM)}</section>
<section aria-labelledby="pypi"><h2 id="pypi">PyPI (${n(TOP_PYPI.length)})</h2>${links("pypi", TOP_PYPI)}</section>
<section aria-labelledby="other"><h2 id="other">Any other package</h2>
<p>Any npm or PyPI package that resolves in its registry has the same page at <code>${IS_IT_SAFE_PATH}/npm/&lt;name&gt;</code> or <code>${IS_IT_SAFE_PATH}/pypi/&lt;name&gt;</code>. For an exact version, from a terminal:</p>
${copyBlock("cmd-check", "npx @theagentforge/cli check npm:<name>@<version>")}
<p class="small">Or <a href="/check">check a tool</a> here, or call <code>forge_check</code> on <code>${origin}/mcp/public</code> (no account). <a href="/methodology">Methodology</a> · as data: <a href="${IS_IT_SAFE_PATH}?format=json">JSON</a> · <a href="${IS_IT_SAFE_PATH}.md">Markdown</a></p>
</section>`,
    },
    { maxAge: IS_IT_SAFE_MAX_AGE },
  );
  return markdown ? markdownResponse(res, `${origin}${IS_IT_SAFE_PATH}.md`) : res;
}

site.get(IS_IT_SAFE_PATH, (c) => indexPage(c, false));
site.get(`${IS_IT_SAFE_PATH}.md`, (c) => indexPage(c, true));

site.get(`${IS_IT_SAFE_PATH}/:rest{.+}`, async (c) => {
  const url = new URL(c.req.url);
  let rest: string;
  try {
    rest = decodeURIComponent(url.pathname.slice(IS_IT_SAFE_PATH.length + 1)).replace(/\/+$/, "");
  } catch {
    return notFound(c, "Not a package address", "That link isn't a valid package address.");
  }
  // `.md` is the Markdown twin (a package whose own name ends in ".md" can't have one; none is listed).
  const markdown = rest.endsWith(".md");
  if (markdown) rest = rest.slice(0, -3);
  const m = /^(npm|pypi)\/(.+)$/.exec(rest);
  const ecosystem = m?.[1] as PackageEcosystem | undefined;
  const name = ecosystem ? canonicalPackageName(ecosystem, m![2]!) : null;
  if (!ecosystem || !name) return notFound(c, "Not a package address", "Package answers are at /is-it-safe/npm/<name> and /is-it-safe/pypi/<name>.");
  // One address per package: npm names in lower case, PyPI names PEP 503 normalised.
  if (name !== m![2]) return c.redirect(`${packagePagePath(ecosystem, name)}${markdown ? ".md" : ""}${url.search}`, 301);
  const a = await packageAnswer(c.env, ecosystem, name);
  if (!a) return notFound(c, "No such package found", `${ECOSYSTEM_LABEL[ecosystem]} has no package named ${name}, or its registry didn't answer.`);
  if (wantsJson(c) && !markdown) return sendJson(c, a, IS_IT_SAFE_MAX_AGE);
  const res = await renderPage(c, a);
  return markdown ? markdownResponse(res, a.markdown_url) : res;
});
