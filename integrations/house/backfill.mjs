// House tester, tool-history backfill (ADR 0134). Three steps in .github/workflows/house-backfill.yml:
//   node backfill.mjs plan <origin>                → plan.json (no token): asks the site's public, read-only plan for
//                                                    servers whose version list isn't read yet and the next pending
//                                                    versions; reads those version lists (with publish dates) from npm
//                                                    and PyPI, as any installer does
//   node backfill.mjs run plan.json <shard> <of>  → results.json (no secrets): installs each version of this shard
//                                                    with npx/uvx in the House tester's sandbox (probe.mjs) and lists
//                                                    its tools
//   node backfill.mjs file <origin> plan.json results/*/results.json → posts version lists and results (OIDC); runs
//                                                    no third-party code and re-validates everything
// The probe shards run third-party code on their own runners, as the nightly House tester does: no token, no secret,
// no write permission. Like the request-a-test split (ADR 0131 amendment 1), a shard's file is believed only for the
// versions the plan gave that shard, so a package can at worst spoil its own shard's results.
// Package code on a GitHub-hosted runner can still reach that job's artifact token (passwordless sudo, or the
// environment of the later upload step), so it could upload or replace another shard's artifact, or the plan. So each
// shard is its own job (house-backfill-shard.yml) that reports its file's sha256 as a job output, which only that job
// can set, and the plan job reports the plan's: the file job believes only files whose sha256 matches (review, 5 Nov).
// Within a shard, each version runs as its own throwaway OS user (isolate.mjs, amendment 2): it can't rewrite the
// shard's other results, read the job's environment, or leave a process behind for the next version.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { writeResultsFile } from "./isolate.mjs";
import { failIfBroken, pep503, probeOne, versionFromFilename } from "./probe.mjs";
import { batches, houseHeaders, INTERNAL_UA, postReport, TOOL_CAPS, toDescriptions } from "./file.mjs";

export const SINCE = "2025-09-01";
export const SINCE_MS = Date.parse(`${SINCE}T00:00:00.000Z`);
/** Versions per run (the site caps it too), and the shards they're spread over (house-backfill.yml's matrix). */
export const PER_RUN = 1000;
export const SHARDS = 10;
/** The newest stable versions per server (the site applies the same cap and marks the rest over_cap). */
export const MAX_VERSIONS = 150;

const SERVER = /^(npm:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*|pypi:[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?)$/;
const VERSION = /^[0-9][A-Za-z0-9.+_!-]{0,63}$/;
const UA = { "User-Agent": "theagentforge-house-tester (+https://theagentforge.io/reports/house)" };

/** The site's plan, re-validated (it is data): only well-formed npm/PyPI names and exact versions survive. */
export function readPlan(body) {
  const ok = (s) => typeof s?.server === "string" && SERVER.test(s.server) && (s.registry === "npm" || s.registry === "pypi") && s.server === `${s.registry}:${s.package}`;
  return {
    enumerate: (Array.isArray(body?.enumerate) ? body.enumerate : []).filter(ok).slice(0, 1000).map((s) => ({ server: s.server, registry: s.registry, package: s.package })),
    versions: (Array.isArray(body?.versions) ? body.versions : [])
      .filter((v) => ok(v) && typeof v.version === "string" && VERSION.test(v.version))
      .slice(0, PER_RUN)
      .map((v) => ({ server: v.server, registry: v.registry, package: v.package, version: v.version })),
  };
}

/** npm's version list with publish dates (the full document's `time`; versions still in `versions`), since SINCE. */
export async function npmVersions(pkg, fetcher = fetch) {
  const res = await fetcher(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}`, { headers: { Accept: "application/json", ...UA } });
  if (res.status === 404) return { status: "not_found", versions: [] };
  if (!res.ok) throw new Error(`npm ${res.status}`);
  const doc = await res.json();
  const versions = Object.entries(doc.time ?? {})
    .filter(([v, at]) => doc.versions?.[v] && VERSION.test(v) && typeof at === "string" && Date.parse(at) >= SINCE_MS)
    .map(([version, at]) => ({ version, published_at: new Date(Date.parse(at)).toISOString() }));
  return { status: "ok", versions };
}

/** PyPI's version list: each version's earliest non-yanked upload (PEP 691 JSON, as uv reads it), since SINCE. */
export async function pypiVersions(pkg, fetcher = fetch) {
  const name = pep503(pkg);
  const res = await fetcher(`https://pypi.org/simple/${encodeURIComponent(name)}/`, { headers: { Accept: "application/vnd.pypi.simple.v1+json", ...UA } });
  if (res.status === 404) return { status: "not_found", versions: [] };
  if (!res.ok) throw new Error(`pypi ${res.status}`);
  const meta = await res.json();
  const first = new Map();
  for (const f of Array.isArray(meta.files) ? meta.files : []) {
    if (f.yanked || typeof f["upload-time"] !== "string") continue;
    const v = versionFromFilename(f.filename, name);
    const at = Date.parse(f["upload-time"]);
    if (!v || !VERSION.test(v) || !Number.isFinite(at)) continue;
    if (!first.has(v) || at < first.get(v)) first.set(v, at);
  }
  return { status: "ok", versions: [...first].filter(([, at]) => at >= SINCE_MS).map(([version, at]) => ({ version, published_at: new Date(at).toISOString() })) };
}

/** A prerelease (the site's rule, services/tool-history.ts isPrerelease). */
export const isPrerelease = (registry, v) => (registry === "npm" ? v.includes("-") : /\d(a|b|c|rc|alpha|beta|pre|preview)\d*/i.test(v) || /dev\d*/i.test(v));

/** The versions this run should also test from lists it just read: newest stable first, at most MAX_VERSIONS each. */
export function freshVersions(enumerated, room) {
  const out = [];
  for (const s of enumerated) {
    if (s.status !== "ok") continue;
    const stable = s.versions.filter((v) => !isPrerelease(s.registry, v.version)).sort((a, b) => b.published_at.localeCompare(a.published_at));
    for (const v of stable.slice(0, MAX_VERSIONS).reverse()) out.push({ server: s.server, registry: s.registry, package: s.package, version: v.version });
  }
  return out.slice(0, Math.max(0, room));
}

/** Shard `shard` of `of`: every `of`-th version, so a server's versions spread over shards (a fair mix of slow ones). */
export const shardOf = (versions, shard, of) => versions.filter((_, i) => i % of === shard);

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) out.push(await fn(items[i++]));
    }),
  );
  return out;
}

