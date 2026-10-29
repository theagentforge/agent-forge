import { ANONYMOUS_PER_MINUTE, PAID_PLAN_IDS, PLANS, type Plan, type PlanId, isPlanId } from "@forge/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { CHECK_LIMIT_PERIOD_S, RATE_LIMITED } from "./errors";

// ADR 0110: optional API keys and a paid high-volume tier, behind PRICING_MODE (off | keys | paid).
//
// - Calls without a key take exactly the path they always did (CHECK_LIMITER per IP); with PRICING_MODE off, a key is
//   ignored altogether and nothing visible changes.
// - A key is `forge_sk_` + 32 base62 characters, shown once. Only an HMAC of it is stored.
// - Keyed calls are limited per key per minute (a rate-limit binding per plan) and per owner per UTC month (the sum of
//   api_usage_daily across their keys). Counts are buffered in the isolate and written to D1 in batches (one upsert per
//   key and day every few seconds), never one write per call; the month's total is cached for 30 seconds. So the quota
//   is counted within about a minute and can run slightly over, as /pricing says.

export type PricingMode = "off" | "keys" | "paid";
export const pricingMode = (env: Pick<Env, "PRICING_MODE">): PricingMode => {
  const m = String(env.PRICING_MODE ?? "off");
  return m === "keys" || m === "paid" ? m : "off";
};

export const KEY_PREFIX = "forge_sk_";
const KEY_BODY = 32;
const KEY_RE = /^forge_sk_[0-9A-Za-z]{32}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_SHOWN_PREFIX = 12;
export const KEY_NAME_MAX = 40;
const CACHE_MS = 30_000;
const FLUSH_MS = 10_000;
const FLUSH_CALLS = 50;

