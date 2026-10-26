import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { isLean } from "./ops-mode";
import { aiAgentStats, bump, usageStats, visitStats, skillStats } from "./usage";
import { agentFunnel, outsidePeople } from "./agent-funnel";

// ADR 0011 leading indicators that the Ops Digest reads: tool claims and sites embedding a Forge badge.

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const refKey = (ms: number) => `badge-ref:${day(ms)}`;
const MAX_HOSTS_PER_DAY = 500;

/** Remembers which outside site showed a badge today (host only, no path or visitor data). */
export async function recordBadgeReferrer(env: Pick<Env, "KV" | "PUBLIC_ORIGIN">, referer: string | null | undefined, now = Date.now()) {
  if (await isLean(env)) return;
  if (!referer) return;
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return;
  }
  if (!host || host === new URL(env.PUBLIC_ORIGIN).hostname) return;
  const hosts = ((await env.KV.get(refKey(now), "json")) as string[] | null) ?? [];
  if (hosts.includes(host) || hosts.length >= MAX_HOSTS_PER_DAY) return;
  await env.KV.put(refKey(now), JSON.stringify([...hosts, host]), { expirationTtl: 10 * 86_400 });
}

/**
 * V6: a README badge was served (an embed shown; GitHub's image proxy and the edge cache both count once per fetch) and
 * the referring site, if any. Daily totals only. Click-ins from badges are the `?from=badge` arrivals (visit:tag:badge).
 */
export async function recordBadgeServe(env: Env, referer: string | null | undefined, now = Date.now()) {
  await bump(env, ["badge:serve"], now);
  await recordBadgeReferrer(env, referer, now);
}

/** Badge serves and badge click-ins over the last `days` days (today included). */
export async function badgeStats(env: Env, now = Date.now(), days = 7) {
  const since = day(now - (days - 1) * 86_400_000);
  const rows = await getDb(env)
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, since), inArray(t.usageDaily.key, ["badge:serve", "visit:tag:badge"])))
    .groupBy(t.usageDaily.key);
  const n = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
  return { serves: n("badge:serve"), clickins: n("visit:tag:badge") };
}

const clickKey = (ms: number) => `home-click:${day(ms)}`;

/**
 * ADR 0016 §8: a home-page visitor clicked into a bout, the Task Guide or "Call it" (`?from=home`). Only a daily
 * total is kept: no cookie, no visitor data. Best-effort (a rare lost increment under concurrency is accepted).
 */
export async function recordHomeClick(env: Pick<Env, "KV">, now = Date.now()) {
  if (await isLean(env)) return;
  const n = Number((await env.KV.get(clickKey(now))) ?? 0);
  await env.KV.put(clickKey(now), String(n + 1), { expirationTtl: 40 * 86_400 });
}

export async function homeClicks(env: Pick<Env, "KV">, now = Date.now(), days = 7) {
  let total = 0;
  for (let i = 0; i < days; i++) total += Number((await env.KV.get(clickKey(now - i * 86_400_000))) ?? 0);
  return total;
}

/** Trap card use (ADR 0017): copies from the page, and plain-text or JSON downloads. Daily totals only, no visitor data. */
export type TrapCardEvent = "copy" | "txt" | "json";
const cardKey = (e: TrapCardEvent, ms: number) => `trapcard-${e}:${day(ms)}`;

export async function recordTrapCard(env: Pick<Env, "KV">, e: TrapCardEvent, now = Date.now()) {
  if (await isLean(env)) return;
  const n = Number((await env.KV.get(cardKey(e, now))) ?? 0);
  await env.KV.put(cardKey(e, now), String(n + 1), { expirationTtl: 40 * 86_400 });
}

export async function trapCardUses(env: Pick<Env, "KV">, e: TrapCardEvent, now = Date.now(), days = 7) {
  let total = 0;
  for (let i = 0; i < days; i++) total += Number((await env.KV.get(cardKey(e, now - i * 86_400_000))) ?? 0);
  return total;
}

