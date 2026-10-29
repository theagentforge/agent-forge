import { env } from "cloudflare:workers";
import { Validator } from "@cfworker/json-schema";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { feedIndex, modifiedCsv, OSV_ID_PREFIX, OSV_SCHEMA_VERSION, osvRecords, pinnedGithub, repoHeld, useOsvState, type MaintainerResponse, type OsvFeedState } from "../src/services/osv-feed";
import { crc32, unzipStore, zipStore } from "../src/services/zip";
import osvSchema from "./fixtures/osv-schema/schema-1.9.2.json";
import { fetchWorker } from "./helpers";
import "../src/index";

// AQ-10 (ADR 0097): the OSV feed. Every record must validate against the official OSV schema (ossf/osv-schema
// validation/schema.json, fetched 28 Oct 2026, schema 1.9.2; see fixtures/osv-schema/README.md).

const ORIGIN = env.PUBLIC_ORIGIN;
const NOW = Date.now();
const HELD_UNTIL = NOW + 86_400_000;
const C1 = "a".repeat(40);
const FIX = "b".repeat(40);
const hex = (ch: string) => ch.repeat(64);
const STATE: OsvFeedState = {
  held_until: new Date(HELD_UNTIL).toISOString(),
  held_repos: ["acme/held-skills"],
  fixtures: [`sha256:${hex("3")}`],
  maintainers: {
    "acme/held-skills": {
      notice: { date: "2026-10-28", url: "https://github.com/acme/held-skills/issues/1", rule_ids: ["FS-EXE-001"] },
      opted_out: false,
    },
  },
};
const RESPONSES: MaintainerResponse[] = [
  {
    repo: "acme/held-skills",
    path: "skills/x/SKILL.md",
    fingerprint: `sha256:${hex("1")}`,
    scanned_commit: C1,
    public_from: new Date(HELD_UNTIL).toISOString(),
    response: { date: "2026-10-28", thread_url: "https://github.com/acme/held-skills/issues/1", fix_label: "#2", fix_url: "https://github.com/acme/held-skills/pull/2", fix_commit: FIX, fix_date: "2026-10-28" },
    rescan: { date: "2026-10-28", commit: "c".repeat(40), fingerprint: `sha256:${hex("9")}`, verdict: "clear", rules_version: "2026-10-23.1" },
  },
];

const finding = (sev: "high" | "medium") => ({ rule: "FS-EXE-001", family: "exec", severity: sev, title: "Download piped into a shell", why: "", line: 7, column: 1, evidence: "curl x | sh" });
async function scan(fpHex: string, sourceUrl: string, opts: { verdict?: "flagged" | "caution"; pub?: boolean } = {}) {
  const verdict = opts.verdict ?? "flagged";
  await getDb(env)
    .insert(t.skillScans)
    .values({
      fingerprint: `sha256:${fpHex}`,
      name: "x",
      sourceUrl,
      verdict,
      findings: [finding(verdict === "flagged" ? "high" : "medium")],
      counts: { high: verdict === "flagged" ? 1 : 0, medium: verdict === "flagged" ? 0 : 1, low: 0 },
      rulesVersion: "2026-10-19.3",
      bytes: 100,
      public: opts.pub ?? true,
      scans: 1,
      firstSeen: Date.UTC(2026, 9, 19, 12),
      lastSeen: Date.UTC(2026, 9, 19, 12),
    })
    .onConflictDoNothing();
}
const raw = (repo: string, ref: string, path = "skills/x/SKILL.md") => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

const ajv = new Ajv2020({ strict: false, allErrors: true });
const ajvCheck = ajv.compile(osvSchema);
const cf = new Validator(osvSchema as never, "2020-12", false);
function valid(rec: unknown) {
  const a = ajvCheck(rec);
  const c = cf.validate(rec);
  return { ok: a && c.valid, errors: JSON.stringify({ ajv: ajvCheck.errors, cf: c.errors.slice(0, 5) }) };
}

