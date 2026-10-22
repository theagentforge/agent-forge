import { describe, expect, it } from "vitest";
import { SIGNED_IN_TOOLS } from "../src/mcp";
import { PUBLIC_TOOLS } from "../src/mcp-public";
import { AGENT_DIRECTED } from "./wording";

// public-repo/forge-mcp is the MIT connection-files repo (ADR 0031): an Agent Plugins 1.0 package (plugin.json,
// mcp.json, skills/), a Gemini CLI extension (gemini-extension.json, GEMINI.md) and the Cursor plugin
// (.cursor-plugin/plugin.json, .mcp.json). ADR 0032 backlog items 3 and 10. It stays hook-free for OpenAI's directory.
// The folder isn't in the public code mirror (the glob finds nothing there), so each check passes empty there
// instead of being skipped (a test-count guard that fails on skipped tests stays green in both repos).

const PUBLIC_URL = "https://theagentforge.io/mcp/public";
const PREFIX = "../../../public-repo/forge-mcp/";
const raw = import.meta.glob<string>("../../../public-repo/forge-mcp/**/*", { eager: true, query: "?raw", import: "default", exhaustive: true });
const files: Record<string, string> = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.slice(PREFIX.length), v]));
const has = (path: string) => path.replace(/^\.\//, "") in files;
const json = (path: string) => JSON.parse(files[path] ?? "null") as Record<string, any>;

/** Every string value in a JSON document, with its path, for wording and URL checks. */
function strings(value: unknown, at = ""): [string, string][] {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${at}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
  return [];
}

const MANIFESTS = ["plugin.json", "mcp.json", ".mcp.json", ".cursor-plugin/plugin.json", "gemini-extension.json"];
const NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const present = has("README.md");
const check = (name: string, fn: () => void) => it(name, () => (present ? fn() : undefined));

describe("forge-mcp package", () => {
  check("has every manifest, each valid JSON", () => {
    for (const f of MANIFESTS) {
      expect(has(f), f).toBe(true);
      expect(() => JSON.parse(files[f]!), f).not.toThrow();
    }
  });

  check("plugin.json follows the closed Agent Plugins 1.0 manifest schema", () => {
    const m = json("plugin.json");
    expect(m.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(m.name).toMatch(NAME);
    expect(m.name.length).toBeLessThanOrEqual(64);
    const allowed = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
    expect(Object.keys(m).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(Object.keys(m.author).filter((k) => !["name", "email", "url"].includes(k))).toEqual([]);
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.license).toBe("MIT");
    // awesome-copilot's intake wants lowercase hyphenated keywords.
    for (const k of m.keywords) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const v of Object.values(m.extensions)) expect(typeof v).toBe("object");
  });

  check("mcp.json is the Agent Plugins format, with only the public server", () => {
    const m = json("mcp.json");
    expect(Object.keys(m).sort()).toEqual(["$schema", "mcpServers"]);
    expect(m.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(Object.values(m.mcpServers)).toEqual([{ type: "streamable-http", url: PUBLIC_URL }]);
  });

  check("the other clients' files point at the same public server", () => {
    expect(Object.values(json(".mcp.json").mcpServers)).toEqual([{ type: "http", url: PUBLIC_URL }]);
    const gemini = json("gemini-extension.json");
    expect(Object.values(gemini.mcpServers)).toEqual([{ httpUrl: PUBLIC_URL }]);
    // Every MCP URL anywhere in the package is the read-only one, never the signed-in /mcp.
    for (const f of MANIFESTS)
      for (const [at, s] of strings(json(f))) if (/theagentforge\.io\/mcp/.test(s)) expect(s, `${f}${at}`).toBe(PUBLIC_URL);
  });

  check("names and versions agree, and every referenced file exists", () => {
    const plugin = json("plugin.json");
    const cursor = json(".cursor-plugin/plugin.json");
    const gemini = json("gemini-extension.json");
    expect(gemini.name).toBe(plugin.name);
    expect(cursor.name).toBe(plugin.name);
    expect(new Set([plugin.version, cursor.version, gemini.version]).size).toBe(1);
    const refs = [cursor.logo, cursor.mcpServers, gemini.contextFileName, plugin.extensions["com.openai"].interface.logo];
    for (const r of refs) expect(has(r), r).toBe(true);
  });

  check("has no hooks, scripts or credentials (OpenAI's directory takes hook-free packages only)", () => {
    expect(Object.keys(files).filter((f) => /(^|\/)hooks(\/|\.json$)|\.(mjs|js|sh|py|exe)$/.test(f))).toEqual([]);
    for (const f of MANIFESTS) {
      const m = json(f);
      expect(m.hooks, f).toBeUndefined();
      for (const s of Object.values<Record<string, unknown>>(m.mcpServers ?? {})) {
        if (typeof s !== "object") continue;
        expect(s.headers, f).toBeUndefined();
        expect(s.env, f).toBeUndefined();
      }
    }
  });

  check("the OpenAI listing fields are filled in", () => {
    const ui = json("plugin.json").extensions["com.openai"].interface;
    for (const k of ["displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL", "privacyPolicyURL", "termsOfServiceURL", "logo"])
      expect(ui[k], k).toBeTruthy();
    expect(ui.displayName).not.toMatch(/\b(mcp|plugin)\b/i);
    for (const k of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL", "supportURL"]) expect(ui[k], k).toMatch(/^https:\/\//);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
  });

  check("each skill is a valid Agent Skill that names only tools that exist and no hook files", () => {
    const skills = Object.keys(files).filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f));
    expect(skills).toEqual(["skills/forge/SKILL.md"]);
    const known = new Set([...Object.keys(PUBLIC_TOOLS), ...Object.keys(SIGNED_IN_TOOLS)]);
    for (const f of skills) {
      const text = files[f]!;
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(/^name: (.+)$/m.exec(front)?.[1], f).toBe(f.split("/")[1]);
      expect(/^description: (.+)$/m.exec(front)?.[1]?.length ?? 0, f).toBeGreaterThan(20);
      expect(text, f).not.toMatch(/CLAUDE_PLUGIN_ROOT|hooks\/|strain\.mjs/);
      for (const tool of text.match(/\b(forge|arena)_[a-z_]+\b/g) ?? []) expect(known.has(tool), tool).toBe(true);
    }
  });

  check("GEMINI.md and the README describe every public tool", () => {
    for (const tool of Object.keys(PUBLIC_TOOLS)) {
      expect(files["GEMINI.md"], tool).toContain(`\`${tool}\``);
      expect(files["README.md"], tool).toContain(`\`${tool}\``);
    }
    expect(files["README.md"]).toContain("gemini extensions install https://github.com/theagentforge/forge-mcp");
  });

  check("what agents read is descriptive data, with no agent-directed wording", () => {
    const texts: [string, string][] = [
      ...MANIFESTS.flatMap((f) => strings(json(f)).map(([at, s]) => [`${f}${at}`, s] as [string, string])),
      ["GEMINI.md", files["GEMINI.md"]!],
      ["skills/forge/SKILL.md", files["skills/forge/SKILL.md"]!],
    ];
    for (const [where, text] of texts) expect(AGENT_DIRECTED.exec(text)?.[0] ?? null, where).toBeNull();
  });
});
