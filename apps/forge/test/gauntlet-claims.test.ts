import { TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CLAIM_NOTICE } from "../src/arena/gauntlet-claims";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { sha256Hex } from "../src/services/digest";
import { growthStats } from "../src/services/growth";
import { growthKpis } from "../src/services/kpis";
import { GAUNTLET_CLAIM_SENTENCE } from "../src/web/legal";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { connectAgent, connectApprovedAgent, fetchWorker } from "./helpers";
import "../src/index";

// ADR 0048: opt-in "claim this run". Runs stay anonymous unless the person who started one uses its private claim key
// (returned once, stored hashed) to link it to one of their agents. The share link never claims. Hiding undoes it.

const host = new URL(env.PUBLIC_ORIGIN).host;
let ipN = 120;
const nextIp = () => `203.0.113.${ipN++}`;
const parse = async (res: Response) => {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result as { structuredContent: any; isError?: boolean };
};
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: host };
const gauntlet = async (name: string, args: unknown, ip: string) =>
  (await parse(await fetchWorker("/mcp/gauntlet", { method: "POST", headers: { ...headers, "CF-Connecting-IP": ip }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }))).structuredContent;
const signedIn = async (token: string, name: string, args: unknown) =>
  parse(await fetchWorker("/mcp", { method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
async function finish(id: string, ip: string) {
  let last: any;
  for (let i = 0; i < TASKS.length; i++) last = await gauntlet("gauntlet_act", { gauntlet_id: id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }, ip);
  return last;
}
const page = async (path: string) => (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();
const json = async (path: string) => (await fetchWorker(path, { headers: { Accept: "application/json" } })).json() as Promise<any>;

describe("claim this run (ADR 0048)", () => {
  it("gives a private key once, stores only its hash, and never shows it again", async () => {
    const ip = nextIp();
    const start = await gauntlet("gauntlet_start", {}, ip);
    expect(start.claim_key).toMatch(/^gck_[A-Za-z0-9_-]{43}$/);
    expect(start.claim).toMatchObject({ private: true, shown_once: true, optional: true, not_the_share_link: true });
    const [row] = await getDb(env).select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, start.gauntlet_id));
    expect(row!.claimKeyHash).toBe(await sha256Hex(start.claim_key));
    expect(JSON.stringify(row)).not.toContain(start.claim_key);
    const end = await finish(start.gauntlet_id, ip);
    expect(JSON.stringify(end)).not.toContain(start.claim_key);
    const status = await gauntlet("gauntlet_status", { gauntlet_id: start.gauntlet_id }, ip);
    expect(JSON.stringify(status)).not.toContain(start.claim_key);
    expect(await page(`/gauntlet/r/${start.gauntlet_id}`)).not.toContain(start.claim_key);
    // A measured re-run gets no key.
    const rerun = await gauntlet("gauntlet_start", { card_from: start.gauntlet_id }, ip);
    expect(rerun.claim_key).toBeNull();
    // HTTP starts get one too.
    const http = (await (await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() }, body: "{}" })).json()) as any;
    expect(http.claim_key).toMatch(/^gck_/);
  });

  it("claims over the signed-in MCP, shows the run on the agent page and in head to head, and hides it again", async () => {
    const owner = await connectApprovedAgent();
    const ip = nextIp();
    const first = await gauntlet("gauntlet_start", {}, ip);
    // An unfinished run can't be claimed yet.
    expect((await signedIn(owner.token, "gauntlet_claim", { claim_key: first.claim_key })).structuredContent.error).toBe("run_not_finished");
    await finish(first.gauntlet_id, ip);
    const ch = await gauntlet("gauntlet_start", { challenge: first.gauntlet_id }, nextIp());
    await finish(ch.gauntlet_id, ip);

    // Before any claim, nothing changes: no section on the agent page, anonymous sides.
    expect(await page(`/a/${owner.agent.handle}`)).not.toContain("Gauntlet runs");
    const anon = await json(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}.json`);
    expect(anon.original).toMatchObject({ name: "Original run", agent: null });
    expect(anon.challenger).toMatchObject({ name: "Challenger", agent: null });

    // The share link (the run id) can't claim, and neither can a made-up key.
    expect((await signedIn(owner.token, "gauntlet_claim", { claim_key: first.gauntlet_id })).structuredContent.error).toBe("claim_key_invalid");
    expect((await signedIn(owner.token, "gauntlet_claim", { claim_key: `gck_${"A".repeat(43)}` })).structuredContent.error).toBe("claim_key_invalid");

    const r = await signedIn(owner.token, "gauntlet_claim", { claim_key: ch.claim_key });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: true, gauntlet_id: ch.gauntlet_id, agent: owner.agent.handle, hidden: false, notice: CLAIM_NOTICE });
    expect(r.structuredContent.agent_url).toBe(`${env.PUBLIC_ORIGIN}/a/${owner.agent.handle}`);
    // One claim per run, whoever tries.
    const other = await connectApprovedAgent();
    expect((await signedIn(other.token, "gauntlet_claim", { claim_key: ch.claim_key })).structuredContent.error).toBe("already_claimed");
    // Only the owner who claimed it can hide it.
    expect((await signedIn(other.token, "gauntlet_claim", { gauntlet_id: ch.gauntlet_id, hidden: true })).structuredContent.error).toBe("not_claimed_by_owner");

    const profile = await json(`/a/${owner.agent.handle}`);
    expect(profile.gauntlet.claimed_runs).toBe(1);
    expect(profile.gauntlet.runs[0]).toMatchObject({ gauntlet_id: ch.gauntlet_id, kind: "challenge", challenge_of: first.gauntlet_id, result: "drawn" });
    expect(profile.gauntlet.challenges).toMatchObject({ won: 0, lost: 0, drawn: 1, rematches: 0 });
    expect(profile.gauntlet.best.gauntlet_id).toBe(ch.gauntlet_id);
    const html = await page(`/a/${owner.agent.handle}`);
    expect(html).toContain("claimed runs");
    expect(html).toContain(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}`);

    // Head to head: the claimed side is named, the unclaimed side stays anonymous.
    const vs = await json(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}.json`);
    expect(vs.challenger).toMatchObject({ name: owner.agent.handle, agent: owner.agent.handle });
    expect(vs.original).toMatchObject({ name: "Original run", agent: null });
    expect(await page(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}`)).toContain(`href="/a/${owner.agent.handle}"`);
    expect(await page(`/gauntlet/r/${ch.gauntlet_id}`)).toContain("Claimed by");

    // Hidden: anonymous again on every public page.
    const hide = await signedIn(owner.token, "gauntlet_claim", { gauntlet_id: ch.gauntlet_id, hidden: true });
    expect(hide.structuredContent).toMatchObject({ hidden: true, agent_url: null, notice: CLAIM_NOTICE });
    expect((await json(`/a/${owner.agent.handle}`)).gauntlet.claimed_runs).toBe(0);
    expect(await page(`/a/${owner.agent.handle}`)).not.toContain("claimed runs");
    expect((await json(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}.json`)).challenger.agent).toBeNull();
    expect(await page(`/gauntlet/r/${ch.gauntlet_id}`)).not.toContain("Claimed by");
    // And shown again.
    await signedIn(owner.token, "gauntlet_claim", { gauntlet_id: ch.gauntlet_id, hidden: false });
    expect((await json(`/a/${owner.agent.handle}`)).gauntlet.claimed_runs).toBe(1);

    // The original's owner claims it too: both sides named, and the challenge counts as defended (level).
    const defender = await connectApprovedAgent();
    await signedIn(defender.token, "gauntlet_claim", { claim_key: first.claim_key });
    const d = await json(`/a/${defender.agent.handle}`);
    expect(d.gauntlet.runs[0]).toMatchObject({ kind: "first_run", result: null });
    expect(d.gauntlet.challenges.defending).toEqual({ won: 0, lost: 0, drawn: 1 });
    const both = await json(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}.json`);
    expect(both.original.agent).toBe(defender.agent.handle);
  });

  it("needs a verified owner", async () => {
    const sandbox = await connectAgent();
    await getDb(env).update(t.humans).set({ tier: "sandbox" }).where(eq(t.humans.id, sandbox.human.id));
    const ip = nextIp();
    const run = await gauntlet("gauntlet_start", {}, ip);
    await finish(run.gauntlet_id, ip);
    const r = await signedIn(sandbox.token, "gauntlet_claim", { claim_key: run.claim_key });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: "claim_needs_verified_owner", notice: CLAIM_NOTICE });
  });

  it("claims and hides from the dashboard, with the notice shown where you claim", async () => {
    const owner = await connectApprovedAgent();
    const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, owner.human.id)}`;
    const dash = await (await fetchWorker("/dashboard", { headers: { Cookie: cookie } })).text();
    expect(dash).toContain("Claim this run");
    expect(dash).toContain(CLAIM_NOTICE.replace(/'/g, "&#39;"));
    const csrf = /name="csrf" value="([^"]+)"/.exec(dash)![1]!;
    const ip = nextIp();
    const run = await gauntlet("gauntlet_start", {}, ip);
    await finish(run.gauntlet_id, ip);
    const post = (path: string, fields: Record<string, string>) =>
      fetchWorker(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post("/dashboard/gauntlet/claim", { agent: owner.agent.id, claim_key: run.gauntlet_id })).headers.get("Location")).toBe("/dashboard?m=claim_key_invalid");
    expect((await post("/dashboard/gauntlet/claim", { agent: owner.agent.id, claim_key: run.claim_key })).headers.get("Location")).toBe("/dashboard?m=claimed");
    expect((await json(`/a/${owner.agent.handle}`)).gauntlet.claimed_runs).toBe(1);
    expect(await (await fetchWorker("/dashboard", { headers: { Cookie: cookie } })).text()).toContain(`/dashboard/gauntlet/${run.gauntlet_id}/hidden`);
    expect((await post(`/dashboard/gauntlet/${run.gauntlet_id}/hidden`, { hidden: "on" })).headers.get("Location")).toBe("/dashboard?m=run_hidden");
    expect((await json(`/a/${owner.agent.handle}`)).gauntlet.claimed_runs).toBe(0);
    // Without the session's CSRF token, nothing happens.
    const forged = await fetchWorker(`/dashboard/gauntlet/${run.gauntlet_id}/hidden`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "x", hidden: "off" }) });
    expect(forged.status).toBe(403);
  });

  it("counts claims by owners outside the project, never House", async () => {
    const before = (await growthStats(env)).gauntlet_claims_7d;
    const outside = await connectApprovedAgent();
    const house = await connectApprovedAgent();
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, house.human.id));
    for (const who of [outside, house]) {
      const ip = nextIp();
      const run = await gauntlet("gauntlet_start", {}, ip);
      await finish(run.gauntlet_id, ip);
      expect((await signedIn(who.token, "gauntlet_claim", { claim_key: run.claim_key })).structuredContent.ok).toBe(true);
    }
    expect((await growthStats(env)).gauntlet_claims_7d).toBe(before + 1);
    const k = await growthKpis(env);
    expect(k.kpis.find((x) => x.id === "results")!.detail).toHaveProperty("gauntlet_claims");
  });

  it("puts the claim sentence in the Privacy Policy 1.2 Gauntlet row, the same words as at the point of claiming", async () => {
    expect(GAUNTLET_CLAIM_SENTENCE).toBe(CLAIM_NOTICE);
    const privacy = await page("/privacy");
    expect(privacy).toContain(GAUNTLET_CLAIM_SENTENCE.replace(/'/g, "&#39;"));
    expect(privacy).toContain("a sentence on claiming a Gauntlet run");
  });
});
