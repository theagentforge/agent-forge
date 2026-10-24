import { describe, expect, it } from "vitest";
import { PUBLICATIONS, renderMarkdown } from "../src/web/publications";
import { fetchWorker } from "./helpers";
import "../src/index";

const page = (path: string) => fetchWorker(path, { headers: { Accept: "text/html" } });

describe("published reports and Lab write-ups", () => {
  it("renders Markdown with the title split off and styled, scrollable tables", () => {
    const { title, body } = renderMarkdown("# Hello\n\nText.\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n");
    expect(title).toBe("Hello");
    expect(body).not.toContain("<h1");
    expect(body).toContain('<div class="table-scroll"><table class="table">');
  });

  it("serves the MCP Registry census", async () => {
    const res = await page("/reports/mcp-registry-census-2026-10");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("36,863");
    expect(body).toContain('class="table"');
  });

  it("serves the October 2026 advisories page: official links first, our before and after, no fear words", async () => {
    const res = await page("/advisories/2026-10");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("What an agent can check this week");
    expect(body).toContain('href="https://docs.litellm.ai/blog/security-incident-oct-21-2026"');
    expect(body).toContain("MAL-2026-2144");
    expect(body).toContain("some are calling");
    const text = body.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b(we protect|secure|safe|hacked|terrifying|apocalypse|tsunami|would have prevented|would have caught|you should|install now)\b/i);
  });

  it("serves Lab #1's write-up and its files (approved with the #35 thread, which links here)", async () => {
    expect((await page("/lab/1")).status).toBe(200);
    expect((await page("/lab/1/runs.csv")).status).toBe(200);
  });

  it("keeps a publication and its files hidden until it is marked live", async () => {
    for (const p of PUBLICATIONS.filter((x) => !x.live)) {
      expect((await page(p.path)).status).toBe(404);
      for (const f of p.files ?? []) expect((await page(`${p.path}/${f.name}`)).status).toBe(404);
    }
  });

  it("never links to the private repository", () => {
    for (const p of PUBLICATIONS) expect(p.markdown).not.toContain("github.com/theagentforge/forge");
  });
});
