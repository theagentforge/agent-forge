import { TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { approveLogin, upsertHuman, vouch } from "../src/services/identity";
import { growthKpis } from "../src/services/kpis";
import { FOUNDING_LIMIT, FOUNDING_LIST_OPENS_AT, foundingList, foundingListOpen, joinFounding, purgeOnOpenOrClose, leaveFounding, normalizeFrom, ownerActivity, reviewQueue, signInFrom, syncOwners } from "../src/services/owners";
import { BOOK_MAILTO } from "../src/web/founding";
import { claimRun, MAX_PENDING_CLAIMS, promotePendingClaims } from "../src/arena/gauntlet-claims";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { authorizeUrl, connectAgent, exchangeCode, fetchWorker, postReport, profile, registerClient, report } from "./helpers";
import "../src/index";

// ADR 0073: the owner acquisition plan's OA-01 (where owners came from, active owners, connected vs web-only),
// OA-06 (claim now, counted once verified, weekly review queue) and OA-07 (Founding Owners, /founding).

afterEach(() => vi.restoreAllMocks());
const db = () => getDb(env);
const today = () => new Date().toISOString().slice(0, 10);
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const counter = async (key: string) => Number((await db().select().from(t.usageDaily).where(and(eq(t.usageDaily.key, key), eq(t.usageDaily.day, today()))))[0]?.n ?? 0);
const human = async (id: string) => (await db().query.humans.findFirst({ where: eq(t.humans.id, id) }))!;

function mockGithub(p: ReturnType<typeof profile>) {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_x" });
    if (url === "https://api.github.com/user") return Response.json(p);
    if (url.startsWith("https://api.github.com/users/")) return Response.json([]);
    return realFetch(input, init);
  });
}

/** The real website sign-in (/auth/login → GitHub, mocked → /callback/web), with an optional `from` on the link. */
async function webLogin(p: ReturnType<typeof profile>, query = "") {
  const start = await fetchWorker(`/auth/login${query}`, { redirect: "manual" });
  const gh = new URL(start.headers.get("Location")!);
  mockGithub(p);
  const hop = await fetchWorker(`/callback?code=c&state=${gh.searchParams.get("state")}`, { redirect: "manual" });
  const cb = await fetchWorker(hop.headers.get("Location")!, { headers: { Cookie: cookiesFrom(start) }, redirect: "manual" });
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-forge_session="))!.split(";")[0]!;
  vi.restoreAllMocks();
  return cookie;
}

/** The real agent connection (consent → GitHub, mocked → /callback), as an app connecting to /mcp does. */
async function oauthConnect(p: ReturnType<typeof profile>) {
  const clientId = await registerClient("Claude Code");
  const verifier = "v".repeat(43);
  const url = new URL(await authorizeUrl(clientId, verifier, "s"));
  const consent = await fetchWorker(url.pathname + url.search);
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]!;
  const approve = await fetchWorker("/authorize", { method: "POST", headers: { Cookie: cookiesFrom(consent), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision: "approve" }), redirect: "manual" });
  const github = new URL(approve.headers.get("Location")!);
  mockGithub(p);
  const callback = await fetchWorker(`/callback?code=c&state=${github.searchParams.get("state")}`, { headers: { Cookie: cookiesFrom(approve) }, redirect: "manual" });
  vi.restoreAllMocks();
  const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
  return exchangeCode(clientId, code, verifier);
}

const asCookie = async (humanId: string) => `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, humanId)}`;
const get = async (path: string, cookie = "") => (await fetchWorker(path, { headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) } })).text();
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const post = async (path: string, cookie: string, fields: Record<string, string>, csrfPage = "/dashboard") =>
  fetchWorker(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: csrfOf(await get(csrfPage, cookie)), ...fields }), redirect: "manual" });

