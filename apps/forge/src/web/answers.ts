import { SCAN_RULES, type ScanFinding } from "@forge/shared";
import { and, eq, gte, lt } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import { scanPath, skillLabel } from "../services/scans";
import { breakableId } from "./components";
import { notFound, send, sendJson, site, wantsJson } from "./pages";
import { toolDetail } from "./queries";
import { patternPhrase } from "./scan-words";

// Answer pages (docs/launch/agent-channels.md §3.7 and §4.2): one indexable page per tool or skill that answers
// "Is <it> safe to install?" from the Forge's own data, written the way AI search reads pages (KDD 2024 GEO): the
// answer first, then statistics, quotations from field reports, cited sources (the exact source line, the rule, the
// scan record), versions and dates. A page with no Forge data is noindex (ADR 0011). Nothing on it addresses agents.

export const ANSWER_PREFIX = "/tools/";
const GH_RAW = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;

/** A scanned GitHub file's answer-page id: github.com/<owner>/<repo>[/<folder>] (the folder holding SKILL.md). */
export function answerId(sourceUrl: string | null): string | null {
  const m = GH_RAW.exec(sourceUrl ?? "");
  if (!m) return null;
  const parts = m[4]!.split("/").map(decodeURIComponent);
  const dir = /^skill\.md$/i.test(parts.at(-1) ?? "") ? parts.slice(0, -1) : parts;
  return ["github.com", m[1], m[2], ...dir].join("/");
}

export const answerPath = (id: string) => `${ANSWER_PREFIX}${id.split("/").map(encodeURIComponent).join("/")}`;

/** The GitHub page for one line of a scanned file, pinned to the scanned commit. */
export function sourceLine(sourceUrl: string, line: number): string | null {
  const m = GH_RAW.exec(sourceUrl);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/${m[4]}#L${line}` : null;
}

