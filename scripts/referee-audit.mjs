#!/usr/bin/env node
// The referee audit (ADR 0136): re-grades a reproducible, stratified random sample of public ranked Arena replays with
// an independent end-state checker and reports agreement with the published trap verdicts. Code only, no LLM grading.
//
// Usage (from the repo root, Node 22.7+; no install needed beyond the repo):
//   node scripts/referee-audit.mjs [--origin https://theagentforge.io] [--cache dir] [--out file.json]
//                                  [--adjudications file.json] [--date YYYY-MM-DD]
//                                  [--census] [--audit-id referee-audit-2] [--also-rules "rules 0.7"] [--frame-source text]
//
// The frame is read from the public files: /arena/dataset.json lists the ranked events, each event's
// /arena/events/<slug>.json lists its runs and the traps the referee marked; each sampled run's replay is
// /arena/run/<id>.json. With --cache, every fetched file is kept there (frame.json, runs/<id>.json) and read from
// there next time, so a run can be repeated offline. The frozen result for audit 1 is
// apps/forge/src/seed/validity/referee-audit-1.json; re-running against the same frame reproduces its figures.
// Audit 2 (ADR 0136 Amendment 1) is the census: `--census --audit-id referee-audit-2 --also-rules "rules 0.7"` re-grades
// every run in the frame (no sample) and also runs the prepared rules 0.7 referee (ADR 0140) on each replay.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 2);
}
const HOOK = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(spec, ctx, next) {
  if (/^\\.\\.?\\//.test(spec) && ctx.parentURL?.endsWith(".ts") && !/\\.[cm]?[jt]s$/.test(spec)) {
    for (const s of [spec + ".ts", spec + "/index.ts"]) {
      const u = new URL(s, ctx.parentURL);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
  }
  return next(spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`);
const { runAudit } = await import(new URL("../packages/arena/src/audit/audit.ts", import.meta.url).href);

const args = process.argv.slice(2);
const opt = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const origin = (opt("--origin") ?? "https://theagentforge.io").replace(/\/$/, "");
const cache = opt("--cache");
const out = opt("--out");
const date = opt("--date") ?? new Date().toISOString().slice(0, 10);
const adjudications = opt("--adjudications") ? JSON.parse(readFileSync(opt("--adjudications"), "utf8")) : [];
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const RANKED = new Set(["card", "guest"]);
const census = args.includes("--census");
const auditId = opt("--audit-id") ?? (census ? "referee-audit-2" : "referee-audit-1");
const alsoRules = opt("--also-rules") ? opt("--also-rules").split(",").map((x) => x.trim()) : [];

async function getJson(path, cacheName) {
  const file = cache && cacheName ? join(cache, cacheName) : null;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(`${origin}${path}`, { headers: { Accept: "application/json", "User-Agent": "forge-referee-audit/1" } });
  if (!res.ok) throw new Error(`${origin}${path} answered ${res.status}`);
  const body = await res.json();
  if (file) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  }
  return body;
}

// The frame: every run of every ranked public event, with the traps the referee marked (public trap ids).
let frame;
if (cache && existsSync(join(cache, "frame.json"))) frame = JSON.parse(readFileSync(join(cache, "frame.json"), "utf8"));
else {
  const index = await getJson("/arena/dataset.json", null);
  frame = [];
  for (const e of index.events.filter((x) => RANKED.has(x.kind))) {
    const ev = await getJson(`/arena/events/${e.slug}.json`, null);
    for (const r of ev.runs) frame.push({ run: r.run, task: r.task, sprung: [...(r.traps_fell ?? [])].sort(), ...(r.model ? { model: r.model } : {}), event: e.slug });
  }
  if (cache) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "frame.json"), JSON.stringify(frame));
  }
}

const { drawSample } = await import(new URL("../packages/arena/src/audit/sample.ts", import.meta.url).href);
const docs = new Map();
for (const s of census ? frame : drawSample(frame)) {
  const d = await getJson(`/arena/run/${s.run}.json`, `runs/${s.run}.json`);
  const start = Array.isArray(d.log) ? d.log[0] : null;
  docs.set(s.run, { id: d.id, task: d.task, seed: start?.seed ?? d.result?.seed, log: d.log, result: d.result });
}

let commit = null;
try {
  commit = execFileSync("git", ["log", "-1", "--format=%H", "--", "packages/arena/src/audit/checkers.ts", "packages/arena/src/audit/claims.ts"], { encoding: "utf8" }).trim() || null;
} catch {
  commit = null;
}
const result = runAudit(frame, docs, { origin, date, sha256Hex, frameSource: opt("--frame-source") ?? `${origin}/arena/dataset.json (ranked events) and /arena/events/<slug>.json`, checkerCommit: commit, adjudications, auditId, design: census ? "census" : "sample", alsoUnderRules: alsoRules });
const text = `${JSON.stringify(result, null, 1)}\n`;
if (out) writeFileSync(out, text);
const o = result.overall;
console.log(`Referee audit (${auditId}): ${o.agree} of ${o.n} trap verdicts agree (${o.agreement}, 95% CI ${o.ci_95?.join("-")}), ${result.sample.runs} runs ${census ? "(census)" : "sampled"} from ${result.frame.runs}.`);
for (const [rules, t] of Object.entries(result.referee_under_rules ?? {})) console.log(`Under ${rules} (prepared, not in force): ${t.agree} of ${t.n} agree.`);
console.log(`Referee-sprung traps the checker also finds: ${result.referee_sprung.checker_agrees} of ${result.referee_sprung.n}. Disagreements: ${result.disagreements.length}. Not covered: ${result.coverage.not_covered.length}.`);
for (const d of result.disagreements) console.log(`  ${d.replay_url} ${d.task}/${d.trap}: published ${d.published}, checker ${d.checker}, current referee ${d.current_referee}${d.resolution ? ` -> ${d.resolution.outcome}` : " (unresolved)"}`);
process.exit(result.disagreements.some((d) => !d.resolution) ? 1 : 0);
