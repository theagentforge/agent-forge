import {
  displayVerdict,
  reportSchema,
  TOOL_ID_PATTERN,
  scanNote,
  scoreToolVersion,
  TOOL_KINDS,
  verdictFor,
  type CheckQuery,
  type CheckSecurity,
  type CheckVerdict,
  type DisplayVerdict,
  type HumanTier,
  type Report,
  type ScoredReport,
  type SecurityStatus,
} from "@forge/shared";
import { and, count, countDistinct, desc, eq, gte, like, ne, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { osvPackageFor, queryAdvisories, recordAdvisories, type AdvisoryResult } from "./advisories";
import { kevState, markExploited } from "./kev";
import { forgetContributor, isContributor, reportAlerts, reportsNeeded, reportUrl, type ReportDraft } from "./contribute";
import { getDb, newId, type Db } from "./db";
import { canParticipate } from "./access";
import { liveAgentCounts, outsidePeople } from "./agent-funnel";
import { grossJson, grossNumbers, publicTotals, STATS_RULES_VERSION } from "./public-stats";
import { type WorkTotals } from "./site-pulse";
import { publicNumbers } from "./public-numbers";
import { countsAsHouse, vouchesRemaining } from "./identity";
import { bump } from "./usage";
import { withRegistryFingerprint } from "./registry";
import { reportsWithVerdicts, saveVerdict, verdictTarget, type VerdictCounts, type VerdictRejection } from "./verdicts";
import { moderateWithinBudget } from "./moderation";
import type { AgentProps } from "./props";
import { shownInChecks } from "./feedback";
import { signReport } from "./signing";
import { sinceLastWeek } from "./digest";
import { canonicalFromUrl, canonicalToolId, publisherFromId, splitInlineVersion, toolPageUrl, versionFromUrl } from "./tools";

// The three agent operations (MASTER_PLAN §10.5). Responses are structured data only, never peer prose.

export interface CheckResult {
  known: boolean;
  tool: { kind: string; id: string } | null;
  version: string | null;
  fingerprint: string | null;
  forge_score: number | null;
  /** Distinct people (any tier) whose agents reported on this version. */
  distinct_owners: number;
  /** How many of them are verified. */
  verified_owners: number;
  /** Share of people whose latest report saw a retry loop (§6.10); null until enough reports. */
  loop_rate: number | null;
  recovers_after_reset_rate: number | null;
  /** Reports with strain counts, and how many were counted by the Claude Code plugin. */
  strain_reports: number;
  strain_hook_reports: number;
  outcome_breakdown: { worked: number; partial: number; failed: number };
  /** A verdict, or "unknown": a tool we don't know with no published advisory (crisis-wave plan C2). */
  security_status: CheckSecurity;
  /**
   * Other versions of this tool that are under review, flagged or confirmed malicious. When the newest version has no
   * score of its own, the worst of these sets security_status, so a fresh unscored version can't hide a flagged one.
   */
  other_versions_flagged: { version: string; security_status: CheckVerdict }[];
  /**
   * Published advisories from OSV for npm and PyPI packages, or null when there's no package to look up or OSV
   * couldn't be reached. Identifiers only: ids, aliases, fixed versions, dates and links (never advisory text).
   */
  public_signals_summary: AdvisoryResult | null;
  page_url: string | null;
  /** The version the agent asked about (from `version`, the id or the URL); `version` is the one the reports are on. */
  asked_version?: string;
  /** Field reports on this exact version (any tier). */
  reports_for_this_version: number;
  /** True when no one has reported on this version yet: a report from this agent would be the first (ADR 0011 g). */
  be_first: boolean;
  /**
   * The one-word answer, as the site shows it: "insufficient" until a version has a Forge Score (also for tools we
   * don't know), then "clear", "caution", "flagged" or "confirmed_malicious". security_status alone says only whether
   * anything is flagged, so "clear" there never means "checked and fine" (issue: unknown tools read as clear).
   */
  verdict: DisplayVerdict;
  /**
   * Where a field report on this tool goes: data only (MASTER_PLAN §6.8). Agents whose owner has signed in use the
   * forge_report tool; anyone else's person can file at report_url after GitHub sign-in (ADR 0038). reports_needed is
   * how many more people, and verified people, would give this version a Forge Score.
   */
  contribute: {
    tool: "forge_report";
    mcp_server: string;
    auth: "github_oauth";
    human_verified: true;
    report_url?: string | null;
    reports_needed?: { people: number; verified: number };
  };
  /**
   * V1 (ADR 0047): the newest field reports on this exact version, by report_id, so an agent that used the same
   * version can confirm or dispute one (forge_report with on_report). Verdicts are counted by distinct verified owners.
   */
  reports: { report_id: string; outcome: "worked" | "partial" | "failed"; created_at: string; verdicts: VerdictCounts }[];
  /** Reports on this version confirmed by at least 2 distinct other owners (and more confirms than disputes). */
  corroborated_reports: number;
  /** For a tool we don't know: up to 5 known tools whose id contains the asked name, so a bare name isn't a dead end. */
  candidates?: { id: string; page_url: string }[];
}

export const contributeFor = (origin: string) =>
  ({ tool: "forge_report", mcp_server: `${origin}/mcp`, auth: "github_oauth", human_verified: true }) as const;

/** The searchable part of an id: "npm:@scope/name" → "name", "github.com/owner/repo" → "repo". */
export function nameTerm(asked: string): string | null {
  const parts = asked
    .toLowerCase()
    .replace(/^(npm|pypi|mcp-registry):/, "")
    .replace(/^https?:\/\//, "")
    .split(/[/@]/)
    .filter(Boolean);
  const term = parts.filter((p) => !["github.com", "tree", "main", "blob", "src", "www.npmjs.com", "package"].includes(p)).pop() ?? "";
  const clean = term.replace(/[^a-z0-9._-]/g, "");
  return clean.length >= 3 ? clean : null;
}

/** Up to 5 known tools whose id or alias contains the term. Never throws. */
export async function toolCandidates(db: Db, origin: string, term: string | null) {
  if (!term) return [];
  try {
    const pat = `%${term}%`; // term holds only [a-z0-9._-]; "_" matching any one character is harmless here
    const rows = await db
      .selectDistinct({ id: t.tools.canonicalId })
      .from(t.tools)
      .leftJoin(t.toolAliases, eq(t.toolAliases.toolId, t.tools.id))
      .where(or(like(t.tools.canonicalId, pat), like(t.toolAliases.alias, pat)))
      // Shortest ids first: the package itself ("npm:@upstash/context7-mcp") before forks and wrappers.
      .orderBy(sql`length(${t.tools.canonicalId})`, t.tools.canonicalId)
      .limit(5);
    return rows.map((r) => ({ id: r.id, page_url: toolPageUrl(origin, r.id) }));
  } catch {
    return [];
  }
}

const STATUS_RANK: Record<SecurityStatus, number> = { clear: 0, under_review: 1, flagged: 2, confirmed_malicious: 3 };

const EMPTY_BREAKDOWN = { worked: 0, partial: 0, failed: 0 };

/** Finds a tool by its canonical id or any alias (npm package, GitHub repo, MCP Registry name). */
export async function findTool(db: Db, canonicalId: string) {
  const direct = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, canonicalId) });
  if (direct) return direct;
  const alias = await db.query.toolAliases.findFirst({ where: eq(t.toolAliases.alias, canonicalId) });
  return alias ? db.query.tools.findFirst({ where: eq(t.tools.id, alias.toolId) }) : undefined;
}

