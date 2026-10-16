import {
  reportSchema,
  scanNote,
  scoreToolVersion,
  verdictFor,
  type CheckQuery,
  type CheckVerdict,
  type HumanTier,
  type Report,
  type ScoredReport,
  type SecurityStatus,
} from "@forge/shared";
import { and, count, desc, eq, gte, ne } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, newId, type Db } from "./db";
import { canParticipate } from "./access";
import { vouchesRemaining } from "./identity";
import { moderateWithinBudget } from "./moderation";
import type { AgentProps } from "./props";
import { shownInChecks } from "./feedback";
import { signReport } from "./signing";
import { canonicalFromUrl, canonicalToolId, publisherFromId, toolPageUrl } from "./tools";

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
  security_status: CheckVerdict;
  /**
   * Other versions of this tool that are under review, flagged or confirmed malicious. When the newest version has no
   * score of its own, the worst of these sets security_status, so a fresh unscored version can't hide a flagged one.
   */
  other_versions_flagged: { version: string; security_status: CheckVerdict }[];
  public_signals_summary: null;
  page_url: string | null;
  /** Field reports on this exact version (any tier). */
  reports_for_this_version: number;
  /** True when no one has reported on this version yet: a report from this agent would be the first (ADR 0011 g). */
  be_first: boolean;
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

export async function checkTool(env: Env, q: CheckQuery): Promise<CheckResult> {
  const db = getDb(env);
  let version: typeof t.toolVersions.$inferSelect | undefined;
  let tool: typeof t.tools.$inferSelect | undefined;

  if (q.fingerprint) {
    version = await db.query.toolVersions.findFirst({
      where: eq(t.toolVersions.fingerprint, q.fingerprint),
      orderBy: desc(t.toolVersions.firstSeenAt),
    });
    if (version) tool = await db.query.tools.findFirst({ where: eq(t.tools.id, version.toolId) });
  } else {
    const canonical = q.id ? canonicalToolId(q.id) : canonicalFromUrl(q.url!);
    tool = await findTool(db, canonical);
    if (tool)
      version = await db.query.toolVersions.findFirst({
        where: eq(t.toolVersions.toolId, tool.id),
        orderBy: desc(t.toolVersions.firstSeenAt),
      });
  }

  if (!tool) {
    return {
      known: false,
      tool: null,
      version: null,
      fingerprint: q.fingerprint ?? null,
      forge_score: null,
      distinct_owners: 0,
      verified_owners: 0,
      loop_rate: null,
      recovers_after_reset_rate: null,
      strain_reports: 0,
      strain_hook_reports: 0,
      outcome_breakdown: EMPTY_BREAKDOWN,
      security_status: "clear",
      other_versions_flagged: [],
      public_signals_summary: null,
      page_url: null,
      reports_for_this_version: 0,
      be_first: true,
    };
  }

  const score = version
    ? await db.query.toolScores.findFirst({ where: eq(t.toolScores.toolVersionId, version.id) })
    : undefined;
  const others = q.fingerprint
    ? []
    : await db
        .select({ id: t.toolVersions.id, version: t.toolVersions.version, status: t.toolScores.securityStatus })
        .from(t.toolScores)
        .innerJoin(t.toolVersions, eq(t.toolScores.toolVersionId, t.toolVersions.id))
        .where(and(eq(t.toolVersions.toolId, tool.id), ne(t.toolScores.securityStatus, "clear")))
        .limit(20);
  const otherFlagged = others
    .filter((o) => o.id !== version?.id)
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
  const breakdown = score?.outcomeBreakdown ?? EMPTY_BREAKDOWN;
  const reportCount = breakdown.worked + breakdown.partial + breakdown.failed;
  const ownStatus = score?.securityStatus ?? "clear";
  const inherited = ownStatus === "clear" && score?.successScore == null ? otherFlagged[0]?.status : undefined;
  return {
    known: true,
    tool: { kind: tool.kind, id: tool.canonicalId },
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
    security_status: verdictFor(inherited ?? ownStatus),
    other_versions_flagged: otherFlagged.map((o) => ({ version: o.version, security_status: verdictFor(o.status) })),
    public_signals_summary: null,
    page_url: toolPageUrl(env.PUBLIC_ORIGIN, tool.canonicalId),
    reports_for_this_version: reportCount,
    be_first: reportCount === 0,
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
  | "publisher_cannot_report_own_tool";

export type ReportResult =
  | {
      ok: true;
      report_id: string;
      page_url: string;
      counted: boolean;
      reason: "counted" | "sandbox_reduced_weight" | "held_for_review";
      note_status: "none" | "published" | "pending_moderation" | "removed_by_moderation";
    }
  | { ok: false; counted: false; reason: ReportRejection; detail?: string };

/** Resolves the agent behind a grant, or null when it was revoked or never existed. */
export async function activeAgent(db: Db, props: AgentProps) {
  const agent = await db.query.agents.findFirst({ where: eq(t.agents.id, props.agentId) });
  if (!agent || agent.status !== "active" || agent.humanId !== props.humanId) return null;
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, agent.humanId) });
  return human ? { agent, human } : null;
}

export async function submitReport(env: Env, props: AgentProps, input: unknown, now = Date.now()): Promise<ReportResult> {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, counted: false, reason: "invalid_report", detail: parsed.error.issues[0]?.message };
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
  /^House handshake test: (started with npx, no credentials, and listed \d{1,4} tools? in \d{1,4}s\.|started and answered initialize, but tools\/list failed\.|npx could not install this version\.)$/;

export async function describeMe(env: Env, props: AgentProps) {
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
  };
}

/** Public headline numbers. Everyone counts here, sandbox included (ADR 0003). */
export async function publicStats(env: Env, now = Date.now()) {
  const db = getDb(env);
  const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const dayAgo = now - 86_400_000;
  const [humans, verified, agents, reports, reports24h, tools, toolsReported] = await Promise.all([
    one(db.select({ n: count() }).from(t.humans)),
    one(db.select({ n: count() }).from(t.humans).where(eq(t.humans.tier, "verified"))),
    one(db.select({ n: count() }).from(t.agents).where(eq(t.agents.status, "active"))),
    one(db.select({ n: count() }).from(t.reports)),
    one(db.select({ n: count() }).from(t.reports).where(gte(t.reports.createdAt, dayAgo))),
    one(db.select({ n: count() }).from(t.tools)),
    one(db.select({ n: count() }).from(t.toolVersions)),
  ]);
  return {
    humans,
    verified_humans: verified,
    agents,
    reports,
    reports_last_24h: reports24h,
    /** Every tool with a page, including tools seeded from public sources. */
    tools,
    /** Tool versions at least one agent has reported on. */
    tool_versions_reported: toolsReported,
    generated_at: new Date(now).toISOString(),
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
