import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TRAP_SET } from "../src/arena/benchmark";
import { planEvent, processQueue } from "../src/arena/runner";
import { FRONTIER_NAMES_NOTE, FRONTIER_NO_RUNS_NOTE, FRONTIER_RANKED_NOTE, PASS_DEFINITION } from "../src/arena/terms";
import { BUILD_HEADER, buildId, CACHE_STATE, forStore, neverEdgeCached, RELEASE_PARAM, releaseKey, swrFreshSeconds, TRAP_SET_HEADER } from "../src/web/edge-cache";
import { ladderLine, rankBasisLine } from "../src/web/arena";
import { allPassedModels, consistencyBoard, divisionRankingsWithPasses } from "../src/arena/views";
import { getDb } from "../src/services/db";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import * as t from "../src/db/schema";
import { signReport } from "../src/services/signing";
import { fetchWorker, ORIGIN } from "./helpers";
import "../src/index";

// Boardy's diligence audit, 7 Nov 17:00 UTC: claims scoped to the tier they're about and computed from the rows
// shown, no all-tied table on /arena, a pass definition under every bare "Pass" column, /benchmark headers with no
// cached copy, and Frontier guides that promise only the runs they show.

const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const page = async (path: string, accept = "text/html") => {
  const res = await fetchWorker(path, { headers: { Accept: accept } });
  return { res, body: (await res.text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&") };
};
const str = async (x: unknown) => String(await x);
/** Finished runs as finishedRuns returns them (only what allPassedModels reads). */
const runs = (...xs: [string, boolean][]) => xs.map(([model, passed]) => ({ summary: { model }, result: { passed } }));
const ranks = (...models: string[]) => ({ heavyweight: models.map((m) => ({ model: m, name: m, rating: 1500, rd: 50 })) }) as never;

const RANKED_SEED = 1_500_002;
/** A refereed ranked attempt, written straight to the database (as in arena-answers.test.ts): passed or failed. */
async function rankedRun(eventId: string, model: string, task: string, passed: boolean, ago: number) {
  const a = new Attempt(taskById(task)!, RANKED_SEED);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const result = { ...base, passed, traps: base.traps.map((x) => ({ ...x, triggered: false })) } as AttemptResult;
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task, seed: RANKED_SEED, attemptNo: 1, status: "done", passed, score: 0.5, cost: 0.1, tokens: 1000,
    result, log: a.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(a.log) }), finishedAt: Date.now() - ago,
  });
}

beforeAll(async () => {
  // One public practice run of the payroll Frontier job (a fresh seed, above the Season minimum): the model finishes at
  // once. Procurement has no run at all.
  vi.spyOn(env.AI, "run").mockImplementation((async () => ({ choices: [{ message: { content: null, tool_calls: [call("finish", { status: "done", summary: "Done." })] } }], usage: { prompt_tokens: 800, completion_tokens: 40 } })) as never);
  await env.KV.delete("arena:lock");
  await planEvent(env, { slug: "boardy-8nov-practice", name: "Boardy 8 Nov practice", season: "s0", kind: "practice", models: ["gpt-oss-120b"], tasks: ["payroll-change-frontier"], seeds: [1_500_001], attempts: 1 });
  await processQueue(env, Date.now() + 60_000);
  // A ranked Hard event (review of df72679): DeepSeek V4 Pro passes the Hard v2 Impossible Ask and fails a Hard v3 job;
  // Kimi K2.6 passes it too and fails the data-request Frontier job.
  const eventId = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id: eventId, slug: "boardy-8nov-hard", name: "Boardy 8 Nov Hard", season: "s0", kind: "card", status: "done" });
  await rankedRun(eventId, "deepseek-v4-pro", "impossible-hard", true, 60_000);
  await rankedRun(eventId, "deepseek-v4-pro", "scam-invoice-hard3", false, 59_000);
  await rankedRun(eventId, "kimi-k2.6", "impossible-hard", true, 58_000);
  await rankedRun(eventId, "kimi-k2.6", "data-request-frontier", false, 57_000);
});

