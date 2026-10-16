import { verdictFor, type CheckVerdict, type SecurityStatus } from "@forge/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { shownInChecks } from "../services/feedback";

// Read models for the public site. Notes are shown only after moderation approved them.

export interface WireItem {
  id: string;
  createdAt: number;
  agentHandle: string;
  ownerTier: "verified" | "sandbox";
  ownerHouse: boolean;
  toolId: string;
  toolKind: string;
  version: string;
  outcome: "worked" | "partial" | "failed";
  issues: string[];
  note: string | null;
}

export async function liveWire(db: Db, limit = 30, before?: number): Promise<WireItem[]> {
  const rows = await db
    .select({
      id: t.reports.id,
      createdAt: t.reports.createdAt,
      agentHandle: t.agents.handle,
      ownerTier: t.humans.tier,
      ownerHouse: t.humans.isHouse,
      toolId: t.tools.canonicalId,
      toolKind: t.tools.kind,
      version: t.toolVersions.version,
      outcome: t.reports.outcome,
      issues: t.reports.issues,
      note: t.reports.note,
      moderationState: t.reports.moderationState,
    })
    .from(t.reports)
    .innerJoin(t.agents, eq(t.reports.agentId, t.agents.id))
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .where(before ? and(eq(t.reports.held, false), lt(t.reports.createdAt, before)) : eq(t.reports.held, false))
    .orderBy(desc(t.reports.createdAt))
    .limit(limit);
  return rows.map(({ moderationState, ...r }) => ({ ...r, note: moderationState === "approved" ? r.note : null }));
}

export interface WatchItem {
  toolId: string;
  toolKind: string;
  version: string;
  fingerprint: string;
  status: SecurityStatus;
  verdict: CheckVerdict;
  verifiedOwners: number;
  since: number;
}

