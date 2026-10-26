import { Attempt, DEFAULT_CAPS, HARD3_TASKS, HARD_TASKS, TASKS, type TaskType } from "@forge/arena";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { standingOpponents } from "../src/arena/gauntlet";
import { HEADLINE } from "../src/arena/lineup";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

// Standing opponents (V2, ADR 0047) from data shaped the way production stores it: ranked "card" events (Crucible 1
// Normal, Crucible 1 Hard, a held Crucible 2 Hard v3, a weekly headline bout), 3 attempts per job with one random
// season seed, Hard and Hard v3 runs of the same models, an embargoed model, a "Call it" fixture still to premiere, and
// practice runs. Only each model's newest public Normal-tier ranked run of each Gauntlet job may be used.

const HOUR = 3_600_000;
const now = Date.now();
const MODELS = HEADLINE.filter((m) => !m.retired && !m.embargoed).map((m) => m.id);
const EMBARGOED = HEADLINE.filter((m) => m.embargoed).map((m) => m.id);

function played(task: TaskType, seed: number, done: boolean) {
  let clock = 0;
  const a = new Attempt(task, seed, { caps: task.caps ?? DEFAULT_CAPS, now: () => (clock += 1000) });
  a.recordTurn({ tokensIn: 900, tokensOut: 40, cost: 0.002, latencyMs: 700, text: "ok" });
  a.call("finish", done ? { status: "done", summary: "Done." } : { status: "cannot_complete", summary: "Stopping." });
  return a;
}

let n = 0;
type Run = typeof t.arenaRuns.$inferInsert;
function runsOf(eventId: string, models: string[], tasks: TaskType[], seed: number, attempts: number, finishedAt: number): Run[] {
  return tasks.flatMap((task) =>
    models.flatMap((modelId) =>
      Array.from({ length: attempts }, (_, i) => {
        const a = played(task, seed, i % 2 === 0);
        const result = a.result!;
        return { id: `op-${eventId}-${n++}`, eventId, modelId, task: task.id, seed, attemptNo: i + 1, status: "done" as const, passed: result.passed, score: 0.5, cost: 0.01, tokens: 940, provider: "test", result, log: a.log, finishedAt: finishedAt + n };
      }),
    ),
  );
}

const C1_SEED = 1_234_567;
const WEEKLY_SEED = 1_765_432;

beforeAll(async () => {
  const db = getDb(env);
  await db.insert(t.arenaEvents).values([
    { id: "op-c1", slug: "crucible-1", name: "Crucible 1", season: "s0", kind: "card", status: "done" },
    { id: "op-c1h", slug: "crucible-1-hard", name: "Crucible 1: Hard", season: "s0", kind: "card", status: "done" },
    { id: "op-c2h", slug: "crucible-2-hard", name: "Crucible 2: Hard", season: "s0", kind: "card", status: "planned" },
    { id: "op-wk", slug: "weekly-2026-10-22", name: "Weekly headline bout", season: "s0", kind: "card", status: "running" },
    { id: "op-pr", slug: "practice-ladder", name: "Practice ladder", season: "s0", kind: "practice", status: "running" },
    // Newer Normal ranked runs that must be skipped: held for review, a Lab arm, a twist.
    { id: "op-held", slug: "weekly-held", name: "Held weekly", season: "s0", kind: "card", status: "planned" },
    { id: "op-lab", slug: "lab-card", name: "Lab arm", season: "s0", kind: "card", status: "done", arm: "none" },
    { id: "op-tw", slug: "twist-card", name: "Twist", season: "s0", kind: "card", status: "done", twist: "half-budget" },
  ]);
  const runs = [
    ...runsOf("op-c1", [...MODELS, ...EMBARGOED], TASKS, C1_SEED, 3, now - 200 * HOUR),
    // Newer Hard and Hard v3 runs (different task ids, harder caps): never a Gauntlet opponent's side.
    ...runsOf("op-c1h", MODELS, HARD_TASKS, 1_300_000, 1, now - 150 * HOUR),
    ...runsOf("op-c2h", MODELS, HARD3_TASKS, 1_400_000, 1, now - 10 * HOUR),
    // The weekly bout is a newer ranked Normal run of one job: it replaces Crucible 1's on that job...
    ...runsOf("op-wk", MODELS, [TASKS[1]!], WEEKLY_SEED, 3, now - 50 * HOUR),
    // ...and practice runs never count, however new.
    ...runsOf("op-pr", MODELS, TASKS, 99, 1, now - HOUR),
    ...runsOf("op-held", MODELS, TASKS, 1_500_000, 1, now - 2 * HOUR),
    ...runsOf("op-lab", MODELS, TASKS, 1_600_000, 1, now - 3 * HOUR),
    ...runsOf("op-tw", MODELS, TASKS, 1_700_000, 1, now - 4 * HOUR),
  ];
  // D1 allows 100 bound values per statement: one row per statement, all in one batch.
  const statements = runs.map((r) => db.insert(t.arenaRuns).values(r));
  await db.batch(statements as [any, ...any[]]);
  // A "Call it" fixture still to premiere hides Qwen's and Mistral's weekly runs: their side falls back to Crucible 1.
  await db.insert(t.arenaFixtures).values({ id: "op-fx", day: "2099-01-01", eventId: "op-wk", task: TASKS[1]!.id, modelA: "qwen3.8-max", modelB: "mistral-large-4", premiereAt: now + 24 * HOUR });
});

describe("standing opponents from production-shaped data", () => {
  it("lists every public headline model with its newest ranked Normal run of each Gauntlet job", async () => {
    const opponents = await standingOpponents(getDb(env), now);
    expect(opponents.map((o) => o.model).sort()).toEqual([...MODELS].sort());
    for (const o of opponents) {
      expect(o.runs.map((r) => r.idx)).toEqual([0, 1, 2, 3, 4, 5]);
      const hidden = o.model === "qwen3.8-max" || o.model === "mistral-large-4";
      expect(o.runs.map((r) => r.seed)).toEqual(TASKS.map((_, i) => (i === 1 && !hidden ? WEEKLY_SEED : C1_SEED)));
      expect(o.runs.every((r) => r.runId.startsWith("op-op-c1-") || r.runId.startsWith("op-op-wk-"))).toBe(true);
    }
    // The embargoed model never appears, even asked for by name.
    for (const m of EMBARGOED) expect(await standingOpponents(getDb(env), now, m)).toEqual([]);
  });

  it("shows them on /gauntlet with a challenge link each", async () => {
    const html = await (await fetchWorker("/gauntlet", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("Or take on a headline model");
    for (const m of MODELS) expect(html).toContain(`href="/gauntlet/challenge/model:${m}"`);
    for (const m of EMBARGOED) expect(html).not.toContain(m);
  });

  it("treats an empty-string twist (a plan written with \"twist\": \"\") as no twist", async () => {
    const db = getDb(env);
    await db.insert(t.arenaEvents).values({ id: "op-empty", slug: "empty-twist", name: "Empty twist", season: "s0", kind: "card", status: "done", twist: "" });
    for (const r of runsOf("op-empty", ["gpt-6.1-sol"], [TASKS[0]!], 1_800_000, 1, now - 30 * HOUR)) await db.insert(t.arenaRuns).values(r);
    const [o] = await standingOpponents(db, now, "gpt-6.1-sol");
    expect(o!.runs[0]!.seed).toBe(1_800_000);
  });
});
