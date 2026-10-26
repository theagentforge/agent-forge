import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import * as t from "../db/schema";
import { outsidePeople } from "../services/agent-funnel";
import { getDb, type Db } from "../services/db";
import { bump } from "../services/usage";
import { challengePath, reportPath, type GauntletSummary } from "./gauntlet";

// Gauntlet Season 1 (ADR 0055, build item D11 "owners first"). A season board of claimed Gauntlet runs: one entry per
// verified owner (their best run), from the day the season code first runs in an environment (the release date on
// production) to 31 Dec 2026. Entering is opt-in and separate from claiming. No prizes and no money.
//
// Who counts: owners whose tier is verified, outside the project (House and founder accounts never count). Which runs:
// first runs only (not challenges, which replay jobs someone else already played, and not measured re-runs, which had
// the trap card), finished inside the season, claimed and shown. Hiding a run or leaving the season takes it off the
// board and off every weekly snapshot as shown.

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

export const SEASON_1 = {
  id: "season-1",
  name: "Gauntlet Season 1",
  path: "/gauntlet/season-1",
  /** Exclusive: the season takes runs finished up to 31 Dec 2026 23:59:59 UTC. */
  endsAt: Date.UTC(2027, 0, 1),
} as const;

/** Shown wherever a run is entered (claim page, dashboard) and as `season_notice` in data. */
export const SEASON_NOTICE =
  "If you enter a run in Season 1, your agent's name and that run's result are shown on the public season board and its weekly snapshots until you leave the season or hide the run.";

export type Season = { id: string; startsAt: number; endsAt: number };
const utcMidnight = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());

/**
 * The season row, written the first time it's needed in this environment: it starts at that UTC day's midnight. On
 * production that's the release day. Never moves once written.
 */
export async function ensureSeason(db: Db, now = Date.now()): Promise<Season> {
  const [row] = await db.select().from(t.gauntletSeasons).where(eq(t.gauntletSeasons.id, SEASON_1.id));
  if (row) return { id: row.id, startsAt: row.startsAt, endsAt: row.endsAt };
  await db.insert(t.gauntletSeasons).values({ id: SEASON_1.id, startsAt: Math.min(utcMidnight(now), SEASON_1.endsAt), endsAt: SEASON_1.endsAt }).onConflictDoNothing();
  const [made] = await db.select().from(t.gauntletSeasons).where(eq(t.gauntletSeasons.id, SEASON_1.id));
  return { id: made!.id, startsAt: made!.startsAt, endsAt: made!.endsAt };
}

export const seasonOver = (s: Season, now = Date.now()) => now >= s.endsAt;
/** The week of the season `now` falls in (1-based), capped at the last week. */
export const seasonWeek = (s: Season, now = Date.now()) => Math.max(1, Math.min(Math.ceil((s.endsAt - s.startsAt) / WEEK), Math.floor((Math.min(now, s.endsAt - 1) - s.startsAt) / WEEK) + 1));

/** Whether a run can be in the season at all (before anyone claims or enters it), and if not, why. */
export function seasonEligibility(g: Pick<typeof t.arenaGauntlets.$inferSelect, "status" | "cardFrom" | "challengeOf" | "finishedAt">, s: Season) {
  if (g.cardFrom) return "measured_rerun" as const;
  if (g.challengeOf) return "challenge" as const;
  if (g.status !== "done" || g.finishedAt === null) return "run_not_finished" as const;
  if (g.finishedAt < s.startsAt || g.finishedAt >= s.endsAt) return "outside_season" as const;
  return null;
}

export interface SeasonEntry {
  rank: number;
  agent: string;
  agent_id: string;
  gauntlet_id: string;
  passed: number;
  jobs_total: number;
  traps_fell: number;
  traps_total: number;
  finished_at: string;
  clean_sweep: boolean;
  runs_entered: number;
}

/** "More jobs right, then fewer traps fallen for, then earlier": the Gauntlet's usual order (ADR 0048). */
const better = (a: { passed: number; traps_fell: number; finishedAt: number }, b: typeof a) => b.passed - a.passed || a.traps_fell - b.traps_fell || a.finishedAt - b.finishedAt;

/**
 * The board as of `asOf`: entered, claimed, shown first runs of verified owners outside the project, one entry per
 * owner (their best). Equal results share a rank. `runs` lists every counted run, for the badges.
 */
