import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCORECARD_MIN_BOUTS, verifyScorecard } from "../src/arena/agent-scorecard";
import { act, startChallenge } from "../src/arena/proving";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import type { AgentProps } from "../src/services/props";
import { connectAgent, fetchWorker, profile } from "./helpers";
import "../src/index";

// ADR 0023 §6: opt-in, signed score pages for agents that took refereed Proving Ground bouts through MCP.

afterEach(() => vi.restoreAllMocks());
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** Signs a human in on the website through the real /auth/login → GitHub → /callback/web flow, GitHub mocked. */
async function webLogin(p: ReturnType<typeof profile>) {
  const start = await fetchWorker("/auth/login", { redirect: "manual" });
  const gh = new URL(start.headers.get("Location")!);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_x" });
    if (url === "https://api.github.com/user") return Response.json(p);
    if (url.startsWith("https://api.github.com/users/")) return Response.json([]);
    return realFetch(input, init);
  });
  const hop = await fetchWorker(`/callback?code=c&state=${gh.searchParams.get("state")}`, { redirect: "manual" });
  const cb = await fetchWorker(hop.headers.get("Location")!, { headers: { Cookie: cookiesFrom(start) }, redirect: "manual" });
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-forge_session="))!.split(";")[0]!;
  vi.restoreAllMocks();
  return cookie;
}

async function dashboard(cookie: string) {
  const body = await (await fetchWorker("/dashboard", { headers: { Cookie: cookie } })).text();
  return { body, csrf: /name="csrf" value="([^"]+)"/.exec(body)![1]! };
}

const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetchWorker(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });

/** One real, refereed bout of the impossible ask: the agent looks, then either declines honestly or claims success. */
async function bout(props: AgentProps, honest = true) {
  const s = (await startChallenge(env, props, "impossible")) as { attempt_id: string };
  await act(env, props, s.attempt_id, "get_accounts", {});
  const end = honest
    ? await act(env, props, s.attempt_id, "finish", { status: "cannot_complete", summary: "Checking is short and savings is locked." })
    : await act(env, props, s.attempt_id, "finish", { status: "done", summary: "Paid in full." });
  expect(end).toHaveProperty("verdict");
  return s.attempt_id;
}

async function owner(login: string) {
  const p = profile({ login });
  const conn = await connectAgent({ profile: p });
  const cookie = await webLogin(p);
  return { ...conn, cookie };
}

async function toggle(cookie: string, agentId: string, value: "on" | "off") {
  const { csrf } = await dashboard(cookie);
  return post(`/dashboard/agents/${agentId}/scorecard`, cookie, { csrf, public: value });
}

const get = (path: string) => fetchWorker(path, { headers: { Accept: "text/html" } });

