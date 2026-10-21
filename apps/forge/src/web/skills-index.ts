import skillMd from "../../public/skill.md";
import beforeInstallMd from "../../../../integrations/skill/forge-check-before-install/SKILL.md";
import { site } from "./pages";

// Skills discovery (docs/launch/agent-channels.md §4.3): `npx skills add https://theagentforge.io` and other installers
// read /.well-known/agent-skills/index.json (Cloudflare's Agent Skills Discovery RFC, schema 0.2.0) or the older
// /.well-known/skills/index.json. Each skill is one self-contained SKILL.md served from this origin, and its digest
// is computed over exactly the bytes served here, so an installer can verify its copy.

export const SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
export const SKILLS = [
  { name: "forge-check-before-install", text: beforeInstallMd },
  { name: "forge-check", text: skillMd },
] as const;

/** The `description` from a SKILL.md's YAML front matter (single line, as ours are written). */
export function frontMatterDescription(md: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  return /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "";
}

export async function digestOf(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function agentSkillsIndex() {
  return {
    $schema: SKILLS_SCHEMA,
    skills: await Promise.all(
      SKILLS.map(async (s) => ({ name: s.name, type: "skill-md", description: frontMatterDescription(s.text), url: `/.well-known/agent-skills/${s.name}/SKILL.md`, digest: await digestOf(s.text) })),
    ),
  };
}

const HEADERS = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" };

// Fetches of the indexes and files are counted in the site middleware, before the cache (usage.ts discoveryCounters).
site.get("/.well-known/agent-skills/index.json", async (c) => c.json(await agentSkillsIndex(), 200, HEADERS));

// The older layout (used by Mintlify sites and earlier installers): names plus file lists, files under the same path.
site.get("/.well-known/skills/index.json", (c) =>
  c.json({ skills: SKILLS.map((s) => ({ name: s.name, description: frontMatterDescription(s.text), files: ["SKILL.md"] })) }, 200, HEADERS),
);

for (const prefix of ["/.well-known/agent-skills", "/.well-known/skills"])
  site.get(`${prefix}/:name/SKILL.md`, (c) => {
    const s = SKILLS.find((x) => x.name === c.req.param("name"));
    if (!s) return c.text("Not found", 404);
    return c.body(s.text, 200, { ...HEADERS, "Content-Type": "text/markdown; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  });
