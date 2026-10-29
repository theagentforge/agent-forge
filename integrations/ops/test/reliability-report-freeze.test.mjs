import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildEdition, freezeGates, plain } from "../../../apps/forge/src/reports/reliability-edition.ts";

// The State of Agent Reliability (ADR 0079, ADR 0080): freezing an edition from copies saved by hand
// (`freeze --from-dir <dir> --fetched-at <time>`), rebuilding it byte for byte, and refusing to change a frozen one.
// The script runs as it does for the coordinator: plain Node, against a temporary checkout (--root).

// Each test spawns the script (and builds a PDF) several times: 1 to 2.5 s each on an idle machine, past the 5 s default
// when the full suite runs in parallel. A generous per-file timeout keeps them from failing on load alone.
vi.setConfig({ testTimeout: 60_000 });

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/reliability-report.mjs");
const EDITION_FILE = "apps/forge/src/reports/editions/2026-q4.json";
const PDF_FILE = "apps/forge/public/reports/state-of-agent-reliability/2026-q4.pdf";
const COPIES = "apps/forge/public/reports/state-of-agent-reliability/2026-q4/sources";
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Minimal source files with the shapes the edition reads (the Worker tests check the real shapes). */
function sources() {
  const cell = (attempts, falls, lo, hi) => ({ attempts, shown: true, policy_breaks: falls, break_rate: Math.round((falls / attempts) * 1000) / 1000, ci_95: [lo, hi], early_read: true });
  return {
    "security.json": {
      arena: {
        rules_version: "rules 0.6",
        attempts_under_older_rules: [{ rules_version: "rules 0.5", attempts: 3 }],
        since: "2026-10-20",
        as_of: "2026-10-27",
        knockouts: 1,
        models: 2,
        overall: cell(20, 8, 0.218, 0.614),
        by_group: [{ name: "Refunds and policy limits", ...cell(14, 4, 0.117, 0.547) }, { name: "Payments and invoices", ...cell(6, 0, 0, 0.391) }, { name: "Records", attempts: 0, shown: false }],
        min_attempts_shown: 5,
        early_read_below: 30,
      },
      reports: { skill_scan: { date: "2026-10-19", rules_version: "2026-10-19.3", skills: 9930, ordinary_skills: 9014, flagged_ordinary: 30, real_patterns: 26, signs_of_malice: 0, malware_found: 0 } },
      trap_card_experiments: [
        { lab: 4, finished: "2026-10-21", rules_version: "rules 0.4", bouts: 210, bouts_per_arm: 105, model_job_pairs: 7, arms: { no_card: { bouts: 105, fell: 31 }, card: { bouts: 105, fell: 26 } }, risk_ratio: 0.84, risk_ratio_ci95: [0.55, 1.27], p: 0.508, p_text: "p = 0.51", statistically_significant: false, result: "did_not_measurably_reduce_traps" },
        { lab: 3, finished: "2026-10-18", rules_version: "rules 0.4", bouts: 492, bouts_per_arm: 164, model_job_pairs: 6, arms: { no_card: { bouts: 164, fell: 60 }, placebo: { bouts: 164, fell: 55 }, card: { bouts: 164, fell: 27 } }, risk_ratio: 0.46, risk_ratio_ci95: [0.31, 0.68], p: 0, p_text: "p < 0.001", statistically_significant: true, result: "reduced_traps" },
      ],
    },
    "benchmark-v1.json": {
      version: "1.0",
      rules_version: "rules 0.6",
      canary: "TEST CANARY GUID 00000000-0000-0000-0000-000000000000",
      counts: { traps: 41, jobs: 6, families: 5, tasks: 20, ranked_attempts: 23, models: 2 },
      limits: { model_tier_rows: 3, model_tier_rows_below_early_read: 3, model_tier_rows_scored_under_older_rules: 1, early_read_below_attempts: 30, traps_with_no_ranked_attempts_yet: ["FA-A-001", "FA-B-002"] },
      referee_validation: { status: "not_yet_published" },
      data_protection: { public_vs_private_gap: { rows_measured: 0, contamination: { status: "not_yet_established", test_events: 1, needs: { min_distinct_events: 2 } } } },
      // F-03 gate 1: four models with 30 ranked Hard attempts each under the current rules (plus rows that don't count).
      results: {
        models: [
          ...["m-a", "m-b", "m-c", "m-d"].map((model) => ({ model, tier: "hard", rules_version: "rules 0.6", attempts: 30 })),
          { model: "m-e", tier: "normal", rules_version: "rules 0.6", attempts: 90 },
          { model: "m-f", tier: "hard", rules_version: "rules 0.5", attempts: 90 },
        ],
      },
    },
    "stats.json": { rules_version: "2.0", blended: { work: { bouts_refereed: 39, ranked_bouts: 28, traps_sprung: 26, field_reports: null, skills_scanned: null, tools_tracked: null }, gauntlet_runs_finished: 0 } },
    "home.json": { hero: { headline_source: { status: "not_found" } } },
  };
}

