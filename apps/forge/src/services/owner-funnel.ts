import { and, count, countDistinct, eq, gte, inArray, like, lt, lte, min, or, sql } from "drizzle-orm";
import { ensureSeason, seasonBoard, SEASON_1 } from "../arena/season";
import * as t from "../db/schema";
import { outsidePeople } from "./agent-funnel";
import { getDb } from "./db";
import { WEB_AGENT_PREFIX } from "./identity";

// ADR 0055 (D11, owners first): the owner funnel, internal only (/admin/kpis). From a finished Gauntlet run to a
// verified owner: runs finished → claim link shown → claim page opened → claimed → verified owners who claimed. Plus
// agents per owner (keep it close to 1) and Season 1 entrants. Counters that began with this change say so: a stage
// with no counter rows yet is null ("not yet measured"), never 0.

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Sum of usage counters by key (or key prefix) over full UTC days from `fromDay` to `toDay`, and the first day each was seen. */
async function counterSums(env: Env, keys: string[], prefixes: string[], fromDay: string, toDay: string) {
  const db = getDb(env);
  const match = or(inArray(t.usageDaily.key, keys), ...prefixes.map((p) => like(t.usageDaily.key, `${p}%`)));
  const rows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, fromDay), lte(t.usageDaily.day, toDay), match))
    .groupBy(t.usageDaily.key);
  const first = await db.select({ key: t.usageDaily.key, first: min(t.usageDaily.day) }).from(t.usageDaily).where(match).groupBy(t.usageDaily.key);
  const seen = (k: string) => first.find((r) => r.key === k)?.first ?? null;
  /** The sum, or null when the counter has never been written (not yet measured). */
  const get = (k: string) => (seen(k) ? Number(rows.find((r) => r.key === k)?.n ?? 0) : null);
  const byPrefix = (p: string) => Object.fromEntries(rows.filter((r) => r.key.startsWith(p)).map((r) => [r.key.slice(p.length), Number(r.n)]));
  return { get, seen, byPrefix };
}

export interface OwnerFunnel {
  window: { from: string; to: string; days: number };
  stages: {
    runs_finished: number;
    claim_link_shown: number | null;
    claim_page_opened: number | null;
    claimed: number;
    verified_owners_claimed: number;
  };
  claim_page_by_source: Record<string, number>;
  claims_on_new_profiles: number | null;
  refused_not_verified: number | null;
  verified_owners: number;
  verified_agents: number;
  agents_per_owner: number | null;
  web_claim_profiles: number;
  season: { id: string; starts_at: string; entrants: number; entries: number };
  measured_since: { claim_link_shown: string | null; claim_page_opened: string | null };
  notes: string[];
}

/** The owner funnel for the `days` full UTC days before `now`'s day. */
export async function ownerFunnel(env: Env, now = Date.now(), days = 30): Promise<OwnerFunnel> {
  const db = getDb(env);
  const outside = outsidePeople(env);
  const from = now - days * DAY;
  const fromDay = day(from);
  const toDay = day(now - DAY);
  const todayStart = Date.parse(`${day(now)}T00:00:00Z`);
  const windowStart = Date.parse(`${fromDay}T00:00:00Z`);

  const [finished] = await db
    .select({ n: count() })
    .from(t.arenaGauntlets)
    .where(and(eq(t.arenaGauntlets.status, "done"), gte(t.arenaGauntlets.finishedAt, windowStart), lt(t.arenaGauntlets.finishedAt, todayStart)));
  const c = await counterSums(env, ["owner:claim_link_shown", "owner:claim_page", "owner:claim_new_agent", "owner:claim_refused_unverified"], ["owner:claim_page:"], fromDay, toDay);
  const [claims] = await db
    .select({ n: count(), owners: countDistinct(t.gauntletClaims.humanId) })
    .from(t.gauntletClaims)
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .where(and(outside, eq(t.humans.tier, "verified"), gte(t.gauntletClaims.claimedAt, windowStart), lt(t.gauntletClaims.claimedAt, todayStart)));
  const [verified] = await db
    .select({ agents: count(t.agents.id), humans: countDistinct(t.agents.humanId) })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, eq(t.agents.status, "active"), eq(t.humans.tier, "verified")));
  const [web] = await db
    .select({ n: count() })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.agents.humanId, t.humans.id))
    .where(and(outside, eq(t.agents.status, "active"), like(t.agents.oauthClientId, `${WEB_AGENT_PREFIX}%`)));
  const season = await ensureSeason(db, now);
  const board = await seasonBoard(env, season, now);
  const owners = Number(verified?.humans ?? 0);
  return {
    window: { from: fromDay, to: toDay, days },
    stages: {
      runs_finished: Number(finished?.n ?? 0),
      claim_link_shown: c.get("owner:claim_link_shown"),
      claim_page_opened: c.get("owner:claim_page"),
      claimed: Number(claims?.n ?? 0),
      verified_owners_claimed: Number(claims?.owners ?? 0),
    },
    claim_page_by_source: c.byPrefix("owner:claim_page:"),
    claims_on_new_profiles: c.get("owner:claim_new_agent"),
    refused_not_verified: c.get("owner:claim_refused_unverified"),
    verified_owners: owners,
    verified_agents: Number(verified?.agents ?? 0),
    agents_per_owner: owners ? Math.round((Number(verified!.agents) / owners) * 100) / 100 : null,
    web_claim_profiles: Number(web?.n ?? 0),
    season: { id: SEASON_1.id, starts_at: new Date(season.startsAt).toISOString().slice(0, 10), entrants: board.entries.length, entries: board.runs.length },
    measured_since: { claim_link_shown: c.seen("owner:claim_link_shown"), claim_page_opened: c.seen("owner:claim_page") },
    notes: [
      "Runs finished counts every Gauntlet run, ours included (runs are anonymous until claimed).",
      "Claim links shown = claimable runs whose end-of-run result carried claim_url. The CLI, plugin and Action print their line without telemetry, so those shows aren't counted; their clicks are (claim page by source).",
      "Claim page opened counts page views, not people.",
      "Claims and owners: verified owners outside the project (House and founders left out).",
    ],
  };
}
