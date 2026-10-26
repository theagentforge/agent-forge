import { and, eq, isNotNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import type { CheckResult } from "../services/forge";
import { checkTool } from "../services/forge";
import { countsAsHouse } from "../services/identity";
import { verdictCounts } from "../services/verdicts";

// README badges for maintainers (the route is in web/badge.ts; this file has no routes, so pages.ts can import it) (ADR 0011 e; V6 maintainer badge program): an SVG and a shields.io endpoint,
// "Forge-checked v1.2.0 | 5 reports, 2 corroborated". Pinned to a version (?v=1.2.0; the newest on file without it) and
// only served for versions with counted reports, so an empty badge never ends up in someone's README.
// Counted reports: shown (not held), not our House or founder accounts, and not from an owner affiliated with the tool
// (a verified publisher claim, or the GitHub account the tool is published under), so a maintainer can't pad the
// badge. Corroborations by affiliated owners don't count either. Embeds and click-ins are counted in web/pages.ts.

export interface Badge {
  label: string;
  message: string;
  color: string;
}

export const BADGE_COLORS = { green: "#2e9e6b", amber: "#c27c0e", red: "#c43c35", grey: "#5b6573" };
const COLORS = BADGE_COLORS;

/** What the badge counts on one version, after leaving out held, House, founder and affiliated owners' reports. */
export interface BadgeCounts {
  reports: number;
  corroborated: number;
  failed: number;
}

/** The badge for one version. Null when nothing is counted, so a README never shows an empty badge. */
export function badgeFor(c: CheckResult, counts?: BadgeCounts): Badge | null {
  const n = counts ?? { reports: c.distinct_owners, corroborated: c.corroborated_reports ?? 0, failed: c.outcome_breakdown?.failed ?? 0 };
  if (!c.known || n.reports === 0) return null;
  const label = `Forge-checked${c.version ? ` v${c.version}` : ""}`;
  if (c.security_status === "confirmed_malicious") return { label, message: "confirmed malicious", color: COLORS.red };
  if (c.security_status === "flagged") return { label, message: "flagged", color: COLORS.red };
  const base = `${n.reports} ${n.reports === 1 ? "report" : "reports"}, ${n.corroborated} corroborated`;
  // The warning colour: the version has failed reports, or an advisory or review against it.
  if (c.security_status === "caution") return { label, message: `${base} · under review`, color: COLORS.amber };
  if (n.failed > 0) return { label, message: `${base} · ${n.failed} failed`, color: COLORS.amber };
  return { label, message: base, color: c.forge_score != null && c.forge_score >= 70 ? COLORS.green : COLORS.grey };
}

/** Owners affiliated with a tool: a verified publisher claim, or the GitHub account the tool is published under. */
export async function affiliatedOwners(db: Db, tool: { id: string; publisherGithub: string | null }) {
  const claims = await db.select({ h: t.publisherClaims.humanId }).from(t.publisherClaims).where(and(eq(t.publisherClaims.toolId, tool.id), isNotNull(t.publisherClaims.verifiedAt)));
  const out = new Set(claims.map((x) => x.h));
  if (tool.publisherGithub) {
    const login = tool.publisherGithub.toLowerCase();
    for (const h of await db.select({ id: t.humans.id }).from(t.humans).where(sql`lower(${t.humans.githubLogin}) = ${login}`)) out.add(h.id);
  }
  return out;
}

/** The badge's counts for one tool version (by tool id and fingerprint). */
export async function badgeCounts(env: Pick<Env, "ADMIN_GITHUB_IDS">, db: Db, canonicalId: string, fingerprint: string): Promise<BadgeCounts> {
  const tool = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, canonicalId) });
  if (!tool) return { reports: 0, corroborated: 0, failed: 0 };
  const version = await db.query.toolVersions.findFirst({ where: and(eq(t.toolVersions.toolId, tool.id), eq(t.toolVersions.fingerprint, fingerprint)) });
  if (!version) return { reports: 0, corroborated: 0, failed: 0 };
  const affiliated = await affiliatedOwners(db, tool);
  const rows = await db
    .select({ id: t.reports.id, humanId: t.reports.humanId, outcome: t.reports.outcome, isHouse: t.humans.isHouse, githubId: t.humans.githubId })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(eq(t.reports.toolVersionId, version.id), eq(t.reports.held, false)))
    .limit(1000);
  const counted = rows.filter((r) => !affiliated.has(r.humanId) && !countsAsHouse(env, r));
  const verdicts = counted.length ? await verdictCounts(env, db, counted.map((r) => r.id), affiliated) : new Map();
  return {
    reports: counted.length,
    corroborated: [...verdicts.values()].filter((v) => v.corroborated).length,
    failed: counted.filter((r) => r.outcome === "failed").length,
  };
}

/** The badge for a tool, pinned to `version` when given (null when that version has no counted reports). */
export async function toolBadge(env: Env, id: string, version?: string | null) {
  const check = await checkTool(env, version ? { id, version } : { id }).catch(() => null);
  if (!check?.known || !check.fingerprint || !check.tool) return null;
  // Pinned to a version we hold no reports for: no badge, rather than another version's numbers.
  if (version && check.version !== version) return null;
  const counts = await badgeCounts(env, getDb(env), check.tool.id, check.fingerprint);
  const badge = badgeFor(check, counts);
  return badge ? { badge, check, counts } : null;
}

/** The markdown a maintainer pastes: pinned to the version, linked to the tool page with ?from=badge. */
export const badgeMarkdown = (origin: string, canonicalId: string, version: string | null) =>
  `[![Forge-checked](${origin}/badge/${encodeURIComponent(canonicalId)}.svg${version ? `?v=${encodeURIComponent(version)}` : ""})](${origin}/t/${encodeURIComponent(canonicalId)}?from=badge)`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Rough Verdana 11px width, good enough for a flat badge. */
const width = (s: string) => Math.round(s.length * 6.6 + 10);

export function badgeSvg(b: Badge) {
  const lw = width(b.label);
  const mw = width(b.message);
  const w = lw + mw;
  const title = `${b.label}: ${b.message}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#0B0E12"/><rect x="${lw}" width="${mw}" height="20" fill="${b.color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(b.label)}</text><text x="${lw + mw / 2}" y="14">${esc(b.message)}</text></g></svg>`;
}

