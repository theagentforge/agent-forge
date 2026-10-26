import { ISSUES, MIN_OWNERS_FOR_SCORE, MIN_VERIFIED_FOR_SCORE, TOOL_ID_PATTERN, TOOL_KINDS, VERSION_PATTERN, verdictFor } from "@forge/shared";
import { and, eq, gte, inArray, ne } from "drizzle-orm";
import * as t from "../db/schema";
import { registryId } from "./registry";
import { toolPageUrl } from "./tools";
import type { Db } from "./db";

// Contribution without gating (ADR 0038). Checks stay free and unlimited for everyone; what changes is how little it
// takes to give back, and what a contributor sees in return:
// - every check result carries a pre-filled /report link and how many more reports would give the version a score;
// - the person files in one tap on the site after GitHub sign-in (no agent setup), from a draft their agent made;
// - owners see how many checks showed their reports, and alerts when a tool they reported on is flagged;
// - agents of recent contributors get a higher check limit.

/** The draft fields a /report link can carry. Everything is validated again on the page and on submit. */
export interface ReportDraft {
  tool: string;
  kind: (typeof TOOL_KINDS)[number];
  /** Empty when the tool has no version on file yet: the agent's draft, or the person, fills it in. */
  version: string;
  fp: string;
  outcome?: "worked" | "partial" | "failed";
  /** Pre-ticked problems from the agent's draft (the issues enum only); the person can change them before filing. */
  issues?: (typeof ISSUES)[number][];
  note?: string;
}

/** `issues=a,b` from a draft link: known issue names only, each once; anything else is dropped. */
export function draftIssues(v: string | undefined): (typeof ISSUES)[number][] {
  const known = new Set<string>(ISSUES);
  return [...new Set((v ?? "").split(",").map((s) => s.trim()).filter((s) => known.has(s)))] as (typeof ISSUES)[number][];
}

/**
 * The pre-filled report link. Without a version it carries only the tool, for the draft to complete; a version without
 * a fingerprint is kept for npm and PyPI ids, whose fingerprint the Forge looks up when the report is filed (ADR 0056).
 */
export function reportUrl(origin: string, d: ReportDraft | null): string | null {
  if (!d) return null;
  const q = new URLSearchParams({ tool: d.tool, kind: d.kind, ...(d.version && (d.fp || registryId(d.tool)) ? { version: d.version, ...(d.fp ? { fp: d.fp } : {}) } : {}) });
  if (d.outcome) q.set("outcome", d.outcome);
  if (d.issues?.length) q.set("issues", d.issues.join(","));
  if (d.note) q.set("note", d.note);
  return `${origin}/report?${q}`;
}

/**
 * Reads a draft from /report parameters; null when anything given is invalid. With `partial`, the version and
 * fingerprint may be missing (the page then asks for them). Filing needs a version, and a fingerprint unless the id is
 * npm: or pypi: (looked up from the registry on submit, ADR 0056).
 */
export function parseDraft(q: (k: string) => string | undefined, opts: { partial?: boolean } = {}): ReportDraft | null {
  const tool = (q("tool") ?? "").trim();
  const kind = q("kind") as ReportDraft["kind"];
  const version = (q("version") ?? "").trim();
  const fp = (q("fp") ?? "").trim();
  if (!tool || tool.length > 512 || !TOOL_ID_PATTERN.test(tool)) return null;
  if (!TOOL_KINDS.includes(kind)) return null;
  if (version && (version.length > 128 || !VERSION_PATTERN.test(version))) return null;
  if (fp && (!version || !/^sha256:[0-9a-f]{64}$/.test(fp))) return null;
  if (!opts.partial && (!version || (!fp && !registryId(tool)))) return null;
  const outcome = q("outcome");
  const note = (q("note") ?? "").trim().slice(0, 280);
  const issues = draftIssues(q("issues"));
  return {
    tool,
    kind,
    version,
    fp,
    ...(outcome === "worked" || outcome === "partial" || outcome === "failed" ? { outcome } : {}),
    ...(issues.length ? { issues } : {}),
    ...(note ? { note } : {}),
  };
}

/** How many more people (and verified people) must report before the version gets a Forge Score; 0 once it has one. */
export function reportsNeeded(distinctOwners: number, verifiedOwners: number, scored: boolean) {
  if (scored) return { people: 0, verified: 0 };
  const verified = Math.max(0, MIN_VERIFIED_FOR_SCORE - verifiedOwners);
  return { people: Math.max(verified, MIN_OWNERS_FOR_SCORE - distinctOwners), verified };
}

/** A contributor: a person outside the House with a counted report in the last 30 days. */
export const CONTRIBUTOR_WINDOW_MS = 30 * 86_400_000;
const CONTRIBUTOR_CACHE_SECONDS = 3600;

export async function isContributor(env: Env, db: Db, humanId: string, now = Date.now()) {
  const key = `contrib:${humanId}`;
  const cached = await env.KV.get(key);
  if (cached === "1" || cached === "0") return cached === "1";
  const row = await db.query.reports.findFirst({
    columns: { id: true },
    where: and(eq(t.reports.humanId, humanId), eq(t.reports.held, false), ne(t.reports.moderationState, "rejected"), gte(t.reports.createdAt, now - CONTRIBUTOR_WINDOW_MS)),
  });
  const yes = !!row;
  // A "yes" is kept for an hour; a "no" for a minute, so a first report counts almost at once.
  await env.KV.put(key, yes ? "1" : "0", { expirationTtl: yes ? CONTRIBUTOR_CACHE_SECONDS : 60 });
  return yes;
}

/** Forgets the cached answer, so a report just filed counts at once. */
export const forgetContributor = (env: Env, humanId: string) => env.KV.delete(`contrib:${humanId}`);

/**
 * Alerts for an owner: tools they reported on that now have a version flagged, under review or confirmed malicious.
 * Read from the same score rows every check uses; nothing is sent anywhere.
 */
export async function reportAlerts(db: Db, origin: string, humanId: string) {
  const mine = await db
    .selectDistinct({ toolId: t.tools.id, canonical: t.tools.canonicalId })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .where(eq(t.reports.humanId, humanId))
    .limit(90);
  if (!mine.length) return [];
  const flagged = await db
    .select({ toolId: t.toolVersions.toolId, version: t.toolVersions.version, status: t.toolScores.securityStatus })
    .from(t.toolScores)
    .innerJoin(t.toolVersions, eq(t.toolScores.toolVersionId, t.toolVersions.id))
    .where(and(inArray(t.toolVersions.toolId, mine.map((m) => m.toolId)), ne(t.toolScores.securityStatus, "clear")));
  return flagged.map((f) => {
    const tool = mine.find((m) => m.toolId === f.toolId)!;
    return { tool_id: tool.canonical, version: f.version, security_status: verdictFor(f.status), page_url: toolPageUrl(origin, tool.canonical) };
  });
}
