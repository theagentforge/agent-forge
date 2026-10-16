import { describe, expect, it } from "vitest";
import css from "../public/site.css?raw";

// Guards the visual system (docs/design/AUDIT-2026-10.md): one 6-step type scale, 4 weights, no mid-word breaks.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("design system", () => {
  it("uses only the type-scale tokens for font sizes", () => {
    const sizes = [...rules.matchAll(/font-size:([^;}]+)/g)].map((m) => m[1]!.trim());
    const fontShorthand = [...rules.matchAll(/font:\s*\d{3}\s+([^/\s]+)/g)].map((m) => m[1]!.trim());
    for (const s of [...sizes, ...fontShorthand]) expect(s, `font size "${s}" is off the scale`).toMatch(/^var\(--fs-(xs|sm|md|lg|xl|2xl|hero)\)$/);
  });
  it("uses at most four font weights", () => {
    const weights = new Set([...rules.matchAll(/font-weight:(\d{3})|font:\s*(\d{3})\s/g)].map((m) => m[1] ?? m[2]));
    expect(weights.size).toBeLessThanOrEqual(4);
  });
  it("never lets headings or table cells split a word mid-word", () => {
    expect(rules).not.toMatch(/(h1|h2|h3|td|th)[^{]*\{[^}]*overflow-wrap:anywhere/);
  });
});