/**
 * Published advisories for a check (crisis-wave plan P1):
 * - with a version: a malicious-package (MAL-) record for it is "flagged"; any other advisory for it is "under review"
 *   (shown as caution);
 * - without one: a malicious record for any version is "under review", since the version in use may be the bad one;
 * - never "confirmed_malicious", which stays a human decision.
 */
export function advisoryStatus(r: AdvisoryResult | null): SecurityStatus | null {
  if (!r || !r.advisories.length) return null;
  const malicious = r.advisories.some((a) => a.kind === "malicious");
  if (r.version) return malicious ? "flagged" : "under_review";
  return malicious ? "under_review" : null;
}

/** The most serious of two statuses. */
const worse = (a: SecurityStatus, b: SecurityStatus | null) => (b && STATUS_RANK[b] > STATUS_RANK[a] ? b : a);

async function advisoriesFor(env: Env, ids: string[], version: string | null) {
  const pkg = ids.map(osvPackageFor).find((p) => p);
  if (!pkg) return null;
  // Marked on every check, not cached with the OSV answer, so a new KEV entry shows the day it's listed (C3). Both
  // reads run at once (ADR 0056).
  const [r, kev] = await Promise.all([queryAdvisories(env, pkg, version), kevState(env)]);
  return r ? markExploited(r, kev.ids, kev.updated) : null;
}

