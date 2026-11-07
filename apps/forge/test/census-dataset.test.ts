import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb, newId } from "../src/services/db";
import {
  buildCensusFiles,
  frozenPath,
  buildSeries,
  CENSUS_GAPS,
  censusSchema,
  CENSUS_STATEMENT,
  censusTick,
  FAILURE_CLASSES,
  failureClass,
  firstDates,
  METRICS,
  publishCensus,
  sha256Hex,
  writeDailySnapshot,
} from "../src/services/census";
import { OUTCOMES, storeRun, storeSweep } from "../src/services/house-report";
import { copyKvNights, FAMILIES } from "../src/services/house-results";
import { HOUSE_TOOLS_SOURCE, storeToolLists } from "../src/services/house-tools";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0129 (build plan 5 Nov, P0 items 1 and 2): history that is never overwritten, a daily snapshot that is written
// once and never backfilled, and census files whose hashes match what is served.

const ms = (iso: string) => Date.parse(iso);
const entry = (pkg: string, outcome: string, over: Record<string, unknown> = {}) => ({ pkg, version: "1.0.0", outcome, slow: false, tools: outcome === "worked" ? 2 : null, ms: 3000, downloads: 100, rank: 1, ...over });
const addTool = async (canonicalId: string, createdAt = Date.now()) => {
  const id = newId();
  await getDb(env).insert(t.tools).values({ id, kind: "mcp_server", canonicalId, createdAt });
  return id;
};
const list = (id: string, description: string) => ({ servers: [{ id, version: "1.0.0", tools: [{ name: "echo", description, schema: null }] }] });

describe("Tool descriptions are append-only (P0 item 1)", () => {
  it("adds a row per new description set, moves only last_seen on a repeat, and keeps every earlier set", async () => {
    const toolId = await addTool("npm:census-hist-mcp");
    const db = getDb(env);
    const rows = () => db.select().from(t.toolDescriptionHistory).where(eq(t.toolDescriptionHistory.toolId, toolId)).orderBy(t.toolDescriptionHistory.firstSeen);

    expect((await storeToolLists(env, list("npm:census-hist-mcp", "Returns its input."), ms("2026-11-01T03:00:00Z"))).ok).toBe(true);
    // The same set the next night: no new row, the scan fields untouched, last_seen moved.
    const again = await storeToolLists(env, list("npm:census-hist-mcp", "Returns its input."), ms("2026-11-02T03:00:00Z"));
    expect(again).toMatchObject({ scanned: 0, unchanged: 1, history: { sightings: 1 } });
    let r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ firstSeen: ms("2026-11-01T03:00:00Z"), lastSeen: ms("2026-11-02T03:00:00Z"), descriptionsCount: 1, carried: false });
    expect(r[0]!.descriptionSha256).toMatch(/^[0-9a-f]{64}$/);

    // A changed description is a second row; the first keeps its text and dates.
    await storeToolLists(env, list("npm:census-hist-mcp", "Returns its input, unchanged."), ms("2026-11-03T03:00:00Z"));
    // A late, out-of-order sighting of the old set never moves last_seen back.
    await storeToolLists(env, list("npm:census-hist-mcp", "Returns its input."), ms("2026-11-01T05:00:00Z"));
    r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]!.lastSeen).toBe(ms("2026-11-02T03:00:00Z"));
    expect((r[0]!.toolList as { description: string }[])[0]!.description).toBe("Returns its input.");
    expect((r[1]!.toolList as { description: string }[])[0]!.description).toBe("Returns its input, unchanged.");
    expect(r[0]!.descriptionSha256).not.toBe(r[1]!.descriptionSha256);

    // The tool page's public signal is still the one current reading.
    const signals = await db.select().from(t.publicSignals).where(sql`${t.publicSignals.toolId} = ${toolId} AND ${t.publicSignals.source} = ${HOUSE_TOOLS_SOURCE}`);
    expect(signals).toHaveLength(1);
    expect(JSON.stringify(signals[0]!.payload)).toContain("Returns its input.");
  });
});

