import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BYOK_FALLBACK_KV, BYOK_HOLD_KV, opsCallAllowed } from "../src/arena/credit";
import { BEFORE_2026_11_04, DECOYS, judge, OURS, PROMPTS, runSelection, score, TOOL_LIST, toolList } from "../src/ops/tool-selection";
import { PUBLIC_TOOLS_NEXT as PUBLIC_TOOLS } from "../src/mcp-public";
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
      return Response.json({ choices: [{ message: { content: pick ? null : "Sunny.", tool_calls: pick ? [{ id: "c1", type: "function", function: { name: pick, arguments: "{}" } }] : [] } }], usage: { prompt_tokens: 900, completion_tokens: 20, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.003 } } });
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

  it("a Claude call billed to OpenRouter credit (usage type Credits, not BYOK) stops the slice and holds Claude for an hour", async () => {
    await env.KV.delete(BYOK_HOLD_KV);
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "forge_check", arguments: "{}" } }] } }], usage: { prompt_tokens: 900, completion_tokens: 20, cost: 0.004, is_byok: false } });
    }) as unknown as typeof fetch;
    const r = await runSelection({ ...env, OPENROUTER_API_KEY: "k" }, "claude-sonnet-5.5", 0, 5, fetcher);
    expect(calls).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r).toMatchObject({ held: "byok", cost: 0.004 });
    expect(await env.KV.get(BYOK_HOLD_KV)).not.toBeNull();
    expect(await opsCallAllowed({ ...env, OPENROUTER_API_KEY: "k" }, true)).toMatchObject({ ok: false });
    await env.KV.delete(BYOK_HOLD_KV);
    await env.KV.delete(BYOK_FALLBACK_KV);
  });

  it("ADR 0133: a run can send the 4 Nov descriptions (before) or the live ones (after); nothing else differs", async () => {
    const before = toolList("before"), after = toolList("after");
    expect(before.map((t) => t.name)).toEqual(after.map((t) => t.name));
    for (const name of OURS) {
      expect(before.find((t) => t.name === name)!.description, name).toBe(BEFORE_2026_11_04[name]);
      expect(after.find((t) => t.name === name)!.description, name).toBe(PUBLIC_TOOLS[name].description);
      expect(BEFORE_2026_11_04[name], name).not.toBe(PUBLIC_TOOLS[name].description);
    }
    for (const d of DECOYS) expect(before.find((t) => t.name === d.name)).toEqual(after.find((t) => t.name === d.name));
    // The 4 Nov digest pinned in test/trap-card.test.ts was taken over {title, description}; the titles didn't change.
    const old = Object.fromEntries(Object.entries(PUBLIC_TOOLS).map(([k, v]) => [k, { title: v.title, description: BEFORE_2026_11_04[k as keyof typeof PUBLIC_TOOLS] }]));
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(old))))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(digest).toBe("3d7edea4185d43494b0068707e23c2286036b692e925f3258694020511952e29");
    const seen: string[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools: { function: { name: string; description: string } }[] };
      seen.push(body.tools.find((t) => t.function.name === "forge_scan")!.function.description);
      return Response.json({ choices: [{ message: { content: "ok", tool_calls: [] } }], usage: { prompt_tokens: 9, completion_tokens: 1, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0 } } });
    }) as unknown as typeof fetch;
    const r = await runSelection({ ...env, OPENROUTER_API_KEY: "k" }, "gpt-6.1-sol", 20, 21, fetcher, "before");
    expect(r.set).toBe("before");
    expect(seen).toEqual([BEFORE_2026_11_04.forge_scan]);
  });

  it("refuses an unknown description set", async () => {
    const res = await fetchWorker("/api/v1/ops/tool-selection", { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5.5", from: 0, to: 10, set: "tuned" }) });
    expect(res.status).toBe(401);
  });

  it("only the tool-selection workflow may start a run", async () => {
    const res = await fetchWorker("/api/v1/ops/tool-selection", { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5.5", from: 0, to: 10 }) });
    expect(res.status).toBe(401);
  });
});