/** The Gauntlet funnel (ADR 0024) over 7 days: started, finished, and measured re-runs finished. Counts only. */
async function gauntletStats(env: Pick<Env, "ADMIN_GITHUB_IDS">, db: ReturnType<typeof getDb>, now: number) {
  const since = now - 7 * 86_400_000;
  const [r] = await db
    .select({
      started: sql<number>`count(*)`,
      finished: sql<number>`sum(case when ${t.arenaGauntlets.status} = 'done' and ${t.arenaGauntlets.cardFrom} is null then 1 else 0 end)`,
      reruns: sql<number>`sum(case when ${t.arenaGauntlets.status} = 'done' and ${t.arenaGauntlets.cardFrom} is not null then 1 else 0 end)`,
    })
    .from(t.arenaGauntlets)
    .where(gte(t.arenaGauntlets.startedAt, since));
  // ADR 0048: opt-in claims in the same 7 days, by owners outside the project (House and founders left out).
  const [cl] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t.gauntletClaims)
    .innerJoin(t.humans, eq(t.gauntletClaims.humanId, t.humans.id))
    .where(and(gte(t.gauntletClaims.claimedAt, since), outsidePeople(env)));
  return { gauntlets_started_7d: Number(r?.started ?? 0), gauntlets_finished_7d: Number(r?.finished ?? 0), gauntlet_reruns_finished_7d: Number(r?.reruns ?? 0), gauntlet_claims_7d: Number(cl?.n ?? 0) };
}

export async function growthStats(env: Env, now = Date.now()) {
  const db = getDb(env);
  const [claims] = await db.select({ total: sql<number>`count(*)` }).from(t.publisherClaims);
  const [verified] = await db.select({ n: sql<number>`count(*)` }).from(t.publisherClaims).where(isNotNull(t.publisherClaims.verifiedAt));
  const sites = new Set<string>();
  for (let i = 0; i < 7; i++) for (const h of ((await env.KV.get(refKey(now - i * 86_400_000), "json")) as string[] | null) ?? []) sites.add(h);
  return {
    claims: claims?.total ?? 0,
    claims_verified: verified?.n ?? 0,
    badge_sites_7d: sites.size,
    ...(await badgeStats(env, now).then(
      (b) => ({ badge_serves_7d: b.serves, badge_clickins_7d: b.clickins }),
      () => ({}),
    )),
    home_clickins_yesterday: await homeClicks(env, now - 86_400_000, 1),
    home_clickins_7d: await homeClicks(env, now),
    trap_card_copies_7d: await trapCardUses(env, "copy", now),
    ...(await gauntletStats(env, db, now)),
    trap_card_downloads_7d: (await trapCardUses(env, "txt", now)) + (await trapCardUses(env, "json", now)),
    ...(await usageStats(env, now).then(
      (u) => ({ mcp_sessions_7d: u.mcp_sessions, mcp_sessions_signed_in_7d: u.mcp_sessions_signed_in, mcp_tool_calls_7d: u.mcp_tool_calls, mcp_top_clients_7d: u.top_clients }),
      () => ({}),
    )),
    ...(await skillStats(env, now).then(
      (k) => ({ skill_scans_7d: k.scans, skill_scans_by_channel_7d: k.scans_by_channel, skill_scans_flagged_7d: k.scans_flagged, watch_checkins_7d: k.watch_checkins, watch_fingerprints_7d: k.watch_fingerprints, skill_file_agent_fetches_7d: k.skill_file_agent_fetches, skill_file_browser_views_7d: k.skill_file_browser_views, a2a_requests_7d: k.a2a_requests, a2a_by_skill_7d: k.a2a_by_skill }),
      () => ({}),
    )),
    ...(await agentFunnel(env, now).then(
      (f) => ({ agent_funnel_7d: f }),
      () => ({}),
    )),
    ...(await agentFunnel(env, now - 86_400_000, 1).then(
      (f) => ({ agent_funnel_yesterday: f.stages, outside_tool_calls_yesterday: f.detail.outside_tool_calls }),
      () => ({}),
    )),
    ...(await aiAgentStats(env, now).then(
      (a) => ({ ai_indexers_7d: a.indexers, ai_live_fetches_7d: a.live_fetches, ai_coding_agents_7d: a.coding_agents }),
      () => ({}),
    )),
    ...(await visitStats(env, now).then(
      // Gross page views only: the people-only breakdown stays internal (Dinike, 23 Oct), in /api/v1/ops/scout-signals.
      (v) => ({ page_views_7d: v.page_views }),
      () => ({}),
    )),
  };
}
