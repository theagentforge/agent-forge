import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { newId, type Db } from "./db";
import { rescoreToolVersion } from "./forge";

// Humans and agents (MASTER_PLAN §6.6, as amended by ADR 0003).
// We keep only GitHub's numeric id, login and account creation date.

export const MAX_AGENTS_PER_HUMAN = 3;
export const MAX_VOUCHES_PER_HUMAN = 5;
/** "Real public activity": at least this many public repos and gists combined, or this many followers. */
export const ACTIVITY_MIN_REPOS_AND_GISTS = 3;
export const ACTIVITY_MIN_FOLLOWERS = 2;

export type VerifiedVia = "approval" | "vouch" | "activity";

export interface GithubProfile {
  id: number;
  login: string;
  created_at: string;
  public_repos: number;
  public_gists: number;
  followers: number;
}

export const hasRealActivity = (p: GithubProfile) =>
  p.public_repos + p.public_gists >= ACTIVITY_MIN_REPOS_AND_GISTS || p.followers >= ACTIVITY_MIN_FOLLOWERS;

/** Verified by founder approval, a vouch, or real public activity. There is no account-age requirement. */
export function verificationFor(profile: GithubProfile, grant: "approval" | "vouch" | null): VerifiedVia | null {
  return grant ?? (hasRealActivity(profile) ? "activity" : null);
}

/**
 * The strongest active grant for a person: approval beats vouch. A grant made out to a username is bound to the
 * first GitHub account that signs in with it; after that only that account (by numeric id) can use it, even if the
 * username is renamed and taken by someone else (SECURITY_REVIEW.md, M4).
 */
export async function activeGrant(db: Db, person: { id: number; login: string }): Promise<"approval" | "vouch" | null> {
  const login = person.login.toLowerCase();
  const rows = await db
    .select({ id: t.trustGrants.id, source: t.trustGrants.source, githubId: t.trustGrants.githubId })
    .from(t.trustGrants)
    .where(
      and(
        isNull(t.trustGrants.revokedAt),
        or(eq(t.trustGrants.githubId, person.id), and(isNull(t.trustGrants.githubId), eq(t.trustGrants.githubLogin, login))),
      ),
    );
  const unbound = rows.filter((r) => r.githubId === null).map((r) => r.id);
  if (unbound.length) await db.update(t.trustGrants).set({ githubId: person.id }).where(inArray(t.trustGrants.id, unbound));
  if (rows.some((r) => r.source === "approval")) return "approval";
  return rows.length > 0 ? "vouch" : null;
}

/** Re-scores every tool version this human reported on, after their tier changes. */
export async function rescoreHuman(db: Db, humanId: string, now: number) {
  const versions = await db
    .selectDistinct({ id: t.reports.toolVersionId })
    .from(t.reports)
    .where(eq(t.reports.humanId, humanId));
  for (const v of versions) {
    const version = await db.query.toolVersions.findFirst({ where: eq(t.toolVersions.id, v.id) });
    if (version) await rescoreToolVersion(db, version, now);
  }
}

async function setVerification(db: Db, humanId: string, via: VerifiedVia | null, now: number) {
  const current = await db.query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  const tier = via ? "verified" : "sandbox";
  if (current && current.tier === tier && current.verifiedVia === via) return;
  await db.update(t.humans).set({ tier, verifiedVia: via }).where(eq(t.humans.id, humanId));
  // Re-score on any change: the tier sets weight, and how someone was verified decides whether they can help flag.
  if (current) await rescoreHuman(db, humanId, now);
}

export async function upsertHuman(db: Db, profile: GithubProfile, now: number) {
  const via = verificationFor(profile, await activeGrant(db, profile));
  const githubCreatedAt = Date.parse(profile.created_at);
  await db
    .insert(t.humans)
    .values({
      id: newId(),
      githubId: profile.id,
      githubLogin: profile.login,
      githubCreatedAt,
      tier: via ? "verified" : "sandbox",
      verifiedVia: via,
      createdAt: now,
    })
    .onConflictDoUpdate({ target: t.humans.githubId, set: { githubLogin: profile.login } });
  const human = (await db.query.humans.findFirst({ where: eq(t.humans.githubId, profile.id) }))!;
  await setVerification(db, human.id, via, now);
  return (await db.query.humans.findFirst({ where: eq(t.humans.id, human.id) }))!;
}

/** Founder accounts, by GitHub user number (the ADMIN_GITHUB_IDS variable, comma-separated). */
export const isAdmin = (env: Pick<Env, "ADMIN_GITHUB_IDS">, githubId: number) =>
  (env.ADMIN_GITHUB_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean).includes(String(githubId));

/** ADR 0023 §3: our own activity (House accounts and founder/admin testing) is never counted as usage. */
export const countsAsHouse = (env: Pick<Env, "ADMIN_GITHUB_IDS">, human: { isHouse: boolean; githubId: number }) =>
  human.isHouse || isAdmin(env, human.githubId);

