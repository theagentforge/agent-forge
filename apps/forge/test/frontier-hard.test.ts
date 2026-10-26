import { Attempt, DEFAULT_CAPS, HARD3_TASKS, HARD_TASKS, type TaskType } from "@forge/arena";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { frontierHard } from "../src/arena/board";
import { HEADLINE } from "../src/arena/lineup";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { labBand } from "../src/web/home-wire";
import { fetchWorker } from "./helpers";
import "../src/index";

// 25 Oct 2026 (Dinike): the frontier line under the Lab #3 band counts the latest headline Hard event only (Crucible 2:
// Hard, Hard v3 jobs), from refereed results: a fall is a trap the referee marked sprung, a knockout is never one, and
// embargoed models (ADR 0041), held events, Lab arms and short weekly bouts never count. "See them" lists exactly
// those falls on /arena/event/<slug>/falls.

const HOUR = 3_600_000;
const now = Date.now();
const MODELS = HEADLINE.filter((m) => !m.retired && !m.embargoed).map((m) => m.id).slice(0, 6);
const EMBARGOED = HEADLINE.filter((m) => m.embargoed).map((m) => m.id);

type Run = typeof t.arenaRuns.$inferInsert;
let n = 0;
/** One finished run; `fell` marks the job's first trap sprung, `ko` ends it as a knockout. */
function run(eventId: string, modelId: string, task: TaskType, attemptNo: number, finishedAt: number, o: { fell?: boolean; ko?: boolean } = {}): Run {
  let clock = 0;
  const a = new Attempt(task, 1_400_000, { caps: task.caps ?? DEFAULT_CAPS, now: () => (clock += 1000) });
  a.recordTurn({ tokensIn: 900, tokensOut: 40, cost: 0.002, latencyMs: 700, text: "ok" });
  a.call("finish", { status: "cannot_complete", summary: "Stopping." });
  const result = structuredClone(a.result!);
  result.traps = task.traps.map((x, i) => ({ ...x, triggered: !!o.fell && i === 0 })) as typeof result.traps;
  if (o.ko) (result as { reason?: string }).reason = "knockout_turns";
  return { id: `fh-${eventId}-${n++}`, eventId, modelId, task: task.id, seed: 1_400_000, attemptNo, status: "done", passed: false, score: 0.4, cost: 0.01, tokens: 940, provider: "test", result, log: a.log, finishedAt: finishedAt + n };
}

/** `count` runs of an event across MODELS and `tasks`, the first `falls` of them with a sprung trap. */
function event(eventId: string, tasks: TaskType[], count: number, falls: number, at: number, extra: { ko?: number } = {}) {
  const out: Run[] = [];
  for (let i = 0; i < count; i++) out.push(run(eventId, MODELS[i % MODELS.length]!, tasks[i % tasks.length]!, 1 + (i % 3), at, { fell: i < falls, ko: i >= falls && i < falls + (extra.ko ?? 0) }));
  return out;
}

beforeAll(async () => {
  const db = getDb(env);
  await db.insert(t.arenaEvents).values([
    { id: "fh-c1h", slug: "crucible-1-hard", name: "Crucible 1: Hard", season: "s0", kind: "card", status: "done" },
    { id: "fh-c2h", slug: "crucible-2-hard", name: "Crucible 2: Hard", season: "s0", kind: "card", status: "running" },
    { id: "fh-wk", slug: "weekly-2026-10-29", name: "Weekly headline bout", season: "s0", kind: "card", status: "running" },
    { id: "fh-held", slug: "crucible-3-hard", name: "Crucible 3: Hard", season: "s0", kind: "card", status: "planned" },
    { id: "fh-lab", slug: "lab-5-none", name: "Lab #5 arm", season: "s0", kind: "card", status: "done", arm: "none" },
  ]);
  const runs = [
    ...event("fh-c1h", HARD_TASKS, 108, 11, now - 100 * HOUR),
    // Crucible 2: Hard: 40 public bouts, 7 with a sprung trap, 5 knockouts without one (not falls).
    ...event("fh-c2h", HARD3_TASKS, 40, 7, now - 20 * HOUR, { ko: 5 }),
    // An embargoed model's falls in the same event never count.
    ...EMBARGOED.flatMap((m) => [run("fh-c2h", m, HARD3_TASKS[0]!, 1, now - 20 * HOUR, { fell: true }), run("fh-c2h", m, HARD3_TASKS[1]!, 1, now - 20 * HOUR, { fell: true })]),
    // Newer, but never the headline event: a weekly bout (under 30 bouts), a held event and a Lab arm.
    ...event("fh-wk", [HARD3_TASKS[2]!], 18, 9, now - 5 * HOUR),
    ...event("fh-held", HARD3_TASKS, 36, 30, now - 3 * HOUR),
    ...event("fh-lab", HARD3_TASKS, 36, 30, now - 2 * HOUR),
  ];
  await db.batch(runs.map((r) => db.insert(t.arenaRuns).values(r)) as [any, ...any[]]);
});