/** A temporary checkout with an unfrozen edition, and a folder of saved copies (pretty-printed, as a browser may save). */
function setup(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "rel-root-"));
  mkdirSync(join(root, dirname(EDITION_FILE)), { recursive: true });
  mkdirSync(join(root, dirname(PDF_FILE)), { recursive: true });
  writeFileSync(join(root, EDITION_FILE), '{ "frozen": false }\n');
  const dir = mkdtempSync(join(tmpdir(), "rel-saved-"));
  for (const [name, body] of Object.entries({ ...sources(), ...over })) writeFileSync(join(dir, name), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  return { root, dir };
}

const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { encoding: "utf8", timeout: 50_000 });
// Each test spawns the script (plain Node, which also draws a PDF) several times: about a second each on a quiet machine,
// several seconds when the full suite shares the CPU. The 5-second default timed out in full runs (review, 28 Oct).
vi.setConfig({ testTimeout: 60_000 });
/** Freeze with Dinike's word given, dated today (F-03 gate 7); the gate tests below leave it out on purpose. */
const TODAY = new Date().toISOString().slice(0, 10);
const OK = ["--dinike-said-freeze", TODAY];
const T = "2026-10-27T09:30:00Z";

describe("freeze --from-dir", () => {
  it("freezes from saved copies: exact bytes, their hashes, the given time, and a valid PDF; rebuild matches", () => {
    const { root, dir } = setup();
    const r = run(root, "freeze", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...OK);
    expect(r.status, r.stderr).toBe(0);
    const frozen = JSON.parse(readFileSync(join(root, EDITION_FILE), "utf8"));
    expect(frozen.frozen).toBe(true);
    expect(frozen.origin).toBe("https://theagentforge.io");
    expect(frozen.edition.mode).toBe("frozen");
    expect(frozen.edition.citable).toBe(true);
    expect(frozen.edition.generated_at).toBe("2026-10-27T09:30:00.000Z");
    const paths = { benchmark: "/benchmark/v1.json", stats: "/stats.json", security: "/security?format=json", home: "/?format=json" };
    const files = { benchmark: "benchmark-v1.json", stats: "stats.json", security: "security.json", home: "home.json" };
    expect(Object.keys(frozen.sources).sort()).toEqual(Object.keys(paths).sort());
    for (const [key, m] of Object.entries(frozen.sources)) {
      const saved = readFileSync(join(dir, files[key]));
      const copy = readFileSync(join(root, COPIES, files[key]));
      expect(copy.equals(saved), key).toBe(true);
      expect(m).toEqual({ path: paths[key], file: `/reports/state-of-agent-reliability/2026-q4/sources/${files[key]}`, fetched_at: "2026-10-27T09:30:00.000Z", via: "saved_copy", sha256: sha(saved), bytes: saved.length });
    }
    // The launch scan's own figures, exactly.
    const n = frozen.edition.nums;
    expect([n.scan_flagged.value, n.scan_ordinary.value, n.scan_real.value, n.scan_malice.value, n.scan_malware.value]).toEqual([30, 9014, 26, 0, 0]);
    const scan = frozen.edition.findings.find((f) => f.id === "skill-scan");
    expect(scan.text).toContainEqual({ n: "scan_rate", fmt: "pct2" });
    // The citation no longer carries the live-preview warning once frozen.
    expect(frozen.edition.citation.bibtex).not.toMatch(/preview/i);
    expect(frozen.edition.citation.cff).toContain("date-released: 2026-10-27");
    // The PDF: recorded hash, a PDF 1.4 file whose cross-reference offsets point at their objects.
    const pdf = readFileSync(join(root, PDF_FILE));
    expect(sha(pdf)).toBe(frozen.pdf.sha256);
    const raw = pdf.toString("latin1");
    expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
    const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(raw)?.[1]);
    expect(raw.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...raw.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(5);
    offsets.forEach((o, i) => expect(raw.slice(o)).toMatch(new RegExp(`^${i + 1} 0 obj\\n`)));
    expect(raw).toContain("30 of 9,014 ordinary");
    expect(raw).toContain("0.33%");
    expect(raw).not.toContain("LIVE PREVIEW");
    // Rebuild from the saved copies: byte for byte.
    const rb = run(root, "rebuild");
    expect(rb.status, rb.stderr).toBe(0);
    expect(rb.stdout).toContain("byte for byte");
    // The same files frozen elsewhere give the same PDF bytes.
    const other = setup();
    expect(run(other.root, "freeze", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...OK).status).toBe(0);
    expect(readFileSync(join(other.root, PDF_FILE)).equals(pdf)).toBe(true);
  });

  it("refuses to overwrite a frozen edition, and rebuild fails when a saved copy changes", () => {
    const { root, dir } = setup();
    expect(run(root, "freeze", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...OK).status).toBe(0);
    const before = readFileSync(join(root, EDITION_FILE));
    const again = run(root, "freeze", "--from-dir", dir, "--fetched-at", "2026-10-27T10:00:00Z", "--case-run-prefix", "", ...OK);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already frozen");
    expect(readFileSync(join(root, EDITION_FILE)).equals(before)).toBe(true);
    writeFileSync(join(root, COPIES, "stats.json"), readFileSync(join(root, COPIES, "stats.json"), "utf8").replace("39", "40"));
    const rb = run(root, "rebuild");
    expect(rb.status).toBe(1);
    expect(rb.stderr).toContain("stats.json: hash differs");
  });

  it("needs an honest --fetched-at, and writes nothing when the copies are missing, not JSON, or the wrong shape", () => {
    const cases = [
      [setup(), [], "needs --fetched-at"],
      [setup(), ["--fetched-at", "28 Oct 2026"], "needs --fetched-at"],
      [setup(), ["--fetched-at", "2099-01-01T00:00:00Z"], "in the future"],
      [setup({ "stats.json": "<!doctype html><pre>{}</pre>" }), ["--fetched-at", T], "isn't JSON"],
      [setup({ "stats.json": { blended: {} } }), ["--fetched-at", T], "missing from the sources"],
    ];
    for (const [{ root, dir }, extra, error] of cases) {
      const r = run(root, "freeze", "--from-dir", dir, ...extra, "--case-run-prefix", "", ...OK);
      expect(r.status, error).toBe(1);
      expect(r.stderr).toContain(error);
      expect(readFileSync(join(root, EDITION_FILE), "utf8")).toBe('{ "frozen": false }\n');
      expect(existsSync(join(root, PDF_FILE))).toBe(false);
      expect(existsSync(join(root, COPIES))).toBe(false);
    }
    // A fetch records its own time: --fetched-at without --from-dir is refused.
    const { root } = setup();
    const r = run(root, "freeze", "--fetched-at", T);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only for --from-dir");
  });
});

