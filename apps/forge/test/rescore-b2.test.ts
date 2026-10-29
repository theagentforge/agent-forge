import { Validator } from "@cfworker/json-schema";
import { env } from "cloudflare:workers";
import { Attempt, checkReplay, HARNESS_FROM, refereeCheck, playedUnderAt, rescoreRefusal, RULES_VERSION, rulesReading, rulesVersionAt, taskById, versionLine, type AttemptResult } from "@forge/arena";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkData, TRAP_SET_VERSIONS, trapSetVersions } from "../src/arena/benchmark";
import { benchmarkFileSchema } from "../src/arena/benchmark-files";
import { CORRECTIONS, correctionCounts, type Correction } from "../src/arena/corrections";
import { PRACTICE } from "../src/arena/lineup";
import { applyJobFor, approveApply, gridRows, RESCORE_APPROVAL_KEY, RESCORE_JOB_KEY, RESCORE_REPORT_KEY, rescoreTick, type RescoreJob, type RescoreReport } from "../src/arena/rescore-job";
import { rulesSpan, rulesText, tallyRules } from "../src/arena/rules-label";
import { planEvent, processQueue } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { sealRun, sha256Hex } from "../src/services/replay-keys";
import { securityJson } from "../src/web/security";
import { fetchWorker } from "./helpers";
import { queueApprovedApply } from "./rescore-helpers";
import "../src/index";

// B2-01 (ADR 0088): the rules 0.6 re-score made usable. Apply is gated on the admin's approval of a finished dry report,
// re-labels each re-scored run "scored under 0.6, played under 0.x" with its seal kept, refuses Hard v3 runs played
// before rules 0.3, reports a full before/after grid, and re-scored runs are shown apart from native 0.6 runs.

const model = PRACTICE[0]!;
const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function scripted(replies: { content?: string | null; tool_calls?: unknown[] }[]) {
  let i = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return { choices: [{ message: { content: r.content ?? null, tool_calls: r.tool_calls ?? [] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
  }) as never);
}
const honest = [
  { tool_calls: [call("get_accounts", {})] },
  { tool_calls: [call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })] },
];
const OCT = (d: number, h = 12) => Date.UTC(2026, 9, d, h);

beforeEach(async () => {
  vi.restoreAllMocks();
  for (const k of ["arena:lock", RESCORE_JOB_KEY, RESCORE_REPORT_KEY, RESCORE_APPROVAL_KEY]) await env.KV.delete(k);
});

/** Plays honest impossible-ask runs in a practice event and stores them as rules 0.2 runs (unstamped, finished 16 Oct). */
async function playedUnder02(slug: string, seeds: number[]) {
  scripted(honest);
  const eventId = await planEvent(env, { slug, name: slug, season: "s0", kind: "practice", models: [model.id], tasks: ["impossible"], seeds, attempts: 1 });
  await processQueue(env, Date.now() + 60_000);
  const db = getDb(env);
  const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
  for (const r of runs) {
    const { rules: _stamp, ...unstamped } = r.result as Record<string, unknown>;
    await db.update(t.arenaRuns).set({ result: unstamped as never, finishedAt: OCT(16) }).where(eq(t.arenaRuns.id, r.id));
  }
  return { eventId, runs: await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId)) };
}

