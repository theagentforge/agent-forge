import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { promotePendingClaims } from "../arena/gauntlet-claims";
import { outsidePeople } from "./agent-funnel";
import { getDb, type Db } from "./db";
import { countsAsHouse, WEB_AGENT_PREFIX } from "./identity";
import { bump } from "./usage";
import { agentHref } from "../web/components";

// ADR 0073 (owner acquisition plan, OA-01, OA-06, OA-07). An owner is a verified person outside the project (not House,
// not a founder account) with at least one active agent (services/owner-funnel.ts, services/kpis.ts).
// - OA-01: where owners came from (a fixed `from` tag, first touch, carried through GitHub sign-in) and whether they
//   stay (active in the last 30 days), split into "connected an app" and "web-only". Daily counters
//   (`owner:new:<from>`), written once per person, plus two dates on the person's row. No new personal data.
// - OA-06: claims by people who aren't verified yet wait in pending_claims and count only once they are verified.
// - OA-07: owner numbers (1, 2, 3… by the date someone first became an owner) behind the Founding Owners list.

/** The fixed `from` tags (OA-01). `hackathon:<slug>` is allowed too; anything else is counted as "other". */
export const OWNER_FROM = ["founding", "connect", "plugin", "cli", "action", "clawhub", "skills-sh", "maintainer", "badge", "score", "welcome", "other"] as const;
const HACKATHON = /^hackathon:[a-z0-9][a-z0-9-]{0,39}$/;

/** A tag from a link, as stored: one of OWNER_FROM, `hackathon:<slug>`, "other" for anything unknown, or null when absent. */
export function normalizeFrom(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if ((OWNER_FROM as readonly string[]).includes(v) || HACKATHON.test(v)) return v;
  return "other";
}

/** The `from` of a sign-in: its own `from`, or the `from` in the page it returns to (the claim page passes cli, plugin…). */
export function signInFrom(from: string | undefined, next: string | undefined): string | null {
  if (from) return normalizeFrom(from);
  try {
    const inNext = next ? new URL(next, "https://x.invalid").searchParams.get("from") : null;
    return inNext ? normalizeFrom(inNext) : null;
  } catch {
    return null;
  }
}

/** First touch: keeps the first tag a person ever arrived with; later tags never overwrite it. */
export async function recordFirstFrom(db: Db, humanId: string, from: string | null) {
  if (!from) return;
  await db.update(t.humans).set({ firstFrom: from }).where(and(eq(t.humans.id, humanId), isNull(t.humans.firstFrom)));
}

const hasActiveAgent = sql`exists (select 1 from agents a where a.human_id = ${t.humans.id} and a.status = 'active')`;

/**
 * Brings owner records up to date; safe to run any time and more than once (sign-ins, connections, claims, vouches,
 * approvals and the hourly cron call it):
 * 1. pending claims of people who are verified now become real claims (OA-06);
 * 2. each person who has just become an owner gets `owner_since` and, once ever, `owner:new:<from>` (OA-01);
 * 3. outside owners without a number get the next ones, in the order they became owners (OA-07).
 */
export async function syncOwners(env: Env, now = Date.now()) {
  const db = getDb(env);
  const promoted = await promotePendingClaims(env, now);
  const fresh = await db
    .select({ id: t.humans.id, from: t.humans.firstFrom })
    .from(t.humans)
    .where(and(outsidePeople(env), eq(t.humans.tier, "verified"), isNull(t.humans.ownerSince), hasActiveAgent));
  const counted: string[] = [];
  for (const h of fresh) {
    // Only the call that sets the date counts the person, so two syncs at once can't count anyone twice.
    const set = await db.update(t.humans).set({ ownerSince: now }).where(and(eq(t.humans.id, h.id), isNull(t.humans.ownerSince))).returning({ id: t.humans.id });
    if (set.length) counted.push(`owner:new:${h.from ?? "other"}`);
  }
  if (counted.length) await bump(env, counted, now).catch(() => {});
  const numbered = await numberOwners(env);
  return { promoted, new_owners: counted.length, numbered };
}

