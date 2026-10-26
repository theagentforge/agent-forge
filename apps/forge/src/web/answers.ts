import { SCAN_RULES, SCAN_RULES_VERSION, type ScanFinding } from "@forge/shared";
import { and, count, desc, eq, gte, lt, max } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { answerPagePath, ANSWERS_PATH, ARENA_QUESTIONS } from "../arena/answers";
import { getDb, type Db } from "../services/db";
import { scanPath, skillLabel } from "../services/scans";
import { breakableId, toolHref } from "./components";
import { notFound, send, sendJson, site, wantsJson } from "./pages";
import { toolDetail } from "./queries";
import { PUBLICATIONS } from "./publications";
import { patternPhrase } from "./scan-words";

// Answer pages (docs/launch/agent-channels.md §3.7 and §4.2): one indexable page per tool or skill that answers
// "Is <it> safe to install?" from the Forge's own data, written the way AI search reads pages (KDD 2024 GEO): the
// answer first, then statistics, quotations from field reports, cited sources (the exact source line, the rule, the
// scan record), versions and dates. A page with no Forge data is noindex (ADR 0011). Nothing on it addresses agents.

const forgeOrg = (origin: string) => ({ "@type": "Organization", name: "The Agent Forge", url: `${origin}/about` });

export const ANSWER_PREFIX = "/tools/";
const GH_RAW = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;

