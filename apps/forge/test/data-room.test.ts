import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { finishedRuns } from "../src/arena/views";
import * as t from "../src/db/schema";
import { BUYER_COOKIE, createLink, datasetBreakdown, LINK_DAYS_MAX, linkByToken, PRIVATE_HEADERS, SHARE_PREFIX, buyerPack } from "../src/services/data-room";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { dataInventory } from "../src/services/kpis";
import { workTotals } from "../src/services/site-pulse";
import { thirdPartyData } from "../src/web/admin-kpis";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { statsData } from "../src/web/stats";
import { fetchWorker, ORIGIN, profile } from "./helpers";
import "../src/index";

// B2-09 / AQ-05 (ADR 0095): the private buyer data room. Admin-only, CSRF-safe, never cached or indexed; share links
// expire, can be revoked, record the NDA the buyer confirmed and log every access; every number comes from the same
// functions as /admin/kpis and /stats; the dataset table reconciles all runs with the public ones.

let adminCookie = "";
let userCookie = "";

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
const adminPage = async () => (await fetchWorker("/admin/data-room", { headers: { Cookie: adminCookie, Accept: "text/html" } })).text();
const post = (path: string, cookie: string, fields: Record<string, string>, origin: string = ORIGIN) =>
  fetchWorker(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields), redirect: "manual" });

/** Opens a buyer link the way the browser does (the code posted from the fragment); returns the response and cookie. */
async function openRoom(token: string) {
  const res = await post("/data-room/open", "", { code: token });
  const cookie = /forge_dr=([^;]*)/.exec(res.headers.get("Set-Cookie") ?? "")?.[1];
  return { res, cookie: cookie ? `${BUYER_COOKIE}=${cookie}` : "" };
}