describe("House results are kept per server per night, per family (P0 item 1)", () => {
  it("keeps each night, replaces a same-night re-run, and keeps the nightly run and the sweep apart", async () => {
    const db = getDb(env);
    const night = (d: string) => db.select().from(t.houseResults).where(eq(t.houseResults.night, d));
    await storeRun(env, { probedAt: "2025-02-01T03:00:00.000Z", entries: [entry("a-mcp", "worked"), entry("b-mcp", "failed", { rank: 2 })] });
    await storeRun(env, { probedAt: "2025-02-02T03:00:00.000Z", entries: [entry("a-mcp", "worked")] });
    // A re-run on 2 Feb replaces 2 Feb only.
    await storeRun(env, { probedAt: "2025-02-02T04:00:00.000Z", entries: [entry("a-mcp", "no_answer"), entry("c-mcp", "worked", { rank: 2 })] });
    await storeSweep(env, { probedAt: "2025-02-02T06:00:00.000Z", entries: [entry("a-mcp", "worked", { rank: null }), entry("py-mcp", "not_on_pypi", { registry: "pypi", rank: null })] });
    expect(await night("2025-02-01")).toHaveLength(2);
    const feb2 = await night("2025-02-02");
    expect(feb2.filter((r) => r.family === FAMILIES.top500).map((r) => `${r.server}:${r.outcome}`).sort()).toEqual(["npm:a-mcp:no_answer", "npm:c-mcp:worked"]);
    expect(feb2.filter((r) => r.family === FAMILIES.sweep).map((r) => r.server).sort()).toEqual(["npm:a-mcp", "pypi:py-mcp"]);
  });

  it("copies nights still only in KV, once, and skips days KV no longer keeps", async () => {
    const now = ms("2026-11-05T00:17:00Z");
    const run = { probedAt: "2026-11-01T02:50:00.000Z", entries: [entry("kv-only-mcp", "worked")], counts: {} };
    await env.KV.put("house:history", JSON.stringify([{ day: "2026-06-01", total: 1, counts: {} }, { day: "2026-11-01", total: 1, counts: {} }]));
    await env.KV.put("house:run:2026-11-01", JSON.stringify(run));
    await env.KV.put("house:sweep:history", JSON.stringify([]));
    const first = await copyKvNights(env, now);
    expect(first).toMatchObject({ copied: 1 });
    const second = await copyKvNights(env, now);
    expect(second).toMatchObject({ pending: 0, copied: 0 }); // 1 Jun is past KV's 120 days: never tried
    const rows = await getDb(env).select().from(t.houseResults).where(eq(t.houseResults.server, "npm:kv-only-mcp"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ night: "2026-11-01", origin: "kv_copy", family: FAMILIES.top500 });
  });
});

describe("Failure classes v1", () => {
  it("maps every House outcome, and anything else to other", () => {
    for (const o of OUTCOMES) {
      const c = failureClass(o);
      expect(c === null || c in FAILURE_CLASSES).toBe(true);
    }
    expect(failureClass("worked")).toBeNull();
    expect(failureClass("partial")).toBeNull();
    expect(failureClass("not_on_npm")).toBe("not_on_registry");
    expect(failureClass("something_new")).toBe("other");
  });
});

