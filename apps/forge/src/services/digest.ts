import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { compareSides } from "../arena/head-to-head";
import type { GauntletSummary } from "../arena/gauntlet";
import { notEmbargoed } from "../arena/views";
import type { Db } from "./db";
import { countsAsHouse } from "./identity";
import { toolPageUrl } from "./tools";

// V5, the weekly digest without email (docs/strategy/agent-social-loops.md §3): what changed for an agent, or for an
// owner across their agents, in a time window. Read by forge_me (`since_last_week`, rolling 7 days) and by the owner's
// private Atom feed (one entry per ISO week). Counts, ids and public tool ids only; never another owner's name or note,
// never a Gauntlet challenger's id (a run's id is the only key to it, ADR 0024), and House and founder accounts never
// count (as in verdicts.ts).

const DAY = 86_400_000;
export const WEEK_MS = 7 * DAY;
/** Tools and fingerprints read per digest (D1 caps bound parameters at 100 a query). */
export const MAX_TOOLS = 50;
export const MAX_WATCH = 50;
export const MAX_GAUNTLETS = 20;
const FINGERPRINT = /^(sha256:)?[0-9a-f]{64}$/;
const GAUNTLET_ID = /^g[0-9a-f]{32}$/;

export type Scope = { kind: "agent"; agentId: string; humanId: string } | { kind: "owner"; humanId: string };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ladderKey = (ms: number) => `ladder:ranks:${day(ms)}`;

/** Current Ranked Ladder positions (the same order as /arena/proving-ground): agent id → rank. */
export async function ladderRanks(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ subject: t.arenaRatings.subject })
    .from(t.arenaRatings)
    .where(gte(t.arenaRatings.wins, 1))
    .orderBy(desc(sql`${t.arenaRatings.rating} - 2 * ${t.arenaRatings.rd}`))
    .limit(500);
  return Object.fromEntries(rows.map((r, i) => [r.subject.replace(/^agent:/, ""), i + 1]));
}

/** Hourly cron: keeps one snapshot of the ladder per UTC day (written once), so rank moves can be read later. */
export async function writeLadderSnapshot(env: Pick<Env, "KV">, db: Db, now = Date.now()) {
  if (await env.KV.get(ladderKey(now))) return { written: false };
  const ranks = await ladderRanks(db);
  await env.KV.put(ladderKey(now), JSON.stringify(ranks), { expirationTtl: 60 * 86_400 });
  return { written: true, ranked: Object.keys(ranks).length };
}

async function ranksOn(env: Pick<Env, "KV">, ms: number) {
  return (await env.KV.get<Record<string, number>>(ladderKey(ms), "json").catch(() => null)) ?? null;
}

/** One agent's ladder move between two moments: rank then and now (null when unranked or no snapshot), and its bouts. */
async function ladderMove(env: Pick<Env, "KV">, db: Db, agentId: string, since: number, until: number, live: Record<string, number> | null) {
  const before = await ranksOn(env, since);
  const after = live ?? (await ranksOn(env, until));
  const [b] = await db
    .select({ n: sql<number>`count(*)`, passed: sql<number>`sum(case when ${t.arenaPgAttempts.passed} = 1 then 1 else 0 end)` })
    .from(t.arenaPgAttempts)
    .where(and(eq(t.arenaPgAttempts.agentId, agentId), eq(t.arenaPgAttempts.status, "done"), gte(t.arenaPgAttempts.finishedAt, since), lt(t.arenaPgAttempts.finishedAt, until)));
  const rank = after?.[agentId] ?? null;
  const was = before ? (before[agentId] ?? null) : null;
  const bouts = Number(b?.n ?? 0);
  if (rank === null && was === null && bouts === 0) return null;
  return {
    rank,
    rank_before: was,
    /** Places moved up (positive) or down (negative); null when either side is unranked or no snapshot was kept. */
    moved: rank !== null && was !== null ? was - rank : null,
    snapshot_before: before ? day(since) : null,
    bouts,
    bouts_passed: Number(b?.passed ?? 0),
  };
}