/** The edition file, PDF and copies are untouched (a refused or dry-run freeze writes nothing). */
function untouched(root) {
  expect(readFileSync(join(root, EDITION_FILE), "utf8")).toBe('{ "frozen": false }\n');
  expect(existsSync(join(root, PDF_FILE))).toBe(false);
  expect(existsSync(join(root, COPIES))).toBe(false);
}

describe("freeze gates (F-03, ADR 0082)", () => {
  const base = sources();
  const withBench = (over) => ({ "benchmark-v1.json": { ...base["benchmark-v1.json"], ...over } });

  it("with 0 ranked current-rules attempts, freeze exits non-zero naming the gate and writes nothing", () => {
    const { root, dir } = setup(withBench({ results: { models: [{ model: "m-f", tier: "hard", rules_version: "rules 0.5", attempts: 90 }] } }));
    const r = run(root, "freeze", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...OK);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not freezing");
    expect(r.stderr).toContain("current_rules_results");
    expect(r.stderr).toContain("0 of 4 models have 30+ ranked Hard attempts under rules 0.6");
    untouched(root);
  });

  it("three models at 30, or four with one at 29, is not enough", () => {
    const rows = (n) => ["m-a", "m-b", "m-c", "m-d"].map((model, i) => ({ model, tier: "hard", rules_version: "rules 0.6", attempts: i === 3 ? n : 30 }));
    const short = setup(withBench({ results: { models: rows(29) } }));
    expect(run(short.root, "freeze", "--from-dir", short.dir, "--fetched-at", T, "--case-run-prefix", "", ...OK).stderr).toContain("3 of 4 models");
    untouched(short.root);
  });

  it("--dry-run reports every gate and which fail, writes nothing, and exits 1 while a blocking gate fails", () => {
    const { root, dir } = setup({ ...withBench({ results: { models: [] }, data_protection: { public_vs_private_gap: { rows_measured: 0, contamination: { status: "not_yet_measured", test_events: 0, needs: { min_distinct_events: 2 } } } } }), "security.json": { ...base["security.json"], trap_card_experiments: [] } });
    const r = run(root, "freeze", "--dry-run", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "");
    expect(r.status).toBe(1);
    for (const id of ["current_rules_results", "null_result_finding", "dinike_said_freeze"]) expect(r.stdout).toMatch(new RegExp(`✗ ${id}:`));
    // ADR 0085: an untested contamination effect is a known unknown stated exactly, last, not a "not yet measured".
    expect(r.stdout).toMatch(/✓ no_unmeasured_findings:/);
    expect(r.stdout).toMatch(/✓ known_unknowns_last:/);
    expect(r.stdout).toMatch(/! referee_audit:/);
    expect(r.stdout).toMatch(/✓ rules_labels:/);
    expect(r.stdout).toMatch(/✓ no_private_material:/);
    expect(r.stdout).toContain("Would not freeze: 3 blocking gates fail");
    untouched(root);
  });

  it("--dry-run with every gate met says it could be frozen, exits 0 and still writes nothing", () => {
    const { root, dir } = setup();
    const r = run(root, "freeze", "--dry-run", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...OK);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("All blocking gates pass");
    expect(r.stdout).not.toMatch(/✗/);
    untouched(root);
  });

  it("refuses without Dinike's word, and without the Lab #4 finding; with every gate met it freezes", () => {
    const a = setup();
    const r = run(a.root, "freeze", "--from-dir", a.dir, "--fetched-at", T, "--case-run-prefix", "");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dinike_said_freeze");
    untouched(a.root);
    const b = setup({ "security.json": { ...base["security.json"], trap_card_experiments: [] } });
    const rb = run(b.root, "freeze", "--from-dir", b.dir, "--fetched-at", T, "--case-run-prefix", "", ...OK);
    expect(rb.stderr).toContain("null_result_finding");
    untouched(b.root);
    const c = setup();
    const ok = run(c.root, "freeze", "--from-dir", c.dir, "--fetched-at", T, "--case-run-prefix", "", ...OK);
    expect(ok.status, ok.stderr).toBe(0);
    const frozen = JSON.parse(readFileSync(join(c.root, EDITION_FILE), "utf8"));
    const lab = frozen.edition.findings.find((f) => f.lab === 4);
    expect(lab.id).toBe("trap-card-null");
    expect([frozen.edition.nums.lab4_risk_ratio_ci95__0.value, frozen.edition.nums.lab4_risk_ratio_ci95__1.value, frozen.edition.nums.lab4_bouts.value]).toEqual([0.55, 1.27, 210]);
  });

  it("a dry run on a frozen edition reports it as frozen rather than failing silently", () => {
    const { root, dir } = setup();
    expect(run(root, "freeze", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...OK).status).toBe(0);
    const r = run(root, "freeze", "--dry-run", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...OK);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ not_frozen_yet: .*already frozen/);
  });
});

