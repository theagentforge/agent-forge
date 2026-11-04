import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { DISPUTE_CLOSE_PATH } from "../src/web/admin-kpis";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, ORIGIN, profile } from "./helpers";
import "../src/index";

// /admin/kpis "Close" on an open dispute (Dinike, 1 Nov: close the 28 Oct junk dispute after release). Founder admins
// only, CSRF-checked like /admin/claims/check; sets the schema's own state (resolved or rejected) and logs the reason.

let adminCookie = "";
let userCookie = "";
let userCsrf = "";
let adminCsrf = "";
const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
const post = (cookie: string, form: Record<string, string>) =>
  fetchWorker(DISPUTE_CLOSE_PATH, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams(form), redirect: "manual" });
const state = async (id: string) => (await getDb(env).select({ s: t.disputes.state, at: t.disputes.resolvedAt }).from(t.disputes).where(eq(t.disputes.id, id)))[0]!;

async function openDispute(reason = "pasted crypto help text, no tool named") {
  const id = crypto.randomUUID();
  await getDb(env).insert(t.disputes).values({ id, reason, state: "open", createdAt: Date.now() - 4 * 86_400_000 });
  return id;
}

beforeAll(async () => {
  const db = getDb(env);
  const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
  adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
  const someone = await upsertHuman(db, profile(), Date.now());
  userCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, someone.id)}`;
  // A real CSRF token for the non-admin too (from a page any signed-in person can open), so the 403 is the admin check.
  userCsrf = csrfOf(await (await fetchWorker("/disputes", { headers: { Cookie: userCookie } })).text());
  expect(userCsrf).not.toBe("");
});

describe("Close on /admin/kpis open disputes", () => {
  it("each open row has a Close form with the CSRF token, a required reason and the schema's states only", async () => {
    const id = await openDispute();
    const page = await (await fetchWorker("/admin/kpis", { headers: { Cookie: adminCookie, Accept: "text/html" } })).text();
    adminCsrf = csrfOf(page);
    const row = page.slice(page.indexOf(`data-dispute="${id}"`), page.indexOf("</tr>", page.indexOf(`data-dispute="${id}"`)));
    expect(row).toContain(`action="${DISPUTE_CLOSE_PATH}"`);
    expect(row).toContain(`name="csrf" value="${adminCsrf}"`);
    expect(row).toContain(`name="id" value="${id}"`);
    expect(row).toMatch(/<input name="reason" required/);
    expect([...row.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual(["resolved", "rejected"]);
    // The default is "rejected" (coordinator, review fix 6): the common case is "not a dispute".
    expect([...row.matchAll(/<option value="([^"]+)" selected>/g)].map((m) => m[1])).toEqual(["rejected"]);
    expect(page).not.toContain("Resolve in D1");
  });

  it("refuses a non-admin with 403, even with a valid token; the dispute stays open", async () => {
    const id = await openDispute();
    expect((await post(userCookie, { csrf: userCsrf, id, state: "rejected", reason: "not a dispute: no tool named" })).status).toBe(403);
    expect((await post("", { csrf: userCsrf, id, state: "rejected", reason: "not a dispute: no tool named" })).status).toBe(403);
    expect((await state(id)).s).toBe("open");
  });

  it("refuses a missing or wrong CSRF token, and a foreign Origin, with 403", async () => {
    const id = await openDispute();
    expect((await post(adminCookie, { id, state: "rejected", reason: "not a dispute: no tool named" })).status).toBe(403);
    expect((await post(adminCookie, { csrf: "wrong", id, state: "rejected", reason: "not a dispute: no tool named" })).status).toBe(403);
    const foreign = await fetchWorker(DISPUTE_CLOSE_PATH, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example", Cookie: adminCookie }, body: new URLSearchParams({ csrf: adminCsrf, id, state: "rejected", reason: "not a dispute" }), redirect: "manual" });
    expect(foreign.status).toBe(403);
    expect((await state(id)).s).toBe("open");
  });

  it("an admin close sets the state, logs the reason, redirects back, and drops the row from the open list", async () => {
    const id = await openDispute();
    const res = await post(adminCookie, { csrf: adminCsrf, id, state: "rejected", reason: "  not a dispute:   no tool named " });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/kpis#disputes");
    const after = await state(id);
    expect(after.s).toBe("rejected");
    expect(after.at).toBeGreaterThan(0);
    const log = await getDb(env).select().from(t.auditLog).where(eq(t.auditLog.target, `dispute:${id}`));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "dispute_closed", detail: { state: "rejected", reason: "not a dispute: no tool named" } });
    const page = await (await fetchWorker("/admin/kpis", { headers: { Cookie: adminCookie, Accept: "text/html" } })).text();
    expect(page).not.toContain(`data-dispute="${id}"`);
    // Closing again finds no open dispute: nothing changes, nothing more is logged.
    expect((await post(adminCookie, { csrf: adminCsrf, id, state: "resolved", reason: "again" })).status).toBe(404);
    expect((await state(id)).s).toBe("rejected");
  });

  it("needs a known state and a short reason", async () => {
    const id = await openDispute();
    for (const form of [{ state: "closed", reason: "not a dispute" }, { state: "resolved", reason: "" }, { state: "resolved", reason: "x".repeat(201) }, { state: "open", reason: "reopen" }])
      expect((await post(adminCookie, { csrf: adminCsrf, id, ...form })).status, JSON.stringify(form).slice(0, 40)).toBe(400);
    const ok = await post(adminCookie, { csrf: adminCsrf, id, state: "resolved", reason: "answered by email" });
    expect(ok.status).toBe(303);
    expect((await state(id)).s).toBe("resolved");
  });
});