beforeAll(async () => {
  useOsvState(STATE, RESPONSES);
  await scan(hex("1"), raw("acme/held-skills", C1)); // held until HELD_UNTIL, then fixed by the maintainer
  await scan(hex("2"), raw("vendor/skills", C1)); // public now
  await scan(hex("3"), raw("vendor/skills", C1, "tests/fixtures/SKILL.md")); // a scanner test fixture
  await scan(hex("4"), raw("vendor/skills", C1, "other/SKILL.md"), { pub: false }); // not public
  await scan(hex("5"), raw("vendor/skills", C1, "c/SKILL.md"), { verdict: "caution" }); // caution only
  await scan(hex("6"), raw("vendor/skills", "main")); // not pinned to a commit
  const db = getDb(env);
  const now = Date.now();
  await db.insert(t.tools).values([
    { id: "tool-osv-1", kind: "mcp_server", canonicalId: "npm:@acme/osv-test", createdAt: now },
    { id: "tool-osv-2", kind: "mcp_server", canonicalId: "npm:advisory-only", createdAt: now },
    { id: "tool-osv-3", kind: "skill", canonicalId: "github.com/acme/osv-skill", createdAt: now },
    { id: "tool-osv-4", kind: "mcp_server", canonicalId: "npm:marked-by-a-person", createdAt: now },
  ]);
  await db.insert(t.toolVersions).values([
    { id: "tv-osv-1", toolId: "tool-osv-1", version: "1.2.3", fingerprint: "npm:@acme/osv-test@1.2.3", firstSeenAt: now },
    { id: "tv-osv-2", toolId: "tool-osv-2", version: "0.1.0", fingerprint: "npm:advisory-only@0.1.0", advisoryMatch: true, firstSeenAt: now },
    { id: "tv-osv-3", toolId: "tool-osv-3", version: "abc", fingerprint: "sha256:x", firstSeenAt: now },
    { id: "tv-osv-4", toolId: "tool-osv-4", version: "9.9.9", fingerprint: "npm:marked-by-a-person@9.9.9", firstSeenAt: now },
  ]);
  const score = (id: string, status: "flagged" | "clear" | "confirmed_malicious") => ({ toolVersionId: id, distinctOwners: 2, verifiedOwners: 2, outcomeBreakdown: { worked: 0, partial: 0, failed: 2 }, securityStatus: status, updatedAt: now });
  await db.insert(t.toolScores).values([score("tv-osv-1", "flagged"), score("tv-osv-2", "flagged"), score("tv-osv-3", "clear"), score("tv-osv-4", "confirmed_malicious")]);
  await db.insert(t.statusEvents).values([
    { id: "se-1", toolVersionId: "tv-osv-1", fromStatus: "clear", toStatus: "flagged", reason: "field_reports", createdAt: now - 5000 },
    { id: "se-2", toolVersionId: "tv-osv-2", fromStatus: "clear", toStatus: "flagged", reason: "field_reports", createdAt: now - 5000 },
    { id: "se-3", toolVersionId: "tv-osv-3", fromStatus: "clear", toStatus: "flagged", reason: "field_reports", createdAt: now - 5000 },
    { id: "se-4", toolVersionId: "tv-osv-3", fromStatus: "flagged", toStatus: "clear", reason: "field_reports", createdAt: now - 1000 },
    { id: "se-5", toolVersionId: "tv-osv-4", fromStatus: "clear", toStatus: "flagged", reason: "field_reports", createdAt: now - 5000 },
    { id: "se-6", toolVersionId: "tv-osv-4", fromStatus: "flagged", toStatus: "confirmed_malicious", reason: "admin", createdAt: now - 2000 },
  ]);
});
afterAll(() => useOsvState(null));

const ofKind = (recs: Awaited<ReturnType<typeof osvRecords>>, kind: string) => recs.filter((r) => (r.database_specific as { kind: string }).kind === kind);