describe("Daily metrics snapshot", () => {
  it("writes the day just ended once, and never an earlier day", async () => {
    const db = getDb(env);
    await addTool("npm:census-snap-a", ms("2025-03-09T10:00:00Z"));
    await addTool("npm:census-snap-b", ms("2025-03-10T10:00:00Z"));
    await db.insert(t.skillScans).values({ fingerprint: `sha256:${"a".repeat(64)}`, verdict: "clear", findings: [], counts: {}, rulesVersion: "r", bytes: 1, firstSeen: ms("2025-03-10T05:00:00Z"), lastSeen: ms("2025-03-10T05:00:00Z") });
    await storeRun(env, { probedAt: "2025-03-10T03:00:00.000Z", entries: [entry("s-a", "worked"), entry("s-b", "needs_config", { rank: 2 }), entry("s-c", "error", { rank: 3 })] });

    const now = ms("2025-03-11T00:17:00Z");
    const first = await writeDailySnapshot(env, now);
    expect(first.date).toBe("2025-03-10");
    expect(first.written).toBeGreaterThan(0);
    const snap = async (date: string) => Object.fromEntries((await db.select().from(t.metricSnapshots).where(eq(t.metricSnapshots.date, date))).map((r) => [r.metric, r.value]));
    const s = await snap("2025-03-10");
    expect(s).toMatchObject({
      "top500_nightly.servers_attempted": 3,
      "top500_nightly.servers_installed": 1,
      "top500_nightly.servers_failed": 2,
      "top500_nightly.failed.needs_config": 1,
      "top500_nightly.failed.test_error": 1,
      "tools_tracked.total": 2,
      "tools_tracked.new": 1,
      "skill_files.scanned_total": 1,
      "skill_files.new": 1,
    });
    // No sweep that day and no descriptions: those families are absent, not zero.
    expect(Object.keys(s).some((k) => k.startsWith("weekly_sweep.") || k.startsWith("tool_descriptions."))).toBe(false);

    // Idempotent: more data and a second run the same day change nothing already written.
    await addTool("npm:census-snap-c", ms("2025-03-10T23:00:00Z"));
    expect((await writeDailySnapshot(env, now + 3_600_000)).written).toBe(0);
    expect((await snap("2025-03-10"))["tools_tracked.total"]).toBe(2);
    // Never backfilled: a later day's run writes that day only; 9 Mar stays empty.
    await writeDailySnapshot(env, ms("2025-03-12T00:17:00Z"));
    expect(Object.keys(await snap("2025-03-09"))).toHaveLength(0);
    expect((await snap("2025-03-11"))["tools_tracked.new"]).toBe(0); // a measured day with none new is a real 0
  });

  it("the cron step writes the snapshot only in the first run after midnight UTC", async () => {
    const db = getDb(env);
    await censusTick(env, ms("2025-04-02T05:17:00Z"));
    expect(await db.$count(t.metricSnapshots, eq(t.metricSnapshots.date, "2025-04-01"))).toBe(0);
    await censusTick(env, ms("2025-04-03T00:17:00Z"));
    expect(await db.$count(t.metricSnapshots, eq(t.metricSnapshots.date, "2025-04-02"))).toBeGreaterThan(0);
  });
});

