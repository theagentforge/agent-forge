import { contrastingPairs, duelScript, heroOrder, pickFeatured, reach, trapContrast, utcDay, type Duel, type DuelCandidate, type DuelPick } from "@forge/arena";
import type { Db } from "../services/db";
import { finishedRuns, modelName, runWithLog } from "./views";

// The home page's featured bout (ADR 0016 §5). Picked once a day by the published rule in @forge/arena, from runs
// that are public (embargoed "Call it" runs never appear), and cached for the day so every visitor sees the same one.

async function candidates(db: Db, now: number, tier?: "hard") {
  const runs = await finishedRuns(db, tier ? { tier, kinds: ["card"], limit: 3000, now } : { limit: 3000, now });
  return runs.map(
    ({ summary: s, result }): DuelCandidate => ({
      id: s.id,
      event: s.event,
      kind: s.kind,
      model: s.model,
      task: s.task,
      seed: s.seed,
      attempt: s.attempt,
      finishedAt: s.finishedAt,
      passed: s.passed,
      traps: result.traps.map((t) => ({ id: t.id, triggered: t.triggered })),
    }),
  );
}

async function scriptFor(db: Db, pick: DuelPick, all: DuelCandidate[], now: number): Promise<Duel | null> {
  const [ra, rb] = await Promise.all([runWithLog(db, pick.a.id, now), runWithLog(db, pick.b.id, now)]);
  if (!ra || !rb) return null;
  const rounds = Math.max(...all.filter((r) => r.event === pick.a.event && r.task === pick.a.task).map((r) => r.attempt));
  const side = (p: DuelCandidate, r: NonNullable<typeof ra>) => ({ id: p.id, model: p.model, name: modelName(p.model), result: r.result, log: r.log, attempt: p.attempt, finishedAt: p.finishedAt });
  return duelScript(side(pick.a, ra), side(pick.b, rb), { rounds, practice: pick.a.kind === "practice" });
}

/** Up to `n` ranked Hard-tier pairs with a trap contrast, best-known models first, a different job each, rotating daily. */
export function frontierPicks(hard: DuelCandidate[], day: number, n: number): DuelPick[] {
  const events = [...new Set(hard.map((r) => r.event))];
  const pairs = events.flatMap((e) => contrastingPairs(hard.filter((r) => r.event === e))).filter(trapContrast);
  if (!pairs.length) return [];
  const ranked = pairs
    .map((p, i) => ({ p, s: reach(p.a.model) + reach(p.b.model), r: (i + day * 7) % pairs.length }))
    .sort((x, y) => y.s - x.s || x.r - y.r);
  const out: DuelPick[] = [];
  for (const { p } of ranked) if (out.length < n && !out.some((q) => q.a.task === p.a.task)) out.push(p);
  return out;
}

/** Today's featured duel, or null when no event has a contrasting pair yet. Cached in KV for the day. */
export async function featuredDuel(env: Pick<Env, "KV">, db: Db, now = Date.now()): Promise<Duel | null> {
  const key = `arena:featured:v5:${utcDay(now)}`;
  const hit = await env.KV.get<{ duel: Duel | null }>(key, "json");
  if (hit) return hit.duel;
  const all = await candidates(db, now);
  const pick = pickFeatured(all, utcDay(now));
  const duel = pick ? await scriptFor(db, pick, all, now) : null;
  // "Nothing yet" is only remembered briefly, so the first bouts appear the same day they're fought.
  await env.KV.put(key, JSON.stringify({ duel }), { expirationTtl: duel ? 2 * 86_400 : 900 });
  return duel;
}

/** The cycling hero and /arena Now Playing (ADR 0019 §1): today's featured duel first, then the most useful. */
export async function channelDuels(env: Pick<Env, "KV">, db: Db, now = Date.now(), max = 8): Promise<Duel[]> {
  const key = `arena:channel:v7:${utcDay(now)}`;
  const hit = await env.KV.get<Duel[]>(key, "json");
  if (hit) return hit;
  const [all, hard] = await Promise.all([candidates(db, now), candidates(db, now, "hard").catch(() => [] as DuelCandidate[])]);
  const picks = heroOrder(all, utcDay(now), max);
  // Second and third: ranked Hard-tier bouts between each lab's everyday model, where one fell for a trap the other
  // caught: the models most people use, on the hardest version of the job (Dinike, 20 Oct).
  const frontier = frontierPicks(hard, utcDay(now), 2);
  const order = [...picks.slice(0, 1), ...frontier, ...picks.slice(1)].slice(0, max);
  const duels = (await Promise.all(order.map((p) => scriptFor(db, p, frontier.includes(p) ? hard : all, now)))).filter((d): d is Duel => !!d);
  await env.KV.put(key, JSON.stringify(duels), { expirationTtl: duels.length ? 2 * 86_400 : 900 });
  return duels;
}


/**
 * A duel from two named runs (the Gauntlet clip page, ADR 0029): they must be the same task, variant and attempt,
 * the way the featured-bout rule pairs them, and both public. Returns null otherwise.
 */
export async function duelFromRuns(db: Db, aId: string, bId: string, now = Date.now()): Promise<Duel | null> {
  if (aId === bId) return null;
  const [ra, rb] = await Promise.all([runWithLog(db, aId, now), runWithLog(db, bId, now)]);
  if (!ra || !rb) return null;
  if (ra.run.task !== rb.run.task || ra.run.seed !== rb.run.seed || ra.run.attemptNo !== rb.run.attemptNo || ra.run.eventId !== rb.run.eventId) return null;
  const side = (r: NonNullable<typeof ra>) => ({ id: r.run.id, model: r.run.modelId, name: modelName(r.run.modelId), result: r.result, log: r.log, attempt: r.run.attemptNo, finishedAt: r.run.finishedAt ?? now });
  return duelScript(side(ra), side(rb), { rounds: Math.max(ra.run.attemptNo, rb.run.attemptNo), practice: ra.event.kind === "practice" });
}

/** The Gauntlet clip id for a pair: "gx-" plus the first 8 characters of each run id. */
export const gauntletClipId = (aId: string, bId: string) => `gx-${aId.slice(0, 8)}-${bId.slice(0, 8)}`;