/** Tools the scope has reported on (most recent first), as tool row ids. */
async function reportedTools(db: Db, scope: Scope) {
  const owner = scope.kind === "agent" ? eq(t.reports.agentId, scope.agentId) : eq(t.reports.humanId, scope.humanId);
  const rows = await db
    .select({ toolId: t.toolVersions.toolId, last: sql<number>`max(${t.reports.createdAt})` })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .where(owner)
    .groupBy(t.toolVersions.toolId)
    .orderBy(desc(sql`max(${t.reports.createdAt})`))
    .limit(MAX_TOOLS);
  return rows.map((r) => r.toolId);
}

/** New shown reports from other owners (not House, not founders) on these tools in the window, per tool. */
async function newReportsOn(env: Pick<Env, "ADMIN_GITHUB_IDS" | "PUBLIC_ORIGIN">, db: Db, toolIds: string[], ownerId: string, since: number, until: number) {
  if (!toolIds.length) return [];
  const rows = await db
    .select({ toolId: t.toolVersions.toolId, versionId: t.toolVersions.id, canonical: t.tools.canonicalId, outcome: t.reports.outcome, isHouse: t.humans.isHouse, githubId: t.humans.githubId })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(inArray(t.toolVersions.toolId, toolIds), ne(t.reports.humanId, ownerId), eq(t.reports.held, false), gte(t.reports.createdAt, since), lt(t.reports.createdAt, until)))
    .limit(2000);
  const by = new Map<string, { tool_id: string; page_url: string; new_reports: number; failed: number; versions: Set<string> }>();
  for (const r of rows) {
    if (countsAsHouse(env, r)) continue;
    const x = by.get(r.toolId) ?? { tool_id: r.canonical, page_url: toolPageUrl(env.PUBLIC_ORIGIN, r.canonical), new_reports: 0, failed: 0, versions: new Set<string>() };
    x.new_reports++;
    if (r.outcome === "failed") x.failed++;
    x.versions.add(r.versionId);
    by.set(r.toolId, x);
  }
  return [...by.entries()].map(([toolRef, x]) => ({ toolRef, tool_id: x.tool_id, page_url: x.page_url, new_reports: x.new_reports, failed: x.failed, versions: x.versions })).sort((a, b) => b.new_reports - a.new_reports || a.tool_id.localeCompare(b.tool_id));
}

/** Counted verdicts other owners gave in the window on the scope's reports (the rules of verdicts.ts). */
async function verdictsReceived(env: Pick<Env, "ADMIN_GITHUB_IDS">, db: Db, scope: Scope, since: number, until: number) {
  const target = scope.kind === "agent" ? eq(t.reports.agentId, scope.agentId) : eq(t.reports.humanId, scope.humanId);
  const mine = await db.select({ id: t.reports.id }).from(t.reports).where(target).orderBy(desc(t.reports.createdAt)).limit(500);
  const ids = mine.map((r) => r.id);
  const rows: { reportId: string; verdict: "confirm" | "dispute"; isHouse: boolean; githubId: number; byHeld: boolean }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    rows.push(
      ...(await db
        .select({ reportId: t.reportVerdicts.reportId, verdict: t.reportVerdicts.verdict, isHouse: t.humans.isHouse, githubId: t.humans.githubId, byHeld: t.reports.held })
        .from(t.reportVerdicts)
        .innerJoin(t.humans, eq(t.reportVerdicts.humanId, t.humans.id))
        .innerJoin(t.reports, eq(t.reportVerdicts.byReportId, t.reports.id))
        .where(and(inArray(t.reportVerdicts.reportId, ids.slice(i, i + 90)), eq(t.humans.tier, "verified"), gte(t.reportVerdicts.updatedAt, since), lt(t.reportVerdicts.updatedAt, until)))),
    );
  }
  const counted = rows.filter((r) => !r.byHeld && !countsAsHouse(env, r));
  const per = new Map<string, { confirmations: number; disputes: number }>();
  for (const r of counted) {
    const x = per.get(r.reportId) ?? { confirmations: 0, disputes: 0 };
    if (r.verdict === "confirm") x.confirmations++;
    else x.disputes++;
    per.set(r.reportId, x);
  }
  return {
    confirmations: counted.filter((r) => r.verdict === "confirm").length,
    disputes: counted.filter((r) => r.verdict === "dispute").length,
    reports: [...per.entries()].slice(0, 20).map(([report_id, x]) => ({ report_id, ...x })),
  };
}

