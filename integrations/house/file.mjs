// House tester, step 2 of 2 (runs WITHOUT having run any untrusted code): validates results.json from step 1 and files
// one House report per clear result, authenticated with this job's GitHub OIDC token (no stored secret).
// It also sends the whole night's results (reported or not) for the public Forge House Report (ADR 0011 b).
// Usage: node file.mjs <origin> [results files…]   (default results.json)
import { appendFileSync, readFileSync } from "node:fs";

const OUTCOMES = new Set(["worked", "partial", "failed"]);
const PKG = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const FP = /^sha256:[0-9a-f]{64}$/;

/** Builds the field report for one probe result, or null if the result doesn't look exactly as step 1 writes it. */
export function toReport(r) {
  if (!r || !OUTCOMES.has(r.outcome) || !PKG.test(r.pkg ?? "") || !VERSION.test(r.version ?? "") || !FP.test(r.fingerprint ?? "")) return null;
  const issues = Array.isArray(r.issues) ? r.issues.filter((i) => i === "slow" || i === "install_failed") : [];
  const n = Number.isInteger(r.toolCount) && r.toolCount >= 0 && r.toolCount < 10_000 ? r.toolCount : 0;
  const secs = Math.max(1, Math.round((Number(r.ms) || 0) / 1000));
  const note =
    r.outcome === "worked"
      ? `House handshake test: started with npx, no credentials, and listed ${n} tool${n === 1 ? "" : "s"} in ${secs}s.`
      : r.outcome === "partial"
        ? `House handshake test: started and answered initialize, but tools/list failed.`
        : `House handshake test: npx could not install this version.`;
  return {
    tool: { kind: "mcp_server", id: `npm:${r.pkg}`, version: r.version, fingerprint: r.fingerprint },
    task: { category: "mcp-handshake", framework: "other" },
    outcome: r.outcome,
    issues,
    note,
  };
}

const WHY = new Set(["needs_config", "no_answer", "not_on_npm", "error"]);

/** One row of the House Report, re-validated (step 1 ran untrusted code), or null. */
export function toRunEntry(r) {
  if (!r || !PKG.test(r.pkg ?? "")) return null;
  const outcome = OUTCOMES.has(r.outcome) ? r.outcome : r.outcome === "skip" && WHY.has(r.why) ? r.why : null;
  if (!outcome) return null;
  const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
  return {
    pkg: r.pkg,
    version: VERSION.test(r.version ?? "") ? r.version : null,
    outcome,
    slow: Array.isArray(r.issues) && r.issues.includes("slow"),
    tools: OUTCOMES.has(r.outcome) ? int(r.toolCount, 9_999) : null,
    ms: int(r.ms, 600_000),
    downloads: int(r.weeklyDownloads, 1e12),
    rank: int(r.rank, 10_000),
  };
}

/** Results from every shard, deduplicated by package. */
export function mergeResults(files, read = (f) => readFileSync(f, "utf8")) {
  const by = new Map();
  let probedAt = null;
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(read(f));
    } catch {
      continue;
    }
    if (typeof data?.probedAt === "string" && (!probedAt || data.probedAt > probedAt)) probedAt = data.probedAt;
    for (const r of Array.isArray(data?.results) ? data.results : []) if (r?.pkg && !by.has(r.pkg)) by.set(r.pkg, r);
  }
  return { probedAt, results: [...by.values()] };
}

async function oidcToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("No GitHub OIDC token available (the job needs permissions: id-token: write).");
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`OIDC token request failed (${res.status}).`);
  return (await res.json()).value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POSTs a report, waiting and retrying when the site says "too many requests" (429). */
export async function postReport(url, init, { fetcher = fetch, waits = [30_000, 60_000, 90_000], wait = sleep } = {}) {
  let res = await fetcher(url, init);
  for (const ms of waits) {
    if (res.status !== 429) break;
    await wait(ms);
    res = await fetcher(url, init);
  }
  return res;
}

async function main() {
  const [origin, ...files] = process.argv.slice(2);
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin ?? "")) throw new Error("usage: node file.mjs https://theagentforge.io [results.json…]");
  const { probedAt, results } = mergeResults(files.length ? files : ["results.json"]);
  const reports = results.map(toReport).filter(Boolean).slice(0, 600);
  let token = await oidcToken(origin);
  let tokenAt = Date.now();
  const fresh = async () => {
    if (Date.now() - tokenAt > 4 * 60_000) [token, tokenAt] = [await oidcToken(origin), Date.now()];
    return token;
  };
  const lines = [];
  for (const rep of reports) {
    const res = await postReport(`${origin}/api/v1/house/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await fresh()}`, "Content-Type": "application/json", "User-Agent": "theagentforge-house-tester" },
      body: JSON.stringify(rep),
    });
    const body = await res.json().catch(() => ({}));
    if (body.duplicate) continue; // already reported this exact version; no need to wait either
    lines.push(`| ${rep.tool.id}@${rep.tool.version} | ${rep.outcome} | ${res.status} ${body.reason ?? ""} |`);
    console.log(lines.at(-1));
    await sleep(7_000); // stays under the 10-reports-a-minute limit per person
  }
  const entries = results.map(toRunEntry).filter(Boolean).slice(0, 1000);
  const run = await fetch(`${origin}/api/v1/house/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await fresh()}`, "Content-Type": "application/json", "User-Agent": "theagentforge-house-tester" },
    body: JSON.stringify({ probedAt: probedAt ?? new Date().toISOString(), entries }),
  });
  console.log(`House Report run: ${run.status} (${entries.length} servers)`);
  const summary = `### House tester\n\n${entries.length} servers tested; ${lines.length} new reports filed to ${origin}; House Report upload ${run.status}.\n\n| Tool | Outcome | Result |\n|---|---|---|\n${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!run.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