describe("Census series", () => {
  it("starts each metric on its first stored date and never zero-fills before it", async () => {
    const db = getDb(env);
    await storeRun(env, { probedAt: "2024-06-03T03:00:00.000Z", entries: [entry("z-mcp", "worked")] });
    await storeRun(env, { probedAt: "2024-06-05T03:00:00.000Z", entries: [entry("z-mcp", "failed")] });
    await storeSweep(env, { probedAt: "2024-06-05T06:00:00.000Z", entries: [entry("z-mcp", "worked", { rank: null }), entry("y-mcp", "worked", { rank: null }), entry("x-mcp", "no_answer", { rank: null })] });
    await db.insert(t.skillScans).values({ fingerprint: `sha256:${"b".repeat(64)}`, verdict: "clear", findings: [], counts: {}, rulesVersion: "r", bytes: 1, firstSeen: ms("2024-06-04T05:00:00Z"), lastSeen: ms("2024-06-04T05:00:00Z") });
    const series = await buildSeries(env, "2024-06-06");
    const days = (m: string) => series.filter((r) => r.metric === m).map((r) => r.date_utc);
    expect(days("top500_nightly.servers_attempted")).toEqual(["2024-06-03", "2024-06-05"]); // no row for 4 Jun: no run
    expect(days("weekly_sweep.servers_tested")).toEqual(["2024-06-05"]);
    expect(days("skill_files.new")).toEqual(["2024-06-04"]);
    expect(days("tools_tracked.total")).toEqual([]); // snapshot-only metric: not yet measured, no invented history
    expect(series.every((r) => r.date_utc <= "2024-06-06")).toBe(true);
    const first = firstDates(series);
    expect(first["top500_nightly.servers_attempted"]).toBe("2024-06-03");
    expect(first["tools_tracked.total"]).toBeNull();

    // Separate families: the sweep's denominator is its own (3), the night's its own (1).
    const v = (m: string, d: string) => series.find((r) => r.metric === m && r.date_utc === d)?.value;
    expect(v("top500_nightly.servers_attempted", "2024-06-05")).toBe(1);
    expect(v("weekly_sweep.servers_tested", "2024-06-05")).toBe(3);
    expect(v("weekly_sweep.servers_installed", "2024-06-05")).toBe(2);
    expect(v("top500_nightly.failed.install_failed", "2024-06-05")).toBe(1);
    expect(series.every((r) => METRICS.some((m) => m.metric === r.metric))).toBe(true);
    expect(METRICS.every((m) => m.metric.split(".")[0] === m.family)).toBe(true);
  });

  it("1–4 Nov 2026 (lean mode stopped storing skill scans) are 'not measured' rows, never 0, in series.csv/json and schema.json", async () => {
    const db = getDb(env);
    // A file stored before the gap and one after; nothing on 1–4 Nov, as on production.
    await db.insert(t.skillScans).values({ fingerprint: `sha256:${"c".repeat(64)}`, verdict: "clear", findings: [], counts: {}, rulesVersion: "r", bytes: 1, firstSeen: ms("2026-10-31T05:00:00Z"), lastSeen: ms("2026-10-31T05:00:00Z") });
    await db.insert(t.skillScans).values({ fingerprint: `sha256:${"d".repeat(64)}`, verdict: "clear", findings: [], counts: {}, rulesVersion: "r", bytes: 1, firstSeen: ms("2026-11-05T05:00:00Z"), lastSeen: ms("2026-11-05T05:00:00Z") });
    expect(CENSUS_GAPS[0]).toMatchObject({ from: "2026-11-01", to: "2026-11-04", metrics: ["skill_files.new", "skill_files.scanned_total"] });
    const series = await buildSeries(env, "2026-11-06");
    const gap = series.filter((r) => r.metric === "skill_files.new" && r.date_utc >= "2026-11-01" && r.date_utc <= "2026-11-04");
    expect(gap.map((r) => r.date_utc)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    for (const m of ["skill_files.new", "skill_files.scanned_total"])
      for (const d of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]) {
        const row = series.find((r) => r.metric === m && r.date_utc === d)!;
        expect(row.value, `${m} ${d}`).toBeNull();
        expect(row.method).toMatch(/^not measured: Lean mode stopped storing skill scans/);
      }
    expect(series.find((r) => r.metric === "skill_files.new" && r.date_utc === "2026-11-05")?.value).toBe(1);
    // A series built before the gap has no gap rows.
    expect((await buildSeries(env, "2026-10-31")).some((r) => r.value === null)).toBe(false);
    const { files } = await buildCensusFiles(env, "2026-11-06");
    const csvGap = files["series.csv"]!.split("\n").filter((l) => l.startsWith("skill_files.new,2026-11-0") && l.split(",")[1]! <= "2026-11-04");
    expect(csvGap).toHaveLength(4);
    for (const l of csvGap) expect(l).toMatch(/^skill_files\.new,2026-11-0[1-4],,files,"?not measured: /);
    expect(files["series.csv"]).not.toMatch(/^skill_files\.(new|scanned_total),2026-11-0[1-4],0,/m);
    const json = JSON.parse(files["series.json"]!) as { rows: { metric: string; date_utc: string; value: number | null }[] };
    expect(json.rows.filter((r) => r.date_utc >= "2026-11-01" && r.date_utc <= "2026-11-04" && r.metric.startsWith("skill_files.")).every((r) => r.value === null)).toBe(true);
    const schema = JSON.parse(files["schema.json"]!) as ReturnType<typeof censusSchema>;
    expect(schema.gaps).toEqual([{ from: "2026-11-01", to: "2026-11-04", metrics: ["skill_files.new", "skill_files.scanned_total"], status: "not measured", note: CENSUS_GAPS[0].note }]);
    expect(firstDates(series)["skill_files.new"]! < "2026-11-01").toBe(true);
  });

  it("server history carries the description set seen that night, and the roster is per night", async () => {
    await addTool("npm:census-desc-mcp");
    await storeRun(env, { probedAt: "2024-07-01T03:00:00.000Z", entries: [entry("census-desc-mcp", "worked")] });
    await storeToolLists(env, list("npm:census-desc-mcp", "Lists files."), ms("2024-07-01T03:10:00Z"));
    await storeRun(env, { probedAt: "2024-06-30T03:00:00.000Z", entries: [entry("census-desc-mcp", "worked")] });
    const { files } = await buildCensusFiles(env, "2024-07-01");
    // One server-history file per UTC month (review of ADR 0129: one growing file would pass KV's 25 MiB cap).
    expect(Object.keys(files).filter((p) => p.startsWith("server-history/")).sort()).toEqual(["server-history/2024-06.csv", "server-history/2024-07.csv"]);
    const lines = [...files["server-history/2024-06.csv"]!.split("\n"), ...files["server-history/2024-07.csv"]!.split("\n")].filter((l) => l.includes("census-desc-mcp"));
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.includes("2024-06-30"))!.endsWith(",")).toBe(true); // before descriptions were captured
    expect(lines.find((l) => l.includes("2024-07-01"))).toMatch(/,[0-9a-f]{64}$/);
    expect(files["server-history/2024-07.csv"]!.split("\n")[0]).toBe("family,server,version,night_utc,outcome,failure_class,tool_count,description_sha256");
    expect(files["roster/2024-07-01.csv"]!.split("\n")[0]).toBe("rank,server,version,weekly_downloads,outcome");
    expect(files["series.csv"]!.split("\n")[0]).toBe("metric,date_utc,value,unit,method,kind");
  });
});