export const PRICING_PATH = "/pricing";
export const KEYS_PATH = "/dashboard/keys";
export const PRICING_CONTACT = "hello@theagentforge.io";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmacHex(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** A new key: 32 characters from crypto.getRandomValues, rejection-sampled so every base62 character is equally likely. */
export function generateKey() {
  let body = "";
  while (body.length < KEY_BODY) {
    for (const b of crypto.getRandomValues(new Uint8Array(48))) if (b < 248 && body.length < KEY_BODY) body += BASE62[b % 62];
  }
  return `${KEY_PREFIX}${body}`;
}

/**
 * The stored hash for each scheme that may be in use: "p" with API_KEY_PEPPER once it is set, "s" with a key derived
 * from SESSION_SECRET. Keys made before the pepper was set keep working; new keys use the pepper.
 */
async function hashes(env: Env, key: string) {
  const out: { v: "p" | "s"; hash: string }[] = [];
  if (env.API_KEY_PEPPER) out.push({ v: "p", hash: await hmacHex(env.API_KEY_PEPPER, key) });
  out.push({ v: "s", hash: await hmacHex(await hmacHex(env.SESSION_SECRET, "forge-api-key-pepper-v1"), key) });
  return out;
}

/** The API key in an Authorization: Bearer header, if it looks like one of ours. Any other token: null (OAuth path). */
export function bearerKey(headers: Headers): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(headers.get("Authorization") ?? "");
  return m && m[1]!.startsWith(KEY_PREFIX) ? m[1]! : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Plans in effect

export interface SubRow {
  plan: string;
  status: string;
  currentPeriodEnd: number | null;
  endedAt: number | null;
}
const RANK: Record<PlanId, number> = { free: 0, team: 1, volume: 2, enterprise: 3 };
export const RENEWAL_GRACE_MS = 3 * 86_400_000;

/**
 * The plan an owner has now. Active or trialing: until the period end plus 3 days (a renewal webhook may come late).
 * Canceled or past due: until the period end already paid for. Revoked, ended or anything else: nothing. No row: free.
 */
export function effectivePlan(rows: SubRow[], now = Date.now()): PlanId {
  let best: PlanId = "free";
  for (const r of rows) {
    if (!isPlanId(r.plan) || (r.endedAt !== null && r.endedAt <= now)) continue;
    const end = r.currentPeriodEnd;
    const on =
      r.status === "active" || r.status === "trialing"
        ? end === null || end + RENEWAL_GRACE_MS > now
        : r.status === "canceled" || r.status === "past_due"
          ? end !== null && end > now
          : false;
    if (on && RANK[r.plan] > RANK[best]) best = r.plan;
  }
  return best;
}

export async function planOf(env: Env, humanId: string, now = Date.now()): Promise<PlanId> {
  const rows = await getDb(env)
    .select({ plan: t.apiSubscriptions.plan, status: t.apiSubscriptions.status, currentPeriodEnd: t.apiSubscriptions.currentPeriodEnd, endedAt: t.apiSubscriptions.endedAt })
    .from(t.apiSubscriptions)
    .where(eq(t.apiSubscriptions.humanId, humanId));
  return effectivePlan(rows, now);
}

// ---------------------------------------------------------------------------------------------------------------
// Keys

export interface ResolvedKey {
  keyId: string;
  humanId: string;
  plan: PlanId;
}
const keyCache = new Map<string, { at: number; key: ResolvedKey | null }>();

/** A plan change: this isolate re-reads the owner's plan on the next call (others within 30 seconds). */
export function forgetOwner(humanId: string) {
  for (const [h, v] of keyCache) if (v.key?.humanId === humanId) keyCache.delete(h);
}

/** For tests: forget cached keys, month totals and unflushed counts. */
export function resetApiKeyState() {
  keyCache.clear();
  monthCache.clear();
  buffer.clear();
  lastFlush = 0;
}

/** The key's owner and plan, or null when the key is unknown or revoked. Cached per isolate for 30 seconds. */
export async function resolveKey(env: Env, key: string, now = Date.now()): Promise<ResolvedKey | null> {
  if (!KEY_RE.test(key)) return null;
  const hs = await hashes(env, key);
  const primary = hs[0]!.hash;
  const hit = keyCache.get(primary);
  if (hit && now - hit.at < CACHE_MS) return hit.key;
  const row = await getDb(env)
    .select({ id: t.apiKeys.id, humanId: t.apiKeys.humanId, revokedAt: t.apiKeys.revokedAt })
    .from(t.apiKeys)
    .where(inArray(t.apiKeys.hash, hs.map((h) => h.hash)))
    .get();
  const key2 = row && row.revokedAt === null ? { keyId: row.id, humanId: row.humanId, plan: await planOf(env, row.humanId, now) } : null;
  keyCache.set(primary, { at: now, key: key2 });
  return key2;
}

export type CreateKeyResult = { ok: true; key: string; id: string; prefix: string } | { ok: false; reason: "not_verified" | "key_limit" | "name_invalid" | "not_found" };

export async function createKey(env: Env, humanId: string, rawName: string, now = Date.now()): Promise<CreateKeyResult> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name || name.length > KEY_NAME_MAX || /[\u0000-\u001f<>]/.test(name)) return { ok: false, reason: "name_invalid" };
  const db = getDb(env);
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, humanId), columns: { tier: true } });
  if (!human) return { ok: false, reason: "not_found" };
  if (human.tier !== "verified") return { ok: false, reason: "not_verified" };
  const plan = PLANS[await planOf(env, humanId, now)];
  const active = await db.select({ n: sql<number>`count(*)` }).from(t.apiKeys).where(and(eq(t.apiKeys.humanId, humanId), sql`${t.apiKeys.revokedAt} is null`)).get();
  if ((active?.n ?? 0) >= plan.keys) return { ok: false, reason: "key_limit" };
  const key = generateKey();
  const h = (await hashes(env, key))[0]!;
  const id = crypto.randomUUID();
  const prefix = key.slice(0, KEY_SHOWN_PREFIX);
  await db.insert(t.apiKeys).values({ id, humanId, name, prefix, hash: h.hash, hashV: h.v, createdAt: now });
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: "api_key_created", target: `api_key:${id}`, detail: { prefix }, createdAt: now });
  return { ok: true, key, id, prefix };
}

export async function revokeKey(env: Env, humanId: string, keyId: string, now = Date.now()) {
  const db = getDb(env);
  const row = await db.query.apiKeys.findFirst({ where: and(eq(t.apiKeys.id, keyId), eq(t.apiKeys.humanId, humanId)) });
  if (!row || row.revokedAt !== null) return false;
  await db.update(t.apiKeys).set({ revokedAt: now }).where(eq(t.apiKeys.id, keyId));
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: "api_key_revoked", target: `api_key:${keyId}`, createdAt: now });
  // This isolate forgets it at once; other isolates within 30 seconds (the cache's lifetime).
  for (const [h, v] of keyCache) if (h === row.hash || v.key?.keyId === keyId) keyCache.delete(h);
  return true;
}