// Review of ADR 0082 (ADR 0085): Dinike's word is a dated, recorded approval that can't be given by accident, and the
// wording gates are checked on the edition itself.
describe("freeze approval and wording (ADR 0085)", () => {
  const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  it("a bare flag, a malformed, future or stale date fails the gate and writes nothing; a dated word is recorded", () => {
    for (const [extra, why] of [
      [["--dinike-said-freeze"], "needs the day Dinike said"],
      [["--dinike-said-freeze", "--dry-run-not"], "needs the day Dinike said"],
      [["--dinike-said-freeze", "yes"], "needs the day Dinike said"],
      [["--dinike-said-freeze", days(2)], "is in the future"],
      [["--dinike-said-freeze", days(-15)], "more than 14 days old"],
    ]) {
      const { root, dir } = setup();
      const r = run(root, "freeze", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", ...extra);
      expect(r.status, why).toBe(1);
      expect(r.stderr).toContain("dinike_said_freeze");
      expect(r.stderr).toContain(why);
      untouched(root);
    }
    const { root, dir } = setup();
    const ok = run(root, "freeze", "--from-dir", dir, "--fetched-at", T, "--case-run-prefix", "", "--dinike-said-freeze", days(-3));
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, EDITION_FILE), "utf8")).approval).toEqual({ dinike_said_freeze: days(-3) });
  });

  it("a finding reading 'not yet measured' or 'not available' fails, and the known unknowns must come last", () => {
    const src = Object.fromEntries(Object.entries(sources()).map(([k, v]) => [{ "security.json": "security", "benchmark-v1.json": "benchmark", "stats.json": "stats", "home.json": "home" }[k], v]));
    const fresh = () => buildEdition(src, { origin: "https://theagentforge.io", mode: "frozen", generatedAt: T });
    const gate = (e, id) => freezeGates(e, src, { approved: true }).find((g) => g.id === id);
    const e = fresh();
    expect(gate(e, "no_unmeasured_findings").pass).toBe(true);
    expect(gate(e, "known_unknowns_last").pass).toBe(true);
    expect(e.findings.at(-1).id).toBe("not-yet-known");
    for (const words of [" Not yet measured.", " Lab #4: not available."]) {
      const bad = fresh();
      bad.findings[0].text = [...bad.findings[0].text, words];
      expect(gate(bad, "no_unmeasured_findings")).toMatchObject({ pass: false, blocking: true, detail: `found in: ${bad.findings[0].id}` });
    }
    const moved = fresh();
    moved.findings.unshift(moved.findings.pop());
    expect(gate(moved, "known_unknowns_last")).toMatchObject({ pass: false, blocking: true });
    // An untested contamination effect reads as exactly that, with its counts.
    const untested = buildEdition({ ...src, benchmark: { ...src.benchmark, data_protection: { public_vs_private_gap: { rows_measured: 0, contamination: { status: "not_yet_measured", test_events: 0, needs: { min_distinct_events: 2 } } } } } }, { origin: "https://theagentforge.io", mode: "frozen", generatedAt: T });
    const text = plain(untested.findings.at(-1).text, untested.nums);
    expect(text).toContain("not tested yet: no contamination test event has run. Contamination test events so far: 0 (at least 2 are needed");
    expect(text).not.toMatch(/not yet measured|not available/i);
  });
});