/** Gives the next owner numbers to outside owners who have none, oldest first. A number is never changed or reused. */
async function numberOwners(env: Env) {
  const db = getDb(env);
  const waiting = await db
    .select({ id: t.humans.id })
    .from(t.humans)
    .where(and(outsidePeople(env), isNotNull(t.humans.ownerSince), isNull(t.humans.ownerNumber)))
    .orderBy(asc(t.humans.ownerSince), asc(t.humans.createdAt), asc(t.humans.id));
  let n = 0;
  for (const h of waiting) {
    const [top] = await db.select({ max: sql<number | null>`max(${t.humans.ownerNumber})` }).from(t.humans);
    try {
      const done = await db
        .update(t.humans)
        .set({ ownerNumber: Number(top?.max ?? 0) + 1 })
        .where(and(eq(t.humans.id, h.id), isNull(t.humans.ownerNumber)))
        .returning({ id: t.humans.id });
      n += done.length;
    } catch {
      // Another sync took that number at the same moment (unique index); the next sync numbers this person.
      break;
    }
  }
  return n;
}

// --- OA-01: active owners and the split ------------------------------------------------------------------------

export interface OwnerActivity {
  window_days: number;
  owners: number;
  active: number;
  connected: { owners: number; active: number };
  web_only: { owners: number; active: number };
  definition: string;
}

const ACTIVE_DEFINITION =
  "Owners (verified, outside the project, with an active agent) whose agent made at least one signed-in check, filed a report, claimed a Gauntlet run or played a Ranked Ladder bout in the last 30 days. Connected = at least one agent connected through an app (OAuth); web-only = only a website report agent or a profile made when claiming a run.";

/** Owners and active owners over the `days` before `now`, outside the project (or, with `ours`, House and founders). */
export async function ownerActivity(env: Env, now = Date.now(), days = 30, ours = false): Promise<OwnerActivity> {
  const db = getDb(env);
  const since = now - days * 86_400_000;
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: t.humans.id,
      isHouse: t.humans.isHouse,
      githubId: t.humans.githubId,
      connected: sql<number>`max(case when ${t.agents.oauthClientId} like ${`${WEB_AGENT_PREFIX}%`} or ${t.agents.oauthClientId} = 'forge-web' then 0 else 1 end)`,
      active: sql<number>`max(case when exists (select 1 from check_sources c where c.source = ${t.agents.id} and c.day >= ${sinceDay})
        or exists (select 1 from reports r where r.agent_id = ${t.agents.id} and r.created_at >= ${since})
        or exists (select 1 from gauntlet_claims g where g.agent_id = ${t.agents.id} and g.claimed_at >= ${since})
        or exists (select 1 from arena_pg_attempts p where p.agent_id = ${t.agents.id} and p.started_at >= ${since}) then 1 else 0 end)`,
    })
    .from(t.humans)
    .innerJoin(t.agents, and(eq(t.agents.humanId, t.humans.id), eq(t.agents.status, "active")))
    .where(eq(t.humans.tier, "verified"))
    .groupBy(t.humans.id);
  const mine = rows.filter((r) => countsAsHouse(env, r) === ours);
  const conn = mine.filter((r) => Number(r.connected) === 1);
  const web = mine.filter((r) => Number(r.connected) !== 1);
  const act = (xs: typeof mine) => xs.filter((r) => Number(r.active) === 1).length;
  return {
    window_days: days,
    owners: mine.length,
    active: act(mine),
    connected: { owners: conn.length, active: act(conn) },
    web_only: { owners: web.length, active: act(web) },
    definition: ACTIVE_DEFINITION,
  };
}

/** New owners by source (`owner:new:<from>`), over the full UTC days in the window; null when never written. */
export async function ownersBySource(env: Env, now = Date.now(), days = 30) {
  const db = getDb(env);
  const from = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ key: t.usageDaily.key, day: t.usageDaily.day, n: t.usageDaily.n })
    .from(t.usageDaily)
    .where(sql`${t.usageDaily.key} like 'owner:new:%'`);
  const by = (fromDay: string, toDay: string) => {
    const out: Record<string, number> = {};
    for (const r of rows) if (r.day >= fromDay && r.day <= toDay) out[r.key.slice("owner:new:".length)] = (out[r.key.slice("owner:new:".length)] ?? 0) + Number(r.n);
    return out;
  };
  const window = by(from, to);
  const all = by("0000-00-00", "9999-99-99");
  const first = rows.reduce<string | null>((a, r) => (a === null || r.day < a ? r.day : a), null);
  return {
    window: { from, to, days },
    /** Null until the first owner:new counter is written (not yet measured). */
    total: first ? Object.values(window).reduce((a, n) => a + n, 0) : null,
    by_source: window,
    all_time_by_source: all,
    measured_since: first,
  };
}

// --- OA-06: pending claims and the review queue -----------------------------------------------------------------

