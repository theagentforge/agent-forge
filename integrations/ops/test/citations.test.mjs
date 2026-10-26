import { describe, expect, it } from "vitest";
import { comment, MARK, mostCited, mostCitedLine, SOURCES_MARK, summary } from "../citations.mjs";
import { agentLine } from "../digest.mjs";

// agent-channels §4.5: the weekly citation score and the digest's agent-traffic line.

const runs = [
  { model: "claude", cost: 0.1, rows: [{ i: 0, cited: true, urls: 5 }, { i: 1, cited: false, urls: 4 }] },
  { model: "perplexity", cost: 0.05, rows: [{ i: 0, cited: null, urls: 0 }, { i: 1, cited: false, urls: 7 }] },
];

describe("the citation check", () => {
  it("scores cited answers out of those that came back", () => {
    expect(summary(runs)).toEqual({ cited: 1, answered: 3, asked: 4 });
  });

  it("writes one comment with a table and a marker the digest reads", () => {
    const c = comment("2026-10-25", runs);
    expect(c).toContain("cited in **1 of 3** answers (1 failed)");
    expect(c).toContain("| 1 | ✓ cited | error |");
    expect(c).toContain("| 2 | – (4 sources) | – (7 sources) |");
    expect(JSON.parse(MARK.exec(c)[1])).toEqual({ date: "2026-10-25", cited: 1, answered: 3, asked: 4 });
  });
});

describe("cited domains (issue #234)", () => {
  const withDomains = [
    { model: "perplexity", cost: 0.01, rows: [{ i: 0, cited: false, urls: 3, domains: ["github.com", "reddit.com"] }, { i: 1, cited: false, urls: 2, domains: ["github.com", "snyk.io"] }, { i: 2, cited: null, urls: 0, domains: [] }] },
    { model: "claude", cost: 0.02, rows: [{ i: 0, cited: true, urls: 1, domains: ["theagentforge.io"] }] },
    // An older site without the domains field still gets a comment.
    { model: "gpt", cost: 0.01, rows: [{ i: 0, cited: false, urls: 4 }] },
  ];

  it("shows the most-cited domains per model, counting each answer once", () => {
    expect(mostCited(withDomains)[0]).toEqual({ model: "perplexity", top: [["github.com", 2], ["reddit.com", 1], ["snyk.io", 1]] });
    expect(mostCitedLine(withDomains)).toBe("Most-cited domains (answers citing each): **perplexity**: github.com 2, reddit.com 1, snyk.io 1; **claude**: theagentforge.io 1.");
    expect(mostCitedLine(runs)).toBe("Most-cited domains: none recorded.");
  });

  it("keeps each answer's domains in a second hidden marker, and the digest's marker still parses", () => {
    const c = comment("2026-11-01", withDomains);
    expect(c).toContain("Most-cited domains (answers citing each): **perplexity**: github.com 2");
    const s = JSON.parse(SOURCES_MARK.exec(c)[1]);
    expect(s.date).toBe("2026-11-01");
    expect(s.sources.perplexity.slice(0, 4)).toEqual([["github.com", "reddit.com"], ["github.com", "snyk.io"], null, null]);
    expect(s.sources.claude[0]).toEqual(["theagentforge.io"]);
    expect(s.sources.gpt[0]).toEqual([]);
    expect(JSON.parse(MARK.exec(c)[1])).toEqual({ date: "2026-11-01", cited: 1, answered: 4, asked: 5 });
    // The digest reads the flat marker with its own copy of the pattern; the new marker must not match it.
    expect([...c.matchAll(/<!-- forge-citations (\{[^}]*\}) -->/g)]).toHaveLength(1);
  });
});

describe("the digest's agent line", () => {
  it("shows indexers, live fetches (with answer-page hits), coding agents and the citation score", () => {
    const g = {
      ai_indexers_7d: { total: 12, by_agent: { openai: 7, anthropic: 5 }, by_page: {} },
      ai_live_fetches_7d: { total: 3, by_agent: { anthropic: 3 }, by_page: { tools: 2 } },
      ai_coding_agents_7d: { total: 0, by_agent: {}, by_page: {} },
    };
    const line = agentLine(g, { date: "2026-10-25", cited: 1, answered: 30 });
    expect(line).toContain("AI search indexers **12** (openai 7, anthropic 5)");
    expect(line).toContain("live AI fetches for a person **3** (anthropic 3), answer pages 2");
    expect(line).toContain("Cited in AI search on 2026-10-25: **1 of 30** answers.");
    expect(agentLine({}, null)).toBeNull();
  });
});
