import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { freeVariantIds, NEURONS_PER_USD } from "../arena/free-lane";
import * as t from "../db/schema";
import { BYOK_EXPIRES, BYOK_FROM, claudeByokIds, CREDIT_KV, OPENROUTER_CREDIT_PURCHASED_USD, type CreditSnapshot } from "../arena/credit";
import { getDb } from "./db";
import { readLedger } from "./llm-ledger";
import { opsMode } from "./ops-mode";

// AQ-08 (ADR 0097): the cost runway guard. What the Forge costs to run each month, by source, for /admin/costs and the
// data room; and the "paused" state public Arena pages show when a model credit runs out or expires. Reads only what is
// already stored (D1 and KV): it never calls a provider, so a page that shows it can't fail because a provider does.

/** The Anthropic API credit allowance that came with the founder's Claude Max plan (ADR 0064), in USD. */
export const ANTHROPIC_ALLOWANCE_USD = 100;
/** Cloudflare Workers Paid plan (MASTER_PLAN §10): the fixed monthly fee; usage above the included amounts is extra. */
export const CLOUDFLARE_PLAN_USD = 5;
/** Set by the runner when OpenRouter answers 402 (out of credit) or 403 (key limit); clears itself. */
export const OUT_OF_CREDIT_KV = "arena:out-of-credit";
export const OUT_OF_CREDIT_SECONDS = 6 * 3_600;
/** A credit reading older than this is stale and never pauses anything (the runner reads hourly while it runs). */
export const READING_FRESH_MS = 3 * 3_600_000;
export const GITHUB_BILLING_URL = "https://github.com/organizations/theagentforge/settings/billing";
export const CLOUDFLARE_BILLING_URL = "https://dash.cloudflare.com/?to=/:account/billing";

export async function noteOutOfCredit(env: Pick<Env, "KV">, status: number, now = Date.now()) {
  await env.KV.put(OUT_OF_CREDIT_KV, JSON.stringify({ at: new Date(now).toISOString(), status }), { expirationTtl: OUT_OF_CREDIT_SECONDS });
}

