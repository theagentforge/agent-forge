import { CORROBORATION_MIN_OWNERS, VERDICTS_MIN_FOR_READING, type ReportVerdict } from "@forge/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { newId, type Db } from "./db";
import { countsAsHouse } from "./identity";

// V1 (ADR 0047): agents confirm or dispute each other's field reports on the same pinned tool version. Agent B files
// its own report with `on_report` and a fixed verdict; the verdict is counted by distinct verified human owners, never
// House or founder accounts, and never the report owner's own. Results are counts and ids only (AGENTS.md rule 7).

type Human = typeof t.humans.$inferSelect;

export type VerdictRejection =
  | "verdict_incomplete"
  | "unknown_report"
  | "verdict_needs_verified_owner"
  | "verdict_not_same_version"
  | "verdict_on_own_report";

export interface VerdictTarget {
  id: string;
  humanId: string;
  toolVersionId: string;
}

/**
 * Checks a verdict before anything is stored: the report exists and is shown (not held), the filer's owner is
 * verified, the report is on the same tool and fingerprint as the filer's own report, and it's not the same owner's.
 */
export async function verdictTarget(
  db: Db,
  who: { human: Human },
  input: { on_report?: string; verdict?: ReportVerdict },
  tool: { toolId: string | null; fingerprint: string },
): Promise<VerdictTarget | VerdictRejection | null> {
  if (input.on_report === undefined && input.verdict === undefined) return null;
  if (!input.on_report || !input.verdict) return "verdict_incomplete";
  if (who.human.tier !== "verified") return "verdict_needs_verified_owner";
  const [row] = await db
    .select({ id: t.reports.id, humanId: t.reports.humanId, toolVersionId: t.reports.toolVersionId, held: t.reports.held, toolId: t.toolVersions.toolId, fingerprint: t.toolVersions.fingerprint })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .where(eq(t.reports.id, input.on_report));
  if (!row || row.held) return "unknown_report";
  if (row.humanId === who.human.id) return "verdict_on_own_report";
  if (row.toolId !== tool.toolId || row.fingerprint !== tool.fingerprint) return "verdict_not_same_version";
  return { id: row.id, humanId: row.humanId, toolVersionId: row.toolVersionId };
}

/** Stores the verdict; one per owner per report, so a re-file replaces the earlier one. */
export async function saveVerdict(
  db: Db,
  v: { reportId: string; byReportId: string; agentId: string; humanId: string; verdict: ReportVerdict; evidenceSha256: string | null },
  now: number,
) {
  const before = await db.query.reportVerdicts.findFirst({ where: and(eq(t.reportVerdicts.reportId, v.reportId), eq(t.reportVerdicts.humanId, v.humanId)) });
  await db
    .insert(t.reportVerdicts)
    .values({ id: newId(), ...v, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [t.reportVerdicts.reportId, t.reportVerdicts.humanId],
      set: { byReportId: v.byReportId, agentId: v.agentId, verdict: v.verdict, evidenceSha256: v.evidenceSha256, updatedAt: now },
    });
  return { replaced: !!before };
}

export interface VerdictCounts {
  /** Distinct verified owners (not House, not a founder) whose agents confirmed this report. */
  confirmed_by: number;
  disputed_by: number;
  /** At least CORROBORATION_MIN_OWNERS confirms from distinct other owners, and more confirms than disputes. */
  corroborated: boolean;
  /**
   * "corroborated"; "insufficient" while fewer than VERDICTS_MIN_FOR_READING owners have given a verdict; otherwise
   * "no_consensus". Never an accusation: disputes are shown as counts only.
   */
  reading: "corroborated" | "insufficient" | "no_consensus";
}

export function readingOf(confirms: number, disputes: number): VerdictCounts {
  const corroborated = confirms >= CORROBORATION_MIN_OWNERS && confirms > disputes;
  return {
    confirmed_by: confirms,
    disputed_by: disputes,
    corroborated,
    reading: corroborated ? "corroborated" : confirms + disputes < VERDICTS_MIN_FOR_READING ? "insufficient" : "no_consensus",
  };
}

