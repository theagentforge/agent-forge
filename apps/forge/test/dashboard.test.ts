import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { connectAgent, fetchWorker, profile } from "./helpers";
import "../src/index";

afterEach(() => vi.restoreAllMocks());
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** Signs a human in on the website through the real /auth/login → GitHub → /callback/web flow, GitHub mocked. */
async function webLogin(p: ReturnType<typeof profile>) {
  const start = await fetchWorker("/auth/login", { redirect: "manual" });
  expect(start.status).toBe(302);
  const gh = new URL(start.headers.get("Location")!);
  // GitHub is always sent the registered URL exactly; website sign-ins are forwarded internally.
  expect(gh.searchParams.get("redirect_uri")).toBe(`${env.PUBLIC_ORIGIN}/callback`);
  expect(gh.searchParams.get("state")).toMatch(/^web-/);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_x" });
    if (url === "https://api.github.com/user") return Response.json(p);
    if (url.startsWith("https://api.github.com/users/")) return Response.json([]);
    return realFetch(input, init);
  });
  const hop = await fetchWorker(`/callback?code=c&state=${gh.searchParams.get("state")}`, { redirect: "manual" });
  expect(hop.headers.get("Location")).toBe(`/callback/web?code=c&state=${gh.searchParams.get("state")}`);
  const cb = await fetchWorker(hop.headers.get("Location")!, {
    headers: { Cookie: cookiesFrom(start) },
    redirect: "manual",
  });
  // OA-08 (ADR 0078): the sign-in that first makes someone an owner (an agent already connected) goes by /welcome.
  expect(["/dashboard", "/welcome"]).toContain(cb.headers.get("Location"));
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-forge_session="))!.split(";")[0]!;
  vi.restoreAllMocks();
  return cookie;
}

async function dashboard(cookie: string) {
  const res = await fetchWorker("/dashboard", { headers: { Cookie: cookie } });
  const body = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1];
  return { res, body, csrf };
}

const post = (path: string, cookie: string, fields: Record<string, string>, origin?: string) =>
  fetchWorker(path, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}) },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

