import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { benchmarkData, CONTAMINATION_MIN_EVENTS, contaminationStatus, eventWorlds, type EventWorlds } from "../src/arena/benchmark";
import { MIN_GAP_ATTEMPTS } from "../src/arena/holdout";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0071: "Contamination effect not known" stays in /benchmark's limits until the effect is established under the
// ADR 0058 rules (measured rows whose public versions were all published before the event, from at least two events).
// One measured contamination row must not remove it.

const SONNET = "claude-sonnet-5.5";
const PUBLIC_SEED = 1_400_321;
const HELD_SEED = 1_900_765;
const LIMIT = "contamination_effect_on_previously_published_job_versions";
const HOUR = 3_600_000;

async function run(eventId: string, seed: number, attemptNo: number, passed: boolean, heldOut: boolean, finishedAt: number) {
  const a = new Attempt(taskById("refund")!, seed);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const result = { ...a.end("finished"), passed } as AttemptResult;
  const id = crypto.randomUUID().replace(/-/g, "");
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: SONNET, task: "refund", seed, attemptNo, status: "done", passed, score: passed ? 1 : 0, cost: 0.01, tokens: 950, heldOut,
    result, log: a.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(a.log) }), finishedAt,
  });
}

/** A ranked event whose public arm replays `pub` (already published) against a held-out arm on `held`, n a side. */
async function contaminationEvent(slug: string, createdAt: number, pub = PUBLIC_SEED, held = HELD_SEED) {
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id, slug, name: slug, season: "s0", kind: "card", status: "done", createdAt });
  for (let i = 1; i <= MIN_GAP_ATTEMPTS; i++) {
    await run(id, pub, i, true, false, createdAt + HOUR);
    await run(id, held, i, i % 2 === 0, true, createdAt + HOUR);
  }
}

/** A ranked event with public runs only, so `seed` counts as published before later events. */
async function firstPublish(slug: string, createdAt: number, seed: number) {
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id, slug, name: slug, season: "s0", kind: "card", status: "done", createdAt });
  for (let i = 1; i <= 3; i++) await run(id, seed, i, true, false, createdAt + HOUR);
}

type Bench = { limits: { not_known: string[] }; data_protection: { public_vs_private_gap: { rows_testing_contamination: number; contamination: { status: string; test_rows: number; test_events: number; test_world_sets: { public: number; held_out: number } } } } };
const bench = async () => (await (await fetchWorker("/benchmark/v1.json")).json()) as Bench;

describe("contaminationStatus (ADR 0071)", () => {
  const row = (event: string, public_arm: string, status = "measured") => ({ event, status, public_arm });
  // Each event on its own job versions unless a test says otherwise.
  const own = (...events: string[]): EventWorlds => new Map(events.map((e) => [e, { pub: `p-${e}`, held: `h-${e}` }]));

  it("counts only measured rows whose public versions were all published before", () => {
    expect(contaminationStatus([], own())).toMatchObject({ status: "not_yet_measured", test_rows: 0 });
    expect(contaminationStatus([row("a", "fresh"), row("b", "mixed"), row("c", "previously_published", "not_enough_bouts")], own("a", "b", "c"))).toMatchObject({ status: "not_yet_measured", test_rows: 0 });
  });

  it("is not established from one event, however many rows it has", () => {
    expect(contaminationStatus([row("a", "previously_published")], own("a"))).toMatchObject({ status: "not_yet_established", test_rows: 1, test_events: 1 });
    expect(contaminationStatus([row("a", "previously_published"), row("a", "previously_published")], own("a"))).toMatchObject({ status: "not_yet_established", test_rows: 2, test_events: 1 });
    expect(contaminationStatus([row("a", "previously_published"), row("b", "previously_published")], own("a", "b"))).toMatchObject({ status: "established", test_events: CONTAMINATION_MIN_EVENTS, test_world_sets: { public: 2, held_out: 2 } });
  });

  it("is not established by two events that replay the same comparison (Amendment 1)", () => {
    const rows = [row("a", "previously_published"), row("b", "previously_published")];
    const same: EventWorlds = new Map([["a", { pub: "p", held: "h" }], ["b", { pub: "p", held: "h" }]]);
    expect(contaminationStatus(rows, same)).toMatchObject({ status: "not_yet_established", test_events: 2, test_world_sets: { public: 1, held_out: 1 } });
    // New public versions against the same private ones still can't rule out a harder held-out world, and vice versa.
    expect(contaminationStatus(rows, new Map([["a", { pub: "p1", held: "h" }], ["b", { pub: "p2", held: "h" }]]))).toMatchObject({ status: "not_yet_established" });
    expect(contaminationStatus(rows, new Map([["a", { pub: "p", held: "h1" }], ["b", { pub: "p", held: "h2" }]]))).toMatchObject({ status: "not_yet_established" });
    // An event with no known worlds adds nothing.
    expect(contaminationStatus(rows, own("a"))).toMatchObject({ status: "not_yet_established" });
  });
});