export interface ArenaPause {
  /** Non-Claude OpenRouter bouts: the prepaid credit is used up (OpenRouter's last reading, or a 402 in the last hours). */
  openrouter: boolean;
  /** Claude bouts: the Anthropic credit they run on has passed its expiry date. */
  claude: boolean;
  notes: string[];
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The pause state public Arena pages show. Never throws: if KV can't be read, it reports no pause it can't prove. */
export async function arenaPause(env: Pick<Env, "KV">, now = Date.now()): Promise<ArenaPause> {
  const [snap, flagRaw] = await Promise.all([
    env.KV.get<CreditSnapshot>(CREDIT_KV, "json").catch(() => null),
    env.KV.get(OUT_OF_CREDIT_KV).catch(() => null),
  ]);
  // Only a recent, successful reading counts: a stale one (the runner stopped reading) or a failed one proves nothing.
  const fresh = !!snap?.ok && snap.good_at !== null && now - snap.good_at <= READING_FRESH_MS;
  const readsEmpty = fresh && snap!.remaining !== null && snap!.remaining <= 0;
  const flagAt = (() => {
    try {
      const at = Date.parse((JSON.parse(flagRaw ?? "null") as { at?: string } | null)?.at ?? "");
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  })();
  // A 402/403 is superseded by a later fresh reading that shows credit: the pause lifts as soon as credit is back.
  const flagged = flagRaw !== null && !(fresh && snap!.remaining !== null && snap!.remaining > 0 && flagAt !== null && snap!.good_at! > flagAt);
  const openrouter = flagged || readsEmpty;
  const claude = now >= BYOK_EXPIRES;
  const notes: string[] = [];
  if (openrouter) notes.push("Paused: the Arena's prepaid model credit has run out, so new bouts on non-Claude models wait until it is topped up.");
  if (claude) notes.push(`Paused: Claude bouts ran on Anthropic API credit that expired on ${day(BYOK_EXPIRES)}, so new Claude bouts wait until there is new credit.`);
  if (notes.length) notes.push("Published results, replays and the dataset are unaffected.");
  return { openrouter, claude, notes };
}

const monthStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Monthly cost by source (USD). null means "not yet measured" here, never a guess. */
export async function monthlyCosts(env: Env, now = Date.now()) {
  const db = getDb(env);
  const since = monthStart(now);
  const [or] = await db
    .select({ c: sql<number>`coalesce(sum(${t.arenaRuns.cost} - coalesce(${t.arenaRuns.byokCost}, 0)), 0)`, n: sql<number>`count(*)` })
    .from(t.arenaRuns)
    // Free-variant bouts (ADR 0109) cost nothing and are counted in their own row on /admin/costs.
    .where(and(eq(t.arenaRuns.costEstimated, false), gte(t.arenaRuns.finishedAt, since), notInArray(t.arenaRuns.modelId, freeVariantIds().length ? freeVariantIds() : ["-"])));
  const [wai] = await db
    .select({ c: sql<number>`coalesce(sum(${t.arenaRuns.cost}), 0)`, n: sql<number>`count(*)` })
    .from(t.arenaRuns)
    .where(and(eq(t.arenaRuns.costEstimated, true), gte(t.arenaRuns.finishedAt, since)));
  const ids = claudeByokIds();
  const byokSum = async (from: number) =>
    Number(
      (
        await db
          .select({ c: sql<number>`coalesce(sum(${t.arenaRuns.byokCost}), 0)` })
          .from(t.arenaRuns)
          .where(and(inArray(t.arenaRuns.modelId, ids.length ? ids : ["-"]), gte(t.arenaRuns.finishedAt, from)))
      )[0]?.c ?? 0,
    );
  // ADR 0113: Moltbook replies on Claude spend the same Anthropic credit; their spend is in the ledger (KV, 40 days).
  const ledgerMonth = await readLedger(env.KV, since, now);
  const ledgerSinceStart = await readLedger(env.KV, Math.max(BYOK_FROM, now - 39 * 86_400_000), now);
  const ledgerAnthropic = (l: Awaited<ReturnType<typeof readLedger>>) => Object.values(l.total).reduce((a, x) => a + (x?.anthropic_usd ?? 0), 0);
  const byokMonth = (await byokSum(Math.max(since, BYOK_FROM))) + ledgerAnthropic(ledgerMonth);
  const byokAll = (await byokSum(BYOK_FROM)) + ledgerAnthropic(ledgerSinceStart);
  // Burn rate: the last 7 days' Anthropic spend (bouts and ledger), per day.
  const weekAgo = now - 7 * 86_400_000;
  const byokWeek = (await byokSum(Math.max(weekAgo, BYOK_FROM))) + ledgerAnthropic(await readLedger(env.KV, Math.max(weekAgo, BYOK_FROM), now));
  const burnPerDay = byokWeek / Math.max(1, Math.min(7, (now - BYOK_FROM) / 86_400_000));
  const left = Math.max(0, ANTHROPIC_ALLOWANCE_USD - byokAll);
  const daysAtBurn = burnPerDay > 0 ? left / burnPerDay : null;
  const snap = await env.KV.get<CreditSnapshot>(CREDIT_KV, "json").catch(() => null);
  const mode = await opsMode(env, now).catch(() => "normal" as const);
  return {
    month: new Date(since).toISOString().slice(0, 7),
    as_of: new Date(now).toISOString(),
    cloudflare: { plan_usd: CLOUDFLARE_PLAN_USD, usage_usd: null as number | null, ops_mode: mode, billing_url: CLOUDFLARE_BILLING_URL },
    openrouter: {
      spent_month_usd: r4(Number(or?.c ?? 0)),
      bouts_month: Number(or?.n ?? 0),
      purchased_usd: OPENROUTER_CREDIT_PURCHASED_USD,
      remaining_usd: snap?.remaining ?? null,
      reading_at: snap?.good_at ? new Date(snap.good_at).toISOString() : null,
      reading_ok: snap?.ok ?? null,
    },
    workers_ai: { estimated_month_usd: r4(Number(wai?.c ?? 0)), bouts_month: Number(wai?.n ?? 0) },
    anthropic_byok: {
      spent_month_usd: r4(byokMonth),
      spent_since_start_usd: r4(byokAll),
      allowance_usd: ANTHROPIC_ALLOWANCE_USD,
      left_usd: r4(left),
      started: day(BYOK_FROM),
      expires: day(BYOK_EXPIRES),
      days_left: Math.max(0, Math.ceil((BYOK_EXPIRES - now) / 86_400_000)),
      expired: now >= BYOK_EXPIRES,
      /** ADR 0113: the last 7 days' spend per day, and how many days the credit left lasts at that rate (null: no spend). */
      burn_per_day_usd: r4(burnPerDay),
      days_left_at_burn: daysAtBurn === null ? null : Math.round(daysAtBurn * 10) / 10,
      /** Whichever comes first: the credit running out at the current burn, or its expiry. */
      lasts_until: day(Math.min(BYOK_EXPIRES, daysAtBurn === null ? BYOK_EXPIRES : now + daysAtBurn * 86_400_000)),
    },
    by_task: await spendByTask(env, since, now, ledgerMonth.total),
    github_actions: { billing_url: GITHUB_BILLING_URL },
    pause: await arenaPause(env, now),
  };
}

/**
 * ADR 0113: this month's model spend by task. The Arena by lane, from stored runs: Claude on the Anthropic key, other
 * OpenRouter models on credit, free variants, and Workers AI practice and ranked (estimated neurons at list price).
 * Moltbook replies, the Moltbook challenge solver and note moderation, from the ledger (llm-ledger.ts).
 */
export async function spendByTask(env: Env, since: number, now: number, ledger: Awaited<ReturnType<typeof readLedger>>["total"]) {
  const db = getDb(env);
  const claude = claudeByokIds();
  const free = freeVariantIds();
  const done = [eq(t.arenaRuns.status, "done"), gte(t.arenaRuns.finishedAt, since), lt(t.arenaRuns.finishedAt, now + 1)];
  const sum = async (where: ReturnType<typeof and>[], usd = sql<number>`coalesce(sum(${t.arenaRuns.cost}), 0)`) => {
    const [r] = await db
      .select({ usd, byok: sql<number>`coalesce(sum(${t.arenaRuns.byokCost}), 0)`, n: sql<number>`count(*)` })
      .from(t.arenaRuns)
      .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
      .where(and(...done, ...where));
    return { usd: Number(r?.usd ?? 0), byok: Number(r?.byok ?? 0), bouts: Number(r?.n ?? 0) };
  };
  const credit = sql<number>`coalesce(sum(${t.arenaRuns.cost} - coalesce(${t.arenaRuns.byokCost}, 0)), 0)`;
  const ids = (x: string[]) => (x.length ? x : ["-"]);
  const c = await sum([inArray(t.arenaRuns.modelId, ids(claude)), eq(t.arenaRuns.costEstimated, false)], credit);
  const or = await sum([notInArray(t.arenaRuns.modelId, ids([...claude, ...free])), eq(t.arenaRuns.costEstimated, false)], credit);
  const fv = await sum([inArray(t.arenaRuns.modelId, ids(free))]);
  const wp = await sum([eq(t.arenaRuns.costEstimated, true), eq(t.arenaEvents.kind, "practice")]);
  const wr = await sum([eq(t.arenaRuns.costEstimated, true), sql`${t.arenaEvents.kind} != 'practice'`]);
  const line = (k: keyof typeof ledger) => {
    const l = ledger[k];
    return {
      calls: l?.calls ?? 0,
      anthropic_usd: r4(l?.anthropic_usd ?? 0),
      credit_usd: r4(l?.credit_usd ?? 0),
      neurons: Math.round(l?.neurons ?? 0),
      cached_tokens: l?.cached_tokens ?? 0,
      cache_write_tokens: l?.cache_write_tokens ?? 0,
    };
  };
  return {
    arena: {
      claude_byok: { bouts: c.bouts, anthropic_usd: r4(c.byok), credit_usd: r4(c.usd) },
      openrouter_credit: { bouts: or.bouts, credit_usd: r4(or.usd) },
      free_variants: { bouts: fv.bouts },
      workers_ai_practice: { bouts: wp.bouts, estimated_usd: r4(wp.usd), neurons: Math.round(wp.usd * NEURONS_PER_USD) },
      workers_ai_ranked: { bouts: wr.bouts, estimated_usd: r4(wr.usd), neurons: Math.round(wr.usd * NEURONS_PER_USD) },
    },
    moltbook_replies: line("moltbook_replies"),
    moltbook_challenge: line("moltbook_challenge"),
    moderation: line("moderation"),
    /** The ledger keeps 40 days and is read per day; a call that failed to record is missing (an estimate). */
    ledger_note: "Moltbook and moderation figures come from a per-day KV ledger written after each call; Arena figures from stored bouts.",
  };
}
