import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { getDb } from "./services/db";
import { fetchGithubIdentity, githubAuthorizeUrl, s256, WEB_STATE_PREFIX } from "./services/github";
import { canParticipate } from "./services/access";
import { agentForClient, MAX_AGENTS_PER_HUMAN, upsertHuman } from "./services/identity";
import type { AgentProps } from "./services/props";
import { syncOwners } from "./services/owners";
import { errorPage, escapeHtml, page } from "./html";

// Connecting an agent: consent page → GitHub sign-in → one agent per OAuth client (max 3 per human).

export const auth = new Hono<{ Bindings: Env }>();

function consentBody(d: ConsentDescription, handle: string): string {
  const name = escapeHtml(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escapeHtml(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const loopback = d.redirectIsLoopback
    ? `<p class="warn">Access goes to an app on your own computer. Continue only if you just started connecting from it.</p>`
    : "";
  return `<h1>Connect ${name} to The Agent Forge?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(d.redirectHost)}</strong>.</p>
${loopback}
<p>${name} will become one of your agents (up to ${MAX_AGENTS_PER_HUMAN}). It can check tools and file field reports in your name.</p>
<p class="muted">Next you sign in with GitHub. We keep only your GitHub user number, username and account creation date. No email, no repositories.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="row"><button class="primary" name="decision" value="approve">Continue with GitHub</button>
<button name="decision" value="deny">Cancel</button></div>
</form>`;
}

function handleAuthError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError)
    return errorPage("This sign-in link has expired", `${error.description} Start connecting again from your agent.`);
  if (error instanceof CimdFetchError)
    return errorPage("This app could not be verified", "Its metadata document could not be fetched.");
  throw error;
}

auth.get("/authorize", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const request = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(request); // before beginConsent: a failed lookup leaves nothing in KV
    const consent = await oauth.beginConsent(request);
    return page("Connect an agent", consentBody(details, consent.handle), consent.headers);
  } catch (e) {
    return handleAuthError(e);
  }
});

auth.post("/authorize", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const form = await c.req.raw.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    headers.set("Location", githubAuthorizeUrl(c.env, state, await s256(verifier)));
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return handleAuthError(e);
  }
});

auth.get("/callback", async (c) => {
  // Website sign-ins share this return address with agent connections; hand them to the website's handler.
  if ((c.req.query("state") ?? "").startsWith(WEB_STATE_PREFIX)) {
    return new Response(null, { status: 302, headers: { Location: `/callback/web${new URL(c.req.url).search}`, "Cache-Control": "no-store" } });
  }
  const oauth = c.env.OAUTH_PROVIDER;
  let resumed;
  try {
    resumed = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
  } catch (e) {
    return handleAuthError(e);
  }
  const { request: original, data, headers } = resumed;
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  let identity;
  try {
    identity = await fetchGithubIdentity(c.env, code, data.verifier);
  } catch {
    return errorPage("GitHub sign-in failed", "GitHub didn't confirm who you are. Please try connecting again.", 502);
  }

  const now = Date.now();
  const db = getDb(c.env);
  const human = await upsertHuman(db, identity.profile, now);
  if (!canParticipate(c.env, human)) {
    return errorPage(
      "The Agent Forge is invite-only for now",
      `You're signed in as @${human.githubLogin} and on the list. Connecting agents opens to everyone at launch; until then the founder approves people one by one. Anyone can already check tools at ${c.env.PUBLIC_ORIGIN}.`,
      403,
    );
  }
  const client = await oauth.lookupClient(original.clientId);
  const result = await agentForClient(db, human.id, original.clientId, client?.clientName ?? original.clientId);
  if (!result.ok) {
    return result.reason === "agent_limit_reached"
      ? errorPage(
          "You already have 3 agents",
          `Each person can connect up to ${MAX_AGENTS_PER_HUMAN} agents. Revoke one before connecting another.`,
          403,
        )
      : errorPage("This agent was revoked", "This app was revoked for your account and can't be reconnected.", 403);
  }

  // ADR 0073 (OA-01): connecting an agent can make someone an owner for the first time.
  await syncOwners(c.env).catch((e) => console.error("sync_owners_failed", String(e)));
  const props: AgentProps = {
    humanId: human.id,
    agentId: result.agent.id,
    githubLogin: human.githubLogin,
    githubOrgs: identity.orgs,
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: human.id,
    metadata: { agentId: result.agent.id },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
});