describe("/benchmark limits keep the contamination item until it is established (ADR 0071)", () => {
  const now = Date.now();
  beforeAll(async () => {
    // The public version is first published in an earlier event (no held-out arm, so no gap row of its own).
    const first = crypto.randomUUID();
    await getDb(env).insert(t.arenaEvents).values({ id: first, slug: "contam-first-publish", name: "First publish", season: "s0", kind: "card", status: "done", createdAt: now - 10 * HOUR });
    for (let i = 1; i <= 3; i++) await run(first, PUBLIC_SEED, i, true, false, now - 9 * HOUR);
    await contaminationEvent("contam-round-1", now - 5 * HOUR);
  });

  it("one measured contamination row: still listed as not known, and the page says not yet established", async () => {
    const d = await bench();
    expect(d.data_protection.public_vs_private_gap).toMatchObject({ rows_testing_contamination: 1, contamination: { status: "not_yet_established", test_rows: 1, test_events: 1 } });
    expect(d.limits.not_known).toContain(LIMIT);
    const page = await (await fetchWorker("/benchmark", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("measured in 1 event, not yet established");
    expect(page).toContain("Not established yet");
    expect(page).toContain("contamination test");
  });

  it("a second event replaying the same public and held-out versions doesn't establish it", async () => {
    await contaminationEvent("contam-round-2", now - 4 * HOUR);
    const d = (await benchmarkData(getDb(env), env.PUBLIC_ORIGIN)) as unknown as Bench;
    expect(d.data_protection.public_vs_private_gap.contamination).toMatchObject({ status: "not_yet_established", test_events: 2, test_world_sets: { public: 1, held_out: 1 } });
    expect(d.limits.not_known).toContain(LIMIT);
  });

  it("an event on other public and held-out versions establishes it, and only then the limit drops", async () => {
    await firstPublish("contam-first-publish-2", now - 8 * HOUR, PUBLIC_SEED + 1);
    await contaminationEvent("contam-round-3", now - 2 * HOUR, PUBLIC_SEED + 1, HELD_SEED + 1);
    // Pages are edge-cached for a few minutes, so read the data the page renders from directly.
    const d = (await benchmarkData(getDb(env), env.PUBLIC_ORIGIN)) as unknown as Bench;
    expect(d.data_protection.public_vs_private_gap.contamination).toMatchObject({ status: "established", test_events: 3, test_world_sets: { public: 2, held_out: 2 } });
    expect(d.limits.not_known).not.toContain(LIMIT);
    // The JSON carries counts only, never the held-out seeds behind them.
    const text = JSON.stringify(d);
    expect(text).not.toContain(String(HELD_SEED));
    expect(text).not.toContain(String(HELD_SEED + 1));
    const w = await eventWorlds(getDb(env), ["contam-round-1", "contam-round-3"]);
    expect(w.get("contam-round-1")).toEqual({ pub: `refund:${PUBLIC_SEED}`, held: `refund:${HELD_SEED}` });
  });
});
