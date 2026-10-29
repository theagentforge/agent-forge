// The State of Agent Reliability (ADR 0079): freeze an edition from the live public files, or rebuild a frozen one and
// check it matches byte for byte. Plain Node (22.18 or newer, which runs the TypeScript modules directly); no packages.
//
//   node scripts/reliability-report.mjs freeze [--origin https://theagentforge.io] [--case-run-prefix 3a118ac4]
//       Reads each source file from the site, saves exact copies, builds the edition and its PDF, and writes:
//         apps/forge/public/reports/state-of-agent-reliability/2026-q4/sources/*.json   (the copies)
//         apps/forge/public/reports/state-of-agent-reliability/2026-q4.pdf              (served as a static file)
//         apps/forge/src/reports/editions/2026-q4.json                                  (the frozen edition + hashes)
//       Refuses if the edition is already frozen: a frozen edition is never changed (a correction is a new file).
//   node scripts/reliability-report.mjs freeze --from-dir <dir> --fetched-at <ISO time, UTC> [--origin https://theagentforge.io]
//       The same, from copies saved by hand exactly as served (for a machine that can't reach the site): <dir> holds
//       benchmark-v1.json, stats.json, security.json and home.json, read from these addresses on the origin:
//         /benchmark/v1.json, /stats.json, /security?format=json, /?format=json
//       --fetched-at is when they were read (required: the edition records it as given, and says the copies were
//       saved by hand rather than fetched by this script). The bytes are hashed exactly as saved.
//   Either form refuses unless every freeze gate passes (F-03, ADR 0082; docs/strategy/build-plan-2026-10-28-boardy2.md
//   §5.1): current-rules results on the Hard jobs, no "not yet measured" finding, the Lab #4 null result as a finding,
//   rules labels, nothing private, and Dinike's "freeze" (--dinike-said-freeze <YYYY-MM-DD, the day it was said>,
//   given only after Dinike says so; recorded in the frozen edition).
//   Add --dry-run to read the sources and report every gate (✓ pass, ✗ blocking failure, ! advisory) without writing
//   anything; it exits 1 when a blocking gate fails, 0 when the edition could be frozen.
//   node scripts/reliability-report.mjs rebuild
//       Checks the saved copies against their hashes, rebuilds the edition and the PDF from them, and fails on any
//       difference. Anyone with the public code can run it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdition, caseText, EDITION, failedGates, freezeGates, gateLines, methods, SOURCE_FILES, SOURCES } from "../apps/forge/src/reports/reliability-edition.ts";
import { editionPdf } from "../apps/forge/src/reports/reliability-pdf.ts";

const flag = (name) => process.argv.includes(`--${name}`);

/**
 * F-03 gate 7: Dinike's "freeze", given as the day it was said (--dinike-said-freeze YYYY-MM-DD, within the last 14
 * days, not in the future). A bare flag, a typo or a stale date fails the gate, so it can't be passed by accident or
 * copied from an old command; the date is recorded in the frozen edition.
 */