export async function checkTool(env: Env, asked: CheckQuery): Promise<CheckResult> {
  const db = getDb(env);
  // A version written into the id or the registry URL counts as the version asked about (24 Oct production check).
  let q = asked;
  if (!q.version && q.id) {
    const split = splitInlineVersion(q.id);
    if (split.version) q = { ...q, id: split.id, version: split.version };
  } else if (!q.version && q.url) {
    const v = versionFromUrl(q.url);
    if (v) q = { ...q, version: v };
  }
  let version: typeof t.toolVersions.$inferSelect | undefined;
  let tool: typeof t.tools.$inferSelect | undefined;
  let canonical: string | null = null;

  if (q.fingerprint) {
    version = await db.query.toolVersions.findFirst({
      where: eq(t.toolVersions.fingerprint, q.fingerprint),
      orderBy: desc(t.toolVersions.firstSeenAt),
    });
    if (version) tool = await db.query.tools.findFirst({ where: eq(t.tools.id, version.toolId) });
  } else {
    canonical = q.id ? canonicalToolId(q.id) : canonicalFromUrl(q.url!);
    tool = await findTool(db, canonical);
    // The version asked about, when reports exist for it; otherwise the newest on file (asked_version says which).
    if (tool && q.version)
      version = await db.query.toolVersions.findFirst({
        where: and(eq(t.toolVersions.toolId, tool.id), eq(t.toolVersions.version, q.version)),
        orderBy: desc(t.toolVersions.firstSeenAt),
      });
    if (tool && !version)
      version = await db.query.toolVersions.findFirst({
        where: eq(t.toolVersions.toolId, tool.id),
        orderBy: desc(t.toolVersions.firstSeenAt),
      });
  }

  if (!tool) {
    const [advisories, candidates] = await Promise.all([
      canonical ? advisoriesFor(env, [canonical], q.version ?? null) : null,
      toolCandidates(db, env.PUBLIC_ORIGIN, canonical ? nameTerm(canonical) : null),
    ]);
    const status = advisoryStatus(advisories);
    return {
      known: false,
      tool: null,
      ...(q.version ? { asked_version: q.version } : {}),
      version: q.version ?? null,
      fingerprint: q.fingerprint ?? null,
      forge_score: null,
      distinct_owners: 0,
      verified_owners: 0,
      loop_rate: null,
      recovers_after_reset_rate: null,
      strain_reports: 0,
      strain_hook_reports: 0,
      outcome_breakdown: EMPTY_BREAKDOWN,
      // Nothing known about it: "unknown", never "clear" (crisis-wave plan, 23 Oct), unless an advisory says more.
      security_status: status ? verdictFor(status) : "unknown",
      other_versions_flagged: [],
      public_signals_summary: advisories,
      page_url: null,
      reports_for_this_version: 0,
      be_first: true,
      verdict: status ? verdictFor(status) : "insufficient",
      // ADR 0056: a tool not on file can still get its first report (it is added when the report is filed).
      contribute: {
        ...contributeFor(env.PUBLIC_ORIGIN),
        ...(canonical && TOOL_ID_PATTERN.test(canonical) ? { report_url: reportUrl(env.PUBLIC_ORIGIN, { tool: canonical, kind: canonical.startsWith("pypi:") ? "api" : "mcp_server", version: q.version ?? "", fp: "" }) } : {}),
        reports_needed: reportsNeeded(0, 0, false),
      },
      reports: [],
      corroborated_reports: 0,
      candidates,
    };
  }

  // Independent reads, sent together (ADR 0056: each D1 round trip added to every check).
  const [score, others, aliasRows] = await Promise.all([
    version ? db.query.toolScores.findFirst({ where: eq(t.toolScores.toolVersionId, version.id) }) : undefined,
    q.fingerprint
      ? []
      : db
          .select({ id: t.toolVersions.id, version: t.toolVersions.version, status: t.toolScores.securityStatus })
          .from(t.toolScores)
          .innerJoin(t.toolVersions, eq(t.toolScores.toolVersionId, t.toolVersions.id))
          .where(and(eq(t.toolVersions.toolId, tool.id), ne(t.toolScores.securityStatus, "clear")))
          .limit(20),
    db.select({ alias: t.toolAliases.alias }).from(t.toolAliases).where(eq(t.toolAliases.toolId, tool.id)).limit(20),
  ]);
  const otherFlagged = others
    .filter((o) => o.id !== version?.id)
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
  const breakdown = score?.outcomeBreakdown ?? EMPTY_BREAKDOWN;
  const reportCount = breakdown.worked + breakdown.partial + breakdown.failed;
  const ownStatus = score?.securityStatus ?? "clear";
  const inherited = ownStatus === "clear" && score?.successScore == null ? otherFlagged[0]?.status : undefined;
  const aliases = aliasRows.map((a) => a.alias);
  const onAsked = !(q.version && version?.version !== q.version);
  const [advisories, listed] = await Promise.all([
    advisoriesFor(env, [tool.canonicalId, ...aliases], q.version ?? version?.version ?? null).then(async (a) => {
      if (a) await recordAdvisories(db, tool.id, a).catch(() => {});
      return a;
    }),
    version && onAsked && reportCount ? reportsWithVerdicts(env, db, version.id, 100) : [],
  ]);
  const status = worse(inherited ?? ownStatus, advisoryStatus(advisories));
  return {
    known: true,
    tool: { kind: tool.kind, id: tool.canonicalId },
    ...(q.version ? { asked_version: q.version } : {}),
    version: version?.version ?? null,
    fingerprint: version?.fingerprint ?? null,
    forge_score: score?.successScore ?? null,
    distinct_owners: score?.distinctOwners ?? 0,
    verified_owners: score?.verifiedOwners ?? 0,
    loop_rate: score?.loopRate ?? null,
    recovers_after_reset_rate: score?.recoversAfterResetRate ?? null,
    strain_reports: score?.strainReports ?? 0,
    strain_hook_reports: score?.strainHookReports ?? 0,
    outcome_breakdown: score?.outcomeBreakdown ?? EMPTY_BREAKDOWN,
    security_status: verdictFor(status),
    other_versions_flagged: otherFlagged.map((o) => ({ version: o.version, security_status: verdictFor(o.status) })),
    public_signals_summary: advisories,
    page_url: toolPageUrl(env.PUBLIC_ORIGIN, tool.canonicalId),
    reports_for_this_version: q.version && version?.version !== q.version ? 0 : reportCount,
    be_first: q.version && version?.version !== q.version ? true : reportCount === 0,
    contribute: {
      ...contributeFor(env.PUBLIC_ORIGIN),
      // The version asked about when it isn't on file yet (its fingerprint is looked up on filing for npm and PyPI).
      report_url: reportUrl(env.PUBLIC_ORIGIN, { tool: tool.canonicalId, kind: TOOL_KINDS.includes(tool.kind as never) ? (tool.kind as ReportDraft["kind"]) : "mcp_server", ...(onAsked ? { version: version?.version ?? q.version ?? "", fp: version?.fingerprint ?? "" } : { version: q.version!, fp: "" }) }),
      reports_needed: reportsNeeded(score?.distinctOwners ?? 0, score?.verifiedOwners ?? 0, score?.successScore != null),
    },
    verdict: displayVerdict({ security_status: verdictFor(status), forge_score: score?.successScore ?? null }),
    reports: listed.slice(0, 20),
    corroborated_reports: listed.filter((r) => r.verdicts.corroborated).length,
  };
}

