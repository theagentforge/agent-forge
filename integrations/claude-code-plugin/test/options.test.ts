import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPTION_ENV, optionOn } from "../src/hooks/common";

// Directory review (22 Oct): reading our own CLAUDE_PLUGIN_OPTION_* settings was held as "Uses a credential from the
// user's machine". The hooks name each setting in full and read nothing else of that kind (REVIEWERS.md).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"));

describe("plugin settings", () => {
  it("map one-to-one onto the boolean userConfig switches in plugin.json", () => {
    const keys = Object.keys(manifest.userConfig).map((k) => k.toUpperCase());
    expect([...Object.keys(OPTION_ENV), "LINK_PROMPT"].sort()).toEqual(keys.sort());
    for (const [k, v] of Object.entries(OPTION_ENV)) expect(v).toBe(`CLAUDE_PLUGIN_OPTION_${k}`);
    for (const opt of Object.values(manifest.userConfig) as { type: string; sensitive?: boolean }[]) {
      expect(opt.type).toBe("boolean");
      expect(opt.sensitive).toBeUndefined();
    }
  });

  it("default to on, and only the text false turns one off", () => {
    expect(optionOn("NUDGE", {})).toBe(true);
    expect(optionOn("NUDGE", { CLAUDE_PLUGIN_OPTION_NUDGE: "FALSE" })).toBe(false);
    expect(optionOn("NUDGE", { CLAUDE_PLUGIN_OPTION_NUDGE: "0" })).toBe(true);
    expect(optionOn("TRAP_CARD", { CLAUDE_PLUGIN_OPTION_NUDGE: "false" })).toBe(true);
  });

  it("are not read through a computed environment name in the built hooks", () => {
    for (const hook of ["pre-install", "strain", "session-start"]) {
      const js = readFileSync(join(root, "release", "forge", "hooks", `${hook}.mjs`), "utf8");
      expect(js).not.toMatch(/process\.env\[`/);
      expect(js).not.toMatch(/CLAUDE_PLUGIN_OPTION_\$\{/);
    }
  });
});

describe("plugin.json directory links", () => {
  it("names the privacy, terms, support and documentation pages (read by the plugin directory's checks)", () => {
    expect(manifest).toMatchObject({
      privacyPolicyUrl: "https://theagentforge.io/privacy",
      termsOfServiceUrl: "https://theagentforge.io/terms",
      supportUrl: "https://theagentforge.io/about",
      documentationUrl: "https://theagentforge.io/connect",
      author: { name: "The Agent Forge", email: "hello@theagentforge.io" },
    });
  });
});

// ADR 0121 (29 Oct): renamed from `forge` (a different community plugin has that name). The identity changes; the
// analytics labels don't.
describe("plugin identity (ADR 0121 rename)", () => {
  it("is named theagentforge, shown as The Agent Forge, from 0.8.0", () => {
    expect(manifest.name).toBe("theagentforge");
    expect(manifest.displayName).toBe("The Agent Forge");
    const [major, minor] = String(manifest.version).split(".").map(Number);
    expect(major! > 0 || minor! >= 8).toBe(true);
    expect(manifest.description).toContain("/theagentforge:sprint");
    expect(manifest.description).toContain("/theagentforge:gauntlet");
    expect(manifest.description).not.toMatch(/\/forge:/);
  });

  it("keeps the User-Agent the Worker counts as the plugin client, in the source and the built hooks", () => {
    for (const f of ["src/hooks/pre-install.ts", "src/hooks/session-start.ts", "release/forge/hooks/pre-install.mjs", "release/forge/hooks/session-start.mjs"]) {
      expect(readFileSync(join(root, f), "utf8"), f).toContain('"theagentforge-claude-plugin"');
    }
  });

  it("the README tells existing forge@theagentforge users how to move to the new name", () => {
    const readme = readFileSync(join(root, "plugin", "README.md"), "utf8");
    expect(readme).toContain("/plugin install theagentforge@theagentforge");
    expect(readme).toContain("/plugin uninstall forge@theagentforge");
    expect(readme).not.toMatch(/(^|[^a-z])\/forge:/m);
  });
});

describe("old forge zips (ADR 0121)", () => {
  it("stay published byte for byte next to the new ones, listed under legacy in the manifest", () => {
    const dir = join(root, "..", "..", "apps", "forge", "public", "plugins");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m.name).toBe("theagentforge");
    for (const env of ["staging", "production"]) expect(m.files[env].file).toMatch(new RegExp(`^theagentforge-${env}-`));
    const old = m.legacy.forge;
    expect(Object.keys(old.files).sort()).toEqual(["production", "staging"]);
    for (const { file, sha256 } of Object.values(old.files) as { file: string; sha256: string }[]) {
      expect(createHash("sha256").update(readFileSync(join(dir, file))).digest("hex"), file).toBe(sha256);
    }
  });
});