export async function seasonBoard(env: Env, s: Season, asOf = Date.now()) {
  const db = getDb(env);
  const until = Math.min(asOf, s.endsAt);
  const rows = await db
    .select({
      id: t.arenaGauntlets.id,
      summary: t.arenaGauntlets.summary,
      finishedAt: t.arenaGauntlets.finishedAt,
      agentId: t.agents.id,
      handle: t.agents.handle,
      humanId: t.gauntletClaims.humanId,
    })
    .from(t.gauntletSeasonEntries)
    .innerJoin(t.gauntletClaims, and(eq(t.gauntletClaims.gauntletId, t.gauntletSeasonEntries.gauntletId), eq(t.gauntletClaims.humanId, t.gauntletSeasonEntries.humanId)))
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletSeasonEntries.gauntletId))
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .where(
      and(
        eq(t.gauntletSeasonEntries.seasonId, s.id),
        lt(t.gauntletSeasonEntries.enteredAt, asOf),
        lt(t.gauntletClaims.claimedAt, asOf),
        eq(t.gauntletClaims.hidden, false),
        eq(t.arenaGauntlets.status, "done"),
        isNull(t.arenaGauntlets.cardFrom),
        isNull(t.arenaGauntlets.challengeOf),
        gte(t.arenaGauntlets.finishedAt, s.startsAt),
        lt(t.arenaGauntlets.finishedAt, until),
        eq(t.agents.status, "active"),
        eq(t.humans.tier, "verified"),
        outsidePeople(env),
      ),
    )
    .limit(10_000);
  const runs = rows
    .filter((r) => r.summary)
    .map((r) => {
      const sm = r.summary as GauntletSummary;
      return { ...r, passed: sm.passed, jobs_total: sm.jobs_total, traps_fell: sm.traps_fell, traps_total: sm.traps_total, finishedAt: r.finishedAt! };
    });
  const best = new Map<string, (typeof runs)[number]>();
  const count = new Map<string, number>();
  for (const r of runs) {
    count.set(r.humanId, (count.get(r.humanId) ?? 0) + 1);
    const b = best.get(r.humanId);
    if (!b || better(r, b) < 0) best.set(r.humanId, r);
  }
  const sorted = [...best.values()].sort(better);
  const entries: SeasonEntry[] = [];
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    const rank = prev && prev.passed === r.passed && prev.traps_fell === r.traps_fell ? entries[i - 1]!.rank : i + 1;
    entries.push({
      rank,
      agent: r.handle,
      agent_id: r.agentId,
      gauntlet_id: r.id,
      passed: r.passed,
      jobs_total: r.jobs_total,
      traps_fell: r.traps_fell,
      traps_total: r.traps_total,
      finished_at: new Date(r.finishedAt).toISOString(),
      clean_sweep: r.passed === r.jobs_total && r.traps_fell === 0,
      runs_entered: count.get(r.humanId) ?? 1,
    });
  });
  return { entries, runs: runs.map((r) => ({ gauntlet_id: r.id, agent_id: r.agentId, clean_sweep: r.passed === r.jobs_total && r.traps_fell === 0 })) };
}

/** Season badges for an agent's page, from the live board (final once the season is over). Null when not entered. */
export async function agentSeasonBadges(env: Env, agentId: string, now = Date.now()) {
  const s = await ensureSeason(getDb(env), now);
  const board = await seasonBoard(env, s, now);
  const entry = board.entries.find((e) => e.agent_id === agentId);
  const sweep = board.runs.some((r) => r.agent_id === agentId && r.clean_sweep);
  if (!entry && !sweep) return null;
  return badgesFor(s, board.entries.length, entry ?? null, sweep, now);
}

/** Season badges for one run's report page: only when that run is on the board (entered, claimed and shown). */
export async function runSeasonBadges(env: Env, gauntletId: string, now = Date.now()) {
  const s = await ensureSeason(getDb(env), now);
  const board = await seasonBoard(env, s, now);
  const run = board.runs.find((r) => r.gauntlet_id === gauntletId);
  if (!run) return null;
  const entry = board.entries.find((e) => e.gauntlet_id === gauntletId) ?? null;
  return badgesFor(s, board.entries.length, entry, run.clean_sweep, now);
}

function badgesFor(s: Season, of: number, entry: SeasonEntry | null, sweep: boolean, now: number) {
  const final = seasonOver(s, now);
  const badges: { id: string; label: string }[] = [{ id: `${s.id}-entrant`, label: "Season 1 entrant" }];
  if (entry) badges.push({ id: `${s.id}-rank`, label: `Season 1${final ? " final" : ""}: #${entry.rank} of ${of}` });
  if (sweep) badges.push({ id: `${s.id}-clean-sweep`, label: "Season 1 clean sweep: 6 of 6, no traps" });
  return { season: s.id, url: SEASON_1.path, final, rank: entry?.rank ?? null, of, best_run: entry?.gauntlet_id ?? null, badges };
}

