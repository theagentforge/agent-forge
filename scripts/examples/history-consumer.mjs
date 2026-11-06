#!/usr/bin/env node
// Sample consumer of The Agent Forge server-history API (contract forge.server-history/v1, ADR 0141).
//
// Fetches one MCP server's dated record, checks the contract it answers with, follows the `next` links of the changes
// section, and prints the per-family install summary and the change events between consecutive versions.
// Node 18+ (global fetch), no dependencies.
//
//   node scripts/examples/history-consumer.mjs npm:@modelcontextprotocol/server-filesystem
//   node scripts/examples/history-consumer.mjs pypi:mcp-server-git --origin https://staging.theagentforge.io --json
//
// Exit codes: 0 ok (measured or not yet measured), 1 request failed, 2 unexpected contract, 64 usage.

import { pathToFileURL } from "node:url";

export const CONTRACT = "forge.server-history/v1";
export const MAJOR = 1;
export const DEFAULT_ORIGIN = "https://theagentforge.io";
/** Pages of change events followed at most (each up to 200 rows). */
export const MAX_PAGES = 50;

/** Null when the body is a v1 answer this script understands, or the reason it isn't. */
export function contractProblem(body) {
  if (!body || typeof body !== "object") return "not a JSON object";
  if (body.contract !== CONTRACT) return `contract is ${JSON.stringify(body.contract)}, expected ${CONTRACT}`;
  const major = Number(String(body.contract_version ?? "").split(".")[0]);
  if (major !== MAJOR) return `contract_version ${JSON.stringify(body.contract_version)} is not ${MAJOR}.x`;
  for (const k of ["server", "status", "data_as_of"]) if (!(k in body)) return `missing field ${k}`;
  return null;
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : "date unknown");

/** One line per change event (newest first, as served). Pure. */
export function formatChange(e) {
  const classes = e.change_classes?.length ? e.change_classes.join("+") : "no change";
  const flags = [e.major_bump ? "major bump" : null, e.zero_major ? "0.x" : null, e.same_version ? "same version" : null, e.untested_between ? `${e.untested_between} untested between` : null].filter(Boolean);
  const counts = `+${e.tools_added} -${e.tools_removed} ~${e.descriptions_changed} desc ~${e.schemas_changed} schema`;
  const rules = e.new_rule_ids?.length ? ` new rule ids: ${e.new_rule_ids.join(", ")}` : "";
  return `${e.from_version} (${day(e.from_published_at)}) -> ${e.to_version} (${day(e.to_published_at)}): ${classes} [${counts}]${flags.length ? ` (${flags.join(", ")})` : ""}${rules}`;
}

/** The summary lines for each install family, kept apart (the contract never adds families together). Pure. */
export function formatFamilies(families = {}) {
  return Object.entries(families).map(([name, f]) =>
    f.status === "measured"
      ? `${name}: ${f.installed} of ${f.tested} tests installed, ${f.first_date} to ${f.last_date}`
      : `${name}: ${f.status.replace(/_/g, " ")}${f.pending ? ` (${f.pending} versions queued)` : ""}`,
  );
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "forge-history-consumer/1" } });
  if (!res.ok) {
    const err = new Error(`GET ${url}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Fetches the record and every page of change events. Returns { body, changes } or throws (err.contract on a bad contract). */
export async function fetchHistory(server, { origin = DEFAULT_ORIGIN, fetchImpl = fetch } = {}) {
  const base = origin.replace(/\/+$/, "");
  const body = await getJson(`${base}/api/v1/history/${encodeURIComponent(server)}`, fetchImpl);
  const problem = contractProblem(body);
  if (problem) {
    const err = new Error(`unexpected contract: ${problem}`);
    err.contract = true;
    throw err;
  }
  const changes = [...(body.changes?.items ?? [])];
  let next = body.changes?.next ?? null;
  for (let pages = 0; next && pages < MAX_PAGES; pages++) {
    // Only follow links on the same site.
    if (new URL(next).origin !== new URL(base).origin) break;
    const more = await getJson(next, fetchImpl);
    const p = contractProblem(more);
    if (p) {
      const err = new Error(`unexpected contract on a later page: ${p}`);
      err.contract = true;
      throw err;
    }
    changes.push(...(more.changes?.items ?? []));
    next = more.changes?.next ?? null;
  }
  return { body, changes };
}

/** The printed report. Pure. */
export function report({ body, changes }) {
  const lines = [`${body.server}: ${body.status.replace(/_/g, " ")} (contract ${body.contract} ${body.contract_version}, data as of ${body.data_as_of ?? "none"})`];
  if (body.install_outcomes) lines.push("Install outcomes by family:", ...formatFamilies(body.install_outcomes.families).map((l) => `  ${l}`));
  if (body.definitions) lines.push(`Tool-definition sets: ${body.definitions.total} across ${body.definitions.versions} versions`);
  const changed = changes.filter((e) => e.change_classes?.length);
  lines.push(`Change events: ${changed.length} of ${changes.length} consecutive pairs${body.changes?.status === "not_yet_computed" ? " (not yet computed)" : ""}`);
  for (const e of changed) lines.push(`  ${formatChange(e)}`);
  return lines.join("\n");
}

export async function main(argv, { fetchImpl = fetch, out = console.log, errOut = console.error } = {}) {
  const args = [...argv];
  const json = args.includes("--json");
  const at = args.indexOf("--origin");
  const origin = at >= 0 ? args[at + 1] : DEFAULT_ORIGIN;
  const server = args.filter((a, i) => !a.startsWith("--") && !(at >= 0 && i === at + 1))[0];
  if (!server || !origin) {
    errOut("usage: node scripts/examples/history-consumer.mjs <npm:name | pypi:name> [--origin URL] [--json]");
    return 64;
  }
  try {
    const r = await fetchHistory(server, { origin, fetchImpl });
    out(json ? JSON.stringify({ server: r.body.server, status: r.body.status, data_as_of: r.body.data_as_of, contract_version: r.body.contract_version, changes: r.changes }, null, 2) : report(r));
    return 0;
  } catch (e) {
    errOut(String(e.message ?? e));
    return e.contract ? 2 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
