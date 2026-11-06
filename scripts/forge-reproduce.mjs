#!/usr/bin/env node
// One-command reproducibility (ADR 0136): `pnpm forge:reproduce <run-id | replay URL | file.json>`.
// Works from a fresh clone of the public repo (theagentforge/agent-forge) with Node 22.7 or later; nothing to install.
//
// For one published Arena replay it: fetches /arena/run/<id>.json; rebuilds the job's world from its task version and
// seed and checks the world and every tool output match the replay byte for byte (canonical JSON, timestamps aside);
// re-runs the open referee on the recorded trace and checks the verdict is identical; checks the hash chain and the
// Ed25519 signature against /.well-known/forge-keys.json (format v2; format v1 runs carry a server-only signature,
// which it says). It states that model outputs vary between runs and prints the 3-of-3 consistency figures for the
// run's model, job and seed from the event's public file.
//
//   pnpm forge:reproduce 0a1b2c3d-...            (theagentforge.io)
//   pnpm forge:reproduce <id> --origin https://staging.theagentforge.io
//   pnpm forge:reproduce ./replay.json --keys ./forge-keys.json   (offline)
//   add --json for the full report as JSON
// Exit code: 0 reproduced (format v2 signature checked), 3 reproduced but the signature couldn't be checked (format v1,
// or no key available),
// 1 a check failed, 2 couldn't check.

import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
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
const { reproduce, consistencyOf } = await import(new URL("../packages/arena/src/audit/reproduce.ts", import.meta.url).href);

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !["--origin", "--keys"].includes(args[i - 1]));
const target = positional[0];
const asJson = args.includes("--json");
if (!target) {
  console.error("Usage: pnpm forge:reproduce <run-id | replay URL | file.json> [--origin https://theagentforge.io] [--keys forge-keys.json] [--json]");
  process.exit(2);
}
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const get = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "forge-reproduce/1" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

let origin = (opt("--origin") ?? "https://theagentforge.io").replace(/\/$/, "");
let doc;
try {
  if (existsSync(target)) doc = JSON.parse(readFileSync(target, "utf8"));
  else if (/^https:\/\//.test(target)) {
    origin = new URL(target).origin;
    doc = await get(target.endsWith(".json") ? target : `${target}.json`);
  } else if (/^[A-Za-z0-9_-]+$/.test(target)) doc = await get(`${origin}/arena/run/${target}.json`);
  else throw new Error(`${target} is not a run id, an https address or a file`);
} catch (e) {
  console.error(`Couldn't load the replay: ${e.message}`);
  process.exit(2);
}

// Keys: a file given with --keys, else the site's published key set.
let keys = new Map();
try {
  const set = opt("--keys") ? JSON.parse(readFileSync(opt("--keys"), "utf8")) : await get(`${origin}/.well-known/forge-keys.json`);
  for (const k of set.keys ?? []) keys.set(k.kid, k.x);
} catch {
  keys = new Map();
}
const verifySig = (kid, message, signature) => {
  const x = keys.get(kid);
  if (!x) return null;
  try {
    return verify(null, Buffer.from(message, "utf8"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(signature.replace(/^ed25519:/, ""), "base64url"));
  } catch {
    return false;
  }
};

// Variance: the run's own model, job and seed across its event's attempts, plus the whole event.
let consistency = null;
if (typeof doc.event === "string") {
  try {
    const ev = await get(`${origin}/arena/events/${doc.event}.json`);
    const rows = ev.runs.map((r) => ({ model: r.model, task: r.task, seed: r.seed, passed: r.passed, traps: r.traps_fell ?? [] }));
    const start = Array.isArray(doc.log) ? doc.log[0] : null;
    const mine = rows.filter((r) => r.model === doc.model && r.task === doc.task && r.seed === start?.seed);
    consistency = {
      source: `${origin}/arena/events/${doc.event}.json`,
      this_model_job_seed: { attempts: mine.length, passed: mine.filter((r) => r.passed).length },
      event: consistencyOf(rows),
    };
  } catch {
    consistency = null;
  }
}

const r = await reproduce(doc, sha, keys.size ? verifySig : null, consistency);
if (asJson) console.log(JSON.stringify(r, null, 1));
else {
  const yes = (b) => (b === true ? "yes" : b === false ? "NO" : "not checked");
  console.log(`Run ${r.run_id} · ${r.task} · seed ${r.seed}${r.task_version ? ` · ${r.task_version}` : ""}`);
  console.log(`World and tool outputs identical to the replay (${r.world.events_compared} events): ${yes(r.world.identical)}${r.world.why ? ` (${r.world.why})` : ""}`);
  console.log(`Referee re-run on the recorded trace gives the identical verdict: ${yes(r.referee.identical_verdict)} (published ${r.referee.published.passed ? "pass" : "fail"}/${r.referee.published.reason}, recomputed ${r.referee.recomputed.passed ? "pass" : "fail"}/${r.referee.recomputed.reason}; referee ${r.referee.rules_here}, run scored under ${r.referee.rules_of_run ?? "unstamped rules"})`);
  console.log(`Signature: format v${r.signature.format ?? "?"}, chain ${r.signature.chain}, record ${r.signature.record}, signature ${r.signature.signature}${r.signature.note ? `. ${r.signature.note}` : ""}`);
  for (const p of r.problems) console.log(`  problem: ${p}`);
  console.log(`Model variance: ${r.model_variance.note}`);
  if (consistency) {
    const e = consistency.event;
    console.log(`  This model, job and seed in its event: ${consistency.this_model_job_seed.passed} of ${consistency.this_model_job_seed.attempts} attempts passed.`);
    console.log(`  Whole event: ${e.same_pass_fail_on_every_attempt} of ${e.groups} model-job-seed groups reached the same pass/fail on all 3 attempts (${e.same_verdict_and_traps_on_every_attempt} also the same traps). Source: ${consistency.source}`);
  }
  console.log(`Status: ${r.status}`);
}
process.exit({ reproduced: 0, reproduced_signature_not_checked: 3, reproduced_signature_not_public: 3, failed: 1, unable: 2 }[r.status]);
