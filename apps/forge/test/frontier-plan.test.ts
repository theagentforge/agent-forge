import { env } from "cloudflare:workers";
import { DEV_SPLIT, FRONTIER_FREEZE, FRONTIER_TASK_IDS, isPracticeOnly } from "@forge/arena";
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
import { CAL_PLANS, CLAUDE_POOL, FRONTIER_POOL, MIN_N } from "../src/arena/frontier-calibration";

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

  it("a ranked event can't include a frontier job while it calibrates", () => {
    for (const id of FRONTIER_TASK_IDS) expect(isPracticeOnly(id)).toBe(true);
    const card = { ...plans[1], slug: "frontier-ranked-too-early", kind: "card", seeds: [1_500_000_001] };
    expect(planSchema.safeParse(card).success).toBe(false);
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
