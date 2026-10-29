import { TASKS } from "@forge/arena";
import { and, eq, gt, gte, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { WEEKLY_ATTEMPTS, weeklyModels } from "./headline-slot";
import { ALL_MODELS, type ArenaModel } from "./lineup";

// Credit-aware routing (ADR 0064, Dinike 26 Oct 2026: use our own Anthropic key through OpenRouter BYOK wherever
// possible, and keep prepaid OpenRouter credit for the work that needs it). Claude routes (provider "anthropic") are billed to our
// own Anthropic key; every other OpenRouter route spends the prepaid OpenRouter credit. This guard keeps enough of that
// credit for the next two weekly headline bouts and the held studies (contamination test 1): below that reserve, new
// non-Claude OpenRouter bouts for practice and the longitudinal panel don't start ("paused: credit"). The weekly
// headline, other ranked events and held studies carry on; a bout already started finishes.

/**
 * OpenRouter credit bought in total, after fees (ADR 0064). Update when credit is topped up: the guard reads the key's
 * all-time `usage` and takes it from this figure. 29 Oct: OpenRouter's Credits page lists $145 of credit bought (30 + 35 + 50
 * + 10 + 5 + 15; purchase fees are charged on top, not taken out) and $11.20 available with $133.80 used, which matches
 * 145 - 133.80. The old figure (132) made the guard read about -$1.68 and show a false "paused" note.
 */
export const OPENROUTER_CREDIT_PURCHASED_USD = 145;
/** The cached reading of OpenRouter's key API. Read at most once an hour. */
export const CREDIT_KV = "arena:or-credit";
export const CREDIT_REFRESH_MS = 3_600_000;
/**
 * Set for 24 hours when a Claude route was served without our BYOK key (OpenRouter's "shared capacity fallback"): until
 * it clears, Claude routes spend credit, so the guard and the monthly cap treat them like any other OpenRouter route.
 */
export const BYOK_FALLBACK_KV = "arena:byok-fallback";
/**
 * Every Claude bout runs on our own Anthropic key, never on OpenRouter credit (Dinike, 28 Oct). After a Claude turn is
 * billed to credit, no Claude bout starts or carries on for an hour; then one bout tries the key again. So a failing
 * key costs at most one credit-billed turn an hour. The real stop is the key's "Shared capacity fallback" setting on
 * OpenRouter ("Never use shared capacity"), which makes a failing key an error instead of a charge.
 */
export const BYOK_HOLD_KV = "arena:byok-hold";
export const BYOK_HOLD_SECONDS = 3_600;
/** The reserve is the estimate times this, because costs per bout vary (contamination-test-1.md: ceiling about 2×). */
export const RESERVE_SAFETY = 1.5;
/** Cost per bout for a model with no stored OpenRouter bouts yet. */
export const DEFAULT_BOUT_USD = 0.05;
/** BYOK reached the Arena on this day; the second is when the key's current funding runs out (ADR 0064). */
export const BYOK_FROM = Date.UTC(2026, 9, 26);
export const BYOK_EXPIRES = Date.UTC(2026, 10, 16);
/** Contamination test 1 (docs/data/contamination-test-1.json), counted in the reserve until it is queued. */
export const CONTAMINATION_TEST_1 = {
  slug: "contamination-test-1",
  models: ["claude-sonnet-5.5", "gpt-6.1-sol", "gemini-4-argon", "mistral-large-4", "deepseek-v4-pro", "qwen3.8-max"],
  /** 6 jobs × 2 sides (public and held out) × 2 attempts, per model. */
  boutsPerModel: 24,
};

/** A Claude model through OpenRouter pinned to provider "anthropic": served on our own Anthropic key (BYOK). */
export const isClaudeByok = (m: Pick<ArenaModel, "route">) => m.route.kind === "openrouter" && m.route.provider.toLowerCase() === "anthropic";
/**
 * Spends OpenRouter credit: every OpenRouter route except Claude's (unless BYOK has been seen falling back) and the
 * `:free` variants (ADR 0109), which have their own caps (free-lane.ts) and are never paused or counted by this guard.
 */
export const spendsCredit = (m: Pick<ArenaModel, "route">, byokFallback = false) => m.route.kind === "openrouter" && !m.route.free && (byokFallback || !isClaudeByok(m));
export const creditModelIds = (byokFallback = false) => ALL_MODELS.filter((m) => spendsCredit(m, byokFallback)).map((m) => m.id);
export const claudeByokIds = () => ALL_MODELS.filter(isClaudeByok).map((m) => m.id);

/**
 * Model-agnostic jobs (practice filler, demo bouts, any "pick a model" default): these first while the BYOK credits
 * last, then the Workers AI practice models (their own daily allowance). Never used to change a ranked, weekly or study
 * lineup, which must stay the same for comparability.
 */
export const FILLER_MODELS = ["claude-haiku-5.5", "claude-sonnet-5.5"] as const;

export interface CreditSnapshot {
  /** When OpenRouter was last asked (ms). */
  at: number;
  /** When the figures below were read (the last successful reading). */
  good_at: number | null;
  ok: boolean;
  /** Credit left: the smaller of the key's own limit left and (credit bought − the key's all-time usage). */
  remaining: number | null;
  key_limit_remaining: number | null;
  key_usage: number | null;
  /** OpenRouter's figure for BYOK spend this month (USD), when the key API reports it. */
  byok_usage_monthly: number | null;
  error?: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * OpenRouter's "get current key" endpoint (GET /api/v1/key, checked 26 Oct 2026), which works with an ordinary API key
 * (GET /api/v1/credits needs a management key, which we don't have). Cached in KV; asked at most once an hour, also
 * after a failure (the last good figures are kept).
 */
export async function readCredit(env: Pick<Env, "KV"> & { OPENROUTER_API_KEY?: string }, now = Date.now(), fetcher: typeof fetch = fetch): Promise<CreditSnapshot | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  const cached = (await env.KV.get<CreditSnapshot>(CREDIT_KV, "json").catch(() => null)) ?? null;
  if (cached && now - cached.at < CREDIT_REFRESH_MS) return cached;
  let snap: CreditSnapshot;
  try {
    const res = await fetcher("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
    if (!res.ok) throw new Error(`OpenRouter key API ${res.status}`);
    const { data } = (await res.json()) as { data?: Record<string, unknown> };
    const limitRemaining = num(data?.limit_remaining);
    const usage = num(data?.usage);
    const options = [limitRemaining, usage === null ? null : OPENROUTER_CREDIT_PURCHASED_USD - usage].filter((x): x is number => x !== null);
    snap = {
      at: now,
      good_at: now,
      ok: true,
      remaining: options.length ? Math.round(Math.min(...options) * 10_000) / 10_000 : null,
      key_limit_remaining: limitRemaining,
      key_usage: usage,
      byok_usage_monthly: num(data?.byok_usage_monthly),
    };
  } catch (e) {
    snap = { ...(cached ?? { good_at: null, remaining: null, key_limit_remaining: null, key_usage: null, byok_usage_monthly: null }), at: now, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
  await env.KV.put(CREDIT_KV, JSON.stringify(snap), { expirationTtl: 2 * 86_400 });
  return snap;
}

/** OpenRouter credit spent by a stored run: its cost less the part billed to our own key. */
const creditCost = sql<number>`(${t.arenaRuns.cost} - coalesce(${t.arenaRuns.byokCost}, 0))`;

/** Average OpenRouter credit per bout for each model, from stored bouts (Normal jobs first, last 60 days). */
export async function costPerBout(env: Env, models: string[], now = Date.now()): Promise<Record<string, number>> {
  if (!models.length) return {};
  const db = getDb(env);
  const avg = async (normalOnly: boolean) => {
    const rows = await db
      .select({ model: t.arenaRuns.modelId, avg: sql<number>`avg(${creditCost})` })
      .from(t.arenaRuns)
      .where(
        and(
          eq(t.arenaRuns.status, "done"),
          eq(t.arenaRuns.costEstimated, false),
          inArray(t.arenaRuns.modelId, models),
          gte(t.arenaRuns.finishedAt, now - 60 * 86_400_000),
          ...(normalOnly ? [inArray(t.arenaRuns.task, TASKS.map((x) => x.id))] : []),
        ),
      )
      .groupBy(t.arenaRuns.modelId);
    return new Map(rows.map((r) => [r.model, Number(r.avg)]));
  };
  const normal = await avg(true);
  const any = await avg(false);
  return Object.fromEntries(models.map((m) => [m, Math.max(0, normal.get(m) ?? any.get(m) ?? DEFAULT_BOUT_USD)]));
}

export interface Reserve {
  /** Dollars of OpenRouter credit kept back (the estimate × RESERVE_SAFETY). */
  total: number;
  /** The estimate, before the safety factor. */
  weekly: number;
  held: number;
  contamination_test_1: number;
  safety: number;
  per_bout: Record<string, number>;
}

/**
 * What the next two weekly headline bouts and the held studies will spend in OpenRouter credit, from stored costs:
 * runs still queued in weekly events and held ("planned") events, plus weeks not yet queued, plus contamination test 1
 * while it isn't queued. Claude (BYOK) and Workers AI bouts don't spend credit, so they aren't counted.
 */
export async function estimateReserve(env: Env, now = Date.now(), byokFallback = false): Promise<Reserve> {
  const db = getDb(env);
  const credit = new Set(creditModelIds(byokFallback));
  const weekly = weeklyModels().filter((m) => credit.has(m));
  const ct1 = CONTAMINATION_TEST_1.models.filter((m) => credit.has(m));
  const open = await db
    .select({ slug: t.arenaEvents.slug, status: t.arenaEvents.status, model: t.arenaRuns.modelId, n: sql<number>`count(*)` })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(inArray(t.arenaRuns.status, ["queued", "running"]), inArray(t.arenaRuns.modelId, [...credit].length ? [...credit] : ["-"]), sql`(${t.arenaEvents.slug} like 'weekly-%' or ${t.arenaEvents.status} = 'planned')`))
    .groupBy(t.arenaEvents.slug, t.arenaEvents.status, t.arenaRuns.modelId);
  const per = await costPerBout(env, [...new Set([...weekly, ...ct1, ...open.map((r) => r.model)])], now);
  const [ct1Event] = await db.select({ id: t.arenaEvents.id }).from(t.arenaEvents).where(eq(t.arenaEvents.slug, CONTAMINATION_TEST_1.slug));
  const weeklyOpen = open.filter((r) => r.slug.startsWith("weekly-"));
  const weeksQueued = new Set(weeklyOpen.map((r) => r.slug)).size;
  const weeklyUsd =
    weeklyOpen.reduce((s, r) => s + Number(r.n) * per[r.model]!, 0) +
    Math.max(0, 2 - weeksQueued) * WEEKLY_ATTEMPTS * 2 * weekly.reduce((s, m) => s + per[m]!, 0); // public seed + held-out seed
  const heldUsd = open.filter((r) => !r.slug.startsWith("weekly-")).reduce((s, r) => s + Number(r.n) * per[r.model]!, 0);
  const ct1Usd = ct1Event ? 0 : ct1.reduce((s, m) => s + CONTAMINATION_TEST_1.boutsPerModel * per[m]!, 0);
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  return { total: r4((weeklyUsd + heldUsd + ct1Usd) * RESERVE_SAFETY), weekly: r4(weeklyUsd), held: r4(heldUsd), contamination_test_1: r4(ct1Usd), safety: RESERVE_SAFETY, per_bout: per };
}

export interface CreditGuard {
  /** "off": no OpenRouter key; "open": above the reserve; "paused": below it (new practice and panel bouts wait). */
  state: "off" | "open" | "paused";
  /** OpenRouter credit left now (estimate): the last reading less what stored bouts have spent since. */
  remaining: number | null;
  source: "openrouter_key_api" | "stored_costs";
  checked_at: string | null;
  reading_ok: boolean;
  spent_since_reading: number;
  reserve: Reserve;
  byok_fallback: { at: string; model: string } | null;
  snapshot: CreditSnapshot | null;
}

export async function byokFallbackSeen(env: Pick<Env, "KV">) {
  return (await env.KV.get<{ at: string; model: string }>(BYOK_FALLBACK_KV, "json").catch(() => null)) ?? null;
}

/**
 * A Claude route charged OpenRouter credit (not our key): remembered for 24 hours (see BYOK_FALLBACK_KV), and Claude
 * bouts held for an hour (BYOK_HOLD_KV).
 */
export async function noteByokFallback(env: Pick<Env, "KV">, model: string, now = Date.now()) {
  console.warn("arena_byok_fallback", model, "a Claude route was billed to OpenRouter credit, not the BYOK key; Claude bouts held for an hour");
  const value = JSON.stringify({ at: new Date(now).toISOString(), model });
  await env.KV.put(BYOK_FALLBACK_KV, value, { expirationTtl: 86_400 });
  await env.KV.put(BYOK_HOLD_KV, value, { expirationTtl: BYOK_HOLD_SECONDS });
}

/** Claude bouts are held (a Claude turn was billed to credit within the hour). */
export async function byokHeld(env: Pick<Env, "KV">) {
  return (await env.KV.get(BYOK_HOLD_KV).catch(() => null)) !== null;
}

/** The guard's state now. Reads OpenRouter at most hourly; between readings, stored bout costs bring it up to date. */
export async function creditGuard(env: Env & { OPENROUTER_API_KEY?: string }, now = Date.now(), fetcher: typeof fetch = fetch): Promise<CreditGuard> {
  const fallback = await byokFallbackSeen(env);
  const reserve = await estimateReserve(env, now, !!fallback);
  const snap = await readCredit(env, now, fetcher);
  const db = getDb(env);
  const spentSince = async (since: number | null) =>
    Number(
      (
        await db
          .select({ c: sql<number>`coalesce(sum(${creditCost}), 0)` })
          .from(t.arenaRuns)
          .where(and(eq(t.arenaRuns.status, "done"), eq(t.arenaRuns.costEstimated, false), ...(since === null ? [] : [gt(t.arenaRuns.finishedAt, since)])))
      )[0]?.c ?? 0,
    );
  let remaining: number | null;
  let source: CreditGuard["source"];
  let spent = 0;
  // Credit bought less every stored OpenRouter-billed bout. The ops checks aren't stored, so this is never lower than
  // the truth: it is a ceiling, used on its own before the first reading and as a cap on the key API's figure (a new or
  // rotated key reports a small all-time `usage`, which would otherwise read as nearly all the credit left).
  const stored = OPENROUTER_CREDIT_PURCHASED_USD - (await spentSince(null));
  if (snap && snap.remaining !== null && snap.good_at !== null) {
    // A failed reading keeps the last good figures, so spend is counted from when those were read.
    spent = await spentSince(snap.good_at);
    remaining = Math.min(snap.remaining - spent, stored);
    source = "openrouter_key_api";
  } else {
    remaining = stored;
    source = "stored_costs";
  }
  remaining = Math.round(remaining * 10_000) / 10_000;
  const state: CreditGuard["state"] = !env.OPENROUTER_API_KEY ? "off" : remaining < reserve.total ? "paused" : "open";
  return {
    state,
    remaining,
    source,
    checked_at: snap ? new Date(snap.at).toISOString() : null,
    reading_ok: snap?.ok ?? false,
    spent_since_reading: Math.round(spent * 10_000) / 10_000,
    reserve,
    byok_fallback: fallback,
    snapshot: snap,
  };
}

/** Whether a model-agnostic ops call (citations, tool selection) on this model may start now. */
export async function opsCallAllowed(env: Env & { OPENROUTER_API_KEY?: string }, claude: boolean, now = Date.now(), fetcher: typeof fetch = fetch) {
  // Claude runs on our Anthropic key only: held (BYOK_HOLD_KV) after a turn was billed to credit, allowed otherwise.
  if (claude) return (await byokHeld(env)) ? { ok: false as const, remaining: null, reserve: null } : { ok: true as const };
  // Fails closed: if the guard can't be worked out, a call that spends credit waits (the ops checks are optional).
  const g = await creditGuard(env, now, fetcher).catch((e) => {
    console.error("ops: credit guard unavailable", String(e));
    return null;
  });
  if (!g) return { ok: false as const, remaining: null, reserve: null };
  return g.state === "paused" ? { ok: false as const, remaining: g.remaining, reserve: g.reserve.total } : { ok: true as const };
}

/**
 * Anthropic BYOK spend this month (an estimate): the BYOK part of stored bout costs as OpenRouter reported it, and how
 * many Claude bouts finished without a reported BYOK cost (billed to credit, or BYOK with the upstream cost unreported:
 * byok_cost 0). Those can't be separated.
 */
export async function byokSpendThisMonth(env: Env, now = Date.now()) {
  const d = new Date(now);
  const since = Math.max(BYOK_FROM, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const ids = claudeByokIds();
  const [r] = await getDb(env)
    .select({
      byok: sql<number>`coalesce(sum(${t.arenaRuns.byokCost}), 0)`,
      bouts: sql<number>`count(*)`,
      unseparated: sql<number>`sum(case when coalesce(${t.arenaRuns.byokCost}, 0) = 0 then 1 else 0 end)`,
    })
    .from(t.arenaRuns)
    .where(and(eq(t.arenaRuns.status, "done"), inArray(t.arenaRuns.modelId, ids.length ? ids : ["-"]), gte(t.arenaRuns.finishedAt, since)));
  return { since: new Date(since).toISOString().slice(0, 10), usd: Math.round(Number(r?.byok ?? 0) * 10_000) / 10_000, claude_bouts: Number(r?.bouts ?? 0), without_byok_cost: Number(r?.unseparated ?? 0) };
}