describe("OSV feed records", () => {
  it("publishes only public, flagged, commit-pinned, non-fixture scans, and nothing from a held repository before its date", async () => {
    const before = ofKind(await osvRecords(env, ORIGIN, HELD_UNTIL - 1), "skill-pattern-finding");
    expect(before.map((r) => (r.database_specific as { findings: unknown[] }) && (r.affected as any)[0].database_specific.file_sha256)).toEqual([hex("2")]);
    expect(JSON.stringify(before)).not.toContain("held-skills");
    expect(repoHeld("ACME/held-skills", HELD_UNTIL - 1)).toBe(true);
    expect(repoHeld("acme/held-skills", HELD_UNTIL)).toBe(false);
    const after = ofKind(await osvRecords(env, ORIGIN, HELD_UNTIL), "skill-pattern-finding");
    expect(after.map((r) => (r.affected as any)[0].database_specific.file_sha256).sort()).toEqual([hex("1"), hex("2")]);
  });

  it("every record validates against the official OSV schema (Ajv and @cfworker), with an x_ id and no severity", async () => {
    expect(osvSchema.$id).toContain("ossf/osv-schema");
    const recs = await osvRecords(env, ORIGIN, HELD_UNTIL);
    expect(recs.length).toBe(4);
    for (const r of recs) {
      const v = valid(r);
      expect(v.ok, `${r.id}: ${v.errors}`).toBe(true);
      expect(r.id).toMatch(new RegExp(`^${OSV_ID_PREFIX}-\\d{4}-[0-9A-F]{12}$`));
      expect(r.schema_version).toBe(OSV_SCHEMA_VERSION);
      expect(r).not.toHaveProperty("severity");
      expect(String(r.summary)).toContain("not a confirmed vulnerability");
      expect(String(r.summary).length).toBeLessThanOrEqual(120);
      expect((r.database_specific as { confirmed_vulnerability: boolean }).confirmed_vulnerability).toBe(false);
    }
    // The schema really rejects what we avoid: an unregistered prefix without x_, and a short commit in a GIT range.
    expect(valid({ ...recs[0], id: "FORGE-SKILL-2026-0001" }).ok).toBe(false);
    const bad = structuredClone(recs.find((r) => (r.database_specific as any).kind === "skill-pattern-finding")!) as any;
    bad.affected[0].ranges[0].events[0].introduced = "29f6fad";
    expect(valid(bad).ok).toBe(false);
    // Ids are stable across builds.
    expect((await osvRecords(env, ORIGIN, HELD_UNTIL)).map((r) => r.id)).toEqual(recs.map((r) => r.id));
  });

  it("carries the maintainer's notice and fix (a fixed event) and the right of reply; unfixed scans end at last_affected", async () => {
    const recs = ofKind(await osvRecords(env, ORIGIN, HELD_UNTIL), "skill-pattern-finding");
    const held = recs.find((r) => (r.affected as any)[0].database_specific.file_sha256 === hex("1"))! as any;
    expect(held.affected[0].ranges[0]).toEqual({ type: "GIT", repo: "https://github.com/acme/held-skills", events: [{ introduced: C1 }, { fixed: FIX }] });
    expect(held.database_specific.maintainer).toEqual({ state: "fixed_by_maintainer", notified_on: "2026-10-28", notice_url: "https://github.com/acme/held-skills/issues/1", fixed_on: "2026-10-28", fix_commit: FIX, fix_url: "https://github.com/acme/held-skills/pull/2", our_rescan: { date: "2026-10-28", commit: "c".repeat(40), verdict: "clear", rules_version: "2026-10-23.1" } });
    expect(held.details).toContain("acme/held-skills #2");
    expect(held.references).toContainEqual({ type: "FIX", url: "https://github.com/acme/held-skills/pull/2" });
    expect(held.references).toContainEqual({ type: "DISCUSSION", url: "https://github.com/acme/held-skills/issues/1" });
    expect(held.database_specific.right_of_reply_url).toBe(`${ORIGIN}/disputes?tool=github.com%2Facme%2Fheld-skills&scan=${hex("1")}&from=maintainer`);
    expect(held.published).toBe(new Date(HELD_UNTIL).toISOString().replace(/\.\d{3}Z$/, "Z"));
    const open = recs.find((r) => (r.affected as any)[0].database_specific.file_sha256 === hex("2"))! as any;
    expect(open.affected[0].ranges[0].events).toEqual([{ introduced: C1 }, { last_affected: C1 }]);
    expect(open.database_specific.maintainer).toEqual({ state: "no_notice" });
    expect(open.details).toContain("worth reading");
  });

  it("a maintainer change our rescan doesn't clear is not a fix: no fixed event, no FIX reference, open at the rescanned commit", async () => {
    const changed: MaintainerResponse = { ...RESPONSES[0]!, rescan: { ...RESPONSES[0]!.rescan!, verdict: "flagged" } };
    useOsvState(STATE, [changed]);
    try {
      const recs = ofKind(await osvRecords(env, ORIGIN, HELD_UNTIL), "skill-pattern-finding");
      const rec = recs.find((r) => (r.affected as any)[0].database_specific.file_sha256 === hex("1"))! as any;
      expect(valid(rec).ok, valid(rec).errors).toBe(true);
      expect(rec.affected[0].ranges[0].events).toEqual([{ introduced: C1 }, { last_affected: "c".repeat(40) }]);
      expect(rec.database_specific.maintainer).toEqual({ state: "changed_still_matching", notified_on: "2026-10-28", notice_url: "https://github.com/acme/held-skills/issues/1", changed_on: "2026-10-28", change_commit: FIX, change_url: "https://github.com/acme/held-skills/pull/2", our_rescan: { date: "2026-10-28", commit: "c".repeat(40), verdict: "flagged", rules_version: "2026-10-23.1" } });
      expect(rec.references).not.toContainEqual(expect.objectContaining({ type: "FIX" }));
      expect(rec.references).toContainEqual({ type: "WEB", url: "https://github.com/acme/held-skills/pull/2" });
      expect(rec.details).toContain("still matches (flagged)");
      expect(JSON.stringify(rec)).not.toMatch(/fixed/);
    } finally {
      useOsvState(STATE, RESPONSES);
    }
  });

  it("field-report flags: npm package and version, never an advisory-only flag; a version no longer flagged is withdrawn", async () => {
    const recs = ofKind(await osvRecords(env, ORIGIN, HELD_UNTIL), "field-report-flag") as any[];
    expect(recs.map((r) => r.database_specific.forge_tool_id).sort()).toEqual(["github.com/acme/osv-skill", "npm:@acme/osv-test"]);
    const npm = recs.find((r) => r.database_specific.forge_tool_id === "npm:@acme/osv-test");
    expect(npm.affected).toEqual([{ package: { ecosystem: "npm", name: "@acme/osv-test", purl: "pkg:npm/%40acme/osv-test" }, versions: ["1.2.3"], database_specific: { fingerprint: "npm:@acme/osv-test@1.2.3" } }]);
    expect(npm.withdrawn).toBeUndefined();
    const gh = recs.find((r) => r.database_specific.forge_tool_id === "github.com/acme/osv-skill");
    expect(gh.affected).toBeUndefined();
    expect(gh.withdrawn).toBeTruthy();
    expect(gh.database_specific.security_status).toBe("clear");
  });

  it("never says 'malicious': a version a person marked confirmed malicious is left out (a human decision), and no record uses the word", async () => {
    const recs = await osvRecords(env, ORIGIN, HELD_UNTIL);
    expect(JSON.stringify(recs)).not.toContain("marked-by-a-person");
    expect(JSON.stringify(recs)).not.toMatch(/malicious|malware/i);
    const held = recs.find((r) => (r.affected as any)?.[0]?.database_specific?.file_sha256 === hex("1")) as any;
    expect(held.details).toContain("earlier commits were not scanned");
  });

  it("pinnedGithub accepts only raw links pinned to a full commit", () => {
    expect(pinnedGithub(raw("a/b", C1))).toEqual({ owner: "a", repo: "b", commit: C1, path: "skills/x/SKILL.md" });
    expect(pinnedGithub(raw("a/b", "main"))).toBeNull();
    expect(pinnedGithub(`https://example.com/a/b/${C1}/SKILL.md`)).toBeNull();
    expect(pinnedGithub(null)).toBeNull();
  });
});

