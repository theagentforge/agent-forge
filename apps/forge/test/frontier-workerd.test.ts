import { env } from "cloudflare:workers";
import { Attempt, FRONTIER_FREEZE, FRONTIER_TASKS, type TaskType } from "@forge/arena";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { planEvent, processQueue } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { playDataRequest, playPayroll, playProcurement } from "../../../packages/arena/test/plays/frontier";

// ADR 0139 Amendment 1: the frontier jobs' own tests run in Node; the runner plays them in the Workers runtime. This
// builds every dev-seed world and plays the careful play here, so a runtime difference (dates, Intl, eval) shows up
// before a calibration bout is voided for it.
const plays = [playDataRequest, playPayroll, playProcurement];

describe("frontier jobs in the Workers runtime", () => {
  it("every calibration-seed world builds and the careful play passes, as in Node", () => {
    FRONTIER_TASKS.forEach((task, i) => {
      for (const seed of FRONTIER_FREEZE.devSeeds) {
        let clock = 0;
        const a = new Attempt(task as TaskType<any>, seed, { now: () => (clock += 10) });
        plays[i]!(a);
        expect(a.result, `${task.id} ${seed}`).not.toBeNull();
        expect(a.result!.traps.filter((x) => x.triggered).map((x) => x.id), `${task.id} ${seed}`).toEqual([]);
        expect(a.result!.passed, `${task.id} ${seed}`).toBe(true);
      }
    });
  });
});

describe("frontier calibration bouts through the runner (held practice, Claude on our own key)", () => {
  it("a scripted Claude bout on each frontier job finishes, is stored done with its full log, and is never voided", async () => {
    const db = getDb(env);
    await env.KV.delete("arena:lock");
    const id = await planEvent(env, { slug: "frontier-cal-r9-runner", name: "Runner check", season: "s0", kind: "practice", hold: true, models: ["claude-sonnet-5.5"], tasks: FRONTIER_TASKS.map((x) => x.id), seeds: [900001], attempts: 1 });
    let n = 0;
    const turns = new Map<string, number>();
    const fetcher = (async (u: string, init?: RequestInit) => {
      if (!String(u).endsWith("/chat/completions")) return new Response("{}", { status: 404 });
      const body = JSON.parse(String(init!.body)) as { tools: { function: { name: string } }[]; messages: unknown[] };
      const names = body.tools.map((x) => x.function.name);
      const key = names.join(",");
      const k = (turns.get(key) ?? 0) + 1;
      turns.set(key, k);
      const list = names.find((x) => x.startsWith("list_req"))!;
      const read = "get_handbook";
      const calls = k >= 12 ? [{ name: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }] : [{ name: read, args: {} }, ...[1, 2, 3].map((page) => ({ name: list, args: { page } }))];
      return Response.json({
        id: `gen-${++n}`,
        model: "anthropic/claude-sonnet-5.5",
        provider: "Anthropic",
        choices: [{ message: { content: k === 1 ? "Reading the procedure first." : null, tool_calls: calls.map((c, i) => ({ id: `c${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }],
        usage: { prompt_tokens: 20_000, completion_tokens: 300, cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.01 } },
      });
    }) as typeof fetch;
    await processQueue({ ...env, OPENROUTER_API_KEY: "k" }, Date.now() + 120_000, () => Date.now(), fetcher);
    const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
    expect(runs.map((r) => r.task).sort()).toEqual(FRONTIER_TASKS.map((x) => x.id).sort());
    for (const r of runs) expect([r.task, r.status, r.voidReason]).toEqual([r.task, "done", null]);
    for (const r of runs) {
      expect((r.log as unknown[]).length).toBeGreaterThan(40);
      expect((r.result as { reason: string }).reason).toBe("finished");
    }
  });
});
