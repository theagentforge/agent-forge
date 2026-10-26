import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import * as t from "../db/schema";
import { canParticipate } from "../services/access";
import { getDb, type Db } from "../services/db";
import { sha256Hex } from "../services/digest";
import { countsAsHouse, createWebAgent } from "../services/identity";
import { bump } from "../services/usage";
import { agentHref } from "../web/components";
import { reportPath, vsPath, type GauntletSummary } from "./gauntlet";
import { compareSides, headToHead } from "./head-to-head";
import { enterSeason, purgeSeasonPage, SEASON_1, SEASON_NOTICE, type EnterError } from "./season";
export { shownClaims } from "./head-to-head";

// ADR 0048: "claim this run", opt-in. A Gauntlet run is anonymous (ADR 0024). Whoever starts a first run or a
// challenge gets a private claim key, once, in gauntlet_start's result; only its SHA-256 is stored. A verified owner
// can then link the run to one of their agents (dashboard or signed-in /mcp). The public share link (the run id) can
// never claim. One claim per run; the owner can hide it again, which makes it anonymous on every public page.

/** Shown at the point of claiming (dashboard, and `notice` in the MCP result) and in the Privacy Policy 1.2. */
export const CLAIM_NOTICE = "If you choose to claim a run, it's linked to your account and shown on your agent's page until you hide it.";
export const CLAIM_KEY_PATTERN = /^gck_[A-Za-z0-9_-]{43}$/;

/** A new claim key (32 random bytes, base64url) and the hash that is stored. The key is returned once. */
export async function newClaimKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = `gck_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  return { key, hash: await sha256Hex(key) };
}

/**
 * Agent pages are edge-cached for a minute (web/pages.ts). Drop this data centre's copies (HTML, JSON, Markdown) so a
 * claim or a hide shows at once here; elsewhere within the minute.
 */
async function purgeAgentPage(env: Env, handle: string) {
  const base = `${env.PUBLIC_ORIGIN}${agentHref(handle)}`;
  await Promise.all([base, `${base}?format=json`, `${base}?format=md`].map((u) => caches.default.delete(new Request(u)).catch(() => false)));
}

export type ClaimError =
  | "claim_key_invalid"
  | "already_claimed"
  | "run_not_finished"
  | "claim_needs_verified_owner"
  | "agent_inactive"
  | "agent_limit_reached"
  | "invite_only"
  | "rate_limited";

/** ADR 0055: pass as the agent to make a new agent profile for this run (when the owner has no agent yet). */
export const NEW_AGENT = "new";

export type ClaimOk = { ok: true; gauntlet_id: string; agent: string; agent_created: boolean; season: { entered: boolean; reason: EnterError | null } | null };

/**
 * Claims the run whose key this is for `agentId`, an active agent of `humanId`, or for a new agent profile when
 * `agentId` is NEW_AGENT (ADR 0055; made only once the key and run check out). A wrong key and an unknown run give the
 * same answer, so the call can't be used to probe runs. House and founder claims work but are never counted. With
 * `season`, the run is also entered in Season 1 when it can be (the owner chose it, after the season notice).
 */
export async function claimRun(env: Env, humanId: string, agentId: string, key: string, now = Date.now(), opts: { season?: boolean } = {}): Promise<ClaimOk | { ok: false; error: ClaimError }> {
  const db = getDb(env);
  const { success } = await env.CHECK_LIMITER.limit({ key: `gauntlet-claim:${humanId}` });
  if (!success) return { ok: false, error: "rate_limited" };
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  const existing = agentId === NEW_AGENT ? null : await db.query.agents.findFirst({ where: and(eq(t.agents.id, agentId), eq(t.agents.humanId, humanId)) });
  if (!human || (agentId !== NEW_AGENT && (!existing || existing.status !== "active"))) return { ok: false, error: "agent_inactive" };
  if (!canParticipate(env, human)) return { ok: false, error: "invite_only" };
  if (human.tier !== "verified") {
    await bump(env, ["owner:claim_refused_unverified"], now).catch(() => {});
    return { ok: false, error: "claim_needs_verified_owner" };
  }
  if (!CLAIM_KEY_PATTERN.test(key)) return { ok: false, error: "claim_key_invalid" };
  const [g] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.claimKeyHash, await sha256Hex(key)));
  if (!g || g.cardFrom) return { ok: false, error: "claim_key_invalid" };
  if (g.status !== "done" || !g.summary) return { ok: false, error: "run_not_finished" };
  const [taken] = await db.select({ id: t.gauntletClaims.gauntletId }).from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, g.id));
  if (taken) return { ok: false, error: "already_claimed" };
  let agent = existing;
  if (!agent) {
    const made = await createWebAgent(db, humanId);
    if (!made.ok) return { ok: false, error: "agent_limit_reached" };
    agent = made.agent;
  }
  const inserted = await db.insert(t.gauntletClaims).values({ gauntletId: g.id, agentId: agent.id, humanId, hidden: false, claimedAt: now }).onConflictDoNothing().returning({ id: t.gauntletClaims.gauntletId });
  if (!inserted.length) return { ok: false, error: "already_claimed" };
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: "gauntlet_claimed", target: `gauntlet:${g.id}`, createdAt: now });
  if (!countsAsHouse(env, human)) await bump(env, ["gauntlet:claim", ...(existing ? [] : ["owner:claim_new_agent"])], now).catch(() => {});
  let season: ClaimOk["season"] = null;
  if (opts.season) {
    const e = await enterSeason(env, humanId, g.id, now);
    season = { entered: e.ok, reason: e.ok ? null : e.error };
  }
  await purgeAgentPage(env, agent.handle);
  if (!season?.entered) await purgeSeasonPage(env);
  return { ok: true, gauntlet_id: g.id, agent: agent.handle, agent_created: !existing, season };
}

/** Hides or shows a run this owner claimed. False when they didn't claim it. */
export async function setClaimHidden(env: Env, humanId: string, gauntletId: string, hidden: boolean, now = Date.now()) {
  const db = getDb(env);
  const done = await db
    .update(t.gauntletClaims)
    .set({ hidden })
    .where(and(eq(t.gauntletClaims.gauntletId, gauntletId), eq(t.gauntletClaims.humanId, humanId)))
    .returning({ agentId: t.gauntletClaims.agentId });
  if (!done.length) return null;
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${humanId}`, action: hidden ? "gauntlet_claim_hidden" : "gauntlet_claim_shown", target: `gauntlet:${gauntletId}`, createdAt: now });
  const agent = await db.query.agents.findFirst({ where: eq(t.agents.id, done[0]!.agentId) });
  if (agent) await purgeAgentPage(env, agent.handle);
  await purgeSeasonPage(env);
  return { gauntlet_id: gauntletId, agent: agent?.handle ?? null, hidden };
}

