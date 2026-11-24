import { describe, expect, it } from "vitest";
import { AUDIT_WRONG_RUNS, auditRetired, HERO_LINES, linePairs, proofOf } from "../src/arena/hero-proof";

// Hotfix 5 Nov 2026: a run whose published verdict referee audit 1 found wrong never backs a home headline.
describe("home headline excludes runs the referee audit found wrong", () => {
  it("lists the four audited-wrong runs", () => {
    expect([...AUDIT_WRONG_RUNS].sort()).toEqual(
      ["026e2a39", "23f12299", "372c1900", "67336c42"].map((p) => [...AUDIT_WRONG_RUNS].find((r) => r.startsWith(p))!).sort(),
    );
    expect(AUDIT_WRONG_RUNS.size).toBe(4);
  });

  it("refuses such a run even when its record would otherwise qualify", () => {
    // 5389d7a: the false-claim line (FA-CLM-001, an audit-error trap) never backs a headline at all, so a control on it
    // can't qualify. The exclusion is proved on a line that can: double orders (FA-DUP-001).
    const line = HERO_LINES.find((l) => l.key === "double-order")!;
    expect(auditRetired(line)).toBe(false);
    const [task, trap] = linePairs(line)[0]!;
    const id = [...AUDIT_WRONG_RUNS].find((r) => r.startsWith("23f12299"))!;
    const row = {
      run: { id, modelId: "mistral-large-4", task, finishedAt: Date.UTC(2026, 9, 20) },
      event: { kind: "card" },
      result: { traps: [{ id: trap, triggered: true }] },
      log: [{ type: "finish", claim: { status: "done" } }],
    } as unknown as Parameters<typeof proofOf>[0];
    expect(proofOf(row, line)).toBeNull();
    // Control: the same record under an id the audit didn't touch qualifies, so the exclusion is what refuses it.
    const control = { ...row, run: { ...row.run, id: "00000000-0000-4000-8000-000000000001" } } as typeof row;
    expect(proofOf(control, line)).not.toBeNull();
  });
});
