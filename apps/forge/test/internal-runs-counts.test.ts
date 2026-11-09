import { env } from "cloudflare:workers";
import { FRONTIER_TASK_IDS, PRACTICE_ONLY_TASK_IDS } from "@forge/arena";
import { describe, expect, it } from "vitest";
import { finishedRuns, rankedModelIds } from "../src/arena/views";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { proofStrip } from "../src/services/proof-strip";
import { BLENDED_RULES } from "../src/services/public-stats";
import { workTotals } from "../src/services/site-pulse";
import { statsData } from "../src/web/stats";
import { EMBARGOED } from "./fixtures/embargoed";
import { fillPrivateLists } from "./internal-runs-helpers";
import "../src/index";

// Weekly brief 9 Nov: /stats.json said 540 ranked bouts on 9 models while /arena and /benchmark showed 6. The totals
// counted every run, so a held event (status "planned"), the embargoed model, private and practice-only jobs and the
// frontier calibration seeds were in public numbers. No held, private or practice-only run may count in any of them.

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const db = () => getDb(env);
const sprung = { traps: [{ id: "x", triggered: true }] };
const clearStrip = () => env.KV.delete("proof-strip:v3");

async function event(kind: "card" | "guest" | "practice", status: "planned" | "running" | "done") {
  const id = uid("ev");
  await db().insert(t.arenaEvents).values({ id, slug: id, name: id, season: "s1", kind, status });
  return id;
}
async function run(eventId: string, modelId: string, task: string, seed: number, heldOut = false) {
  await db().insert(t.arenaRuns).values({ id: uid("run"), eventId, modelId, task, seed, attemptNo: 1, status: "done", finishedAt: Date.now(), heldOut, result: sprung as never });
}

/** One run of every internal kind, each on a model id of its own, plus one public ranked run and one held-out run. */
async function seed() {
  const publicModel = uid("public-model");
  const heldModel = uid("held-model");
  const privateModel = uid("private-model");
  const calModel = uid("cal-model");
  const heldOutModel = uid("heldout-model");
  const card = await event("card", "done");
  await run(card, publicModel, "refund", 1_200_000_001);
  // Internal: a held ranked event, a held practice event, the embargoed model, a private job, a calibration seed.
  await run(await event("card", "planned"), heldModel, "refund", 1_200_000_002);
  await run(await event("practice", "planned"), heldModel, "refund", 1_200_000_003);
  await run(card, EMBARGOED.id, "refund", 1_200_000_004);
  await run(await event("practice", "done"), privateModel, PRACTICE_ONLY_TASK_IDS[0]!, 1_200_000_005);
  await run(await event("practice", "done"), calModel, FRONTIER_TASK_IDS[0]!, 900_001);
  await run(card, calModel, FRONTIER_TASK_IDS[0]!, 900_002);
  // A held-out seed in a public ranked event: in the running totals (published as an aggregate), not in the Arena line.
  await run(card, heldOutModel, "refund", 1_200_000_006, true);
  return { publicModel, internalModels: [heldModel, privateModel, calModel, EMBARGOED.id], heldOutModel };
}

describe("held, private and practice-only runs never count in a public number", () => {
  it("guards the fixtures: there is a private job and a frontier job to seed", () => {
    expect(PRACTICE_ONLY_TASK_IDS.length).toBeGreaterThan(0);
    expect(FRONTIER_TASK_IDS.length).toBeGreaterThan(0);
  });

  it("the running totals (/stats, home band, /about, /dataset) count the public and held-out runs only", async () => {
    const before = await workTotals(env);
    await seed();
    const after = await workTotals(env);
    // Of the 8 seeded runs, the public run and the held-out run count; the 6 internal ones don't.
    expect((after.bouts_refereed ?? 0) - (before.bouts_refereed ?? 0)).toBe(2);
    expect((after.ranked_bouts ?? 0) - (before.ranked_bouts ?? 0)).toBe(2);
    expect((after.traps_sprung ?? 0) - (before.traps_sprung ?? 0)).toBe(2);
  });

  it("the Arena line on /stats counts the runs and models /arena ranks, and no internal model", async () => {
    const { publicModel, internalModels, heldOutModel } = await seed();
    await clearStrip();
    const strip = await proofStrip(env);
    const ranked = await rankedModelIds(db());
    expect(ranked.has(publicModel)).toBe(true);
    for (const m of [...internalModels, heldOutModel]) expect(ranked.has(m), m).toBe(false);
    expect(strip.models).toBe(ranked.size);
    expect(strip.bouts).toBe((await finishedRuns(db(), { kinds: ["card", "guest"], hard: true })).length);
    await clearStrip();
    const s = await statsData(env);
    expect(s.blended.our_arena).toMatchObject({ models_ranked: ranked.size, ranked_bouts: strip.bouts, traps_sprung_ranked: strip.traps_sprung });
    expect(JSON.stringify(s)).not.toContain(EMBARGOED.id);
  });

  it("the published SQL for each total reproduces it, internal runs included in the data", async () => {
    await seed();
    const work = await workTotals(env);
    for (const [k, v] of [["bouts_refereed", work.bouts_refereed], ["ranked_bouts", work.ranked_bouts], ["traps_sprung", work.traps_sprung]] as const) {
      const rule = BLENDED_RULES.find((r) => r.key === k)!;
      // The rules never name an embargoed model or a private job: the two lists are placeholders.
      expect(rule.reproduce).toContain("<EMBARGOED_MODEL_IDS>");
      expect(rule.reproduce).toContain("<PRIVATE_TASK_IDS>");
      expect(rule.reproduce).not.toContain(EMBARGOED.id);
      for (const id of PRACTICE_ONLY_TASK_IDS) expect(rule.reproduce).not.toContain(`'${id}'`);
      const row = await env.DB.prepare(fillPrivateLists(rule.reproduce)).first<Record<string, number>>();
      expect(Number(Object.values(row!)[0]), k).toBe(v);
    }
  });
});