async function seedRun(eventKind: "card" | "practice", heldOut = false, fell = false) {
  const db = getDb(env);
  const eventId = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: eventId, slug: `dr-${eventId.slice(0, 8)}`, name: "Data room test", season: "s0", kind: eventKind, status: "done" });
  const a = new Attempt(taskById("scam-invoice")!, 1_000_123);
  a.recordTurn({ tokensIn: 100, tokensOut: 10, cost: 0.001, latencyMs: 100, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const result = { ...base, traps: base.traps.map((x, i) => ({ ...x, triggered: fell && i === 0 })) } as AttemptResult;
  await db.insert(t.arenaRuns).values({ id: crypto.randomUUID(), eventId, modelId: "claude-sonnet-5.5", task: "scam-invoice", seed: 1_000_123, attemptNo: 1, status: "done", passed: !fell, score: 0.5, cost: 0.001, tokens: 110, result, log: a.log, heldOut, finishedAt: Date.now() - 60_000 });
}

beforeAll(async () => {
  const db = getDb(env);
  const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
  adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
  const someone = await upsertHuman(db, profile(), Date.now());
  userCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, someone.id)}`;
  await seedRun("card");
  await seedRun("card", false, true);
  await seedRun("card", true);
  await seedRun("practice");
});

describe("admin only, CSRF-safe, private headers", () => {
  it("only founder admins see the data room and its JSON", async () => {
    expect((await fetchWorker("/admin/data-room", { redirect: "manual" })).status).toBe(302);
    expect((await fetchWorker("/admin/data-room", { headers: { Cookie: userCookie }, redirect: "manual" })).status).toBe(302);
    expect((await fetchWorker("/admin/data-room/pack.json", { headers: { Cookie: userCookie } })).status).toBe(403);
    const res = await fetchWorker("/admin/data-room", { headers: { Cookie: adminCookie, Accept: "text/html" } });
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) expect(res.headers.get(k), k).toBe(v);
    expect(await res.text()).toContain('<meta name="robots" content="noindex');
    const json = await fetchWorker("/admin/data-room/pack.json", { headers: { Cookie: adminCookie } });
    expect(json.headers.get("Cache-Control")).toBe(PRIVATE_HEADERS["Cache-Control"]);
    expect(json.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("refuses link, revoke, note and export posts without the session's CSRF token, from another origin, or from a non-admin", async () => {
    const csrf = csrfOf(await adminPage());
    expect(csrf).not.toBe("");
    const fields = { label: "Acme", days: "14", nda: "forge-mutual-nda-template-2026-10-28" };
    expect((await post("/admin/data-room/links", adminCookie, fields)).status).toBe(403);
    expect((await post("/admin/data-room/links", adminCookie, { ...fields, csrf: "nope" })).status).toBe(403);
    expect((await post("/admin/data-room/links", adminCookie, { ...fields, csrf }, "https://evil.example")).status).toBe(403);
    expect((await post("/admin/data-room/links", userCookie, { ...fields, csrf })).status).toBe(403);
    expect((await post("/admin/data-room/export", "", { csrf })).status).toBe(403);
    expect((await post("/admin/data-room/links", adminCookie, { ...fields, nda: "made-up", csrf })).status).toBe(400);
    expect(await getDb(env).select().from(t.dataRoomLinks)).toHaveLength(0);
  });
});

describe("share links", () => {
  it("an admin makes a link that expires; the token is shown once, never in a URL the server sees, and only its hash is stored", async () => {
    const csrf = csrfOf(await adminPage());
    const res = await post("/admin/data-room/links", adminCookie, { label: "Acme Security", days: "99", nda: "forge-mutual-nda-template-2026-10-28", export: "1", csrf });
    expect(res.status).toBe(303);
    const location = res.headers.get("Location")!;
    expect(location).toBe("/admin/data-room?made=1#links");
    const page = await (await fetchWorker(location, { headers: { Cookie: adminCookie, Accept: "text/html" } })).text();
    const shown = /\/data-room#([A-Za-z0-9_-]{43})/.exec(page)?.[1];
    expect(shown).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = shown!;
    // Shown once: the next load doesn't have it.
    expect(await (await fetchWorker(location, { headers: { Cookie: adminCookie, Accept: "text/html" } })).text()).not.toContain(token);
    // The full link the admin copies.
    expect(page).toContain(`${ORIGIN}/data-room#${token}`);
    const link = (await linkByToken(env, token))!;
    expect(link).toMatchObject({ label: "Acme Security", includeExport: true, ndaVersion: "forge-mutual-nda-template-2026-10-28", confirmedAt: null });
    expect(link.expiresAt - link.createdAt).toBe(LINK_DAYS_MAX * 86_400_000); // 99 days is capped
    const rows = await getDb(env).select().from(t.dataRoomLinks);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("the buyer confirms the NDA version before seeing anything; every access is logged; revoked and expired links close", async () => {
    const admin = (await getDb(env).query.humans.findFirst({ where: eq(t.humans.githubId, Number(env.ADMIN_GITHUB_IDS)) }))!;
    const { token, id } = await createLink(env, { label: "Beta Labs", days: 14, ndaVersion: "forge-mutual-nda-template-2026-10-28", includeExport: false, by: `admin:${admin.id}` });
    // The entry page holds no content and loads the script that posts the fragment.
    const entry = await fetchWorker("/data-room", { headers: { Accept: "text/html" } });
    expect(entry.status).toBe(200);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) expect(entry.headers.get(k), k).toBe(v);
    const entryHtml = await entry.text();
    expect(entryHtml).toContain('src="/data-room.js"');
    expect(entryHtml).not.toContain("Beta Labs");
    // Opening from another origin, or with a wrong code, gets nothing.
    expect((await post("/data-room/open", "", { code: token }, "https://evil.example")).status).toBe(403);
    expect((await post("/data-room/open", "", { code: "A".repeat(43) })).status).toBe(404);
    const { res: opened, cookie } = await openRoom(token);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("Location")).toBe(`${SHARE_PREFIX}room`);
    const setCookie = opened.headers.get("Set-Cookie")!;
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/data-room"]) expect(setCookie).toContain(attr);
    expect(Number(/Max-Age=(\d+)/.exec(setCookie)![1])).toBeLessThanOrEqual(8 * 3600);
    const room = `${SHARE_PREFIX}room`;
    expect((await fetchWorker(room)).status).toBe(404); // no cookie, no room
    const gate = await fetchWorker(room, { headers: { Accept: "text/html", Cookie: cookie } });
    expect(gate.status).toBe(200);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) expect(gate.headers.get(k), k).toBe(v);
    const gateHtml = await gate.text();
    expect(gateHtml).toContain("The Agent Forge mutual NDA template, 28 Oct 2026");
    expect(gateHtml).not.toContain('data-k="runs_all"');
    expect(gateHtml).not.toContain(token);
    const csrf = csrfOf(gateHtml);
    const confirm = `${SHARE_PREFIX}confirm`;
    // No tick, a wrong token, a wrong NDA version, another origin or no cookie: refused.
    expect((await post(confirm, cookie, { csrf, nda: "forge-mutual-nda-template-2026-10-28", org: "Beta" })).status).toBe(400);
    expect((await post(confirm, cookie, { csrf: "x", signed: "1", nda: "forge-mutual-nda-template-2026-10-28", org: "Beta" })).status).toBe(400);
    expect((await post(confirm, cookie, { csrf, signed: "1", nda: "buyer-own-nda", org: "Beta" })).status).toBe(400);
    expect((await post(confirm, cookie, { csrf, signed: "1", nda: "forge-mutual-nda-template-2026-10-28", org: "Beta" }, "https://evil.example")).status).toBe(403);
    expect((await post(confirm, "", { csrf, signed: "1", nda: "forge-mutual-nda-template-2026-10-28", org: "Beta" })).status).toBe(404);
    expect((await post(confirm, cookie, { csrf, signed: "1", nda: "forge-mutual-nda-template-2026-10-28", org: "Beta Labs Ltd" })).status).toBe(303);
    const open = await (await fetchWorker(room, { headers: { Accept: "text/html", Cookie: cookie } })).text();
    expect(open).toContain('data-k="runs_all"');
    expect(open).toContain("confirmed");
    // No export through a link made without it.
    expect((await fetchWorker(`${SHARE_PREFIX}export/2026-W44-20261028T000000/manifest.json`, { headers: { Cookie: cookie } })).status).toBe(403);

    const link = (await linkByToken(env, token))!;
    expect(link).toMatchObject({ confirmedNdaVersion: "forge-mutual-nda-template-2026-10-28", confirmedOrg: "Beta Labs Ltd" });
    expect(link.confirmedAt).toBeGreaterThan(0);

    // Dinike's manual note, and revocation, from the admin page (CSRF-checked). Revocation closes the open cookie at once.
    const csrfAdmin = csrfOf(await adminPage());
    expect((await post(`/admin/data-room/links/${id}/note`, adminCookie, { note: "NDA PDF signed 29 Oct, in Drive", csrf: csrfAdmin })).status).toBe(303);
    expect((await post(`/admin/data-room/links/${id}/revoke`, adminCookie, { csrf: csrfAdmin })).status).toBe(303);
    const closed = await fetchWorker(room, { headers: { Accept: "text/html", Cookie: cookie } });
    expect(closed.status).toBe(410);
    expect(closed.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await openRoom(token)).res.status).toBe(410);

    const log = await getDb(env).select().from(t.dataRoomAccess).where(eq(t.dataRoomAccess.linkId, id));
    const events = log.map((x) => x.event);
    expect(events).toEqual(expect.arrayContaining(["view", "confirm", "refused_unconfirmed", "refused_revoked"]));
    expect(events.filter((e) => e === "view")).toHaveLength(2);
    for (const x of log) expect(x.viewer).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(log)).not.toContain(token);
    const page = await adminPage();
    expect(page).toContain("NDA PDF signed 29 Oct, in Drive");
    expect(page).toContain("revoked");

    const old = await createLink(env, { label: "Gamma", days: 14, ndaVersion: "buyer-own-nda", includeExport: false, by: "admin:test" }, Date.now() - 15 * 86_400_000);
    expect((await openRoom(old.token)).res.status).toBe(410);
    expect((await getDb(env).select().from(t.dataRoomAccess).where(eq(t.dataRoomAccess.linkId, old.id)))[0]?.event).toBe("refused_expired");
    // An expired link's old cookie is refused server-side too.
    expect((await fetchWorker(room, { headers: { Cookie: `${BUYER_COOKIE}=${old.token}` } })).status).toBe(410);
    // The retired /data-room/<token> form serves nothing.
    expect((await fetchWorker(`${SHARE_PREFIX}${token}`)).status).toBe(404);
  });

  it("never edge-caches or counts a data-room page", async () => {
    const a = await fetchWorker("/data-room", { headers: { Accept: "text/html" } });
    const b = await fetchWorker("/data-room", { headers: { Accept: "text/html" } });
    for (const r of [a, b]) {
      expect(r.headers.get("Cache-Control")).toBe(PRIVATE_HEADERS["Cache-Control"]);
      expect(r.headers.get("CF-Cache-Status")).toBeNull();
    }
  });
});

