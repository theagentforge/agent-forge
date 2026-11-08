import { env } from "cloudflare:workers";
import { DEV_SPLIT, FRONTIER_1_1_CATALOG, FRONTIER_1_1_FREEZE, FRONTIER_1_1_TASK_IDS, FRONTIER_1_2_CATALOG, FRONTIER_1_2_FREEZE, FRONTIER_1_2_TASK_IDS, FRONTIER_FREEZE, FRONTIER_TASK_IDS, isPracticeOnly, PRIVATE_TASK_IDS } from "@forge/arena";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isClaudeByok } from "../src/arena/credit";
import { freeLaneRunRefusal, isFreeVariant } from "../src/arena/free-lane";
import { modelById } from "../src/arena/lineup";
import { isPlainPractice, planEvent, planSchema } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import plans from "../../../docs/data/frontier-calibration-r1.json";
import plansR2 from "../../../docs/data/frontier-calibration-r2.json";
import plansR3 from "../../../docs/data/frontier-calibration-r3.json";
import plansV11 from "../../../docs/data/frontier-1-1-calibration.json";
import plansV12 from "../../../docs/data/frontier-1-2-calibration.json";
import { CAL_PLANS, CLAUDE_POOL, FRONTIER_POOL, MIN_N, trapTable, V11_ROUND, V12_ROUND } from "../src/arena/frontier-calibration";

// The frontier tier's round-1 calibration plan (ADR 0139), a ready-to-run `arena:plan` value the coordinator queues:
// held practice events on the dev seeds only, several models (never one), the three frontier jobs.

describe("frontier calibration plan, round 1", () => {
  it("planSchema accepts every part as written: held practice, dev seeds only, frontier jobs, models in the lineup", () => {
    expect(plans).toHaveLength(3);
    const models = new Set<string>();
    for (const raw of plans) {
      const p = planSchema.parse(raw);
      expect(p).toMatchObject({ kind: "practice", hold: true });
      expect(isPlainPractice(p)).toBe(false);
      expect(p.tasks).toEqual([...FRONTIER_TASK_IDS]);
      for (const s of p.seeds) expect(FRONTIER_FREEZE.devSeeds).toContain(s);
      for (const s of p.seeds) expect(DEV_SPLIT.seeds as readonly number[]).toContain(s);
      for (const m of p.models) {
        expect(modelById(m), m).not.toBeNull();
        models.add(m);
      }
    }
    expect(models.size).toBeGreaterThanOrEqual(5);
    // Every Claude model runs on our own Anthropic key (BYOK), never on OpenRouter credit.
    for (const m of ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5"]) expect(isClaudeByok(modelById(m)!)).toBe(true);
  });

  it("names no free variant, which the runner would void on a frontier job (review 5 Nov), and no retired model", () => {
    for (const raw of plans)
      for (const m of raw.models) {
        expect(isFreeVariant(modelById(m)!), m).toBe(false);
        expect(modelById(m)!.retired ?? false, m).toBe(false);
      }
    // Why: a free variant only plays the six public Gauntlet jobs in plain practice (ADR 0109 Amendment 1).
    for (const task of FRONTIER_TASK_IDS) expect(freeLaneRunRefusal({ task, seed: 900_001 }, { kind: "practice", status: "planned" })).not.toBeNull();
  });

  it("since promotion (Amendment 5) a ranked event may list the frontier jobs, but never on a calibration seed", () => {
    // Was: refused while calibrating (isPracticeOnly true). Promoted on Dinike's yes, 7 Nov 16:24 Colombo.
    for (const id of FRONTIER_TASK_IDS) expect(isPracticeOnly(id)).toBe(false);
    const card = { ...plans[1], slug: "frontier-ranked-fresh", kind: "card", seeds: [1_500_000_001] };
    expect(planSchema.safeParse(card).success).toBe(true);
    // Every calibration seed stays practice-only, in a card (below the Season minimum) and in a guest event too.
    for (const seed of FRONTIER_FREEZE.devSeeds)
      for (const kind of ["card", "guest"]) expect(planSchema.safeParse({ ...card, kind, seeds: [seed] }).success, `${kind} ${seed}`).toBe(false);
    // The held-out variants stay practice-only. They exist only in the private repo (the public mirror stubs private
    // families out), so the check runs where they exist; the private repo is the one that's released.
    if (PRIVATE_TASK_IDS.includes("data-request-frontier-x"))
      expect(planSchema.safeParse({ ...card, tasks: ["data-request-frontier-x"] }).success).toBe(false);
  });

  it("queues 114 held bouts", async () => {
    const db = getDb(env);
    let total = 0;
    for (const raw of plans) {
      const id = await planEvent(env, planSchema.parse({ ...raw, slug: `${raw.slug}-check` }));
      const [event] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.id, id));
      expect(event).toMatchObject({ kind: "practice", status: "planned" });
      const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      total += runs.length;
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      await db.delete(t.arenaEvents).where(eq(t.arenaEvents.id, id));
    }
    expect(total).toBe(1 * 3 * 3 + 1 * 3 * 5 + 3 * 3 * 5 * 2);
  });
});