export type ReportRejection =
  | "invalid_report"
  | "agent_inactive"
  | "invite_only"
  | "rate_limited"
  | "note_contains_credential"
  | "note_contains_file_path"
  | "note_contains_link"
  | "publisher_cannot_report_own_tool"
  | VerdictRejection;

export type ReportResult =
  | {
      ok: true;
      report_id: string;
      page_url: string;
      counted: boolean;
      reason: "counted" | "sandbox_reduced_weight" | "held_for_review";
      note_status: "none" | "published" | "pending_moderation" | "removed_by_moderation";
      /** V1: the verdict this report recorded on another report, when `on_report` was given. */
      verdict?: { on_report: string; verdict: "confirm" | "dispute"; replaced: boolean; counted: boolean };
    }
  | { ok: false; counted: false; reason: ReportRejection; detail?: string; field?: string };

/** Resolves the agent behind a grant, or null when it was revoked or never existed. */
export async function activeAgent(db: Db, props: AgentProps) {
  const agent = await db.query.agents.findFirst({ where: eq(t.agents.id, props.agentId) });
  if (!agent || agent.status !== "active" || agent.humanId !== props.humanId) return null;
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, agent.humanId) });
  return human ? { agent, human } : null;
}

export async function submitReport(env: Env, props: AgentProps, input: unknown, now = Date.now()): Promise<ReportResult> {
  // ADR 0056: an npm or PyPI version's fingerprint is looked up when the report leaves it out.
  const parsed = reportSchema.safeParse(await withRegistryFingerprint(env, input));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, counted: false, reason: "invalid_report", detail: issue?.message, ...(issue?.path.length ? { field: issue.path.join(".") } : {}) };
  }
  const report: Report = parsed.data;
  const db = getDb(env);

  const who = await activeAgent(db, props);
  if (!who) return { ok: false, counted: false, reason: "agent_inactive" };
  if (!canParticipate(env, who.human)) return { ok: false, counted: false, reason: "invite_only" };

  const [agentLimit, humanLimit] = await Promise.all([
    env.REPORT_LIMITER.limit({ key: `agent:${who.agent.id}` }),
    env.REPORT_LIMITER.limit({ key: `human:${who.human.id}` }),
  ]);
  if (!agentLimit.success || !humanLimit.success) return { ok: false, counted: false, reason: "rate_limited" };

  if (report.note) {
    const rejection = scanNote(report.note);
    if (rejection) return { ok: false, counted: false, reason: `note_contains_${rejection}` };
  }

  const canonicalId = canonicalToolId(report.tool.id);
  const known = await findTool(db, canonicalId);
  const owners = [known?.publisherGithub, publisherFromId(canonicalId)].filter((o): o is string => !!o);
  if (owners.some((o) => o === props.githubLogin.toLowerCase() || props.githubOrgs.includes(o))) {
    return { ok: false, counted: false, reason: "publisher_cannot_report_own_tool" };
  }

  // V1: a verdict on another report is checked before anything is stored, so a refused verdict files nothing.
  const target = await verdictTarget(db, who, report, { toolId: known?.id ?? null, fingerprint: report.tool.fingerprint });
  if (typeof target === "string") return { ok: false, counted: false, reason: target };

  const tool = known ?? (await upsertTool(db, canonicalId, report.tool.kind, publisherFromId(canonicalId)));
  const version = await upsertToolVersion(db, tool.id, report.tool.version, report.tool.fingerprint, now);

  let noteState: (typeof t.reports.$inferInsert)["moderationState"] = "none";
  let note: string | null = null;
  if (report.note && who.human.isHouse && HOUSE_TESTER_NOTE.test(report.note)) {
    // The House tester's notes come from one fixed template in our own code (integrations/house/file.mjs), so they
    // don't spend the shared AI moderation budget (ADR 0011 b: ~500 a night).
    noteState = "approved";
    note = report.note;
  } else if (report.note) {
    noteState = await moderateWithinBudget(env, report.note, now);
    // A note the model rejects is dropped; the structured report still counts.
    note = noteState === "rejected" ? null : report.note;
  }

  const held = await isAnomalous(db, version.id, who.human, now);
  const st = report.strain;
  const id = newId();
  const fields = {
    id,
    agentId: who.agent.id,
    humanId: who.human.id,
    toolVersionId: version.id,
    taskCategory: report.task.category,
    framework: report.task.framework,
    outcome: report.outcome,
    issues: report.issues,
    note,
    moderationState: noteState,
    createdAt: now,
    held,
    strainSource: st?.source ?? null,
    strainAttempts: st?.attempts ?? null,
    strainToolErrors: st?.tool_errors ?? null,
    strainRetries: st?.retries ?? null,
    strainLoopDetected: st?.loop_detected ?? null,
    strainContextReset: st?.context_reset ?? null,
    strainOutcomeAfterReset: st?.outcome_after_reset ?? null,
    strainEscalated: st?.escalated_to_human ?? null,
  };
  await db.insert(t.reports).values({ ...fields, serverSignature: await signReport(env.REPORT_SIGNING_KEY, fields) });
  await rescoreToolVersion(db, version, now);
  if (!held) await forgetContributor(env, who.human.id);
  let verdict: Extract<ReportResult, { ok: true }>["verdict"];
  if (target && report.verdict) {
    const saved = await saveVerdict(db, { reportId: target.id, byReportId: id, agentId: who.agent.id, humanId: who.human.id, verdict: report.verdict, evidenceSha256: report.evidence_sha256 ?? null }, now);
    const counted = !held && !countsAsHouse(env, who.human);
    verdict = { on_report: target.id, verdict: report.verdict, replaced: saved.replaced, counted };
    if (counted) await bump(env, [`verdict:${report.verdict}`], now).catch(() => {});
  }

  return {
    ok: true,
    report_id: id,
    page_url: toolPageUrl(env.PUBLIC_ORIGIN, tool.canonicalId),
    counted: !held,
    reason: held ? "held_for_review" : who.human.tier === "verified" ? "counted" : "sandbox_reduced_weight",
    note_status: !report.note
      ? "none"
      : noteState === "approved"
        ? "published"
        : noteState === "pending"
          ? "pending_moderation"
          : "removed_by_moderation",
    ...(verdict ? { verdict } : {}),
  };
}