describe("the frontier Hard line comes from the latest headline Hard event", () => {
  it("counts Crucible 2: Hard alone: sprung traps only, no knockouts, embargoed models, held events or Lab arms", async () => {
    await env.KV.delete(`arena:frontier-hard:v3:${new Date(now).toISOString().slice(0, 13)}`);
    const f = await frontierHard(env, getDb(env), now);
    expect(f).toEqual({ event: { slug: "crucible-2-hard", name: "Crucible 2: Hard" }, runs: 40, fell: 7, models: MODELS.length });
  });

  it("names the event and links to its falls on the home page; the Lab #3 and Lab #4 lines stay", async () => {
    const body = await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text();
    expect(body).toContain('<a href="/arena/event/crucible-2-hard/falls?from=home-lab">See the 7 falls in Crucible 2: Hard</a>');
    expect(body).toContain("Our card's best estimate is 16% fewer, but 210 bouts weren't enough to prove it (<a href=\"/lab/4/results?from=home-lab\">Lab #4</a>)");
    expect(body).not.toContain("Hard traps.");
  });

  it("hides the line with no qualifying event or under 30 bouts", () => {
    expect(String(labBand(null))).not.toContain("/falls?from=home-lab");
    expect(String(labBand({ event: { slug: "x", name: "X" }, runs: 29, fell: 3, models: 6 }))).not.toContain("/falls?from=home-lab");
  });

  it("is cached per UTC hour, including 'no event yet'", async () => {
    const at = Date.parse("2026-12-02T10:15:00Z");
    const hit = { event: { slug: "c", name: "C" }, runs: 1, fell: 1, models: 1 };
    await env.KV.put("arena:frontier-hard:v3:2026-12-02T10", JSON.stringify(hit));
    expect(await frontierHard(env, getDb(env), at)).toEqual(hit);
    await env.KV.put("arena:frontier-hard:v3:2026-12-02T12", JSON.stringify({ none: true }));
    expect(await frontierHard(env, getDb(env), at + 2 * HOUR)).toBeNull();
    expect((await frontierHard(env, getDb(env), at + HOUR))?.event.slug).toBe("crucible-2-hard");
  });
});

describe("/arena/event/<slug>/falls lists exactly those falls", () => {
  it("shows the same count as the home line, one entry per sprung attempt, and no embargoed model", async () => {
    const res = await fetchWorker("/arena/event/crucible-2-hard/falls", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("7 of 40 attempts fell for a trap");
    expect(body.match(/<span class="outcome o-failed">⚠/g)).toHaveLength(7);
    for (const m of EMBARGOED) expect(body).not.toContain(m);
  });

  it("has a JSON twin of ids and numbers", async () => {
    const j = (await (await fetchWorker("/arena/event/crucible-2-hard/falls?format=json")).json()) as { attempts: number; fell: number; falls: { url: string; traps: unknown[] }[]; rule: unknown };
    expect(j.attempts).toBe(40);
    expect(j.fell).toBe(7);
    expect(j.falls).toHaveLength(7);
    expect(j.falls.every((f) => f.url.startsWith("/arena/run/") && f.traps.length === 1)).toBe(true);
    expect(j.rule).toEqual({ fell: "trap_marked_triggered_by_referee", knockout: "not_a_fall" });
  });

  it("is a 404 for a held event, and the event page links to it", async () => {
    expect((await fetchWorker("/arena/event/crucible-3-hard/falls")).status).toBe(404);
    const body = await (await fetchWorker("/arena/event/crucible-2-hard", { headers: { Accept: "text/html" } })).text();
    expect(body).toContain('href="/arena/event/crucible-2-hard/falls"');
  });
});
