import type { GithubProfile } from "./identity";

// "Sign in with GitHub" as the upstream identity step. No scopes requested: public profile only.

const UA = { "User-Agent": "theagentforge" };

/**
 * Both flows send GitHub exactly `${origin}/callback`, the OAuth app's registered URL. In practice GitHub rejected the
 * sub-path /callback/web, so website sign-ins are told apart by their state ("web-…") and forwarded internally.
 */
export const WEB_STATE_PREFIX = "web-";
export const githubCallbackUrl = (origin: string, _flow: "agent" | "web" = "agent") => `${origin}/callback`;

export function githubAuthorizeUrl(env: Env, state: string, codeChallenge: string, flow: "agent" | "web" = "agent"): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  u.searchParams.set("redirect_uri", githubCallbackUrl(env.PUBLIC_ORIGIN, flow));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Exchanges the code, reads the profile and public organisations, then forgets the GitHub token. */
export async function fetchGithubIdentity(
  env: Env,
  code: string,
  verifier: string,
  flow: "agent" | "web" = "agent",
): Promise<{ profile: GithubProfile; orgs: string[] }> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { ...UA, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: githubCallbackUrl(env.PUBLIC_ORIGIN, flow),
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`github_token_exchange_failed:${token.error ?? tokenRes.status}`);

  const auth = { ...UA, Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}` };
  const userRes = await fetch("https://api.github.com/user", { headers: auth });
  if (!userRes.ok) throw new Error(`github_user_failed:${userRes.status}`);
  const u = (await userRes.json()) as GithubProfile;
  const profile: GithubProfile = {
    id: u.id,
    login: u.login,
    created_at: u.created_at,
    public_repos: u.public_repos ?? 0,
    public_gists: u.public_gists ?? 0,
    followers: u.followers ?? 0,
  };
  const orgsRes = await fetch(`https://api.github.com/users/${encodeURIComponent(u.login)}/orgs?per_page=100`, {
    headers: auth,
  });
  const orgs = orgsRes.ok ? ((await orgsRes.json()) as { login: string }[]).map((o) => o.login.toLowerCase()) : [];
  return { profile, orgs };
}