// The Gauntlet over its no-account MCP endpoint, for claim keys.
const host = new URL(env.PUBLIC_ORIGIN).host;
let ipN = 40;
const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: host };
const parse = async (res: Response) => {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result.structuredContent;
};
const gauntlet = async (name: string, args: unknown, ip: string) =>
  parse(await fetchWorker("/mcp/gauntlet", { method: "POST", headers: { ...mcpHeaders, "CF-Connecting-IP": ip }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
async function finishedRun() {
  const ip = `192.0.2.${ipN++}`;
  const start = await gauntlet("gauntlet_start", {}, ip);
  for (let i = 0; i < TASKS.length; i++) await gauntlet("gauntlet_act", { gauntlet_id: start.gauntlet_id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }, ip);
  return { id: start.gauntlet_id as string, key: start.claim_key as string };
}

const sandbox = (over = {}) => profile({ public_repos: 0, public_gists: 0, followers: 0, ...over });
const founderProfile = () => profile({ id: Number(env.ADMIN_GITHUB_IDS) });

describe("OA-01: where owners came from", () => {
  it("normalises the from tag: known tags and hackathon slugs kept, anything else is other", () => {
    expect(normalizeFrom("founding")).toBe("founding");
    expect(normalizeFrom("Skills-SH")).toBe("skills-sh");
    expect(normalizeFrom("hackathon:sl-ai-club")).toBe("hackathon:sl-ai-club");
    expect(normalizeFrom("hackathon:Bad Slug!")).toBe("other");
    expect(normalizeFrom("twitter")).toBe("other");
    expect(normalizeFrom("")).toBeNull();
    expect(signInFrom(undefined, "/gauntlet/claim?from=cli&back=1")).toBe("cli");
    expect(signInFrom("plugin", "/gauntlet/claim?from=cli")).toBe("plugin");
    expect(signInFrom(undefined, "/dashboard")).toBeNull();
  });

  it("a fresh outside verified person who signs in via ?from=founding and connects an agent writes owner:new:founding once", async () => {
    const p = profile();
    const before = await counter("owner:new:founding");
    await webLogin(p, "?from=founding&next=/founding");
    const h = (await db().query.humans.findFirst({ where: eq(t.humans.githubId, p.id) }))!;
    expect(h.firstFrom).toBe("founding");
    expect(h.ownerSince).toBeNull(); // signed in, no agent yet: not an owner
    expect(await counter("owner:new:founding")).toBe(before);
    const token = await oauthConnect(p);
    expect(token).toBeTruthy();
    const after = await human(h.id);
    expect(after.ownerSince).not.toBeNull();
    expect(after.ownerNumber).toBeGreaterThan(0);
    expect(await counter("owner:new:founding")).toBe(before + 1);
    // A later sign-in with another tag never changes the first touch, and never counts the person again.
    await webLogin(p, "?from=plugin");
    await syncOwners(env);
    expect((await human(h.id)).firstFrom).toBe("founding");
    expect(await counter("owner:new:founding")).toBe(before + 1);
    expect(await counter("owner:new:plugin")).toBe(0);
  });

  it("counts an unknown from as other", async () => {
    const p = profile();
    await webLogin(p, "?from=some-newsletter");
    const h = (await db().query.humans.findFirst({ where: eq(t.humans.githubId, p.id) }))!;
    expect(h.firstFrom).toBe("other");
    const before = await counter("owner:new:other");
    await oauthConnect(p);
    expect(await counter("owner:new:other")).toBe(before + 1);
  });

  it("never counts House or founder accounts, and never numbers them", async () => {
    const hp = profile();
    await webLogin(hp, "?from=hackathon:house-check");
    const houseRow = (await db().query.humans.findFirst({ where: eq(t.humans.githubId, hp.id) }))!;
    await db().update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, houseRow.id));
    await oauthConnect(hp);
    const fp = founderProfile();
    await webLogin(fp, "?from=hackathon:house-check");
    await oauthConnect(fp);
    await syncOwners(env);
    expect(await counter("owner:new:hackathon:house-check")).toBe(0);
    expect((await human(houseRow.id)).ownerNumber).toBeNull();
    const founder = (await db().query.humans.findFirst({ where: eq(t.humans.githubId, fp.id) }))!;
    expect(founder.ownerNumber).toBeNull();
  });

  it("splits connected-app owners from web-only owners, and counts active owners over 30 days from a fixture", async () => {
    const before = await ownerActivity(env);
    // Web-only and active: a report filed on the website (its agent is the web agent).
    const web = await upsertHuman(db(), profile(), Date.now());
    const cookie = await asCookie(web.id);
    const filed = await post("/report", cookie, { tool: "npm:@acme/web-only", version: "1.0.0", fp: `sha256:${"c".repeat(64)}`, kind: "mcp_server", agent: "web", outcome: "worked", category: "general", framework: "claude-code" });
    expect(filed.status, await filed.clone().text()).toBe(200);
    // Connected and active: a signed-in report through the API.
    const active = await connectAgent();
    expect((await postReport(active.token, report({ tool: { kind: "mcp_server", id: "npm:@acme/active-owner", version: "1.0.0", fingerprint: `sha256:${"d".repeat(64)}` } }))).status).toBe(201);
    // Connected and idle: an agent, nothing done in 30 days.
    const idle = await connectAgent();
    await db().update(t.agents).set({ createdAt: Date.now() - 60 * 86_400_000 }).where(eq(t.agents.id, idle.agent.id));
    const after = await ownerActivity(env);
    expect(after.owners - before.owners).toBe(3);
    expect(after.active - before.active).toBe(2);
    expect(after.connected.owners - before.connected.owners).toBe(2);
    expect(after.connected.active - before.connected.active).toBe(1);
    expect(after.web_only.owners - before.web_only.owners).toBe(1);
    expect(after.web_only.active - before.web_only.active).toBe(1);
  });

  it("puts owners by source and active owners on /admin/kpis (founder only), and active owners on /stats with the below-10 gate", async () => {
    const k = await growthKpis(env);
    const active = k.kpis.find((x) => x.id === "active_owners")!;
    const sources = k.kpis.find((x) => x.id === "owners_by_source")!;
    expect(active.value).toBe((await ownerActivity(env)).active);
    expect(sources.detail).toHaveProperty("by_source");
    const fp = founderProfile();
    const founder = (await db().query.humans.findFirst({ where: eq(t.humans.githubId, fp.id) })) ?? (await upsertHuman(db(), fp, Date.now()));
    const admin = await get("/admin/kpis", await asCookie(founder.id));
    expect(admin).toContain("Owners: where they came from, and whether they stay");
    expect(admin).toContain("Web-only (a website report or a claim profile)");
    // ADR 0067 Amendment 1 (Dinike, 28 Oct): active owners are internal now, on /admin/kpis only.
    expect(admin).toContain("Active owners, last 30 days (outside the project)");
    const stats = await get("/stats");
    expect(stats).not.toContain("Active owners");
    const json = (await (await fetchWorker("/stats.json")).json()) as any;
    // F-02: the whole outside-only people table is internal now (null, listed in internal_only).
    expect(json.now).toBeNull();
    expect(json.internal_only).toContain("active_owners_30d");
    const api = (await (await fetchWorker("/api/v1/stats")).json()) as any;
    expect(api.active_owners_30d).toBeNull();
    const rules = await get("/stats/rules");
    expect(rules).not.toContain('id="active_owners_30d"');
    // Versions 2.0 and 2.1 say what changed; the rules and their SQL move to the admin JSON with the other internal numbers.
    expect(rules).toContain("<b>2.1</b> (2026-10-28)");
    expect(rules).toContain("<b>2.0</b> (2026-10-28)");
    expect(rules).toContain("<b>1.1</b> (2026-10-28): Added active_owners_30d");
    const rj = (await (await fetchWorker("/stats/rules?format=json")).json()) as any;
    expect(rj.version).toBe("2.4");
    expect(rj.changes[0].version).toBe("2.4");
    expect(rj.rules.some((r: any) => r.key === "active_owners_30d")).toBe(false);
    const internal = (await (await fetchWorker("/admin/stats/third-party.json", { headers: { Cookie: await asCookie(founder.id) } })).json()) as any;
    const sql = internal.rules.find((r: any) => r.key === "active_owners_30d").reproduce as string;
    expect(sql).toMatch(/^SELECT count\(DISTINCT h\.id\)/);
    // The SQL gives the same number as the code.
    const now = Date.now();
    const filled = sql
      .replaceAll("<ADMIN_GITHUB_IDS>", env.ADMIN_GITHUB_IDS)
      .replaceAll("<now - 30 days, YYYY-MM-DD>", new Date(now - 30 * 86_400_000).toISOString().slice(0, 10))
      .replaceAll("<now - 30 days, ms>", String(now - 30 * 86_400_000));
    const row = await env.DB.prepare(filled).first<Record<string, number>>();
    expect(Object.values(row!)[0]).toBe((await ownerActivity(env, now)).active);
  });
});

describe("OA-06: claim now, counted once verified", () => {
  it("stores a sandbox person's claim as pending (verified_owners unchanged, score page 404); a vouch counts it once", async () => {
    const p = sandbox();
    const s = await upsertHuman(db(), p, Date.now());
    expect(s.tier).toBe("sandbox");
    await db().update(t.humans).set({ firstFrom: "hackathon:vouch-test" }).where(eq(t.humans.id, s.id));
    const cookie = await asCookie(s.id);
    const run = await finishedRun();
    const ownersBefore = (await growthKpis(env)).kpis.find((x) => x.id === "verified_owners")!.value;
    const res = await post("/gauntlet/claim", cookie, { run: run.id, agent: "new", claim_key: run.key, season: "0" });
    expect(res.headers.get("Location")).toBe(`/gauntlet/claim?run=${run.id}&m=pending`);
    expect((await db().select().from(t.pendingClaims).where(eq(t.pendingClaims.gauntletId, run.id))).length).toBe(1);
    expect((await growthKpis(env)).kpis.find((x) => x.id === "verified_owners")!.value).toBe(ownersBefore);
    expect((await fetchWorker(`/score/${run.id}`)).status).toBe(404);
    expect((await fetchWorker(`/badge/score/${run.id}.svg`)).status).toBe(404);
    expect(await get("/scores/recent.json")).not.toContain(run.id);
    // Shown privately on their own dashboard, with the two ways forward.
    const dash = await get("/dashboard", cookie);
    expect(dash).toContain("Not counted yet");
    expect(dash).toContain(run.id.slice(1, 9));
    expect(dash).toContain("Request a review");
    expect(dash).toContain(p.login);
    // Someone else can't take the run meanwhile (only the key holder could anyway).
    const other = await connectAgent();
    const taken = await post("/gauntlet/claim", await asCookie(other.human.id), { run: run.id, agent: other.agent.id, claim_key: run.key, season: "0" });
    expect(taken.headers.get("Location")).toBe(`/gauntlet/claim?run=${run.id}&m=already_claimed`);

    // A verified person vouches: the claim counts, and owner:new is written once.
    const voucher = await connectAgent();
    expect(await counter("owner:new:hackathon:vouch-test")).toBe(0);
    const v = await post("/dashboard/vouch", await asCookie(voucher.human.id), { github_login: p.login });
    expect(v.headers.get("Location")).toBe("/dashboard?m=vouched");
    expect((await human(s.id)).tier).toBe("verified");
    expect((await db().select().from(t.pendingClaims).where(eq(t.pendingClaims.gauntletId, run.id))).length).toBe(0);
    const [claim] = await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id));
    expect(claim!.humanId).toBe(s.id);
    expect(await counter("owner:new:hackathon:vouch-test")).toBe(1);
    expect((await fetchWorker(`/score/${run.id}`)).status).toBe(200);
    await syncOwners(env);
    expect(await counter("owner:new:hackathon:vouch-test")).toBe(1);
  });

  it("an approval from the weekly review queue flips a pending claim to counted; the queue shows only people who asked, login and account age only", async () => {
    const asked = await upsertHuman(db(), sandbox({ created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() }), Date.now());
    const quiet = await upsertHuman(db(), sandbox(), Date.now());
    const cookie = await asCookie(asked.id);
    const run = await finishedRun();
    await post("/gauntlet/claim", cookie, { run: run.id, agent: "new", claim_key: run.key, season: "0" });
    expect((await post("/dashboard/review-request", cookie, {})).headers.get("Location")).toBe("/dashboard?m=review_requested");
    expect((await post("/dashboard/review-request", cookie, {})).headers.get("Location")).toBe("/dashboard?m=review_already_requested");
    const q = await reviewQueue(db());
    const row = q.find((x) => x.github_login === asked.githubLogin)!;
    expect(Object.keys(row).sort()).toEqual(["account_age_days", "github_login", "human_id", "requested_at"]);
    expect(row.account_age_days).toBe(10);
    expect(q.some((x) => x.github_login === quiet.githubLogin)).toBe(false);

    const fp = founderProfile();
    const founder = (await db().query.humans.findFirst({ where: eq(t.humans.githubId, fp.id) })) ?? (await upsertHuman(db(), fp, Date.now()));
    const fcookie = await asCookie(founder.id);
    // Not for anyone else.
    expect((await fetchWorker("/admin/owners", { headers: { Cookie: cookie }, redirect: "manual" })).status).toBe(302);
    const page = await get("/admin/owners", fcookie);
    expect(page).toContain(`@${asked.githubLogin}`);
    expect(page).not.toContain(`@${quiet.githubLogin}`);
    const res = await post("/admin/owners/decide", fcookie, { human: asked.id, decision: "approve" }, "/admin/owners");
    expect(res.headers.get("Location")).toBe("/admin/owners?m=approved");
    expect((await human(asked.id)).verifiedVia).toBe("approval");
    expect((await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id))).length).toBe(1);
    expect((await reviewQueue(db())).some((x) => x.human_id === asked.id)).toBe(false);
    // Skip closes a request without verifying anyone.
    const skip = await upsertHuman(db(), sandbox(), Date.now());
    await post("/dashboard/review-request", await asCookie(skip.id), {});
    expect((await post("/admin/owners/decide", fcookie, { human: skip.id, decision: "skip" }, "/admin/owners")).headers.get("Location")).toBe("/admin/owners?m=skipped");
    expect((await human(skip.id)).tier).toBe("sandbox");
  });

  it("a vouch given before the person signs in counts their claim when they next sign in", async () => {
    const p = sandbox();
    const s = await upsertHuman(db(), p, Date.now());
    const run = await finishedRun();
    await post("/gauntlet/claim", await asCookie(s.id), { run: run.id, agent: "new", claim_key: run.key, season: "0" });
    // The vouch is recorded by login (the vouch() service alone, with no sync), so nothing counts yet.
    const voucher = await connectAgent();
    expect((await vouch(db(), voucher.human.id, p.login, Date.now())).ok).toBe(true);
    expect((await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id))).length).toBe(0);
    await webLogin(p);
    expect((await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id))).length).toBe(1);
  });
});