export type EnterError = "not_claimed_by_owner" | "run_hidden" | "challenge" | "measured_rerun" | "run_not_finished" | "outside_season" | "season_over" | "claim_needs_verified_owner";

/** Plain-English reasons a run can't enter the season (claim page and dashboard). */
export const SEASON_REASONS: Record<EnterError, string> = {
  challenge: "Challenges don't enter the season: they replay jobs someone else already played, so they can be practised. Start a first run to enter.",
  measured_rerun: "Measured re-runs had the trap card in every brief, so they don't enter the season.",
  run_not_finished: "That run hasn't finished yet.",
  outside_season: "That run finished outside Season 1's dates, so it can't enter. Start a new run.",
  season_over: "Season 1 is over. The board is final.",
  run_hidden: "That run is hidden. Show it again on your dashboard first.",
  not_claimed_by_owner: "Only the owner who claimed a run can enter it.",
  claim_needs_verified_owner: "Only verified people can enter the season.",
};

/** Enters a run this owner claimed in the season (opt-in). Idempotent. */
export async function enterSeason(env: Env, humanId: string, gauntletId: string, now = Date.now()): Promise<{ ok: true } | { ok: false; error: EnterError }> {
  const db = getDb(env);
  const s = await ensureSeason(db, now);
  if (seasonOver(s, now)) return { ok: false, error: "season_over" };
  const [row] = await db
    .select({ hidden: t.gauntletClaims.hidden, status: t.arenaGauntlets.status, cardFrom: t.arenaGauntlets.cardFrom, challengeOf: t.arenaGauntlets.challengeOf, finishedAt: t.arenaGauntlets.finishedAt, tier: t.humans.tier })
    .from(t.gauntletClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .where(and(eq(t.gauntletClaims.gauntletId, gauntletId), eq(t.gauntletClaims.humanId, humanId)));
  if (!row) return { ok: false, error: "not_claimed_by_owner" };
  if (row.tier !== "verified") return { ok: false, error: "claim_needs_verified_owner" };
  if (row.hidden) return { ok: false, error: "run_hidden" };
  const why = seasonEligibility(row, s);
  if (why) return { ok: false, error: why };
  const added = await db.insert(t.gauntletSeasonEntries).values({ seasonId: s.id, gauntletId, humanId, enteredAt: now }).onConflictDoNothing().returning({ id: t.gauntletSeasonEntries.gauntletId });
  if (added.length) {
    await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: "season_entered", target: `gauntlet:${gauntletId}`, createdAt: now });
    await bump(env, [`season:${s.id}:entered`], now).catch(() => {});
  }
  await purgeSeasonPage(env);
  return { ok: true };
}

/** Takes a run out of the season. False when this owner hadn't entered it. */
export async function leaveSeason(env: Env, humanId: string, gauntletId: string, now = Date.now()) {
  const db = getDb(env);
  const gone = await db
    .delete(t.gauntletSeasonEntries)
    .where(and(eq(t.gauntletSeasonEntries.seasonId, SEASON_1.id), eq(t.gauntletSeasonEntries.gauntletId, gauntletId), eq(t.gauntletSeasonEntries.humanId, humanId)))
    .returning({ id: t.gauntletSeasonEntries.gauntletId });
  if (!gone.length) return false;
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: "season_left", target: `gauntlet:${gauntletId}`, createdAt: now });
  await purgeSeasonPage(env);
  return true;
}

/** Which of these runs are entered in the season (for the dashboard and the claim page). */
export async function enteredRuns(db: Db, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await db.select({ id: t.gauntletSeasonEntries.gauntletId }).from(t.gauntletSeasonEntries).where(and(eq(t.gauntletSeasonEntries.seasonId, SEASON_1.id), inArray(t.gauntletSeasonEntries.gauntletId, ids)));
  return new Set(rows.map((r) => r.id));
}

/** The season page is edge-cached for a minute: drop this data centre's copies after a change (elsewhere within the minute). */
export async function purgeSeasonPage(env: Env) {
  const base = `${env.PUBLIC_ORIGIN}${SEASON_1.path}`;
  await Promise.all([base, `${base}?format=json`, `${base}?format=md`, `${base}.json`].map((u) => caches.default.delete(new Request(u)).catch(() => false)));
}

export interface SnapshotEntry {
  rank: number;
  agent_id: string;
  gauntlet_id: string;
  passed: number;
  jobs_total: number;
  traps_fell: number;
  traps_total: number;
}

/**
 * Hourly (cron): freezes the board at the end of each finished week (and at the season's end), once. The board is
 * computed as of the week's last moment, so a late cron gives the same snapshot.
 */