async function upsertTool(db: Db, canonicalId: string, kind: string, publisher: string | null) {
  const known = await findTool(db, canonicalId);
  if (known) return known;
  await db
    .insert(t.tools)
    .values({ id: newId(), kind, canonicalId, publisherGithub: publisher })
    .onConflictDoNothing({ target: t.tools.canonicalId });
  return (await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, canonicalId) }))!;
}

async function upsertToolVersion(db: Db, toolId: string, version: string, fingerprint: string, now: number) {
  await db
    .insert(t.toolVersions)
    .values({ id: newId(), toolId, version, fingerprint, firstSeenAt: now })
    .onConflictDoNothing({ target: [t.toolVersions.toolId, t.toolVersions.fingerprint] });
  return (await db.query.toolVersions.findFirst({
    where: and(eq(t.toolVersions.toolId, toolId), eq(t.toolVersions.fingerprint, fingerprint)),
  }))!;
}

/** Recomputes the score for one tool version and records any security status change publicly. */
export async function rescoreToolVersion(db: Db, version: typeof t.toolVersions.$inferSelect, now: number) {
  const rows = await db
    .select({
      humanId: t.reports.humanId,
      humanTier: t.humans.tier,
      verifiedVia: t.humans.verifiedVia,
      outcome: t.reports.outcome,
      issues: t.reports.issues,
      createdAt: t.reports.createdAt,
      strainSource: t.reports.strainSource,
      strainLoopDetected: t.reports.strainLoopDetected,
      strainContextReset: t.reports.strainContextReset,
      strainOutcomeAfterReset: t.reports.strainOutcomeAfterReset,
    })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(eq(t.reports.toolVersionId, version.id), eq(t.reports.held, false)));

  const scored: ScoredReport[] = rows.map((r) => ({
    humanId: r.humanId,
    humanTier: r.humanTier as HumanTier,
    canFlag: r.verifiedVia === "approval" || r.verifiedVia === "vouch",
    isPublisher: false, // publishers are refused before a report is stored
    fingerprint: version.fingerprint,
    outcome: r.outcome,
    issues: r.issues as ScoredReport["issues"],
    createdAt: r.createdAt,
    strain: r.strainSource
      ? {
          source: r.strainSource,
          loop_detected: r.strainLoopDetected ?? false,
          context_reset: r.strainContextReset ?? false,
          outcome_after_reset: r.strainOutcomeAfterReset ?? "none",
        }
      : null,
  }));
  const s = scoreToolVersion(version.fingerprint, scored, {
    now,
    advisoryMatch: version.advisoryMatch,
    confirmedMalicious: version.confirmedMalicious,
  });

  const previous = await db.query.toolScores.findFirst({ where: eq(t.toolScores.toolVersionId, version.id) });
  const row = {
    toolVersionId: version.id,
    distinctOwners: s.distinctOwners,
    verifiedOwners: s.verifiedOwners,
    successScore: s.successScore,
    loopRate: s.loopRate,
    recoversAfterResetRate: s.recoversAfterResetRate,
    strainReports: s.strainReports,
    strainHookReports: s.strainHookReports,
    outcomeBreakdown: s.outcomeBreakdown,
    securityStatus: s.securityStatus,
    updatedAt: now,
  };
  await db.insert(t.toolScores).values(row).onConflictDoUpdate({ target: t.toolScores.toolVersionId, set: row });

  const from: SecurityStatus = previous?.securityStatus ?? "clear";
  if (from !== s.securityStatus) {
    await db.insert(t.statusEvents).values({
      id: newId(),
      toolVersionId: version.id,
      fromStatus: from,
      toStatus: s.securityStatus,
      reason: "field_reports",
      createdAt: now,
    });
    await db.insert(t.auditLog).values({
      id: newId(),
      actor: "system:scoring",
      action: "security_status_changed",
      target: version.id,
      detail: { from, to: s.securityStatus },
      createdAt: now,
    });
  }
  return s;
}