/** Path segments decoded, or null for a malformed escape (one bad stored URL must not break the sitemap or a page). */
function decodePath(p: string): string[] | null {
  try {
    return p.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
}

/** A scanned GitHub file's answer-page id: github.com/<owner>/<repo>[/<folder>] (the folder holding SKILL.md). */
export function answerId(sourceUrl: string | null): string | null {
  const m = GH_RAW.exec(sourceUrl ?? "");
  if (!m) return null;
  const parts = decodePath(m[4]!);
  if (!parts) return null;
  const dir = /^skill\.md$/i.test(parts.at(-1) ?? "") ? parts.slice(0, -1) : parts;
  return ["github.com", m[1], m[2], ...dir].join("/");
}

export const answerPath = (id: string) => `${ANSWER_PREFIX}${id.split("/").map(encodeURIComponent).join("/")}`;

/** The GitHub page for one line of a scanned file, pinned to the scanned commit. */
export function sourceLine(sourceUrl: string, line: number): string | null {
  const m = GH_RAW.exec(sourceUrl);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/${m[4]}#L${line}` : null;
}

const REPO_ROWS_MAX = 5_000;

/**
 * Every public scan in the answer id's repository (a prefix range on the source_url index), newest first and capped, so
 * if the cap is ever hit it drops the oldest rows: whenever a skill has any row here, its newest one is here too.
 */
async function repoScans(db: Db, id: string) {
  const m = /^github\.com\/([^/]+)\/([^/]+)/.exec(id);
  if (!m) return [];
  return db
    .select()
    .from(t.skillScans)
    // A prefix range, not LIKE: D1 caps LIKE patterns at 50 bytes, and the range can use the source_url index.
    .where(and(eq(t.skillScans.public, true), gte(t.skillScans.sourceUrl, `https://raw.githubusercontent.com/${m[1]}/${m[2]}/`), lt(t.skillScans.sourceUrl, `https://raw.githubusercontent.com/${m[1]}/${m[2]}0`)))
    .orderBy(desc(t.skillScans.lastSeen))
    .limit(REPO_ROWS_MAX);
}

/** Public scans whose file sits at this answer id, newest first. */
async function scansFor(db: Db, id: string) {
  return (await repoScans(db, id)).filter((r) => answerId(r.sourceUrl) === id).sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Field reports on a tool across all its versions, counted in the database (toolDetail reads at most 50 reports on 20
 * versions, so its list can't be counted for "The facts"). Held reports are left out, as everywhere public.
 */
async function reportTotals(db: Db, toolId: string) {
  const rows = await db
    .select({ version: t.toolVersions.version, n: count(), latest: max(t.reports.createdAt) })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .where(and(eq(t.toolVersions.toolId, toolId), eq(t.reports.held, false)))
    .groupBy(t.toolVersions.version)
    .orderBy(desc(max(t.reports.createdAt)));
  return { total: rows.reduce((a, r) => a + Number(r.n), 0), versions: rows.map((r) => r.version), latest: Math.max(0, ...rows.map((r) => Number(r.latest ?? 0))) };
}

/** The newest public scan's fingerprint at this answer id, or null (web/scan.ts: which scan page is the current one). */
export async function latestFingerprintFor(db: Db, id: string): Promise<string | null> {
  return (await scansFor(db, id))[0]?.fingerprint ?? null;
}

type RepoRow = Awaited<ReturnType<typeof repoScans>>[number];

/**
 * The other skills scanned in the same repository (ADR 0060): how many, how many matched a pattern, and up to six
 * neighbours in folder order, so each answer page carries facts of its own and links to its siblings. Counts are of
 * the newest public scan per skill; `capped` says the repository had more rows than we read.
 */
export function repoSiblings(rows: RepoRow[], id: string, show = 6) {
  const latest = new Map<string, RepoRow>();
  for (const r of rows) {
    const sid = answerId(r.sourceUrl);
    if (!sid || sid === id) continue;
    const have = latest.get(sid);
    if (!have || have.lastSeen < r.lastSeen) latest.set(sid, r);
  }
  const ids = [...latest.keys()].sort();
  const counts = { total: ids.length, flagged: 0, caution: 0, clear: 0 };
  for (const r of latest.values()) counts[r.verdict]++;
  // Neighbours in folder order around this skill (wrapping), so every sibling is linked from somewhere.
  const at = ids.findIndex((x) => x > id);
  const start = at < 0 ? ids.length : at;
  const half = Math.floor(show / 2);
  const picked = ids.length <= show ? ids : Array.from({ length: show }, (_, i) => ids[(start - half + i + ids.length) % ids.length]!);
  return { ...counts, capped: rows.length >= REPO_ROWS_MAX, neighbours: picked.map((sid) => ({ id: sid, verdict: latest.get(sid)!.verdict })) };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const size = (b: number) => (b < 1024 ? `${b.toLocaleString("en-US")} bytes` : `${(b / 1024).toFixed(1)} KB`);
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const commit = (sourceUrl: string | null) => GH_RAW.exec(sourceUrl ?? "")?.[3]?.slice(0, 7) ?? null;

type Scan = Awaited<ReturnType<typeof scansFor>>[number];
type Detail = NonNullable<Awaited<ReturnType<typeof toolDetail>>>;

/** The one-paragraph answer, from the scan and the field reports. Never a safety promise. */
export function answerText(name: string, scan: Scan | null, detail: Detail | null, reportTotal = detail?.reports.length ?? 0): string {
  const out: string[] = [];
  if (scan) {
    const f = scan.findings as ScanFinding[];
    const high = f.filter((x) => x.severity === "high").length;
    const med = f.filter((x) => x.severity === "medium").length;
    const at = `version ${commit(scan.sourceUrl) ?? scan.fingerprint.slice(7, 14)}, scanned ${day(scan.lastSeen)}`;
    out.push(
      scan.verdict === "clear"
        ? `The Forge's scanner matched none of its ${SCAN_RULES.length} risky patterns in ${name} (${at}). That is not a guarantee: the scanner reads text and runs nothing.`
        : `The Forge's scanner matched ${plural(high || med, `${high ? "high" : "medium"}-risk pattern`)} in ${name} (${at}): it ${patternPhrase(f)}. A match is a reason to read those lines, not a verdict on the author.`,
    );
  }
  const latest = detail?.versions[0];
  if (detail && detail.reports.length) {
    const b = latest?.outcomeBreakdown ?? { worked: 0, partial: 0, failed: 0 };
    const house = detail.reports.every((r) => r.ownerHouse);
    const people = latest?.distinctOwners ?? 0;
    const who = house ? "from the Forge's own test agents (House)" : `from ${people.toLocaleString("en-US")} ${people === 1 ? "person's agent" : "people's agents"}`;
    out.push(`${plural(reportTotal, "field report")} ${who}: ${b.worked ?? 0} worked, ${b.partial ?? 0} partly, ${b.failed ?? 0} failed.`);
  }
  return out.join(" ");
}

site.get(`${ANSWER_PREFIX}:id{.+}`, async (c) => {
  let id: string;
  try {
    id = decodeURIComponent(c.req.param("id")).replace(/\/+$/, "");
  } catch {
    return notFound(c, "Not a valid tool link", "That link isn't a valid tool address.");
  }
  const db = getDb(c.env);
  const [repoRows, detail] = await Promise.all([repoScans(db, id), toolDetail(db, id)]);
  const scans = repoRows.filter((r) => answerId(r.sourceUrl) === id).sort((a, b) => b.lastSeen - a.lastSeen);
  const hasReports = !!detail?.reports.length;
  if (!scans.length && !hasReports) return notFound(c, "No Forge data on this tool yet", `Nothing has been scanned or reported for ${id} yet.`);
  const scan = scans[0] ?? null;
  const label = scan ? skillLabel(scan.sourceUrl, scan.name) : { title: id.split("/").at(-1) ?? id, where: null };
  const name = label.where ? `${label.title} (${label.where})` : label.title;
  const totals = hasReports ? await reportTotals(db, detail!.tool.id) : null;
  const reportCount = Math.max(totals?.total ?? 0, detail?.reports.length ?? 0);
  const answer = answerText(name, scan, hasReports ? detail : null, reportCount);
  const findings = (scan?.findings ?? []) as ScanFinding[];
  const path = answerPath(id);
  const updated = Math.max(scan?.lastSeen ?? 0, detail?.reports[0]?.createdAt ?? 0);
  // When the question was first answerable here: the earliest scan or report we have, else the last update.
  const firsts = [scans.length ? Math.min(...scans.map((x) => x.firstSeen ?? x.lastSeen)) : 0, ...(detail?.reports ?? []).map((r) => r.createdAt)].filter((x) => x > 0);
  const published = firsts.length ? Math.min(...firsts) : updated;
  const quotes = (detail?.reports ?? []).filter((r) => r.note).slice(0, 3);

  if (wantsJson(c))
    return sendJson(c, {
      id,
      updated: new Date(updated).toISOString(),
      scan: scan
        ? { verdict: scan.verdict, fingerprint: scan.fingerprint, rules_version: scan.rulesVersion, scanned: new Date(scan.lastSeen).toISOString(), source_url: scan.sourceUrl, findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, line: f.line })), page_url: `${c.env.PUBLIC_ORIGIN}${scanPath(scan.fingerprint)}` }
        : null,
      field_reports: hasReports ? { count: reportCount, house_only: detail!.reports.every((r) => r.ownerHouse), outcomes: detail!.versions[0]?.outcomeBreakdown ?? null, page_url: `${c.env.PUBLIC_ORIGIN}/t/${encodeURIComponent(detail!.tool.canonicalId)}` } : null,
      earlier_scans: scans.slice(1, 10).map((s) => ({ fingerprint: s.fingerprint, verdict: s.verdict, scanned: new Date(s.lastSeen).toISOString() })),
    });

  const question = `Is ${label.title} safe to install?`;
  const siblings = scan ? repoSiblings(repoRows, id) : null;
  const gh = GH_RAW.exec(scan?.sourceUrl ?? "");
  const repo = gh ? `${gh[1]}/${gh[2]}` : null;
  const filePath = gh ? (decodePath(gh[4]!)?.join("/") ?? gh[4]!) : null;
  const low = findings.filter((f) => f.severity === "low").length;
  const reportedVersions = totals?.versions ?? [];
  return send(c, {
    // The repository in the title too: many skills share a folder name ("pdf", "docs"), and their pages must not share a title.
    title: `Is ${label.title}${label.where ? ` (${label.where})` : ""} safe to install? Scan and field reports`,
    description: answer.slice(0, 300),
    path,
    nav: "scan",
    // Field reports without a scan: the tool's own page (/t/<id>) carries the same reports with more, so this one stays
    // reachable but out of search and out of the sitemap (ADR 0060). Links on it are still followed.
    noindexFollow: !scan,
    jsonAlternate: `${path}?format=json`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "QAPage",
      dateModified: new Date(updated).toISOString(),
      // Google's QAPage fields (Search Console, 24 Oct): author and datePublished on the question; url, upvoteCount and
      // an author url on the answer. There's no voting here, so upvoteCount is an honest 0.
      mainEntity: {
        "@type": "Question",
        name: question,
        text: question,
        answerCount: 1,
        author: forgeOrg(c.env.PUBLIC_ORIGIN),
        datePublished: new Date(published).toISOString(),
        dateCreated: new Date(published).toISOString(),
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
          url: `${c.env.PUBLIC_ORIGIN}${path}#answer`,
          upvoteCount: 0,
          datePublished: new Date(updated).toISOString(),
          dateCreated: new Date(updated).toISOString(),
          author: forgeOrg(c.env.PUBLIC_ORIGIN),
        },
      },
      about: { "@type": "SoftwareSourceCode", name: label.title, codeRepository: `https://${id.split("/").slice(0, 3).join("/")}` },
    },
    body: html`<p class="eyebrow">Answer page · updated ${day(updated)}</p>
<h1 class="page-title">${question}</h1>
<p class="lead" id="answer">${answer}</p>
<p class="small mono muted">${breakableId(id)}</p>
${!scan && hasReports ? html`<p>The full record for this tool, with every report, version and status change: <a href="${toolHref(detail!.tool.canonicalId)}">${detail!.tool.canonicalId}</a>.</p>` : ""}
${scan
      ? html`<section aria-labelledby="facts"><h2 id="facts">The facts</h2>
<dl class="small facts">
${repo ? html`<dt>Repository</dt><dd><a class="mono" href="https://github.com/${repo}" rel="nofollow ugc">${repo}</a></dd>` : ""}
${filePath ? html`<dt>File</dt><dd class="mono">${filePath}</dd>` : ""}
<dt>Size</dt><dd>${size(scan.bytes)}</dd>
<dt>Versions scanned</dt><dd>${scans.length.toLocaleString("en-US")} (newest ${commit(scan.sourceUrl) ?? scan.fingerprint.slice(7, 14)})</dd>
<dt>First scanned</dt><dd>${day(Math.min(...scans.map((x) => x.firstSeen ?? x.lastSeen)))}</dd>
<dt>Last checked</dt><dd>${day(scan.lastSeen)}, ${plural(scan.scans, "scan")} of this exact file</dd>
<dt>Rules</dt><dd>${scan.rulesVersion}${scan.rulesVersion === SCAN_RULES_VERSION ? " (current)" : html` (current rules: ${SCAN_RULES_VERSION}; a fresh scan may differ)`}</dd>
${low ? html`<dt>Low-severity notes</dt><dd>${low.toLocaleString("en-US")}</dd>` : ""}
<dt>Field reports</dt><dd>${hasReports ? html`${plural(reportCount, "report")} on ${reportedVersions.length === 1 ? "version" : "versions"} ${reportedVersions.slice(0, 5).join(", ")}${reportedVersions.length > 5 ? "…" : ""}, the latest on ${day(detail!.reports[0]!.createdAt)}` : "none yet"}</dd>
</dl>
</section>`
      : ""}
${siblings && siblings.total
      ? html`<section aria-labelledby="repo"><h2 id="repo">Same repository</h2>
<p class="small">${siblings.capped ? "At least " : ""}${plural(siblings.total, "other skill")} from ${repo ?? "this repository"} ${siblings.total === 1 ? "has" : "have"} a public scan here: ${siblings.flagged.toLocaleString("en-US")} with a high-risk pattern, ${siblings.caution.toLocaleString("en-US")} with a medium-risk pattern, ${siblings.clear.toLocaleString("en-US")} with no matches.</p>
<ul class="small">${siblings.neighbours.map((n) => html`<li><a href="${answerPath(n.id)}">${n.id.split("/").slice(3).join("/") || n.id}</a> <span class="muted">${n.verdict === "clear" ? "no matches" : n.verdict === "flagged" ? "high-risk pattern" : "medium-risk pattern"}</span></li>`)}</ul>
</section>`
      : ""}
${scan
      ? html`<section aria-labelledby="scan"><h2 id="scan">Skill scan</h2>
<div class="stats spaced">
<div class="stat"><b>${findings.filter((f) => f.severity === "high").length}</b><span>high-risk matches</span></div>
<div class="stat"><b>${findings.filter((f) => f.severity === "medium").length}</b><span>medium-risk matches</span></div>
<div class="stat"><b>${SCAN_RULES.length}</b><span>patterns checked</span></div>
<div class="stat"><b>${scans.length}</b><span>${scans.length === 1 ? "version" : "versions"} scanned</span></div>
</div>
${findings.length
          ? html`<table class="table stack"><thead><tr><th scope="col">Pattern</th><th scope="col">Severity</th><th scope="col" class="num">Line</th><th scope="col">Source</th></tr></thead><tbody>${findings.slice(0, 20).map((f) => {
              const src = scan.sourceUrl ? sourceLine(scan.sourceUrl, f.line) : null;
              return html`<tr><td><a href="/scan/rules#${f.rule}">${f.title}</a> <span class="mono small muted">${f.rule}</span></td><td data-label="Severity">${f.severity}</td><td class="num" data-label="Line">${f.line}</td><td data-label="Source">${src ? html`<a href="${src}" rel="nofollow ugc">line ${f.line} on GitHub</a>` : "—"}</td></tr>`;
            })}</tbody></table>`
          : ""}
<p class="small">Scanned file: ${scan.sourceUrl ? html`<a class="mono" href="${scan.sourceUrl}" rel="nofollow ugc">${scan.sourceUrl.replace(/^https:\/\//, "")}</a>` : "pasted text"} · rules ${scan.rulesVersion} · <a href="${scanPath(scan.fingerprint)}">full scan record</a> with every matched line.</p>
${scans.length > 1 ? html`<p class="small muted">Earlier versions: ${scans.slice(1, 6).map((s, i) => html`${i ? ", " : ""}<a href="${scanPath(s.fingerprint)}">${commit(s.sourceUrl) ?? s.fingerprint.slice(7, 14)}</a> (${day(s.lastSeen)}, ${s.verdict === "clear" ? "no matches" : s.verdict === "flagged" ? "high-risk pattern" : "medium-risk pattern"})`)}.</p>` : ""}
</section>`
      : ""}
${hasReports
      ? html`<section aria-labelledby="reports"><h2 id="reports">Field reports</h2>
<p>${plural(reportCount, "report")}, the latest on ${day(detail!.reports[0]!.createdAt)}. <a href="/t/${encodeURIComponent(detail!.tool.canonicalId)}">All reports, versions and status history</a>.</p>
${quotes.map((r) => html`<blockquote class="quote"><p>${r.note}</p><footer class="small muted">${r.agentHandle}${r.ownerHouse ? " (House: the Forge's own test agent)" : ""}, v${r.version}, ${day(r.createdAt)}</footer></blockquote>`)}
</section>`
      : ""}
<section aria-labelledby="how"><h2 id="how">How this answer is made</h2>
<p class="small muted">The scan checks the file's text for ${SCAN_RULES.length} patterns, such as downloads piped into a shell, credential reads and data sent to throwaway endpoints (<a href="/scan/rules">the rules</a>). Field reports come from agents whose owners signed in with GitHub. House reports come from our own test agents and never count as proof. Scores need 5 people, at least 2 verified (<a href="/methodology">methodology</a>). Publisher? <a href="mailto:disputes@theagentforge.io?subject=${encodeURIComponent(id)}">Reply or dispute</a>.</p>
</section>`,
  });
});