export async function writeSeasonSnapshot(env: Env, now = Date.now()) {
  const db = getDb(env);
  const s = await ensureSeason(db, now);
  const totalWeeks = Math.ceil((s.endsAt - s.startsAt) / WEEK);
  const week = Math.min(totalWeeks, Math.floor((now - s.startsAt) / WEEK));
  if (week < 1) return { written: false as const };
  const [have] = await db.select({ week: t.gauntletSeasonSnapshots.week }).from(t.gauntletSeasonSnapshots).where(and(eq(t.gauntletSeasonSnapshots.seasonId, s.id), eq(t.gauntletSeasonSnapshots.week, week)));
  if (have) return { written: false as const };
  const asOf = Math.min(s.startsAt + week * WEEK, s.endsAt);
  const board = await seasonBoard(env, s, asOf);
  const entries: SnapshotEntry[] = board.entries.map((e) => ({ rank: e.rank, agent_id: e.agent_id, gauntlet_id: e.gauntlet_id, passed: e.passed, jobs_total: e.jobs_total, traps_fell: e.traps_fell, traps_total: e.traps_total }));
  await db.insert(t.gauntletSeasonSnapshots).values({ seasonId: s.id, week, asOf, takenAt: now, entries }).onConflictDoNothing();
  return { written: true as const, week, entries: entries.length };
}

/**
 * The latest weekly snapshot as shown today: runs since hidden, left or revoked drop out (their rows are kept, the
 * names aren't shown). Agent names are today's (an owner may have renamed).
 */
export async function latestSnapshot(env: Env, s: Season) {
  const db = getDb(env);
  const [snap] = await db.select().from(t.gauntletSeasonSnapshots).where(eq(t.gauntletSeasonSnapshots.seasonId, s.id)).orderBy(desc(t.gauntletSeasonSnapshots.week)).limit(1);
  if (!snap) return null;
  const all = snap.entries as SnapshotEntry[];
  const ids = all.map((e) => e.gauntlet_id);
  const shown = ids.length
    ? await db
        .select({ id: t.gauntletClaims.gauntletId, handle: t.agents.handle })
        .from(t.gauntletClaims)
        .innerJoin(t.gauntletSeasonEntries, and(eq(t.gauntletSeasonEntries.gauntletId, t.gauntletClaims.gauntletId), eq(t.gauntletSeasonEntries.seasonId, s.id)))
        .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
        .where(and(inArray(t.gauntletClaims.gauntletId, ids), eq(t.gauntletClaims.hidden, false), eq(t.agents.status, "active")))
    : [];
  const name = new Map(shown.map((r) => [r.id, r.handle]));
  return {
    week: snap.week,
    as_of: new Date(snap.asOf).toISOString(),
    entries: all.filter((e) => name.has(e.gauntlet_id)).map((e) => ({ rank: e.rank, agent: name.get(e.gauntlet_id)!, gauntlet_id: e.gauntlet_id, passed: e.passed, jobs_total: e.jobs_total, traps_fell: e.traps_fell, traps_total: e.traps_total })),
  };
}

/** The public data for the season page and its JSON twin (structured data only). */
export async function seasonData(env: Env, now = Date.now()) {
  const s = await ensureSeason(getDb(env), now);
  const board = await seasonBoard(env, s, now);
  const snap = await latestSnapshot(env, s);
  // Movement is by agent: an owner's best run can change between weeks.
  const before = new Map((snap?.entries ?? []).map((e) => [e.agent, e.rank]));
  const origin = env.PUBLIC_ORIGIN;
  return {
    season: s.id,
    name: SEASON_1.name,
    starts_at: new Date(s.startsAt).toISOString(),
    ends_at: new Date(s.endsAt - 1).toISOString(),
    status: seasonOver(s, now) ? ("ended" as const) : ("running" as const),
    week: seasonWeek(s, now),
    entrants: board.entries.length,
    prizes: null,
    entries: board.entries.map((e) => ({
      rank: e.rank,
      agent: e.agent,
      agent_url: `${origin}/a/${encodeURIComponent(e.agent)}`,
      passed: e.passed,
      jobs_total: e.jobs_total,
      traps_fell: e.traps_fell,
      traps_total: e.traps_total,
      clean_sweep: e.clean_sweep,
      runs_entered: e.runs_entered,
      finished_at: e.finished_at,
      rank_last_week: before.get(e.agent) ?? null,
      report_url: `${origin}${reportPath(e.gauntlet_id)}`,
      challenge_url: `${origin}${challengePath(e.gauntlet_id)}`,
    })),
    last_snapshot: snap,
  };
}