/** Normalised, de-duplicated fingerprints and Gauntlet ids from an agent's input; anything malformed is dropped. */
export function cleanInput(input: { watch?: unknown; gauntlet_ids?: unknown }) {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? v.split(",") : []);
  const watch = [...new Set(list(input.watch).map((x) => x.trim().toLowerCase()).filter((x) => FINGERPRINT.test(x)).map((x) => (x.startsWith("sha256:") ? x : `sha256:${x}`)))].slice(0, MAX_WATCH);
  const gauntlets = [...new Set(list(input.gauntlet_ids).map((x) => x.trim()).filter((x) => GAUNTLET_ID.test(x)))].slice(0, MAX_GAUNTLETS);
  return { watch, gauntlets };
}

/** Reports on watched versions' tools (fingerprints the agent gave; watch lists aren't stored, ADR 0026). */
async function watched(env: Pick<Env, "ADMIN_GITHUB_IDS" | "PUBLIC_ORIGIN">, db: Db, fingerprints: string[], ownerId: string, since: number, until: number) {
  if (!fingerprints.length) return [];
  const versions = await db.select({ id: t.toolVersions.id, toolId: t.toolVersions.toolId, version: t.toolVersions.version, fingerprint: t.toolVersions.fingerprint }).from(t.toolVersions).where(inArray(t.toolVersions.fingerprint, fingerprints));
  const news = await newReportsOn(env, db, [...new Set(versions.map((v) => v.toolId))], ownerId, since, until);
  return fingerprints.map((fp) => {
    const v = versions.find((x) => x.fingerprint === fp);
    const n = v ? news.find((x) => x.toolRef === v.toolId) : undefined;
    return { fingerprint: fp, known: !!v, tool_id: n?.tool_id ?? null, version: v?.version ?? null, new_reports_on_tool: n?.new_reports ?? 0, failed: n?.failed ?? 0, on_this_version: v && n?.versions.has(v.id) ? true : false, page_url: n?.page_url ?? null };
  });
}

/** Challenges started in the window against Gauntlet runs whose ids the agent gave: counts and results, no challenger ids. */
async function challenges(db: Db, ids: string[], since: number, until: number) {
  if (!ids.length) return [];
  const originals = await db.select({ id: t.arenaGauntlets.id, summary: t.arenaGauntlets.summary }).from(t.arenaGauntlets).where(inArray(t.arenaGauntlets.id, ids));
  const rows = await db
    .select({ of: t.arenaGauntlets.challengeOf, status: t.arenaGauntlets.status, summary: t.arenaGauntlets.summary })
    .from(t.arenaGauntlets)
    .where(and(inArray(t.arenaGauntlets.challengeOf, ids), gte(t.arenaGauntlets.startedAt, since), lt(t.arenaGauntlets.startedAt, until)))
    .limit(1000);
  return originals.map((o) => {
    const mine = rows.filter((r) => r.of === o.id);
    const done = mine.filter((r) => r.status === "done" && r.summary && o.summary);
    const results = done.map((r) => compareSides(o.summary as GauntletSummary, r.summary as GauntletSummary));
    return {
      gauntlet_id: o.id,
      challenges_started: mine.length,
      challenges_finished: done.length,
      your_run_ahead: results.filter((x) => x === "original_ahead").length,
      challenger_ahead: results.filter((x) => x === "challenger_ahead").length,
      level: results.filter((x) => x === "level").length,
    };
  });
}

/**
 * Ranked Arena events (card and guest, never Lab or practice) with new public results in the window: the event, how
 * many attempts finished and by how many models, and where the per-attempt data is. Held events and embargoed models
 * never count (notEmbargoed), so an event shows up the week its results become public, not before.
 */
export async function newArenaResults(env: Pick<Env, "PUBLIC_ORIGIN">, db: Db, since: number, until: number) {
  const rows = await db
    .select({
      slug: t.arenaEvents.slug,
      name: t.arenaEvents.name,
      attempts: sql<number>`count(*)`,
      models: sql<number>`count(distinct ${t.arenaRuns.modelId})`,
      last: sql<number>`max(${t.arenaRuns.finishedAt})`,
    })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(
      and(
        eq(t.arenaRuns.status, "done"),
        gte(t.arenaRuns.finishedAt, since),
        lt(t.arenaRuns.finishedAt, until),
        inArray(t.arenaEvents.kind, ["card", "guest"]),
        sql`${t.arenaEvents.arm} is null`,
        notEmbargoed(until),
      ),
    )
    .groupBy(t.arenaEvents.id)
    .orderBy(desc(sql`max(${t.arenaRuns.finishedAt})`))
    .limit(10);
  return rows.map((r) => ({
    event: r.slug,
    name: r.name,
    attempts: Number(r.attempts),
    models: Number(r.models),
    page_url: `${env.PUBLIC_ORIGIN}/arena/event/${r.slug}`,
    data_url: `${env.PUBLIC_ORIGIN}/arena/events/${r.slug}.json`,
  }));
}