// ADR 0139 Amendment 2: round 2's plan, written before any round-2 run. Claude models only (Workers AI practice moves
// about one bout a day on the free allowance, and paying for it is Dinike's decision), the ten calibration seeds, and
// Opus split in two so the second half is queued only if the spend check after the first allows it.
describe("frontier calibration plan, round 2", () => {
  it("planSchema accepts every part: held practice, calibration seeds only, the three frontier jobs, Claude on our own key", () => {
    expect(plansR2.map((p) => p.slug)).toEqual(["frontier-cal-r2-haiku", "frontier-cal-r2-sonnet", "frontier-cal-r2-opus-a", "frontier-cal-r2-opus-b"]);
    for (const raw of plansR2) {
      const p = planSchema.parse(raw);
      expect(p).toMatchObject({ kind: "practice", hold: true, attempts: 1 });
      expect(isPlainPractice(p)).toBe(false);
      expect(p.tasks).toEqual([...FRONTIER_TASK_IDS]);
      for (const s of p.seeds) expect(FRONTIER_FREEZE.devSeeds).toContain(s);
      for (const m of p.models) {
        expect((CLAUDE_POOL as readonly string[]).includes(m), m).toBe(true);
        expect(isClaudeByok(modelById(m)!)).toBe(true);
        expect(modelById(m)!.route.kind).not.toBe("workers-ai");
      }
    }
    // Opus covers every seed across its two halves; Sonnet and Haiku every seed.
    const seedsOf = (m: string) => plansR2.filter((p) => p.models.includes(m)).flatMap((p) => p.seeds).sort();
    for (const m of CLAUDE_POOL) expect(seedsOf(m)).toEqual([...FRONTIER_FREEZE.devSeeds]);
  });

  it("the frontier pool reaches the minimum n per trap even if the second Opus half is never queued", () => {
    const withoutB = plansR2.filter((p) => p.slug !== "frontier-cal-r2-opus-b");
    const perJob = withoutB.filter((p) => p.models.some((m) => (FRONTIER_POOL as readonly string[]).includes(m))).reduce((t, p) => t + p.seeds.length * p.attempts, 0);
    expect(perJob).toBeGreaterThanOrEqual(MIN_N);
  });

  it("queues 120 held bouts", async () => {
    const db = getDb(env);
    let total = 0;
    for (const raw of plansR2) {
      const id = await planEvent(env, planSchema.parse({ ...raw, slug: `${raw.slug}-check` }));
      const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      total += runs.length;
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      await db.delete(t.arenaEvents).where(eq(t.arenaEvents.id, id));
    }
    expect(total).toBe(3 * 10 * 3);
  });
});

