import { describe, expect, it } from "vitest";
import { displayVerdict, verdictLine, type VerdictInput } from "../src/index";

const base: VerdictInput = {
  known: true,
  tool: { id: "github.com/acme/pdf-tools" },
  version: "1.4.2",
  forge_score: 87,
  distinct_owners: 41,
  verified_owners: 30,
  security_status: "clear",
  page_url: "https://theagentforge.io/t/github.com%2Facme%2Fpdf-tools",
};

describe("verdict strings", () => {
  it("clear", () => {
    expect(verdictLine(base)).toBe(
      "[F✓] · clear · Forge Score 87 · 41 independent agents · github.com/acme/pdf-tools@1.4.2 · theagentforge.io/t/github.com%2Facme%2Fpdf-tools",
    );
  });
  it("is honest when there are too few reports", () => {
    expect(displayVerdict({ security_status: "clear", forge_score: null })).toBe("insufficient");
    expect(verdictLine({ ...base, forge_score: null, distinct_owners: 2 })).toContain("[F–] · not enough reports yet (2 of 5)");
  });
  it("flagged and caution never show as clear", () => {
    expect(verdictLine({ ...base, security_status: "flagged", verified_owners: 3 })).toContain(
      "[F⚑] · flagged · 3 independent verified agents reported a security issue",
    );
    expect(verdictLine({ ...base, security_status: "caution" })).toContain("[F!] · caution");
  });
  it("advisories_checked false (ADR 0152): the verdict comes from the reports, and the line says the advisories weren't checked", () => {
    expect(verdictLine({ ...base, advisories_checked: false })).toBe(
      "[F✓] · clear · Forge Score 87 · 41 independent agents · github.com/acme/pdf-tools@1.4.2 · advisories not checked · theagentforge.io/t/github.com%2Facme%2Fpdf-tools",
    );
    expect(verdictLine({ ...base, advisories_checked: false, forge_score: null, distinct_owners: 1 })).toContain("not enough reports yet (1 of 5) · github.com/acme/pdf-tools@1.4.2 · advisories not checked");
    // Checked, or an answer from before the field existed: unchanged.
    expect(verdictLine({ ...base, advisories_checked: true })).not.toContain("advisories not checked");
    expect(verdictLine(base)).not.toContain("advisories not checked");
    // A flag is said as before.
    expect(verdictLine({ ...base, advisories_checked: false, security_status: "caution" })).not.toContain("advisories not checked");
  });
  it("unknown tools", () => {
    expect(verdictLine({ ...base, known: false, tool: null })).toBe(
      "[F–] · not enough reports yet (0 of 5) · unknown tool · no field reports yet",
    );
  });
});
