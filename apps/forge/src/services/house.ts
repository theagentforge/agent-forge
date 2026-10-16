import { and, eq } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, newId } from "./db";
import type { AgentProps } from "./props";

// The House tester (MASTER_PLAN §7.2): a GitHub Actions workflow in this repo starts MCP servers from the official
// registry in a sandbox and files honest, "house"-labelled reports. It authenticates with GitHub's OIDC token, so no
// shared secret exists anywhere: only a job in theagentforge/forge running house-tester.yml from main is accepted.

export const HOUSE_WORKFLOW = "theagentforge/forge/.github/workflows/house-tester.yml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";
const HOUSE_CLIENT = "house:tester";

interface Jwk extends JsonWebKey {
  kid: string;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

let jwksCache: { at: number; keys: Jwk[] } | null = null;
/** Tests only. */
export const resetJwksCache = () => {
  jwksCache = null;
};
async function githubKeys(fetcher: typeof fetch): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetcher(`${ISSUER}/.well-known/jwks`);
  if (!res.ok) throw new Error("jwks_unavailable");
  jwksCache = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  return jwksCache.keys;
}

export interface OidcClaims {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  repository: string;
  job_workflow_ref: string;
  ref: string;
  event_name: string;
}

/** Verifies a GitHub Actions OIDC token (RS256) and that it came from the House tester workflow on main. */
export async function verifyHouseToken(token: string, audience: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0]!))) as { alg: string; kid: string };
    if (header.alg !== "RS256") return null;
    const jwk = (await githubKeys(fetcher)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(b64url(parts[1]!))) as OidcClaims;
    const s = Math.floor(now / 1000);
    if (c.iss !== ISSUER || c.aud !== audience || c.exp < s || c.iat > s + 60) return null;
    if (c.repository !== "theagentforge/forge" || c.job_workflow_ref !== HOUSE_WORKFLOW || c.ref !== "refs/heads/main") return null;
    return c;
  } catch {
    return null;
  }
}

/** The House tester agent, owned by the first founder account, which must be marked House. Created on first use. */
export async function houseAgentProps(env: Env): Promise<AgentProps | null> {
  const db = getDb(env);
  const founderId = Number((env.ADMIN_GITHUB_IDS ?? "").split(",")[0]);
  const human = await db.query.humans.findFirst({ where: eq(t.humans.githubId, founderId) });
  if (!human || !human.isHouse) return null;
  let agent = await db.query.agents.findFirst({ where: and(eq(t.agents.humanId, human.id), eq(t.agents.oauthClientId, HOUSE_CLIENT)) });
  if (!agent) {
    await db
      .insert(t.agents)
      .values({ id: newId(), humanId: human.id, handle: "house-tester", framework: "other", oauthClientId: HOUSE_CLIENT })
      .onConflictDoNothing();
    agent = await db.query.agents.findFirst({ where: and(eq(t.agents.humanId, human.id), eq(t.agents.oauthClientId, HOUSE_CLIENT)) });
  }
  if (!agent || agent.status !== "active") return null;
  return { humanId: human.id, agentId: agent.id, githubLogin: human.githubLogin, githubOrgs: [] };
}

/**
 * True if the House agent already filed a report on this exact tool version. Extra same-day runs can pick the same
 * servers; a repeat adds nothing (one person counts once) and would only inflate House report counts.
 */
export async function houseAlreadyReported(env: Env, agentId: string, body: unknown) {
  const tool = (body as { tool?: { id?: unknown; version?: unknown } } | null)?.tool;
  if (typeof tool?.id !== "string" || typeof tool.version !== "string") return false;
  const row = await getDb(env)
    .select({ id: t.reports.id })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.toolVersions.id, t.reports.toolVersionId))
    .innerJoin(t.tools, eq(t.tools.id, t.toolVersions.toolId))
    .where(and(eq(t.reports.agentId, agentId), eq(t.tools.canonicalId, tool.id), eq(t.toolVersions.version, tool.version)))
    .limit(1);
  return row.length > 0;
}