/** forge_me's `since_last_week`: the last 7 days for one agent. Watched fingerprints and Gauntlet ids come from the agent. */
export async function sinceLastWeek(env: Env, db: Db, who: { agentId: string; humanId: string }, input: { watch?: unknown; gauntlet_ids?: unknown } = {}, now = Date.now()) {
  const since = now - WEEK_MS;
  const scope: Scope = { kind: "agent", ...who };
  const { watch, gauntlets } = cleanInput(input);
  const tools = await newReportsOn(env, db, await reportedTools(db, scope), who.humanId, since, now);
  return {
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    new_reports_on_tools_you_reported: tools.slice(0, 20).map(({ tool_id, page_url, new_reports, failed }) => ({ tool_id, page_url, new_reports, failed })),
    watched: await watched(env, db, watch, who.humanId, since, now),
    verdicts_received: await verdictsReceived(env, db, scope, since, now),
    ranked_ladder: await ladderMove(env, db, who.agentId, since, now, await ladderRanks(db)),
    gauntlet_challenges: await challenges(db, gauntlets, since, now),
    new_arena_results: await newArenaResults(env, db, since, now),
  };
}

/** Monday 00:00 UTC of the ISO week holding `ms`. */
export const weekStart = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
};

/** The owner's weekly digest entries, newest first: this week so far, then the `weeks - 1` weeks before. */
export async function ownerWeeks(env: Env, db: Db, humanId: string, now = Date.now(), weeks = 4) {
  const scope: Scope = { kind: "owner", humanId };
  const tools = await reportedTools(db, scope);
  const agents = await db.select({ id: t.agents.id, handle: t.agents.handle }).from(t.agents).where(and(eq(t.agents.humanId, humanId), eq(t.agents.status, "active")));
  const live = await ladderRanks(db);
  const out = [];
  for (let i = 0; i < weeks; i++) {
    const start = weekStart(now) - i * WEEK_MS;
    const end = Math.min(start + WEEK_MS, now);
    const reports = await newReportsOn(env, db, tools, humanId, start, end);
    const verdicts = await verdictsReceived(env, db, scope, start, end);
    const ladder = [];
    for (const a of agents) {
      const m = await ladderMove(env, db, a.id, start, end, i === 0 ? live : null);
      if (m) ladder.push({ agent: a.handle, ...m });
    }
    out.push({
      start,
      end,
      current: i === 0,
      new_reports: reports.slice(0, 20).map(({ tool_id, page_url, new_reports, failed }) => ({ tool_id, page_url, new_reports, failed })),
      verdicts_received: verdicts,
      ranked_ladder: ladder,
      arena_results: await newArenaResults(env, db, start, end),
    });
  }
  return out;
}

// --- The private Atom feed's token (stored hashed) ------------------------------------------------------------------

export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new random feed token (32 bytes, base64url) for an owner, replacing any earlier one. Returns the token once. */
export async function createFeed(db: Db, humanId: string, now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const tokenHash = await sha256Hex(token);
  await db.insert(t.digestFeeds).values({ humanId, tokenHash, createdAt: now }).onConflictDoUpdate({ target: t.digestFeeds.humanId, set: { tokenHash, createdAt: now } });
  return token;
}

export async function revokeFeed(db: Db, humanId: string) {
  await db.delete(t.digestFeeds).where(eq(t.digestFeeds.humanId, humanId));
}

/** The owner behind a feed token, or null (unknown or revoked). */
export async function feedOwner(db: Db, token: string) {
  if (!FEED_TOKEN.test(token)) return null;
  const [row] = await db.select().from(t.digestFeeds).where(eq(t.digestFeeds.tokenHash, await sha256Hex(token)));
  return row ?? null;
}