describe("OA-07: Founding Owners", () => {
  it("/founding: the checklist, the mailto, recognition only (no price, prize or money words)", async () => {
    const html = await get("/founding");
    expect(html).toContain("Three steps");
    expect(html).toContain("Connect your agent");
    expect(html).toContain("Link it to you");
    expect(html).toContain("Optional: run the Gauntlet");
    expect(html).toContain("Book 15 minutes with Dinike");
    expect(BOOK_MAILTO).toMatch(/^mailto:hello@theagentforge\.io\?subject=/);
    expect(html).toContain(BOOK_MAILTO.replace(/&/g, "&amp;"));
    expect(html).not.toMatch(/<form[^>]*action="[^"]*book/i);
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b(price|pricing|prices|prize|prizes|money|cash|paid|pay|payment|reward|rewards|discount|fee|fees|free|cost|costs|\$|usd|dollar|credit|credits|win|winner)\b/i);
    expect(text).not.toMatch(/[$€£]/);
    expect(text).not.toMatch(/social network/i);
  });

  it("only owners who opt in appear; numbers follow the date they became owners, stay stable and are never reused", async () => {
    await syncOwners(env);
    const a = await connectAgent();
    await syncOwners(env, Date.now());
    const b = await connectAgent();
    await syncOwners(env, Date.now() + 1);
    const na = (await human(a.human.id)).ownerNumber!;
    const nb = (await human(b.human.id)).ownerNumber!;
    expect(nb).toBeGreaterThan(na);
    // B doesn't opt in: never listed, no label.
    expect(await joinFounding(env, a.human.id)).toEqual({ ok: true, number: na });
    let list = await foundingList(env);
    expect(list.find((x) => x.github === a.human.githubLogin)?.number).toBe(na);
    expect(list.some((x) => x.github === b.human.githubLogin)).toBe(false);
    expect(await get(`/a/${b.agent.handle}`)).not.toContain("Founding owner #");
    // The label on A's agent page (HTML and JSON).
    // F-02: "Founding owner #n" only once the /founding list is open; until then a plain "Founding owner".
    const isOpen = await foundingListOpen(env);
    const labelA = isOpen ? `Founding owner #${na}` : "Founding owner";
    expect(await get(`/a/${a.agent.handle}`)).toContain(`>${labelA}</a>`);
    const aj = (await (await fetchWorker(`/a/${a.agent.handle}`, { headers: { Accept: "application/json" } })).json()) as any;
    expect(aj.founding_owner).toMatchObject({ number: isOpen ? na : null, label: labelA });
    // A leaves: off the list, and nobody gets the number; a new owner gets a higher one.
    await leaveFounding(env, a.human.id);
    list = await foundingList(env);
    expect(list.some((x) => x.github === a.human.githubLogin)).toBe(false);
    const c = await connectAgent();
    await syncOwners(env, Date.now() + 2);
    expect((await human(c.human.id)).ownerNumber).toBeGreaterThan(nb);
    expect((await human(a.human.id)).ownerNumber).toBe(na);
    // Joining again shows the same number.
    expect(await joinFounding(env, a.human.id)).toEqual({ ok: true, number: na });
    // F-02: the public list stays closed below 10 opted-in owners (its length would be an outside-only count), but A
    // still sees their own number and the leave form.
    if ((await foundingList(env)).length < 10) {
      const page = await get("/founding");
      expect(page).not.toContain(`@${a.human.githubLogin}`);
      expect(page).toContain("Founding owners will be listed here");
    } else expect(await get("/founding")).toContain(`@${a.human.githubLogin}`);
    expect(await get("/founding", await asCookie(a.human.id))).toContain((await foundingListOpen(env)) ? `Founding owner #${na}` : "a Founding owner");
  });

  it("joins through the page with its own notice, and shows the label on the run's score page", async () => {
    const owner = await connectAgent();
    await syncOwners(env);
    const cookie = await asCookie(owner.human.id);
    const page = await get("/founding", cookie);
    expect(page).toContain("If you join the Founding Owners list");
    expect(page).toContain("Join the list");
    const res = await post("/founding/join", cookie, {}, "/founding");
    expect(res.headers.get("Location")).toBe("/founding?m=joined");
    const n = (await human(owner.human.id)).ownerNumber!;
    const run = await finishedRun();
    await post("/gauntlet/claim", cookie, { run: run.id, agent: owner.agent.id, claim_key: run.key, season: "0" });
    const isOpen = await foundingListOpen(env);
    expect(await get(`/score/${run.id}`)).toContain(`>${isOpen ? `Founding owner #${n}` : "Founding owner"}</a>`);
    const sj = (await (await fetchWorker(`/score/${run.id}.json`)).json()) as any;
    expect(sj.founding_owner).toBe(isOpen ? n : null);
    expect(sj.founding_owner_label).toBe(isOpen ? `Founding owner #${n}` : "Founding owner");
  });

  it("refuses House and founder accounts, sandbox people, and numbers above 100", async () => {
    const fp = founderProfile();
    const founder = (await db().query.humans.findFirst({ where: eq(t.humans.githubId, fp.id) })) ?? (await upsertHuman(db(), fp, Date.now()));
    expect(await joinFounding(env, founder.id)).toEqual({ ok: false, error: "ours" });
    const house = await connectAgent();
    await db().update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, house.human.id));
    expect(await joinFounding(env, house.human.id)).toEqual({ ok: false, error: "ours" });
    const s = await upsertHuman(db(), sandbox(), Date.now());
    expect(await joinFounding(env, s.id)).toEqual({ ok: false, error: "not_an_owner" });
    // An approved owner (not a founder) is fine.
    const ok = await connectAgent();
    await approveLogin(db(), ok.human.githubLogin, Date.now());
    await syncOwners(env);
    const r = await joinFounding(env, ok.human.id);
    expect(r.ok).toBe(true);
    const late = await connectAgent();
    await syncOwners(env);
    await db().update(t.humans).set({ ownerNumber: 100_000 + Math.floor(Math.random() * 1000) }).where(eq(t.humans.id, late.human.id));
    expect(await joinFounding(env, late.human.id)).toEqual({ ok: false, error: "number_over_limit" });
    expect(FOUNDING_LIMIT).toBe(100);
  });
});

