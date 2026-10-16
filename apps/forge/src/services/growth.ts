import { isNotNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";

// ADR 0011 leading indicators that the Ops Digest reads: tool claims and sites embedding a Forge badge.

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const refKey = (ms: number) => `badge-ref:${day(ms)}`;
const MAX_HOSTS_PER_DAY = 500;

/** Remembers which outside site showed a badge today (host only, no path or visitor data). */
export async function recordBadgeReferrer(env: Pick<Env, "KV" | "PUBLIC_ORIGIN">, referer: string | null | undefined, now = Date.now()) {
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

const clickKey = (ms: number) => `home-click:${day(ms)}`;

/**
 * ADR 0016 §8: a home-page visitor clicked into a bout, the Task Guide or "Call it" (`?from=home`). Only a daily
 * total is kept: no cookie, no visitor data. Best-effort (a rare lost increment under concurrency is accepted).
 */
export async function recordHomeClick(env: Pick<Env, "KV">, now = Date.now()) {
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
  const n = Number((await env.KV.get(cardKey(e, now))) ?? 0);
  await env.KV.put(cardKey(e, now), String(n + 1), { expirationTtl: 40 * 86_400 });
}

export async function trapCardUses(env: Pick<Env, "KV">, e: TrapCardEvent, now = Date.now(), days = 7) {
  let total = 0;
  for (let i = 0; i < days; i++) total += Number((await env.KV.get(cardKey(e, now - i * 86_400_000))) ?? 0);
  return total;
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
    home_clickins_yesterday: await homeClicks(env, now - 86_400_000, 1),
    home_clickins_7d: await homeClicks(env, now),
    trap_card_copies_7d: await trapCardUses(env, "copy", now),
    trap_card_downloads_7d: (await trapCardUses(env, "txt", now)) + (await trapCardUses(env, "json", now)),
  };
}
