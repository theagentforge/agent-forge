import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateWorkflow, resetJwksCache, verifyActionsToken } from "../src/services/house";
import { CLAIM_KV, ERROR_KV, cleanChallenge, compute, KEY_KV, moltbookKey, moltbookStatus, postToMoltbook, registerMoltbook, solveChallenge, validatePost } from "../src/social/moltbook";
import { fetchWorker } from "./helpers";
import "../src/index";

// The Forge's agent on Moltbook: approve-only posts from moltbook.yml (GitHub OIDC, private repo, main only), the key in
// Cloudflare only, one post per approved text, and Moltbook's arithmetic check read by Workers AI and computed in code.

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const WORKFLOW = "theagentforge/forge/.github/workflows/moltbook.yml@refs/heads/main";
let keys: CryptoKeyPair;

async function token(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc({ iss: "https://token.actions.githubusercontent.com", aud: env.PUBLIC_ORIGIN, iat: now, exp: now + 300, repository: "theagentforge/forge", repository_id: "1418096645", job_workflow_ref: WORKFLOW, ref: "refs/heads/main", event_name: "issue_comment", ...over });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

const post = { submolt: "security", title: "We scanned 1,200 agent skills", content: "Eight read the whole key file to get one key." };
let moltCalls: { url: string; body: unknown }[] = [];

beforeEach(async () => {
  resetJwksCache();
  moltCalls = [];
  keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://token.actions.githubusercontent.com/.well-known/jwks") return Response.json({ keys: [jwk] });
    if (url.startsWith("https://www.moltbook.com/api/v1/")) {
      moltCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/posts")) return Response.json({ success: true, verification_required: true, post: { id: `post-${moltCalls.length}`, verification: { verification_code: "moltbook_verify_x", challenge_text: "A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE" } } });
      if (url.endsWith("/verify")) return Response.json({ success: true });
      if (url.endsWith("/agents/register")) return Response.json({ agent: { api_key: "moltbook_test_secret", claim_url: "https://www.moltbook.com/claim/moltbook_claim_abc", verification_code: "reef-X4B2" } });
      if (url.endsWith("/agents/status")) return Response.json({ status: "pending_claim" });
    }
    return realFetch(input, init);
  });
  vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: '{"a": 20, "op": "-", "b": 5}' })) as never);
});

describe("who may post", () => {
  it("only moltbook.yml on main in the private repo", async () => {
    const ok = privateWorkflow("moltbook.yml");
    expect(await verifyActionsToken(await token(), env.PUBLIC_ORIGIN, ok)).not.toBeNull();
    for (const bad of [
      { repository: "theagentforge/agent-forge", repository_id: "1421518455", job_workflow_ref: "theagentforge/agent-forge/.github/workflows/moltbook.yml@refs/heads/main" },
      { job_workflow_ref: "theagentforge/forge/.github/workflows/post-to-x.yml@refs/heads/main" },
      { ref: "refs/heads/feature", job_workflow_ref: "theagentforge/forge/.github/workflows/moltbook.yml@refs/heads/feature" },
      { repository_id: "1" },
      { aud: "https://evil.example" },
    ])
      expect(await verifyActionsToken(await token(bad), env.PUBLIC_ORIGIN, ok), JSON.stringify(bad)).toBeNull();
  });

  it("the endpoint refuses anyone else and checks the post", async () => {
    const call = async (auth: string, body: unknown) =>
      fetchWorker("/api/v1/social/moltbook", { method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await call("nope", post)).status).toBe(401);
    expect((await call(await token({ job_workflow_ref: "theagentforge/forge/.github/workflows/ci.yml@refs/heads/main" }), post)).status).toBe(401);
    expect((await call(await token(), { ...post, submolt: "Not OK" })).status).toBe(422);
    // No Moltbook key in tests: connected later by Claude through the Cloudflare connector.
    const r = await call(await token(), post);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, error: "moltbook_not_connected" });
  });
});