describe("two rules readings (scored under, played under)", () => {
  it("a re-scored rules 0.2 run reads scored under rules 0.6, played under rules 0.2, in a group of its own", () => {
    const result: { rules?: string; rescored: unknown } = { rescored: { rules: "rules 0.6", played_under: "rules 0.2" } };
    expect(rulesReading(OCT(16), result)).toEqual({ scored_under: "rules 0.6", played_under: "rules 0.2", rescored: true });
    expect(playedUnderAt(OCT(16), result)).toBe("rules 0.2");
    expect(rulesVersionAt(OCT(16), result)).toBe("rules 0.6 re-scored");
    expect(rulesVersionAt(OCT(16), result)).not.toBe(RULES_VERSION);
    expect(versionLine("impossible", OCT(16), result)).toBe("Rules 0.6, re-scored from the signed log (played under rules 0.2) · Normal 1.0");
    // Not re-scored: one reading, unchanged.
    expect(rulesReading(OCT(16), {})).toEqual({ scored_under: "rules 0.2", played_under: "rules 0.2", rescored: false });
    expect(rulesVersionAt(OCT(27), { rules: "rules 0.6" })).toBe("rules 0.6");
  });

  it("refuses Hard v3 runs played before rules 0.3 (another harness); Normal and Hard v2 always qualify", () => {
    expect(HARNESS_FROM["weekend-hard3"]).toBe("rules 0.3");
    expect(rescoreRefusal("weekend-hard3", OCT(16, 23), null)).toBe("harness_changed");
    expect(rescoreRefusal("refund-hard3-2", OCT(16, 23), null)).toBe("harness_changed");
    expect(rescoreRefusal("weekend-hard3", OCT(17, 8), null)).toBeNull();
    expect(rescoreRefusal("weekend-hard", OCT(16, 12), null)).toBeNull();
    expect(rescoreRefusal("impossible", OCT(15, 12), null)).toBeNull();
  });

  it("labels: a span never reads a re-scored group as played under its rules, and each group's count is given", () => {
    const list = tallyRules([{ finishedAt: OCT(16), result: null }, { finishedAt: OCT(27), result: { rules: "rules 0.6" } }, { finishedAt: OCT(16), result: { rescored: { rules: "rules 0.6" } } }, { finishedAt: OCT(16), result: { rescored: { rules: "rules 0.6" } } }]);
    expect(list.map((x) => [x.version, x.n])).toEqual([["rules 0.2", 1], ["rules 0.6", 1], ["rules 0.6 re-scored", 2]]);
    expect(rulesSpan(list)).toBe("rules 0.2–0.6");
    expect(rulesText(list)).toBe("rules 0.2–0.6 (0.2: 1; 0.6: 1; 0.6 re-scored from signed logs: 2)");
    expect(rulesText([{ version: "rules 0.6 re-scored", n: 3 }])).toBe("rules 0.6, re-scored from signed logs");
  });
});

describe("apply is gated on the admin's approval", () => {
  it("an apply job without an approval is dropped unread; nothing changes", async () => {
    const { eventId, runs } = await playedUnder02("rsb2-gate", [11]);
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "apply", publicOnly: true } satisfies RescoreJob));
    expect(await rescoreTick(env)).toBeNull();
    expect(await env.KV.get(RESCORE_JOB_KEY)).toBeNull();
    const [after] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, runs[0]!.id));
    expect((after!.result as { rescored?: unknown }).rescored).toBeUndefined();
  });

  it("approval needs a finished dry report; it covers only that scope, and is used up by the apply", async () => {
    const { eventId } = await playedUnder02("rsb2-scope", [12]);
    expect(await approveApply(env, "admin:x")).toBeNull();
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "dry", publicOnly: true } satisfies RescoreJob));
    await rescoreTick(env);
    const a = (await approveApply(env, "admin:x"))!;
    expect(a).toMatchObject({ rules: RULES_VERSION, scope: { events: [eventId], tasks: null, publicOnly: true }, dry: { checked: 1 } });
    // A hand-written apply job of another scope (or without publicOnly) is refused even with an approval.
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: ["*"], mode: "apply", publicOnly: true } satisfies RescoreJob));
    expect(await rescoreTick(env)).toBeNull();
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "apply" } satisfies RescoreJob));
    expect(await rescoreTick(env)).toBeNull();
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify((await applyJobFor(env))!));
    expect((await rescoreTick(env))!).toMatchObject({ mode: "apply", done: true, relabelled: 1 });
    expect(await env.KV.get(RESCORE_APPROVAL_KEY)).toBeNull();
  });

  it("an apply job of exactly the approved scope but written by hand (no approval id) is dropped; a new dry run voids the approval", async () => {
    const { eventId, runs } = await playedUnder02("rsb2-hand", [16]);
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "dry", publicOnly: true } satisfies RescoreJob));
    await rescoreTick(env);
    const a = (await approveApply(env, "admin:x"))!;
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "apply", publicOnly: true } satisfies RescoreJob));
    expect(await rescoreTick(env)).toBeNull();
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "apply", publicOnly: true, approval: "guess" } satisfies RescoreJob));
    expect(await rescoreTick(env)).toBeNull();
    const [row] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, runs[0]!.id));
    expect((row!.result as { rescored?: unknown }).rescored).toBeUndefined();
    // A new dry run replaces the approved report: the approval (and its id) no longer stands.
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "dry", publicOnly: true } satisfies RescoreJob));
    await rescoreTick(env);
    expect(await env.KV.get(RESCORE_APPROVAL_KEY)).toBeNull();
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "apply", publicOnly: true, approval: a.id } satisfies RescoreJob));
    expect(await rescoreTick(env)).toBeNull();
  });
});

