import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  scoreToolVersion,
  verdictFor,
  wilsonLowerBound,
  type ScoredReport,
} from "../src/index";

const FP = `sha256:${"a".repeat(64)}`;
const FP2 = `sha256:${"b".repeat(64)}`;
const NOW = Date.UTC(2026, 9, 14);

function r(humanId: string, over: Partial<ScoredReport> = {}): ScoredReport {
  return {
    humanId,
    humanTier: "verified",
    isPublisher: false,
    fingerprint: FP,
    outcome: "worked",
    issues: [],
    createdAt: NOW - DAY_MS,
    ...over,
  };
}
const humans = (n: number, over: Partial<ScoredReport> = {}) =>
  Array.from({ length: n }, (_, i) => r(`h${i}`, over));

describe("success score", () => {
  it("one human with 3 agents counts once, using their latest report", () => {
    const reports = [
      r("h1", { outcome: "failed", createdAt: NOW - 3 * DAY_MS }),
      r("h1", { outcome: "failed", createdAt: NOW - 2 * DAY_MS }),
      r("h1", { outcome: "worked", createdAt: NOW - 1 * DAY_MS }),
    ];
    const s = scoreToolVersion(FP, reports, { now: NOW });
    expect(s.distinctOwners).toBe(1);
    expect(s.outcomeBreakdown).toEqual({ worked: 1, partial: 0, failed: 0 });
  });

  it("shows no score below 5 owners", () => {
    expect(scoreToolVersion(FP, humans(4), { now: NOW }).successScore).toBeNull();
    const s = scoreToolVersion(FP, humans(5), { now: NOW });
    expect(s.successScore).toBe(Math.round(100 * wilsonLowerBound(1, 5)));
    expect(s.successScore).toBeGreaterThan(0);
  });

  it("everyone counts as an owner, but a score needs at least 2 verified among them", () => {
    const sandbox = humans(20, { humanTier: "sandbox" }).map((x, i) => ({ ...x, humanId: `s${i}` }));
    const oneVerified = scoreToolVersion(FP, [...humans(1), ...sandbox], { now: NOW });
    expect(oneVerified.distinctOwners).toBe(21);
    expect(oneVerified.verifiedOwners).toBe(1);
    expect(oneVerified.successScore).toBeNull();

    const twoVerified = scoreToolVersion(FP, [...humans(2), ...sandbox.slice(0, 3)], { now: NOW });
    expect(twoVerified.distinctOwners).toBe(5);
    // weighted: 2 verified + 3 × 0.25 sandbox, all "worked"
    expect(twoVerified.successScore).toBe(Math.round(100 * wilsonLowerBound(1, 2.75)));
  });

  it("sandbox accounts get 0.25 weight", () => {
    const sandbox = humans(20, { humanTier: "sandbox" }).map((x, i) => ({ ...x, humanId: `s${i}` }));

    // 5 verified "worked" + 4 sandbox "failed": weighted rate is 5 / (5 + 1) over n = 6.
    const failedSandbox = sandbox.slice(0, 4).map((x) => ({ ...x, outcome: "failed" as const }));
    const mixed = scoreToolVersion(FP, [...humans(5), ...failedSandbox], { now: NOW });
    expect(mixed.successScore).toBe(Math.round(100 * wilsonLowerBound(5 / 6, 6)));
  });

  it("a publisher's own reports never count", () => {
    const s = scoreToolVersion(FP, [...humans(4), r("pub", { isPublisher: true })], { now: NOW });
    expect(s.distinctOwners).toBe(4);
    expect(s.verifiedOwners).toBe(4);
    expect(s.successScore).toBeNull();
  });

  it("ignores reports older than 180 days", () => {
    const old = humans(5, { createdAt: NOW - 181 * DAY_MS });
    expect(scoreToolVersion(FP, old, { now: NOW }).distinctOwners).toBe(0);
  });

  it("a fingerprint change resets the version", () => {
    const s = scoreToolVersion(FP2, humans(10), { now: NOW });
    expect(s).toMatchObject({
      distinctOwners: 0,
      verifiedOwners: 0,
      successScore: null,
      outcomeBreakdown: { worked: 0, partial: 0, failed: 0 },
      securityStatus: "clear",
    });
  });

  it("partial counts as half", () => {
    const s = scoreToolVersion(FP, humans(10, { outcome: "partial" }), { now: NOW });
    expect(s.successScore).toBe(Math.round(100 * wilsonLowerBound(0.5, 10)));
  });
});

