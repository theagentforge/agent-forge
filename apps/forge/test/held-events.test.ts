import { env } from "cloudflare:workers";
import { checkReplay, refereeCheck, RULES_VERSION } from "@forge/arena";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DAY_MS, earliestPublication, markPackSent, packDigest, publishHeld } from "../src/arena/held-events";
import { PRACTICE } from "../src/arena/lineup";
import { planEvent, processQueue } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb, newId } from "../src/services/db";
import { sha256Hex } from "../src/services/replay-keys";
import { NOTICE_DAYS } from "../src/web/results-policy";
import { securityJson } from "../src/web/security";
import { csrfToken, newSession, SESSION_COOKIE } from "../src/web/session";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import "../src/index";

// B2-02 (ADR 0089): a held event (status "planned") is published only through /admin/arena-held, only NOTICE_DAYS
// after its full pack was marked sent, and only if its runs are the ones the pack covered. Until then no page, JSON or
// feed shows it. The full pack carries the event's own data: draft result with n and 95% intervals, method, exact
// model versions and signed replay logs.

const model = PRACTICE[0]!;
const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function scripted() {
  const replies = [
    { tool_calls: [call("get_accounts", {})] },
    { tool_calls: [call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })] },
  ];
  let i = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return { choices: [{ message: { content: null, tool_calls: r.tool_calls } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
  }) as never);
}

const SLUG = "held-panel-test";
let cookie = "";
let token = "";
let otherCookie = "";
let otherToken = "";

beforeAll(async () => {
  const db = getDb(env);
  const adminGh = Number(env.ADMIN_GITHUB_IDS.split(",")[0]);
  let admin = await db.query.humans.findFirst({ where: eq(t.humans.githubId, adminGh) });
  if (!admin) {
    await db.insert(t.humans).values({ id: newId(), githubId: adminGh, githubLogin: "founder-held", githubCreatedAt: 0, tier: "verified" });
    admin = await db.query.humans.findFirst({ where: eq(t.humans.githubId, adminGh) });
  }
  token = await newSession(env.SESSION_SECRET, admin!.id);
  cookie = `${SESSION_COOKIE}=${token}`;
  const other = newId();
  await db.insert(t.humans).values({ id: other, githubId: 7_300_001, githubLogin: "not-admin-held", githubCreatedAt: 0, tier: "verified" });
  otherToken = await newSession(env.SESSION_SECRET, other);
  otherCookie = `${SESSION_COOKIE}=${otherToken}`;
});

const post = async (c: string, tok: string, fields: Record<string, string>) =>
  fetchWorker("/admin/arena-held", {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: c, Origin: env.PUBLIC_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: await csrfToken(env.SESSION_SECRET, tok), ...fields }),
  });