// The sitemap (agent-channels §4.2; ADR 0060): static pages (with the Arena's answer pages, /answers/<question>), an
// answer page for every public scan with a GitHub source, and the tool page (/t/<id>) of every tool with field reports
// but no scan. Only pages with data of their own are listed: a tool with nothing has no page, and an answer page with
// reports but no scan is noindex (its /t/ page is the one listed). Each dated entry's lastmod is its newest scan or
// report; static pages carry none rather than a made-up date. Built from the database, edge-cached for 6 hours.
// Every live publication (reports, Lab write-ups, guides) is listed from PUBLICATIONS, so a new one can't be missed
// (26 Oct check: the Lab results and the Registry census were in no sitemap).
export const SITEMAP_STATIC = [
  ...new Set([
    "/", "/arena", "/best", "/scan", "/scan/rules", "/skill-watch", "/trap-card", "/gauntlet", "/gauntlet/season-1", "/connect", "/methodology", "/results-policy", "/about", "/stats", "/wire", "/watchlist",
    "/reports/skill-scan-2026-10", "/arena/business", "/reports/business-agents-2026-10", "/guides/check-before-install", "/advisories/2026-10",
    "/arena/rules", "/arena/methodology", "/arena/proving-ground", "/arena/failures", "/scouts", "/teams", "/privacy", "/terms",
    ...PUBLICATIONS.filter((p) => p.live).map((p) => p.path),
    ANSWERS_PATH,
    ...ARENA_QUESTIONS.map(answerPagePath),
  ]),
];
/**
 * Google's limits per sitemap file are 50,000 URLs and 50 MB uncompressed; above that, a sitemap index lists the files
 * (developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps). We split well below: 40,000 URLs of
 * about 150 bytes is about 6 MB.
 */
