import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { installIdHash, installReturns, installReturnsData, recordInstallId, sweepInstallIds, type ReturnRow } from "../src/services/install-ids";
import { upsertHuman } from "../src/services/identity";
import { getDb } from "../src/services/db";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { INSTALL_ID_PARAGRAPH } from "../src/web/legal";
import { fetchWorker, profile } from "./helpers";
import "../src/index";

// B3-09 (ADR 0103): the anonymous install ID. Stored only as a keyed hash with first and last day, client and an ours
// flag; never the raw ID, an IP or a package name. Return cohorts and the step table on /admin/kpis (admins only).

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID2 = "9c5a3e1e-7d1b-4c3a-a0f2-1b2c3d4e5f60";
const DAY = 86_400_000;
let n = 0;
const ip = () => `203.0.113.${(++n % 200) + 20}`;

async function settle<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 100 && !done(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await read();
  }
  return v;
}
const rows = () => env.DB.prepare("SELECT * FROM install_ids").all<Record<string, unknown>>().then((r) => r.results);

describe("install IDs: what the server stores", () => {
  it("a check with the header stores a hash, the day and the client, never the raw ID, an IP or the package", async () => {
    await env.DB.prepare("DELETE FROM install_ids").run();
    const res = await fetchWorker(`/api/v1/check?id=npm:install-id-probe&n=${++n}`, { headers: { "User-Agent": "theagentforge-cli/0.6.0", "CF-Connecting-IP": "203.0.113.9", "forge-install-id": ID } });
    expect(res.status).toBe(200);
    const stored = await settle(rows, (r) => r.length > 0);
    expect(stored).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(stored[0]).toEqual({ id_hash: await installIdHash(env.SESSION_SECRET, ID), client: "cli", first_day: today, last_day: today, ours: 0 });
    const dump = JSON.stringify(stored);
    for (const s of [ID, ID.replaceAll("-", ""), "203.0.113.9", "install-id-probe"]) expect(dump).not.toContain(s);
  });

  it("ignores a missing or malformed ID, and clients that don't send one (browsers, the Actions)", async () => {
    await env.DB.prepare("DELETE FROM install_ids").run();
    const ua = { cli: "theagentforge-cli/0.6.0", action: "theagentforge-action/1", browser: "Mozilla/5.0" };
    await recordInstallId(env, undefined, ua.cli, null);
    await recordInstallId(env, "not-a-uuid", ua.cli, null);
    await recordInstallId(env, "3b241101-e2bb-1255-8caf-4136c566a962", ua.cli, null); // v1
    await recordInstallId(env, ID, ua.action, null);
    await recordInstallId(env, ID, ua.browser, null);
    expect(await rows()).toHaveLength(0);
  });

  it("keeps the first day and the first client, moves the last day forward, and marks a tagged request as ours", async () => {
    await env.DB.prepare("DELETE FROM install_ids").run();
    const t0 = Date.UTC(2026, 9, 1);
    await recordInstallId(env, ID, "theagentforge-claude-plugin", null, t0);
    await recordInstallId(env, ID.toUpperCase(), "theagentforge-cli/0.6.0 (hook codex)", null, t0 + 8 * DAY);
    await recordInstallId(env, ID, "theagentforge-claude-plugin", null, t0 + 2 * DAY); // an older day never moves it back
    await recordInstallId(env, ID2, "theagentforge-cli/0.6.0", "ci", t0);
    const r = await env.DB.prepare("SELECT client, first_day, last_day, ours FROM install_ids ORDER BY ours").all();
    expect(r.results).toEqual([
      { client: "plugin", first_day: "2026-10-01", last_day: "2026-10-09", ours: 0 },
      { client: "cli", first_day: "2026-10-01", last_day: "2026-10-01", ours: 1 },
    ]);
  });

  it("deletes IDs last seen more than 400 days ago", async () => {
    await env.DB.prepare("DELETE FROM install_ids").run();
    const now = Date.UTC(2027, 11, 1);
    await recordInstallId(env, ID, "theagentforge-cli/0.6.0", null, now - 401 * DAY);
    await recordInstallId(env, ID2, "theagentforge-cli/0.6.0", null, now - 399 * DAY);
    await sweepInstallIds(env, now);
    expect((await rows()).map((x) => x.last_day)).toEqual([new Date(now - 399 * DAY).toISOString().slice(0, 10)]);
  });
});

