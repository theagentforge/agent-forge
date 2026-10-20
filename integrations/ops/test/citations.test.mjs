import { describe, expect, it } from "vitest";
import { comment, MARK, summary } from "../citations.mjs";
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
