import { TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CLAIM_NOTICE } from "../src/arena/gauntlet-claims";
import { ensureSeason, latestSnapshot, SEASON_1, SEASON_NOTICE, seasonBoard, WEEK, writeSeasonSnapshot } from "../src/arena/season";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { upsertHuman, WEB_AGENT_PREFIX } from "../src/services/identity";
import { growthKpis } from "../src/services/kpis";
import { ownerFunnel } from "../src/services/owner-funnel";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { connectAgent, fetchWorker, profile } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// ADR 0055 (D11, owners first): Gauntlet Season 1, claim links at the end of every run, the one-sign-in claim page,
// and the owner funnel KPIs.

const host = new URL(env.PUBLIC_ORIGIN).host;
let ipN = 10;
const nextIp = () => `198.51.100.${ipN++}`;
const parse = async (res: Response) => {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result as { structuredContent: any; isError?: boolean };
};
const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: host };
const gauntlet = async (name: string, args: unknown, ip: string) =>
  (await parse(await fetchWorker("/mcp/gauntlet", { method: "POST", headers: { ...mcpHeaders, "CF-Connecting-IP": ip }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }))).structuredContent;
async function finish(id: string, ip: string) {
  let last: any;
  for (let i = 0; i < TASKS.length; i++) last = await gauntlet("gauntlet_act", { gauntlet_id: id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }, ip);
  return last;
}
async function finishedRun() {
  const ip = nextIp();
  const start = await gauntlet("gauntlet_start", {}, ip);
  const end = await finish(start.gauntlet_id, ip);
  return { start, end, id: start.gauntlet_id as string, key: start.claim_key as string };
}
const json = async (path: string) => (await fetchWorker(path, { headers: { Accept: "application/json" } })).json() as Promise<any>;

/** A verified person signed in on the website only (no app connected), and their form helpers. */
async function webOwner(over = {}) {
  const human = await upsertHuman(getDb(env), profile(over), Date.now());
  const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, human.id)}`;
  const get = (path: string) => fetchWorker(path, { headers: { Cookie: cookie, Accept: "text/html" } });
  const csrfFor = async (path: string) => /name="csrf" value="([^"]+)"/.exec(await (await get(path)).text())?.[1] ?? "";
  const post = async (path: string, fields: Record<string, string>, csrfPage = "/dashboard") =>
    fetchWorker(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: await csrfFor(csrfPage), ...fields }), redirect: "manual" });
  return { human, cookie, get, post };
}

describe("claim links at the end of a run (ADR 0055)", () => {
  it("puts claim status and a key-free claim_url in the end-of-run result, and the keyed link only in the start result", async () => {
    const { start, end, id, key } = await finishedRun();
    expect(start.claim.url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/claim?run=${id}#${key}`);
    expect(start.claim.url_contains_key).toBe(true);
    const report = end.report;
    expect(report).toMatchObject({ claim_status: "unclaimed", claim_url: `${env.PUBLIC_ORIGIN}/gauntlet/claim?run=${id}`, claim_key_from: "gauntlet_start" });
    expect(report.season).toEqual({ id: "season-1", url: `${env.PUBLIC_ORIGIN}${SEASON_1.path}`, eligible: true, not_eligible_because: null });
    expect(JSON.stringify(report)).not.toContain(key);
    // Data, not instructions (AGENTS.md rule 7).
    for (const v of [report.claim_status, report.claim_url, report.claim_key_from, JSON.stringify(report.season)]) expect(String(v)).not.toMatch(AGENT_DIRECTED);
    // gauntlet_status says the same.
    expect((await gauntlet("gauntlet_status", { gauntlet_id: id }, nextIp())).report.claim_status).toBe("unclaimed");
    // A measured re-run is not claimable and not in the season.
    const ip = nextIp();
    const rerun = await gauntlet("gauntlet_start", { card_from: id }, ip);
    const rend = (await finish(rerun.gauntlet_id, ip)).report;
    expect(rend).toMatchObject({ claim_status: "not_claimable", claim_url: null, season: { eligible: false, not_eligible_because: "measured_rerun" } });
    // A challenge can be claimed but doesn't enter the season.
    const cip = nextIp();
    const ch = await gauntlet("gauntlet_start", { challenge: id }, cip);
    expect((await finish(ch.gauntlet_id, cip)).report).toMatchObject({ claim_status: "unclaimed", season: { eligible: false, not_eligible_because: "challenge" } });
  });
});

