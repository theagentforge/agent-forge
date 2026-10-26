import { describe, expect, it } from "vitest";
import { CITATION_QUESTIONS, citedDomains, runCitations, TOP_DOMAINS } from "../src/ops/citations";

// Issue #234: the weekly citation check keeps which domains each answer cited (top 10), from the same reply, so we can
// compare the pages answer engines cite with ours. No extra model calls.

const perplexity = (citations: string[]) => ({ citations, choices: [{ message: { content: "Answer." } }], usage: { cost: 0.001 } });

describe("cited domains", () => {
  it("keeps hostnames without www, most-cited first, ties in citation order, at most ten", () => {
    const body = perplexity([
      "https://www.reddit.com/r/mcp/1",
      "https://github.com/a/b",
      "https://github.com/c/d",
      "https://snyk.io/blog/x",
      "https://GitHub.com/e/f",
      "https://reddit.com/r/mcp/2",
    ]);
    expect(citedDomains(body)).toEqual(["github.com", "reddit.com", "snyk.io"]);
    const many = perplexity(Array.from({ length: 14 }, (_, i) => `https://site${i}.example.com/page`));
    expect(citedDomains(many)).toHaveLength(TOP_DOMAINS);
    expect(citedDomains(many)[0]).toBe("site0.example.com");
  });

  it("reads web-plugin annotations too, counts a URL once and drops anything that isn't a plain hostname", () => {
    const body = {
      citations: ["https://docs.example.org/a", "not a url", "javascript:alert(1)", "https://[::1]/x"],
      choices: [{ message: { content: "x", annotations: [{ type: "url_citation", url_citation: { url: "https://docs.example.org/a" } }, { type: "url_citation", url_citation: { url: "https://owasp.org/x" } }] } }],
    };
    expect(citedDomains(body)).toEqual(["docs.example.org", "owasp.org"]);
    expect(citedDomains(null)).toEqual([]);
  });

  it("records them on each row from the one call per question it already makes", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return Response.json(perplexity(["https://github.com/x", "https://theagentforge.io/answers/which-ai-models-fall-for-fake-invoices"]));
    }) as unknown as typeof fetch;
    const r = await runCitations({ OPENROUTER_API_KEY: "test" }, "perplexity", 0, 3, fetcher);
    expect(calls).toHaveLength(3);
    expect(r.rows[0]).toEqual({ i: 0, cited: true, urls: 2, domains: ["github.com", "theagentforge.io"] });
    const failed = await runCitations({ OPENROUTER_API_KEY: "test" }, "perplexity", 9, CITATION_QUESTIONS.length, (async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    expect(failed.rows).toEqual([{ i: 9, cited: null, urls: 0, domains: [] }]);
  });
});
