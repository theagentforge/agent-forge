import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

// The ChatGPT/Codex Plugins Directory checks these on upload (OpenAI "Submit and publish your plugin", read 29 Oct
// 2026). Each limit is pinned here so a later edit can't fail the upload.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const zipName = readdirSync(join(root, "release")).find((f) => f.endsWith(".zip"));
const zip = unzipSync(new Uint8Array(readFileSync(join(root, "release", zipName))));
const manifest = JSON.parse(new TextDecoder().decode(zip[".codex-plugin/plugin.json"]));
const mcp = JSON.parse(new TextDecoder().decode(zip[".mcp.json"]));
const ui = manifest.interface;
const review = manifest.extensions["com.openai"].review;

/** WCAG relative luminance of #RRGGBB, for OpenAI's brand colour contrast rule. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("the OpenAI plugin ZIP", () => {
  it("is current, and the same bytes in every time zone", () => {
    for (const tz of ["UTC", "Asia/Colombo", "Pacific/Kiritimati"]) {
      const out = execFileSync(process.execPath, [join(root, "build.mjs"), "--check"], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
      expect(out).toContain("up to date");
    }
  }, 60_000);

  it("holds only the Codex manifest, one MCP config and the two icons: no hooks, skills or app references", () => {
    expect(Object.keys(zip).sort()).toEqual([".codex-plugin/plugin.json", ".mcp.json", "assets/icon.png", "assets/logo.png"]);
    expect(zipName).toBe(`the-agent-forge-openai-${manifest.version}.zip`);
    expect(manifest).not.toHaveProperty("hooks");
    expect(manifest).not.toHaveProperty("apps");
  });

  it("connects exactly one server: the read-only, no-sign-in /mcp/public", () => {
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(mcp).toEqual({ mcpServers: { forge: { url: "https://theagentforge.io/mcp/public" } } });
  });

  it("keeps every listing field inside OpenAI's limits", () => {
    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(manifest.name.length).toBeLessThanOrEqual(64);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description.length).toBeLessThanOrEqual(4000);
    expect(manifest.author.name.length).toBeLessThanOrEqual(120);
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.category).toBeTruthy();
    expect(ui.capabilities.length).toBeLessThanOrEqual(20);
    for (const c of ui.capabilities) expect(c.length).toBeLessThanOrEqual(120);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const p of ui.defaultPrompt) expect(p.length).toBeLessThanOrEqual(128);
    // All four links are required for an MCP app in public review, HTTPS, at most 1,024 characters.
    for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(ui[k]).toMatch(/^https:\/\/theagentforge\.io(\/|$)/);
      expect(ui[k].length).toBeLessThanOrEqual(1024);
    }
    // The directory name comes from Dinike's verified identity; developerName is set in the dashboard, not here.
    expect(ui).not.toHaveProperty("developerName");
  });

  it("uses brand colours with at least 2:1 contrast (light against white, dark against #212121)", () => {
    expect(ui.brandColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(contrast(ui.brandColor, "#FFFFFF")).toBeGreaterThanOrEqual(2);
    expect(contrast(ui.brandColorDark, "#212121")).toBeGreaterThanOrEqual(2);
  });

  it("ships square PNG icons of at least 48 px and at most 5 MiB, where the manifest says", () => {
    for (const k of ["logo", "composerIcon"]) {
      const bytes = zip[ui[k].replace(/^\.\//, "")];
      expect(bytes, k).toBeDefined();
      expect(Buffer.from(bytes.slice(1, 4)).toString()).toBe("PNG");
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const [w, h] = [view.getUint32(16), view.getUint32(20)];
      expect(w).toBe(h);
      expect(w).toBeGreaterThanOrEqual(48);
      expect(w).toBeLessThanOrEqual(4096);
      expect(bytes.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
  });

  it("has exactly 5 positive and 3 negative review cases, naming only tools that /mcp/public serves", () => {
    const tools = new Set(["forge_check", "forge_scan", "forge_watch", "forge_exposure", "forge_traps", "arena_results"]);
    expect(review.test_cases.positive).toHaveLength(5);
    expect(review.test_cases.negative).toHaveLength(3);
    for (const c of review.test_cases.positive) {
      expect(c.description && c.prompt && c.expected_behavior).toBeTruthy();
      for (const t of c.tools_triggered.split(",").map((s) => s.trim())) expect(tools.has(t), t).toBe(true);
    }
    for (const c of review.test_cases.negative) expect(Object.keys(c).sort()).toEqual(["description", "prompt"]);
    // Reviewer access and the demo video go in the dashboard: the ZIP rejects credentials and reviewer instructions,
    // and leaving the video URL out lets Dinike paste it there.
    expect(review).not.toHaveProperty("test_credentials");
    expect(review).not.toHaveProperty("reviewer_instructions");
    expect(review).not.toHaveProperty("demo_recording_url");
    expect(review.commerce).toBe(false);
  });

  it("makes no promotional claims the review criteria forbid", () => {
    const text = JSON.stringify(manifest).toLowerCase();
    for (const banned of ["free", "discount", "trial", "best-in-class", "the best", "#1", "official"]) expect(text, banned).not.toContain(banned);
  });
});