describe("a dry run started by code from before B2-01", () => {
  it("is restarted from the first run (never half old, half new), and a finished one can't be approved", async () => {
    const { eventId, runs } = await playedUnder02("rsb2-legacy", [17, 18]);
    const ids = runs.map((r) => r.id).sort();
    const legacy = { rules: RULES_VERSION, mode: "dry", events: [eventId], publicOnly: true, done: false, checked: 1, byEvent: {}, byModel: {}, changed: [], unfaithful: [], errors: [], updatedAt: "2026-10-28T10:00:00.000Z" };
    await env.KV.put(RESCORE_REPORT_KEY, JSON.stringify(legacy));
    await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ events: [eventId], mode: "dry", publicOnly: true, cursor: ids[0] } satisfies RescoreJob));
    const r = (await rescoreTick(env))!;
    expect(r).toMatchObject({ done: true, checked: 2 });
    expect(gridRows(r).map((g) => g.runs)).toEqual([2]);
    // A finished report from the old code (no grid, no exclusions) is never approved.
    await env.KV.put(RESCORE_REPORT_KEY, JSON.stringify({ ...legacy, done: true, checked: 2 }));
    expect(await approveApply(env, "admin:x")).toBeNull();
  });
});

describe("apply re-labels each re-scored run", () => {
  it("an unchanged run is re-labelled too: scored under 0.6, played under 0.2, verdict, stamp, log and seal untouched", async () => {
    const { eventId, runs } = await playedUnder02("rsb2-relabel", [13]);
    // Sealed as stored (unstamped), as a rules 0.2-era v2 run would be, so its published replay verifies before the apply.
    const r0 = runs[0]!;
    const seal = await sealRun(env, { kind: "arena", runId: r0.id, model: r0.modelId, rules: "rules 0.2", taskVersion: (r0.replaySeal as { task_version: string }).task_version, log: r0.log as never, result: r0.result as never, signedAt: OCT(16) });
    await getDb(env).update(t.arenaRuns).set({ replaySeal: seal as never }).where(eq(t.arenaRuns.id, r0.id));
    const [before] = (await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, r0.id))) as [typeof r0];
    await queueApprovedApply({ events: [eventId] });
    const r = (await rescoreTick(env))!;
    expect(r.changed).toEqual([]);
    const [after] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, before.id));
    const res = after!.result as AttemptResult & { rescored: { rules: string; played_under: string; changed: boolean; sealed?: unknown } };
    expect(rulesReading(after!.finishedAt!, res)).toEqual({ scored_under: RULES_VERSION, played_under: "rules 0.2", rescored: true });
    expect(res.rescored).toMatchObject({ rules: RULES_VERSION, played_under: "rules 0.2", changed: false });
    expect(res.rules).toBeUndefined();
    expect(after!.passed).toBe(before.passed);
    expect(after!.score).toBe(before.score);
    expect(after!.signature).toBe(before.signature);
    expect(JSON.stringify(after!.log)).toBe(JSON.stringify(before.log));
    // A sealed run keeps its seal bytes and the exact result the seal covers.
    expect(JSON.stringify(after!.replaySeal)).toBe(JSON.stringify(before.replaySeal));
    expect(before.replaySeal).toBeTruthy();
    expect(res.rescored.sealed).toEqual(before.result);
    // forge verify (CLI 0.5.1) still passes on the published replay: chain, record and the referee re-run.
    const doc = (await (await fetchWorker(`/arena/run/${before.id}.json`)).json()) as Record<string, unknown>;
    expect(await checkReplay(doc, sha256Hex, null)).toMatchObject({ format: 2, chain: "ok", record: "ok", rescored_rules: RULES_VERSION });
    expect(refereeCheck(doc)).toMatchObject({ checked: true, same_verdict: true, faithful: true, rules_of_run: RULES_VERSION });
    const { rescored: _n, ...rest } = res;
    expect(rest).toEqual(before.result);
    // Running it again changes nothing more: already re-scored under these rules.
    await queueApprovedApply({ events: [eventId] });
    const again = (await rescoreTick(env))!;
    expect(again.relabelled).toBe(0);
    expect(again.excluded).toEqual([{ id: before.id, model: model.id, task: "impossible", reason: "already_rescored" }]);
  });

  it("refuses Hard v3 runs before rules 0.3, never touches runs played under rules 0.6 or unfaithful replays, and reports a full grid", async () => {
    const { eventId, runs } = await playedUnder02("rsb2-grid", [14, 15]);
    const db = getDb(env);
    // One run re-stamped as native rules 0.6 (played under the rules in force).
    await db.update(t.arenaRuns).set({ result: { ...(runs[1]!.result as object), rules: RULES_VERSION } as never, finishedAt: OCT(27) }).where(eq(t.arenaRuns.id, runs[1]!.id));
    // A Hard v3 run finished on 16 Oct (rules 0.2): another harness.
    const a = new Attempt(taskById("weekend-hard3")!, 1_234_567);
    a.call("finish", { status: "done", summary: "done" });
    const hard = { id: crypto.randomUUID(), eventId, modelId: model.id, task: "weekend-hard3", seed: 1_234_567, attemptNo: 1, status: "done" as const, passed: false, score: 0, result: a.end("finished") as never, log: a.log as never, finishedAt: OCT(16) };
    await db.insert(t.arenaRuns).values(hard);
    // An unfaithful replay: its logged start event names another seed's world.
    const log = [...(runs[0]!.log as { type: string }[])];
    const bad = { ...runs[0]!, id: crypto.randomUUID(), seed: 999_999, log: log as never };
    await db.insert(t.arenaRuns).values(bad);
    await queueApprovedApply({ events: [eventId] });
    const r = (await rescoreTick(env))!;
    expect(r.excluded!.map((x) => [x.id, x.reason]).sort()).toEqual([[hard.id, "harness_changed"], [runs[1]!.id, "played_under_current_rules"]].sort());
    // Not replayable as logged: reported (not faithful, or an error), never changed.
    expect([...r.unfaithful.map((x) => x.id), ...r.errors.map((x) => x.id)]).toContain(bad.id);
    for (const id of [hard.id, runs[1]!.id, bad.id]) {
      const [row] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.id, id));
      expect((row!.result as { rescored?: unknown }).rescored, id).toBeUndefined();
    }
    // Every model × job checked, not only changed runs.
    const grid = gridRows(r);
    expect(grid.map((g) => [g.task, g.runs])).toEqual([["impossible", 3], ["weekend-hard3", 1]]);
    expect(grid[0]).toMatchObject({ rescored: 1, excluded: 1, before: { passes: 3 }, after: { passes: 3 } });
    expect(grid[1]).toMatchObject({ excluded: 1, rescored: 0, before: { passes: 0 }, after: { passes: 0 }, played_under: { "rules 0.2": 1 } });
  });
});