/** A person's pending claims (private: their dashboard and the claim page only). */
export async function pendingClaimsOf(db: Db, humanId: string) {
  return db
    .select({ id: t.pendingClaims.gauntletId, createdAt: t.pendingClaims.createdAt, summary: t.arenaGauntlets.summary, mode: t.arenaGauntlets.mode })
    .from(t.pendingClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.pendingClaims.gauntletId))
    .where(eq(t.pendingClaims.humanId, humanId))
    .orderBy(asc(t.pendingClaims.createdAt))
    .limit(50);
}

/** "Request a review": only people who aren't verified. Asking again while open does nothing; after a Skip it reopens. */
export async function requestReview(db: Db, humanId: string, now = Date.now()): Promise<"requested" | "already_requested" | "already_verified" | "not_found"> {
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  if (!human) return "not_found";
  if (human.tier === "verified") return "already_verified";
  const existing = await db.query.ownerReviewRequests.findFirst({ where: eq(t.ownerReviewRequests.humanId, humanId) });
  if (existing && existing.decision === null) return "already_requested";
  await db
    .insert(t.ownerReviewRequests)
    .values({ humanId, requestedAt: now })
    .onConflictDoUpdate({ target: t.ownerReviewRequests.humanId, set: { requestedAt: now, decision: null, decidedAt: null } });
  return "requested";
}

/** The founder's weekly queue: open requests only, oldest first, with the GitHub login and account age only. */
export async function reviewQueue(db: Db, now = Date.now()) {
  const rows = await db
    .select({ humanId: t.ownerReviewRequests.humanId, requestedAt: t.ownerReviewRequests.requestedAt, login: t.humans.githubLogin, githubCreatedAt: t.humans.githubCreatedAt })
    .from(t.ownerReviewRequests)
    .innerJoin(t.humans, eq(t.humans.id, t.ownerReviewRequests.humanId))
    .where(isNull(t.ownerReviewRequests.decision))
    .orderBy(asc(t.ownerReviewRequests.requestedAt))
    .limit(200);
  return rows.map((r) => ({
    human_id: r.humanId,
    github_login: r.login,
    account_age_days: Math.max(0, Math.floor((now - r.githubCreatedAt) / 86_400_000)),
    requested_at: new Date(r.requestedAt).toISOString().slice(0, 10),
  }));
}

/** Closes a request with the founder's decision. Approving itself is approveLogin (the caller does it). */
export async function decideReview(db: Db, humanId: string, decision: "approved" | "skipped", now = Date.now()) {
  const done = await db
    .update(t.ownerReviewRequests)
    .set({ decision, decidedAt: now })
    .where(and(eq(t.ownerReviewRequests.humanId, humanId), isNull(t.ownerReviewRequests.decision)))
    .returning({ id: t.ownerReviewRequests.humanId });
  return done.length > 0;
}

// --- OA-07: Founding Owners -----------------------------------------------------------------------------------

/** The first 100 outside owners can join the Founding Owners list. */
export const FOUNDING_LIMIT = 100;

/** Shown where someone joins (its own notice, like the Season entry, ADR 0055 §5). */
export const FOUNDING_NOTICE =
  "If you join the Founding Owners list, your GitHub username, your owner number and a link to your agent's page are shown on the public /founding page, and a \"Founding owner #n\" label on your agent's page and its score pages, until you leave.";

export type FoundingError = "not_an_owner" | "ours" | "number_over_limit";

/** Whether this person can join, and their number. House and founder accounts are refused; so is anyone over #100. */
export async function foundingEligibility(env: Env, humanId: string, opts: { sync?: boolean } = {}): Promise<{ ok: true; number: number } | { ok: false; error: FoundingError }> {
  const db = getDb(env);
  // Only on a POST (joining): a page view never writes (ADR 0073 review: GET /founding ran a full sync per view).
  if (opts.sync) await syncOwners(env).catch(() => {});
  const h = await db.query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  if (!h) return { ok: false, error: "not_an_owner" };
  if (countsAsHouse(env, h)) return { ok: false, error: "ours" };
  if (h.ownerNumber === null || h.tier !== "verified") return { ok: false, error: "not_an_owner" };
  if (h.ownerNumber > FOUNDING_LIMIT) return { ok: false, error: "number_over_limit" };
  return { ok: true, number: h.ownerNumber };
}

