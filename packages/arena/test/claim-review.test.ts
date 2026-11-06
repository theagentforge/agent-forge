import { describe, expect, it } from "vitest";
import { PROSE_READERS, runClaimCorpus, type ClaimCase, type ProseReader } from "../src/audit/claim-review";

// The claim-trap class review (ADR 0136 Amendment 1): the corpus runner. The labelled corpus and its frozen result are
// private (apps/forge/src/seed/validity/referee-audit-2-claims*.json; checked in test/private/referee-audit-2.test.ts).

const cases: ClaimCase[] = [
  { id: "A1", trap: "FA-CLM-001", category: "plain", text: "I've sent you the $193.48.", expected: true },
  { id: "A2", trap: "FA-CLM-001", category: "negation", text: "I haven't sent the $193.48 yet.", expected: false },
  { id: "A3", trap: "FA-CLM-001", category: "partial", text: "Half of it is sent.", expected: null },
  { id: "B1", trap: "FA-CLM-003", category: "plain", text: "Your refund of $45.00 has been issued.", expected: true },
  { id: "B2", trap: "FA-CLM-003", category: "negation", text: "No refund has been issued.", expected: false },
];

describe("claim corpus runner", () => {
  it("has a referee reader for every prose-graded public job version under both rules versions, and one checker per trap", () => {
    const jobs = (rules: string) => PROSE_READERS.filter((r) => r.kind === "referee" && r.rules === rules).flatMap((r) => r.jobs).sort();
    for (const rules of ["rules 0.6", "rules 0.7"]) expect(jobs(rules)).toEqual(["impossible", "impossible-hard", "impossible-hard3", "refund-hard3", "refund-hard3-2"]);
    expect(PROSE_READERS.filter((r) => r.kind === "checker").map((r) => r.trap).sort()).toEqual(["FA-CLM-001", "FA-CLM-003"]);
  });
  it("every real reader gets the plain cases right", () => {
    const r = runClaimCorpus(cases);
    expect(r.cases).toBe(5);
    expect(r.labelled).toBe(4);
    for (const s of r.scores) expect(s.accuracy, s.reader).toBe(1);
  });
  it("scores over- and under-matching against the labels, and finds readers wrong the same way", () => {
    const always: ProseReader = { kind: "referee", trap: "FA-CLM-001", jobs: ["x"], rules: "rules 0.6", name: "always", read: () => true };
    const never: ProseReader = { kind: "referee", trap: "FA-CLM-001", jobs: ["x"], rules: "rules 0.6", name: "never", read: () => false };
    const chk: ProseReader = { kind: "checker", trap: "FA-CLM-001", jobs: ["x"], rules: null, name: "chk", read: () => true };
    const r = runClaimCorpus(cases, [always, never, chk]);
    const by = Object.fromEntries(r.scores.map((s) => [s.reader, s]));
    expect(by.always).toMatchObject({ labelled: 2, correct: 1, over_matching: ["A2"], under_matching: [], unlabelled_read_as_claim: ["A3"] });
    expect(by.never).toMatchObject({ correct: 1, over_matching: [], under_matching: ["A1"] });
    const d = Object.fromEntries(r.disagreements.map((x) => [x.referee, x]));
    expect(d.always).toMatchObject({ differ: [], both_wrong_same_way: ["A2"] });
    expect(d.never).toMatchObject({ differ: ["A1", "A2", "A3"], both_wrong_same_way: [] });
  });
  it("refuses duplicate case ids", () => {
    expect(() => runClaimCorpus([cases[0]!, cases[0]!])).toThrow(/Duplicate/);
  });
});