describe("re-scored runs are shown apart from native rules 0.6 runs", () => {
  it("Trap Set rows, /security and its JSON keep native and re-scored groups apart", async () => {
    const db = getDb(env);
    const eventId = crypto.randomUUID();
    await db.insert(t.arenaEvents).values({ id: eventId, slug: "rsb2-ranked", name: "Re-score ranked", season: "s0", kind: "card", status: "done" });
    const SONNET = "claude-sonnet-5.5";
    const run = (seed: number, fell: boolean, extra: Record<string, unknown>, finishedAt: number) => {
      const a = new Attempt(taskById("scam-invoice")!, seed);
      a.call("finish", { status: "done", summary: "done" });
      const base = a.end("finished");
      const trap = base.traps[0]!.id;
      const result = { ...base, passed: !fell, traps: base.traps.map((x) => ({ ...x, triggered: fell && x.id === trap })), ...extra };
      return { id: crypto.randomUUID(), eventId, modelId: SONNET, task: "scam-invoice", seed, attemptNo: 1, status: "done" as const, passed: !fell, score: 0.5, result: result as never, log: a.log as never, finishedAt };
    };
    await db.insert(t.arenaRuns).values([
      run(3_000_001, true, { rules: RULES_VERSION }, OCT(27)),
      run(3_000_002, false, { rules: RULES_VERSION }, OCT(27)),
      run(3_000_003, true, { rescored: { rules: RULES_VERSION, played_under: "rules 0.4" } }, OCT(20)),
      run(3_000_004, true, { rescored: { rules: RULES_VERSION, played_under: "rules 0.4" } }, OCT(20)),
      run(3_000_005, false, { rescored: { rules: RULES_VERSION, played_under: "rules 0.4" } }, OCT(20)),
    ]);
    const bench = await benchmarkData(db, env.PUBLIC_ORIGIN);
    const rows = bench.results.models.filter((m) => m.model === SONNET && m.tier === "normal");
    const native = rows.find((m) => m.rules_version === RULES_VERSION)!;
    const rescored = rows.find((m) => m.rules_version === `${RULES_VERSION} re-scored`)!;
    expect(native).toMatchObject({ attempts: 2, rescored_from_signed_logs: false, played_under: { [RULES_VERSION]: 2 } });
    expect(rescored).toMatchObject({ attempts: 3, rescored_from_signed_logs: true, scored_under: RULES_VERSION, played_under: { "rules 0.4": 3 }, scored_under_trap_set_rules: true });
    expect(bench.limits.model_tier_rows_rescored_from_signed_logs).toBeGreaterThanOrEqual(1);
    // The whole-file schema (ADR 0087) accepts both groups.
    const check = new Validator(benchmarkFileSchema(env.PUBLIC_ORIGIN) as never, "2020-12", false).validate(JSON.parse(JSON.stringify(bench)));
    expect(check.errors.slice(0, 3)).toEqual([]);
    const page = await (await fetchWorker("/benchmark", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("re-scored from signed logs");

    const sec = await securityJson(env);
    expect(sec.arena.rules_version).toBe(RULES_VERSION);
    expect(sec.arena.attempts).toBe(2);
    expect(sec.arena.attempts_under_older_rules.map((v) => v.rules_version)).not.toContain(`${RULES_VERSION} re-scored`);
    expect(sec.arena.rescored).toMatchObject({ rules_version: `${RULES_VERSION} re-scored`, scored_under: RULES_VERSION, pooled_with_native: false, attempts: 3, played_under: [{ rules_version: "rules 0.4", attempts: 3 }] });
    const html = await (await fetchWorker("/security", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain('id="rescored"');
    expect(html).toContain("re-scored under");
  });
});

describe("Trap Set 1.1", () => {
  it("versions are dated in order: a correction flipped with a date before 1.0 fails here (set its date to the day it is published)", () => {
    const dates = TRAP_SET_VERSIONS.map((v) => v.date);
    expect([...dates].sort()).toEqual(dates);
    const c = CORRECTIONS.find((x) => x.id === "2026-10-rules-0.6-negation")!;
    if (c.published && c.applied && c.counts) expect(c.date >= TRAP_SET_VERSIONS[0]!.date).toBe(true);
  });

  const applied: Correction = { ...CORRECTIONS[0]!, date: "2026-10-30", applied: true, published: true, counts: { checked: 5400, changed: 12, passToFail: 5, failToPass: 7, events: 4, models: 5, unfaithful: 10, excluded: 3 } };
  it("is 1.0 until the re-score correction is applied and published; then 1.1, dated, with a changelog line", () => {
    expect(trapSetVersions().map((v) => v.version)).toEqual(["1.0", "1.0.1"]);
    expect(trapSetVersions([{ ...applied, applied: false }]).map((v) => v.version)).toEqual(["1.0", "1.0.1"]);
    const v = trapSetVersions([applied]);
    expect(v.map((x) => x.version)).toEqual(["1.0", "1.0.1", "1.1"]);
    expect(v[2]).toMatchObject({ date: "2026-10-30", rules: RULES_VERSION, task_versions: v[0]!.task_versions });
    expect(v[2]!.change).toContain("Re-scored runs carry both their rules versions");
    expect(v[2]!.change).toContain("5400 published runs");
    expect(correctionCounts(applied)).toContain("played under rules 0.x");
    expect(correctionCounts(applied)).toContain("3 Hard v3 runs played before rules 0.3");
  });
});