export async function joinFounding(env: Env, humanId: string, now = Date.now()) {
  const e = await foundingEligibility(env, humanId, { sync: true });
  if (!e.ok) return e;
  const db = getDb(env);
  const done = await db.update(t.humans).set({ foundingAt: now }).where(and(eq(t.humans.id, humanId), isNull(t.humans.foundingAt))).returning({ id: t.humans.id });
  if (done.length) {
    await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: "founding_joined", target: `owner:${e.number}`, createdAt: now });
    await purgeFoundingPages(env, humanId);
    await purgeOnOpenOrClose(env, "join");
  }
  return e;
}

/** Leaving keeps the number (it is never reused); joining again later shows the same number. */
export async function leaveFounding(env: Env, humanId: string, now = Date.now()) {
  const db = getDb(env);
  const done = await db.update(t.humans).set({ foundingAt: null }).where(and(eq(t.humans.id, humanId), isNotNull(t.humans.foundingAt))).returning({ id: t.humans.id });
  if (done.length) {
    await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: "founding_left", target: `human:${humanId}`, createdAt: now });
    await purgeFoundingPages(env, humanId);
    await purgeOnOpenOrClose(env, "leave");
  }
  return done.length > 0;
}

/**
 * Pages are edge-cached for a minute (web/pages.ts). Drop this data centre's copies of the list's JSON and the person's
 * agent pages, so joining or leaving shows at once here (elsewhere, and on score pages, within the minute).
 */
async function purgeFoundingPages(env: Env, humanId: string) {
  const agents = await getDb(env).select({ handle: t.agents.handle }).from(t.agents).where(eq(t.agents.humanId, humanId)).limit(10);
  const urls = [`${env.PUBLIC_ORIGIN}/founding?format=json`, `${env.PUBLIC_ORIGIN}/founding?format=md`];
  for (const a of agents) {
    const base = `${env.PUBLIC_ORIGIN}${agentHref(a.handle)}`;
    urls.push(base, `${base}?format=json`, `${base}?format=md`, ...ownerShareUrls(env, a.handle));
  }
  await Promise.all(urls.map((u) => caches.default.delete(new Request(u)).catch(() => false)));
}

/**
 * F-02: when a join opens the list (it reaches FOUNDING_LIST_OPENS_AT) or a leave closes it again, every listed
 * owner's badge changes between "Founding owner" and "Founding owner #n", not only the joiner's or leaver's. Drop this
 * data centre's copies of all their pages and cards (elsewhere they lapse within the minute's cache). Returns the
 * number of owners purged (0 when the list neither opened nor closed).
 */
export async function purgeOnOpenOrClose(env: Env, change: "join" | "leave") {
  const list = await foundingList(env);
  const flipped = change === "join" ? list.length === FOUNDING_LIST_OPENS_AT : list.length === FOUNDING_LIST_OPENS_AT - 1;
  if (!flipped) return 0;
  const db = getDb(env);
  const people = await db.select({ id: t.humans.id }).from(t.humans).where(and(isNotNull(t.humans.ownerNumber), sql`${t.humans.ownerNumber} <= ${FOUNDING_LIMIT}`, inArray(t.humans.githubLogin, list.map((o) => o.github))));
  await Promise.all(people.map((p) => purgeFoundingPages(env, p.id)));
  return people.length;
}

/**
 * OA-08 (ADR 0078): the owner share page and card (web/welcome.ts) as the edge cache keys them. Both say "Founding
 * owner #n" only while the owner is on the list, and exist only while the agent is active, so leaving the list or
 * revoking the agent drops them here at once (elsewhere within the minute: both are cached for 60 seconds).
 */
export function ownerShareUrls(env: Pick<Env, "PUBLIC_ORIGIN">, handle: string) {
  const page = `${env.PUBLIC_ORIGIN}/owner/${encodeURIComponent(handle)}`;
  return [page, `${page}?format=json`, `${page}?format=md`, `${env.PUBLIC_ORIGIN}/og/owner/${encodeURIComponent(handle)}.png`];
}

export async function purgeOwnerShare(env: Pick<Env, "PUBLIC_ORIGIN">, handle: string) {
  await Promise.all(ownerShareUrls(env, handle).map((u) => caches.default.delete(new Request(u)).catch(() => false)));
}

/** True when a person's row shows a public Founding owner label: opted in, outside, verified, number 1–100. */
export function foundingNumber(env: Pick<Env, "ADMIN_GITHUB_IDS">, h: Pick<typeof t.humans.$inferSelect, "foundingAt" | "ownerNumber" | "isHouse" | "githubId" | "tier">) {
  if (h.foundingAt === null || h.ownerNumber === null || h.ownerNumber > FOUNDING_LIMIT || h.tier !== "verified" || countsAsHouse(env, h)) return null;
  return h.ownerNumber;
}

