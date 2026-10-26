import { describe, expect, it } from "vitest";
import { looksLikeSkillLink } from "../src/web/scan";
import { fetchWorker } from "./helpers";
import "../src/index";

// Conversion review (24 Oct 2026): one box on the home page for anything, the Claude Code plugin first on /connect,
// and the "every install" step offered after a check.

const go = (q: string) =>
  fetchWorker("/go", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.91" }, body: new URLSearchParams({ q, from: "home-box" }).toString(), redirect: "manual" });

describe("the one box", () => {
  it("tells skill links from packages and repositories", () => {
    for (const s of ["https://clawhub.ai/acme/skills/weather", "https://github.com/acme/skills/blob/main/weather/SKILL.md", "https://github.com/acme/repo/tree/main/skills/x", "https://gist.github.com/a/b"]) expect(looksLikeSkillLink(s), s).toBe(true);
    for (const s of ["npm:express", "pypi:litellm", "https://github.com/modelcontextprotocol/servers", "litellm", "not a url"]) expect(looksLikeSkillLink(s), s).toBe(false);
  });

  it("sends a package or repository to the check page, and a link it can't read to the check page too", async () => {
    for (const q of ["npm:express", "https://github.com/modelcontextprotocol/servers", "https://evil.example/skill.md"]) {
      const res = await go(q);
      expect(res.status, q).toBe(303);
      expect(res.headers.get("Location"), q).toBe(`/check?q=${encodeURIComponent(q)}&from=home-box`);
    }
    const empty = await go("");
    expect(empty.headers.get("Location")).toBe("/scan");
  });

  it("is on the home page above the fold, posting to /go", async () => {
    const html = await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain('action="/go"');
    expect(html.indexOf('action="/go"')).toBeLessThan(html.indexOf('id="arena"') > 0 ? html.indexOf('id="arena"') : html.length);
  });

  it("the check page offers the every-install step", async () => {
    const html = await (await fetchWorker("/check?q=npm%3Aexpress", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("/connect?from=check");
  });
});

describe("/connect", () => {
  it("opens with the Claude Code plugin, which checks every install by itself", async () => {
    const html = await (await fetchWorker("/connect", { headers: { Accept: "text/html" } })).text();
    const plugin = html.indexOf("/plugin install forge@theagentforge");
    expect(plugin).toBeGreaterThan(0);
    expect(plugin).toBeLessThan(html.indexOf("Any AI app or agent"));
  });

  it("gives Codex, Gemini CLI and Copilot CLI the install hook from the published CLI", async () => {
    const html = await (await fetchWorker("/connect", { headers: { Accept: "text/html" } })).text();
    for (const c of ["codex", "gemini", "copilot"]) expect(html).toContain(`npx -y @theagentforge/cli hook --print-config ${c}`);
  });
});