/** One version, probed exactly as the nightly House tester probes a server (probe.mjs probeOne: same sandbox). */
export async function probeVersion(v, probe = probeOne) {
  const c = { pkg: v.package, version: v.version, ...(v.registry === "pypi" ? { registry: "pypi" } : {}) };
  try {
    const r = await probe(c);
    // probeOne pins c.version; a registry answering with another version is not this version's result.
    if (r.version !== undefined && r.version !== v.version) return { server: v.server, version: v.version, outcome: "error" };
    const outcome = r.outcome === "skip" ? r.why : r.outcome;
    return { server: v.server, version: v.version, outcome, tools_count: Number.isInteger(r.toolCount) ? r.toolCount : null, tools: Array.isArray(r.tools) ? r.tools : null };
  } catch {
    return { server: v.server, version: v.version, outcome: "error" };
  }
}

const OUTCOMES = new Set(["worked", "partial", "failed", "no_answer", "needs_config", "not_on_npm", "not_on_pypi", "no_command", "error"]);

/** One shard result, re-validated (the shard ran untrusted code), or null. Tools are capped as file.mjs caps them. */
export function toResult(r) {
  if (!r || !SERVER.test(r.server ?? "") || !VERSION.test(r.version ?? "") || !OUTCOMES.has(r.outcome)) return null;
  const registry = r.server.startsWith("pypi:") ? "pypi" : "npm";
  const desc = r.outcome === "worked" ? toDescriptions({ outcome: "worked", ...(registry === "pypi" ? { registry } : {}), pkg: r.server.slice(registry.length + 1), version: r.version, tools: r.tools }, TOOL_CAPS) : null;
  const n = Number.isInteger(r.tools_count) && r.tools_count >= 0 && r.tools_count < 10_000 ? r.tools_count : null;
  return { server: r.server, version: r.version, outcome: r.outcome, tools_count: r.outcome === "worked" || r.outcome === "partial" ? n : null, tools: desc ? desc.tools : null };
}