/**
 * F-02 (Dinike, 28 Oct; coordinator, B2 follow-up): the /founding list's length is an outside-only count, so the list
 * stays hidden until this many owners have opted in. A "Founding owner #n" number is a rank among outside owners, so
 * it is hidden on every public surface until then too: a plain "Founding owner" badge shows instead. The stored numbers
 * don't change; only the display does.
 */
export const FOUNDING_LIST_OPENS_AT = 10;

/** True once the public /founding list is open (at least FOUNDING_LIST_OPENS_AT opted-in owners). */
export async function foundingListOpen(env: Env) {
  return (await foundingList(env)).length >= FOUNDING_LIST_OPENS_AT;
}

export interface FoundingBadge {
  /** The owner number, or null while the list is closed (the rank would be an outside-only number). */
  number: number | null;
  label: string;
}

/** What a page shows for a founding number: "Founding owner #n" once the list is open, else "Founding owner". */
export const foundingBadge = (n: number | null, open: boolean): FoundingBadge | null =>
  n === null ? null : open ? { number: n, label: `Founding owner #${n}` } : { number: null, label: "Founding owner" };

/** The badge shown for a human id, or null. */
export async function foundingBadgeOf(env: Env, humanId: string) {
  const n = await foundingNumberOf(env, humanId);
  return n === null ? null : foundingBadge(n, await foundingListOpen(env));
}

/** The founding number shown for a human id, or null. */
export async function foundingNumberOf(env: Env, humanId: string) {
  const h = await getDb(env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return h ? foundingNumber(env, h) : null;
}

/** The public list: opted-in outside owners numbered 1–100, by number, with one active agent each (the oldest). */
export async function foundingList(env: Env) {
  const db = getDb(env);
  const rows = await db
    .select({ id: t.humans.id, login: t.humans.githubLogin, number: t.humans.ownerNumber, isHouse: t.humans.isHouse, githubId: t.humans.githubId, tier: t.humans.tier, foundingAt: t.humans.foundingAt, ownerNumber: t.humans.ownerNumber })
    .from(t.humans)
    .where(and(outsidePeople(env), isNotNull(t.humans.foundingAt), isNotNull(t.humans.ownerNumber), sql`${t.humans.ownerNumber} <= ${FOUNDING_LIMIT}`, eq(t.humans.tier, "verified")))
    .orderBy(asc(t.humans.ownerNumber));
  const out = [];
  for (const r of rows) {
    if (foundingNumber(env, r) === null) continue;
    const [agent] = await db
      .select({ handle: t.agents.handle })
      .from(t.agents)
      .where(and(eq(t.agents.humanId, r.id), eq(t.agents.status, "active")))
      .orderBy(asc(t.agents.createdAt))
      .limit(1);
    out.push({ number: r.number!, github: r.login, agent: agent?.handle ?? null });
  }
  return out;
}

// --- OA-08: "You're an owner" (/welcome) ------------------------------------------------------------------------

/** The page someone lands on after they first become an owner (ADR 0078). */
export const WELCOME_PATH = "/welcome";

/** Where to send someone who just became an owner: /welcome, which then offers the page they were going to. */
export const welcomeRedirect = (next: string) => (next && next !== "/dashboard" ? `${WELCOME_PATH}?next=${encodeURIComponent(next)}` : WELCOME_PATH);

/** True when `before` wasn't an owner yet and `after` is: the moment to show /welcome. */
export const becameOwner = (before: { ownerSince: number | null } | null | undefined, after: { ownerSince: number | null } | null | undefined) =>
  !before?.ownerSince && !!after?.ownerSince;

/** The person's own owner row, or null when they aren't an owner (verified, outside the project, with an active agent). */
export async function ownerOf(env: Env, humanId: string) {
  const db = getDb(env);
  const h = await db.query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  if (!h || h.ownerSince === null || h.tier !== "verified" || countsAsHouse(env, h)) return null;
  const agents = await db
    .select({ id: t.agents.id, handle: t.agents.handle, oauthClientId: t.agents.oauthClientId })
    .from(t.agents)
    .where(and(eq(t.agents.humanId, h.id), eq(t.agents.status, "active")))
    .orderBy(asc(t.agents.createdAt));
  return agents.length ? { human: h, agents } : null;
}