describe("one source for every number", () => {
  it("the dataset table reconciles all runs, public runs and the /stats and /admin/kpis counts", async () => {
    const d = await datasetBreakdown(env);
    const row = (k: string) => d.rows.find((r) => r.key === k)!.n;
    const [work, inv] = await Promise.all([workTotals(env), dataInventory(env)]);
    expect(row("runs_all")).toBe(work.bouts_refereed);
    expect(row("runs_all")).toBe(inv.refereed_runs.total);
    expect(row("runs_public")).toBe((await finishedRuns(getDb(env), { hard: true })).length);
    const dataset = (await (await fetchWorker("/arena/dataset.json")).json()) as { runs: unknown[] };
    expect(row("runs_public")).toBe(dataset.runs.length);
    expect(row("runs_held_out")).toBeGreaterThanOrEqual(1);
    expect(row("runs_public") + row("runs_held_out") + row("runs_lab_arms") + row("runs_other_withheld")).toBe(row("runs_all"));
    expect(row("runs_ranked")).toBe(inv.refereed_runs.ranked);
    expect(row("runs_ranked_with_fall")).toBe(inv.refereed_runs.with_trap_fall);
    expect(row("runs_non_practice")).toBe(work.ranked_bouts);
    expect(row("reports_readable")).toBe(work.field_reports ?? 0);
    expect(d.checks).toMatchObject({ runs_match_stats: true, parts_add_up: true });
    expect(Date.parse(d.generated_at)).toBeGreaterThan(0);
  });

  it("gross numbers match /stats, outside-only numbers match /admin/kpis, and every section is timestamped", async () => {
    // ADR 0099: the data room shows every row, those below their public minimum included.
    const [pack, stats, third] = await Promise.all([buyerPack(env), statsData(env, { allRows: true }), thirdPartyData(env)]);
    expect(pack.internal_only).toBe(true);
    expect(pack.kpis.gross!.totals).toEqual(stats.totals.items);
    expect(pack.kpis.gross!.people_and_7_days).toEqual(stats.gross.items);
    expect(pack.kpis.outside_only!.splits).toEqual(third.splits);
    expect(pack.kpis.outside_only!.active_owners_30d).toBe(third.active_owners_30d);
    for (const at of [pack.generated_at, pack.kpis.gross!.generated_at, pack.kpis.outside_only!.generated_at, pack.kpis.series.generated_at, pack.costs.credit.generated_at, pack.dataset.generated_at]) expect(Date.parse(at)).toBeGreaterThan(0);
    expect(pack.costs.credit.anthropic_byok_expires).toBe("2026-11-16");
    for (const s of pack.kpis.series.series) expect(["outside", "ours", "outside + ours", "kpi (as defined)", "dataset (gross)"]).toContain(s.basis);
  });

  it("no public page shows the data room's outside-only numbers or links to it", async () => {
    for (const path of ["/stats", "/stats.json", "/sitemap.xml", "/llms.txt", "/robots.txt"]) {
      const text = await (await fetchWorker(path)).text();
      expect(text, path).not.toContain('data-k="outside_');
      expect(text, path).not.toContain("/data-room");
    }
  });
});
