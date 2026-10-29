import { scanSkill } from "@forge/shared";
import { describe, expect, it } from "vitest";
import { digestOf, SKILLS, SKILLS_SCHEMA } from "../src/web/skills-index";
import { fetchWorker } from "./helpers";
import "../src/index";

// Skills discovery (agent-channels §4.3): both index layouts, digests over the served bytes, and skills that are
// self-contained: they pass our own scanner and never send an agent to fetch instructions.

describe("the skills discovery index", () => {
  it("serves the RFC 0.2.0 index, with each digest matching the bytes served at its url", async () => {
    const res = await fetchWorker("/.well-known/agent-skills/index.json");
    expect(res.status).toBe(200);
    const idx = (await res.json()) as { $schema: string; skills: { name: string; type: string; description: string; url: string; digest: string }[] };
    expect(idx.$schema).toBe(SKILLS_SCHEMA);
    expect(idx.skills.map((s) => s.name)).toEqual(["forge-check-before-install", "forge-check", "forge-run-the-gauntlet"]);
    for (const s of idx.skills) {
      expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.type).toBe("skill-md");
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.description.length).toBeLessThanOrEqual(1024);
      const file = await fetchWorker(s.url);
      expect(file.headers.get("Content-Type")).toContain("text/markdown");
      expect(await digestOf(await file.text())).toBe(s.digest);
    }
  });

  it("serves the older layout too", async () => {
    const idx = (await (await fetchWorker("/.well-known/skills/index.json")).json()) as { skills: { name: string; files: string[] }[] };
    expect(idx.skills.map((s) => [s.name, s.files])).toEqual([["forge-check-before-install", ["SKILL.md"]], ["forge-check", ["SKILL.md"]], ["forge-run-the-gauntlet", ["SKILL.md"]]]);
    expect((await fetchWorker("/.well-known/skills/forge-check-before-install/SKILL.md")).status).toBe(200);
    expect((await fetchWorker("/.well-known/agent-skills/nope/SKILL.md")).status).toBe(404);
  });
});

describe("the skills themselves", () => {
  it("pass the Forge's own scanner and point only at theagentforge.io", async () => {
    for (const s of SKILLS) {
      expect((await scanSkill(s.text)).verdict, s.name).toBe("clear");
      const hosts = [...s.text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
      for (const h of hosts) expect(["theagentforge.io", "github.com", "clawhub.ai"], `${s.name}: ${h}`).toContain(h);
    }
  });

  it("the before-install skill says it never fetches instructions, and has no timer or heartbeat", () => {
    const s = SKILLS[0]!.text;
    expect(s).toContain("It never fetches instructions from anywhere");
    expect(s).not.toMatch(/heartbeat|every (day|hour|week)|once a week|cron/i);
    expect(s).toMatch(/^---\nname: forge-check-before-install\n/);
  });
});
