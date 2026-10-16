import { describe, expect, it } from "vitest";
import { DAY_MS, reportSchema, scoreToolVersion, strainSchema, type ScoredReport, type Strain } from "../src/index";

const strain = (over: Partial<Strain> = {}): Strain => ({
  source: "hook",
  attempts: 2,
  tool_errors: 4,
  retries: 3,
  loop_detected: true,
  context_reset: true,
  outcome_after_reset: "worked",
  escalated_to_human: false,
  ...over,
});

describe("strain schema (§6.10)", () => {
  it("accepts honest counts", () => {
    expect(strainSchema.safeParse(strain()).success).toBe(true);
    expect(strainSchema.safeParse(strain({ loop_detected: false, tool_errors: 0, retries: 0, context_reset: false, outcome_after_reset: "none" })).success).toBe(true);
  });

  it.each([
    ["inflated attempts", { attempts: 51 }],
    ["inflated errors", { tool_errors: 101 }],
    ["inflated retries", { retries: 51 }],
    ["negative counts", { tool_errors: -1 }],
    ["fractional counts", { retries: 1.5 }],
    ["an unknown source", { source: "vibes" }],
    ["an unknown outcome", { outcome_after_reset: "great" }],
    ["more retries than failures", { tool_errors: 1, retries: 3 }],
    ["a loop with no failures", { loop_detected: true, tool_errors: 1, retries: 0 }],
    ["an outcome after reset without a reset", { context_reset: false, outcome_after_reset: "worked" }],
  ])("rejects %s", (_n, over) => {
    expect(strainSchema.safeParse({ ...strain(), ...over }).success).toBe(false);
  });

  it("rejects extra fields, so no error text or inputs can ride along", () => {
    expect(strainSchema.safeParse({ ...strain(), error_text: "stack trace…" }).success).toBe(false);
  });

  it("is optional on reports", () => {
    const base = {
      tool: { kind: "skill", id: "npm:x", version: "1", fingerprint: `sha256:${"0".repeat(64)}` },
      task: { category: "data", framework: "claude-code" },
      outcome: "worked",
    };
    expect(reportSchema.safeParse(base).success).toBe(true);
    expect(reportSchema.safeParse({ ...base, strain: strain() }).success).toBe(true);
  });
});

describe("loop rate and recovers after reset", () => {
  const FP = `sha256:${"c".repeat(64)}`;
  const NOW = Date.UTC(2026, 9, 14);
  const r = (humanId: string, s: Partial<Strain> | null, tier: "verified" | "sandbox" = "verified"): ScoredReport => ({
    humanId,
    humanTier: tier,
    isPublisher: false,
    fingerprint: FP,
    outcome: "partial",
    issues: [],
    createdAt: NOW - DAY_MS,
    strain: s ? strain(s) : null,
  });

  it("stays hidden below the score thresholds", () => {
    const s = scoreToolVersion(FP, [r("a", {}), r("b", {}), r("c", {}), r("d", {})], { now: NOW });
    expect(s.loopRate).toBeNull();
    expect(s.strainReports).toBe(4);
  });

  it("counts the share of people whose latest report saw a loop", () => {
    const reports = [
      r("a", {}),
      r("b", {}),
      r("c", { loop_detected: false }),
      r("d", { loop_detected: false }),
      r("e", { loop_detected: false, source: "self" }),
      r("f", null), // no strain data: not in the denominator
    ];
    const s = scoreToolVersion(FP, reports, { now: NOW });
    expect(s.loopRate).toBe(0.4);
    expect(s.strainReports).toBe(5);
    expect(s.strainHookReports).toBe(4);
  });

  it("needs 2 verified people among strain reporters", () => {
    const sandbox = ["a", "b", "c", "d"].map((h) => r(h, {}, "sandbox"));
    expect(scoreToolVersion(FP, [...sandbox, r("v", {})], { now: NOW }).loopRate).toBeNull();
  });

  it("recovers-after-reset uses only reports with a context reset", () => {
    const reports = ["a", "b", "c", "d", "e"].map((h, i) => r(h, { outcome_after_reset: i < 4 ? "worked" : "failed" }));
    expect(scoreToolVersion(FP, reports, { now: NOW }).recoversAfterResetRate).toBe(0.8);
  });
});
