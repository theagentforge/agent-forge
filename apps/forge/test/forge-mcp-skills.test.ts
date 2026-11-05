import { describe, expect, it } from "vitest";
import checkSrc from "../../../integrations/skill/forge-check-before-install/SKILL.md";
import gauntletSrc from "../../../integrations/skill/forge-run-the-gauntlet/SKILL.md";

// Build list 4 Nov, item 9: skills.sh (`npx skills add theagentforge/forge-mcp`) finds skills at skills/<name>/SKILL.md.
// The forge-mcp repo carries our two public Agent Skills there as exact copies of integrations/skill, so the copies can't
// drift from what /.well-known/agent-skills serves. public-repo/ isn't in the public code mirror (the glob finds nothing
// there), so each check passes empty there, like test/forge-mcp-package.test.ts.

const raw = import.meta.glob<string>("../../../public-repo/forge-mcp/skills/*/SKILL.md", { eager: true, query: "?raw", import: "default" });
const copies = Object.fromEntries(Object.entries(raw).map(([p, t]) => [p.replace("../../../public-repo/forge-mcp/", ""), t]));
const present = Object.keys(copies).length > 0;

const nameOf = (md: string) => /^---\nname: ([a-z0-9-]+)\n/.exec(md)?.[1];

describe("forge-mcp skills layout", () => {
  it("carries exact copies of the public Agent Skills", () => {
    if (!present) return;
    expect(copies["skills/forge-check-before-install/SKILL.md"]).toBe(checkSrc);
    expect(copies["skills/forge-run-the-gauntlet/SKILL.md"]).toBe(gauntletSrc);
  });

  it("names each skill after its folder, as the skills installer expects", () => {
    if (!present) return;
    for (const [path, text] of Object.entries(copies)) expect(nameOf(text), path).toBe(path.split("/")[1]);
    expect(Object.keys(copies).sort()).toEqual(["skills/forge-check-before-install/SKILL.md", "skills/forge-run-the-gauntlet/SKILL.md", "skills/forge/SKILL.md"]);
  });
});
