import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import worker from "../src/index";
import { validityReleased } from "../src/web/validity-release";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { profile } from "./helpers";

// The validity pack's release switch (review 5 Nov, ADR 0136): until VALIDITY_PUBLIC is "on", /benchmark/validity,
// its files, the error record and the trap pages' "Dispute and correction history" are 404 or absent for everyone but
// a signed-in admin, whose preview is never cached. Off-state checks run before any released fetch, so no edge-cached
// released copy can stand in for them.

const PATHS = [
  "/benchmark/validity",
  "/benchmark/validity.json",
  "/benchmark/validity/referee-audit-1.json",
  "/benchmark/validity/referee-audit-1-per-trap.csv",
  "/benchmark/validity/referee-audit-1-disagreements.csv",
  "/benchmark/validity/error-record.json",
  "/benchmark/validity/error-record.csv",
];
const OFF = { ...env, VALIDITY_PUBLIC: undefined } as Env;
const ON = { ...env, VALIDITY_PUBLIC: "on" } as Env;

async function get(path: string, e: Env, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, { headers }) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let adminCookie = "";
let userCookie = "";
beforeAll(async () => {
  const db = getDb(env);
  const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
  adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
  const someone = await upsertHuman(db, profile(), Date.now());
  userCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, someone.id)}`;
});

describe("validity pack release switch", () => {
  it("is off unless VALIDITY_PUBLIC is exactly on (any case); the test config leaves it unset", () => {
    expect(validityReleased(env)).toBe(false);
    for (const v of [undefined, "", "off", "true", "1", "yes"]) expect(validityReleased({ VALIDITY_PUBLIC: v })).toBe(false);
    for (const v of ["on", "ON", " on "]) expect(validityReleased({ VALIDITY_PUBLIC: v })).toBe(true);
  });

  it("off: every validity path is 404 for visitors and signed-in non-admins, with nothing of the audit in the body", async () => {
    for (const p of PATHS)
      for (const headers of [{}, { Accept: "application/json" }, { Cookie: userCookie }] as Record<string, string>[]) {
        const res = await get(p, OFF, headers);
        expect(res.status, `${p} ${JSON.stringify(headers)}`).toBe(404);
        expect((await res.text()).split(p).join("")).not.toMatch(/referee-audit-1|error_record|Dispute and correction|independent checker|trap verdicts/i);
      }
  });

  it("off: /benchmark has no validity link and trap pages have no history section or field", async () => {
    expect(await (await get("/benchmark", OFF)).text()).not.toContain("/benchmark/validity");
    for (const headers of [{}, { Cookie: userCookie }] as Record<string, string>[]) {
      const page = await (await get("/arena/failures/FA-CLM-001", OFF, headers)).text();
      expect(page).not.toContain("Dispute and correction history");
      expect(page).not.toContain("/benchmark/validity");
      const json = await (await get("/arena/failures/FA-CLM-001?format=json", OFF, headers)).json<Record<string, unknown>>();
      expect(json).not.toHaveProperty("history");
    }
  });

  it("off: an admin still sees every path and the trap history, uncached and unindexed", async () => {
    for (const p of PATHS) {
      const res = await get(p, OFF, { Cookie: adminCookie });
      expect(res.status, p).toBe(200);
      expect(res.headers.get("Cache-Control"), p).toBe("private, no-store");
      expect(res.headers.get("X-Robots-Tag"), p).toContain("noindex");
    }
    const page = await get("/arena/failures/FA-CLM-001", OFF, { Cookie: adminCookie });
    expect(await page.text()).toContain("Dispute and correction history");
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    const json = await (await get("/arena/failures/FA-CLM-001?format=json", OFF, { Cookie: adminCookie })).json<any>();
    expect(json.history.audit.audit_id).toBe("referee-audit-1");
  });

  it("on: every path is public and cacheable, /benchmark links to it and trap pages show their history", async () => {
    for (const p of PATHS) {
      const res = await get(p, ON);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("Cache-Control") ?? "", p).toMatch(/^public/);
    }
    // A distinct address, so the off-state copies the edge cache stored above aren't read back.
    expect(await (await get("/benchmark?released=1", ON)).text()).toContain('href="/benchmark/validity"');
    expect(await (await get("/arena/failures/FA-CLM-001?released=1", ON)).text()).toContain("Dispute and correction history");
  });

  it("referee audit 2 (ADR 0136 Amendment 1) is served nowhere: 404 off, on and for an admin, and no page names it", async () => {
    for (const f of ["referee-audit-2.json", "referee-audit-2-adjudications.json", "referee-audit-2-claims.json", "referee-audit-2-claims-corpus.json"])
      for (const [e, headers] of [[OFF, {}], [ON, {}], [OFF, { Cookie: adminCookie }]] as [Env, Record<string, string>][]) {
        const res = await get(`/benchmark/validity/${f}`, e, headers);
        expect(res.status, f).toBe(404);
      }
    for (const [e, headers] of [[ON, {}], [OFF, { Cookie: adminCookie }]] as [Env, Record<string, string>][])
      expect(await (await get("/benchmark/validity.json?a2=1", e, headers)).text()).not.toMatch(/referee-audit-2|claim-review/);
  });
});
