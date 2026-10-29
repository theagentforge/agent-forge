import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { finishedRuns } from "../src/arena/views";
import { buildExport, chunkRows, exportRows, EXPORT_INDEX_KEY, exportIndex, isoWeek, MAX_FILE_BYTES, readManifest, scrubber, sha256Hex, weeklyExport, writeExport } from "../src/services/bulk-export";
import { BUYER_COOKIE, createLink, SHARE_PREFIX } from "../src/services/data-room";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { DATA_CONTROLS } from "../src/services/kpis";
import { NOTICE_ENDS, useHeldFile } from "../src/services/skill-seed";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker, profile } from "./helpers";
import "../src/index";

// AQ-03 (ADR 0095): the pseudonymised weekly bulk export. No GitHub login or email in any row, a SHA-256 per file and a
// manifest, exports_pseudonymised true, and nothing private: no embargoed model, held-out seed, lab arm or held scan.

const NOW = NOTICE_ENDS - 86_400_000; // inside the launch-scan hold, so a held scan exists
const LOGIN = "zq-export-member";
const EMAIL = "someone.private@example.org";
const HELD_HEX = "c".repeat(64);
const ids: Record<string, string> = {};
let adminCookie = "";

async function run(model: string, heldOut: boolean) {
  const db = getDb(env);
  const eventId = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: eventId, slug: `bx-${eventId.slice(0, 8)}`, name: "Export test", season: "s0", kind: "card", status: "done" });
  const a = new Attempt(taskById("scam-invoice")!, 1_000_321);
  a.recordTurn({ tokensIn: 100, tokensOut: 10, cost: 0.001, latencyMs: 100, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const result = a.end("finished") as AttemptResult;
  const id = crypto.randomUUID();
  await db.insert(t.arenaRuns).values({ id, eventId, modelId: model, task: "scam-invoice", seed: 1_000_321, attemptNo: 1, status: "done", passed: true, score: 0.5, cost: 0.001, tokens: 110, result, log: a.log, heldOut, finishedAt: NOW - 3_600_000 });
  return id;
}

const scan = (fp: string, sourceUrl: string | null, isPublic = true) => ({
  fingerprint: fp, name: `Skill contact ${EMAIL}`, sourceUrl, verdict: "caution" as const, findings: [{ rule: "x", text: `mail ${EMAIL}` }], counts: {}, rulesVersion: "1", bytes: 10, public: isPublic, scans: 1, firstSeen: NOW - 1000, lastSeen: NOW - 1000,
});

beforeAll(async () => {
  const db = getDb(env);
  const member = await upsertHuman(db, profile({ login: LOGIN }), NOW);
  const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS) }), NOW);
  adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
  const agentId = crypto.randomUUID();
  await db.insert(t.agents).values({ id: agentId, humanId: member.id, handle: `${LOGIN}-bot`, framework: "claude-code", oauthClientId: "c1" });
  const toolId = crypto.randomUUID();
  const tvId = crypto.randomUUID();
  await db.insert(t.tools).values({ id: toolId, kind: "npm", canonicalId: "npm:export-test-tool" });
  await db.insert(t.toolVersions).values({ id: tvId, toolId, version: "1.0.0", fingerprint: "sha256:" + "a".repeat(64), firstSeenAt: NOW });
  const report = (note: string, extra: Partial<typeof t.reports.$inferInsert> = {}) => ({ id: crypto.randomUUID(), agentId, humanId: member.id, toolVersionId: tvId, taskCategory: "coding", framework: "claude-code", outcome: "worked" as const, issues: [], note, moderationState: "none" as const, serverSignature: "sig", createdAt: NOW - 5000, ...extra });
  const shown = report(`Worked well. Ping @${LOGIN} or ${EMAIL} (also ${LOGIN.toUpperCase()}, my agent ${LOGIN}-bot).`, { moderationState: "approved" });
  const held = report("held one", { held: true });
  const pending = report("PENDING-NOTE-TEXT not yet moderated", { moderationState: "pending" });
  const unmoderated = report("UNMODERATED-NOTE-TEXT", { moderationState: "none" });
  ids.report = shown.id;
  ids.heldReport = held.id;
  ids.pending = pending.id;
  await db.insert(t.reports).values([shown, held, pending, unmoderated]);
  await db.insert(t.skillScans).values([scan("sha256:" + "d".repeat(64), "https://github.com/open/skills"), scan("sha256:" + HELD_HEX, null), scan("sha256:" + "e".repeat(64), null, false)]);
  useHeldFile({ meta: { rules_version: "1", files: 1 }, repos: [["heldco/skills", "main"]], rows: [[0, "weather/SKILL.md", HELD_HEX, 0, 0]] });
  ids.public = await run("claude-sonnet-5.5", false);
  ids.heldOut = await run("claude-sonnet-5.5", true);
  ids.embargoed = await run(EMBARGOED.id, false);
});
afterAll(() => useHeldFile(null));

