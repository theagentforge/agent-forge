import { Attempt, DEFAULT_CAPS, freshBoutSeed, publicTrapId, TASKS, type AttemptResult, type CallRecord } from "@forge/arena";
import { provenance } from "../services/provenance";
import { TRAP_CARD_DATE, TRAP_CARD_VERSION, TRAP_CHECKS } from "@forge/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import { isLean } from "../services/ops-mode";
import { day, sourceHash } from "../services/proof";
import { HEADLINE } from "./lineup";
import { claimPagePath, newClaimKey } from "./gauntlet-claims";
import { ensureSeason, SEASON_1, seasonEligibility } from "./season";
import { bump as bumpUsage } from "../services/usage";
import { modelName, notEmbargoed } from "./views";

// The Gauntlet (ADR 0024): the six everyday jobs in a row, for any agent, with no account. The server only referees:
// it rebuilds each sandbox by replaying the stored calls, so a run costs D1 writes and no model. At the end the agent
// gets a report card and a trap card made from the traps it fell for. A re-run with `card_from` plays six new variants
// with that card at the top of every brief, so the before/after is measured on the user's own agent, not promised.
// Agents never get the trap names in advance (headline models don't either), so results compare with the Arena's.

export const GAUNTLET_TIME_LIMIT_MS = 2 * 60 * 60_000;
/** Starts per visitor per day (one-day code, never the IP) and for everyone per day: soft caps against abuse. */
export const GAUNTLET_DAILY_PER_SOURCE = 10;
export const GAUNTLET_DAILY_TOTAL = 3000;
/** Tool calls and logs are deleted after this; the summary (pass/fail and traps per job) stays. */
export const GAUNTLET_KEEP_LOGS_MS = 30 * 86_400_000;
export const JOBS = TASKS;

type G = typeof t.arenaGauntlets.$inferSelect;
type B = typeof t.arenaGauntletBouts.$inferSelect;

export interface GauntletJob {
  idx: number;
  task: string;
  title: string;
  passed: boolean;
  reason: string;
  quality: number;
  traps: { id: string; public_id: string | null; label: string; triggered: boolean }[];
}
export interface GauntletSummary {
  jobs: GauntletJob[];
  passed: number;
  jobs_total: number;
  traps_fell: number;
  traps_total: number;
  /** "task/trap" keys of the traps it fell for. */
  fell: string[];
}

const newGauntletId = () => `g${crypto.randomUUID().replace(/-/g, "")}`;
const newSeed = () => freshBoutSeed();
export const reportPath = (id: string) => `/gauntlet/r/${id}`;
/** V2 (ADR 0047): the head-to-head page of a challenge: the run it challenged, then the challenger. */
export const vsPath = (original: string, challenger: string) => `/gauntlet/vs/${original}/${challenger}`;
export const challengePath = (target: string) => `/gauntlet/challenge/${target}`;
/** What `challenge` takes: a gauntlet id, or `model:<id>` for a headline model's stored ranked runs. */
export const CHALLENGE_PATTERN = /^(g[0-9a-f]{32}|model:[a-z0-9][a-z0-9.-]{0,63})$/;
export type ChallengeInfo = { seeds: number[]; runs?: (string | null)[] };

/** The seed for job `idx`: the challenged run's seed when this run is a challenge, otherwise a fresh one. */
const seedAt = (g: Pick<G, "challenge">, idx: number) => (g.challenge as ChallengeInfo | null)?.seeds[idx] ?? newSeed();

export interface Opponent {
  model: string;
  name: string;
  /** The newest stored ranked run on each Gauntlet job, in job order. */
  runs: { idx: number; runId: string; seed: number; result: AttemptResult; finishedAt: number }[];
}

/**
 * Standing opponents (V2): headline models (not embargoed or retired) with a stored ranked run on every Gauntlet job.
 * Only card and guest events with no Lab arm and no twist, past any embargo: those used the same task code, seed and
 * default caps as the Gauntlet, so a challenger plays the identical sandbox. Reads stored runs only; never starts a bout.
 */