export async function listKeys(env: Env, humanId: string, now = Date.now()) {
  const db = getDb(env);
  const keys = await db.select().from(t.apiKeys).where(eq(t.apiKeys.humanId, humanId)).orderBy(desc(t.apiKeys.createdAt));
  const month = monthStart(now);
  const used = keys.length
    ? await db
        .select({ keyId: t.apiUsageDaily.keyId, n: sql<number>`sum(${t.apiUsageDaily.n})` })
        .from(t.apiUsageDaily)
        .where(and(eq(t.apiUsageDaily.humanId, humanId), sql`${t.apiUsageDaily.day} >= ${month}`))
        .groupBy(t.apiUsageDaily.keyId)
    : [];
  const byKey = new Map(used.map((u) => [u.keyId, Number(u.n)]));
  for (const b of buffer.values()) if (b.humanId === humanId && b.day >= month) byKey.set(b.keyId, (byKey.get(b.keyId) ?? 0) + b.n);
  return keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, callsThisMonth: byKey.get(k.id) ?? 0 }));
}

// ---------------------------------------------------------------------------------------------------------------
// Metering

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
/** First day of this UTC month, YYYY-MM-DD. */
export const monthStart = (now: number) => `${day(now).slice(0, 7)}-01`;
/** When the monthly quota resets: the first instant of next UTC month (ms). */
export function monthReset(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

interface Pending {
  keyId: string;
  humanId: string;
  day: string;
  n: number;
  n429: number;
}
const buffer = new Map<string, Pending>();
const monthCache = new Map<string, { at: number; month: string; n: number }>();
let lastFlush = 0;

function add(k: ResolvedKey, now: number, served: number, refused: number) {
  const d = day(now);
  const id = `${k.keyId}|${d}`;
  const p = buffer.get(id) ?? { keyId: k.keyId, humanId: k.humanId, day: d, n: 0, n429: 0 };
  p.n += served;
  p.n429 += refused;
  buffer.set(id, p);
}

/** Calls this UTC month across all the owner's keys: D1 (cached 30 s) plus what this isolate hasn't written yet. */
export async function monthUsed(env: Env, humanId: string, now = Date.now()) {
  const month = monthStart(now);
  let c = monthCache.get(humanId);
  if (!c || c.month !== month || now - c.at >= CACHE_MS) {
    const r = await getDb(env)
      .select({ n: sql<number>`coalesce(sum(${t.apiUsageDaily.n}), 0)` })
      .from(t.apiUsageDaily)
      .where(and(eq(t.apiUsageDaily.humanId, humanId), sql`${t.apiUsageDaily.day} >= ${month}`))
      .get();
    c = { at: now, month, n: Number(r?.n ?? 0) };
    monthCache.set(humanId, c);
  }
  let pending = 0;
  for (const p of buffer.values()) if (p.humanId === humanId && p.day >= month) pending += p.n;
  return c.n + pending;
}

/** Writes the buffered counts to D1: one upsert per key and day, plus last_used_at. Returns the rows written. */
export async function flushApiUsage(env: Env, now = Date.now()) {
  lastFlush = now;
  if (!buffer.size) return 0;
  const taken = [...buffer.values()];
  buffer.clear();
  // Counted in the cached month totals at once, so nothing is missed while the write is in flight.
  for (const p of taken) {
    const c = monthCache.get(p.humanId);
    if (c && p.day >= c.month) c.n += p.n;
  }
  const stmts = taken.flatMap((p) => [
    env.DB.prepare(
      "INSERT INTO api_usage_daily (key_id, human_id, day, n, n_429) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key_id, day) DO UPDATE SET n = n + excluded.n, n_429 = n_429 + excluded.n_429",
    ).bind(p.keyId, p.humanId, p.day, p.n, p.n429),
    ...(p.n > 0 ? [env.DB.prepare("UPDATE api_keys SET last_used_at = max(coalesce(last_used_at, 0), ?) WHERE id = ?").bind(now, p.keyId)] : []),
  ]);
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // Put the counts back for the next flush (best effort; an evicted isolate loses at most a few seconds of counts).
    for (const p of taken) {
      add({ keyId: p.keyId, humanId: p.humanId, plan: "free" }, Date.parse(`${p.day}T12:00:00Z`), p.n, p.n429);
      const c = monthCache.get(p.humanId);
      if (c && p.day >= c.month) c.n -= p.n;
    }
    console.error("api_usage_flush_failed", String(e).slice(0, 200));
    return 0;
  }
  return taken.length;
}

function maybeFlush(env: Env, ctx: Pick<ExecutionContext, "waitUntil"> | null, now: number) {
  let calls = 0;
  for (const p of buffer.values()) calls += p.n + p.n429;
  if (ctx && (calls >= FLUSH_CALLS || now - lastFlush >= FLUSH_MS)) ctx.waitUntil(flushApiUsage(env, now));
}

