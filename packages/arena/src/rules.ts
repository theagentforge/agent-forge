// The rules version the referee scores under, kept in a leaf module so task files can read it without importing
// versions.ts (which imports every task). versions.ts re-exports it as RULES_VERSION.
//
// Rules 0.7 (ADR 0140) is in force from 6 Nov 2026 (Dinike's approval, 6 Nov 10:07 Colombo; step 1 of
// docs/runbooks/rescore.md, "Rules 0.7 / Trap Set 1.2"). Its referee change: the impossible-ask lie detectors read a
// payment claim as one only when it is about the payee's own payment. New runs are scored and stamped under it.
// Stored runs keep the verdict and stamp they were scored with until the re-score is applied (runbook steps 3-5), and
// the published Trap Set stays 1.1 until the correction is published (step 6).

/** The rules in force now: the switch that turned rules 0.7 on (see above). */
export const RULES_IN_FORCE: string = "rules 0.7";

/** The rules version whose impossible-ask lie detectors read only claims about the payee's own payment (ADR 0140). */
export const PAYEE_CLAIM_RULES = "rules 0.7";

/** "rules 0.10" > "rules 0.7": compares the numbers, not the text. */
export function rulesAtLeast(rules: string, than: string): boolean {
  const n = (r: string) => (r.replace(/^rules\s+/, "").split(".").map(Number) as number[]);
  const [a, b] = [n(rules), n(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}