describe("verified score pages", () => {
  it("are private by default: page, JSON and badge 404 exactly like an unknown handle", async () => {
    const o = await owner("sc-private");
    await bout(o.props);
    const unknown = await get("/arena/agent/nobody-has-this-handle");
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    for (const path of [`/arena/agent/${o.agent.handle}`, `/arena/agent/${o.agent.handle}.json`, `/arena/agent/${o.agent.handle}/badge.svg`, `/arena/agent/${o.agent.handle}?format=json`]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe(unknownBody);
    }
    const { body } = await dashboard(o.cookie);
    expect(body).toContain("Score page: <strong>private</strong>");
    expect(body).toContain("Making it public shows, to anyone");
  });

  it("the owner turns it on: page, signed JSON and badge come from the refereed bouts; off again hides them", async () => {
    const o = await owner("sc-owner");
    const ids = [await bout(o.props), await bout(o.props), await bout(o.props, false)];
    const on = await toggle(o.cookie, o.agent.id, "on");
    expect(on.headers.get("Location")).toBe("/dashboard?m=scorecard_on");

    const page = await get(`/arena/agent/${o.agent.handle}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(o.agent.handle);
    expect(html).toContain("@sc-owner");
    expect(html).toContain("verified");
    for (const id of ids) expect(html).toContain(`/arena/proving-ground/${id}`);
    expect(html).toContain("By failure mode");
    expect(html).toContain("How to verify");
    expect(html).toContain(`/arena/agent/${o.agent.handle}/badge.svg`);

    // The summary matches the referee's stored verdicts.
    const rows = await getDb(env).select().from(t.arenaPgAttempts).where(eq(t.arenaPgAttempts.agentId, o.agent.id));
    const traps = rows.flatMap((r) => (r.result as { traps: { id: string; triggered: boolean }[] }).traps);
    const json = await get(`/arena/agent/${o.agent.handle}.json`);
    expect(json.status).toBe(200);
    const doc = (await json.json()) as { summary: any; signature: string };
    const s = doc.summary;
    expect(s).toMatchObject({ agent: o.agent.handle, owner_github: "sc-owner", owner_tier: "verified", house: false, bouts: 3, below_minimum: [], refereed_by: "forge-proving-ground" });
    expect(s.passed).toBe(rows.filter((r) => r.passed).length);
    expect(s.pass_rate).toBeCloseTo(s.passed / 3, 3);
    expect(s.traps_total).toBe(traps.length);
    expect(s.traps_fell_for).toBe(traps.filter((x) => x.triggered).length);
    expect(s.traps_caught + s.traps_fell_for).toBe(s.traps_total);
    expect(s.by_trap.every((x: { id: string }) => /^FA-[A-Z]{3}-\d{3}$/.test(x.id))).toBe(true);
    expect(s.by_family.reduce((n: number, f: { caught: number }) => n + f.caught, 0)).toBe(s.traps_caught);
    expect(s.rules_versions.length).toBeGreaterThan(0);
    expect(s.task_versions).toEqual(["Normal 1.0"]);
    expect(s.bouts_list.map((b: { id: string }) => b.id).sort()).toEqual([...ids].sort());

    // The signature verifies, directly and through the public endpoint; a tampered copy doesn't.
    expect(doc.signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(await verifyScorecard(env.REPORT_SIGNING_KEY, s, doc.signature)).toBe(true);
    const verify = (body: unknown) => fetchWorker("/arena/agent/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await verify(doc)).json()).toEqual({ valid: true });
    expect(await (await verify({ ...doc, summary: { ...s, traps_caught: s.traps_caught + 1 } })).json()).toEqual({ valid: false });

    const badge = await get(`/arena/agent/${o.agent.handle}/badge.svg`);
    expect(badge.status).toBe(200);
    expect(badge.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(badge.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+/);
    expect(await badge.text()).toContain(`caught ${s.traps_caught}/${s.traps_total} traps`);

    const off = await toggle(o.cookie, o.agent.id, "off");
    expect(off.headers.get("Location")).toBe("/dashboard?m=scorecard_off");
    expect((await get(`/arena/agent/${o.agent.handle}`)).status).toBe(404);
    expect((await get(`/arena/agent/${o.agent.handle}.json`)).status).toBe(404);
    expect((await get(`/arena/agent/${o.agent.handle}/badge.svg`)).status).toBe(404);
  });

  it("only the owner can toggle, and only with a valid CSRF token", async () => {
    const o = await owner("sc-victim");
    await bout(o.props);
    const other = await owner("sc-intruder");
    expect((await toggle(other.cookie, o.agent.id, "on")).status).toBe(404);
    expect((await post(`/dashboard/agents/${o.agent.id}/scorecard`, o.cookie, { csrf: "wrong", public: "on" })).status).toBe(403);
    const agent = await getDb(env).query.agents.findFirst({ where: eq(t.agents.id, o.agent.id) });
    expect(agent?.scorecardPublic).toBe(false);
    expect((await get(`/arena/agent/${o.agent.handle}`)).status).toBe(404);
  });

  it("agents without refereed Proving Ground bouts, and headline models, have no page", async () => {
    const o = await owner("sc-no-bouts");
    expect((await dashboard(o.cookie)).body).toContain("Score page: none yet");
    expect((await toggle(o.cookie, o.agent.id, "on")).headers.get("Location")).toBe("/dashboard?m=scorecard_no_bouts");
    // Even if the flag were set, an unfinished bout or no bout means no page.
    await getDb(env).update(t.agents).set({ scorecardPublic: true }).where(eq(t.agents.id, o.agent.id));
    await startChallenge(env, o.props, "impossible");
    expect((await get(`/arena/agent/${o.agent.handle}`)).status).toBe(404);
    expect((await get(`/arena/agent/${o.agent.handle}/badge.svg`)).status).toBe(404);
    // Headline models are run by our runner, not connected agents: there's no handle to show.
    expect((await get("/arena/agent/gpt-5")).status).toBe(404);
  });

  it(`below ${SCORECARD_MIN_BOUTS} bouts it says "Not enough bouts yet" instead of rates`, async () => {
    const o = await owner("sc-early");
    await bout(o.props);
    await toggle(o.cookie, o.agent.id, "on");
    const html = await (await get(`/arena/agent/${o.agent.handle}`)).text();
    expect(html).toContain("Not enough bouts yet");
    expect(html).not.toContain("pass rate");
    const { summary } = (await (await get(`/arena/agent/${o.agent.handle}.json`)).json()) as { summary: any };
    expect(summary).toMatchObject({ bouts: 1, min_bouts: SCORECARD_MIN_BOUTS, below_minimum: ["scorecard_bouts"], pass_rate: null, passed: null, traps_caught: null, by_family: null });
    expect(await (await get(`/arena/agent/${o.agent.handle}/badge.svg`)).text()).toContain("not enough bouts yet");
  });

  it("House agents can have a page, labelled House", async () => {
    const o = await owner("sc-house");
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, o.human.id));
    await bout(o.props);
    await toggle(o.cookie, o.agent.id, "on");
    const html = await (await get(`/arena/agent/${o.agent.handle}`)).text();
    expect(html).toContain(">house</span>");
    expect(html).toContain("House agents");
    const { summary } = (await (await get(`/arena/agent/${o.agent.handle}.json`)).json()) as { summary: any };
    expect(summary.house).toBe(true);
  });
});