/** The shard a results file came from (artifact house-backfill-results-<n>, n written without leading zeros), or null. */
export const shardOfFile = (f) => {
  const m = /(?:^|[\\/])house-backfill-results-(0|[1-9]\d?)[\\/]results\.json$/.exec(String(f));
  return m ? Number(m[1]) : null;
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The sha256 each shard's own job reported (house-backfill.yml passes the file job `toJSON(needs)`): shard n's is
 * needs["shard-<n>"].outputs.results_sha, or null when that job reported none (it died) or something malformed.
 */
export function shardHashes(needsJson, of = SHARDS) {
  let needs;
  try {
    needs = JSON.parse(needsJson ?? "");
  } catch {
    needs = null;
  }
  return Array.from({ length: of }, (_, n) => {
    const h = needs?.[`shard-${n}`]?.outputs?.results_sha;
    return typeof h === "string" && HEX64.test(h) ? h : null;
  });
}

/**
 * The results files to believe: one per shard, at results/house-backfill-results-<n>/results.json, whose sha256 is the
 * one shard n's own job reported. A file another job uploaded under that shard's name doesn't match and is dropped;
 * `tampered` lists those shards (their versions aren't counted as offered, so a bad shard can't close them).
 */
export function verifiedFiles(files, expected, read = (f) => readFileSync(f), of = SHARDS) {
  const ok = [];
  const tampered = [];
  const seen = new Set();
  for (const f of files) {
    const shard = shardOfFile(f);
    if (shard === null || shard >= of || seen.has(shard)) continue;
    seen.add(shard);
    let bytes;
    try {
      bytes = read(f);
    } catch {
      continue;
    }
    if (expected[shard] && sha256(bytes) === expected[shard]) ok.push(f);
    else tampered.push(shard);
  }
  return { files: ok, tampered };
}

/**
 * Results from every shard, each file believed only for the versions the plan gave its shard (ADR 0131 amendment 1's
 * split, applied per shard), first answer per version wins.
 */
export function mergeShardResults(plan, files, read = (f) => readFileSync(f, "utf8"), of = SHARDS) {
  const out = new Map();
  const seen = new Set();
  for (const f of files) {
    const shard = shardOfFile(f);
    if (shard === null || shard >= of || seen.has(shard)) continue;
    seen.add(shard);
    const mine = new Set(shardOf(plan.versions, shard, of).map((v) => `${v.server}@${v.version}`));
    let data;
    try {
      data = JSON.parse(read(f));
    } catch {
      continue;
    }
    for (const raw of Array.isArray(data?.results) ? data.results : []) {
      const r = toResult(raw);
      const key = r && `${r.server}@${r.version}`;
      if (r && mine.has(key) && !out.has(key)) out.set(key, r);
    }
  }
  return [...out.values()];
}

/** Version lists from plan.json, re-validated: only servers the site asked for, versions well-formed and dated. */
export function enumeratedFor(plan) {
  const asked = new Set(plan.enumerate.map((s) => s.server));
  return (Array.isArray(plan.enumerated) ? plan.enumerated : [])
    .filter((s) => asked.has(s.server) && (s.status === "ok" || s.status === "not_found"))
    .map((s) => ({
      server: s.server,
      status: s.status,
      versions: (Array.isArray(s.versions) ? s.versions : []).filter((v) => VERSION.test(v?.version ?? "") && !Number.isNaN(Date.parse(v?.published_at ?? ""))).slice(0, 5000),
    }));
}

async function oidcToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("No GitHub OIDC token available (the job needs permissions: id-token: write).");
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`OIDC token request failed (${res.status}).`);
  return (await res.json()).value;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "plan") {
    const origin = rest[0];
    if (!/^https:\/\/[a-z0-9.-]+$/.test(origin ?? "")) throw new Error("usage: node backfill.mjs plan https://theagentforge.io");
    const res = await fetch(`${origin}/api/v1/house/backfill/plan?limit=${PER_RUN}`, { headers: { Accept: "application/json", "User-Agent": INTERNAL_UA, "X-Forge-Internal": "house" } });
    if (!res.ok) throw new Error(`plan ${res.status}`);
    const plan = readPlan(await res.json());
    const enumerated = await pool(plan.enumerate, 8, async (s) => {
      try {
        return { ...s, ...(await (s.registry === "pypi" ? pypiVersions(s.package) : npmVersions(s.package))) };
      } catch (e) {
        console.log(`${s.server}: version list not read (${e.message}); asked again next run`);
        return null;
      }
    });
    const lists = enumerated.filter(Boolean);
    // Versions from lists read just now ride along tonight (the file step queues them before posting results).
    const queued = new Set(plan.versions.map((v) => `${v.server}@${v.version}`));
    const extra = freshVersions(lists, PER_RUN - plan.versions.length).filter((v) => !queued.has(`${v.server}@${v.version}`));
    const out = { enumerate: plan.enumerate, enumerated: lists, versions: [...plan.versions, ...extra] };
    writeFileSync("plan.json", JSON.stringify(out));
    console.log(`Backfill plan: ${lists.length} of ${plan.enumerate.length} version lists read; ${out.versions.length} versions (${plan.versions.length} queued, ${extra.length} new)`);
    return;
  }
  if (mode === "run") {
    const plan = JSON.parse(readFileSync(rest[0], "utf8"));
    const mine = shardOf(readPlan(plan).versions, Number(rest[1] ?? 0), Number(rest[2] ?? SHARDS));
    console.log(`Probing ${mine.length} versions`);
    const results = await pool(mine, 4, (v) => probeVersion(v));
    // Written by this (runner-user) process only, mode 600, in a folder no probe user can open (ADR 0134 amendment 2).
    writeResultsFile("results.json", JSON.stringify({ probedAt: new Date().toISOString(), results }));
    failIfBroken();
    const by = results.reduce((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {});
    console.log(JSON.stringify(by));
    return;
  }
  if (mode === "file") {
    const [origin, planFile, ...files] = rest;
    if (!/^https:\/\/[a-z0-9.-]+$/.test(origin ?? "")) throw new Error("usage: node backfill.mjs file https://theagentforge.io plan.json results/*/results.json");
    // The plan job's and each shard job's own sha256 (job outputs no other job can set): a swapped plan stops the run,
    // a swapped shard file is dropped.
    const planSha = process.env.PLAN_SHA ?? "";
    if (!HEX64.test(planSha) || !process.env.NEEDS) throw new Error("file needs PLAN_SHA and NEEDS from house-backfill.yml");
    const planBytes = readFileSync(planFile);
    if (sha256(planBytes) !== planSha) throw new Error("plan.json is not the file the plan job wrote; nothing filed");
    const raw = JSON.parse(planBytes.toString("utf8"));
    const plan = { ...readPlan(raw), enumerated: raw.enumerated };
    const lists = enumeratedFor(plan);
    const checked = verifiedFiles(files, shardHashes(process.env.NEEDS));
    for (const n of checked.tampered) console.log(`::warning::Shard ${n}: results file doesn't match the sha256 its own job reported; ignored, its versions stay pending`);
    const results = mergeShardResults(plan, checked.files);
    const probedAt = new Date().toISOString();
    let token = await oidcToken(origin);
    let tokenAt = Date.now();
    const fresh = async () => {
      if (Date.now() - tokenAt > 4 * 60_000) [token, tokenAt] = [await oidcToken(origin), Date.now()];
      return token;
    };
    const post = async (path, body) => {
      const res = await postReport(`${origin}${path}`, { method: "POST", headers: houseHeaders(await fresh()), body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    // 1. Version lists first, so tonight's new versions are queued before their results arrive.
    let queued = 0;
    for (const group of batches(lists, 25)) {
      const r = await post("/api/v1/house/backfill/versions", { servers: group });
      if (r.status >= 300) console.log(`Version lists: ${r.status} ${r.body.detail ?? ""}`);
      queued += Number(r.body.queued) || 0;
    }
    // 2. Results, a few at a time (each may carry up to 64 KB of tool text).
    let stored = 0;
    let failed = 0;
    for (const group of batches(results, 10)) {
      const r = await post("/api/v1/house/backfill/results", { probed_at: probedAt, results: group });
      if (r.status >= 300) console.log(`Results: ${r.status} ${r.body.detail ?? ""}`);
      stored += Number(r.body.stored) || 0;
      failed += Number(r.body.failed) || 0;
    }
    // 3. Last: every version offered tonight, so one with no answer (its shard died) counts an attempt.
    // A shard whose file was swapped isn't counted (another job's doing must not close its versions as test_error).
    const bad = new Set(checked.tampered);
    const offered = plan.versions.filter((_, i) => !bad.has(i % SHARDS)).map((v) => ({ server: v.server, version: v.version }));
    const done = offered.length ? await post("/api/v1/house/backfill/results", { probed_at: probedAt, results: [], offered }) : { status: 0, body: {} };
    const summary = `### Tool-history backfill\n\n${lists.length} version lists sent (${queued} versions queued); ${results.length} of ${offered.length} offered versions answered: ${stored} tool sets stored, ${failed} didn't start; ${Number(done.body.closed_unanswered) || 0} closed after ${3} unanswered offers.\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    return;
  }
  throw new Error("usage: node backfill.mjs plan|run|file …");
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