function saidFreeze(argv = process.argv, now = Date.now()) {
  const i = argv.indexOf("--dinike-said-freeze");
  if (i < 0) return { ok: false, detail: 'not given: pass --dinike-said-freeze <YYYY-MM-DD, the day Dinike said "freeze"> only after Dinike says so' };
  const d = argv[i + 1] ?? "";
  const day = Date.parse(`${d}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(day)) return { ok: false, detail: '--dinike-said-freeze needs the day Dinike said "freeze", as YYYY-MM-DD' };
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  if (day > today) return { ok: false, detail: `--dinike-said-freeze ${d} is in the future` };
  if (today - day > 14 * 86_400_000) return { ok: false, detail: `--dinike-said-freeze ${d} is more than 14 days old: ask again` };
  return { ok: true, date: d, detail: `given on ${d} (--dinike-said-freeze)` };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

// --root writes and reads under another checkout (the tests use a temporary folder); the default is this repo.
const ROOT = resolvePath(arg("root", join(dirname(fileURLToPath(import.meta.url)), "..")));
const PUBLIC = join(ROOT, "apps/forge/public");
const FROZEN = join(ROOT, `apps/forge/src/reports/editions/${EDITION.slug}.json`);
const copyPath = (key) => join(PUBLIC, EDITION.sources_dir, SOURCE_FILES[key]);
const pdfPath = join(PUBLIC, EDITION.pdf);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const pdfOf = (edition, origin) => Buffer.from(editionPdf(edition, origin, { methods: methods(edition), caseText: caseText(edition) }));

async function freeze() {
  const origin = (arg("origin", "https://theagentforge.io") ?? "").replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) throw new Error("--origin must be https://<host>");
  const prefix = arg("case-run-prefix", "3a118ac4");
  const dry = flag("dry-run");
  const current = JSON.parse(readFileSync(FROZEN, "utf8"));
  const already = current.frozen ? `Edition ${EDITION.slug} is already frozen (${current.edition.generated}); a frozen edition is never changed.` : null;
  if (already && !dry) throw new Error(already);
  const fromDir = arg("from-dir");
  let fetchedAt = new Date().toISOString();
  if (fromDir) {
    // Saved by hand: the time they were read is whatever the person saving them says, so it must be given, in UTC.
    const given = arg("fetched-at");
    if (!given || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(given) || Number.isNaN(Date.parse(given)))
      throw new Error("--from-dir needs --fetched-at <when the files were read, as an ISO time in UTC, e.g. 2026-10-28T09:30:00Z>");
    if (Date.parse(given) > Date.now() + 5 * 60_000) throw new Error(`--fetched-at ${given} is in the future`);
    fetchedAt = new Date(Date.parse(given)).toISOString();
  } else if (arg("fetched-at")) throw new Error("--fetched-at is only for --from-dir (a fetch records its own time)");
  // Read everything first and check it, so a failed freeze writes nothing.
  const bufs = {};
  for (const [key, path] of Object.entries(SOURCES)) {
    if (fromDir) {
      const file = join(resolvePath(fromDir), SOURCE_FILES[key]);
      if (!existsSync(file)) throw new Error(`${file} is missing: save ${origin}${path} there exactly as served`);
      bufs[key] = readFileSync(file);
    } else {
      const res = await fetch(`${origin}${path}`, { headers: { Accept: "application/json", "User-Agent": "forge-reliability-report/1 (+https://theagentforge.io/reports/state-of-agent-reliability)" } });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      bufs[key] = Buffer.from(await res.arrayBuffer());
    }
  }
  const sources = {};
  const meta = {};
  for (const [key, path] of Object.entries(SOURCES)) {
    const buf = bufs[key];
    try {
      sources[key] = JSON.parse(buf.toString("utf8"));
    } catch {
      throw new Error(`${SOURCE_FILES[key]} (${path}) isn't JSON: save the file exactly as served, not the page around it`);
    }
    meta[key] = { path, file: `${EDITION.sources_dir}/${SOURCE_FILES[key]}`, fetched_at: fetchedAt, via: fromDir ? "saved_copy" : "fetch", sha256: sha256(buf), bytes: buf.length };
  }
  const edition = buildEdition(sources, { origin, mode: "frozen", generatedAt: fetchedAt });
  const said = saidFreeze();
  const gates = freezeGates(edition, sources, { approved: said.ok, approvalDetail: said.detail });
  if (already) gates.unshift({ id: "not_frozen_yet", title: "The edition isn't frozen yet", pass: false, blocking: true, detail: already });
  if (prefix && edition.case_study.found && !String(edition.case_study.run).startsWith(prefix))
    gates.push({ id: "case_replay", title: "The illustrative case is the expected replay", pass: false, blocking: true, detail: `the home page's source replay is ${edition.case_study.run}, not ${prefix}…: check it before freezing (or pass --case-run-prefix "")` });
  const failed = failedGates(gates);
  if (dry) {
    console.log(`Dry run for ${EDITION.path} (sources read ${fetchedAt}); nothing written.`);
    console.log(gateLines(gates).join("\n"));
    console.log(failed.length ? `Would not freeze: ${failed.length} blocking ${failed.length === 1 ? "gate fails" : "gates fail"} (${failed.map((g) => g.id).join(", ")}).` : "All blocking gates pass: the edition could be frozen.");
    return failed.length ? 1 : 0;
  }
  if (failed.length) throw new Error(`Not freezing: ${failed.length} freeze ${failed.length === 1 ? "gate fails" : "gates fail"}:\n${gateLines(failed).join("\n")}\nRun with --dry-run to see every gate.`);
  const pdf = pdfOf(edition, origin);
  for (const key of Object.keys(SOURCES)) {
    mkdirSync(dirname(copyPath(key)), { recursive: true });
    writeFileSync(copyPath(key), bufs[key]);
  }
  writeFileSync(pdfPath, pdf);
  const frozen = { frozen: true, origin, approval: { dinike_said_freeze: said.date }, edition, sources: meta, pdf: { path: EDITION.pdf, sha256: sha256(pdf), bytes: pdf.length } };
  writeFileSync(FROZEN, `${JSON.stringify(frozen, null, 1)}\n`);
  console.log(`Froze ${EDITION.path} at ${fetchedAt}: ${Object.keys(edition.nums).length} numbers, ${edition.findings.length} findings, PDF ${pdf.length} bytes (sha256 ${frozen.pdf.sha256}).`);
  return 0;
}

function rebuild() {
  const frozen = JSON.parse(readFileSync(FROZEN, "utf8"));
  if (!frozen.frozen) {
    console.log(`Edition ${EDITION.slug} isn't frozen yet: nothing to rebuild.`);
    return;
  }
  const problems = [];
  const sources = {};
  if (Object.keys(frozen.sources).sort().join() !== Object.keys(SOURCES).sort().join()) problems.push("the frozen edition doesn't record exactly the four source files");
  for (const [key, m] of Object.entries(frozen.sources)) {
    const buf = readFileSync(copyPath(key));
    if (sha256(buf) !== m.sha256 || buf.length !== m.bytes) problems.push(`${m.file}: hash differs from the one recorded`);
    sources[key] = JSON.parse(buf.toString("utf8"));
  }
  const edition = buildEdition(sources, { origin: frozen.origin, mode: "frozen", generatedAt: frozen.edition.generated_at });
  if (JSON.stringify(edition) !== JSON.stringify(frozen.edition)) problems.push("the rebuilt edition differs from the frozen one");
  const pdf = pdfOf(edition, frozen.origin);
  if (sha256(pdf) !== frozen.pdf.sha256) problems.push("the rebuilt PDF differs from the recorded hash");
  if (sha256(readFileSync(pdfPath)) !== frozen.pdf.sha256) problems.push(`${EDITION.pdf}: the served PDF differs from the recorded hash`);
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`✓ ${EDITION.path}: edition and PDF rebuilt from the saved sources, byte for byte (sha256 ${frozen.pdf.sha256}).`);
}

const cmd = process.argv[2];
if (cmd === "freeze") {
  try {
    process.exitCode = await freeze();
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
} else if (cmd === "rebuild") rebuild();
else {
  console.error("Usage: node scripts/reliability-report.mjs freeze [--dry-run] [--dinike-said-freeze <YYYY-MM-DD>] [--origin https://theagentforge.io] [--from-dir <dir> --fetched-at <ISO UTC>] | rebuild");
  process.exit(2);
}