describe("install IDs: return cohorts", () => {
  it("cohort maths and the biggest drop on fixture rows", () => {
    const r: ReturnRow[] = [
      { client: "cli", ours: false, ids: 10, e1: 8, r1: 4, e7: 6, r7: 1, e30: 0, r30: 0 },
      { client: "plugin", ours: false, ids: 10, e1: 8, r1: 4, e7: 4, r7: 1, e30: 2, r30: 1 },
      { client: "cli", ours: true, ids: 5, e1: 5, r1: 5, e7: 5, r7: 5, e30: 5, r30: 5 },
    ];
    const v = installReturns(r, "2026-11-20");
    expect(v.outside.ids).toBe(20);
    expect(v.outside.d1).toEqual({ eligible: 16, returned: 8, pct: 50 });
    expect(v.outside.d7).toEqual({ eligible: 10, returned: 2, pct: 20 });
    expect(v.outside.d30).toEqual({ eligible: 2, returned: 1, pct: 50 });
    expect(v.ours.ids).toBe(5); // ours never mixes into the outside numbers
    expect(v.by_client.cli.d7.pct).toBeCloseTo(16.7);
    expect(v.by_client["hook-codex"].d1.pct).toBeNull();
    expect(v.steps.map((s) => s.key)).toEqual(["installed", "first_check", "second_day", "week_2"]);
    expect(v.steps[0]!.n).toBeNull(); // an install sends nothing before its first check
    // 100 → 50 loses 50 points; 50 → 20 loses 30: the first is the biggest drop.
    expect(v.biggest_drop).toBe("First check → Came back another day: 50 points lost (8 of 16 IDs old enough came back)");
    expect(installReturns([], "2026-11-20").biggest_drop).toBeNull();
  });

  it("reads the cohorts from the table: day N counts only IDs old enough", async () => {
    await env.DB.prepare("DELETE FROM install_ids").run();
    const now = Date.UTC(2026, 10, 30);
    const at = (d: number) => now - d * DAY;
    const ids = Array.from({ length: 4 }, (_, i) => `3b241101-e2bb-4255-8caf-4136c566a96${i}`);
    // first seen 40 days ago, last 35 days later: returned at day 1, 7 and 30.
    await recordInstallId(env, ids[0], "theagentforge-cli/0.6.0", null, at(40));
    await recordInstallId(env, ids[0], "theagentforge-cli/0.6.0", null, at(5));
    // first seen 10 days ago, back 2 days later: day 1 only (too young for day 30).
    await recordInstallId(env, ids[1], "theagentforge-claude-plugin", null, at(10));
    await recordInstallId(env, ids[1], "theagentforge-claude-plugin", null, at(8));
    // first seen today: in no cohort yet.
    await recordInstallId(env, ids[2], "theagentforge-claude-plugin", null, at(0));
    // ours: kept apart.
    await recordInstallId(env, ids[3], "theagentforge-cli/0.6.0", "house", at(40));
    const v = await installReturnsData(env, now);
    expect(v.outside.ids).toBe(3);
    expect(v.outside.d1).toEqual({ eligible: 2, returned: 2, pct: 100 });
    expect(v.outside.d7).toEqual({ eligible: 2, returned: 1, pct: 50 });
    expect(v.outside.d30).toEqual({ eligible: 1, returned: 1, pct: 100 });
    expect(v.ours.ids).toBe(1);
    expect(v.by_client.plugin.ids).toBe(2);
  });

  it("/admin/kpis shows the cohorts and the step table to admins only; no public page shows them", async () => {
    const founder = await upsertHuman(getDb(env), profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
    const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
    const kpis = await (await fetchWorker("/admin/kpis", { headers: { Cookie: cookie, Accept: "text/html" } })).text();
    expect(kpis).toContain('id="returns"');
    expect(kpis).toContain('data-k="returns_outside"');
    expect(kpis).toContain('data-step="week_2"');
    expect(kpis).toContain("Biggest drop (install path):");
    const json = (await (await fetchWorker("/admin/stats/third-party.json", { headers: { Cookie: cookie } })).json()) as { install_returns: { internal_only: boolean } };
    expect(json.install_returns.internal_only).toBe(true);
    for (const path of ["/stats", "/"]) expect(await (await fetchWorker(`${path}?u=${ip()}`, { headers: { Accept: "text/html" } })).text()).not.toContain("return cohorts");
  });
});

describe("install IDs: Privacy page", () => {
  it("carries the approved paragraph with its anchor", async () => {
    const html = await (await fetchWorker("/privacy", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain('id="install-id"');
    expect(html.replaceAll("&#39;", "'")).toContain(INSTALL_ID_PARAGRAPH);
    expect(INSTALL_ID_PARAGRAPH).toMatch(/400 days/);
    expect(INSTALL_ID_PARAGRAPH).toMatch(/FORGE_NO_ANALYTICS=1 or DO_NOT_TRACK=1/);
  });

  it("says plainly that Cloudflare's request logs keep headers (the ID) and IPs for up to 7 days (Dinike, 29 Oct)", async () => {
    const html = (await (await fetchWorker("/privacy", { headers: { Accept: "text/html" } })).text()).replaceAll("&#39;", "'");
    expect(INSTALL_ID_PARAGRAPH).toContain("Cloudflare's request logs");
    expect(INSTALL_ID_PARAGRAPH).not.toMatch(/never your IP address or the packages you checked,/);
    expect(html).toContain("request headers, such as the random install ID");
  });

  it("says the logs keep the request address, which names the package checked, and calls it the Random install ID (Dinike, 29 Oct)", async () => {
    const html = (await (await fetchWorker("/privacy", { headers: { Accept: "text/html" } })).text()).replaceAll("&#39;", "'");
    expect(INSTALL_ID_PARAGRAPH).toContain(
      "Cloudflare's request logs keep each request (its address, which names the package checked, and its headers, including this ID) with the IP address for up to 7 days; we don't copy the ID out of them.",
    );
    expect(INSTALL_ID_PARAGRAPH).toContain("the plugin's Random install ID setting");
    expect(html).toContain("About the random install ID");
    expect(html).not.toMatch(/anonymous install ID/i);
  });
});