/** The House tester's note template (integrations/house/file.mjs `toReport`). */
export const HOUSE_TESTER_NOTE =
  /^House handshake test: (started with (npx|uvx), no credentials, and listed \d{1,4} tools? in \d{1,4}s\.|started and answered initialize, but tools\/list failed\.|(npx|uvx) could not install this version\.)$/;

export async function describeMe(env: Env, props: AgentProps, input: { watch?: unknown; gauntlet_ids?: unknown } = {}) {
  const db = getDb(env);
  const who = await activeAgent(db, props);
  if (!who) return null;
  const recent = await db
    .select({
      report_id: t.reports.id,
      tool_ref: t.tools.id,
      tool_id: t.tools.canonicalId,
      version: t.toolVersions.version,
      outcome: t.reports.outcome,
      created_at: t.reports.createdAt,
    })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .where(eq(t.reports.agentId, who.agent.id))
    .orderBy(desc(t.reports.createdAt))
    .limit(10);
  const shown = await shownInChecks(db, recent.map((r) => ({ id: r.report_id, toolId: r.tool_ref, createdAt: r.created_at })));
  return {
    agent: {
      handle: who.agent.handle,
      framework: who.agent.framework,
      created_at: who.agent.createdAt,
      owner_github: who.human.githubLogin,
    },
    human_tier: who.human.tier,
    verified_via: who.human.verifiedVia,
    vouches_remaining: who.human.tier === "verified" ? await vouchesRemaining(db, who.human.id) : 0,
    scout_points: who.agent.scoutPoints,
    recent_reports: recent.map(({ tool_ref, ...r }) => ({ ...r, shown_in_checks: shown.get(r.report_id) ?? 0, created_at: new Date(r.created_at).toISOString() })),
    /** Feedback, not points: checks of these tools since each report was filed (each check shows the report). */
    recent_reports_shown_in_checks: [...shown.values()].reduce((a, n) => a + n, 0),
    /** ADR 0038: tools this agent's owner reported on that now have a version flagged or under review. */
    alerts: await reportAlerts(db, env.PUBLIC_ORIGIN, who.human.id),
    /** ADR 0038: a counted report in the last 30 days raises this agent's check limit. */
    contributor: await isContributor(env, db, who.human.id),
    /** V5: what changed in the last 7 days (data only; watched fingerprints and Gauntlet ids come from the agent). */
    since_last_week: await sinceLastWeek(env, db, { agentId: who.agent.id, humanId: who.human.id }, input),
  };
}

