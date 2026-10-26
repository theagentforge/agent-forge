import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/services/db";
import { agentForClient, approveLogin, upsertHuman, verificationFor, vouch } from "../src/services/identity";
import {
  authorizeUrl,
  connectAgent,
  exchangeCode,
  fetchWorker,
  fp,
  postReport,
  profile,
  REDIRECT,
  registerClient,
  report,
} from "./helpers";
import "../src/index";

const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

afterEach(() => vi.restoreAllMocks());

describe("connecting an agent through GitHub", () => {
  it("consent page → GitHub → callback → token, storing no email", async () => {
    const clientId = await registerClient("Claude Code");
    const verifier = crypto.randomUUID() + crypto.randomUUID();

    const start = new URL(await authorizeUrl(clientId, verifier, "client-state"));
    const consent = await fetchWorker(start.pathname + start.search);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const html = await consent.text();
    expect(html).toContain("Connect Claude Code to The Agent Forge?");
    expect(html).toContain("localhost"); // the redirect host is shown
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;

    const approve = await fetchWorker("/authorize", {
      method: "POST",
      headers: { Cookie: cookiesFrom(consent), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }),
      redirect: "manual",
    });
    expect(approve.status).toBe(302);
    const github = new URL(approve.headers.get("Location")!);
    expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(github.searchParams.get("client_id")).toBe("test-client-id");
    expect(github.searchParams.get("code_challenge_method")).toBe("S256");
    expect(github.searchParams.has("scope")).toBe(false); // public profile only

    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_test" });
      if (url === "https://api.github.com/user")
        return Response.json({
          id: 424242,
          login: "octo",
          email: "octo@example.com",
          created_at: "2019-05-01T00:00:00Z",
          public_repos: 4,
          public_gists: 0,
          followers: 2,
        });
      if (url.startsWith("https://api.github.com/users/octo/orgs")) return Response.json([{ login: "OctoOrg" }]);
      return realFetch(input, init);
    });

    const callback = await fetchWorker(`/callback?code=gh-code&state=${github.searchParams.get("state")}`, {
      headers: { Cookie: cookiesFrom(approve) },
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("Location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("client-state");

    const token = await exchangeCode(clientId, back.searchParams.get("code")!, verifier);
    const me = await fetchWorker("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ human_tier: "verified", agent: { owner_github: "octo", framework: "claude-code" } });

    const humans = await env.DB.prepare("SELECT * FROM humans WHERE github_id = 424242").all();
    expect(humans.results).toHaveLength(1);
    expect(JSON.stringify(humans.results)).not.toContain("example.com");
  });

  it("cancelling sends the client access_denied", async () => {
    const clientId = await registerClient();
    const url = new URL(await authorizeUrl(clientId, "v".repeat(43)));
    const consent = await fetchWorker(url.pathname + url.search);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]!;
    const deny = await fetchWorker("/authorize", {
      method: "POST",
      headers: { Cookie: cookiesFrom(consent), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "deny" }),
      redirect: "manual",
    });
    expect(deny.status).toBe(302);
    expect(new URL(deny.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("a forged consent post without the browser cookie is refused", async () => {
    const res = await fetchWorker("/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: "stolen", decision: "approve" }),
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("escapes a hostile client name on the consent page", async () => {
    const clientId = await registerClient('<script>alert("x")</script>');
    const url = new URL(await authorizeUrl(clientId, "w".repeat(43)));
    const html = await (await fetchWorker(url.pathname + url.search)).text();
    expect(html).not.toContain("<script>");
  });
});

describe("agents per human", () => {
  it("allows at most 3 agents per human; reconnecting the same client reuses its agent", async () => {
    const db = getDb(env);
    const human = await upsertHuman(db, profile(), Date.now());
    const first = await agentForClient(db, human.id, "client-a", "Claude Code");
    await agentForClient(db, human.id, "client-b", "Cursor");
    await agentForClient(db, human.id, "client-c", "Codex");
    expect(await agentForClient(db, human.id, "client-d", "Other")).toEqual({ ok: false, reason: "agent_limit_reached" });
    const again = await agentForClient(db, human.id, "client-a", "Claude Code");
    expect(again.ok && first.ok && again.agent.id === first.agent.id).toBe(true);
  });

  it("verified needs approval, a vouch or real public activity, with no account-age wait", () => {
    const brandNew = { created_at: new Date().toISOString() };
    expect(verificationFor(profile({ ...brandNew, public_repos: 3, followers: 0 }), null)).toBe("activity");
    expect(verificationFor(profile({ ...brandNew, public_repos: 0, followers: 2 }), null)).toBe("activity");
    expect(verificationFor(profile({ ...brandNew, public_repos: 1, public_gists: 1, followers: 1 }), null)).toBeNull();
    expect(verificationFor(profile({ public_repos: 0, followers: 0 }), "approval")).toBe("approval");
    expect(verificationFor(profile({ public_repos: 0, followers: 0 }), "vouch")).toBe("vouch");
  });
});

describe("approval and vouching", () => {
  const quiet = () => profile({ created_at: new Date().toISOString(), public_repos: 0, public_gists: 0, followers: 0 });

  it("an approval made before sign-in verifies the person when they arrive", async () => {
    const db = getDb(env);
    const p = quiet();
    await approveLogin(db, p.login.toUpperCase(), Date.now());
    const human = await upsertHuman(db, p, Date.now());
    expect(human).toMatchObject({ tier: "verified", verifiedVia: "approval" });
  });

  it("approving an existing sandbox person upgrades them and re-scores their reports", async () => {
    const p = quiet();
    const { token } = await connectAgent({ profile: p });
    const tool = { kind: "api", id: "npm:approval-rescore", version: "1", fingerprint: fp("9") };
    await postReport(token, report({ tool }));
    let check = (await (await fetchWorker(`/api/v1/check?fingerprint=${fp("9")}`)).json()) as Record<string, unknown>;
    expect(check).toMatchObject({ distinct_owners: 1, verified_owners: 0 });

    await approveLogin(getDb(env), p.login, Date.now());
    check = (await (await fetchWorker("/api/v1/check?id=npm:approval-rescore")).json()) as Record<string, unknown>;
    expect(check).toMatchObject({ distinct_owners: 1, verified_owners: 1 });
  });

  it("a verified person can vouch for 5 people; sandbox people can't vouch; nobody vouches for themselves", async () => {
    const db = getDb(env);
    const sponsor = await upsertHuman(db, profile(), Date.now());
    const newcomer = await upsertHuman(db, quiet(), Date.now());
    expect(newcomer.tier).toBe("sandbox");

    expect(await vouch(db, newcomer.id, "someone", Date.now())).toEqual({ ok: false, reason: "voucher_not_verified" });
    expect(await vouch(db, sponsor.id, sponsor.githubLogin, Date.now())).toEqual({
      ok: false,
      reason: "cannot_vouch_for_self",
    });

    expect(await vouch(db, sponsor.id, `@${newcomer.githubLogin}`, Date.now())).toMatchObject({
      ok: true,
      vouches_remaining: 4,
    });
    expect((await db.query.humans.findFirst({ where: (h, { eq }) => eq(h.id, newcomer.id) }))?.tier).toBe("verified");
    expect(await vouch(db, sponsor.id, newcomer.githubLogin, Date.now())).toEqual({ ok: false, reason: "already_vouched" });

    for (const n of ["a", "b", "c", "d"]) expect((await vouch(db, sponsor.id, `friend-${n}`, Date.now())).ok).toBe(true);
    expect(await vouch(db, sponsor.id, "friend-e", Date.now())).toEqual({ ok: false, reason: "vouch_limit_reached" });
  });

  it("agents can't vouch: vouching is only on the human's dashboard (prompt-injection guard)", async () => {
    const { token } = await connectAgent();
    const res = await fetchWorker("/api/v1/vouch", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ github_login: "attacker" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("MCP server", () => {
  const rpc = (token: string, method: string, params: unknown = {}) =>
    fetchWorker("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Host: new URL(env.PUBLIC_ORIGIN).host, // set by every real client; the MCP handler checks it
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  async function result(res: Response) {
    const text = await res.text();
    const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
    return JSON.parse(json) as { result?: any; error?: unknown };
  }

  it("lists the Forge tools", async () => {
    const { token } = await connectAgent();
    const res = await rpc(token, "tools/list");
    expect(res.status).toBe(200);
    const names = (await result(res)).result.tools.map((x: { name: string }) => x.name);
    expect(names.sort()).toEqual(["arena_act", "arena_start", "forge_check", "forge_me", "forge_report", "forge_traps", "gauntlet_claim"]);
  });

  it("forge_check returns structured data", async () => {
    const { token } = await connectAgent();
    const res = await rpc(token, "tools/call", { name: "forge_check", arguments: { id: "npm:unknown-thing" } });
    const out = (await result(res)).result;
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ known: false, security_status: "unknown" });
  });
});