export async function standingOpponents(db: Db, now = Date.now(), only?: string): Promise<Opponent[]> {
  const ids = HEADLINE.filter((m) => !m.retired && !m.embargoed && (!only || m.id === only)).map((m) => m.id);
  if (!ids.length) return [];
  const rows = await db
    .select({ id: t.arenaRuns.id, model: t.arenaRuns.modelId, task: t.arenaRuns.task, seed: t.arenaRuns.seed, result: t.arenaRuns.result, finishedAt: t.arenaRuns.finishedAt })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(
      and(
        eq(t.arenaRuns.status, "done"),
        isNotNull(t.arenaRuns.finishedAt),
        isNotNull(t.arenaRuns.result),
        inArray(t.arenaEvents.kind, ["card", "guest"]),
        isNull(t.arenaEvents.arm),
        // No twist: null, or an empty string from a plan written with `"twist": ""` (planSchema accepts it).
        sql`coalesce(${t.arenaEvents.twist}, '') = ''`,
        // Normal tier only: exactly the six Gauntlet job ids (Hard and Hard v3 ids differ and have other caps).
        inArray(t.arenaRuns.task, JOBS.map((j) => j.id)),
        inArray(t.arenaRuns.modelId, ids),
        notEmbargoed(now),
      ),
    )
    .orderBy(desc(t.arenaRuns.finishedAt))
    .limit(5000);
  return ids.flatMap((model) => {
    const runs = JOBS.map((job, idx) => {
      const r = rows.find((x) => x.model === model && x.task === job.id);
      return r ? { idx, runId: r.id, seed: r.seed, result: r.result as AttemptResult, finishedAt: r.finishedAt! } : null;
    });
    if (runs.every((r) => r)) return [{ model, name: modelName(model), runs: runs as Opponent["runs"] }];
    // Logged so an empty list on /gauntlet can be explained from the Worker logs, not guessed at (24 Oct).
    if (rows.length) console.warn("gauntlet: no standing opponent", model, "missing", JOBS.filter((_, i) => !runs[i]).map((j) => j.id).join(","));
    return [];
  });
}

/** The six seeds (and, for a model, the run ids) a challenge plays, or why it can't be played. */
async function challengeFor(db: Db, target: string, now: number): Promise<ChallengeInfo | { error: "unknown_run" | "unknown_opponent" | "run_not_finished" | "challenge_needs_first_run" }> {
  if (target.startsWith("model:")) {
    const [o] = await standingOpponents(db, now, target.slice("model:".length));
    if (!o) return { error: "unknown_opponent" };
    return { seeds: o.runs.map((r) => r.seed), runs: o.runs.map((r) => r.runId) };
  }
  const [parent] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, target));
  if (!parent) return { error: "unknown_run" };
  if (parent.status !== "done") return { error: "run_not_finished" };
  // A measured re-run had the trap card in every brief, so a challenge of it wouldn't be like for like.
  if (parent.cardFrom) return { error: "challenge_needs_first_run" };
  const bouts = await db.select({ idx: t.arenaGauntletBouts.idx, seed: t.arenaGauntletBouts.seed }).from(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, target));
  // A job the challenged run never reached (time ran out) gets a fresh seed: there's nothing on it to match.
  return { seeds: JOBS.map((_, i) => bouts.find((b) => b.idx === i)?.seed ?? newSeed()) };
}

function replay(b: Pick<B, "task" | "seed" | "calls">) {
  const task = JOBS.find((x) => x.id === b.task)!;
  let clock = 0;
  const a = new Attempt(task, b.seed, { caps: DEFAULT_CAPS, now: () => (clock += 1000) });
  for (const c of b.calls as CallRecord[]) a.call(c.name, c.args);
  return a;
}

/**
 * The trap card for one agent: the published checks, with the ones for traps it fell for first. Same wording as the
 * public card (no new claims), so its effect can be read against Forge Lab #3.
 */
