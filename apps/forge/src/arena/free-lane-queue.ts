import { SEASON, TASKS } from "@forge/arena";
import { and, eq, inArray, like } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isLean } from "../services/ops-mode";
import { freeVariantModels, LaneMeter, waiLaneModels } from "./free-lane";
import { FREE_LANE_PREFIX } from "./free-lane-slug";
import { planEvent, planSchema, seasonSeeds } from "./runner";

// B3-13 (ADR 0109): queues the free lane's practice bouts. Each sub-lane (OpenRouter free variants, Workers AI) gets a
// new event only when none of its runs is still queued, so the queue never grows faster than the caps let it play.
// Gauntlet-style: every model plays the six public Gauntlet jobs (TASKS) on fresh random public seeds, never a
// held-out seed (seasonSeeds skips them) and never a private job family. Practice: published, labelled, never ranked.
// Production only: staging shares the Cloudflare account's neurons and the OpenRouter key's free requests, but not
// production's KV counters.

/** Seeds per job per model in one event: about 72 OpenRouter bouts (about 430 requests) and 48 Workers AI bouts. */
export const OR_SEEDS_PER_EVENT = 6;
export const WAI_SEEDS_PER_EVENT = 2;

export const freeLaneSlug = (lane: "or" | "wai", now: number) => `${FREE_LANE_PREFIX}${lane}-${new Date(now).toISOString().slice(0, 10)}`;

async function hasQueued(env: Env, lane: "or" | "wai", models: string[]) {
  const [row] = await getDb(env)
    .select({ id: t.arenaRuns.id })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(inArray(t.arenaRuns.status, ["queued", "running"]), inArray(t.arenaRuns.modelId, models), like(t.arenaEvents.slug, `${FREE_LANE_PREFIX}${lane}-%`)))
    .limit(1);
  return !!row;
}

export async function queueFreeLane(env: Env & { OPENROUTER_API_KEY?: string }, now = Date.now()) {
  const out: { or: string | null; wai: string | null; skipped: string[] } = { or: null, wai: null, skipped: [] };
  if (env.ENVIRONMENT !== "production") return { ...out, skipped: ["not production"] };
  if (await isLean(env)) return { ...out, skipped: ["lean"] };
  const meter = await LaneMeter.load(env, { now: () => now });
  const tasks = TASKS.map((x) => x.id);
  const plan = async (lane: "or" | "wai", models: string[], seeds: number) => {
    const slug = freeLaneSlug(lane, now);
    const day = slug.slice(-10);
    const p = planSchema.parse({
      slug,
      name: lane === "or" ? `Free-model practice, ${day}: OpenRouter free variants` : `Free-model practice, ${day}: Workers AI`,
      season: SEASON.id,
      kind: "practice",
      models,
      tasks,
      seeds: seasonSeeds(seeds),
      attempts: 1,
    });
    await planEvent(env, p);
    return slug;
  };
  const or = freeVariantModels().map((m) => m.id);
  if (!env.OPENROUTER_API_KEY) out.skipped.push("or: no key");
  else if (!or.length) out.skipped.push("or: no models");
  else if (!meter.orOpen()) out.skipped.push("or: paused or used up today");
  else if (await hasQueued(env, "or", or)) out.skipped.push("or: runs still queued");
  else out.or = await plan("or", or, OR_SEEDS_PER_EVENT);
  const wai = waiLaneModels().map((m) => m.id);
  if (!wai.length) out.skipped.push("wai: no models");
  else if (!meter.waiOpen()) out.skipped.push("wai: neurons used today");
  else if (await hasQueued(env, "wai", wai)) out.skipped.push("wai: runs still queued");
  else out.wai = await plan("wai", wai, WAI_SEEDS_PER_EVENT);
  return out;
}
