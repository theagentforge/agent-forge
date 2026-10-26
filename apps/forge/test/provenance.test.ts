import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { summarise } from "../src/arena/gauntlet";
import { EVENT_CSV_HEADER } from "../src/arena/results";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { DATASET_LICENCE, LICENCE_ID, PRIVACY_HISTORY, provenance, runProvenance, TERMS_HISTORY, versionAt, WORKERS_AI_PROVIDER } from "../src/services/provenance";
import { signReport } from "../src/services/signing";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { LEGAL_DATE, LEGAL_VERSION, NEXT_LEGAL, PRIVACY_DATE, PRIVACY_VERSION } from "../src/web/legal";
import { NOTICE_DAYS, RESULTS_POLICY_CHANGES, RESULTS_POLICY_VERSION } from "../src/web/results-policy";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// ADR 0053 (D10, D14): every published Arena record carries provenance and the evaluation-only licence; the Croissant
// file describes the dataset; the results policy page is public and linked.

const ORIGIN = env.PUBLIC_ORIGIN;
const SLUG = "provenance-test-card";
const SONNET = "claude-sonnet-5.5";
const QWEN = "qwen3-30b";
const ids: Record<string, string> = {};
const FINISHED = Date.UTC(2026, 9, 20, 12);

async function addRun(key: string, eventId: string, model: string, provider: string | null) {
  const a = new Attempt(taskById("refund")!, 1_000_123);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const result = a.end("finished") as AttemptResult;
  const id = crypto.randomUUID();
  ids[key] = id;
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task: "refund", seed: 1_000_123, attemptNo: 1, status: "done", passed: result.passed, score: 0.5, cost: 0.1, tokens: 1000, provider,
    result, log: a.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(a.log) }), finishedAt: FINISHED,
  });
}

beforeAll(async () => {
  const eventId = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id: eventId, slug: SLUG, name: "Provenance test", season: "s0", kind: "card", status: "done" });
  await addRun("sonnet", eventId, SONNET, "Anthropic");
  await addRun("qwen", eventId, QWEN, null);
});