describe("ADR 0073 review: pending claims can't be lost, squatted or made public against the owner's wish", () => {
  it("a run claimed for real meanwhile wins: promoting the stale pending claim makes no empty profile and no owner", async () => {
    const s = await upsertHuman(db(), sandbox(), Date.now());
    const run = await finishedRun();
    expect((await claimRun(env, s.id, "new", run.key)).ok).toBe(true);
    // A verified person's claim landed at the same moment (as a race would leave it).
    const other = await connectAgent();
    await db().insert(t.gauntletClaims).values({ gauntletId: run.id, agentId: other.agent.id, humanId: other.human.id, hidden: false, claimedAt: Date.now() });
    await approveLogin(db(), s.githubLogin, Date.now());
    await promotePendingClaims(env);
    expect((await db().select().from(t.agents).where(eq(t.agents.humanId, s.id))).length).toBe(0);
    expect((await db().select().from(t.pendingClaims).where(eq(t.pendingClaims.gauntletId, run.id))).length).toBe(0);
    const [claim] = await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id));
    expect(claim!.humanId).toBe(other.human.id);
    await syncOwners(env);
    expect((await human(s.id)).ownerSince).toBeNull();
  });

  it("a pending claim can't be written over a real claim, and another person's pending row is never changed", async () => {
    const a = await upsertHuman(db(), sandbox(), Date.now());
    const b = await upsertHuman(db(), sandbox(), Date.now());
    const run = await finishedRun();
    expect((await claimRun(env, a.id, "new", run.key)).ok).toBe(true);
    expect(await claimRun(env, b.id, "new", run.key)).toEqual({ ok: false, error: "already_claimed" });
    const [row] = await db().select().from(t.pendingClaims).where(eq(t.pendingClaims.gauntletId, run.id));
    expect(row!.humanId).toBe(a.id);
  });

  it("gauntlet_claim with hidden: true while pending stays hidden once it counts (no score page, not on the agent page)", async () => {
    const p = sandbox();
    const s = await connectAgent({ profile: p });
    expect(s.human.tier).toBe("sandbox");
    const run = await finishedRun();
    const r = await claimRun(env, s.human.id, s.agent.id, run.key, Date.now(), { hidden: true });
    expect(r).toMatchObject({ ok: true, pending: true });
    const voucher = await connectAgent();
    expect((await post("/dashboard/vouch", await asCookie(voucher.human.id), { github_login: p.login })).headers.get("Location")).toBe("/dashboard?m=vouched");
    const [claim] = await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id));
    expect(claim!.humanId).toBe(s.human.id);
    expect(claim!.hidden).toBe(true);
    expect((await fetchWorker(`/score/${run.id}`)).status).toBe(404);
  });

  it("caps runs waiting per unverified person", async () => {
    const s = await upsertHuman(db(), sandbox(), Date.now());
    await db().insert(t.pendingClaims).values(Array.from({ length: MAX_PENDING_CLAIMS }, (_, i) => ({ gauntletId: `gcap${s.id}${i}`, humanId: s.id, createdAt: Date.now() })));
    const run = await finishedRun();
    expect(await claimRun(env, s.id, "new", run.key)).toEqual({ ok: false, error: "pending_limit_reached" });
    await db().delete(t.pendingClaims).where(eq(t.pendingClaims.humanId, s.id));
  });

  it("in invite-only mode a verified person who can't take part yet keeps their pending claim (it isn't dropped)", async () => {
    const s = await upsertHuman(db(), sandbox(), Date.now());
    const run = await finishedRun();
    expect((await claimRun(env, s.id, "new", run.key)).ok).toBe(true);
    // Verified by GitHub activity (not approval or vouch): can't take part while access is closed.
    await db().update(t.humans).set({ tier: "verified", verifiedVia: "activity" }).where(eq(t.humans.id, s.id));
    await promotePendingClaims({ ...env, ACCESS_MODE: "closed" });
    expect((await db().select().from(t.pendingClaims).where(eq(t.pendingClaims.gauntletId, run.id))).length).toBe(1);
    expect((await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id))).length).toBe(0);
    await promotePendingClaims(env);
    expect((await db().select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, run.id))).length).toBe(1);
  });

  it("viewing /founding never writes (no owner sync on a GET); joining does", async () => {
    const o = await connectAgent();
    await db().update(t.humans).set({ ownerSince: null, ownerNumber: null }).where(eq(t.humans.id, o.human.id));
    const cookie = await asCookie(o.human.id);
    await get("/founding", cookie);
    expect((await human(o.human.id)).ownerSince).toBeNull();
    // Joined, or over 100 after the earlier tests' numbers: either way the POST brought the owner record up to date.
    expect((await post("/founding/join", cookie, {}, "/dashboard")).headers.get("Location")).toMatch(/^\/founding\?m=(joined|number_over_limit)$/);
    expect((await human(o.human.id)).ownerNumber).toBeGreaterThan(0);
  });

  it("/founding (HTML and JSON) and a founding owner's agent page show nothing embargoed", async () => {
    const o = await connectAgent();
    await syncOwners(env);
    await joinFounding(env, o.human.id);
    for (const path of ["/founding", "/founding?format=json", `/a/${o.agent.handle}`, `/a/${o.agent.handle}?format=json`]) expect(await get(path)).not.toMatch(SHOWS_EMBARGOED);
  });
});