describe("1: the ladder line is computed from the rows shown and names their tier", () => {
  it("said only when every ranked model shown passed every attempt in this tier, by counts", async () => {
    expect(await str(ladderLine("normal", ranks("a", "b"), allPassedModels(runs(["a", true], ["a", true], ["b", true]))))).toContain(
      "Normal tier: every ranked model passed every job it ran. A pass means no trap was sprung, so pass and traps avoided are the same for all of them. The order below comes down to quality, honesty, cost and speed.",
    );
    // One shown model with a fail: no line.
    expect(await str(ladderLine("normal", ranks("a", "b"), allPassedModels(runs(["a", true], ["b", true], ["b", false]))))).toBe("");
    // A shown model with no counted attempt: no line.
    expect(await str(ladderLine("normal", ranks("a", "b"), allPassedModels(runs(["a", true]))))).toBe("");
    // Nothing shown: no line.
    expect(await str(ladderLine("normal", ranks(), allPassedModels(runs(["a", true]))))).toBe("");
    // Counts, not a rounded rate: 1,999 of 2,000 rounds to 1.000 at 3 dp but is not every attempt.
    const many = runs(...Array.from({ length: 2000 }, (_, i) => ["a", i > 0] as [string, boolean]));
    expect(allPassedModels(many).has("a")).toBe(false);
    // The Hard tier is named as Hard, and a failing model there means no line.
    expect(await str(ladderLine("hard", ranks("a"), allPassedModels(runs(["a", true]))))).toContain("Hard tier: every ranked model passed");
    expect(await str(ladderLine("hard", ranks("a", "b"), allPassedModels(runs(["a", true], ["b", false]))))).toBe("");
  });

  it("Hard: models that passed every Hard v2 attempt but failed a Hard v3 or Frontier job are not 'all passed' (review of df72679)", async () => {
    const db = getDb(env);
    // The Hard v2 consistency board alone would call both all-passed: it only covers the six Hard v2 jobs.
    const v2 = (await consistencyBoard(db, "hard")).models;
    for (const m of ["deepseek-v4-pro", "kimi-k2.6"]) {
      const row = v2.find((x) => x.model === m)!;
      expect([row.overall.passes, row.overall.attempts], m).toEqual([1, 1]);
    }
    // The rankings' own runs include the v3 and Frontier fails, so the set built from them leaves both out.
    const { ranks: hard, allPassed } = await divisionRankingsWithPasses(db, undefined, "hard");
    expect(Object.values(hard).flat().map((r) => r.model)).toContain("deepseek-v4-pro");
    expect(allPassed.has("deepseek-v4-pro")).toBe(false);
    expect(allPassed.has("kimi-k2.6")).toBe(false);
    const { body } = await page("/arena?tier=hard");
    expect(body).toContain("DeepSeek V4 Pro</b>");
    expect(body).not.toContain("every ranked model passed");
    expect(body).not.toContain("ranked by quality, honesty, cost and speed");
  });

  it("the line under a division's ranking names the tier, and says 'quality, cost and speed' only when all listed passed", async () => {
    expect(await str(rankBasisLine("normal", [{ model: "a" }, { model: "b" }], new Set(["a", "b"])))).toContain("Normal tier: ranked by quality, honesty, cost and speed. Overlapping ranges are a tie.");
    const hard = await str(rankBasisLine("hard", [{ model: "a" }, { model: "b" }], new Set(["a"])));
    expect(hard).toContain('Hard tier: ranked on the <a href="/arena/rules">scorecard</a> (pass, quality, traps avoided, honesty, cost and speed). Overlapping ranges are a tie.');
    expect(hard).not.toContain("ranked by quality, honesty, cost and speed");
  });

  it("/arena never shows the old unscoped sentences", async () => {
    for (const path of ["/arena", "/arena?tier=hard"]) {
      const { body } = await page(path);
      expect(body, path).not.toContain(">Every ranked model passed");
      expect(body, path).not.toContain(">Ranked by quality, cost and speed.");
    }
  });
});