/** Founder approval (MASTER_PLAN §11.3: granting access is Dinike's decision). Takes effect immediately. */
export async function approveLogin(db: Db, githubLogin: string, now: number) {
  const login = githubLogin.toLowerCase();
  const human = await db.query.humans.findFirst({ where: sql`lower(${t.humans.githubLogin}) = ${login}` });
  await db.insert(t.trustGrants).values({ id: newId(), githubLogin: login, githubId: human?.githubId ?? null, source: "approval", createdAt: now });
  if (human) await setVerification(db, human.id, "approval", now);
}

export type VouchResult =
  | { ok: true; vouched_login: string; vouches_remaining: number }
  | { ok: false; reason: "voucher_not_verified" | "cannot_vouch_for_self" | "already_vouched" | "vouch_limit_reached" };

/** A verified human vouches for someone by GitHub login; that person is verified (now, or when they sign in). */
export async function vouch(db: Db, voucherId: string, targetLogin: string, now: number): Promise<VouchResult> {
  const voucher = await db.query.humans.findFirst({ where: eq(t.humans.id, voucherId) });
  if (!voucher || voucher.tier !== "verified") return { ok: false, reason: "voucher_not_verified" };
  const login = targetLogin.trim().replace(/^@/, "").toLowerCase();
  if (login === voucher.githubLogin.toLowerCase()) return { ok: false, reason: "cannot_vouch_for_self" };

  const given = await db
    .select({ login: t.trustGrants.githubLogin })
    .from(t.trustGrants)
    .where(and(eq(t.trustGrants.grantedByHumanId, voucherId), isNull(t.trustGrants.revokedAt)));
  if (given.some((g) => g.login === login)) return { ok: false, reason: "already_vouched" };
  if (given.length >= MAX_VOUCHES_PER_HUMAN) return { ok: false, reason: "vouch_limit_reached" };

  const target = await db.query.humans.findFirst({ where: sql`lower(${t.humans.githubLogin}) = ${login}` });
  await db.insert(t.trustGrants).values({
    id: newId(),
    githubLogin: login,
    githubId: target?.githubId ?? null,
    source: "vouch",
    grantedByHumanId: voucherId,
    createdAt: now,
  });
  await db.insert(t.auditLog).values({
    id: newId(),
    actor: `human:${voucherId}`,
    action: "vouch",
    target: `github:${login}`,
    createdAt: now,
  });
  if (target && target.tier !== "verified") await setVerification(db, target.id, "vouch", now);
  return { ok: true, vouched_login: login, vouches_remaining: MAX_VOUCHES_PER_HUMAN - given.length - 1 };
}

export async function vouchesRemaining(db: Db, humanId: string) {
  const given = await db
    .select({ id: t.trustGrants.id })
    .from(t.trustGrants)
    .where(and(eq(t.trustGrants.grantedByHumanId, humanId), isNull(t.trustGrants.revokedAt)));
  return Math.max(0, MAX_VOUCHES_PER_HUMAN - given.length);
}

export function frameworkFromClientName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude-code";
  if (n.includes("codex") || n.includes("chatgpt") || n.includes("openai")) return "codex";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("openclaw")) return "openclaw";
  return "other";
}

function handleFor(clientName: string): string {
  const base =
    clientName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "agent";
  const suffix = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${base}-${suffix}`;
}

export type AgentResult =
  | { ok: true; agent: typeof t.agents.$inferSelect }
  | { ok: false; reason: "agent_limit_reached" | "agent_revoked" };

/** Each OAuth client a human authorizes is one agent. Re-authorizing the same client reuses it. */
export async function agentForClient(
  db: Db,
  humanId: string,
  clientId: string,
  clientName: string,
): Promise<AgentResult> {
  const existing = await db.query.agents.findFirst({
    where: and(eq(t.agents.humanId, humanId), eq(t.agents.oauthClientId, clientId)),
  });
  if (existing) return existing.status === "active" ? { ok: true, agent: existing } : { ok: false, reason: "agent_revoked" };

  const [active] = await db
    .select({ n: count() })
    .from(t.agents)
    .where(and(eq(t.agents.humanId, humanId), eq(t.agents.status, "active")));
  if ((active?.n ?? 0) >= MAX_AGENTS_PER_HUMAN) return { ok: false, reason: "agent_limit_reached" };

  const agent = {
    id: newId(),
    humanId,
    handle: handleFor(clientName),
    framework: frameworkFromClientName(clientName),
    oauthClientId: clientId,
  };
  await db.insert(t.agents).values(agent);
  return { ok: true, agent: (await db.query.agents.findFirst({ where: eq(t.agents.id, agent.id) }))! };
}
