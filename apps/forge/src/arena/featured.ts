import { REPLAY_V2_FROM } from "../services/replay-keys";
import { contrastingPairs, contrastTrap, duelScript, heroOrder, pickFeatured, publicTrapId, reach, trapContrast, utcDay, type Duel, type DuelCandidate, type DuelPick } from "@forge/arena";
import type { Db } from "../services/db";
import { inArray } from "drizzle-orm";
import { verifiedReplay } from "./fail-card";
import { AUDIT_ERROR_TRAPS, AUDIT_WRONG_RUNS } from "./hero-proof";
import * as t from "../db/schema";
import { finishedRuns, modelName, runWithLog } from "./views";

// The home page's featured bout (ADR 0016 §5). Picked once a day by the published rule in @forge/arena, from runs
// that are public (embargoed "Call it" runs never appear), and cached for the day so every visitor sees the same one.

/** Bouts from this time carry replay format v2, which anyone can check against our published key. */
export const PUBLICLY_CHECKABLE_FROM = Date.parse(`${REPLAY_V2_FROM}T00:00:00Z`);

async function candidates(db: Db, now: number, tier?: "hard") {
  const runs = await finishedRuns(db, tier ? { tier, kinds: ["card"], limit: 3000, now } : { limit: 3000, now });
  // 13 Nov walkthrough: feature only bouts anyone can check (replay format v2, signed from REPLAY_V2_FROM, as /about says).
  return runs.filter(({ summary: s }) => s.finishedAt >= PUBLICLY_CHECKABLE_FROM).map(
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
  const key = `arena:channel:v8:${utcDay(now)}`;
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


/** Which replay format a home replay's two runs carry: v2 (sealed, checkable by anyone) or v1 (signed by us only). */
export type ReplayFormat = "v2" | "v1";
export interface HeroFall {
  duel: Duel;
  format: ReplayFormat;
}
// AUDIT_ERROR_TRAPS lives in hero-proof.ts (the home headlines apply it too); re-exported here for its older callers.
export { AUDIT_ERROR_TRAPS };
/** Day 0 of the rotation (16 Nov 2026): the first pick in the preferred order is that day's. */
export const HERO_FALL_ANCHOR_DAY = utcDay(Date.UTC(2026, 10, 16));

export interface FallPair {
  pick: DuelPick;
  format: ReplayFormat;
  /** The trap shown (the contrast trap), its public id, and the corner that fell. */
  trap: string;
  publicId: string;
  fellModel: string;
}

/**
 * Every ranked pair that can back the home replay, in the order the rotation walks them. Ranked bouts only (card and
 * guest, both tiers; finishedRuns already leaves out held-out runs, embargoed models, held events and Lab arms), paired
 * on the same event, job, seed and attempt where one side's planted trap went off and the other's didn't, both runs in
 * the same replay format, the shown trap public and not one the audits found the referee wrong on, and no run audit 1
 * found scored wrong. Order: v2 before v1; Hard jobs first; the deleted-real-record trap first (Crucible 2: Hard's
 * spreadsheet-hard3, the coordinator's 16 Nov pick); then the corners that fell interleaved, so no one model is shown
 * day after day.
 */
export async function heroFallPairs(db: Db, now = Date.now()): Promise<FallPair[]> {
  const runs = await finishedRuns(db, { kinds: ["card", "guest"], hard: true, limit: 5000, now });
  const results = new Map(runs.map((r) => [r.summary.id, r.result]));
  const all: DuelCandidate[] = runs.map(({ summary: s, result }) => ({ id: s.id, event: s.event, kind: s.kind, model: s.model, task: s.task, seed: s.seed, attempt: s.attempt, finishedAt: s.finishedAt, passed: s.passed, traps: (result?.traps ?? []).map((x) => ({ id: x.id, triggered: x.triggered })) }));
  const format = (c: DuelCandidate): ReplayFormat => (c.finishedAt >= PUBLICLY_CHECKABLE_FROM ? "v2" : "v1");
  const out: FallPair[] = [];
  for (const p of contrastingPairs(all).filter(trapContrast)) {
    if (format(p.a) !== format(p.b) || AUDIT_WRONG_RUNS.has(p.a.id) || AUDIT_WRONG_RUNS.has(p.b.id)) continue;
    const ra = results.get(p.a.id), rb = results.get(p.b.id);
    if (!ra || !rb) continue;
    const trap = contrastTrap(p.a.task, ra, rb);
    const publicId = trap ? publicTrapId(p.a.task, trap) : null;
    if (!trap || !publicId || AUDIT_ERROR_TRAPS.has(publicId)) continue;
    const fellA = ra.traps.some((x) => x.id === trap && x.triggered), fellB = rb.traps.some((x) => x.id === trap && x.triggered);
    if (fellA === fellB) continue;
    out.push({ pick: p, format: format(p.a), trap, publicId, fellModel: fellA ? p.a.model : p.b.model });
  }
  const rank = (f: FallPair) => [f.format === "v2" ? 0 : 1, /-hard\d*$/.test(f.pick.a.task) ? 0 : 1, f.trap === "deleted_real_row" ? 0 : 1, -(reach(f.pick.a.model) + reach(f.pick.b.model))];
  const cmp = (x: FallPair, y: FallPair) => {
    const a = rank(x), b = rank(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return x.pick.a.id.localeCompare(y.pick.a.id);
  };
  // Within each (format, Hard, trap) group, deal the pairs round-robin by the model that fell.
  const groups = new Map<string, FallPair[]>();
  for (const f of out.sort(cmp)) {
    const k = rank(f).slice(0, 3).join("|");
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups.values()].flatMap((g) => {
    const byModel = new Map<string, FallPair[]>();
    for (const f of g) byModel.set(f.fellModel, [...(byModel.get(f.fellModel) ?? []), f]);
    const queues = [...byModel.values()];
    const dealt: FallPair[] = [];
    for (let i = 0; dealt.length < g.length; i++) for (const q of queues) if (q[i]) dealt.push(q[i]!);
    return dealt;
  });
}

/**
 * One pair as the home replay may show it, or null: v2 pairs need both seals; v1 pairs need both stored signatures to
 * verify (the page then labels them "signed by us, not independently verifiable"). The scripted duel must be ranked and
 * show exactly one side falling, on the pair's own trap. Used by arena/hero-variants.ts.
 */
export async function checkedDuel(env: Pick<Env, "REPORT_SIGNING_KEY">, db: Db, f: FallPair, now = Date.now()): Promise<HeroFall | null> {
  const ids = [f.pick.a.id, f.pick.b.id];
  const rows = await db.select({ id: t.arenaRuns.id, seal: t.arenaRuns.replaySeal, log: t.arenaRuns.log, signature: t.arenaRuns.signature }).from(t.arenaRuns).where(inArray(t.arenaRuns.id, ids));
  if (rows.length !== 2) return null;
  const ok = f.format === "v2" ? rows.every((r) => r.seal) : (await Promise.all(rows.map((r) => verifiedReplay(env, r.id, r.log, r.signature)))).every(Boolean);
  if (!ok) return null;
  const d = await scriptFor(db, f.pick, [f.pick.a, f.pick.b], now);
  const lanes = d?.gauntlet?.lanes;
  if (!d || d.practice || !lanes || lanes.filter((l) => l.fell).length !== 1) return null;
  if (lanes.find((l) => l.fell)!.model !== f.fellModel) return null;
  return { duel: d, format: f.format };
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