export function tailoredCard(fell: string[], runId: string): string {
  const hit = new Set(fell);
  const first = TRAP_CHECKS.filter((c) => c.traps.some((k) => hit.has(k)));
  const rest = TRAP_CHECKS.filter((c) => !first.includes(c));
  const head = `Checks for my AI agent (Forge trap card v${TRAP_CARD_VERSION}, ${TRAP_CARD_DATE}, tailored from Gauntlet run ${runId.slice(1, 9)}):`;
  if (!first.length) return [head, ...rest.map((c) => `- ${c.text}`)].join("\n");
  return [head, "Most important (it slipped on these):", ...first.map((c) => `- ${c.text}`), "Also:", ...rest.map((c) => `- ${c.text}`)].join("\n");
}

/** The job an agent sees. On a measured re-run, the card comes first, the way a user's standing instructions would. */
function jobPayload(g: Pick<G, "id" | "card" | "cardFrom">, b: Pick<B, "idx" | "task" | "seed" | "calls">) {
  const a = replay(b);
  const brief = g.cardFrom && g.card ? `Your owner's standing instructions:\n${g.card}\n\nThe job:\n${a.variant.brief}` : a.variant.brief;
  return {
    job: b.idx + 1,
    of: JOBS.length,
    task: b.task,
    title: a.task.title,
    brief,
    tools: a.toolSpecs(),
    limits: { tool_calls: a.caps.toolCalls, tool_calls_left: a.caps.toolCalls - (b.calls as CallRecord[]).length },
  };
}

async function sourceCount(env: Env, ip: string, now: number) {
  const d = day(now);
  const code = await sourceHash(env.SESSION_SECRET, d, `gauntlet|${ip}`);
  return { mine: `gauntlet-src:${d}:${code}`, all: `gauntlet-all:${d}` };
}

async function bump(env: Env, key: string) {
  const n = Number((await env.KV.get(key)) ?? 0) + 1;
  await env.KV.put(key, String(n), { expirationTtl: 2 * 86_400 });
  return n;
}

export async function startGauntlet(env: Env, ip: string, opts: { cardFrom?: string; challenge?: string } = {}, now = Date.now()) {
  const db = getDb(env);
  if (opts.cardFrom && opts.challenge) return { error: "challenge_with_card_from" as const };
  if (await isLean(env)) return { error: "busy_today" as const };
  const { success } = await env.CHECK_LIMITER.limit({ key: `gauntlet:${ip}` });
  if (!success) return { error: "rate_limited" as const };
  const keys = await sourceCount(env, ip, now);
  if (Number((await env.KV.get(keys.all)) ?? 0) >= GAUNTLET_DAILY_TOTAL) return { error: "busy_today" as const };
  if (Number((await env.KV.get(keys.mine)) ?? 0) >= GAUNTLET_DAILY_PER_SOURCE) return { error: "daily_limit" as const, limit: GAUNTLET_DAILY_PER_SOURCE };

  let card: string | null = null;
  if (opts.cardFrom) {
    const [parent] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, opts.cardFrom));
    if (!parent || parent.cardFrom) return { error: "unknown_run" as const };
    if (parent.status !== "done" || !parent.card) return { error: "run_not_finished" as const };
    card = parent.card;
  }
  let challenge: ChallengeInfo | null = null;
  if (opts.challenge) {
    const ch = await challengeFor(db, opts.challenge, now);
    if ("error" in ch) return { error: ch.error };
    challenge = ch;
  }
  await bump(env, keys.all);
  await bump(env, keys.mine);

  const id = newGauntletId();
  // ADR 0048: a private claim key for first runs and challenges (not measured re-runs). Only its hash is stored, so
  // this result is the only place it ever appears; the run id (the share link) can't claim.
  const claim = opts.cardFrom ? null : await newClaimKey();
  await db.insert(t.arenaGauntlets).values({ id, status: "open", cardFrom: opts.cardFrom ?? null, card, current: 0, startedAt: now, challengeOf: opts.challenge ?? null, challenge, claimKeyHash: claim?.hash ?? null });
  const first = { id: crypto.randomUUID(), gauntletId: id, idx: 0, task: JOBS[0]!.id, seed: seedAt({ challenge }, 0), calls: [], status: "open" as const, startedAt: now };
  await db.insert(t.arenaGauntletBouts).values(first);
  return {
    gauntlet_id: id,
    measured_rerun_of: opts.cardFrom ?? null,
    /** V2: the run (or `model:<id>`) whose identical jobs this run plays, and the head-to-head page once both are done. */
    challenge_of: opts.challenge ?? null,
    ...(opts.challenge ? { vs_url: `${env.PUBLIC_ORIGIN}${vsPath(opts.challenge, id)}` } : {}),
    jobs: JOBS.map((x) => x.id),
    time_limit_minutes: GAUNTLET_TIME_LIMIT_MS / 60_000,
    report_url: reportPath(id),
    /**
     * ADR 0048 (opt-in): the private key that links this run to an agent's public page, once it's finished. Shown only
     * here; null for a measured re-run. Unused, the run stays anonymous.
     */
    claim_key: claim?.key ?? null,
    claim: claim
      ? {
          private: true,
          shown_once: true,
          optional: true,
          where: [`${env.PUBLIC_ORIGIN}/dashboard`, "gauntlet_claim on the signed-in MCP server /mcp"],
          not_the_share_link: true,
          /** ADR 0055: the claim page with this key in the #fragment (never sent to the server); as private as the key. */
          url: `${env.PUBLIC_ORIGIN}${claimPagePath(id)}#${claim.key}`,
          url_contains_key: true,
        }
      : null,
    how: "Call gauntlet_act with this gauntlet_id, a tool name from `tools` and its arguments. Call the job's `finish` tool when a job is done or can't be done; the next job follows.",
    current: jobPayload({ id, card, cardFrom: opts.cardFrom ?? null }, first),
  };
}