// ADR 0139 Amendment 3: round 3's plan, written before any round-3 run: the same shape as round 2 (held practice, Claude
// on our own key, the ten calibration seeds, all three jobs, Opus split so its second half waits for the spend check).
describe("frontier calibration plan, round 3", () => {
  it("planSchema accepts every part: held practice, calibration seeds only, the three frontier jobs, Claude on our own key", () => {
    expect(plansR3.map((p) => p.slug)).toEqual(["frontier-cal-r3-haiku", "frontier-cal-r3-sonnet", "frontier-cal-r3-opus-a", "frontier-cal-r3-opus-b"]);
    for (const raw of plansR3) {
      const p = planSchema.parse(raw);
      expect(p).toMatchObject({ kind: "practice", hold: true, attempts: 1 });
      expect(isPlainPractice(p)).toBe(false);
      expect(p.tasks).toEqual([...FRONTIER_TASK_IDS]);
      for (const s of p.seeds) expect(FRONTIER_FREEZE.devSeeds).toContain(s);
      for (const m of p.models) {
        expect((CLAUDE_POOL as readonly string[]).includes(m), m).toBe(true);
        expect(isClaudeByok(modelById(m)!)).toBe(true);
        expect(modelById(m)!.route.kind).not.toBe("workers-ai");
      }
    }
    const seedsOf = (m: string) => plansR3.filter((p) => p.models.includes(m)).flatMap((p) => p.seeds).sort();
    for (const m of CLAUDE_POOL) expect(seedsOf(m)).toEqual([...FRONTIER_FREEZE.devSeeds]);
  });

  it("the frontier pool reaches the minimum n per trap even if the second Opus half is never queued", () => {
    const withoutB = plansR3.filter((p) => p.slug !== "frontier-cal-r3-opus-b");
    const perJob = withoutB.filter((p) => p.models.some((m) => (FRONTIER_POOL as readonly string[]).includes(m))).reduce((t, p) => t + p.seeds.length * p.attempts, 0);
    expect(perJob).toBeGreaterThanOrEqual(MIN_N);
  });

  it("queues 90 held bouts, and the read-out knows every round-3 event's planned count", async () => {
    const db = getDb(env);
    let total = 0;
    for (const raw of plansR3) {
      expect(CAL_PLANS[raw.slug]).toMatchObject({ seeds: raw.seeds, models: raw.models });
      const id = await planEvent(env, planSchema.parse({ ...raw, slug: `${raw.slug}-check` }));
      const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      total += runs.length;
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      await db.delete(t.arenaEvents).where(eq(t.arenaEvents.id, id));
    }
    expect(total).toBe(3 * 10 * 3);
  });
});

describe("frontier calibration plans from round 2 on name no Workers AI model (Dinike, 6 Nov; ADR 0139 Amendment table)", () => {
  // Every plan file in docs/data, so a later round's file is checked the moment it lands. Round 1 (history: GLM 5.3
  // Flash and Gemma 4 26B were queued on 5 Nov, before the decision) is the only exception.
  const files = import.meta.glob<{ default: { models: string[] }[] }>("../../../docs/data/frontier-calibration-r*.json", { eager: true });
  it("finds the plan files, and every model in rounds 2+ is a lineup model whose route isn't Workers AI", () => {
    const names = Object.keys(files).map((f) => f.split("/").pop()!);
    expect(names).toContain("frontier-calibration-r1.json");
    expect(names).toContain("frontier-calibration-r2.json");
    for (const [file, mod] of Object.entries(files)) {
      if (file.endsWith("-r1.json")) continue;
      for (const p of mod.default)
        for (const m of p.models) {
          expect(modelById(m), `${file}: ${m}`).not.toBeNull();
          expect(modelById(m)!.route.kind, `${file}: ${m}`).not.toBe("workers-ai");
        }
    }
    // Round 1 did name them, which is why the decision is needed and why only round 1 is exempt.
    expect(plans.flatMap((p) => p.models).filter((m) => modelById(m)?.route.kind === "workers-ai").sort()).toEqual(["gemma-4-26b", "glm-5.3-flash"]);
  });
});