describe("F-02 review: the list opening or closing purges every listed owner's cached pages", () => {
  it("drops each listed owner's agent page and share card from the edge cache when the list opens, and again when it closes", async () => {
    const db = getDb(env);
    const have = (await foundingList(env)).length;
    expect(have).toBeLessThan(FOUNDING_LIST_OPENS_AT);
    const used = new Set((await db.select({ n: t.humans.ownerNumber }).from(t.humans)).map((r) => r.n));
    const free = Array.from({ length: FOUNDING_LIMIT }, (_, i) => i + 1).filter((n) => !used.has(n));
    const ids: string[] = [];
    const handles: string[] = [];
    for (let i = 0; i < FOUNDING_LIST_OPENS_AT - have; i++) {
      const id = crypto.randomUUID();
      const handle = `purge-${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(t.humans).values({ id, githubId: 950_000_000 + i, githubLogin: `purge-login-${id.slice(0, 8)}`, githubCreatedAt: 0, tier: "verified", ownerSince: Date.now(), ownerNumber: free[i]!, foundingAt: Date.now() });
      await db.insert(t.agents).values({ id: crypto.randomUUID(), humanId: id, handle, framework: "claude-code", oauthClientId: `c-${id}` });
      ids.push(id);
      handles.push(handle);
    }
    const urls = (h: string) => [`${env.PUBLIC_ORIGIN}/a/${h}`, `${env.PUBLIC_ORIGIN}/og/owner/${h}.png`];
    const prime = () => Promise.all(handles.flatMap(urls).map((u) => caches.default.put(new Request(u), new Response("cached", { headers: { "Cache-Control": "public, max-age=60" } }))));
    const cached = async () => (await Promise.all(handles.flatMap(urls).map((u) => caches.default.match(new Request(u))))).filter(Boolean).length;

    // The list just reached the threshold: a join opens it.
    await prime();
    expect(await cached()).toBe(handles.length * 2);
    expect(await purgeOnOpenOrClose(env, "leave")).toBe(0); // 10 after a leave would not be a close
    expect(await purgeOnOpenOrClose(env, "join")).toBeGreaterThanOrEqual(handles.length);
    expect(await cached()).toBe(0);

    // A leave that takes it back below the threshold closes it: everyone left on the list is purged again.
    await prime();
    await db.update(t.humans).set({ foundingAt: null }).where(eq(t.humans.id, ids[0]!));
    expect(await purgeOnOpenOrClose(env, "join")).toBe(0);
    expect(await purgeOnOpenOrClose(env, "leave")).toBeGreaterThanOrEqual(handles.length - 1);
    expect((await Promise.all(handles.slice(1).flatMap(urls).map((u) => caches.default.match(new Request(u))))).filter(Boolean)).toHaveLength(0);
  });
});