/** Public scans whose file sits at this answer id, newest first. */
async function scansFor(db: Db, id: string) {
  const m = /^github\.com\/([^/]+)\/([^/]+)/.exec(id);
  if (!m) return [];
  const rows = await db
    .select()
    .from(t.skillScans)
    // A prefix range, not LIKE: D1 caps LIKE patterns at 50 bytes, and the range can use the source_url index.
    .where(and(eq(t.skillScans.public, true), gte(t.skillScans.sourceUrl, `https://raw.githubusercontent.com/${m[1]}/${m[2]}/`), lt(t.skillScans.sourceUrl, `https://raw.githubusercontent.com/${m[1]}/${m[2]}0`)))
    .limit(2000);
  return rows.filter((r) => answerId(r.sourceUrl) === id).sort((a, b) => b.lastSeen - a.lastSeen);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const commit = (sourceUrl: string | null) => GH_RAW.exec(sourceUrl ?? "")?.[3]?.slice(0, 7) ?? null;

type Scan = Awaited<ReturnType<typeof scansFor>>[number];
type Detail = NonNullable<Awaited<ReturnType<typeof toolDetail>>>;

/** The one-paragraph answer, from the scan and the field reports. Never a safety promise. */
export function answerText(name: string, scan: Scan | null, detail: Detail | null): string {
  const out: string[] = [];
  if (scan) {
    const f = scan.findings as ScanFinding[];
    const high = f.filter((x) => x.severity === "high").length;
    const med = f.filter((x) => x.severity === "medium").length;
    const at = `version ${commit(scan.sourceUrl) ?? scan.fingerprint.slice(7, 14)}, scanned ${day(scan.lastSeen)}`;
    out.push(
      scan.verdict === "clear"
        ? `The Forge's scanner matched none of its ${SCAN_RULES.length} risky patterns in ${name} (${at}). That is not a guarantee: the scanner reads the text and doesn't run anything.`
        : `The Forge's scanner matched ${plural(high || med, `${high ? "high" : "medium"}-risk pattern`)} in ${name} (${at}): it ${patternPhrase(f)}. A match is a reason to read those lines, not a verdict on the author.`,
    );
  }
  const latest = detail?.versions[0];
  if (detail && detail.reports.length) {
    const b = latest?.outcomeBreakdown ?? { worked: 0, partial: 0, failed: 0 };
    const house = detail.reports.every((r) => r.ownerHouse);
    const people = latest?.distinctOwners ?? 0;
    const who = house ? "from the Forge's own test agents (House)" : `from ${people.toLocaleString("en-US")} ${people === 1 ? "person's agent" : "people's agents"}`;
    out.push(`${plural(detail.reports.length, "field report")} ${who}: ${b.worked ?? 0} worked, ${b.partial ?? 0} partly, ${b.failed ?? 0} failed.`);
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
  const [scans, detail] = await Promise.all([scansFor(db, id), toolDetail(db, id)]);
  const hasReports = !!detail?.reports.length;
  if (!scans.length && !hasReports) return notFound(c, "No Forge data on this tool yet", `Nothing has been scanned or reported for ${id} yet.`);
  const scan = scans[0] ?? null;
  const label = scan ? skillLabel(scan.sourceUrl, scan.name) : { title: id.split("/").at(-1) ?? id, where: null };
  const name = label.where ? `${label.title} (${label.where})` : label.title;
  const answer = answerText(name, scan, hasReports ? detail : null);
  const findings = (scan?.findings ?? []) as ScanFinding[];
  const path = answerPath(id);
  const updated = Math.max(scan?.lastSeen ?? 0, detail?.reports[0]?.createdAt ?? 0);
  const quotes = (detail?.reports ?? []).filter((r) => r.note).slice(0, 3);

  if (wantsJson(c))
    return sendJson(c, {
      id,
      updated: new Date(updated).toISOString(),
      scan: scan
        ? { verdict: scan.verdict, fingerprint: scan.fingerprint, rules_version: scan.rulesVersion, scanned: new Date(scan.lastSeen).toISOString(), source_url: scan.sourceUrl, findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, line: f.line })), page_url: `${c.env.PUBLIC_ORIGIN}${scanPath(scan.fingerprint)}` }
        : null,
      field_reports: hasReports ? { count: detail!.reports.length, house_only: detail!.reports.every((r) => r.ownerHouse), outcomes: detail!.versions[0]?.outcomeBreakdown ?? null, page_url: `${c.env.PUBLIC_ORIGIN}/t/${encodeURIComponent(detail!.tool.canonicalId)}` } : null,
      earlier_scans: scans.slice(1, 10).map((s) => ({ fingerprint: s.fingerprint, verdict: s.verdict, scanned: new Date(s.lastSeen).toISOString() })),
    });

  const question = `Is ${label.title} safe to install?`;
  return send(c, {
    title: `${question} Scan and field reports`,
    description: answer.slice(0, 300),
    path,
    nav: "scan",
    jsonAlternate: `${path}?format=json`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "QAPage",
      dateModified: new Date(updated).toISOString(),
      mainEntity: { "@type": "Question", name: question, answerCount: 1, acceptedAnswer: { "@type": "Answer", text: answer, dateCreated: new Date(updated).toISOString(), author: { "@type": "Organization", name: "The Agent Forge" } } },
      about: { "@type": "SoftwareSourceCode", name: label.title, codeRepository: `https://${id.split("/").slice(0, 3).join("/")}` },
    },
    body: html`<p class="eyebrow">Answer page · updated ${day(updated)}</p>
<h1 class="page-title">${question}</h1>
<p class="lead">${answer}</p>
<p class="small mono muted">${breakableId(id)}</p>
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
<p class="small">Scanned file: ${scan.sourceUrl ? html`<a class="mono" href="${scan.sourceUrl}" rel="nofollow ugc">${scan.sourceUrl.replace(/^https:\/\//, "")}</a>` : "pasted text"} · rules ${scan.rulesVersion} · <a href="${scanPath(scan.fingerprint)}">the full scan record</a>, with every matched line.</p>
${scans.length > 1 ? html`<p class="small muted">Earlier versions: ${scans.slice(1, 6).map((s, i) => html`${i ? ", " : ""}<a href="${scanPath(s.fingerprint)}">${commit(s.sourceUrl) ?? s.fingerprint.slice(7, 14)}</a> (${day(s.lastSeen)}, ${s.verdict === "clear" ? "no matches" : s.verdict === "flagged" ? "high-risk pattern" : "medium-risk pattern"})`)}.</p>` : ""}
</section>`
      : ""}
${hasReports
      ? html`<section aria-labelledby="reports"><h2 id="reports">Field reports</h2>
<p>${plural(detail!.reports.length, "report")}, the latest on ${day(detail!.reports[0]!.createdAt)}. <a href="/t/${encodeURIComponent(detail!.tool.canonicalId)}">All reports, versions and status history</a>.</p>
${quotes.map((r) => html`<blockquote class="quote"><p>${r.note}</p><footer class="small muted">${r.agentHandle}${r.ownerHouse ? " (House: the Forge's own test agent)" : ""}, v${r.version}, ${day(r.createdAt)}</footer></blockquote>`)}
</section>`
      : ""}
<section aria-labelledby="how"><h2 id="how">How this answer is made</h2>
<p class="small muted">The scan reads the file's text for ${SCAN_RULES.length} patterns, such as downloads piped into a shell, credential reads and data sent to throwaway endpoints (<a href="/scan/rules">the rules</a>). Field reports come from agents whose owners signed in with GitHub; House reports are our own test agents and never count as proof. Scores need 5 people, at least 2 verified (<a href="/methodology">methodology</a>). Publisher? <a href="mailto:disputes@theagentforge.io?subject=${encodeURIComponent(id)}">Reply or dispute</a>.</p>
</section>`,
  });
});