describe("Census files at /dataset/census", () => {
  it("publishes a version once, serves files whose sha256 matches the manifest, and states the method", async () => {
    await storeRun(env, { probedAt: "2026-11-04T03:00:00.000Z", entries: [entry("pub-mcp", "worked"), entry("pub2-mcp", "no_answer", { rank: 2 })] });
    const now = ms("2026-11-05T02:17:00Z");
    const first = await publishCensus(env, now);
    expect(first).toMatchObject({ version: "2026-11-04", published: true });
    expect(await publishCensus(env, now + 3_600_000)).toMatchObject({ published: false });

    const m = (await (await fetchWorker("/dataset/census/manifest.json")).json()) as { version: string; files: { path: string; sha256: string; bytes: number }[]; versions: { version: string }[]; statement: string };
    expect(m.version).toBe("2026-11-04");
    expect(m.statement).toBe(CENSUS_STATEMENT);
    expect(m.versions.map((v) => v.version)).toContain("2026-11-04");
    for (const p of ["series.csv", "series.json", "server-history/2026-11.csv", "schema.json", "roster/2026-11-04.csv"]) expect(m.files.map((f) => f.path)).toContain(p);
    for (const f of m.files) {
      const res = await fetchWorker(`/dataset/census/${f.path}`);
      expect(res.status, f.path).toBe(200);
      const text = await res.text();
      expect(await sha256Hex(text), f.path).toBe(f.sha256);
      expect(new TextEncoder().encode(text).length).toBe(f.bytes);
      // Wording and exposure rules: no verdict words, no embargoed model, no house-vs-outside split.
      expect(text).not.toMatch(/malicious/i);
      expect(text).not.toMatch(SHOWS_EMBARGOED);
      expect(text).not.toMatch(/external_value|house_value|outside_only/);
    }
    const schema = (await (await fetchWorker("/dataset/census/schema.json")).json()) as { day_boundary: string; metrics: { metric: string; first_measured: string | null; status?: string }[]; failure_classes: { version: string; closed: boolean } };
    expect(schema.day_boundary).toMatch(/UTC day its check completed/);
    expect(schema.failure_classes).toMatchObject({ version: "failure-classes/v1", closed: true });
    expect(schema.metrics.find((x) => x.metric === "top500_nightly.servers_attempted")!.first_measured).not.toBeNull();
    expect(schema.metrics.every((x) => x.first_measured !== null || x.status === "not yet measured")).toBe(true);
    expect((await fetchWorker("/dataset/census/roster/1999-01-01.csv")).status).toBe(404);

    const page = await fetchWorker("/dataset/census", { headers: { Accept: "text/html" } });
    const body = await page.text();
    expect(body).toContain(CENSUS_STATEMENT);
    expect(body).toContain('href="/dataset/census/series.csv"');
    expect(body).toMatch(/noindex/);
  });
});