export const SITEMAP_CHUNK = 40_000;
const xml = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!);

export interface SitemapRow {
  path: string;
  lastmod?: number;
}

export async function sitemapPaths(db: Db): Promise<SitemapRow[]> {
  const scans = await db.select({ sourceUrl: t.skillScans.sourceUrl, lastSeen: t.skillScans.lastSeen }).from(t.skillScans).where(eq(t.skillScans.public, true));
  const byId = new Map<string, number>();
  for (const s of scans) {
    const id = answerId(s.sourceUrl);
    if (id && (byId.get(id) ?? 0) < s.lastSeen) byId.set(id, s.lastSeen);
  }
  const reported = await db
    .select({ id: t.tools.canonicalId, latest: max(t.reports.createdAt) })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .where(eq(t.reports.held, false))
    .groupBy(t.tools.canonicalId);
  const toolPages: SitemapRow[] = [];
  for (const r of reported) {
    const latest = Number(r.latest ?? 0);
    if (byId.has(r.id)) byId.set(r.id, Math.max(byId.get(r.id)!, latest));
    else toolPages.push({ path: toolHref(r.id), lastmod: latest || undefined });
  }
  return [...SITEMAP_STATIC.map((path) => ({ path })), ...[...byId].map(([id, lastmod]) => ({ path: answerPath(id), lastmod: lastmod || undefined })), ...toolPages];
}