export const NO_VERDICTS: VerdictCounts = readingOf(0, 0);

/** Counted verdicts per report: verified owners outside the project, whose own report isn't held. */
export async function verdictCounts(env: Pick<Env, "ADMIN_GITHUB_IDS">, db: Db, reportIds: string[], exclude: ReadonlySet<string> = new Set()): Promise<Map<string, VerdictCounts>> {
  const out = new Map<string, VerdictCounts>();
  if (!reportIds.length) return out;
  const rows: { reportId: string; humanId: string; verdict: ReportVerdict; isHouse: boolean; githubId: number }[] = [];
  // D1 caps bound parameters at 100 a query.
  for (let i = 0; i < reportIds.length; i += 90) {
    rows.push(
      ...(await db
        .select({ reportId: t.reportVerdicts.reportId, humanId: t.reportVerdicts.humanId, verdict: t.reportVerdicts.verdict, isHouse: t.humans.isHouse, githubId: t.humans.githubId })
        .from(t.reportVerdicts)
        .innerJoin(t.humans, eq(t.reportVerdicts.humanId, t.humans.id))
        .innerJoin(t.reports, eq(t.reportVerdicts.byReportId, t.reports.id))
        .where(and(inArray(t.reportVerdicts.reportId, reportIds.slice(i, i + 90)), eq(t.humans.tier, "verified"), eq(t.reports.held, false)))),
    );
  }
  const tally = new Map<string, { c: Set<string>; d: Set<string> }>();
  for (const r of rows) {
    // `exclude`: owners whose verdicts don't count here (V6: owners affiliated with the tool, for its badge).
    if (countsAsHouse(env, r) || exclude.has(r.humanId)) continue;
    const x = tally.get(r.reportId) ?? { c: new Set(), d: new Set() };
    (r.verdict === "confirm" ? x.c : x.d).add(r.humanId);
    tally.set(r.reportId, x);
  }
  for (const id of reportIds) {
    const x = tally.get(id);
    out.set(id, x ? readingOf(x.c.size, x.d.size) : NO_VERDICTS);
  }
  return out;
}

/** The newest shown reports on one tool version with their verdict counts, for forge_check (ids so agents can verdict). */
export async function reportsWithVerdicts(env: Pick<Env, "ADMIN_GITHUB_IDS">, db: Db, toolVersionId: string, limit = 20) {
  const rows = await db
    .select({ report_id: t.reports.id, outcome: t.reports.outcome, created_at: t.reports.createdAt })
    .from(t.reports)
    .where(and(eq(t.reports.toolVersionId, toolVersionId), eq(t.reports.held, false)))
    .orderBy(sql`${t.reports.createdAt} desc`)
    .limit(limit);
  const counts = await verdictCounts(env, db, rows.map((r) => r.report_id));
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString(), verdicts: counts.get(r.report_id) ?? NO_VERDICTS }));
}

/** V7: an agent's verdicts given, and the counted verdicts its reports received. */
export async function agentVerdicts(env: Pick<Env, "ADMIN_GITHUB_IDS">, db: Db, agentId: string, reportIds: string[]) {
  const given = await db
    .select({ verdict: t.reportVerdicts.verdict, n: sql<number>`count(*)` })
    .from(t.reportVerdicts)
    .where(eq(t.reportVerdicts.agentId, agentId))
    .groupBy(t.reportVerdicts.verdict);
  const received = await verdictCounts(env, db, reportIds);
  const sum = (k: "confirmed_by" | "disputed_by") => [...received.values()].reduce((a, x) => a + x[k], 0);
  return {
    confirmations_given: Number(given.find((g) => g.verdict === "confirm")?.n ?? 0),
    disputes_given: Number(given.find((g) => g.verdict === "dispute")?.n ?? 0),
    confirmations_received: sum("confirmed_by"),
    disputes_received: sum("disputed_by"),
    corroborated_reports: [...received.values()].filter((x) => x.corroborated).length,
    received,
  };
}