const limiterFor = (env: Env, plan: PlanId): RateLimit => (plan === "free" ? env.KEY_FREE_LIMITER : plan === "team" ? env.KEY_TEAM_LIMITER : env.KEY_VOLUME_LIMITER);

export type LimitReason = "per_ip_minute" | "per_key_minute" | "monthly_quota";

/** Where to get more: data only (AGENTS.md rule 7). Paid plans are "coming_soon" until PRICING_MODE is "paid". */
export function upgradeInfo(env: Env, plan: PlanId | "anonymous") {
  const origin = env.PUBLIC_ORIGIN;
  const higher = PAID_PLAN_IDS.filter((p) => plan === "anonymous" || plan === "free" || RANK[p] > RANK[plan as PlanId]);
  return {
    url: `${origin}${PRICING_PATH}`,
    keys_url: `${origin}${KEYS_PATH}`,
    plans: higher,
    paid_plans: pricingMode(env) === "paid" ? ("available" as const) : ("coming_soon" as const),
    ...(plan === "anonymous" ? { free_key: { per_minute: PLANS.free.perMinute, per_month: PLANS.free.perMonth } } : {}),
    ...(higher.length ? {} : { contact: PRICING_CONTACT }),
  };
}

/** The 429 body for a call without a key. With PRICING_MODE off it is exactly the old body. */
export function anonymousLimited(env: Env) {
  if (pricingMode(env) === "off") return RATE_LIMITED;
  return { ...RATE_LIMITED, reason: "per_ip_minute" as const, limit: { plan: "anonymous" as const, per_minute: ANONYMOUS_PER_MINUTE }, upgrade: upgradeInfo(env, "anonymous") };
}

function keyedLimited(env: Env, plan: Plan, reason: LimitReason, used: number, now: number) {
  const reset = monthReset(now);
  const retry = reason === "monthly_quota" ? Math.max(1, Math.ceil((reset - now) / 1000)) : CHECK_LIMIT_PERIOD_S;
  return {
    error: "rate_limited" as const,
    reason,
    retry_after_s: retry,
    limit: { plan: plan.id, per_minute: plan.perMinute, per_month: plan.perMonth, used_this_month: used, resets_at: new Date(reset).toISOString() },
    upgrade: upgradeInfo(env, plan.id),
  };
}

export type KeyGate =
  | { kind: "anonymous" }
  | { kind: "keyed"; key: ResolvedKey; headers: Record<string, string> }
  | { kind: "refused"; status: 401 | 429; body: Record<string, unknown>; headers: Record<string, string> };

export const invalidKeyBody = (env: Env) => ({ error: "invalid_api_key" as const, docs_url: `${env.PUBLIC_ORIGIN}${PRICING_PATH}`, keys_url: `${env.PUBLIC_ORIGIN}${KEYS_PATH}` });

/**
 * Resolves the caller's key (if any) without metering. `anonymous` for calls without one, and for every call with
 * PRICING_MODE off. Unknown or revoked keys are refused with 401, never served anonymously. A key lookup that misses the
 * cache costs a D1 read, so lookups are limited per IP (60 a minute) against floods of made-up keys.
 */
export async function identifyKey(env: Env, headers: Headers, now = Date.now()): Promise<{ kind: "anonymous" } | { kind: "key"; key: ResolvedKey } | Extract<KeyGate, { kind: "refused" }>> {
  if (pricingMode(env) === "off") return { kind: "anonymous" };
  const token = bearerKey(headers);
  if (!token) return { kind: "anonymous" };
  const primary = KEY_RE.test(token) ? keyCache.get((await hashes(env, token))[0]!.hash) : undefined;
  if (!primary || now - primary.at >= CACHE_MS) {
    const ip = headers.get("CF-Connecting-IP") ?? "unknown";
    const ok = await env.CHECK_LIMITER.limit({ key: `key-lookup:${ip}` }).then((r) => r.success, () => true);
    if (!ok) return { kind: "refused", status: 429, body: anonymousLimited(env) as Record<string, unknown>, headers: { "Retry-After": String(CHECK_LIMIT_PERIOD_S) } };
  }
  const key = await resolveKey(env, token, now);
  if (!key) return { kind: "refused", status: 401, body: invalidKeyBody(env), headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } };
  return { kind: "key", key };
}