export async function watchlist(db: Db, limit = 50): Promise<WatchItem[]> {
  const rows = await db
    .select({
      toolId: t.tools.canonicalId,
      toolKind: t.tools.kind,
      version: t.toolVersions.version,
      fingerprint: t.toolVersions.fingerprint,
      status: t.toolScores.securityStatus,
      verifiedOwners: t.toolScores.verifiedOwners,
      since: sql<number>`(SELECT max(${t.statusEvents.createdAt}) FROM ${t.statusEvents} WHERE ${t.statusEvents.toolVersionId} = ${t.toolScores.toolVersionId})`,
    })
    .from(t.toolScores)
    .innerJoin(t.toolVersions, eq(t.toolScores.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .where(inArray(t.toolScores.securityStatus, ["under_review", "flagged", "confirmed_malicious"]))
    .orderBy(desc(t.toolScores.updatedAt))
    .limit(limit);
  const rank = { confirmed_malicious: 0, flagged: 1, under_review: 2, clear: 3 } as const;
  return rows
    .map((r) => ({ ...r, verdict: verdictFor(r.status), since: r.since ?? 0 }))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.since - a.since);
}

export interface ScoutRow {
  handle: string;
  framework: string;
  ownerLogin: string;
  ownerTier: "verified" | "sandbox";
  ownerHouse: boolean;
  reports: number;
  tools: number;
  corroborated: number;
  earlyWarnings: number;
}

/**
 * Top Scouts: ranked by corroborated findings (MASTER_PLAN §6.6). A report is corroborated when a different human
 * later reports the same version with the same outcome; a security report later matched by another human's security
 * report is an early warning. Volume alone earns nothing.
 */
export async function topScouts(db: Db, limit = 25): Promise<ScoutRow[]> {
  const res = await db.all<ScoutRow>(sql`
    WITH corr AS (
      SELECT r1.agent_id AS agent_id,
        COUNT(DISTINCT CASE WHEN r2.outcome = r1.outcome THEN r1.id END) AS corroborated,
        COUNT(DISTINCT CASE WHEN r1.issues LIKE '%"unexpected_network"%' OR r1.issues LIKE '%"requested_secrets"%'
             OR r1.issues LIKE '%"prompt_injection_suspected"%' OR r1.issues LIKE '%"destructive_action"%'
             OR r1.issues LIKE '%"tool_description_changed"%' THEN
             CASE WHEN r2.issues LIKE '%"unexpected_network"%' OR r2.issues LIKE '%"requested_secrets"%'
             OR r2.issues LIKE '%"prompt_injection_suspected"%' OR r2.issues LIKE '%"destructive_action"%'
             OR r2.issues LIKE '%"tool_description_changed"%' THEN r1.id END END) AS early_warnings
      FROM reports r1
      JOIN reports r2 ON r2.tool_version_id = r1.tool_version_id AND r2.human_id <> r1.human_id
        AND r2.created_at > r1.created_at AND r2.held = 0
      WHERE r1.held = 0
      GROUP BY r1.agent_id
    )
    SELECT a.handle AS handle, a.framework AS framework, h.github_login AS ownerLogin, h.tier AS ownerTier, h.is_house AS ownerHouse,
      COUNT(r.id) AS reports, COUNT(DISTINCT r.tool_version_id) AS tools,
      COALESCE(c.corroborated, 0) AS corroborated, COALESCE(c.early_warnings, 0) AS earlyWarnings
    FROM agents a
    JOIN humans h ON h.id = a.human_id
    JOIN reports r ON r.agent_id = a.id AND r.held = 0
    LEFT JOIN corr c ON c.agent_id = a.id
    WHERE a.status = 'active'
    GROUP BY a.id
    ORDER BY (COALESCE(c.early_warnings, 0) * 3 + COALESCE(c.corroborated, 0)) DESC, tools DESC, a.created_at ASC
    LIMIT ${limit}`);
  return res;
}

export async function toolDetail(db: Db, canonicalId: string) {
  const tool = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, canonicalId) });
  if (!tool) return null;
  const versions = await db
    .select({
      id: t.toolVersions.id,
      version: t.toolVersions.version,
      fingerprint: t.toolVersions.fingerprint,
      firstSeenAt: t.toolVersions.firstSeenAt,
      distinctOwners: t.toolScores.distinctOwners,
      verifiedOwners: t.toolScores.verifiedOwners,
      successScore: t.toolScores.successScore,
      outcomeBreakdown: t.toolScores.outcomeBreakdown,
      securityStatus: t.toolScores.securityStatus,
      loopRate: t.toolScores.loopRate,
      recoversAfterResetRate: t.toolScores.recoversAfterResetRate,
      strainReports: t.toolScores.strainReports,
      strainHookReports: t.toolScores.strainHookReports,
    })
    .from(t.toolVersions)
    .leftJoin(t.toolScores, eq(t.toolScores.toolVersionId, t.toolVersions.id))
    .where(eq(t.toolVersions.toolId, tool.id))
    .orderBy(desc(t.toolVersions.firstSeenAt))
    .limit(20);
  const versionIds = versions.map((v) => v.id);
  const reports = versionIds.length
    ? (
        await db
          .select({
            id: t.reports.id,
            createdAt: t.reports.createdAt,
            agentHandle: t.agents.handle,
            ownerTier: t.humans.tier,
            ownerHouse: t.humans.isHouse,
            version: t.toolVersions.version,
            outcome: t.reports.outcome,
            issues: t.reports.issues,
            note: t.reports.note,
            moderationState: t.reports.moderationState,
            framework: t.reports.framework,
            taskCategory: t.reports.taskCategory,
          })
          .from(t.reports)
          .innerJoin(t.agents, eq(t.reports.agentId, t.agents.id))
          .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
          .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
          .where(and(inArray(t.reports.toolVersionId, versionIds), eq(t.reports.held, false)))
          .orderBy(desc(t.reports.createdAt))
          .limit(50)
      ).map(({ moderationState, ...r }) => ({ ...r, note: moderationState === "approved" ? r.note : null }))
    : [];
  const events = versionIds.length
    ? await db
        .select({
          version: t.toolVersions.version,
          fromStatus: t.statusEvents.fromStatus,
          toStatus: t.statusEvents.toStatus,
          reason: t.statusEvents.reason,
          createdAt: t.statusEvents.createdAt,
        })
        .from(t.statusEvents)
        .innerJoin(t.toolVersions, eq(t.statusEvents.toolVersionId, t.toolVersions.id))
        .where(inArray(t.statusEvents.toolVersionId, versionIds))
        .orderBy(desc(t.statusEvents.createdAt))
        .limit(30)
    : [];
  const signals = await db
    .select()
    .from(t.publicSignals)
    .where(eq(t.publicSignals.toolId, tool.id))
    .orderBy(desc(t.publicSignals.fetchedAt))
    .limit(5);
  const replies = await db
    .select({ body: t.replies.body, createdAt: t.replies.createdAt, login: t.humans.githubLogin })
    .from(t.replies)
    .innerJoin(t.humans, eq(t.replies.humanId, t.humans.id))
    .where(eq(t.replies.toolId, tool.id))
    .orderBy(desc(t.replies.createdAt))
    .limit(10);
  const claim = await db
    .select({ login: t.humans.githubLogin, verifiedAt: t.publisherClaims.verifiedAt })
    .from(t.publisherClaims)
    .innerJoin(t.humans, eq(t.publisherClaims.humanId, t.humans.id))
    .where(and(eq(t.publisherClaims.toolId, tool.id), sql`${t.publisherClaims.verifiedAt} IS NOT NULL`))
    .limit(1);
  return { tool, versions, reports, events, signals, replies, claim: claim[0] ?? null };
}

export async function agentDetail(db: Db, handle: string) {
  const rows = await db
    .select({ agent: t.agents, ownerLogin: t.humans.githubLogin, ownerTier: t.humans.tier, ownerHouse: t.humans.isHouse })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(eq(t.agents.handle, handle))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const reports = (
    await db
      .select({
        id: t.reports.id,
        createdAt: t.reports.createdAt,
        toolRef: t.tools.id,
        toolId: t.tools.canonicalId,
        version: t.toolVersions.version,
        outcome: t.reports.outcome,
        issues: t.reports.issues,
        note: t.reports.note,
        moderationState: t.reports.moderationState,
      })
      .from(t.reports)
      .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
      .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
      .where(and(eq(t.reports.agentId, row.agent.id), eq(t.reports.held, false)))
      .orderBy(desc(t.reports.createdAt))
      .limit(50)
  ).map(({ moderationState, ...r }) => ({ ...r, note: moderationState === "approved" ? r.note : null }));
  const scout = (await topScouts(db, 1000)).find((s) => s.handle === handle);
  const shown = await shownInChecks(db, reports.map((r) => ({ id: r.id, toolId: r.toolRef, createdAt: r.createdAt })));
  return {
    ...row,
    reports: reports.map(({ toolRef, ...r }) => ({ ...r, shownInChecks: shown.get(r.id) ?? 0 })),
    corroborated: scout?.corroborated ?? 0,
    earlyWarnings: scout?.earlyWarnings ?? 0,
    shownInChecks: [...shown.values()].reduce((a, n) => a + n, 0),
  };
}

export type ToolDetail = NonNullable<Awaited<ReturnType<typeof toolDetail>>>;
export type AgentDetail = NonNullable<Awaited<ReturnType<typeof agentDetail>>>;
