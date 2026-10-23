// House tester, step 1 of 2 (runs with NO secrets): picks MCP servers from the official registry that need no
// credentials or arguments, starts each with npx in a scratch directory, performs the MCP handshake (initialize +
// tools/list), and writes plain results to results.json. Step 2 (file.mjs) validates them and files House reports.
// Usage:
//   node probe.mjs plan [count]                 → plan.json: the `count` most-downloaded candidates (ADR 0011 b)
//   node probe.mjs run plan.json <shard> <of>   → results.json for one shard of the plan
//   node probe.mjs [count]                      → legacy: a rotating slice of the registry
// MASTER_PLAN §7.2; docs/runbooks/house-tester.md
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REGISTRY = "https://registry.modelcontextprotocol.io";
export const PROBE_TIMEOUT_MS = 75_000;
export const SLOW_MS = 20_000;
export const PROTOCOL = "2025-06-18";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** An npm, stdio package that the registry says needs no required environment variables or arguments. */
export function candidateFrom(entry) {
  const s = entry?.server;
  if (!s?.name) return null;
  if (entry._meta?.["io.modelcontextprotocol.registry/official"]?.status === "deleted") return null;
  const p = (s.packages ?? []).find((x) => (x.registryType ?? x.registry_type) === "npm" && x.identifier);
  if (!p) return null;
  if (p.transport?.type && p.transport.type !== "stdio") return null;
  const required = (xs) => (xs ?? []).some((x) => x.isRequired && x.value === undefined && x.default === undefined);
  if (required(p.environmentVariables) || required(p.packageArguments) || required(p.runtimeArguments)) return null;
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(p.identifier)) return null;
  const version = p.version && /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(p.version) && p.version !== "latest" ? p.version : null;
  return { registryName: s.name, pkg: p.identifier.toLowerCase(), version };
}