describe("Census files stay bounded as the record grows (review of ADR 0129)", () => {
  type Manifest = { version: string; files: { path: string; sha256: string }[]; versions: { version: string; manifest: string; files?: unknown }[] };
  // A fresh address each read: the edge cache keeps a served file for 5 minutes.
  let reads = 0;
  const fresh = (path: string) => `${path}?read=${++reads}`;
  const getManifest = async () => (await (await fetchWorker(fresh("/dataset/census/manifest.json"))).json()) as Manifest;

  it("marks only rosters and earlier months as frozen", () => {
    expect(frozenPath("roster/2026-11-04.csv", "2026-11-04")).toBe(true);
    expect(frozenPath("server-history/2026-10.csv", "2026-11-04")).toBe(true);
    expect(frozenPath("server-history/2026-11.csv", "2026-11-04")).toBe(false);
    expect(frozenPath("series.csv", "2026-11-04")).toBe(false);
    expect(frozenPath("schema.json", "2026-11-04")).toBe(false);
  });

  it("reuses an unchanged earlier month without reading it again, rebuilds it when its rows change, and links each version's manifest", async () => {
    await storeRun(env, { probedAt: "2023-03-30T03:00:00.000Z", entries: [entry("grow-a-mcp", "worked"), entry("grow-b-mcp", "failed", { rank: 2 })] });
    await storeRun(env, { probedAt: "2023-04-01T03:00:00.000Z", entries: [entry("grow-a-mcp", "worked")] });
    const v1 = await publishCensus(env, ms("2023-04-02T00:17:00Z"));
    expect(v1).toMatchObject({ version: "2023-04-01", published: true, reused: 0 });
    const m1 = await getManifest();
    const march = m1.files.find((f) => f.path === "server-history/2023-03.csv")!;
    expect(march).toBeDefined();

    // The next day: March and its rosters are frozen and unchanged, so they are reused, not rebuilt.
    await storeRun(env, { probedAt: "2023-04-02T03:00:00.000Z", entries: [entry("grow-a-mcp", "no_answer")] });
    const v2 = await publishCensus(env, ms("2023-04-03T00:17:00Z"));
    expect(v2).toMatchObject({ version: "2023-04-02", published: true });
    expect((v2 as { reused: number }).reused).toBeGreaterThanOrEqual(2); // server-history/2023-03.csv and roster/2023-03-30.csv
    const m2 = await getManifest();
    expect(m2.files.find((f) => f.path === "server-history/2023-03.csv")!.sha256).toBe(march.sha256);
    for (const f of m2.files) {
      const res = await fetchWorker(fresh(`/dataset/census/${f.path}`));
      expect(res.status, f.path).toBe(200);
      expect(await sha256Hex(await res.text()), f.path).toBe(f.sha256);
    }
    // No internal fingerprint is served, and manifest.json links each version's own list instead of carrying it.
    expect(JSON.stringify(m2)).not.toMatch(/"fp"/);
    const vs = m2.versions.map((v) => v.version);
    expect(vs.indexOf("2023-04-02")).toBeGreaterThanOrEqual(0);
    expect(vs.indexOf("2023-04-02")).toBeLessThan(vs.indexOf("2023-04-01")); // newest first
    expect(m2.versions.every((v) => v.files === undefined && v.manifest.endsWith(`/dataset/census/manifest/${v.version}.json`))).toBe(true);
    const old = (await (await fetchWorker(fresh("/dataset/census/manifest/2023-04-01.json"))).json()) as Manifest;
    expect(old.files.map((f) => f.path)).toEqual(m1.files.map((f) => f.path));
    expect(old.version).toBe("2023-04-01");
    expect((await fetchWorker("/dataset/census/manifest/1999-01-01.json")).status).toBe(404);

    // A re-run of a March night changes what March is built from: the next version rebuilds it.
    await storeRun(env, { probedAt: "2023-03-30T05:00:00.000Z", entries: [entry("grow-a-mcp", "failed")] });
    const v3 = await publishCensus(env, ms("2023-04-04T00:17:00Z"));
    expect(v3).toMatchObject({ published: true, reused: 2 }); // only April's two rosters; March is rebuilt
    const m3 = await getManifest();
    const march3 = m3.files.find((f) => f.path === "server-history/2023-03.csv")!;
    expect(march3.sha256).not.toBe(march.sha256);
    expect(await (await fetchWorker(fresh("/dataset/census/server-history/2023-03.csv"))).text()).toContain("npm:grow-a-mcp,1.0.0,2023-03-30,failed");
  });
});