describe("the bulk export (AQ-03)", () => {
  it("has no GitHub login, handle or email in any row, and pseudonyms instead of people", async () => {
    const { manifest, files } = await buildExport(env, NOW);
    const all = [...files.values()].join("\n");
    expect(all.toLowerCase()).not.toContain(LOGIN);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(all).not.toMatch(/github_login|"email"|"handle"/);
    const reports = files.get("reports-0001.jsonl")!.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    // Report ids are pseudonyms too: public pages show a report's id next to its agent's handle.
    expect(all).not.toContain(ids.report);
    expect(reports.every((r) => /^report_[0-9a-f]{20}$/.test(String(r.id)))).toBe(true);
    const mine = reports.find((r) => String(r.note ?? "").startsWith("Worked well"))!;
    expect(mine.owner).toMatch(/^owner_[0-9a-f]{20}$/);
    expect(mine.agent).toMatch(/^agent_[0-9a-f]{20}$/);
    expect(mine.note).toContain("[member removed]");
    expect(mine.note).toContain("[email removed]");
    expect(all).not.toContain("held one");
    expect(reports).toHaveLength(3);
    // Notes moderation hasn't approved are never public, so never exported.
    expect(all).not.toContain("PENDING-NOTE-TEXT");
    expect(all).not.toContain("UNMODERATED-NOTE-TEXT");
    expect(manifest.pseudonym_key).toBe("session_secret");
    // The same person gets the same pseudonym next time.
    const again = (await buildExport(env, NOW)).files.get("reports-0001.jsonl")!;
    expect(again).toContain(String(mine.owner));
    expect(manifest.exports_pseudonymised).toBe(true);
    expect(DATA_CONTROLS.exports_pseudonymised).toBe(true);
  });

  it("leaves out embargoed models, held-out seeds, held scans and unlisted scans", async () => {
    const { files, manifest } = await buildExport(env, NOW);
    const all = [...files.values()].join("\n");
    expect(all).toContain(ids.public);
    expect(all).not.toContain(ids.heldOut);
    expect(all).not.toContain(ids.embargoed);
    expect(all).not.toContain(EMBARGOED.id);
    expect(all).not.toContain(HELD_HEX);
    expect(all).not.toContain("e".repeat(64));
    expect(all).toContain("d".repeat(64));
    expect(all).not.toMatch(/FA-[A-Z]+-1\d\d/);
    expect(manifest.excluded.join(" ")).toMatch(/held-out seeds/);
  });

  it("gives every file a SHA-256 in the manifest, a CSV twin and a Croissant description", async () => {
    const { manifest, files } = await buildExport(env, NOW);
    expect(manifest.files.map((f) => f.name)).toEqual(expect.arrayContaining(["runs-0001.jsonl", "runs-0001.csv", "reports-0001.jsonl", "reports-0001.csv", "scans-0001.jsonl", "scans-0001.csv", "croissant.json"]));
    for (const f of manifest.files) {
      expect(f.sha256).toBe(await sha256Hex(files.get(f.name)!));
      expect(f.bytes).toBe(new TextEncoder().encode(files.get(f.name)!).length);
    }
    expect(manifest.counts.reports).toBe(3);
    const croissant = JSON.parse(files.get("croissant.json")!) as { distribution: { sha256: string; name: string }[] };
    expect(croissant.distribution.find((d) => d.name === "runs-0001.jsonl")!.sha256).toBe(manifest.files.find((f) => f.name === "runs-0001.jsonl")!.sha256);
    expect(files.get("reports-0001.csv")!.split("\n")[0]).toContain("owner");
  });

  it("is stored privately, downloads match their checksums, and a buyer link gets it only when allowed (logged)", async () => {
    const m = await writeExport(env, NOW);
    expect((await readManifest(env, m.export_id))!.files).toHaveLength(m.files.length);
    // Admins only.
    expect((await fetchWorker(`/admin/data-room/export/${m.export_id}/runs-0001.jsonl`)).status).toBe(403);
    const res = await fetchWorker(`/admin/data-room/export/${m.export_id}/runs-0001.jsonl`, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(await sha256Hex(await res.text())).toBe(m.files.find((f) => f.name === "runs-0001.jsonl")!.sha256);
    expect((await fetchWorker(`/admin/data-room/export/${m.export_id}/..%2Fsecret`, { headers: { Cookie: adminCookie } })).status).toBe(404);

    const link = await createLink(env, { label: "Delta", days: 7, ndaVersion: "buyer-own-nda", includeExport: true, by: "admin:test" });
    const cookie = `${BUYER_COOKIE}=${link.token}`;
    const file = `${SHARE_PREFIX}export/${m.export_id}/manifest.json`;
    expect((await fetchWorker(file)).status).toBe(404); // no cookie
    expect((await fetchWorker(file, { headers: { Cookie: cookie } })).status).toBe(403); // not confirmed yet
    await getDb(env).update(t.dataRoomLinks).set({ confirmedAt: Date.now(), confirmedNdaVersion: "buyer-own-nda", confirmedOrg: "Delta" }).where(eq(t.dataRoomLinks.id, link.id));
    const ok = await fetchWorker(file, { headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toContain("no-store");
    expect(((await ok.json()) as { exports_pseudonymised: boolean }).exports_pseudonymised).toBe(true);
    const log = await getDb(env).select().from(t.dataRoomAccess).where(eq(t.dataRoomAccess.linkId, link.id));
    expect(log.map((x) => x.event)).toEqual(expect.arrayContaining(["refused_unconfirmed", "download"]));
    // Expiry and revocation are checked on the download itself, not only on the page.
    await getDb(env).update(t.dataRoomLinks).set({ expiresAt: Date.now() - 1 }).where(eq(t.dataRoomLinks.id, link.id));
    expect((await fetchWorker(file, { headers: { Cookie: cookie } })).status).toBe(410);
    await getDb(env).update(t.dataRoomLinks).set({ expiresAt: Date.now() + 86_400_000, revokedAt: Date.now() }).where(eq(t.dataRoomLinks.id, link.id));
    expect((await fetchWorker(file, { headers: { Cookie: cookie } })).status).toBe(410);
    // No public path reaches it.
    expect((await fetchWorker(`/data-room/export/${m.export_id}/manifest.json`)).status).toBe(404);
    expect((await fetchWorker(`/data-room/${link.token}/export/${m.export_id}/manifest.json`)).status).toBe(404);
  });

  it("is written once per ISO week by the hourly job", async () => {
    const week = Date.UTC(2026, 11, 7, 3); // Monday 7 Dec 2026
    const a = await weeklyExport(env, week);
    const b = await weeklyExport(env, week + 3_600_000);
    expect(a).toMatchObject({ written: true, week: "2026-W50" });
    expect(b).toMatchObject({ written: false, week: "2026-W50" });
    expect((await exportIndex(env)).filter((x) => x.week === "2026-W50" && x.trigger === "weekly")).toHaveLength(1);
  });
});

describe("size and completeness", () => {
  it("splits files by bytes as well as rows, and refuses one row too big for a file", () => {
    const row = { x: "y".repeat(1000) };
    const parts = chunkRows(Array.from({ length: 50 }, () => row), 5000, 64 * 1024 + 20_000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(2 * new TextEncoder().encode(p.map((r) => JSON.stringify(r)).join("\n")).length).toBeLessThanOrEqual(64 * 1024 + 20_000);
    expect(parts.flat()).toHaveLength(50);
    expect(chunkRows([], 5000)).toEqual([[]]);
    expect(() => chunkRows([{ x: "y".repeat(MAX_FILE_BYTES) }])).toThrow(/over the per-file limit/);
  });

  it("exports every public run, read in pages (not capped at /arena/dataset.json's newest 5,000)", async () => {
    const all = await finishedRuns(getDb(env), { hard: true, now: NOW, limit: 1_000_000 });
    expect(all.length).toBeGreaterThanOrEqual(1);
    const paged = await exportRows(env, NOW, 1); // one run per page: every page boundary exercised
    expect(paged.runs.map((r) => r.id).sort()).toEqual(all.map((r) => r.summary.id).sort());
    const { manifest } = await buildExport(env, NOW);
    expect(manifest.counts.runs).toBe(all.length);
    for (const f of manifest.files) expect(f.bytes).toBeLessThanOrEqual(MAX_FILE_BYTES);
  });

  it("a failed export lists nothing and leaves nothing downloadable", async () => {
    const before = await env.KV.get(EXPORT_INDEX_KEY);
    const broken = { ...env, KV: { ...env.KV, put: async () => { throw new Error("kv down"); }, get: env.KV.get.bind(env.KV), delete: env.KV.delete.bind(env.KV) } } as unknown as Env;
    await expect(writeExport(broken, NOW + 7_000)).rejects.toThrow(/kv down/);
    expect(await env.KV.get(EXPORT_INDEX_KEY)).toBe(before);
  });
});

describe("helpers", () => {
  it("ISO weeks", () => {
    expect(isoWeek(Date.UTC(2026, 9, 28))).toBe("2026-W44");
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe("2025-W01");
  });

  it("removes emails and whole-word logins, not parts of other words", () => {
    const s = scrubber(["bob", "zq-x"]);
    expect(s.text("ask bob, @Bob or a@b.co; bobby and zq-x-y stay")).toBe("ask [member removed], [member removed] or [email removed]; bobby and zq-x-y stay");
  });
});
