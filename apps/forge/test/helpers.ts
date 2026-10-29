import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { env, exports } from "cloudflare:workers";
import { providerOptions } from "../src/index";
import { getDb } from "../src/services/db";
import { agentForClient, approveLogin, upsertHuman, type GithubProfile } from "../src/services/identity";
import type { AgentProps } from "../src/services/props";

export const ORIGIN = env.PUBLIC_ORIGIN;
export const REDIRECT = "http://localhost:4567/callback";
export const fp = (c: string) => `sha256:${c.repeat(64)}`;

export const fetchWorker = (path: string, init?: RequestInit) => exports.default.fetch(`${ORIGIN}${path}`, init);

let githubIds = 1000;
export function profile(over: Partial<GithubProfile> = {}): GithubProfile {
  const id = githubIds++;
  return {
    id,
    login: `user${id}`,
    created_at: "2020-01-01T00:00:00Z",
    public_repos: 3,
    public_gists: 0,
    followers: 1,
    ...over,
  };
}

export async function s256(verifier: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Registers a public client through Dynamic Client Registration, as an MCP client would. */
export async function registerClient(name = "Claude Code") {
  const res = await fetchWorker("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export async function authorizeUrl(clientId: string, verifier: string, state = "st") {
  const u = new URL(`${ORIGIN}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", await s256(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", ORIGIN);
  return u.toString();
}

export async function exchangeCode(clientId: string, code: string, verifier: string) {
  const res = await fetchWorker("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: ORIGIN,
    }),
  });
  if (res.status !== 200) throw new Error(`token failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Connects an agent without the GitHub round trip (the callback route has its own test):
 * register a client, create the human and agent, complete the authorization, exchange the code.
 */
export async function connectAgent(opts: { profile?: GithubProfile; orgs?: string[]; clientName?: string } = {}) {
  const p = opts.profile ?? profile();
  const clientId = await registerClient(opts.clientName);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const oauth = getOAuthApi(providerOptions(ORIGIN), env);
  const request = await oauth.parseAuthRequest(new Request(await authorizeUrl(clientId, verifier)));
  const db = getDb(env);
  const human = await upsertHuman(db, p, Date.now());
  const agent = await agentForClient(db, human.id, clientId, opts.clientName ?? "Claude Code");
  if (!agent.ok) throw new Error(agent.reason);
  const props: AgentProps = {
    humanId: human.id,
    agentId: agent.agent.id,
    githubLogin: human.githubLogin,
    githubOrgs: opts.orgs ?? [],
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: human.id,
    metadata: {},
    scope: request.scope,
    props,
  });
  const code = new URL(redirectTo).searchParams.get("code")!;
  const token = await exchangeCode(clientId, code, verifier);
  return { token, human, agent: agent.agent, props, clientId };
}

export function report(over: Record<string, unknown> = {}) {
  return {
    tool: { kind: "mcp_server", id: "npm:@acme/search-mcp", version: "1.0.0", fingerprint: fp("a") },
    task: { category: "web-scraping", framework: "claude-code" },
    outcome: "worked",
    issues: [],
    ...over,
  };
}

export const postReport = (token: string, body: unknown) =>
  fetchWorker("/api/v1/report", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Connects an agent for a person the founder approved (the only kind, with vouched people, who can help flag). */
export async function connectApprovedAgent(p: GithubProfile = profile()) {
  await approveLogin(getDb(env), p.login, Date.now());
  return connectAgent({ profile: p });
}

let shownSeq = 0;
/**
 * ADR 0094: insert `n` owners, each with one active agent and one claimed, shown, finished Gauntlet run, straight into
 * D1 (no MCP round trips). Outside owners by default; `house`, `hidden`, `revoked` or `githubId` vary one condition.
 */
export async function seedShownOwners(n: number, o: { house?: boolean; hidden?: boolean; revoked?: boolean; githubId?: number } = {}) {
  const t = await import("../src/db/schema");
  const db = getDb(env);
  const now = Date.now();
  const handles: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = `${now.toString(36)}-${++shownSeq}`;
    const humanId = `seedh-${k}`;
    const agentId = `seeda-${k}`;
    const gid = `seedg-${k}`;
    await db.insert(t.humans).values({ id: humanId, githubId: o.githubId ?? 700_000_000 + shownSeq, githubLogin: `seed-${k}`, githubCreatedAt: 0, tier: "verified", isHouse: !!o.house });
    await db.insert(t.agents).values({ id: agentId, humanId, handle: `seed-${k}`, framework: "claude-code", oauthClientId: `seedc-${k}`, status: o.revoked ? "revoked" : "active" });
    await db.insert(t.arenaGauntlets).values({ id: gid, status: "done", startedAt: now - 1000, finishedAt: now - 500, mode: "full" });
    await db.insert(t.gauntletClaims).values({ gauntletId: gid, agentId, humanId, hidden: !!o.hidden, claimedAt: now });
    handles.push(`seed-${k}`);
  }
  return handles;
}
