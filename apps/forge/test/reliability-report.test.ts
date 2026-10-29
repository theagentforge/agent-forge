import { env } from "cloudflare:workers";
import { Attempt, RULES_VERSION, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { outward, wilson } from "../src/arena/holdout";
import { isEmbargoed } from "../src/arena/lineup";
import * as t from "../src/db/schema";
import { at, buildEdition, caseText, display, EDITION, freezeGates, methods, missingNumbers, plain, SOURCE_FILES, SOURCES, wilsonOutward, type Edition, type SourceKey } from "../src/reports/reliability-edition";
import { asciiText, pdfDisplay } from "../src/reports/reliability-pdf";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { currentEdition, FROZEN, liveSources, pdfFor } from "../src/web/reliability-report";
import held from "../src/seed/skill-scan-held.json";
import { fetchWorker } from "./helpers";
import "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// W5.1 / AQ-11 (ADR 0079): The State of Agent Reliability, Edition 1. Every number on the page links to a public JSON
// file and a pointer, and must equal the value there; the PDF carries the same numbers, the citation and the canary;
// ranked and practice stay apart; nothing embargoed, private or held appears.

let n = 0;
const get = (path: string, accept = "text/html") => fetchWorker(`${path}${path.includes("?") ? "&" : "?"}n=rel${++n}`, { headers: { Accept: accept } });
const json = async (path: string) => (await get(path, "application/json")).json() as Promise<unknown>;

function made(task: string, traps: string[], sprung: string[], stamped = true) {
  const a = new Attempt(taskById(task)!, 4_100_001);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "All invoices paid, job complete" });
  a.call("finish", { status: "done", summary: "All invoices paid, job complete" });
  const base = a.end("finished");
  const result = { ...base, passed: !sprung.length, traps: traps.map((id) => ({ id, label: id, triggered: sprung.includes(id) })), ...(stamped ? { rules: RULES_VERSION } : {}) };
  return { result: result as AttemptResult, log: a.log };
}

let clock = Date.now() - 3_600_000;
const runIds: Record<string, string> = {};
async function addRuns(eventId: string, model: string, task: string, traps: string[], plan: string[][], key?: string, stamped = true) {
  for (const sprung of plan) {
    const r = made(task, traps, sprung, stamped);
    const id = crypto.randomUUID();
    if (key) runIds[key] = id;
    clock += 1000;
    await getDb(env).insert(t.arenaRuns).values({
      id, eventId, modelId: model, task, seed: 4_100_001, attemptNo: 1, status: "done", passed: r.result.passed, score: 0.5, cost: 0.01, tokens: 1000,
      result: r.result, log: r.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) }), finishedAt: clock,
    });
  }
}

const REFUND = ["out_of_policy", "over_refund"];
const IMPOSSIBLE = ["partial", "false_claim"];
let page = "";
/** Ranked attempts the seed should count: the embargoed model's 5 only once its results are published. */
const RANKED = 20 + (isEmbargoed(EMBARGOED.id) ? 0 : 5);
/** The edition the site serves: the frozen one once frozen, else the live preview. */
let edition: Edition;
/** The edition built from this test's seed (always a live preview), for checks on what the builder does with the data. */
let live: Edition;
let liveSrc: Record<SourceKey, unknown>;

/** The files the served edition's numbers come from: the saved copies once frozen, else the live public files. */
async function servedSources(): Promise<Record<SourceKey, unknown>> {
  const out: Partial<Record<SourceKey, unknown>> = {};
  for (const key of Object.keys(SOURCES) as SourceKey[])
    out[key] = FROZEN.frozen ? await (await env.ASSETS.fetch(`https://assets.local${EDITION.sources_dir}/${SOURCE_FILES[key]}`)).json() : await json(SOURCES[key]);
  return out as Record<SourceKey, unknown>;
}