describe("the claim page: one GitHub sign-in (ADR 0055)", () => {
  it("signed out: shows the run, both notices and sign-in links that come back here; never the key", async () => {
    const { id, key } = await finishedRun();
    const res = await fetchWorker(`/gauntlet/claim?run=${id}`, { headers: { Accept: "text/html" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`data-claim-run="${id}"`);
    expect(html).toContain("/gauntlet-claim.js");
    expect(html).toContain(CLAIM_NOTICE.replace(/'/g, "&#39;"));
    expect(html).toContain(SEASON_NOTICE.replace(/'/g, "&#39;"));
    expect(html).toContain(`/auth/login?next=${encodeURIComponent(`/gauntlet/claim?run=${id}&season=1`)}`);
    expect(html).not.toContain(key);
    // The sign-in returns to the claim page (the existing safe `next`).
    const login = await fetchWorker(`/auth/login?next=${encodeURIComponent(`/gauntlet/claim?run=${id}&season=1`)}`, { redirect: "manual" });
    expect(login.headers.get("Location")).toContain("github.com/login/oauth/authorize");
  });

  it("signed in with no agent: one click claims onto a new profile and enters Season 1; the first app connected later takes the profile over", async () => {
    const owner = await webOwner();
    const { id, key } = await finishedRun();
    const page = await (await owner.get(`/gauntlet/claim?run=${id}`)).text();
    expect(page).toContain('data-auto="1"');
    expect(page).toContain("A new profile for this agent");
    const res = await owner.post("/gauntlet/claim", { run: id, agent: "new", claim_key: key, season: "1" }, `/gauntlet/claim?run=${id}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/gauntlet/claim?run=${id}&m=claimed_new_season`);
    const [agent] = await getDb(env).select().from(t.agents).where(eq(t.agents.humanId, owner.human.id));
    expect(agent!.oauthClientId.startsWith(WEB_AGENT_PREFIX)).toBe(true);
    // On the board and the agent's page, with badges.
    const season = await json(`${SEASON_1.path}.json`);
    expect(season.entries.find((e: any) => e.agent === agent!.handle)).toMatchObject({ jobs_total: 6, challenge_url: `${env.PUBLIC_ORIGIN}/gauntlet/challenge/${id}` });
    expect(season.prizes).toBeNull();
    const profileJson = await json(`/a/${agent!.handle}`);
    expect(profileJson.gauntlet.claimed_runs).toBe(1);
    expect(profileJson.season.badges.map((b: any) => b.id)).toContain("season-1-entrant");
    expect((await json(`/gauntlet/r/${id}?format=json`)).season.badges[0].label).toBe("Season 1 entrant");
    // The end-of-run status now says claimed, with no claim link.
    expect((await gauntlet("gauntlet_status", { gauntlet_id: id }, nextIp())).report).toMatchObject({ claim_status: "claimed", claim_url: null });
    // Connecting an app later reuses this profile: still one agent for this owner.
    const app = await connectAgent({ profile: { id: owner.human.githubId, login: owner.human.githubLogin, created_at: "2020-01-01T00:00:00Z", public_repos: 3, public_gists: 0, followers: 1 }, clientName: "Cursor" });
    expect(app.agent.id).toBe(agent!.id);
    expect(app.agent.framework).toBe("cursor");
    expect((await getDb(env).select().from(t.agents).where(eq(t.agents.humanId, owner.human.id))).length).toBe(1);
  });

  it("claims for the owner's only agent, or claims only; a challenge is claimed but not entered", async () => {
    const owner = await connectAgent();
    const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, owner.human.id)}`;
    const page = await (await fetchWorker(`/gauntlet/claim?run=${(await finishedRun()).id}`, { headers: { Cookie: cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const post = (fields: Record<string, string>) => fetchWorker("/gauntlet/claim", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    const only = await finishedRun();
    expect((await post({ run: only.id, agent: owner.agent.id, claim_key: only.key, season: "0" })).headers.get("Location")).toBe(`/gauntlet/claim?run=${only.id}&m=claimed`);
    expect((await getDb(env).select().from(t.gauntletSeasonEntries).where(eq(t.gauntletSeasonEntries.gauntletId, only.id))).length).toBe(0);
    // The share link can't claim.
    const other = await finishedRun();
    expect((await post({ run: other.id, agent: owner.agent.id, claim_key: other.id, season: "1" })).headers.get("Location")).toBe(`/gauntlet/claim?run=${other.id}&m=claim_key_invalid`);
    const ip = nextIp();
    const ch = await gauntlet("gauntlet_start", { challenge: other.id }, ip);
    await finish(ch.gauntlet_id, ip);
    expect((await post({ run: ch.gauntlet_id, agent: owner.agent.id, claim_key: ch.claim_key, season: "1" })).headers.get("Location")).toBe(`/gauntlet/claim?run=${ch.gauntlet_id}&m=season_challenge`);
    // Without the session's CSRF token, nothing happens.
    const forged = await fetchWorker("/gauntlet/claim", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "x", run: other.id, agent: owner.agent.id, claim_key: other.key }) });
    expect(forged.status).toBe(403);
  });

  it("refuses a sandbox owner with plain steps, and counts the refusal", async () => {
    const owner = await webOwner({ public_repos: 0, followers: 0 });
    expect(owner.human.tier).toBe("sandbox");
    const { id, key } = await finishedRun();
    const html = await (await owner.get(`/gauntlet/claim?run=${id}`)).text();
    expect(html).toContain("Only verified people can claim a run");
    const res = await owner.post("/gauntlet/claim", { run: id, agent: "new", claim_key: key, season: "1" });
    expect(res.status, await res.clone().text()).toBe(303);
    expect(res.headers.get("Location")).toBe(`/gauntlet/claim?run=${id}&m=claim_needs_verified_owner`);
    expect((await getDb(env).select().from(t.agents).where(eq(t.agents.humanId, owner.human.id))).length).toBe(0);
  });

  it("from a check (CLI, plugin, Action): a profile page with one sign-in link and the two ways to fill it", async () => {
    const html = await (await fetchWorker("/gauntlet/claim?from=cli", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("Claim your agent&#39;s profile");
    expect(html).toContain(`/auth/login?next=${encodeURIComponent("/gauntlet/claim?from=cli")}`);
    expect(html).toContain("/connect");
  });
});

describe("Gauntlet Season 1 (ADR 0055)", () => {
  it("one entry per verified owner (their best run), House and founders left out, hidden and withdrawn runs off the board", async () => {
    const db = getDb(env);
    const s = await ensureSeason(db);
    expect(s.endsAt).toBe(Date.UTC(2027, 0, 1));
    const a = await webOwner();
    const b = await webOwner();
    const house = await webOwner();
    await db.update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, house.human.id));
    const claimEnter = async (o: Awaited<ReturnType<typeof webOwner>>, agent: string) => {
      const r = await finishedRun();
      const res = await o.post("/gauntlet/claim", { run: r.id, agent, claim_key: r.key, season: "1" }, `/gauntlet/claim?run=${r.id}`);
      expect(res.headers.get("Location")).toMatch(/m=claimed(_new)?_season$/);
      return r.id;
    };
    const a1 = await claimEnter(a, "new");
    const [aAgent] = await db.select().from(t.agents).where(eq(t.agents.humanId, a.human.id));
    // A second, better run for owner a (set its summary as the referee would have, 6 of 6 and no traps).
    const a2 = await claimEnter(a, aAgent!.id);
    const [row] = await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, a2));
    await db.update(t.arenaGauntlets).set({ summary: { ...(row!.summary as object), passed: 6, traps_fell: 0 } }).where(eq(t.arenaGauntlets.id, a2));
    await claimEnter(b, "new");
    const h1 = await claimEnter(house, "new");

    let board = await seasonBoard(env, s);
    const mine = board.entries.filter((e) => e.agent_id === aAgent!.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ gauntlet_id: a2, passed: 6, clean_sweep: true, runs_entered: 2 });
    expect(board.entries.some((e) => e.gauntlet_id === h1)).toBe(false);
    // Ranks: 6 of 6 is above the 0-of-6 runs, which share a rank.
    expect(mine[0]!.rank).toBe(1);
    for (const e of board.entries) for (const f of board.entries) if (e.passed === f.passed && e.traps_fell === f.traps_fell) expect(e.rank).toBe(f.rank);
    const badges = (await json(`/a/${aAgent!.handle}`)).season;
    expect(badges.badges.map((x: any) => x.id)).toEqual(["season-1-entrant", "season-1-rank", "season-1-clean-sweep"]);
    // The page: rules in plain English, the board, "Take this challenge" links, no prizes.
    const html = await (await fetchWorker(SEASON_1.path, { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("The rules, in plain English");
    expect(html).toContain(`/gauntlet/challenge/${a2}`);
    expect(html).toContain("No prizes and no money");
    expect(html).toContain(aAgent!.handle);

    // Hidden: off the board. Shown again: back. Withdrawn from the season (dashboard): off.
    expect((await a.post(`/dashboard/gauntlet/${a2}/hidden`, { hidden: "on" }, "/dashboard")).status).toBe(303);
    board = await seasonBoard(env, s);
    expect(board.entries.find((e) => e.agent_id === aAgent!.id)!.gauntlet_id).toBe(a1);
    await a.post(`/dashboard/gauntlet/${a2}/hidden`, { hidden: "off" }, "/dashboard");
    expect((await a.post("/gauntlet/claim/season", { run: a2, season: "leave", back: "dashboard" }, "/dashboard")).headers.get("Location")).toBe("/dashboard?m=season_left");
    board = await seasonBoard(env, s);
    expect(board.entries.find((e) => e.agent_id === aAgent!.id)!.gauntlet_id).toBe(a1);
    expect((await a.post("/gauntlet/claim/season", { run: a2, season: "enter", back: "dashboard" }, "/dashboard")).headers.get("Location")).toBe("/dashboard?m=season_entered");
    // Someone else can't enter or withdraw your run.
    expect((await b.post("/gauntlet/claim/season", { run: a2, season: "leave" })).headers.get("Location")).toContain("m=not_claimed_by_owner");
    expect((await (await a.get("/dashboard")).text())).toContain("Season 1");
  });

  it("freezes a weekly snapshot once, and shows it without runs hidden since", async () => {
    const db = getDb(env);
    const s = await ensureSeason(db);
    const o = await webOwner();
    const r = await finishedRun();
    await o.post("/gauntlet/claim", { run: r.id, agent: "new", claim_key: r.key, season: "1" }, `/gauntlet/claim?run=${r.id}`);
    const at = s.startsAt + WEEK + 3_600_000;
    const w = await writeSeasonSnapshot(env, at);
    expect(w).toMatchObject({ written: true, week: 1 });
    expect((await writeSeasonSnapshot(env, at + 3_600_000)).written).toBe(false);
    expect((await writeSeasonSnapshot(env, s.startsAt + 3_600_000)).written).toBe(false);
    let snap = await latestSnapshot(env, s);
    expect(snap!.week).toBe(1);
    expect(snap!.entries.some((e) => e.gauntlet_id === r.id)).toBe(true);
    await o.post(`/dashboard/gauntlet/${r.id}/hidden`, { hidden: "on" }, "/dashboard");
    snap = await latestSnapshot(env, s);
    expect(snap!.entries.some((e) => e.gauntlet_id === r.id)).toBe(false);
  });
});

describe("owner funnel KPIs (ADR 0055)", () => {
  it("adds verified owners with the funnel in its detail, and shows it on /admin/kpis only", async () => {
    const f = await ownerFunnel(env, Date.now() + 86_400_000);
    expect(Object.keys(f.stages)).toEqual(["runs_finished", "claim_link_shown", "claim_page_opened", "claimed", "verified_owners_claimed"]);
    expect(f.stages.runs_finished).toBeGreaterThan(0);
    expect(f.stages.claim_link_shown).toBeGreaterThan(0);
    expect(f.season.id).toBe("season-1");
    expect(f.claim_page_by_source).toHaveProperty("run");
    const k = await growthKpis(env, Date.now() + 86_400_000);
    const v = k.kpis.find((x) => x.id === "verified_owners")!;
    expect(v).toMatchObject({ first: 100, unit: "owners" });
    expect(v.detail).toHaveProperty("agents_per_owner");
    // Existing KPIs are unchanged.
    expect(k.kpis.find((x) => x.id === "verified_agents")!.detail).toHaveProperty("agents_per_human");
    // Not on a public page.
    expect((await (await fetchWorker("/admin/kpis", { redirect: "manual" })).status)).toBe(302);
  });
});