describe("publishing a held event (B2-02)", () => {
  it("the whole path: unfinished runs refused, pack marked sent, publication refused before the notice ends, then published", async () => {
    vi.restoreAllMocks();
    await env.KV.delete("arena:lock");
    const db = getDb(env);
    const before = await securityJson(env);
    const eventId = await planEvent(env, { slug: SLUG, name: "Held panel test", season: "s0", kind: "card", hold: true, models: [model.id], tasks: ["impossible"], seeds: [2_100_001, 2_100_002], attempts: 1 });
    expect((await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.id, eventId)))[0]!.status).toBe("planned");
    // Runs still queued: no pack can be marked sent.
    expect(await markPackSent(env, SLUG, "admin:t", "")).toEqual({ ok: false, reason: "runs_unfinished" });
    scripted();
    await processQueue(env, Date.now() + 60_000);

    // Held: shown nowhere, on any page, JSON or file.
    expect((await fetchWorker(`/arena/events/${SLUG}.json`)).status).toBe(404);
    expect((await securityJson(env)).arena.attempts).toBe(before.arena.attempts);
    const dataset = await (await fetchWorker("/arena/dataset.json")).text();
    expect(dataset).not.toContain(SLUG);

    // Not sent yet: no publication.
    expect(await publishHeld(env, SLUG, "admin:t")).toEqual({ ok: false, reason: "no_pack_sent" });
    // Founder admins only, with a CSRF token.
    expect((await post(otherCookie, otherToken, { action: "pack-sent", slug: SLUG })).headers.get("Location")).toBe("/dashboard");
    const noCsrf = await fetchWorker("/admin/arena-held", { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: env.PUBLIC_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "pack-sent", slug: SLUG }) });
    expect(noCsrf.headers.get("Location")).toBe("/dashboard");
    expect(await db.select().from(t.arenaEventNotices).where(eq(t.arenaEventNotices.eventId, eventId))).toEqual([]);

    // The pack's runs fingerprint must be named: without it, or with an older one, nothing is recorded.
    expect((await post(cookie, token, { action: "pack-sent", slug: SLUG })).headers.get("Location")).toBe("/admin/arena-held?r=pack_stale");
    expect((await post(cookie, token, { action: "pack-sent", slug: SLUG, sha256: "0".repeat(64) })).headers.get("Location")).toBe("/admin/arena-held?r=pack_stale");
    expect(await db.select().from(t.arenaEventNotices).where(eq(t.arenaEventNotices.eventId, eventId))).toEqual([]);
    const listed = (await (await fetchWorker("/admin/arena-held", { headers: { Cookie: cookie } })).text()).match(/name="sha256" value="([0-9a-f]{64})"/g) ?? [];
    const fp = (await packDigest(db, eventId)).sha256;
    expect(listed.some((x) => x.includes(fp))).toBe(true);
    const sent = await post(cookie, token, { action: "pack-sent", slug: SLUG, sha256: fp });
    expect(sent.headers.get("Location")).toBe("/admin/arena-held?r=pack_sent");
    const [n] = await db.select().from(t.arenaEventNotices).where(eq(t.arenaEventNotices.eventId, eventId));
    expect(n).toMatchObject({ packRuns: 2, publishedAt: null });
    expect(n!.packSentBy).toMatch(/^admin:/);
    expect(n!.packRunsSha256).toMatch(/^[0-9a-f]{64}$/);

    // Before the notice ends (frozen clock: one second short), publication is refused, by the page and the function.
    const refused = await post(cookie, token, { action: "publish", slug: SLUG });
    expect(refused.headers.get("Location")).toBe("/admin/arena-held?r=notice_period");
    expect(await publishHeld(env, SLUG, "admin:t", earliestPublication(n!.packSentAt!) - 1000)).toEqual({ ok: false, reason: "notice_period" });
    expect(earliestPublication(n!.packSentAt!) - n!.packSentAt!).toBe(NOTICE_DAYS * DAY_MS);
    expect((await fetchWorker(`/arena/events/${SLUG}.json`)).status).toBe(404);
    expect((await securityJson(env)).arena.attempts).toBe(before.arena.attempts);
    const list = (await (await fetchWorker("/admin/arena-held?format=json", { headers: { Cookie: cookie } })).json()) as any[];
    expect(list.find((x) => x.slug === SLUG)).toMatchObject({ status: "planned", can_publish: false, pack_runs: 2 });

    // After it: published, recorded, and the results show with their rules label, n and intervals.
    expect(await publishHeld(env, SLUG, "admin:founder", earliestPublication(n!.packSentAt!))).toEqual({ ok: true });
    expect((await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.id, eventId)))[0]!.status).toBe("running");
    const [p] = await db.select().from(t.arenaEventNotices).where(eq(t.arenaEventNotices.eventId, eventId));
    expect(p).toMatchObject({ publishedBy: "admin:founder", publishedAt: earliestPublication(n!.packSentAt!) });
    expect(await publishHeld(env, SLUG, "admin:t", Date.now() + 30 * DAY_MS)).toEqual({ ok: false, reason: "not_held" });
    const ev = (await (await fetchWorker(`/arena/events/${SLUG}.json`)).json()) as any;
    expect(ev.runs).toHaveLength(2);
    expect(ev.runs.every((r: any) => r.rules_version === RULES_VERSION && r.rescored_from_signed_logs === false)).toBe(true);
    const after = await securityJson(env);
    expect(after.arena.rules_version).toBe(RULES_VERSION);
    expect(after.arena.attempts).toBe(before.arena.attempts + 2);
    const row = after.arena.by_model.find((m: any) => m.id === model.id)!;
    expect(row).toBeTruthy();
    expect(row.attempts).toBeGreaterThanOrEqual(2);
    expect(Object.keys(row)).toContain("ci_95");
  });

  it("refuses to publish when the runs changed after the pack was sent", async () => {
    vi.restoreAllMocks();
    await env.KV.delete("arena:lock");
    const slug = "held-changed-test";
    const eventId = await planEvent(env, { slug, name: "Held changed", season: "s0", kind: "card", hold: true, models: [model.id], tasks: ["impossible"], seeds: [2_100_003], attempts: 1 });
    scripted();
    await processQueue(env, Date.now() + 60_000);
    const t0 = Date.now();
    const db = getDb(env);
    expect(await markPackSent(env, slug, "admin:t", (await packDigest(db, eventId)).sha256, t0)).toEqual({ ok: true });
    const [run] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    await db.update(t.arenaRuns).set({ passed: !run!.passed }).where(eq(t.arenaRuns.id, run!.id));
    expect(await publishHeld(env, slug, "admin:t", t0 + NOTICE_DAYS * DAY_MS)).toEqual({ ok: false, reason: "runs_changed" });
    // The old pack can't be marked sent again; a new pack (its new fingerprint) restarts the clock.
    const [old] = await db.select().from(t.arenaEventNotices).where(eq(t.arenaEventNotices.eventId, eventId));
    expect(await markPackSent(env, slug, "admin:t", old!.packRunsSha256!, t0 + DAY_MS)).toEqual({ ok: false, reason: "pack_stale" });
    expect(await markPackSent(env, slug, "admin:t", (await packDigest(db, eventId)).sha256, t0 + DAY_MS)).toEqual({ ok: true });
    expect(await publishHeld(env, slug, "admin:t", t0 + NOTICE_DAYS * DAY_MS)).toEqual({ ok: false, reason: "notice_period" });
    expect(await publishHeld(env, slug, "admin:t", t0 + (NOTICE_DAYS + 1) * DAY_MS)).toEqual({ ok: true });
  });

  it("the full pack: draft result with n and 95% intervals, method, exact model versions and signed replays of this event only", async () => {
    vi.restoreAllMocks();
    await env.KV.delete("arena:lock");
    const slug = "held-pack-test";
    const eventId = await planEvent(env, { slug, name: "Held pack", season: "s0", kind: "card", hold: true, models: [model.id], tasks: ["impossible"], seeds: [2_100_004, 2_100_005], attempts: 1 });
    // Another held event's run, which this pack must not carry.
    const otherId = await planEvent(env, { slug: "held-pack-other", name: "Held other", season: "s0", kind: "card", hold: true, models: [model.id], tasks: ["impossible"], seeds: [2_100_009], attempts: 1 });
    scripted();
    await processQueue(env, Date.now() + 60_000);
    // In this event but never in its pack: a held-out run (its seed is private) and an embargoed model's run.
    const db = getDb(env);
    const [own] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    const [other] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, otherId));
    const heldOut = { ...own!, id: newId(), seed: 2_100_777, heldOut: true };
    const embargoed = { ...own!, id: newId(), seed: 2_100_888, modelId: EMBARGOED.id };
    await db.insert(t.arenaRuns).values([heldOut, embargoed]);
    expect((await fetchWorker(`/admin/arena-held/${slug}/pack.json`, { redirect: "manual", headers: { Cookie: otherCookie } })).headers.get("Location")).toBe("/dashboard");
    const res = await fetchWorker(`/admin/arena-held/${slug}/pack.json`, { headers: { Cookie: cookie } });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const pack = (await res.json()) as any;
    expect(pack.pack).toMatchObject({ format: "forge-notice-pack/1", held: true, pack_sent_at: null });
    expect(pack.event).toMatchObject({ slug, status: "planned" });
    expect(pack.method).toMatchObject({ rules_in_force: RULES_VERSION, interval: "wilson_95_rounded_outwards", tasks: ["impossible"], seeds: [2_100_004, 2_100_005] });
    expect(pack.method.results_policy.notice_days).toBe(NOTICE_DAYS);
    expect(pack.models).toEqual([expect.objectContaining({ id: model.id, exact: expect.anything() })]);
    const d = pack.draft_result[0];
    expect(d.overall).toMatchObject({ attempts: 2, passes: { n: 2 }, rules_versions: [RULES_VERSION] });
    expect(d.overall.passes.ci_95).toHaveLength(2);
    expect(d.by_job[0]).toMatchObject({ task: "impossible", attempts: 2 });
    expect(pack.runs).toMatchObject({ count: 2, sha256: (await packDigest(db, eventId)).sha256 });
    expect(pack.replays).toHaveLength(2);
    const text = JSON.stringify(pack);
    for (const id of [heldOut.id, embargoed.id, other!.id]) expect(text).not.toContain(id);
    expect(text).not.toContain("2100777");
    expect(text).not.toContain("2100009");
    for (const doc of pack.replays) {
      expect(doc.event).toBe(slug);
      const r = await checkReplay(doc, sha256Hex, null);
      expect(r).toMatchObject({ chain: "ok", record: "ok" });
      expect(refereeCheck(doc)).toMatchObject({ checked: true, same_verdict: true });
    }
    const summary = (await (await fetchWorker(`/admin/arena-held/${slug}/pack.json?replays=0`, { headers: { Cookie: cookie } })).json()) as any;
    expect(summary.replays).toBeUndefined();
    expect(JSON.stringify(pack)).not.toMatch(SHOWS_EMBARGOED);
    // The page lists it with its buttons.
    const page = await (await fetchWorker("/admin/arena-held", { headers: { Cookie: cookie } })).text();
    expect(page).toContain(slug);
    expect(page).toContain("Mark full pack sent");
    expect(page).not.toContain("Publish held event</button>");
  });
});