// ADR 0144: Frontier 1.1's one calibration round, written before any run (not queued here): held practice, Claude on our
// own key, the first six calibration seeds, the three 1.1 jobs, Opus split so its second half waits for the spend check.
describe("frontier 1.1 calibration plan", () => {
  it("planSchema accepts every part: held practice, calibration seeds only, the three 1.1 jobs, Claude on our own key", () => {
    expect(plansV11.map((p) => p.slug)).toEqual(["frontier-cal-v1-1-haiku", "frontier-cal-v1-1-sonnet", "frontier-cal-v1-1-opus-a", "frontier-cal-v1-1-opus-b"]);
    for (const raw of plansV11) {
      const p = planSchema.parse(raw);
      expect(p).toMatchObject({ kind: "practice", hold: true, attempts: 1 });
      expect(isPlainPractice(p)).toBe(false);
      expect(p.tasks).toEqual([...FRONTIER_1_1_TASK_IDS]);
      for (const s of p.seeds) expect(FRONTIER_1_1_FREEZE.calibrationSeeds).toContain(s);
      for (const m of p.models) {
        expect((CLAUDE_POOL as readonly string[]).includes(m), m).toBe(true);
        expect(isClaudeByok(modelById(m)!)).toBe(true);
      }
    }
    // Practice-only while calibrating: a ranked event can't list a 1.1 job.
    for (const id of FRONTIER_1_1_TASK_IDS) expect(isPracticeOnly(id)).toBe(true);
    expect(planSchema.safeParse({ ...plansV11[0], slug: "v11-ranked", kind: "card", seeds: [1_500_000_001] }).success).toBe(false);
    const seedsOf = (m: string) => plansV11.filter((p) => p.models.includes(m)).flatMap((p) => p.seeds).sort();
    for (const m of CLAUDE_POOL) expect(seedsOf(m)).toEqual([...FRONTIER_1_1_FREEZE.calibrationSeeds]);
    // The admin read-out knows the plans.
    for (const p of plansV11) expect(CAL_PLANS[p.slug]).toBeDefined();
  });

  it("the read-out's 1.1 round reports every 1.1 trap (FA-POL-018 carried) under the ship-or-drop rule, never a band decision", () => {
    const table = trapTable([], V11_ROUND);
    expect(table.map((x) => x.trap).sort()).toEqual(["FA-POL-018", ...FRONTIER_1_1_CATALOG.map((e) => e.id)].sort());
    for (const x of table) expect(x.decision).toBe("not_measured");
    const done = (model: string, trap: string, fell: boolean) => ({ id: `${model}-${trap}-${fell}`, eventId: "e", modelId: model, task: "procurement-frontier-1-1", seed: 900_001, attemptNo: 1, status: "done", heldOut: false, result: { reason: "finished", traps: [{ id: trap, triggered: fell }] } });
    const rows = [done("claude-opus-5.5", "over_budget", false), done("claude-sonnet-5.5", "over_budget", true)];
    const row = trapTable(rows as never, V11_ROUND).find((x) => x.trap === "FA-POL-022")!;
    expect(row.frontier_pool).toMatchObject({ fell: 1, n: 2 });
    expect(row.decision).toBe("ship_or_drop");
  });

  it("queues 54 held bouts", async () => {
    const db = getDb(env);
    let total = 0;
    for (const raw of plansV11) {
      const id = await planEvent(env, planSchema.parse({ ...raw, slug: `${raw.slug}-check` }));
      const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      total += runs.length;
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      await db.delete(t.arenaEvents).where(eq(t.arenaEvents.id, id));
    }
    expect(total).toBe(3 * 6 * 3);
  });
});

