import { describe, expect, it } from "vitest";
import { htmlToMarkdown, prefersMarkdown } from "../src/web/markdown";
import { fetchWorker } from "./helpers";
import "../src/index";

describe("Markdown for agents (agent readiness)", () => {
  it("negotiates like Cloudflare's convention: Markdown only when preferred, never for */* or browsers", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.9")).toBe(true);
    expect(prefersMarkdown("text/*")).toBe(true);
    expect(prefersMarkdown("text/markdown, */*")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown")).toBe(false);
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
    expect(prefersMarkdown(undefined)).toBe(false);
  });

  it("converts the main content: headings, links made absolute, lists, tables, code; drops scripts and nav", () => {
    const md = htmlToMarkdown(
      `<html><head><title>Stats · The Agent Forge</title><meta name="description" content="Live &amp; honest"></head><body><nav><a href="/x">menu</a></nav><main><h1>Stats</h1><p>Hello <strong>agents</strong> &amp; <a href="/scan?from=a">scan</a>.</p><script>alert(1)</script><ul><li>one</li><li>two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table><pre><code>npx x</code></pre></main></body></html>`,
      "https://theagentforge.io/stats",
    );
    expect(md).toMatch(/^---\ntitle: "Stats · The Agent Forge"\ndescription: "Live & honest"\nurl: https:\/\/theagentforge.io\/stats\n---/);
    expect(md).toContain("# Stats");
    expect(md).toContain("Hello **agents** & [scan](https://theagentforge.io/scan?from=a).");
    expect(md).toContain("- one\n- two");
    expect(md).toContain("| A | B |\n| --- | --- |\n| 1 | 2\\|3 |");
    expect(md).toContain("```\nnpx x\n```");
    expect(md).not.toMatch(/alert|menu|<\w/);
  });

  it("serves real pages as Markdown on request, with Vary, Content-Signal and discovery Links; HTML stays the default", async () => {
    const md = await fetchWorker("/methodology?t=md", { headers: { Accept: "text/markdown" } });
    expect(md.status).toBe(200);
    expect(md.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("Vary")).toContain("Accept");
    expect(md.headers.get("Content-Signal")).toBe("search=yes, ai-input=yes, ai-train=no");
    const body = await md.text();
    expect(body).toMatch(/^---\ntitle: /);
    expect(body).not.toContain("<div");
    const html = await fetchWorker("/methodology?t=md", { headers: { Accept: "text/html" } });
    expect(html.headers.get("Content-Type")).toContain("text/html");
    expect(html.headers.get("Link")).toContain('</.well-known/api-catalog>; rel="api-catalog"');
    expect(html.headers.get("Link")).toContain('</mcp/public/server-card>; rel="service-desc"');
  });

  it("publishes an RFC 9727 API catalog linking each API to what describes it", async () => {
    const res = await fetchWorker("/.well-known/api-catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe('application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
    const j = (await res.json()) as { linkset: { anchor: string; "service-desc": { href: string }[] }[] };
    expect(j.linkset.map((e) => new URL(e.anchor).pathname)).toEqual(["/mcp/public", "/mcp/gauntlet", "/a2a", "/api/v1"]);
    expect(j.linkset[0]!["service-desc"][0]!.href).toMatch(/\/mcp\/public\/server-card$/);
  });
});

describe("OpenAI plugin directory domain check", () => {
  it("serves the stored token as plain text, and 404 until one is stored", async () => {
    const { env } = await import("cloudflare:workers");
    const { OPENAI_CHALLENGE_KEY } = await import("../src/web/discovery");
    expect((await fetchWorker("/.well-known/openai-apps-challenge")).status).toBe(404);
    await env.KV.put(OPENAI_CHALLENGE_KEY, "abc123-TOKEN_x.y");
    const res = await fetchWorker("/.well-known/openai-apps-challenge");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123-TOKEN_x.y");
    await env.KV.put(OPENAI_CHALLENGE_KEY, "<script>");
    expect((await fetchWorker("/.well-known/openai-apps-challenge")).status).toBe(404);
  });
});