describe("OSV feed routes", () => {
  it("serves an index, all.json, modified_id.csv (newest first), all.zip that round-trips, and each record", async () => {
    // The route uses the real clock, which is before HELD_UNTIL: the held repository is absent.
    const idx = (await (await fetchWorker("/feeds/osv")).json()) as ReturnType<typeof feedIndex>;
    expect(idx.format).toBe("OSV");
    expect(idx.schema_url).toBe("https://raw.githubusercontent.com/ossf/osv-schema/main/validation/schema.json");
    expect(idx.licence.id).toBe("evaluation-only");
    expect(idx.all_zip).toBe(`${ORIGIN}/feeds/osv/all.zip`);
    const resAll = await fetchWorker("/feeds/osv/all.json");
    expect(resAll.headers.get("Link")).toContain('rel="describedby"');
    expect(resAll.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const all = (await resAll.json()) as { id: string; modified: string }[];
    expect(all.length).toBe(idx.records);
    expect(JSON.stringify(all)).not.toContain("held-skills");
    const csv = await (await fetchWorker("/feeds/osv/modified_id.csv")).text();
    expect(csv).toBe(modifiedCsv(all as never));
    const lines = csv.trim().split("\n");
    expect(lines.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z,x_FORGE-\d{4}-[0-9A-F]{12}$/.test(l))).toBe(true);
    expect([...lines].sort().reverse()).toEqual(lines.slice().sort((a, b) => (a < b ? 1 : -1)));
    const zipRes = await fetchWorker("/feeds/osv/all.zip");
    expect(zipRes.headers.get("Content-Type")).toBe("application/zip");
    const files = unzipStore(new Uint8Array(await zipRes.arrayBuffer()));
    expect([...files.keys()].sort()).toEqual(all.map((r) => `${r.id}.json`).sort());
    for (const r of all) expect(JSON.parse(new TextDecoder().decode(files.get(`${r.id}.json`)))).toEqual(r);
    const one = await fetchWorker(`/feeds/osv/${all[0]!.id}.json`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(all[0]);
    expect((await fetchWorker("/feeds/osv/x_FORGE-2026-000000000000.json")).status).toBe(404);
    const sec = await (await fetchWorker("/security", { headers: { Accept: "text/html" } })).text();
    expect(sec).toContain('id="osv-feed"');
    expect(sec).toContain('href="/feeds/osv/all.zip"');
  });

  it("cache: 10 minutes at most, and the 2 Nov gate runs on the server clock per request (a URL first fetched before it never shows held rows)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(HELD_UNTIL - 1);
      const early = await fetchWorker("/feeds/osv/all.json?gate=early");
      expect(early.headers.get("Cache-Control")).toBe("public, max-age=600");
      expect(await early.text()).not.toContain("held-skills");
      vi.setSystemTime(HELD_UNTIL);
      expect(await (await fetchWorker("/feeds/osv/all.json?gate=late")).text()).toContain("held-skills");
      for (const p of ["/feeds/osv", "/feeds/osv/modified_id.csv", "/feeds/osv/all.zip"]) expect((await fetchWorker(`${p}?gate=late`)).headers.get("Cache-Control"), p).toBe("public, max-age=600");
    } finally {
      vi.useRealTimers();
    }
  });

  it("all.zip is a well-formed archive: the end record and the central directory (read independently of unzipStore) match each local entry", async () => {
    const zip = new Uint8Array(await (await fetchWorker("/feeds/osv/all.zip?z=1")).arrayBuffer());
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    const entries = v.getUint16(eocd + 10, true);
    const cdSize = v.getUint32(eocd + 12, true);
    const cdOffset = v.getUint32(eocd + 16, true);
    expect(cdOffset + cdSize).toBe(eocd);
    const all = (await (await fetchWorker("/feeds/osv/all.json?z=1")).json()) as { id: string }[];
    expect(entries).toBe(all.length);
    let at = cdOffset;
    const dec = new TextDecoder();
    for (let i = 0; i < entries; i++) {
      expect(v.getUint32(at, true)).toBe(0x02014b50);
      const crc = v.getUint32(at + 16, true);
      const size = v.getUint32(at + 24, true);
      const nameLen = v.getUint16(at + 28, true);
      const extraLen = v.getUint16(at + 30, true);
      const commentLen = v.getUint16(at + 32, true);
      const local = v.getUint32(at + 42, true);
      const name = dec.decode(zip.subarray(at + 46, at + 46 + nameLen));
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      expect(dec.decode(zip.subarray(local + 30, local + 30 + v.getUint16(local + 26, true)))).toBe(name);
      expect(v.getUint32(local + 14, true)).toBe(crc);
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = zip.subarray(start, start + size);
      expect(crc32(data)).toBe(crc);
      expect(JSON.parse(dec.decode(data)).id).toBe(name.replace(/\.json$/, ""));
      at += 46 + nameLen + extraLen + commentLen;
    }
    expect(at).toBe(eocd);
  });

  it("the zip writer: known CRC-32, and a fixture with one flagged skill round-trips", async () => {
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
    const recs = ofKind(await osvRecords(env, ORIGIN, HELD_UNTIL - 1), "skill-pattern-finding");
    expect(recs.length).toBe(1);
    const zip = zipStore([{ name: `${recs[0]!.id}.json`, data: new TextEncoder().encode(JSON.stringify(recs[0])) }]);
    const back = JSON.parse(new TextDecoder().decode(unzipStore(zip).get(`${recs[0]!.id}.json`)));
    expect(back).toEqual(recs[0]);
    expect(valid(back).ok).toBe(true);
  });
});