/** Counts one keyed call against the key's minute limit and the owner's monthly quota. */
export async function meterKey(env: Env, ctx: Pick<ExecutionContext, "waitUntil"> | null, key: ResolvedKey, now = Date.now()): Promise<KeyGate> {
  const plan = PLANS[key.plan];
  const used = await monthUsed(env, key.humanId, now);
  const reset = Math.floor(monthReset(now) / 1000);
  const quotaHeaders = (u: number): Record<string, string> => ({
    "X-Forge-Plan": plan.id,
    ...(plan.perMonth !== null ? { "X-Forge-Quota-Limit": String(plan.perMonth), "X-Forge-Quota-Remaining": String(Math.max(0, plan.perMonth - u)), "X-Forge-Quota-Reset": String(reset) } : {}),
  });
  if (plan.perMonth !== null && used >= plan.perMonth) {
    add(key, now, 0, 1);
    maybeFlush(env, ctx, now);
    const body = keyedLimited(env, plan, "monthly_quota", used, now);
    return { kind: "refused", status: 429, body, headers: { ...quotaHeaders(used), "Retry-After": String(body.retry_after_s) } };
  }
  const minuteOk = await limiterFor(env, plan.id).limit({ key: `key:${key.keyId}` }).then((r) => r.success, () => true);
  if (!minuteOk) {
    add(key, now, 0, 1);
    maybeFlush(env, ctx, now);
    return { kind: "refused", status: 429, body: keyedLimited(env, plan, "per_key_minute", used, now), headers: { ...quotaHeaders(used), "Retry-After": String(CHECK_LIMIT_PERIOD_S) } };
  }
  add(key, now, 1, 0);
  maybeFlush(env, ctx, now);
  return { kind: "keyed", key, headers: quotaHeaders(used + 1) };
}

/** identifyKey, then meterKey for keyed calls: what every REST check surface runs first. */
export async function keyGate(env: Env, headers: Headers, ctx: Pick<ExecutionContext, "waitUntil"> | null, now = Date.now()): Promise<KeyGate> {
  const id = await identifyKey(env, headers, now);
  if (id.kind !== "key") return id;
  return meterKey(env, ctx, id.key, now);
}

// ---------------------------------------------------------------------------------------------------------------
// Account deletion (Privacy Policy: key records are kept "while your account exists")

/**
 * Deletes an owner's API keys and their daily usage rows. Paid-plan rows in api_subscriptions are kept as tax records
 * (they hold no key data: plan, provider, dates, price and the provider's ids); any other subscription row is deleted.
 * There is no self-service or admin account deletion yet (deletion is by request to hello@, Privacy "Deleting your
 * account"); every deletion path must call this first, since api_keys references humans. Returns what it did.
 */
export async function deleteApiData(env: Env, humanId: string, actor: string, now = Date.now()) {
  const db = getDb(env);
  const keys = await db.select({ id: t.apiKeys.id, hash: t.apiKeys.hash }).from(t.apiKeys).where(eq(t.apiKeys.humanId, humanId));
  const subs = await db.select({ id: t.apiSubscriptions.id, plan: t.apiSubscriptions.plan }).from(t.apiSubscriptions).where(eq(t.apiSubscriptions.humanId, humanId));
  const paid = subs.filter((s) => s.plan === "team" || s.plan === "volume" || s.plan === "enterprise");
  const unpaid = subs.filter((s) => !paid.includes(s));
  // Usage rows first (they reference api_keys), by owner so rows of any key are caught.
  await db.batch([
    db.delete(t.apiUsageDaily).where(eq(t.apiUsageDaily.humanId, humanId)),
    db.delete(t.apiKeys).where(eq(t.apiKeys.humanId, humanId)),
    ...(unpaid.length ? [db.delete(t.apiSubscriptions).where(inArray(t.apiSubscriptions.id, unpaid.map((s) => s.id)))] : []),
    db.insert(t.auditLog).values({
      id: crypto.randomUUID(),
      actor,
      action: "api_data_deleted",
      target: `human:${humanId}`,
      // The kept subscription rows are marked here as tax records; no key, hash or usage data is kept.
      detail: { keys_deleted: keys.length, kept_as_tax_records: paid.map((s) => s.id), subscriptions_deleted: unpaid.length },
      createdAt: now,
    }),
  ]);
  for (const [h, v] of keyCache) if (v.key?.humanId === humanId || keys.some((k) => k.hash === h)) keyCache.delete(h);
  monthCache.delete(humanId);
  for (const [id, p] of buffer) if (p.humanId === humanId) buffer.delete(id);
  return { keysDeleted: keys.length, keptAsTaxRecords: paid.length, subscriptionsDeleted: unpaid.length };
}