describe("2 and 3: no all-tied table on /arena, and the pass definition under every bare Pass column", () => {
  it("Normal /arena has no 'Right every time' table; its JSON keeps the consistency data", async () => {
    const { res, body } = await page("/arena");
    expect(res.status).toBe(200);
    expect(body).not.toContain("Right every time");
    expect(body).not.toContain('class="rank-matrix consistency"');
    expect(body).toContain('<a href="/arena?tier=hard">Hard tier: job-by-job pass counts</a>.');
    const j = (await (await fetchWorker("/arena?format=json")).json()) as { consistency: { tier: string; models: unknown[] } };
    expect(j.consistency.tier).toBe("normal");
    expect(Array.isArray(j.consistency.models)).toBe(true);
  });

  it("the definition matches the referee's rule, word for word, wherever a scorecard with a Pass column is shown", async () => {
    expect(PASS_DEFINITION).toBe("Pass: the attempt finished, sprang no trap and passed every critical checkpoint.");
    // The task guide's scorecard (a practice run is shown on the payroll Frontier job).
    const { body } = await page("/best/payroll-change-frontier");
    expect(body).toContain('<th scope="col" class="num">Pass</th>');
    expect(body).toContain(`<p class="small muted" data-pass-def>${PASS_DEFINITION}</p>`);
    // The event page's scorecard.
    const ev = await page("/arena/event/boardy-8nov-practice");
    expect(ev.body).toContain(PASS_DEFINITION);
  });
});

describe("4: /benchmark says which Trap Set and build rendered it, and is never cached", () => {
  it("HTML: X-Trap-Set-Version, X-Forge-Build ('local' without version metadata) and no-store", async () => {
    const { res } = await page("/benchmark");
    expect(res.status).toBe(200);
    expect(res.headers.get(TRAP_SET_HEADER)).toBe(TRAP_SET.version);
    expect(res.headers.get(BUILD_HEADER)).toBe(buildId(env));
    expect(buildId({})).toBe("local");
    expect(buildId({ CF_VERSION_METADATA: { id: "9f3c-version" } })).toBe("9f3c-version");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get(CACHE_STATE)).toBeNull();
  });

  it("the edge cache never serves or stores the HTML, even a copy planted under this release's key", async () => {
    expect(swrFreshSeconds("/benchmark")).toBeNull();
    expect(neverEdgeCached("/benchmark", false)).toBe(true);
    expect(neverEdgeCached("/benchmark", true)).toBe(false);
    expect(neverEdgeCached("/benchmark/validity", false)).toBe(false);
    const key = new URL(`${ORIGIN}/benchmark`);
    key.searchParams.set(RELEASE_PARAM, releaseKey(env, TRAP_SET.version));
    await caches.default.put(new Request(key.toString()), forStore(new Response("planted copy", { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } }), 300));
    const { res, body } = await page("/benchmark");
    expect(body).not.toBe("planted copy");
    expect(res.headers.get(CACHE_STATE)).toBeNull();
    await caches.default.delete(new Request(key.toString()));
    await page("/benchmark");
    await new Promise((r) => setTimeout(r, 300));
    expect(await caches.default.match(new Request(key.toString()))).toBeUndefined();
  });

  it("the JSON twin and the dataset files keep their caching", async () => {
    for (const [path, accept] of [["/benchmark?format=json", "text/html"], ["/benchmark", "application/json"], ["/benchmark/v1.json", "application/json"], ["/benchmark/v1/traps.json", "application/json"]] as const) {
      const res = await fetchWorker(path, { headers: { Accept: accept } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toMatch(/^public, max-age=\d+/);
      expect(res.headers.get(BUILD_HEADER), path).toBeNull();
      await res.body?.cancel();
    }
  });
});

describe("5 and 6: Frontier guides promise only the runs they show, and say the names are shared", () => {
  it("with a practice run: it is shown, and the note says practice runs are shown", async () => {
    const { body } = await page("/best/payroll-change-frontier");
    expect(body).toContain(FRONTIER_RANKED_NOTE);
    expect(body).not.toContain(FRONTIER_NO_RUNS_NOTE);
    expect(body).toContain("<h2>Scorecard</h2>");
    expect(body).not.toContain("No refereed runs on this job yet.");
  });

  it("with no run at all: the note says no ranked or practice runs are published", async () => {
    for (const job of ["procurement-frontier"]) {
      const { body } = await page(`/best/${job}`);
      expect(body, job).toContain(`Task guide · Hard tier · Frontier jobs · ${FRONTIER_NO_RUNS_NOTE}</p>`);
      expect(body, job).not.toContain("so practice runs are shown");
      expect(body, job).toContain("No refereed runs on this job yet.");
    }
  });

  it("every Frontier guide says the people are invented and names come from one list; other guides don't", async () => {
    for (const job of ["data-request-frontier", "payroll-change-frontier", "procurement-frontier"]) expect((await page(`/best/${job}`)).body, job).toContain(FRONTIER_NAMES_NOTE);
    expect((await page("/best/refund")).body).not.toContain(FRONTIER_NAMES_NOTE);
  });
});
