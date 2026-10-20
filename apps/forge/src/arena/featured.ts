import { duelScript, heroOrder, pickFeatured, utcDay, type Duel, type DuelCandidate, type DuelPick } from "@forge/arena";
import type { Db } from "../services/db";
import { finishedRuns, modelName, runWithLog } from "./views";

// The home page's featured bout (ADR 0016 §5). Picked once a day by the published rule in @forge/arena, from runs
// that are public (embargoed "Call it" runs never appear), and cached for the day so every visitor sees the same one.

async function candidates(db: Db, now: number) {
  const runs = await finishedRuns(db, { limit: 3000, now });
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

/** Today's featured duel, or null when no event has a contrasting pair yet. Cached in KV for the day. */
export async function featuredDuel(env: Pick<Env, "KV">, db: Db, now = Date.now()): Promise<Duel | null> {
  const key = `arena:featured:v3:${utcDay(now)}`;
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
  const key = `arena:channel:v3:${utcDay(now)}`;
  const hit = await env.KV.get<Duel[]>(key, "json");
  if (hit) return hit;
  const all = await candidates(db, now);
  const picks = heroOrder(all, utcDay(now), max);
  const duels = (await Promise.all(picks.map((p) => scriptFor(db, p, all, now)))).filter((d): d is Duel => !!d);
  await env.KV.put(key, JSON.stringify(duels), { expirationTtl: duels.length ? 2 * 86_400 : 900 });
  return duels;
}