describe("provenance helper", () => {
  it("dates the Terms and Privacy versions as web/legal.ts does", () => {
    expect(TERMS_HISTORY[0]).toMatchObject({ version: LEGAL_VERSION, from: Date.parse(`${LEGAL_DATE} UTC`) });
    expect(TERMS_HISTORY.at(-1)).toMatchObject({ version: NEXT_LEGAL.terms, from: NEXT_LEGAL.from });
    expect(PRIVACY_HISTORY.find((h) => h.version === PRIVACY_VERSION)!.from).toBe(Date.parse(`${PRIVACY_DATE} UTC`));
    expect(PRIVACY_HISTORY.at(-1)).toMatchObject({ version: NEXT_LEGAL.privacy, from: NEXT_LEGAL.from });
    expect(versionAt(TERMS_HISTORY, Date.UTC(2026, 9, 14))).toBeNull();
    expect(versionAt(TERMS_HISTORY, Date.UTC(2026, 9, 20))).toBe("1.0");
    expect(versionAt(TERMS_HISTORY, Date.UTC(2026, 10, 7))).toBe("1.1");
    expect(versionAt(PRIVACY_HISTORY, Date.UTC(2026, 9, 18))).toBe("1.0");
    expect(versionAt(PRIVACY_HISTORY, Date.UTC(2026, 9, 19))).toBe("1.1");
  });

  it("tags a house bout with the exact model, maker and serving provider; other sources carry no model", () => {
    expect(runProvenance({ model: SONNET, provider: "Anthropic", finishedAt: FINISHED })).toEqual({
      source: "house_bout",
      model: { id: SONNET, exact: "anthropic/claude-sonnet-5.5", maker: "Anthropic", gateway: "openrouter", served_by: "Anthropic" },
      run_date: "2026-10-20", terms_version: "1.0", privacy_version: "1.1", licence: LICENCE_ID,
    });
    // No provider recorded: the lineup's pinned one (Workers AI for practice models).
    expect(runProvenance({ model: QWEN, provider: null, finishedAt: FINISHED }).model).toEqual({ id: QWEN, exact: "@cf/qwen/qwen3-30b-a3b-fp8", maker: "Alibaba (open weights)", gateway: "workers-ai", served_by: WORKERS_AI_PROVIDER });
    expect(WORKERS_AI_PROVIDER).toBe("cloudflare-workers-ai"); // what arena/adapters.ts records on a Workers AI run
    expect(runProvenance({ model: "not-a-model", provider: null, finishedAt: FINISHED }).model).toEqual({ id: "not-a-model", exact: null, maker: null, gateway: null, served_by: null });
    for (const s of ["gauntlet", "field_report", "scan"] as const) expect(provenance(s, FINISHED)).toMatchObject({ source: s, model: null, licence: LICENCE_ID, terms_version: "1.0" });
  });

  it("the licence is evaluation only, keeps no resale wording and reads as data", () => {
    expect(DATASET_LICENCE).toMatch(/evaluation, research and reporting/);
    expect(DATASET_LICENCE).toMatch(/Not for training or fine-tuning AI models/);
    expect(DATASET_LICENCE).toMatch(/providers' terms/);
    expect(DATASET_LICENCE).not.toMatch(/resale|Bulk/i);
    expect(AGENT_DIRECTED.exec(DATASET_LICENCE)).toBeNull();
  });
});

describe("published Arena records carry provenance", () => {
  it("/arena/dataset.json: licence id and link at the top, provenance on every run", async () => {
    const d = (await (await fetchWorker("/arena/dataset.json")).json()) as { licence: string; licence_id: string; licence_url: string; terms_history: unknown[]; runs: { id: string; provenance: { source: string; model: { exact: string } | null } }[] };
    expect(d).toMatchObject({ licence: DATASET_LICENCE, licence_id: LICENCE_ID, licence_url: `${ORIGIN}/arena/methodology#licence` });
    expect(d.terms_history).toEqual([{ version: "1.0", from: "2026-10-15T00:00:00.000Z" }, { version: "1.1", from: "2026-11-07T00:00:00.000Z" }]);
    expect(d.runs.length).toBeGreaterThan(0);
    for (const r of d.runs) expect(r.provenance.source).toBe("house_bout");
    expect(d.runs.find((r) => r.id === ids.sonnet)!.provenance).toMatchObject({ model: { exact: "anthropic/claude-sonnet-5.5", served_by: "Anthropic" }, run_date: "2026-10-20" });
  });

  it("event JSON and CSV: provenance per attempt", async () => {
    const d = (await (await fetchWorker(`/arena/events/${SLUG}.json`)).json()) as { licence_id: string; runs: { run: string; provenance: { model: { maker: string } } }[] };
    expect(d.licence_id).toBe(LICENCE_ID);
    expect(d.runs.find((r) => r.run === ids.qwen)!.provenance.model.maker).toBe("Alibaba (open weights)");
    const lines = (await (await fetchWorker(`/arena/events/${SLUG}.csv`)).text()).trim().split("\n");
    expect(lines[0]).toBe(EVENT_CSV_HEADER);
    const cols = EVENT_CSV_HEADER.split(",");
    const row = lines.find((l) => l.includes(ids.sonnet!))!.split(",");
    expect(row).toHaveLength(cols.length);
    const col = (k: string) => row[cols.indexOf(k)];
    expect([col("source"), col("model_exact"), col("model_maker"), col("served_by"), col("terms_version"), col("privacy_version"), col("licence")]).toEqual(["house_bout", "anthropic/claude-sonnet-5.5", "Anthropic", "Anthropic", "1.0", "1.1", LICENCE_ID]);
  });

  it("the run log JSON carries the licence and provenance", async () => {
    const r = (await (await fetchWorker(`/arena/run/${ids.sonnet}.json`)).json()) as { licence_id: string; provenance: { source: string; model: { id: string } } };
    expect(r.licence_id).toBe(LICENCE_ID);
    expect(r.provenance).toMatchObject({ source: "house_bout", model: { id: SONNET }, terms_version: "1.0" });
  });

  it("a finished Gauntlet report and a public scan record carry provenance with no model", async () => {
    const id = `g${crypto.randomUUID().replace(/-/g, "")}`;
    await getDb(env).insert(t.arenaGauntlets).values({ id, status: "done", current: 6, summary: summarise([]), startedAt: FINISHED - 60_000, finishedAt: FINISHED });
    const g = (await (await fetchWorker(`/api/v1/gauntlet/${id}`)).json()) as { report: { provenance: unknown } };
    expect(g.report.provenance).toEqual({ source: "gauntlet", model: null, run_date: "2026-10-20", terms_version: "1.0", privacy_version: "1.1", licence: LICENCE_ID });
    const fp = `sha256:${"ab".repeat(32)}`;
    await getDb(env).insert(t.skillScans).values({ fingerprint: fp, verdict: "clear", findings: [], counts: {}, rulesVersion: "test", bytes: 10, public: true, firstSeen: FINISHED, lastSeen: FINISHED });
    const s = (await (await fetchWorker(`/api/v1/scan/${fp}`)).json()) as { provenance: unknown };
    expect(s.provenance).toMatchObject({ source: "scan", model: null, run_date: "2026-10-20", licence: LICENCE_ID });
  });
});

describe("/arena/croissant.json (Croissant 1.0 + RAI)", () => {
  it("describes dataset.json, and every field's JSONPath resolves on a real row", async () => {
    const res = await fetchWorker("/arena/croissant.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    const c = (await res.json()) as Record<string, unknown> & { distribution: { contentUrl: string }[]; recordSet: { field: { name: string; source: { fileObject: { "@id": string }; extract: { jsonPath: string } } }[] }[] };
    expect(c["@type"]).toBe("sc:Dataset");
    expect(c.conformsTo).toEqual(["http://mlcommons.org/croissant/1.0", "http://mlcommons.org/croissant/RAI/1.0"]);
    expect(c.license).toBe(`${ORIGIN}/arena/methodology#licence`);
    expect(c.isLiveDataset).toBe(true);
    for (const k of ["rai:dataCollection", "rai:dataUseCases", "rai:dataLimitations", "rai:dataBiases", "rai:personalSensitiveInformation", "rai:dataReleaseMaintenancePlan"]) expect(String(c[k]).length, k).toBeGreaterThan(20);
    expect(c.distribution[0]!.contentUrl).toBe(`${ORIGIN}/arena/dataset.json`);
    // The standard Croissant 1.0 @context (mlcroissant 1.1.1, rdf.make_context for a 1.0 file): the validator warns if
    // any key is missing, and recommends datePublished.
    const STANDARD = ["@language", "@vocab", "citeAs", "column", "conformsTo", "cr", "rai", "data", "dataType", "dct", "equivalentProperty", "examples", "extract", "field", "fileProperty", "fileObject", "fileSet", "format", "includes", "isLiveDataset", "jsonPath", "key", "md5", "parentField", "path", "recordSet", "references", "regex", "repeated", "replace", "samplingRate", "sc", "separator", "source", "subField", "transform"];
    expect(Object.keys(c["@context"] as object).sort()).toEqual([...STANDARD].sort());
    expect(c.datePublished).toBe("2026-10-15");
    expect(c.distribution[0]).not.toHaveProperty("sha256");
    expect(c.distribution[0]).not.toHaveProperty("md5");
    // Every field points at a key that exists on a dataset row.
    const row = ((await (await fetchWorker("/arena/dataset.json")).json()) as { runs: Record<string, unknown>[] }).runs.find((r) => r.id === ids.sonnet)!;
    for (const f of c.recordSet[0]!.field) {
      expect(f.source.fileObject["@id"]).toBe("dataset-json");
      // One value per run: no path may fan out inside a row (mlcroissant needs every column the same length).
      expect(f.source.extract.jsonPath, f.name).toMatch(/^\$\.runs\[\*\]\.[A-Za-z_.]+$/);
      const path = f.source.extract.jsonPath.replace(/^\$\.runs\[\*\]\./, "").split(".");
      let v: unknown = row;
      for (const p of path) v = (v as Record<string, unknown>)?.[p];
      expect(v, f.name).not.toBeUndefined();
    }
  });
});

describe("/results-policy (D14)", () => {
  it("states equal notice, version pinning, intervals, replays, independence and corrections", async () => {
    const res = await fetchWorker("/results-policy", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<b>${NOTICE_DAYS} days</b>`);
    for (const id of ["scope", "notice", "versions", "numbers", "independence", "corrections"]) expect(body).toContain(`<h2 id="${id}">`);
    expect(body).toContain("No lab gets it earlier than the others");
    expect(body).toContain("No lab pays for placement");
    expect(body).toContain('href="mailto:hello@theagentforge.io"');
    expect(body).not.toMatch(SHOWS_EMBARGOED);
    // Scope matches what the site does: practice runs publish as they finish, so "first results" means first ranked
    // results; repeats of published numbers aren't new headline results; the pack can't link to replays still hidden.
    expect(body).toContain("the first ranked results for any model");
    expect(body).not.toContain("the first published results for any model");
    expect(body).not.toContain("links to the replays");
    expect(body).toContain(`Version ${RESULTS_POLICY_VERSION}`);
    expect(body).toContain('<h2 id="changes">');
    expect(RESULTS_POLICY_CHANGES.at(-1)!.version).toBe(RESULTS_POLICY_VERSION);
  });

  it("has a structured JSON twin", async () => {
    const d = (await (await fetchWorker("/results-policy?format=json")).json()) as { pre_release_notice: { days: number; same_content: boolean; early_access_for_any_lab: boolean }; independence: { paid_placement: boolean } };
    expect(d.pre_release_notice).toMatchObject({ days: 7, same_content: true, early_access_for_any_lab: false });
    expect(d.independence.paid_placement).toBe(false);
    expect((d as unknown as { applies_to: string[] }).applies_to).toContain("first_ranked_results_for_a_model");
    expect((d as unknown as { corrections: Record<string, unknown> }).corrections).toMatchObject({ aim_to_reply_within_days: 7 });
    expect(JSON.stringify(d)).not.toMatch(AGENT_DIRECTED);
  });

  it("is linked from /methodology, the footer, the Arena methodology and llms.txt; the licence section is on the methodology", async () => {
    const m = await (await fetchWorker("/methodology", { headers: { Accept: "text/html" } })).text();
    expect(m.match(/href="\/results-policy"/g)!.length).toBeGreaterThanOrEqual(2); // body and footer
    const am = await (await fetchWorker("/arena/methodology", { headers: { Accept: "text/html" } })).text();
    expect(am).toContain('<h2 id="licence">Data licence and provenance</h2>');
    expect(am).toContain('href="/arena/croissant.json"');
    expect(am).not.toMatch(/Bulk resale/);
    const amj = (await (await fetchWorker("/arena/methodology?format=json")).json()) as { licence: { id: string } };
    expect(amj.licence.id).toBe(LICENCE_ID);
    const llms = await (await fetchWorker("/llms.txt")).text();
    const line = llms.split("\n").find((l) => l.includes("/results-policy"))!;
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(line).toContain("/arena/croissant.json");
  });
});
