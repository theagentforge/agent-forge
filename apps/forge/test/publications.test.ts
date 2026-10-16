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