async function load(db: Db, id: string) {
  const [g] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, id));
  if (!g) return null;
  const [b] = await db.select().from(t.arenaGauntletBouts).where(and(eq(t.arenaGauntletBouts.gauntletId, id), eq(t.arenaGauntletBouts.idx, g.current)));
  return { g, b: b ?? null };
}

export async function gauntletAct(env: Env, id: string, tool: string, args: unknown, now = Date.now()) {
  const db = getDb(env);
  const { success } = await env.CHECK_LIMITER.limit({ key: `gauntlet-act:${id}` });
  if (!success) return { error: "rate_limited" as const };
  const got = await load(db, id);
  if (!got) return { error: "not_found" as const };
  let { g, b } = got;
  if (g.status === "done" || !b) return { error: "gauntlet_over" as const, report: await reportOf(env, g) };
  if (now - g.startedAt > GAUNTLET_TIME_LIMIT_MS) {
    g = await finishAll(env, g, b, now);
    return { error: "gauntlet_over" as const, reason: "time_limit", report: await reportOf(env, g) };
  }
  const a = replay(b);
  const out = a.call(tool, args);
  const calls = [...(b.calls as CallRecord[]), { name: tool, args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>, ok: out.ok }];
  if (!a.done) {
    await db.update(t.arenaGauntletBouts).set({ calls }).where(eq(t.arenaGauntletBouts.id, b.id));
    return { ok: out.ok, result: safeParse(out.content), tool_calls_left: a.caps.toolCalls - calls.length };
  }
  const verdict = await closeBout(db, { ...b, calls }, a.result!, a, now);
  if (b.idx + 1 < JOBS.length) {
    const next = { id: crypto.randomUUID(), gauntletId: g.id, idx: b.idx + 1, task: JOBS[b.idx + 1]!.id, seed: seedAt(g, b.idx + 1), calls: [], status: "open" as const, startedAt: now };
    await db.insert(t.arenaGauntletBouts).values(next);
    await db.update(t.arenaGauntlets).set({ current: next.idx }).where(eq(t.arenaGauntlets.id, g.id));
    return { ok: out.ok, result: safeParse(out.content), job_verdict: verdict, next: jobPayload(g, next) };
  }
  g = await finalize(env, g, now);
  return { ok: out.ok, result: safeParse(out.content), job_verdict: verdict, report: await reportOf(env, g) };
}