beforeAll(async () => {
  const ids = { card: crypto.randomUUID(), practice: crypto.randomUUID() };
  await getDb(env).insert(t.arenaEvents).values([
    { id: ids.card, slug: "rel-card", name: "Reliability ranked", season: "s0", kind: "card", status: "done" },
    { id: ids.practice, slug: "rel-practice", name: "Reliability practice", season: "s0", kind: "practice", status: "done" },
  ]);
  // Ranked: 8 refund attempts (3 falls) and 6 impossible asks (4 false "done" claims) by one model, 6 refunds by another.
  await addRuns(ids.card, "claude-sonnet-5.5", "refund", REFUND, [["out_of_policy"], [], ["over_refund"], [], [], ["out_of_policy"], [], []]);
  await addRuns(ids.card, "claude-sonnet-5.5", "impossible", IMPOSSIBLE, [["false_claim"], [], ["false_claim"], ["false_claim"], [], ["false_claim"]]);
  await addRuns(ids.card, "gpt-6.1-sol", "refund", REFUND, [[], [], ["out_of_policy"], [], [], []]);
  // Three ranked runs scored before results were stamped with their rules (so under older rules): counted apart.
  await addRuns(ids.card, "gpt-6.1-sol", "refund", REFUND, [["out_of_policy"], ["out_of_policy"], []], undefined, false);
  // An embargoed model's ranked runs, all falls: never in any rate while it is embargoed.
  await addRuns(ids.card, EMBARGOED.id, "refund", REFUND, [["out_of_policy"], ["out_of_policy"], ["out_of_policy"], ["out_of_policy"], ["out_of_policy"]]);
  // Practice: 10 falls that must never reach a rate, and the fake-invoice replay that is the illustrative case.
  await addRuns(ids.practice, "kimi-k2.6", "refund", REFUND, Array.from({ length: 10 }, () => ["out_of_policy"]));
  await addRuns(ids.practice, "kimi-k2.6", "scam-invoice", ["paid_scam"], [["paid_scam"]], "case");
  page = await (await get(EDITION.path)).text();
  edition = await currentEdition(env);
  liveSrc = await liveSources(env);
  live = buildEdition(liveSrc, { origin: env.PUBLIC_ORIGIN, mode: "live_preview", generatedAt: new Date().toISOString() });
});

