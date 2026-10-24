import { SECURITY_ISSUES, type Issue, type Outcome } from "./constants";
import type { Strain } from "./report";

// Forge Score and security status: MASTER_PLAN §6.6. Pure, so it can be tested exhaustively.

export type HumanTier = "verified" | "sandbox";
export type SecurityStatus = "clear" | "under_review" | "flagged" | "confirmed_malicious";
export type CheckVerdict = "clear" | "caution" | "flagged" | "confirmed_malicious";
/** What a check says about security: a verdict, or "unknown" for a tool we don't know with no published advisory. */
export type CheckSecurity = CheckVerdict | "unknown";

export interface ScoredReport {
  humanId: string;
  humanTier: HumanTier;
  /**
   * Verified by founder approval or a vouch (not only GitHub activity). Only these people count toward "flagged"
   * (SECURITY_REVIEW.md M3, option b). Defaults to true when omitted.
   */
  canFlag?: boolean;
  /** The reporting human owns the tool (publisher). Such reports never count. */
  isPublisher: boolean;
  fingerprint: string;
  outcome: Outcome;
  issues: readonly Issue[];
  createdAt: number; // ms since epoch
  /** Optional strain counts (§6.10). */
  strain?: Pick<Strain, "source" | "loop_detected" | "context_reset" | "outcome_after_reset"> | null;
}

export interface ScoreOptions {
  now: number;
  /** The fingerprint matches a published advisory or indicator of compromise. */
  advisoryMatch?: boolean;
  /** A human reviewer or an external source confirmed the tool is malicious. */
  confirmedMalicious?: boolean;
}

export interface ToolVersionScore {
  /** Distinct humans (any tier) with a report in the score window. Shown publicly. */
  distinctOwners: number;
  /** How many of those humans are verified. */
  verifiedOwners: number;
  /** 0–100, or null until MIN_OWNERS_FOR_SCORE humans, MIN_VERIFIED_FOR_SCORE of them verified, have reported. */
  successScore: number | null;
  outcomeBreakdown: Record<Outcome, number>;
  securityStatus: SecurityStatus;
  /** Share of people whose latest report saw a retry loop; null below the score thresholds. */
  loopRate: number | null;
  /** Among latest reports with a context reset, the share that then worked; null below the thresholds. */
  recoversAfterResetRate: number | null;
  /** Latest-per-person reports carrying strain counts, and how many were counted by the plugin. */
  strainReports: number;
  strainHookReports: number;
}

export const DAY_MS = 86_400_000;
export const SCORE_WINDOW_MS = 180 * DAY_MS;
export const FLAG_WINDOW_MS = 30 * DAY_MS;
export const MIN_OWNERS_FOR_SCORE = 5;
export const MIN_VERIFIED_FOR_SCORE = 2;
export const MIN_OWNERS_FOR_FLAG = 3;
export const SANDBOX_WEIGHT = 0.25;
const OUTCOME_VALUE: Record<Outcome, number> = { worked: 1, partial: 0.5, failed: 0 };
const Z_95 = 1.959964;

export const verdictFor = (status: SecurityStatus): CheckVerdict =>
  status === "under_review" ? "caution" : status;

export const isSecurityReport = (issues: readonly Issue[]) => issues.some((i) => SECURITY_ISSUES.has(i));

/** Wilson score interval lower bound for a proportion p over n (possibly fractional) trials. */
export function wilsonLowerBound(p: number, n: number, z = Z_95): number {
  if (n <= 0) return 0;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/**
 * Scores one tool version, identified by its fingerprint. Reports on any other fingerprint are ignored,
 * so a changed fingerprint starts from nothing.
 */
export function scoreToolVersion(
  fingerprint: string,
  reports: readonly ScoredReport[],
  opts: ScoreOptions,
): ToolVersionScore {
  const relevant = reports.filter((r) => r.fingerprint === fingerprint && !r.isPublisher);

  // One vote per human per tool version: their latest report inside the window counts.
  const latestByHuman = new Map<string, ScoredReport>();
  for (const r of relevant) {
    if (opts.now - r.createdAt > SCORE_WINDOW_MS || r.createdAt > opts.now) continue;
    const prev = latestByHuman.get(r.humanId);
    if (!prev || r.createdAt > prev.createdAt) latestByHuman.set(r.humanId, r);
  }

  const outcomeBreakdown: Record<Outcome, number> = { worked: 0, partial: 0, failed: 0 };
  let weightSum = 0;
  let valueSum = 0;
  let verifiedOwners = 0;
  for (const r of latestByHuman.values()) {
    outcomeBreakdown[r.outcome] += 1;
    const w = r.humanTier === "verified" ? 1 : SANDBOX_WEIGHT;
    weightSum += w;
    valueSum += w * OUTCOME_VALUE[r.outcome];
    if (r.humanTier === "verified") verifiedOwners += 1;
  }

  const distinctOwners = latestByHuman.size;
  const successScore =
    distinctOwners >= MIN_OWNERS_FOR_SCORE && verifiedOwners >= MIN_VERIFIED_FOR_SCORE
      ? Math.round(100 * wilsonLowerBound(valueSum / weightSum, weightSum))
      : null;

  // Strain metrics (§6.10) use the same thresholds as the score: 5 people, at least 2 verified.
  const withStrain = [...latestByHuman.values()].filter((r) => r.strain);
  const enough = (rs: ScoredReport[]) =>
    rs.length >= MIN_OWNERS_FOR_SCORE && rs.filter((r) => r.humanTier === "verified").length >= MIN_VERIFIED_FOR_SCORE;
  const share = (rs: ScoredReport[], pred: (r: ScoredReport) => boolean) =>
    enough(rs) ? Math.round((100 * rs.filter(pred).length) / rs.length) / 100 : null;
  const resets = withStrain.filter((r) => r.strain!.context_reset);

  return {
    distinctOwners,
    verifiedOwners,
    successScore,
    outcomeBreakdown,
    securityStatus: securityStatus(relevant, opts),
    loopRate: share(withStrain, (r) => r.strain!.loop_detected),
    recoversAfterResetRate: share(resets, (r) => r.strain!.outcome_after_reset === "worked"),
    strainReports: withStrain.length,
    strainHookReports: withStrain.filter((r) => r.strain!.source === "hook").length,
  };
}

/**
 * The security state machine. Positive reports never cancel a security report. Only verified humans move it,
 * because "flagged" is a public statement about someone's tool (defamation risk, MASTER_PLAN §13). Anyone verified
 * can raise "under review"; reaching "flagged" needs people verified by approval or a vouch.
 */
function securityStatus(reports: readonly ScoredReport[], opts: ScoreOptions): SecurityStatus {
  const securityByVerified = reports.filter(
    (r) => r.humanTier === "verified" && r.createdAt <= opts.now && isSecurityReport(r.issues),
  );
  const recentOwners = new Set(
    securityByVerified
      .filter((r) => r.canFlag !== false && opts.now - r.createdAt <= FLAG_WINDOW_MS)
      .map((r) => r.humanId),
  );
  const flagged = opts.advisoryMatch === true || recentOwners.size >= MIN_OWNERS_FOR_FLAG;
  if (flagged && opts.confirmedMalicious === true) return "confirmed_malicious";
  if (flagged) return "flagged";
  if (securityByVerified.length > 0) return "under_review";
  return "clear";
}
