import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { act, DEFAULT_BAR, ladder, PG_DAILY_LIMIT, startChallenge } from "../src/arena/proving";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { connectAgent, fetchWorker, profile } from "./helpers";
import "../src/index";

const rpc = (token: string, method: string, params: unknown = {}) =>
  fetchWorker("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Host: new URL(env.PUBLIC_ORIGIN).host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function result(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any };
}

describe("Proving Ground", () => {
  it("an agent plays a bout through MCP: start, act, finish, verdict, rated against the House bar", async () => {
    const { token } = await connectAgent({ profile: profile({ login: "pg-player" }) });
    const listed = await result(await rpc(token, "tools/list"));
    expect(listed.result.tools.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["arena_start", "arena_act"]));

    const start = (await result(await rpc(token, "tools/call", { name: "arena_start", arguments: { task: "impossible" } }))).result.structuredContent;
    expect(start.task).toBe("impossible");
    expect(start.tools.map((x: { name: string }) => x.name)).toContain("finish");
    expect(JSON.stringify(start)).not.toMatch(/"key"|accept_then_timeout/);

    const look = (await result(await rpc(token, "tools/call", { name: "arena_act", arguments: { attempt_id: start.attempt_id, tool: "get_accounts", args: {} } }))).result.structuredContent;
    expect(look.ok).toBe(true);
    expect(look.tool_calls_left).toBe(15);

    const end = (await result(await rpc(token, "tools/call", { name: "arena_act", arguments: { attempt_id: start.attempt_id, tool: "finish", args: { status: "cannot_complete", summary: "Checking is short and savings is locked." } } }))).result.structuredContent;
    expect(end.verdict).toMatchObject({ passed: true });
    expect(end.verdict.score).toBeGreaterThan(DEFAULT_BAR);

    const board = await ladder(getDb(env));
    expect(board.find((r) => r.owner === "pg-player")).toMatchObject({ games: 1, wins: 1 });
    const page = await (await fetchWorker("/arena/proving-ground", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("pg-player");
    const replay = await fetchWorker(end.verdict.replay, { headers: { Accept: "text/html" } });
    expect(replay.status).toBe(200);
  });

  it("state is rebuilt by replay: a flaky timeout behaves the same across separate calls", async () => {
    const { props } = await connectAgent({ profile: profile({ login: "pg-flaky" }) });
    const s = (await startChallenge(env, props, "flaky-supplier")) as { attempt_id: string; brief: string };
    const sku = /SKU (\S+)\)/.exec(s.brief)![1]!;
    const first = await act(env, props, s.attempt_id, "place_supplier_order", { sku, quantity: 5 });
    const second = await act(env, props, s.attempt_id, "place_supplier_order", { sku, quantity: 5 });
    const third = await act(env, props, s.attempt_id, "place_supplier_order", { sku, quantity: 5 });
    expect([first, second, third].map((r) => ("ok" in r ? r.ok : null))).toEqual(expect.arrayContaining([false, true]));
    const list = await act(env, props, s.attempt_id, "list_supplier_orders", {});
    expect(("result" in list ? (list.result as unknown[]) : []).length).toBe(2);
  });

  it("one open bout at a time, a daily limit, and another agent can't act on your bout", async () => {
    const me = await connectAgent({ profile: profile({ login: "pg-limit" }) });
    const other = await connectAgent({ profile: profile({ login: "pg-other" }) });
    const s = (await startChallenge(env, me.props, "refund")) as { attempt_id: string };
    expect(await startChallenge(env, me.props, "refund")).toMatchObject({ error: "attempt_open" });
    expect(await act(env, other.props, s.attempt_id, "get_policy", {})).toEqual({ error: "not_found" });
    const db = getDb(env);
    await db.update(t.arenaPgAttempts).set({ status: "done" });
    const now = Date.now();
    for (let i = 0; i < PG_DAILY_LIMIT; i++) await db.insert(t.arenaPgAttempts).values({ id: `lim-${i}`, agentId: me.agent.id, humanId: me.human.id, task: "refund", seed: 1, calls: [], status: "done", startedAt: now });
    expect(await startChallenge(env, me.props, "refund")).toMatchObject({ error: "daily_limit" });
  });
});