export async function gauntletStatus(env: Env, id: string, now = Date.now()) {
  const db = getDb(env);
  const got = await load(db, id);
  if (!got) return { error: "not_found" as const };
  let { g, b } = got;
  if (g.status === "open" && b && now - g.startedAt > GAUNTLET_TIME_LIMIT_MS) g = await finishAll(env, g, b, now);
  if (g.status === "done" || !b) return { status: "done" as const, report: await reportOf(env, g) };
  return { status: "open" as const, current: jobPayload(g, b) };
}

const verdictOf = (r: AttemptResult) => ({ passed: r.passed, reason: r.reason, traps_fell: r.traps.filter((x) => x.triggered).length, traps_total: r.traps.length });

/**
 * ADR 0048/0055: a claim key an agent echoed into a tool call (it has the key, and claim.url carries it) would otherwise
 * sit in the public replay of that job, and anyone reading it could claim the run first. Stored calls and logs of a
 * finished job have any claim key blanked out.
 */
const CLAIM_KEY_ANYWHERE = /gck_[A-Za-z0-9_-]{43}/g;
export const redactClaimKeys = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v).replace(CLAIM_KEY_ANYWHERE, "gck_[redacted]")) as T));

async function closeBout(db: Db, b: B, result: AttemptResult, a: Attempt, now: number) {
  await db
    .update(t.arenaGauntletBouts)
    .set({ status: "done", calls: redactClaimKeys(b.calls), passed: result.passed, result: redactClaimKeys(result), log: redactClaimKeys(a.log), finishedAt: now })
    .where(eq(t.arenaGauntletBouts.id, b.id));
  return verdictOf(result);
}

/** Time ran out: the open job ends as a time knockout, and jobs never reached count as not passed. */
async function finishAll(env: Env, g: G, b: B, now: number) {
  const a = replay(b);
  const result = a.done ? a.result! : a.end("knockout_time");
  await closeBout(getDb(env), b, result, a, now);
  return finalize(env, g, now);
}

async function finalize(env: Env, g: G, now: number): Promise<G> {
  const db = getDb(env);
  const bouts = await db.select().from(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, g.id)).orderBy(asc(t.arenaGauntletBouts.idx));
  const summary = summarise(bouts);
  // The first run gets its own card; a measured re-run keeps the card it was given.
  const card = g.cardFrom ? g.card : tailoredCard(summary.fell, g.id);
  await db.update(t.arenaGauntlets).set({ status: "done", summary, card, finishedAt: now }).where(eq(t.arenaGauntlets.id, g.id));
  // ADR 0055 owner funnel: a finished run, and whether its end-of-run result carried a claim link (claimable runs).
  await bumpUsage(env, ["owner:run_finished", ...(g.claimKeyHash && !g.cardFrom ? ["owner:claim_link_shown"] : [])], now).catch(() => {});
  return { ...g, status: "done", summary, card, finishedAt: now };
}

export function summarise(bouts: Pick<B, "idx" | "task" | "result">[]): GauntletSummary {
  const jobs: GauntletJob[] = JOBS.map((task, idx) => {
    const r = bouts.find((x) => x.idx === idx)?.result as AttemptResult | null | undefined;
    return {
      idx,
      task: task.id,
      title: task.title,
      passed: r?.passed ?? false,
      reason: r?.reason ?? "not_reached",
      quality: r?.quality ?? 0,
      traps: (r?.traps ?? []).map((x) => ({ id: x.id, public_id: publicTrapId(task.id, x.id), label: x.label, triggered: x.triggered })),
    };
  });
  const all = jobs.flatMap((j) => j.traps.map((x) => ({ ...x, task: j.task })));
  return {
    jobs,
    passed: jobs.filter((j) => j.passed).length,
    jobs_total: jobs.length,
    traps_fell: all.filter((x) => x.triggered).length,
    traps_total: all.length,
    fell: all.filter((x) => x.triggered).map((x) => `${x.task}/${x.id}`),
  };
}

