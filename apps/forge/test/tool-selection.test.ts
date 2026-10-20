import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DECOYS, judge, OURS, PROMPTS, runSelection, score, TOOL_LIST } from "../src/ops/tool-selection";
import { fetchWorker } from "./helpers";
import "../src/index";

// The tool-selection test (agent-channels §4.1): a fixed set, our five tools among eight ordinary ones, scored apart.

describe("the fixed set", () => {
  it("has 20 requests that fit one of our tools and 10 that fit none, covering every tool", () => {
    expect(PROMPTS).toHaveLength(30);
    expect(PROMPTS.filter((p) => p.expect === "none")).toHaveLength(10);
    const covered = new Set(PROMPTS.flatMap((p) => (p.expect === "none" ? [] : p.expect)));
    for (const t of OURS) expect(covered.has(t), t).toBe(true);
    expect(TOOL_LIST).toHaveLength(OURS.length + DECOYS.length);
    expect(new Set(TOOL_LIST.map((t) => t.name)).size).toBe(TOOL_LIST.length);
  });

  it("judges a pick against the expected tool, and any of ours on a 'none' request as a false trigger", () => {
    expect(judge(["forge_check"], "forge_check")).toBe(true);
    expect(judge(["forge_scan", "forge_check"], "forge_check")).toBe(true);
    expect(judge(["forge_check"], "web_search")).toBe(false);
    expect(judge("none", "web_search")).toBe(true);
    expect(judge("none", "none")).toBe(true);
    expect(judge("none", "forge_scan")).toBe(false);
  });
});

describe("running a slice", () => {
  it("sends each request with the tool list and records the first tool called", async () => {
    const seen: string[][] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools: { function: { name: string } }[]; messages: { content: string }[] };
      seen.push(body.tools.map((t) => t.function.name));
      const pick = body.messages[1]!.content.includes("weather") ? null : "forge_check";
      return Response.json({ choices: [{ message: { content: pick ? null : "Sunny.", tool_calls: pick ? [{ id: "c1", type: "function", function: { name: pick, arguments: "{}" } }] : [] } }], usage: { prompt_tokens: 900, completion_tokens: 20, cost: 0.003 } });
    }) as unknown as typeof fetch;
    const r = await runSelection({ ...env, OPENROUTER_API_KEY: "k" }, "claude-sonnet-5.5", 20, 23, fetcher);
    expect(r.rows.map((x) => [x.i, x.chose, x.correct])).toEqual([
      [20, "forge_check", false],
      [21, "none", true],
      [22, "forge_check", false],
    ]);
    expect(seen[0]).toEqual(TOOL_LIST.map((t) => t.name));
    expect(score(r.rows)).toMatchObject({ false_triggers: 2, n_not: 3, accuracy: null });
  });

  it("only the tool-selection workflow may start a run", async () => {
    const res = await fetchWorker("/api/v1/ops/tool-selection", { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5.5", from: 0, to: 10 }) });
    expect(res.status).toBe(401);
  });
});