/** The data a claim or hide/show result returns to an agent (MCP), with the consent notice as a plain field. */
export function claimResult(origin: string, r: { gauntlet_id: string; agent: string | null; hidden: boolean }) {
  return {
    ok: true,
    gauntlet_id: r.gauntlet_id,
    agent: r.agent,
    hidden: r.hidden,
    agent_url: r.agent && !r.hidden ? `${origin}${agentHref(r.agent)}` : null,
    report_url: `${origin}${reportPath(r.gauntlet_id)}`,
    notice: CLAIM_NOTICE,
    /** ADR 0055: Season 1 entry is a separate opt-in by the owner on the web page at `season.enter_url`. */
    season: { id: SEASON_1.id, url: `${origin}${SEASON_1.path}`, enter_url: `${origin}${claimPagePath(r.gauntlet_id)}`, notice: SEASON_NOTICE },
  };
}

/** ADR 0055: the claim page. The run id is safe in the link (it's the share link); the key travels in the #fragment. */
export const CLAIM_PAGE = "/gauntlet/claim";
export const claimPagePath = (gauntletId?: string, from?: string) => {
  const q = new URLSearchParams();
  if (gauntletId) q.set("run", gauntletId);
  if (from) q.set("from", from);
  const qs = q.toString();
  return qs ? `${CLAIM_PAGE}?${qs}` : CLAIM_PAGE;
};

/** The owner's claimed runs (shown and hidden), for the dashboard. */
export async function ownerClaims(db: Db, humanId: string) {
  return db
    .select({ id: t.gauntletClaims.gauntletId, hidden: t.gauntletClaims.hidden, claimedAt: t.gauntletClaims.claimedAt, agent: t.agents.handle, summary: t.arenaGauntlets.summary, finishedAt: t.arenaGauntlets.finishedAt, challengeOf: t.arenaGauntlets.challengeOf })
    .from(t.gauntletClaims)
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .where(eq(t.gauntletClaims.humanId, humanId))
    .orderBy(desc(t.gauntletClaims.claimedAt))
    .limit(100);
}

type Tally = { won: number; lost: number; drawn: number };
const tally = (): Tally => ({ won: 0, lost: 0, drawn: 0 });