async function reportOf(env: Env, g: G) {
  const origin = env.PUBLIC_ORIGIN;
  const s = g.summary as GauntletSummary | null;
  if (!s) return null;
  const db = getDb(env);
  // ADR 0055: claim status and link, and the season, as data. The claim key itself is never here (ADR 0048).
  const [claimed] = await db.select({ hidden: t.gauntletClaims.hidden }).from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, g.id));
  const claimable = !!g.claimKeyHash && !g.cardFrom;
  const claimStatus = claimed ? ("claimed" as const) : claimable ? ("unclaimed" as const) : ("not_claimable" as const);
  const season = await ensureSeason(db);
  const why = seasonEligibility(g, season);
  const when = new Date(g.finishedAt ?? g.startedAt).toISOString().slice(0, 10);
  return {
    report_url: reportPath(g.id),
    /** The public report and a factual one-line summary of it (data, for a post or README; conversion review 24 Oct). */
    share: {
      url: `${origin}${reportPath(g.id)}`,
      summary: `Forge Gauntlet, ${when}: passed ${s.passed} of ${s.jobs_total} everyday jobs; fell for ${s.traps_fell} of ${s.traps_total} planted traps${g.cardFrom ? " (re-run with the trap card)" : ""}.`,
    },
    passed: s.passed,
    jobs_total: s.jobs_total,
    traps_fell: s.traps_fell,
    traps_total: s.traps_total,
    fell_for: s.jobs.flatMap((j) => j.traps.filter((x) => x.triggered).map((x) => x.public_id ?? `${j.task}/${x.id}`)),
    measured_rerun_of: g.cardFrom,
    /** V2: the run this one challenged, and the head-to-head page (data). */
    challenge_of: g.challengeOf ?? null,
    vs_url: g.challengeOf ? `${origin}${vsPath(g.challengeOf, g.id)}` : null,
    /** V3: the web page where someone else's agent can take on this run's exact jobs (a link for people; data here). */
    challenge_url: g.cardFrom ? null : `${origin}${challengePath(g.id)}`,
    /**
     * ADR 0055: "unclaimed" (claim_url opens the claim page; it asks for this run's claim_key from gauntlet_start, or
     * use claim.url from gauntlet_start, which has the key), "claimed", or "not_claimable" (a measured re-run or an
     * older run without a key).
     */
    claim_status: claimStatus,
    claim_url: claimStatus === "unclaimed" ? `${origin}${claimPagePath(g.id)}` : null,
    claim_key_from: claimStatus === "unclaimed" ? "gauntlet_start" : null,
    season: { id: SEASON_1.id, url: `${origin}${SEASON_1.path}`, eligible: why === null, not_eligible_because: why },
    trap_card: g.cardFrom ? null : g.card,
    /** ADR 0053: where this record came from and its licence (no model is recorded for a Gauntlet run). */
    provenance: provenance("gauntlet", g.finishedAt ?? g.startedAt),
    next: g.cardFrom
      ? "Compare with the first run on report_url."
      : "To measure the trap card on this agent, call gauntlet_start with card_from set to this gauntlet_id: six new variants with the card at the top of every brief.",
  };
}

const safeParse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export async function gauntletRun(db: Db, id: string) {
  const [g] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, id));
  if (!g) return null;
  const bouts = await db.select().from(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, id)).orderBy(asc(t.arenaGauntletBouts.idx));
  const parent = g.cardFrom ? ((await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, g.cardFrom)))[0] ?? null) : null;
  const [rerun] = g.cardFrom
    ? []
    : await db
        .select()
        .from(t.arenaGauntlets)
        .where(and(eq(t.arenaGauntlets.cardFrom, id), eq(t.arenaGauntlets.status, "done")))
        .orderBy(asc(t.arenaGauntlets.finishedAt))
        .limit(1);
  return { g, bouts, parent, rerun: rerun ?? null };
}

/** Hourly: deletes tool calls and logs older than GAUNTLET_KEEP_LOGS_MS. The per-job summary stays. */
export async function sweepGauntletLogs(env: Env, now = Date.now()) {
  const res = await getDb(env)
    .update(t.arenaGauntletBouts)
    .set({ calls: [], log: null })
    .where(and(lt(t.arenaGauntletBouts.startedAt, now - GAUNTLET_KEEP_LOGS_MS), sql`(${t.arenaGauntletBouts.log} is not null or ${t.arenaGauntletBouts.calls} != '[]')`));
  return { cleared: res.meta?.changes ?? 0 };
}
