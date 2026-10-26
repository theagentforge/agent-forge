import { env } from "cloudflare:workers";
import { Attempt, baseTask, HARD3_2_TASKS, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { arenaAnswer, arenaQuestion, questionForTask, versionsOf } from "../src/arena/answers";
import { ALL_TASKS, arenaResults } from "../src/arena/results";
import { trapsData } from "../src/arena/traps";
import { eventCard, tierOf } from "../src/arena/views";
import * as t from "../src/db/schema";
import { resultsInput, trapsInput } from "../src/mcp-public";
import { jobFamily } from "../src/services/review";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import "../src/index";

// Hard v3.2 on the site (ADR 0054): the two new task ids (`refund-hard3-2`, `flaky-supplier-hard3-2`) map to their job,
// version, tier and pages wherever a task id does. No runs exist yet, so nothing shows v3.2 until a ranked run does.

const SEED = 1_000_032;
const MODEL = "claude-sonnet-5.5";
const SLUG = "crucible-3-hard-v32-test";
const REFUND = "/answers/which-ai-model-can-be-trusted-with-refunds";

/** A refereed attempt on a v3.2 job that fell for `trap` (added to the referee's list if this variant hasn't it). */
function fellFor(task: string, trap: string): { result: AttemptResult; log: unknown } {
  const a = new Attempt(taskById(task)!, SEED);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const others = base.traps.filter((x) => x.id !== trap).map((x) => ({ ...x, triggered: false }));
  return { result: { ...base, passed: false, traps: [...others, { id: trap, label: trap, triggered: true }] }, log: a.log };
}

describe("Hard v3.2 task ids map to their job, version and tier", () => {
  it("every v3.2 id is a Hard job of its family, in the task enums of forge_traps and arena_results", () => {
    expect(HARD3_2_TASKS.map((x) => x.id)).toEqual(["refund-hard3-2", "flaky-supplier-hard3-2"]);
    for (const id of HARD3_2_TASKS.map((x) => x.id)) {
      expect(tierOf(id)).toBe("hard");
      expect(ALL_TASKS.map((x) => x.id)).toContain(id);
      expect(resultsInput.safeParse({ task: id }).success).toBe(true);
      expect(trapsInput.safeParse({ task: id }).success).toBe(true);
    }
    expect(jobFamily("refund-hard3-2")).toBe("refund");
    expect(baseTask("flaky-supplier-hard3-2")).toBe("flaky-supplier");
  });

  it("answer pages: a v3.2 id finds its job's question, and v3.2 leads the versions list", () => {
    expect(questionForTask("refund-hard3-2")?.job).toBe("refund");
    expect(questionForTask("flaky-supplier-hard3-2")?.job).toBe("flaky-supplier");
    expect(versionsOf("refund").map((v) => [v.task.id, v.version])).toEqual([
      ["refund-hard3-2", "Hard v3.2"],
      ["refund-hard3", "Hard v3"],
      ["refund-hard", "Hard v2"],
      ["refund", "Normal"],
    ]);
    // Jobs without a v3.2 task are unchanged.
    expect(versionsOf("weekend").map((v) => v.version)).toEqual(["Hard v3", "Hard v2", "Normal"]);
  });

  it("the v3.2 task guide links its Normal version and its job's answer page", async () => {
    const page = await (await fetchWorker("/best/refund-hard3-2")).text();
    expect(page).toContain('href="/best/refund"');
    expect(page).toContain(REFUND);
  });
});

describe("before any v3.2 run, nothing shows v3.2", () => {
  it("answer page, arena_results and forge_traps (Hard) list no v3.2 job", async () => {
    const db = getDb(env);
    const a = await arenaAnswer(db, arenaQuestion("which-ai-model-can-be-trusted-with-refunds")!, env.PUBLIC_ORIGIN);
    expect(a.sections.map((s) => s.version)).not.toContain("Hard v3.2");
    expect((await fetchWorker(REFUND).then((r) => r.text()))).not.toContain("Hard v3.2");
    const r = await arenaResults(db, { tier: "hard" }, env.PUBLIC_ORIGIN);
    expect(r.tasks.map((x) => x.task)).not.toContain("refund-hard3-2");
    const tr = await trapsData(db, { tier: "hard" });
    expect(tr.tasks.map((x) => x.task)).not.toContain("refund-hard3-2");
  });
});

describe("once a ranked v3.2 run exists, it shows as Hard v3.2", () => {
  let eventId = "";
  beforeAll(async () => {
    const db = getDb(env);
    eventId = crypto.randomUUID();
    await db.insert(t.arenaEvents).values({ id: eventId, slug: SLUG, name: "Crucible 3: Hard (test)", season: "s0", kind: "card", status: "done" });
    for (const [task, trap, n] of [["refund-hard3-2", "stale_approval", 1], ["flaky-supplier-hard3-2", "accepted_not_done", 2]] as const) {
      const r = fellFor(task, trap);
      const id = crypto.randomUUID();
      await db.insert(t.arenaRuns).values({
        id, eventId, modelId: MODEL, task, seed: SEED, attemptNo: n, status: "done", passed: false, score: 0.2, cost: 0.1, tokens: 1000,
        result: r.result, log: r.log as never, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) }), finishedAt: Date.now() - 60_000 * n,
      });
    }
  });

  it("the refund answer leads with a Hard v3.2 section that counts the stale approval", async () => {
    const a = await arenaAnswer(getDb(env), arenaQuestion("which-ai-model-can-be-trusted-with-refunds")!, env.PUBLIC_ORIGIN);
    const s = a.sections[0]!;
    expect([s.task, s.version, s.tier, s.attempts]).toEqual(["refund-hard3-2", "Hard v3.2", "hard", 1]);
    expect(s.task_versions).toEqual(["Hard v3.2"]);
    expect(s.models[0]!.traps_fell.map((x) => x.id)).toEqual(["FA-POL-016"]);
    // A fresh cache key: the page was cached (edge cache, web/pages.ts) before the run existed.
    expect(await fetchWorker(`${REFUND}?after=v32`).then((r) => r.text())).toContain("Hard tier (Hard v3.2)");
  });

  it("arena_results and forge_traps (Hard) include the v3.2 jobs with their new trap ids", async () => {
    const db = getDb(env);
    const r = await arenaResults(db, { tier: "hard" }, env.PUBLIC_ORIGIN);
    const restock = r.tasks.find((x) => x.task === "flaky-supplier-hard3-2")!;
    expect(restock.tier).toBe("hard");
    expect(restock.models[0]!.traps_fell.map((x) => x.id)).toEqual(["FA-CLM-004"]);
    expect(r.task_versions).toContain("Hard v3.2");
    const tr = await trapsData(db, { task: "refund-hard3-2" });
    expect(tr.tier).toBe("hard");
    const stale = tr.tasks[0]!.traps.find((x) => x.trap === "stale_approval")!;
    expect(stale).toMatchObject({ public_id: "FA-POL-016", attempts: 1, fell: 1 });
    expect(stale.name).not.toBe("stale_approval");
  });

  it("the event card has a bout for each v3.2 job, and its data file says Hard v3.2", async () => {
    const card = await eventCard(getDb(env), SLUG);
    expect(card!.bouts.map((b) => b.task.id)).toEqual(["refund-hard3-2", "flaky-supplier-hard3-2"]);
    const d = (await (await fetchWorker(`/arena/events/${SLUG}.json`)).json()) as { runs: { task: string; tier: string; task_version: string; traps_fell: string[] }[] };
    expect(d.runs.map((x) => [x.task, x.tier, x.task_version, x.traps_fell])).toEqual([
      ["refund-hard3-2", "hard", "Hard v3.2", ["FA-POL-016"]],
      ["flaky-supplier-hard3-2", "hard", "Hard v3.2", ["FA-CLM-004"]],
    ]);
  });
});
