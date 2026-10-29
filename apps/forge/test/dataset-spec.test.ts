import { env } from "cloudflare:workers";
import { anyTaskById, Attempt, CANARY, heldOutSeeds, RULES_VERSION, TASKS, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import llms from "../public/llms.txt?raw";
import { benchmarkData, STAKE_SEEDS } from "../src/arena/benchmark";
import { versionsData } from "../src/arena/benchmark-versions";
import { COMMERCIAL_LICENCE_LINE as SAMPLE_LINE } from "../src/arena/sample";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { latestRun, storeRun } from "../src/services/house-report";
import { osvRecords } from "../src/services/osv-feed";
import { COMMERCIAL_LICENCE, COMMERCIAL_LICENCE_LINE, DATASET_LICENCE } from "../src/services/provenance";
import { PUBLIC_ROW_MINIMUMS } from "../src/services/counters";
import { signReport } from "../src/services/signing";
import { SITEMAP_STATIC } from "../src/web/answers";
import { croissant } from "../src/web/croissant";
import { BUYER_RECEIVES, DATASET_SPEC_PATH, datasetSpecData, HELD_BACK, type DatasetSpec } from "../src/web/dataset-spec";
import { statsData } from "../src/web/stats";
import { SNAPSHOTS } from "../src/seed/benchmark";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import "../src/index";

// B3-01 and B3-02 (ADR 0104): the /dataset buyer spec page and the commercial-licence line; plus the /founding wording.

const SEED = 1_000_021;
const PUBLIC_MODEL = "gpt-oss-120b";
/** The evaluation-only text approved on 26 Oct, word for word: B3-02 must not change it. */
const EVALUATION_ONLY =
  "Evaluation-only licence: free to use for evaluation, research and reporting, with attribution and a link to theagentforge.io/arena. Not for training or fine-tuning AI models. Model outputs in the run logs remain subject to their providers' terms.";

let n = 0;
const u = () => `${Date.now()}-${++n}`;
const page = async (path: string) => (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}u=${u()}`, { headers: { Accept: "text/html" } })).text();
const json = async <T>(path: string) => (await (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}u=${u()}`)).json()) as T;
const sv = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");

async function seedRun(eventId: string, model: string, task: string, seed: number, fell: boolean, heldOut = false) {
  const a = new Attempt(anyTaskById(task)!, seed);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const trap = base.traps[0]!.id;
  const result = { ...base, rules: RULES_VERSION, task, passed: !fell, traps: base.traps.map((x) => ({ ...x, triggered: fell && x.id === trap })) } as AttemptResult;
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task, seed, attemptNo: 1, status: "done", passed: result.passed, score: 0.5, cost: 0.01, tokens: 1000, heldOut,
    result, log: a.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(a.log) }), finishedAt: Date.now() - 60_000,
  });
}
async function addGauntlets(k: number) {
  for (let i = 0; i < k; i++) await getDb(env).insert(t.arenaGauntlets).values({ id: crypto.randomUUID(), status: "done", current: 6, mode: "full", startedAt: Date.now() - 60_000, finishedAt: Date.now() });
}
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
  return out;
};
const heldSeeds = () => [...new Set(TASKS.flatMap((x) => heldOutSeeds(x.id)))];

beforeAll(async () => {
  const ranked = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values([{ id: ranked, slug: "crucible-dataset-spec-test", name: "Crucible dataset spec test", season: "s0", kind: "card", status: "done" }]);
  await seedRun(ranked, PUBLIC_MODEL, "scam-invoice", SEED, true);
  await seedRun(ranked, PUBLIC_MODEL, "refund", SEED, false);
  await seedRun(ranked, EMBARGOED.id, "scam-invoice", SEED, true);
  const held = heldOutSeeds("refund")[0];
  if (held !== undefined) await seedRun(ranked, PUBLIC_MODEL, "refund", held, true, true);
  await storeRun(env, {
    probedAt: "2026-10-28T03:00:00.000Z",
    entries: [
      { pkg: "@example/server-a", version: "1.0.0", outcome: "worked", slow: false, tools: 3, ms: 900, downloads: 100, rank: 1 },
      { pkg: "@example/server-b", version: "2.1.0", outcome: "failed", slow: false, tools: null, ms: 2000, downloads: 50, rank: 2 },
      { pkg: "@example/server-c", version: "0.3.0", outcome: "error", slow: false, tools: null, ms: null, downloads: 10, rank: 3 },
    ],
  });
});