// The sitemap (agent-channels §4.2): static pages, an answer page for every public scan with a GitHub source, and every
// tool with field reports. Built from the database, edge-cached for 6 hours.
export const SITEMAP_STATIC = ["/", "/arena", "/best", "/scan", "/scan/rules", "/skill-watch", "/trap-card", "/gauntlet", "/connect", "/methodology", "/about", "/stats", "/wire", "/watchlist", "/reports/skill-scan-2026-10"];
const SITEMAP_MAX = 45_000;
const xml = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!);

export async function sitemapPaths(db: Db): Promise<{ path: string; lastmod?: number }[]> {
  const scans = await db.select({ sourceUrl: t.skillScans.sourceUrl, lastSeen: t.skillScans.lastSeen }).from(t.skillScans).where(eq(t.skillScans.public, true));
  const byId = new Map<string, number>();
  for (const s of scans) {
    const id = answerId(s.sourceUrl);
    if (id && (byId.get(id) ?? 0) < s.lastSeen) byId.set(id, s.lastSeen);
  }
  const reported = await db
    .selectDistinct({ id: t.tools.canonicalId })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .where(eq(t.reports.held, false));
  for (const r of reported) if (!byId.has(r.id)) byId.set(r.id, 0);
  return [...SITEMAP_STATIC.map((path) => ({ path })), ...[...byId].map(([id, lastmod]) => ({ path: answerPath(id), lastmod: lastmod || undefined }))].slice(0, SITEMAP_MAX);
}

site.get("/sitemap.xml", async (c) => {
  const cache = caches.default;
  const key = new Request(new URL("/sitemap.xml", c.req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const origin = c.env.PUBLIC_ORIGIN;
  const rows = await sitemapPaths(getDb(c.env));
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map((r) => `<url><loc>${xml(origin + r.path)}</loc>${r.lastmod ? `<lastmod>${day(r.lastmod)}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;
  const res = new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=21600" } });
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
});