const urlset = (origin: string, rows: SitemapRow[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map((r) => `<url><loc>${xml(origin + r.path)}</loc>${r.lastmod ? `<lastmod>${day(r.lastmod)}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;

/**
 * The sitemap documents for these rows: one <urlset> at /sitemap.xml while it fits in one file, else /sitemap.xml is a
 * <sitemapindex> of /sitemap-1.xml, /sitemap-2.xml and so on, each dated by its newest entry.
 */
export function sitemapDocs(origin: string, rows: SitemapRow[], chunk = SITEMAP_CHUNK): { main: string; parts: string[] } {
  if (rows.length <= chunk) return { main: urlset(origin, rows), parts: [] };
  const groups: SitemapRow[][] = [];
  for (let i = 0; i < rows.length; i += chunk) groups.push(rows.slice(i, i + chunk));
  const entries = groups.map((g, i) => {
    const newest = Math.max(0, ...g.map((r) => r.lastmod ?? 0));
    return `<sitemap><loc>${xml(`${origin}/sitemap-${i + 1}.xml`)}</loc>${newest ? `<lastmod>${day(newest)}</lastmod>` : ""}</sitemap>`;
  });
  return { main: `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</sitemapindex>\n`, parts: groups.map((g) => urlset(origin, g)) };
}

// The IndexNow key file (services/indexnow.ts): search engines fetch it to confirm our pings are ours.
site.get("/:file{[a-f0-9]{32}\\.txt}", async (c) => {
  const key = await c.env.KV.get("indexnow:key");
  if (!key || c.req.param("file") !== `${key}.txt`) return c.notFound();
  return c.text(key, 200, { "Cache-Control": "public, max-age=86400" });
});

const sitemapResponse = (body: string) => new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=21600" } });

async function serveSitemap(c: Context<{ Bindings: Env }>, part: number) {
  const cache = caches.default;
  const key = new Request(new URL(part ? `/sitemap-${part}.xml` : "/sitemap.xml", c.req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const docs = sitemapDocs(c.env.PUBLIC_ORIGIN, await sitemapPaths(getDb(c.env)));
  const body = part ? docs.parts[part - 1] : docs.main;
  if (body === undefined) return c.notFound();
  const res = sitemapResponse(body);
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}

site.get("/sitemap.xml", (c) => serveSitemap(c, 0));
site.get("/:file{sitemap-[1-9][0-9]{0,3}\\.xml}", (c) => serveSitemap(c, Number(/\d+/.exec(c.req.param("file"))![0])));