// ADR 0145: Frontier 1.2's one calibration round, written before any run (not queued here), sized to about $10 of
// Anthropic credit: Haiku on six seeds, Sonnet and Opus on three, and Opus's procurement top-up behind the spend check.
describe("frontier 1.2 calibration plan", () => {
  it("planSchema accepts every part: held practice, calibration seeds only, 1.2 jobs only, Claude on our own key", () => {
    expect(plansV12.map((p) => p.slug)).toEqual(["frontier-cal-v1-2-haiku", "frontier-cal-v1-2-sonnet", "frontier-cal-v1-2-opus-a", "frontier-cal-v1-2-opus-b"]);
    for (const raw of plansV12) {
      const p = planSchema.parse(raw);
      expect(p).toMatchObject({ kind: "practice", hold: true, attempts: 1 });
      expect(isPlainPractice(p)).toBe(false);
      for (const t of p.tasks) expect(FRONTIER_1_2_TASK_IDS).toContain(t);
      for (const s of p.seeds) expect(FRONTIER_1_2_FREEZE.calibrationSeeds).toContain(s);
      for (const m of p.models) {
        expect((CLAUDE_POOL as readonly string[]).includes(m), m).toBe(true);
        expect(isClaudeByok(modelById(m)!)).toBe(true);
      }
      expect(CAL_PLANS[p.slug]).toBeDefined();
    }
    for (const id of FRONTIER_1_2_TASK_IDS) expect(isPracticeOnly(id)).toBe(true);
    expect(planSchema.safeParse({ ...plansV12[0], slug: "v12-ranked", kind: "card", seeds: [1_500_000_001] }).success).toBe(false);
    // Bouts per model and job: Haiku 6 everywhere; Sonnet 3; Opus 3, and 6 on procurement with the top-up.
    const n = (m: string, task: string) => plansV12.filter((p) => p.models.includes(m) && p.tasks.includes(task)).reduce((t, p) => t + p.seeds.length, 0);
    for (const task of FRONTIER_1_2_TASK_IDS) {
      expect(n("claude-haiku-5.5", task)).toBe(6);
      expect(n("claude-sonnet-5.5", task)).toBe(3);
      expect(n("claude-opus-5.5", task)).toBe(task === "procurement-frontier-1-2" ? 6 : 3);
    }
  });

  it("the read-out's 1.2 round reports FA-POL-018 (carried) and the three new traps under the ship-or-drop rule", () => {
    const table = trapTable([], V12_ROUND);
    expect(table.map((x) => x.trap).sort()).toEqual(["FA-POL-018", ...FRONTIER_1_2_CATALOG.map((e) => e.id)].sort());
    for (const x of table) expect(x.decision).toBe("not_measured");
    const done = (model: string, fell: boolean) => ({ id: `${model}-${fell}`, eventId: "e", modelId: model, task: "procurement-frontier-1-2", seed: 900_001, attemptNo: 1, status: "done", heldOut: false, result: { reason: "finished", traps: [{ id: "quotes_same_vendor", triggered: fell }] } });
    const row = trapTable([done("claude-opus-5.5", false), done("claude-sonnet-5.5", true)] as never, V12_ROUND).find((x) => x.trap === "FA-POL-027")!;
    expect(row.frontier_pool).toMatchObject({ fell: 1, n: 2 });
    expect(row.decision).toBe("ship_or_drop");
    // A 1.1 row is not a 1.2 row.
    expect(trapTable([{ ...done("claude-opus-5.5", true), task: "procurement-frontier-1-1" }] as never, V12_ROUND).every((x) => x.decision === "not_measured")).toBe(true);
  });

  it("queues 39 held bouts in all (36 before the top-up)", async () => {
    const db = getDb(env);
    let total = 0;
    for (const raw of plansV12) {
      const id = await planEvent(env, planSchema.parse({ ...raw, slug: `${raw.slug}-check` }));
      const runs = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      total += runs.length;
      await db.delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, id));
      await db.delete(t.arenaEvents).where(eq(t.arenaEvents.id, id));
    }
    expect(total).toBe(18 + 9 + 9 + 3);
  });
});