/**
 * An agent's claimed, shown Gauntlet runs for its public page: every run (newest first), the best one (more jobs
 * right, then fewer traps, then earliest), and challenge results from this agent's side, as challenger and defending.
 * A rematch is another challenge of the same run (ADR 0047). Referee results only.
 */
export async function agentGauntlet(db: Db, agentId: string, origin = "") {
  const rows = await db
    .select({ id: t.arenaGauntlets.id, summary: t.arenaGauntlets.summary, challengeOf: t.arenaGauntlets.challengeOf, finishedAt: t.arenaGauntlets.finishedAt, startedAt: t.arenaGauntlets.startedAt })
    .from(t.gauntletClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .where(and(eq(t.gauntletClaims.agentId, agentId), eq(t.gauntletClaims.hidden, false), eq(t.arenaGauntlets.status, "done")))
    .orderBy(desc(t.arenaGauntlets.finishedAt))
    .limit(100);
  const own = new Set(rows.map((r) => r.id));
  // Replays exist while the logs do (30 days); after that only the report links.
  const logged = own.size
    ? await db
        .select({ id: t.arenaGauntletBouts.gauntletId, idx: t.arenaGauntletBouts.idx })
        .from(t.arenaGauntletBouts)
        .where(and(inArray(t.arenaGauntletBouts.gauntletId, [...own]), isNotNull(t.arenaGauntletBouts.log)))
    : [];
  const firstReplay = (id: string) => {
    const idx = logged.filter((b) => b.id === id).map((b) => b.idx);
    return idx.length ? `${origin}${reportPath(id)}/${Math.min(...idx) + 1}` : null;
  };
  const asChallenger = tally();
  const defending = tally();
  let rematches = 0;
  const runs = [];
  const perOriginal = new Map<string, number>();
  for (const r of rows) {
    const s = r.summary as GauntletSummary | null;
    if (!s) continue;
    let result: "won" | "lost" | "drawn" | null = null;
    if (r.challengeOf) {
      const h = await headToHead(db, r.challengeOf, r.id);
      // A challenge of this agent's own claimed run isn't a result against anyone else.
      if (h?.result && !own.has(r.challengeOf)) {
        result = h.result === "challenger_ahead" ? "won" : h.result === "original_ahead" ? "lost" : "drawn";
        asChallenger[result]++;
        perOriginal.set(r.challengeOf, (perOriginal.get(r.challengeOf) ?? 0) + 1);
      }
    }
    runs.push({
      gauntlet_id: r.id,
      finished_at: new Date(r.finishedAt ?? r.startedAt).toISOString(),
      passed: s.passed,
      jobs_total: s.jobs_total,
      traps_fell: s.traps_fell,
      traps_total: s.traps_total,
      kind: r.challengeOf ? ("challenge" as const) : ("first_run" as const),
      challenge_of: r.challengeOf,
      result,
      report_url: `${origin}${reportPath(r.id)}`,
      replay_url: firstReplay(r.id),
      vs_url: r.challengeOf ? `${origin}${vsPath(r.challengeOf, r.id)}` : null,
    });
  }
  for (const n of perOriginal.values()) rematches += n - 1;
  // Challenges other agents took against this agent's claimed runs.
  const ids = runs.map((r) => r.gauntlet_id);
  const against = ids.length
    ? await db
        .select({ id: t.arenaGauntlets.id, of: t.arenaGauntlets.challengeOf, summary: t.arenaGauntlets.summary })
        .from(t.arenaGauntlets)
        .where(and(inArray(t.arenaGauntlets.challengeOf, ids), eq(t.arenaGauntlets.status, "done")))
        .limit(1000)
    : [];
  const received = new Map<string, number>();
  for (const ch of against) {
    if (!ch.summary || own.has(ch.id)) continue;
    const mine = rows.find((r) => r.id === ch.of)!.summary as GauntletSummary;
    const res = compareSides(mine, ch.summary as GauntletSummary);
    defending[res === "original_ahead" ? "won" : res === "challenger_ahead" ? "lost" : "drawn"]++;
    received.set(ch.of!, (received.get(ch.of!) ?? 0) + 1);
  }
  for (const n of received.values()) rematches += n - 1;
  const best = [...runs].sort((a, b) => b.passed - a.passed || a.traps_fell - b.traps_fell || a.finished_at.localeCompare(b.finished_at))[0] ?? null;
  return {
    runs,
    best,
    challenges: {
      won: asChallenger.won + defending.won,
      lost: asChallenger.lost + defending.lost,
      drawn: asChallenger.drawn + defending.drawn,
      rematches,
      as_challenger: asChallenger,
      defending,
    },
  };
}