/**
 * Public headline numbers (ADR 0003): everyone outside the project counts, sandbox included. ADR 0023 §3: House
 * accounts are never counted, and each number is null (listed in `below_minimum`) until it reaches its minimum.
 * `tools` is a registry fact (every tool with a page, including tools seeded from public sources), not usage.
 */
/** The /api/v1/stats fields that counted outside people only (F-02): always null now. */
export const OUTSIDE_ONLY_STATS = ["humans", "verified_humans", "agents", "reports", "reports_last_24h", "tool_versions_reported"] as const;

export async function publicStats(
  env: Env,
  now = Date.now(),
  pre?: Promise<[WorkTotals | null, Awaited<ReturnType<typeof liveAgentCounts>> | null]>,
) {
  // ADR 0116: the totals come from the one snapshot every public page reads (tools is its tools_tracked).
  const [gross, [work, live]] = await Promise.all([
    grossNumbers(env, now).catch(() => null),
    pre ?? publicNumbers(env, now).then((n) => [n.work, n.live] as const),
  ]);
  // Review of ADR 0116: null (not 0) when the count could not be read, or there are none yet.
  const tools = work?.tools_tracked ?? null;
  return {
    /**
     * F-02 (Dinike, 28 Oct; ADR 0082): these counted people, agents and reports outside the project only, so they are
     * internal now (/admin/kpis). Always null, kept so existing readers don't break; the gross twins are in `gross`.
     */
    humans: null,
    verified_humans: null,
    agents: null,
    reports: null,
    reports_last_24h: null,
    tool_versions_reported: null,
    below_minimum: [] as never[],
    minimums: {},
    /** Every tool with a page, including tools seeded from public sources (a registry fact, not usage). */
    tools,
    /** F-02: signed-in people and agents, AI tool calls and skill scans in 7 days, our own included. */
    gross: grossJson(gross, env.PUBLIC_ORIGIN),
    /**
     * ADR 0067 Amendment 1: no longer public. Always null (the outside-only active-owner count is on /admin/kpis).
     * Kept so existing readers don't break.
     */
    active_owners_30d: null,
    /**
     * ADR 0067 Amendment 1: the outside-only headline is internal now. Always an empty array (kept, not removed, so
     * clients that iterate it or check its type keep working).
     */
    third_party: [] as never[],
    /** ADR 0067 Amendment 1: the public live totals, our own test agents included (`includes_own_test_agents`). */
    totals: publicTotals(work, live, env.PUBLIC_ORIGIN),
    internal_only: ["third_party", "active_owners_30d", ...OUTSIDE_ONLY_STATS],
    /** F-02: no public number leaves our own accounts out any more; every one includes them. */
    house_excluded: false,
    founders_excluded: false,
    rules_version: STATS_RULES_VERSION,
    rules_url: `${env.PUBLIC_ORIGIN}/stats/rules`,
    stats_json: `${env.PUBLIC_ORIGIN}/stats.json`,
    generated_at: new Date(now).toISOString(),
  };
}

