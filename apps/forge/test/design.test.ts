import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

// Guards the visual system (docs/design/AUDIT-2026-10.md; BRAND.md §7 v1.3, site audit 29 Oct): one type scale of
// tokens, a 13 px reading floor (12 px only for short mono tags), sentence case, no mid-word breaks. It reads site.css
// as served (a ?raw import of CSS is stubbed out by the test config, which left the older version of this test empty).
let rules = "";
beforeAll(async () => {
  const css = await (await env.ASSETS.fetch("https://assets.local/site.css")).text();
  expect(css.length).toBeGreaterThan(10_000);
  rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
});
const px = (rem: string) => parseFloat(rem) * 16;
const token = (name: string) => new RegExp(`--${name}:([0-9.]+)rem`).exec(rules)?.[1];

describe("design system", () => {
  it("uses only the type-scale tokens for font sizes, never a pixel or em value", () => {
    const sizes = [...rules.matchAll(/font-size:([^;}]+)/g)].map((m) => m[1]!.trim());
    const fontShorthand = [...rules.matchAll(/font:\s*\d{3}\s+([^/\s]+)/g)].map((m) => m[1]!.trim());
    expect(sizes.length + fontShorthand.length).toBeGreaterThan(50);
    for (const s of [...sizes, ...fontShorthand]) expect(s, `font size "${s}" is off the scale`).toMatch(/^var\(--fs-(tag|xs|sm|md|lg|xl|2xl|hero)\)$/);
  });
  it("keeps reading text at 13 px or more, and only the tag step at 12 px (BRAND §7, 29 Oct)", () => {
    expect(px(token("fs-xs")!)).toBe(13);
    expect(px(token("fs-tag")!)).toBe(12);
    expect(px(token("fs-sm")!)).toBe(14);
    expect(px(token("fs-md")!)).toBe(16);
    // The 12 px step is for short all-caps mono tags only.
    const tagUsers = [...rules.matchAll(/([^{}]+)\{[^}]*var\(--fs-tag\)/g)].map((m) => m[1]!.trim());
    for (const sel of tagUsers) expect(sel, sel).toMatch(/\.label|\.tag|\.stamp|\.vs/);
  });
  it("sets eyebrows, table heads and the live pill in sentence case (no text-transform)", () => {
    for (const sel of [".eyebrow", ".table th", ".live-pill", ".theme-toggle", ".link-group-title"]) {
      const block = new RegExp(`(^|\\})${sel.replace(/[.]/g, "\\.")}\\{([^}]*)\\}`, "m").exec(rules);
      expect(block, sel).not.toBeNull();
      expect(block![2], sel).not.toContain("text-transform");
    }
  });
  it("draws the live pill in neutral text with a Blue Flame dot, not the Flagged red (BRAND §6.1)", () => {
    expect(rules).toMatch(/\.live-pill\{[^}]*color:var\(--text\)/);
    expect(rules).toMatch(/\.live-pill i\{[^}]*background:var\(--brand\)/);
  });
  it("uses at most five font weights (BRAND §7: 400, 500, 600 for text; 700, 800 for display)", () => {
    const weights = new Set([...rules.replace(/@font-face\{[^}]*\}/g, "").matchAll(/font-weight:(\d{3})|font:\s*(\d{3})\s/g)].map((m) => m[1] ?? m[2]));
    expect([...weights].every((w) => ["400", "500", "600", "700", "800"].includes(w!))).toBe(true);
  });
  it("never lets headings or table cells split a word mid-word", () => {
    expect(rules).not.toMatch(/(^|[},\s])(h1|h2|h3|td|th)(\s|\.|\[|:|,)[^{]*\{[^}]*overflow-wrap:anywhere/m);
  });
});
