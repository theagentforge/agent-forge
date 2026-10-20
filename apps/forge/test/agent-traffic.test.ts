import { describe, expect, it } from "vitest";
import { citedUrls, wasCited } from "../src/ops/citations";
import { aiAgentCounters, aiPageKind, visitCounters } from "../src/services/usage";
import { fetchWorker } from "./helpers";
import "../src/index";

// agent-channels §4.5: AI agents counted apart from people, by group, agent and kind of page; citation detection.

const req = (ua: string, path = "/tools/github.com/o/r") => ({ method: "GET", url: `https://theagentforge.io${path}`, headers: new Headers({ "user-agent": ua }) });

describe("AI agent counters", () => {
  it("sorts indexers, live fetches and coding agents, with the kind of page", () => {
    expect(aiAgentCounters(req("Mozilla/5.0 (compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot)"))).toEqual(["ai:indexer", "ai:indexer:openai", "ai:indexer:page:tools"]);
    expect(aiAgentCounters(req("Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "/llms.txt"))).toEqual(["ai:live", "ai:live:anthropic", "ai:live:page:llms"]);
    expect(aiAgentCounters(req("claude-code/2.4.1", "/.well-known/agent-skills/index.json"))).toEqual(["ai:coding", "ai:coding:claude-code", "ai:coding:page:skills"]);
    expect(aiAgentCounters(req("Mozilla/5.0 (Macintosh) Safari/605"))).toEqual([]);
    expect(aiAgentCounters({ ...req("PerplexityBot/1.0"), method: "POST" })).toEqual([]);
    expect(aiPageKind("/.well-known/ai-catalog.json")).toBe("discovery");
  });

  it("people are still counted as visits, and AI agents aren't", () => {
    expect(visitCounters(req("PerplexityBot/1.0"), "https://theagentforge.io")).toEqual([]);
    expect(visitCounters(req("Mozilla/5.0 (Macintosh) Safari/605"), "https://theagentforge.io")).toContain("visit:arrivals");
  });
});

describe("citation detection", () => {
  it("finds our domain in web-plugin annotations, a citations list or the text, and nowhere else", () => {
    const annotated = { choices: [{ message: { content: "Use a scanner.", annotations: [{ type: "url_citation", url_citation: { url: "https://theagentforge.io/tools/github.com/o/r" } }] } }] };
    expect(wasCited(annotated)).toBe(true);
    expect(citedUrls(annotated)).toEqual(["https://theagentforge.io/tools/github.com/o/r"]);
    expect(wasCited({ citations: ["https://example.com", "https://www.theagentforge.io/scan"], choices: [{ message: { content: "x" } }] })).toBe(true);
    expect(wasCited({ choices: [{ message: { content: "See theagentforge.io for a free scan." } }] })).toBe(true);
    expect(wasCited({ citations: ["https://notheagentforge.io.evil.com"], choices: [{ message: { content: "x" } }] })).toBe(false);
    expect(wasCited({ citations: ["https://theagentforge.io.evil.com/x"], choices: [{ message: { content: "x" } }] })).toBe(false);
  });

  it("only the citation workflow may start a run", async () => {
    const res = await fetchWorker("/api/v1/ops/citations", { method: "POST", headers: { Authorization: "Bearer x", "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