describe("dashboard", () => {
  it("asks visitors to sign in and is never cached", async () => {
    const res = await fetchWorker("/dashboard");
    expect(await res.text()).toContain("Sign in with GitHub");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("lets the owner rename and revoke their agent", async () => {
    const p = profile();
    const { agent, token } = await connectAgent({ profile: p });
    const cookie = await webLogin(p);
    const { body, csrf } = await dashboard(cookie);
    expect(body).toContain(agent.handle);

    const rename = await post(`/dashboard/agents/${agent.id}/rename`, cookie, { csrf: csrf!, handle: "my-scout" });
    expect(rename.headers.get("Location")).toBe("/dashboard?m=renamed");
    const renamed = await getDb(env).query.agents.findFirst({ where: eq(t.agents.id, agent.id) });
    expect(renamed?.handle).toBe("my-scout");

    const revoke = await post(`/dashboard/agents/${agent.id}/revoke`, cookie, { csrf: csrf! });
    expect(revoke.headers.get("Location")).toBe("/dashboard?m=revoked");
    const me = await fetchWorker("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(401); // the OAuth grant itself is gone, not just the agent's write access
  });

  it("refuses posts without the CSRF token or from another site", async () => {
    const p = profile();
    const { agent } = await connectAgent({ profile: p });
    const cookie = await webLogin(p);
    const { csrf } = await dashboard(cookie);
    expect((await post(`/dashboard/agents/${agent.id}/revoke`, cookie, { csrf: "wrong" })).status).toBe(403);
    expect(
      (await post(`/dashboard/agents/${agent.id}/revoke`, cookie, { csrf: csrf! }, "https://evil.example")).status,
    ).toBe(403);
  });

  it("can't touch someone else's agent", async () => {
    const victim = await connectAgent();
    const p = profile();
    await connectAgent({ profile: p });
    const cookie = await webLogin(p);
    const { csrf } = await dashboard(cookie);
    const res = await post(`/dashboard/agents/${victim.agent.id}/revoke`, cookie, { csrf: csrf! });
    expect(res.status).toBe(404);
    const still = await getDb(env).query.agents.findFirst({ where: eq(t.agents.id, victim.agent.id) });
    expect(still?.status).toBe("active");
  });

  it("verified people can vouch from the dashboard", async () => {
    const p = profile();
    await connectAgent({ profile: p });
    const cookie = await webLogin(p);
    const { csrf } = await dashboard(cookie);
    const res = await post("/dashboard/vouch", cookie, { csrf: csrf!, github_login: "@new-friend" });
    expect(res.headers.get("Location")).toBe("/dashboard?m=vouched");
  });

  it("the founder can approve people with one tap; nobody else can", async () => {
    const newcomer = profile({ login: "design-partner", public_repos: 0, public_gists: 0, followers: 0 });
    await connectAgent({ profile: newcomer });

    const founder = profile({ id: Number(env.ADMIN_GITHUB_IDS) });
    const cookie = await webLogin(founder);
    const { body, csrf } = await dashboard(cookie);
    expect(body).toContain("Approve people (founder only)");
    expect(body).toContain("AI agents using the Forge (founder only)");
    expect(body).toContain("@design-partner");
    const res = await post("/dashboard/approve", cookie, { csrf: csrf!, github_login: "design-partner" });
    expect(res.headers.get("Location")).toBe("/dashboard?m=approved");
    const h = await getDb(env).query.humans.findFirst({ where: eq(t.humans.githubLogin, "design-partner") });
    expect(h).toMatchObject({ tier: "verified", verifiedVia: "approval" });

    const other = profile();
    const otherCookie = await webLogin(other);
    const page = await dashboard(otherCookie);
    expect(page.body).not.toContain("Approve people");
    expect(page.body).not.toContain("AI agents using the Forge");
    const denied = await post("/dashboard/approve", otherCookie, { csrf: page.csrf!, github_login: "someone-else" });
    expect(denied.headers.get("Location")).toBe("/dashboard?m=not_admin");
    expect(await getDb(env).query.trustGrants.findFirst({ where: eq(t.trustGrants.githubLogin, "someone-else") })).toBeUndefined();
  });

  it("the founder can mark a signed-in account as House", async () => {
    await connectAgent({ profile: profile({ login: "house-runner" }) });
    const cookie = await webLogin(profile({ id: Number(env.ADMIN_GITHUB_IDS) + 1_000_000 }));
    const founderCookie = await webLogin(profile({ id: Number(env.ADMIN_GITHUB_IDS) }));
    const { csrf } = await dashboard(founderCookie);
    const res = await post("/dashboard/house", founderCookie, { csrf: csrf!, github_login: "house-runner", house: "on" });
    expect(res.headers.get("Location")).toBe("/dashboard?m=house_on");
    expect((await getDb(env).query.humans.findFirst({ where: eq(t.humans.githubLogin, "house-runner") }))?.isHouse).toBe(true);
    const other = await dashboard(cookie);
    const denied = await post("/dashboard/house", cookie, { csrf: other.csrf!, github_login: "house-runner", house: "off" });
    expect(denied.headers.get("Location")).toBe("/dashboard?m=not_admin");
  });

  it("rejects a forged session cookie", async () => {
    const res = await fetchWorker("/dashboard", { headers: { Cookie: "__Host-forge_session=eyJoIjoieCJ9.forged" } });
    expect(await res.text()).toContain("Sign in with GitHub");
  });
});

describe("publishers and disputes", () => {
  it("the GitHub owner can claim a tool and reply on its page", async () => {
    const owner = profile({ login: "toolmaker" });
    const tool = { kind: "skill", id: "github.com/toolmaker/great-skill", version: "1", fingerprint: `sha256:${"5".repeat(64)}` };
    const reporter = await connectAgent();
    const { postReport, report } = await import("./helpers");
    expect((await postReport(reporter.token, report({ tool, outcome: "failed" }))).status).toBe(201);

    const cookie = await webLogin(owner);
    const page = await fetchWorker(`/claim?tool=${encodeURIComponent(tool.id)}`, { headers: { Cookie: cookie } });
    const html = await page.text();
    expect(html).toContain("so you can claim it now");
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    expect((await post("/claim", cookie, { csrf, tool: tool.id })).status).toBe(303);
    const reply = await post("/claim/reply", cookie, { csrf, tool: tool.id, body: "Fixed in v2, please retest." });
    expect(reply.headers.get("Location")).toBe(`/t/${encodeURIComponent(tool.id)}`);
    const toolPage = await (await fetchWorker(`/t/${encodeURIComponent(tool.id)}?fresh=1`)).text();
    expect(toolPage).toContain("Fixed in v2, please retest.");
    expect(toolPage).toContain("claimed by @toolmaker");
  });

  it("someone else can't claim it", async () => {
    const tool = { kind: "skill", id: "github.com/realowner/thing", version: "1", fingerprint: `sha256:${"4".repeat(64)}` };
    const { postReport, report } = await import("./helpers");
    await postReport((await connectAgent()).token, report({ tool }));
    const p = profile();
    const cookie = await webLogin(p);
    const { csrf } = await dashboard(cookie);
    expect((await post("/claim", cookie, { csrf: csrf!, tool: tool.id })).status).toBe(403);
  });

  it("signed-in people can open a dispute", async () => {
    const p = profile();
    const cookie = await webLogin(p);
    const page = await (await fetchWorker("/disputes", { headers: { Cookie: cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const res = await post("/disputes", cookie, { csrf, tool: "", report: "", reason: "This report is about a different tool." });
    expect(res.headers.get("Location")).toBe("/disputes?sent=1");
    const rows = await env.DB.prepare("SELECT reason FROM disputes").all();
    expect(JSON.stringify(rows.results)).toContain("different tool");
  });
});