describe("security status", () => {
  const sec = { issues: ["requested_secrets"] as const };

  it("is clear with no security reports", () => {
    expect(scoreToolVersion(FP, humans(5), { now: NOW }).securityStatus).toBe("clear");
  });

  it("one verified owner moves it to under review (caution)", () => {
    const s = scoreToolVersion(FP, [...humans(5), r("x", sec)], { now: NOW });
    expect(s.securityStatus).toBe("under_review");
    expect(verdictFor(s.securityStatus)).toBe("caution");
  });

  it("needs 3 distinct verified owners within 30 days to be flagged", () => {
    const two = [r("a", sec), r("b", sec)];
    expect(scoreToolVersion(FP, two, { now: NOW }).securityStatus).toBe("under_review");
    expect(scoreToolVersion(FP, [...two, r("c", sec)], { now: NOW }).securityStatus).toBe("flagged");
  });

  it("one human's 3 agents cannot flag a tool", () => {
    const ring = [r("a", sec), r("a", sec), r("a", sec)];
    expect(scoreToolVersion(FP, ring, { now: NOW }).securityStatus).toBe("under_review");
  });

  it("sandbox security reports don't move the status", () => {
    const s = scoreToolVersion(FP, humans(5, { ...sec, humanTier: "sandbox" }), { now: NOW });
    expect(s.securityStatus).toBe("clear");
  });

  it("people verified only by GitHub activity can't push a tool to flagged (M3, option b)", () => {
    const sec = { issues: ["unexpected_network"] as const, canFlag: false };
    const s = scoreToolVersion(FP, [r("a", sec), r("b", sec), r("c", sec), r("d", sec)], { now: NOW });
    expect(s.securityStatus).toBe("under_review");
    const mixed = [r("a", sec), r("b", sec), r("x", { issues: ["unexpected_network"] }), r("y", { issues: ["unexpected_network"] })];
    expect(scoreToolVersion(FP, mixed, { now: NOW }).securityStatus).toBe("under_review");
    expect(scoreToolVersion(FP, [...mixed, r("z", { issues: ["unexpected_network"] })], { now: NOW }).securityStatus).toBe("flagged");
  });

  it("security reports older than 30 days don't count toward flagged", () => {
    const old = [r("a", sec), r("b", sec), r("c", { ...sec, createdAt: NOW - 31 * DAY_MS })];
    expect(scoreToolVersion(FP, old, { now: NOW }).securityStatus).toBe("under_review");
  });

  it("positive reports never average a security report away", () => {
    const s = scoreToolVersion(FP, [...humans(50), r("a", sec), r("b", sec), r("c", sec)], { now: NOW });
    expect(s.securityStatus).toBe("flagged");
  });

  it("an advisory match flags the tool on its own", () => {
    expect(scoreToolVersion(FP, [], { now: NOW, advisoryMatch: true }).securityStatus).toBe("flagged");
  });

  it("confirmed malicious requires flagged plus confirmation", () => {
    expect(scoreToolVersion(FP, [r("a", sec)], { now: NOW, confirmedMalicious: true }).securityStatus).toBe(
      "under_review",
    );
    expect(
      scoreToolVersion(FP, [], { now: NOW, advisoryMatch: true, confirmedMalicious: true }).securityStatus,
    ).toBe("confirmed_malicious");
  });
});