describe("posting", () => {
  it("validates like Moltbook does", () => {
    expect(validatePost(post)).toEqual(post);
    expect(validatePost({ ...post, title: "" })).toMatch(/title/);
    expect(validatePost({ ...post, content: "x".repeat(40_001) })).toMatch(/content/);
    expect(validatePost(null)).toMatch(/object/);
  });

  it("posts, answers the arithmetic check, and never sends the same post twice", async () => {
    const e = { ...env, MOLTBOOK_API_KEY: "test-key" };
    await env.KV.delete("moltbook:last-post");
    const first = await postToMoltbook(e, { ...post, title: `${post.title} ${crypto.randomUUID()}` });
    expect(first).toMatchObject({ ok: true, verified: true });
    expect(moltCalls.map((c) => c.url.split("/api/v1")[1])).toEqual(["/posts", "/verify"]);
    expect(moltCalls[1]!.body).toEqual({ verification_code: "moltbook_verify_x", answer: "15.00" });
    const p2 = { ...post, title: "Same post" };
    await env.KV.delete("moltbook:last-post");
    await postToMoltbook(e, p2);
    const n = moltCalls.length;
    expect(await postToMoltbook(e, p2)).toMatchObject({ ok: true, already: true });
    expect(moltCalls.length).toBe(n);
  });

  it("keeps Moltbook's gaps between posts: 2 hours on the first day, 30 minutes after", async () => {
    const e = { ...env, MOLTBOOK_API_KEY: "test-key" };
    await env.KV.put("moltbook:first-post", String(Date.now() - 3_600_000));
    await env.KV.put("moltbook:last-post", String(Date.now() - 40 * 60_000));
    const r = await postToMoltbook(e, { ...post, title: `Gap ${crypto.randomUUID()}` });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/^too_soon: .*120 minutes/);
    await env.KV.put("moltbook:first-post", String(Date.now() - 3 * 86_400_000));
    expect(await postToMoltbook(e, { ...post, title: `Gap ${crypto.randomUUID()}` })).toMatchObject({ ok: true });
  });

  it("reads the scrambled question and does the arithmetic in code", async () => {
    expect(cleanChallenge("A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS")).toBe("a lobster swims at twenntyy meters");
    expect(compute(20, "-", 5)).toBe("15.00");
    expect(compute(7, "/", 2)).toBe("3.50");
    expect(compute(1, "/", 0)).toBeNull();
    expect(compute(1, "^", 2)).toBeNull();
    expect(await solveChallenge(env.AI, "x")).toBe("15.00");
    vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "I think it's 15" })) as never);
    expect(await solveChallenge(env.AI, "x")).toBeNull();
  });
});

describe("registering the agent from /admin/moltbook", () => {
  it("registers once, keeps the key server-side, and returns only the claim link and code", async () => {
    await env.KV.delete(KEY_KV);
    await env.KV.delete(CLAIM_KV);
    const r = await registerMoltbook(env);
    expect(r).toMatchObject({ ok: true, claim_url: "https://www.moltbook.com/claim/moltbook_claim_abc", verification_code: "reef-X4B2" });
    expect(JSON.stringify(r)).not.toContain("moltbook_test_secret");
    expect(moltCalls.at(-1)!.body).toMatchObject({ name: "TheAgentForge" });
    expect(await moltbookKey(env)).toBe("moltbook_test_secret");
    expect(await moltbookStatus(env)).toBe("pending_claim");
    // A second press never registers a second agent.
    const n = moltCalls.length;
    expect(await registerMoltbook(env)).toMatchObject({ ok: false, error: "already_registered" });
    expect(moltCalls.length).toBe(n);
    await env.KV.delete(KEY_KV);
  });

  it("moves on to the next name when Moltbook says a name is taken, and keeps the error when all fail", async () => {
    await env.KV.delete(KEY_KV);
    const taken = new Set(["TheAgentForge"]);
    const fetcher = (async (_u: string, init?: RequestInit) => {
      const name = JSON.parse(String(init?.body)).name as string;
      if (taken.has(name)) return Response.json({ error: "Agent name already taken" }, { status: 409 });
      return Response.json({ agent: { api_key: "moltbook_k2", claim_url: "https://www.moltbook.com/claim/c2", verification_code: "tide-9" } });
    }) as typeof fetch;
    expect(await registerMoltbook(env, fetcher)).toMatchObject({ ok: true, name: "AgentForgeArena", claim_url: "https://www.moltbook.com/claim/c2" });
    await env.KV.delete(KEY_KV);
    const down = (async () => Response.json({ error: "busy" }, { status: 503 })) as unknown as typeof fetch;
    expect(await registerMoltbook(env, down)).toMatchObject({ ok: false });
    expect(await env.KV.get(ERROR_KV)).toMatch(/busy \(HTTP 503, name TheAgentForge\)/);
    await env.KV.delete(ERROR_KV);
  });

  it("the admin page and button are for signed-in admins only", async () => {
    const page = await fetchWorker("/admin/moltbook", { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe("/dashboard");
    const press = await fetchWorker("/admin/moltbook/register", { method: "POST", redirect: "manual", headers: { Origin: env.PUBLIC_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "csrf=x" });
    expect(press.status).toBe(302);
    expect(await env.KV.get(KEY_KV)).toBeNull();
  });
});