/** The raw outside-only counts (House and founders left out). Internal since F-02: never sent to a public page or API. */
export async function publicCounts(env: Env, now = Date.now()) {
  const db = getDb(env);
  const one = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const dayAgo = now - 86_400_000;
  // ADR 0067: House and founder accounts are ours; reports count only when people can read them (not held or rejected).
  const outside = outsidePeople(env);
  const reportsBy = () => db.select({ n: count() }).from(t.reports).innerJoin(t.humans, eq(t.reports.humanId, t.humans.id));
  const readable = and(eq(t.reports.held, false), ne(t.reports.moderationState, "rejected"));
  const [humans, verified, agents, reports, reports24h, tools, toolsReported] = await Promise.all([
    one(db.select({ n: count() }).from(t.humans).where(outside)),
    one(db.select({ n: count() }).from(t.humans).where(and(outside, eq(t.humans.tier, "verified")))),
    one(db.select({ n: count() }).from(t.agents).innerJoin(t.humans, eq(t.agents.humanId, t.humans.id)).where(and(outside, eq(t.agents.status, "active")))),
    one(reportsBy().where(and(outside, readable))),
    one(reportsBy().where(and(outside, readable, gte(t.reports.createdAt, dayAgo)))),
    one(db.select({ n: count() }).from(t.tools)),
    one(
      db
        .select({ n: countDistinct(t.reports.toolVersionId) })
        .from(t.reports)
        .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
        .where(outside),
    ),
  ]);
  return {
    humans,
    verified_humans: verified,
    agents,
    reports,
    reports_last_24h: reports24h,
    /** Tool versions at least one agent outside the project has reported on. */
    tool_versions_reported: toolsReported,
    tools,
  };
}

/** Anomaly holds (MASTER_PLAN §6.6): a burst of reports from brand-new accounts on one version is held for review. */
export const NEW_ACCOUNT_MS = 86_400_000;
export const BURST_WINDOW_MS = 3_600_000;
export const BURST_THRESHOLD = 5;

async function isAnomalous(db: Db, toolVersionId: string, human: typeof t.humans.$inferSelect, now: number) {
  const isNew = (h: { createdAt: number; tier: string }) => now - h.createdAt < NEW_ACCOUNT_MS && h.tier === "sandbox";
  if (!isNew(human)) return false;
  const recent = await db
    .select({ humanId: t.reports.humanId, createdAt: t.humans.createdAt, tier: t.humans.tier })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(eq(t.reports.toolVersionId, toolVersionId), gte(t.reports.createdAt, now - BURST_WINDOW_MS)));
  const newcomers = new Set(recent.filter(isNew).map((r) => r.humanId));
  newcomers.add(human.id);
  return newcomers.size >= BURST_THRESHOLD;
}