async function getJson(u, fetcher, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetcher(u).catch(() => null);
    if (res?.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

/**
 * Today's slice of the registry: skips `dayIndex * 3 % 100` pages so each day covers different servers. The registry
 * sometimes fails deep in its listing; then we keep what we have (or start again from the first page).
 */
export async function pickCandidates(count, dayIndex, fetcher = fetch) {
  const out = [];
  const seen = new Set();
  const skipPages = (dayIndex * 3) % 100;
  for (const skip of [skipPages, 0]) {
    let cursor = null;
    for (let page = 0; out.length < count && page < skip + 40; page++) {
      const u = new URL(`${REGISTRY}/v0.1/servers`);
      u.searchParams.set("version", "latest");
      u.searchParams.set("limit", "100");
      if (cursor) u.searchParams.set("cursor", cursor);
      const data = await getJson(u, fetcher);
      if (!data) break;
      if (page >= skip) {
        for (const e of data.servers ?? []) {
          const c = candidateFrom(e);
          if (c && !seen.has(c.pkg)) {
            seen.add(c.pkg);
            out.push(c);
            if (out.length >= count) break;
          }
        }
      }
      cursor = data.metadata?.nextCursor;
      if (!cursor) break;
    }
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Every candidate in the registry (deduplicated by package), for ranking by popularity. 450 pages of 100 covers the
 * whole registry (about 37,000 entries in Oct 2026); 120 pages only reached the first third.
 */
export async function allCandidates(fetcher = fetch, maxPages = 450) {
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const u = new URL(`${REGISTRY}/v0.1/servers`);
    u.searchParams.set("version", "latest");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const data = await getJson(u, fetcher);
    if (!data) break;
    for (const e of data.servers ?? []) {
      const c = candidateFrom(e);
      if (c && !seen.has(c.pkg)) {
        seen.add(c.pkg);
        out.push(c);
      }
    }
    cursor = data.metadata?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * Last week's npm downloads per package. Unscoped names go 128 at a time through npm's bulk endpoint; scoped names
 * (which the bulk endpoint doesn't accept) one by one. Unknown counts are 0.
 */
export async function weeklyDownloads(pkgs, fetcher = fetch) {
  const out = new Map(pkgs.map((p) => [p, 0]));
  const base = "https://api.npmjs.org/downloads/point/last-week/";
  const plain = pkgs.filter((p) => !p.startsWith("@"));
  const scoped = pkgs.filter((p) => p.startsWith("@"));
  for (let i = 0; i < plain.length; i += 128) {
    const chunk = plain.slice(i, i + 128);
    const data = await getJson(base + chunk.join(","), fetcher);
    if (!data) continue;
    if (chunk.length === 1 && typeof data.downloads === "number") out.set(chunk[0], data.downloads);
    else for (const p of chunk) if (typeof data[p]?.downloads === "number") out.set(p, data[p].downloads);
  }
  await pool(scoped, 8, async (p) => {
    const data = await getJson(base + p, fetcher, 2);
    if (typeof data?.downloads === "number") out.set(p, data.downloads);
  });
  return out;
}

/**
 * Well-known servers people check first but the registry ranking misses: not listed there as npm stdio packages, or
 * needing a start argument (filesystem needs a folder: the scratch directory). Our own data, 22-23 Oct: checks of
 * `@modelcontextprotocol/server-filesystem`, the reference `fetch` server and `context7` found nothing. Each starts
 * with no credentials; one that asks for configuration is skipped (needs_config), never reported as failed.
 */
export const PRIORITY = [
  { pkg: "@modelcontextprotocol/server-filesystem", args: ["."] },
  { pkg: "@modelcontextprotocol/server-memory" },
  { pkg: "@modelcontextprotocol/server-sequential-thinking" },
  { pkg: "@modelcontextprotocol/server-everything" },
  { pkg: "@upstash/context7-mcp" },
  { pkg: "@playwright/mcp" },
  { pkg: "chrome-devtools-mcp" },
  { pkg: "@browsermcp/mcp" },
];

/** The plan with the priority servers first (no duplicates), still at most `count` entries. */
export function withPriority(plan, count, priority = PRIORITY) {
  const first = priority.map((p, i) => ({ registryName: null, pkg: p.pkg, version: null, ...(p.args ? { args: p.args } : {}), priority: i + 1 }));
  const seen = new Set(first.map((p) => p.pkg));
  return [...first, ...plan.filter((c) => !seen.has(c.pkg))].slice(0, count);
}

/** The `count` most-downloaded candidates, busiest first (ties by name, so the plan is stable). */
export function rankTop(candidates, downloads, count) {
  return candidates
    .map((c) => ({ ...c, weeklyDownloads: downloads.get(c.pkg) ?? 0 }))
    .sort((a, b) => b.weeklyDownloads - a.weeklyDownloads || a.pkg.localeCompare(b.pkg))
    .slice(0, count)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/** Shard `shard` (0-based) of `of`: every `of`-th entry, so each shard gets a fair mix of busy and quiet servers. */
export const shardOf = (plan, shard, of) => plan.filter((_, i) => i % of === shard);

/** The exact published version (resolving "latest") and a fingerprint of its tarball (sha256 of npm's integrity). */
export async function npmVersion(pkg, version, fetcher = fetch) {
  const res = await fetcher(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/${version ?? "latest"}`);
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`npm ${res.status}`);
  const meta = await res.json();
  if (!meta.version || !meta.dist?.integrity) throw new Error("npm metadata incomplete");
  return { version: meta.version, fingerprint: `sha256:${sha256(meta.dist.integrity)}` };
}

const NEEDS_CONFIG = /(api[_ -]?key|access[_ -]?token|\btoken\b|credential|unauthori[sz]ed|environment variable|env var|is required|must be set|not set|missing required|usage:|--help)/i;
const INSTALL_FAILED = /(npm (ERR|error)!? code (E404|ETARGET|EINVALIDPACKAGENAME)|404 Not Found|No matching version|notarget)/i;

/**
 * Turns what happened into a report, or null when the honest answer is "can't tell" (the server wants config we
 * didn't give it, or never answered). Only clear results are reported.
 */
export function classify(r) {
  if (r.toolsListed !== undefined) {
    const issues = r.ms > SLOW_MS ? ["slow"] : [];
    return { outcome: "worked", issues, toolCount: r.toolsListed };
  }
  if (r.initialized) return { outcome: "partial", issues: [], toolCount: 0 };
  if (INSTALL_FAILED.test(r.stderr)) return { outcome: "failed", issues: ["install_failed"], toolCount: 0 };
  return null;
}

/** Why there's no report for a result: it asked for configuration, or it never answered the handshake. */
export const skipReason = (r) => (NEEDS_CONFIG.test(r.stderr) ? "needs_config" : "no_answer");

/** Starts one server with npx and speaks just enough MCP to list its tools. */
export function handshake(pkg, version, timeoutMs = PROBE_TIMEOUT_MS, args = []) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "house-"));
    const started = Date.now();
    // Start arguments come only from PRIORITY (constants in this file), never from the registry.
    const child = spawn("npx", ["-y", `${pkg}@${version}`, ...args.filter((x) => typeof x === "string" && /^[\w./-]{1,64}$/.test(x))], {
      cwd: dir,
      // A clean environment: no tokens or secrets reach the server. Proxy settings pass through where they exist.
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CI: "1",
        npm_config_cache: join(dir, ".npm"),
        npm_config_update_notifier: "false",
        ...Object.fromEntries(
          ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]]),
        ),
        ...(process.env.NODE_EXTRA_CA_CERTS ? { npm_config_cafile: process.env.NODE_EXTRA_CA_CERTS } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const result = { initialized: false, toolsListed: undefined, stderr: "", ms: 0, tools: [] };
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      result.ms = Date.now() - started;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      resolve(result);
    };
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const timer = setTimeout(finish, timeoutMs);
    child.stderr.on("data", (d) => {
      if (result.stderr.length < 4000) result.stderr += d.toString();
    });
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          result.initialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          if (msg.result && Array.isArray(msg.result.tools)) {
            result.toolsListed = msg.result.tools.length;
            result.tools = msg.result.tools.map((t) => String(t?.name ?? "")).slice(0, 100);
          }
          clearTimeout(timer);
          finish();
        }
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      setTimeout(finish, 50);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "theagentforge-house-tester", version: "1.0.0" } },
    });
  });
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const item = items[i++];
        out.push(await fn(item));
      }
    }),
  );
  return out;
}

async function probeAll(candidates) {
  return pool(candidates, 4, async (c) => {
    try {
      const v = await npmVersion(c.pkg, c.version);
      if (v.missing) return { ...c, outcome: "skip", why: "not_on_npm" };
      const r = await handshake(c.pkg, v.version, PROBE_TIMEOUT_MS, Array.isArray(c.args) ? c.args : []);
      const verdict = classify(r);
      console.log(`${c.pkg}@${v.version}: ${verdict ? `${verdict.outcome} (${r.toolsListed ?? 0} tools, ${r.ms} ms)` : `skipped (${skipReason(r)})`}`);
      return verdict
        ? { ...c, version: v.version, fingerprint: v.fingerprint, ms: r.ms, ...verdict }
        : { ...c, version: v.version, fingerprint: v.fingerprint, ms: r.ms, outcome: "skip", why: skipReason(r) };
    } catch (e) {
      return { ...c, outcome: "skip", why: "error" };
    }
  });
}

function writeResults(results) {
  writeFileSync("results.json", JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  const by = results.reduce((a, r) => ((a[r.why ?? r.outcome] = (a[r.why ?? r.outcome] ?? 0) + 1), a), {});
  console.log(JSON.stringify(by));
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "plan") {
    const count = Number(rest[0] ?? 500);
    const candidates = await allCandidates();
    const downloads = await weeklyDownloads(candidates.map((c) => c.pkg));
    const plan = withPriority(rankTop(candidates, downloads, count), count);
    writeFileSync("plan.json", JSON.stringify(plan, null, 2));
    console.log(`Planned ${plan.length} of ${candidates.length} candidates`);
    return;
  }
  if (mode === "run") {
    const plan = JSON.parse(readFileSync(rest[0], "utf8"));
    const shard = shardOf(plan, Number(rest[1] ?? 0), Number(rest[2] ?? 1));
    console.log(`Probing ${shard.length} servers`);
    writeResults(await probeAll(shard));
    return;
  }
  const count = Number(mode ?? 40);
  // OFFSET (manual runs only) shifts the slice so an extra run covers servers tonight's run won't.
  const dayIndex = Math.floor(Date.now() / 86_400_000) + 7 * (Number.parseInt(process.env.OFFSET ?? "0", 10) || 0); // 21 pages per offset step
  const candidates = await pickCandidates(count, dayIndex);
  console.log(`Probing ${candidates.length} servers`);
  writeResults(await probeAll(candidates));
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0));