/** Every number on the page: the attributes numHtml writes. */
function pageNums(html: string) {
  return [...html.matchAll(/<a class="src-num" href="[^"]*" title="[^"]*" data-num="([^"]+)" data-source="([^"]+)" data-pointer="([^"]*)"(?: data-op="([^"]+)")?(?: data-pointer2="([^"]+)")?><data value="([^"]*)">/g)].map((m) => ({
    id: m[1]!,
    source: m[2] as SourceKey,
    pointer: m[3]!.replace(/&#x2F;|&#47;/g, "/"),
    op: m[4],
    pointer2: m[5]?.replace(/&#x2F;|&#47;/g, "/"),
    value: m[6]!,
  }));
}

/** The derived values, recomputed here independently of the report's own code. */
function expected(doc: unknown, pointer: string, op?: string, pointer2?: string): unknown {
  const a = at(doc, pointer);
  if (!op) return a;
  if (op === "length") return (a as unknown[]).length;
  if (op === "count_shown") return (a as { shown: boolean }[]).filter((x) => x.shown).length;
  const x = a as number;
  const y = at(doc, pointer2!) as number;
  if (op === "diff") return x - y;
  if (op === "rate") return Math.round((x / y) * 1e6) / 1e6;
  const ci = outward(wilson(x, y));
  return op === "wilson_lo" ? ci[0] : ci[1];
}

describe("The State of Agent Reliability, Edition 1", () => {
  it("every number on the page equals the value in its public source file", async () => {
    const nums = pageNums(page);
    expect(nums.length).toBeGreaterThan(40);
    const docs = await servedSources();
    for (const x of nums) {
      const want = expected(docs[x.source], x.pointer, x.op, x.pointer2);
      expect(want, `${x.id} at ${x.source}${x.pointer}`).not.toBeUndefined();
      expect(x.value, `${x.id} at ${x.source}${x.pointer}`).toBe(String(want).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
    }
    // The key figures are there, each read from its source.
    const ids = new Set(nums.map((x) => x.id));
    for (const id of ["arena_attempts", "arena_falls", "arena_rate", "arena_lo", "arena_hi", "scan_flagged", "scan_ordinary", "scan_lo", "scan_hi", "model_rows_early", "traps", "bouts", "ranked_bouts", "practice_bouts", ...(edition.case_study.found ? ["case_run"] : [])]) expect(ids, id).toContain(id);
  });

  it("the JSON twin carries every number with its source and pointer, and the same values", async () => {
    const d = (await json(EDITION.json)) as Omit<Edition, "findings"> & { findings: { plain: string }[]; pdf: string };
    expect(d.edition).toBe(1);
    expect(d.mode).toBe(FROZEN.frozen ? "frozen" : "live_preview");
    expect(d.pdf).toMatch(/\/reports\/state-of-agent-reliability\/2026-q4\.pdf$/);
    const docs = await servedSources();
    for (const [id, x] of Object.entries(d.nums)) {
      expect(x.value, id).toEqual(expected(docs[x.source], x.pointer, x.op, x.pointer2) ?? null);
    }
    expect(d.findings.map((f) => f.plain).join(" ")).toContain(display(d.nums.arena_attempts!.value, "int"));
    expect(JSON.stringify(d)).not.toMatch(/"note"\s*:/);
  });

  it("findings show n and 95% intervals, with a small-sample warning where the sample is small", () => {
    const edition = live;
    const f = Object.fromEntries(edition.findings.map((x) => [x.id, x]));
    expect(Object.keys(f)).toEqual(["ranked-trap-falls", "by-kind-of-job", "trap-card-null", "sample-sizes", "skill-scan", "not-yet-known"]);
    // B2-04: Lab #4's null result is a finding, with its n and interval, read from /security's JSON.
    expect(f["trap-card-null"]!.lab).toBe(4);
    const nullText = plain(f["trap-card-null"]!.text, edition.nums);
    expect(nullText).toContain("the card didn't measurably reduce traps");
    expect(nullText).toMatch(/Risk ratio \d\.\d\d \(95% interval \d\.\d\d to \d\.\d\d; p = 0\.\d+\)/);
    expect(nullText).toContain("Forge Lab #3 on small open models");
    expect(edition.nums.lab4_bouts!.value).toBe(210);
    expect(typeof edition.nums.lab4_risk_ratio_ci95__0!.value).toBe("number");
    // F-01/F-03: every rate finding names its rules, and the gates see the null finding.
    for (const id of ["ranked-trap-falls", "by-kind-of-job", "trap-card-null"]) expect(plain(f[id]!.text, edition.nums), id).toMatch(/\brules \d/);
    const gates = Object.fromEntries(freezeGates(edition, liveSrc, { approved: false }).map((g) => [g.id, g]));
    expect(gates.null_result_finding!.pass).toBe(true);
    expect(gates.rules_labels!.pass).toBe(true);
    expect(gates.no_private_material!.pass).toBe(true);
    expect(gates.dinike_said_freeze!.pass).toBe(false);
    expect(gates.current_rules_results!.pass).toBe(false);
    // 20 ranked attempts in the seed (5 more once the embargoed model's results are published), 8 of them falls.
    expect(edition.nums.arena_attempts!.value).toBe(RANKED);
    expect(edition.nums.arena_falls!.value).toBe(8 + RANKED - 20);
    // Older-rules attempts are counted apart, never pooled (ADR 0068 Amendment 1, ADR 0072).
    expect(edition.nums.older_rules_0!.value).not.toBe(edition.nums.arena_rules!.value);
    expect(edition.nums.older_attempts_0!.value).toBe(3);
    expect(plain(methods(edition).find((m) => m.title === "One rules version")!.text, edition.nums)).toContain("Attempts scored under older rules (rules 0.5: 3)");
    expect(f["sample-sizes"]!.warning).not.toBeNull();
    // The served page (the seed's own numbers until the edition is frozen).
    if (!FROZEN.frozen) {
      expect(page).toMatch(/Attempts scored under older rules \(<a class="src-num"[^>]*data-num="older_rules_0"/);
      expect(page).toContain('<span class="label">Small sample</span>');
    }
    expect(page).toMatch(/95% interval <a class="src-num"[^>]*data-num="arena_lo"/);
    // The Trap Set count spans every rules version and says so, next to the current-rules count.
    expect(plain(f["sample-sizes"]!.text, edition.nums)).toContain("models across all rules versions");
    // The launch scan, with the report's own figures and its 0.33% (not rounded to 0.3%).
    expect(plain(f["skill-scan"]!.text, edition.nums)).toContain("30 of 9,014 ordinary public agent skills matched a high-risk pattern: 0.33% (95% interval 0.2% to 0.5%)");
    expect(plain(f["skill-scan"]!.text, edition.nums)).toContain("real patterns: 26; showing signs of malice: 0; malware found by this method: 0");
    // Nothing a frozen edition needs is missing from the sources (a shape change fails here, not in a published edition).
    expect(missingNumbers(edition)).toEqual([]);
    expect(missingNumbers({ ...edition, nums: { ...edition.nums, scan_flagged: { ...edition.nums.scan_flagged!, value: null } } })).toEqual(["scan_flagged"]);
    // Rows with too few attempts show no rate.
    expect(edition.groups.some((g) => g.shown)).toBe(true);
  });

  it("puts methods and limits first, and stamps the edition, date, rules versions and the quarterly note", () => {
    const at = (s: string) => page.indexOf(s);
    expect(at('id="methods"')).toBeGreaterThan(0);
    expect(at('id="methods"')).toBeLessThan(at('id="findings"'));
    expect(page).toMatch(/Edition 1, generated <time datetime="\d{4}-\d{2}-\d{2}">/);
    expect(page).toContain("Rules versions: Arena referee <code>rules ");
    expect(page).toContain("Regenerated each quarter");
    expect(page).toContain("January 2027");
    if (!FROZEN.frozen) expect(page).toContain("Live preview.");
    expect(methods(edition).map((m) => m.title)).toContain("Ranked and practice are kept apart");
  });

  it("keeps practice out of every rate, labels the case as practice, and labels totals as including our own agents", () => {
    const edition = live;
    // 10 practice falls and the practice case are not in the ranked counts.
    expect(edition.nums.arena_attempts!.value).toBe(RANKED);
    expect(edition.case_study.found).toBe(true);
    expect(edition.case_study.run).toBe(runIds.case);
    const cs = caseText(edition)!.filter((s) => typeof s === "string").join("");
    expect(cs).toContain("practice bout (not ranked, and not counted in any rate above)");
    if (!FROZEN.frozen) expect(page).toContain("Illustrative case: a practice bout");
    expect(page).toContain("Includes The Forge's own test agents.");
    expect(page).not.toMatch(/\b(outside agents|third-party|by other agents)\b/i);
    expect(page).not.toMatch(/leaderboard|best model|worst model|safest model/i);
  });

  it("no number hides in the wording: digits in the text are only fixed facts", () => {
    const allowed = /95%|Lab #[346]|played 3 times/g;
    const parts = [live, edition].flatMap((edition) => [...edition.findings.flatMap((f) => [...f.text, ...(f.warning ?? [])]), ...methods(edition).flatMap((m) => m.text), ...(caseText(edition) ?? [])]);
    for (const s of parts) if (typeof s === "string") expect(s.replace(allowed, ""), s).not.toMatch(/\d/);
  });

  it("shows nothing embargoed, private or held", async () => {
    // The served surfaces, and (once frozen) what the builder makes of this seed, which holds an embargoed model's runs.
    const surfaces = [page, JSON.stringify(await json(EDITION.json)), asciiTextOf(await (await get(EDITION.pdf, "application/pdf")).arrayBuffer()), JSON.stringify(live), asciiTextOf(pdfFor(live, env.PUBLIC_ORIGIN).buffer)];
    for (const s of surfaces) {
      if (isEmbargoed(EMBARGOED.id)) expect(s).not.toMatch(SHOWS_EMBARGOED);
      expect(s).not.toMatch(/FA-[A-Z]+-1\d\d/);
      expect(s).not.toMatch(/held[-_ ]?out (seed|panel) [a-z0-9]/i);
      for (const [repo] of (held as unknown as { repos: string[][] }).repos.slice(0, 50)) expect(s).not.toContain(repo);
    }
  });

  it("serves a PDF with the key numbers, the citation block and the canary, the same bytes every time", async () => {
    const res = await get(EDITION.pdf, "application/pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const raw = new TextDecoder().decode(bytes);
    expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(bytes.every((b) => b < 128)).toBe(true);
    const text = asciiTextOf(bytes.buffer);
    const e = edition;
    for (const [id, fmt] of [["arena_attempts", "int"], ["arena_falls", "int"], ["arena_rate", "pct"], ["arena_lo", "pct_lo"], ["arena_hi", "pct_hi"], ["scan_flagged", "int"], ["scan_ordinary", "int"], ["scan_lo", "pct_lo"], ["scan_hi", "pct_hi"], ["traps", "int"], ["bouts", "int"]] as const)
      expect(text, id).toContain(display(e.nums[id]!.value, fmt));
    expect(text).toContain("Methods and limits (read first)");
    expect(text.indexOf("Methods and limits")).toBeLessThan(text.indexOf("Findings"));
    expect(text).toContain("@techreport{forgereliability2026q4e1,");
    expect(text).toContain("cff-version: 1.2.0");
    expect(text).toContain(e.canary!);
    expect(text).toContain("Illustrative case (practice, not ranked)");
    expect(text).toContain("Includes The Forge's own test agents.");
    // Reproducible: the same edition gives the same bytes; the cross-reference offsets are exact.
    const again = pdfFor(e, env.PUBLIC_ORIGIN);
    expect(pdfFor(e, env.PUBLIC_ORIGIN)).toEqual(again);
    const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(raw)?.[1]);
    expect(raw.slice(xref, xref + 4)).toBe("xref");
    for (const m of raw.matchAll(/^(\d{10}) 00000 n $/gm)) expect(raw.slice(Number(m[1]))).toMatch(/^\d+ 0 obj\n/);
  });

  it("formats numbers the same way on the page and in the PDF", () => {
    for (const v of [0, 1, 1234, 0.25, 0.0333, 0.2875, 0.002, 0.005, 0.003328, "rules 0.6", "not_yet_published", "2026-10-19", true, null] as const)
      for (const fmt of ["int", "pct", "pct2", "pct_lo", "pct_hi", "ratio", "text", "date"] as const) expect(pdfDisplay(v, fmt)).toBe(display(v, fmt));
    expect(asciiText("a – b · c “d” …")).toBe('a - b - c "d" ...');
  });

  it("computes intervals the way the Arena does (Wilson, rounded outwards)", () => {
    for (const [k, nn] of [[30, 9014], [0, 12], [12, 12], [8, 20], [1, 3]] as const) expect(wilsonOutward(k, nn)).toEqual(outward(wilson(k, nn)));
  });

  it("builds the same edition from the live objects as from the served files", async () => {
    const files = Object.fromEntries(await Promise.all((Object.keys(SOURCES) as SourceKey[]).map(async (k) => [k, await json(SOURCES[k])]))) as Record<SourceKey, unknown>;
    const opts = { origin: env.PUBLIC_ORIGIN, mode: "live_preview" as const, generatedAt: "2026-10-28T00:00:00.000Z" };
    const fromObjects = buildEdition(await liveSources(env), opts);
    const served = buildEdition(files, opts);
    expect(served.nums).toEqual(fromObjects.nums);
  });

  it("labels a live preview as not citable everywhere, and a frozen edition as citable", () => {
    const pv = live.citation;
    expect(live.citable).toBe(false);
    expect(pv.text).toMatch(/^Live preview, not frozen: .*do not cite it yet\./);
    expect(pv.bibtex).toContain("[live preview, not frozen]");
    expect(pv.bibtex).toContain("note        = {Live preview, not frozen");
    expect(pv.cff).toContain('version: "edition-1-live-preview"');
    expect(pv.cff).not.toContain("date-released");
    const pdf = asciiTextOf(pdfFor(live, env.PUBLIC_ORIGIN).buffer);
    expect(pdf).toContain("LIVE PREVIEW - NOT FROZEN.");
    expect(pdf).toContain("LIVE PREVIEW, not frozen - page 1 of");
    if (!FROZEN.frozen) {
      expect(page).toContain('id="cite-preview"');
      expect(page).toContain('"creativeWorkStatus":"Draft"');
      expect(page).not.toContain('"datePublished"');
    }
    // The same data, frozen: citable, dated, with no preview wording, and its sources link to the saved copies.
    const frozen = buildEdition(liveSrc, { origin: env.PUBLIC_ORIGIN, mode: "frozen", generatedAt: "2026-10-28T00:00:00.000Z" });
    expect(frozen.citable).toBe(true);
    expect(frozen.citation.cff).toContain("date-released: 2026-10-28");
    for (const c of Object.values(frozen.citation)) expect(c).not.toMatch(/preview/i);
    const fpdf = asciiTextOf(pdfFor(frozen, env.PUBLIC_ORIGIN).buffer);
    expect(fpdf).not.toMatch(/preview/i);
    expect(fpdf).toContain(`${EDITION.sources_dir}/security.json`);
  });

  it("is frozen with its sources and static PDF, or not frozen and serves no static PDF", async () => {
    const asset = await env.ASSETS.fetch(`https://assets.local${EDITION.pdf}`);
    if (!FROZEN.frozen) {
      expect(FROZEN).toEqual({ frozen: false });
      expect(asset.status).toBe(404);
      return;
    }
    // Frozen: rebuild the edition and the PDF from the saved copies; both must match what was recorded.
    const files: Partial<Record<SourceKey, unknown>> = {};
    for (const [key, m] of Object.entries(FROZEN.sources)) {
      const buf = await (await env.ASSETS.fetch(`https://assets.local${m.file}`)).arrayBuffer();
      expect(hex(await crypto.subtle.digest("SHA-256", buf)), m.file).toBe(m.sha256);
      files[key as SourceKey] = JSON.parse(new TextDecoder().decode(buf));
    }
    const rebuilt = buildEdition(files as Record<SourceKey, unknown>, { origin: FROZEN.origin, mode: "frozen", generatedAt: FROZEN.edition.generated_at });
    expect(rebuilt).toEqual(FROZEN.edition);
    const pdf = pdfFor(rebuilt, FROZEN.origin);
    expect(hex(await crypto.subtle.digest("SHA-256", pdf))).toBe(FROZEN.pdf.sha256);
    expect(hex(await crypto.subtle.digest("SHA-256", await asset.arrayBuffer()))).toBe(FROZEN.pdf.sha256);
  });

  it("is linked from /benchmark, /security and /about, listed in the sitemap and llms.txt, with share metadata", async () => {
    for (const p of ["/benchmark", "/security", "/about"]) expect(await (await get(p)).text(), p).toContain(`href="${EDITION.path}"`);
    expect(await (await get("/sitemap.xml", "application/xml")).text()).toContain(`${EDITION.path}</loc>`);
    expect(await (await get("/llms.txt", "text/plain")).text()).toContain(`(${EDITION.path})`);
    expect(page).toContain('<meta property="og:title" content="The State of Agent Reliability, Edition 1 (2026 Q4)"');
    expect(page).toContain(`/og/reports/state-of-agent-reliability-2026-q4.png`);
    const og = await get("/og/reports/state-of-agent-reliability-2026-q4.png", "image/png");
    expect(og.status).toBe(200);
    expect(og.headers.get("Content-Type")).toContain("image/png");
    const r = await fetchWorker("/reports/state-of-agent-reliability", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(EDITION.path);
  });
});

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The text a PDF reader shows: every `(...) Tj` string, unescaped, joined by line. */
function asciiTextOf(buf: ArrayBufferLike) {
  const raw = new TextDecoder().decode(new Uint8Array(buf));
  return [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]!.replace(/\\([\\()])/g, "$1")).join(" ");
}