describe("B3-01: /dataset, the buyer dataset spec", () => {
  it("renders every section in order, with HTML and JSON", async () => {
    const res = await fetchWorker(`${DATASET_SPEC_PATH}?u=${u()}`, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const h = await res.text();
    const ids = ["what", "contents", "provenance", "formats", "licence", "receives", "held-back", "contact"];
    const at = ids.map((id) => h.indexOf(`<h2 id="${id}"`));
    for (const [i, p] of at.entries()) expect(p, ids[i]).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(h).toContain(CANARY);
    expect((await fetchWorker(`/dataset.json?u=${u()}`)).status).toBe(200);
    const j = await json<DatasetSpec>("/dataset.json");
    expect(j.contents.trap_set.traps).toBeGreaterThan(0);
    expect(j.buyer_receives).toMatchObject({ private: true, shared_under: "nda" });
    expect(j.buyer_receives.items).toEqual(BUYER_RECEIVES.map((x) => x.item));
    for (const x of BUYER_RECEIVES) expect(text(h)).toContain(x.what);
    for (const x of HELD_BACK) expect(text(h)).toContain(x.why);
    expect(text(h)).toContain("Private, shared under NDA");
  });

  it("every number equals its source function's value (/benchmark, /stats, House Report, OSV feed)", async () => {
    const [d, bench, stats, run, osv] = await Promise.all([datasetSpecData(env), benchmarkData(getDb(env), env.PUBLIC_ORIGIN), statsData(env), latestRun(env), osvRecords(env, env.PUBLIC_ORIGIN)]);
    const w = stats.blended.work!;
    expect(d.contents.trap_set).toMatchObject({ traps: bench.counts.traps, trap_kinds: bench.counts.families, jobs: bench.counts.jobs, job_versions: bench.counts.tasks, version: bench.version });
    expect(d.contents.trap_set.traps_per_kind.reduce((s, k) => s + k.traps, 0)).toBe(bench.counts.traps);
    expect(d.contents.bouts).toMatchObject({ refereed_practice_included: w.bouts_refereed, of_them_ranked: w.ranked_bouts, traps_sprung: w.traps_sprung, ranked_public_attempts_in_results: bench.counts.ranked_attempts });
    expect(d.contents.models.count).toBe(bench.counts.models);
    expect(d.contents.models.list.map((m) => m.model).sort()).toEqual([...new Set(bench.results.models.map((m) => m.model))].sort());
    expect(d.contents.models.list.reduce((s, m) => s + m.ranked_attempts, 0)).toBe(bench.counts.ranked_attempts);
    expect(d.contents.seeds.public_dev_split_seeds).toBe(STAKE_SEEDS.length);
    expect(d.contents.seeds.held_out_seeds).toBe("kept_back");
    expect(d.contents.field_reports.total).toBe(w.field_reports);
    expect(d.contents.field_reports.house_share_published).toBe(false);
    expect(d.contents.skill_scans.distinct_skill_files_scanned).toBe(w.skills_scanned);
    expect(d.contents.tools_with_a_page).toBe(w.tools_tracked);
    expect(d.contents.install_tests).toMatchObject({ servers_in_latest_nightly_run: run!.entries.length - run!.counts.error, latest_run: "2026-10-28", nightly_runs_since: "2026-10-28" });
    expect(d.contents.install_tests.servers_in_latest_nightly_run).toBe(2);
    expect(d.contents.osv_feed.records).toBe(osv.length);
    expect(d.formats.frozen_versions.versions.map((v) => v.sha256)).toEqual(versionsData(env.PUBLIC_ORIGIN).versions.map((v) => v.snapshot?.sha256 ?? null));
    // The page prints the same values.
    const h = await page(DATASET_SPEC_PATH);
    const cell = (k: string) => new RegExp(`data-k="${k}"[^]*?data-v="([^"]*)"`).exec(h)?.[1];
    expect(cell("traps")).toBe(sv(bench.counts.traps));
    expect(cell("bouts_refereed")).toBe(sv(w.bouts_refereed));
    expect(cell("ranked_bouts")).toBe(sv(w.ranked_bouts));
    expect(cell("field_reports")).toBe(sv(w.field_reports));
    expect(cell("skills_scanned")).toBe(sv(w.skills_scanned));
    expect(cell("install_test_servers")).toBe("2");
    expect(cell("osv_records")).toBe(sv(osv.length));
    expect(cell("models")).toBe(sv(bench.counts.models));
    // House field reports are labelled as on /stats, with the method link.
    expect(h).toContain('href="/methodology#house-install-tests"');
    expect(text(h)).toContain("Field reports filed (most are our House agent's nightly install tests)");
  });

  it("a row /stats hides below its minimum is absent from /dataset too, and appears with /stats once it passes", async () => {
    const before = await count("SELECT count(*) AS n FROM arena_gauntlets WHERE status = 'done' AND mode = 'full'");
    expect(before).toBeLessThan(PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished);
    expect("gauntlet_runs_finished" in (await statsData(env)).blended).toBe(false);
    expect(await page(DATASET_SPEC_PATH)).not.toContain('data-k="gauntlet_runs_finished"');
    expect(await json<DatasetSpec>("/dataset.json")).not.toHaveProperty("contents.bouts.gauntlet_runs_finished");
    await addGauntlets(PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished - before);
    const v = (await statsData(env)).blended.gauntlet_runs_finished;
    expect(v).toBe(PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished);
    expect((await datasetSpecData(env)).contents.bouts).toMatchObject({ gauntlet_runs_finished: v });
    expect(await page(DATASET_SPEC_PATH)).toContain(`data-k="gauntlet_runs_finished"`);
  });

  it("no outside-only number, signed-in people or agents, embargoed model, private trap id or held-out seed", async () => {
    const h = await page(DATASET_SPEC_PATH);
    const raw = JSON.stringify(await json("/dataset.json"));
    const keys = keysOf(JSON.parse(raw));
    for (const k of ["external", "external_exact", "outside", "outside_only", "house", "weekly_reporting_agents", "verified_humans", "active_owners_30d", "agent_funnel", "signed_in_people", "signed_in_agents", "install_checked_all"]) expect(keys.has(k), k).toBe(false);
    for (const s of [h, raw]) {
      expect(s).not.toMatch(SHOWS_EMBARGOED);
      expect(s).not.toMatch(/FA-[A-Z]+-1\d\d/);
      expect(s).not.toMatch(/signed in|outside the project/i);
      for (const seed of heldSeeds()) expect(s.includes(String(seed)), `held-out seed ${seed}`).toBe(false);
    }
  });

  it("every link on the page resolves", async () => {
    const h = await page(DATASET_SPEC_PATH);
    const links = [...new Set([...h.matchAll(/href="(\/[^"#]*)(?:#[^"]*)?"/g)].map((m) => m[1]!.replace(/&amp;/g, "&")))].filter((p) => p && !p.startsWith("//"));
    const main = h.slice(h.indexOf('<h1 class="page-title">Dataset spec'), h.indexOf("</main>") > 0 ? h.indexOf("</main>") : undefined);
    const own = links.filter((l) => main.includes(`href="${l}`));
    expect(own.length).toBeGreaterThan(20);
    for (const l of own) {
      const r = await fetchWorker(l);
      expect(r.status, l).toBeLessThan(400);
      await r.arrayBuffer();
    }
  });

  it("is linked from the footer, /about#investors, /benchmark, /security, llms.txt and the sitemap", async () => {
    for (const p of ["/about", "/benchmark", "/security", "/stats"]) expect(await page(p), p).toContain('href="/dataset"');
    expect((await page("/stats")).match(/<footer[^]*<\/footer>/)?.[0]).toContain('<a href="/dataset">Dataset spec</a>');
    const about = await page("/about");
    expect(about.slice(about.indexOf('id="investors"'))).toContain('href="/dataset"');
    expect(llms).toContain("[Dataset spec](/dataset)");
    expect(SITEMAP_STATIC).toContain("/dataset");
  });
});

describe("B3-02: the commercial-licence line", () => {
  it("is word for word on /benchmark/licence, its JSON, Croissant, the sample and /dataset; evaluation-only text untouched", async () => {
    expect(COMMERCIAL_LICENCE_LINE).toBe("Commercial and derivative licences (for example training, redistribution, or internal use at scale) are available by written agreement. Ask partners@theagentforge.io.");
    expect(SAMPLE_LINE).toBe(COMMERCIAL_LICENCE_LINE);
    expect(DATASET_LICENCE).toBe(EVALUATION_ONLY);
    const h = await page("/benchmark/licence");
    expect(text(h)).toContain(COMMERCIAL_LICENCE_LINE);
    expect(text(h)).toContain(EVALUATION_ONLY);
    expect(h).toContain('href="mailto:partners@theagentforge.io"');
    const j = await json<{ text: string; training_allowed: boolean; commercial_licence: typeof COMMERCIAL_LICENCE }>("/benchmark/licence?format=json");
    expect(j.text).toBe(EVALUATION_ONLY);
    expect(j.training_allowed).toBe(false);
    expect(j.commercial_licence).toEqual({ available: true, by: "written_agreement", examples: ["training", "redistribution", "internal_use_at_scale"], contact: "partners@theagentforge.io", prices_published: false, text: COMMERCIAL_LICENCE_LINE });
    // Text and JSON agree.
    expect(text(h)).toContain(j.commercial_licence.text);
    const cr = croissant(env.PUBLIC_ORIGIN) as Record<string, unknown>;
    expect(cr.licenceText).toBe(EVALUATION_ONLY);
    expect(cr.commercialLicence).toEqual(j.commercial_licence);
    const served = await json<Record<string, unknown>>("/arena/croissant.json");
    expect(served.commercialLicence).toEqual(j.commercial_licence);
    const d = await page(DATASET_SPEC_PATH);
    expect(text(d)).toContain(COMMERCIAL_LICENCE_LINE);
    expect(text(d)).toContain(EVALUATION_ONLY);
    expect((await json<DatasetSpec>("/dataset.json")).licence.commercial_licence).toEqual(j.commercial_licence);
    // No prices.
    for (const s of [text(h), JSON.stringify(j)]) expect(s).not.toMatch(/(US)?\$\s?\d|USD\s?\d/);
  });

  it("stays out of every frozen Trap Set snapshot (ADR 0101: no version bump)", () => {
    for (const s of SNAPSHOTS) {
      expect(s.text).not.toContain("Commercial and derivative licences");
      expect(s.text).not.toContain("commercial_licence");
    }
  });
});

describe("/founding: no threshold in the wording", () => {
  it("says 'opening soon' and its JSON has no list_opens_at", async () => {
    const h = await page("/founding");
    expect(h).not.toMatch(/opens at \d+/);
    expect(h).toContain("The list is opening soon.");
    const j = await json<Record<string, unknown>>("/founding?format=json");
    expect(j).not.toHaveProperty("list_opens_at");
    expect(j.list_status).toBe("opening_soon");
    expect(j.list_open).toBe(false);
  });
});

async function count(q: string) {
  return Number((await env.DB.prepare(q).first<{ n: number }>())!.n);
}
