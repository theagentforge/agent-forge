// The Agent Forge plugin for Claude Code: hooks/pre-install.mjs
// PreToolUse (Bash): before an install command runs, look the package up at <origin>/api/v1/check.
// Built (bundled, not minified) from integrations/claude-code-plugin/src/hooks/pre-install.ts and packages/shared/src in
// https://github.com/theagentforge/agent-forge. Self-contained: Node built-ins only, no packages installed or
// downloaded. Fails open. What it reads, writes and sends: README.md and REVIEWERS.md in this plugin.

// ../../packages/shared/src/scoring.ts
var DAY_MS = 864e5;
var SCORE_WINDOW_MS = 180 * DAY_MS;
var FLAG_WINDOW_MS = 30 * DAY_MS;
var MIN_OWNERS_FOR_SCORE = 5;

// ../../packages/shared/src/verdict.ts
var advisoryIdOf = (c) => c.public_signals_summary?.advisories.find((a) => a.kind === "malicious")?.id ?? c.public_signals_summary?.advisories[0]?.id ?? null;
var PUNCH = {
  clear: "[F\u2713]",
  caution: "[F!]",
  flagged: "[F\u2691]",
  confirmed_malicious: "[F\u2715]",
  insufficient: "[F\u2013]"
};
var VERDICT_WORD = {
  clear: "clear",
  caution: "caution",
  flagged: "flagged",
  confirmed_malicious: "confirmed malicious",
  insufficient: "not enough reports yet"
};
function displayVerdict(c) {
  if (c.security_status === "unknown") return "insufficient";
  if (c.security_status !== "clear") return c.security_status;
  return c.forge_score === null ? "insufficient" : "clear";
}
var plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function verdictLine(c) {
  const v = displayVerdict(c);
  const subject = c.tool ? `${c.tool.id}${c.version ? `@${c.version}` : ""}` : "unknown tool";
  const advisory = advisoryIdOf(c);
  if (advisory && (v === "flagged" || v === "caution") && (!c.known || c.verified_owners === 0))
    return [PUNCH[v], v, `published advisory ${advisory}`, subject, ...c.page_url ? [c.page_url.replace(/^https?:\/\//, "")] : []].join(" \xB7 ");
  if (!c.known) return [PUNCH.insufficient, "not enough reports yet (0 of 5)", subject, "no field reports yet"].join(" \xB7 ");
  const parts = [PUNCH[v]];
  switch (v) {
    case "clear":
      parts.push("clear", `Forge Score ${c.forge_score}`, plural(c.distinct_owners, "independent agent"), subject);
      break;
    case "insufficient":
      parts.push(`not enough reports yet (${Math.min(c.distinct_owners, MIN_OWNERS_FOR_SCORE)} of ${MIN_OWNERS_FOR_SCORE})`, subject);
      break;
    case "caution":
      parts.push("caution", "security report under review", subject);
      break;
    case "flagged":
      parts.push("flagged", `${plural(c.verified_owners, "independent verified agent")} reported a security issue`, subject);
      break;
    case "confirmed_malicious":
      parts.push("confirmed malicious", subject);
      break;
  }
  if (c.page_url) parts.push(c.page_url.replace(/^https?:\/\//, ""));
  return parts.join(" \xB7 ");
}

// ../../packages/shared/src/since.ts
var MEMORY_SCHEMA = 1;
var MEMORY_MAX_ENTRIES = 400;
var MEMORY_MAX_AGE_MS = 180 * 864e5;
var emptyMemory = () => ({ v: MEMORY_SCHEMA, checks: {}, watch: {} });
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function parseMemory(text) {
  if (!text) return emptyMemory();
  try {
    const m = JSON.parse(text);
    if (!isObj(m) || m.v !== MEMORY_SCHEMA) return emptyMemory();
    return {
      v: MEMORY_SCHEMA,
      checks: isObj(m.checks) ? m.checks : {},
      watch: isObj(m.watch) ? m.watch : {},
      ...typeof m.rules === "string" ? { rules: m.rules } : {},
      ...typeof m.weekly_at === "string" ? { weekly_at: m.weekly_at } : {}
    };
  } catch {
    return emptyMemory();
  }
}
function trim(rec, now) {
  const kept = Object.entries(rec).filter(([, m]) => isObj(m) && typeof m.at === "string" && now - Date.parse(m.at) < MEMORY_MAX_AGE_MS).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, MEMORY_MAX_ENTRIES);
  return Object.fromEntries(kept);
}
function serializeMemory(m, now = Date.now()) {
  return JSON.stringify({ ...m, checks: trim(m.checks, now), watch: trim(m.watch, now) });
}
var checkKey = (id, version) => `${id.trim().toLowerCase()}@${version || "*"}`;
function checkMemo(c, at) {
  const b = c.outcome_breakdown ?? { worked: 0, partial: 0, failed: 0 };
  return {
    at,
    verdict: displayVerdict(c),
    security: c.security_status,
    score: c.forge_score ?? null,
    reports: c.reports_for_this_version ?? b.worked + b.partial + b.failed,
    outcomes: { worked: b.worked ?? 0, partial: b.partial ?? 0, failed: b.failed ?? 0 },
    advisories: [...new Set((c.public_signals_summary?.advisories ?? []).map((a) => a.id).filter((id) => typeof id === "string"))].sort(),
    version: c.version ?? null
  };
}
function checkChanges(prev, next) {
  if (!prev || !isObj(prev)) return null;
  const po = prev.outcomes ?? { worked: 0, partial: 0, failed: 0 };
  const sameVersion = (prev.version ?? null) === next.version;
  const pos = (n) => Math.max(0, n);
  const new_outcomes = sameVersion ? { worked: pos(next.outcomes.worked - (po.worked ?? 0)), partial: pos(next.outcomes.partial - (po.partial ?? 0)), failed: pos(next.outcomes.failed - (po.failed ?? 0)) } : { ...next.outcomes };
  const new_reports = sameVersion ? pos(next.reports - (prev.reports ?? 0)) : next.reports;
  const before = new Set(Array.isArray(prev.advisories) ? prev.advisories : []);
  const new_advisories = next.advisories.filter((a) => !before.has(a));
  const verdict = prev.verdict !== next.verdict ? { from: prev.verdict, to: next.verdict } : null;
  const security = prev.security !== next.security ? { from: String(prev.security), to: String(next.security) } : null;
  const score = (prev.score ?? null) !== next.score ? { from: prev.score ?? null, to: next.score } : null;
  const version = sameVersion ? null : { from: prev.version ?? null, to: next.version };
  return {
    since: prev.at,
    new_reports,
    new_outcomes,
    new_advisories,
    verdict,
    security,
    score,
    version,
    changed: !!(new_reports || new_advisories.length || verdict || security || score || version)
  };
}
var plural2 = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
var day = (iso) => /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? iso;
var word = (v) => VERDICT_WORD[v] ?? v.replace(/_/g, " ");
function sinceLine(c) {
  if (!c) return "since last check: first check of this version from here";
  if (!c.changed) return `since last check (${day(c.since)}): no change`;
  const parts = [];
  if (c.version) parts.push(`reports now on version ${c.version.to ?? "none"} (was ${c.version.from ?? "none"})`);
  if (c.new_reports) {
    const o = c.new_outcomes;
    const split = [o.worked && `${o.worked} worked`, o.partial && `${o.partial} partial`, o.failed && `${o.failed} failed`].filter(Boolean).join(", ");
    parts.push(`${plural2(c.new_reports, "new field report")}${split ? ` (${split})` : ""}`);
  }
  if (c.new_advisories.length) parts.push(`${c.new_advisories.length === 1 ? "new published advisory" : "new published advisories"} ${c.new_advisories.slice(0, 5).join(", ")}${c.new_advisories.length > 5 ? ` and ${c.new_advisories.length - 5} more` : ""}`);
  if (c.verdict) parts.push(`verdict ${word(c.verdict.from)} \u2192 ${word(c.verdict.to)}`);
  if (c.security && !c.verdict) parts.push(`security status ${word(c.security.from)} \u2192 ${word(c.security.to)}`);
  if (c.score && !c.verdict) parts.push(`Forge Score ${c.score.from ?? "none"} \u2192 ${c.score.to ?? "none"}`);
  return `since last check (${day(c.since)}): ${parts.join("; ")}`;
}
function receiptOf(c, origin) {
  const u = c?.share?.receipt_url;
  return typeof u === "string" && u.startsWith(`${origin}/r/`) && !/\s/.test(u) ? u : null;
}
var WEEK_MS = 7 * 864e5;

// ../../packages/shared/src/claim.ts
var claimProfileUrl = (origin, from) => `${origin.replace(/\/+$/, "")}/gauntlet/claim?from=${from}`;
var claimLine = (origin, from) => `Claim your agent's Forge profile: ${claimProfileUrl(origin, from)}`;
var CLAIM_LINE_EVERY_MS = 7 * 864e5;

// ../../packages/shared/src/install-id.ts
var INSTALL_ID_HEADER = "forge-install-id";
var INSTALL_ID_FILE = "install-id.json";
var PRIVACY_INSTALL_ID_URL = "https://theagentforge.io/privacy#install-id";
var UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var isInstallId = (v) => typeof v === "string" && UUID_V4.test(v);
var on = (v) => v !== void 0 && !["", "0", "false"].includes(v.trim().toLowerCase());
function installIdEnvOff(env) {
  if (on(env.FORGE_NO_ANALYTICS)) return "FORGE_NO_ANALYTICS";
  if (on(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  if (on(env.CI)) return "CI";
  return null;
}
var installIdDebug = (env) => on(env.FORGE_TELEMETRY_DEBUG);
function parseInstallIdState(text) {
  try {
    const s = JSON.parse(text ?? "");
    return { enabled: s?.enabled !== false, id: isInstallId(s?.id) ? s.id : null };
  } catch {
    return { enabled: true, id: null };
  }
}
var serializeInstallIdState = (s) => `${JSON.stringify(s.enabled ? { enabled: true, id: s.id } : { enabled: false })}
`;
function planInstallId(stateText, env, newId) {
  const state = parseInstallIdState(stateText);
  const off = installIdEnvOff(env) ?? (state.enabled ? null : "disabled");
  if (off) return { send: null, id: null, save: null, notice: false, debug: false, off };
  let id = state.id;
  let save = null;
  if (!id) {
    const made = newId();
    if (!isInstallId(made)) return { send: null, id: null, save: null, notice: false, debug: false, off: null };
    id = made;
    save = serializeInstallIdState({ enabled: true, id });
  }
  const debug = installIdDebug(env);
  return { send: debug ? null : id, id, save, notice: save !== null, debug, off: null };
}
function installIdNotice(how) {
  return `The Agent Forge: checks now send a random install ID so we can count return use (we store no IP address or package list with it; Cloudflare's request logs keep each request, its address naming the package and this ID, with the IP address for up to 7 days). Turn off: ${how}, or set FORGE_NO_ANALYTICS=1. ${PRIVACY_INSTALL_ID_URL}`;
}
function installIdDebugLine(id, client, url) {
  return `forge telemetry debug (nothing sent): would send header ${INSTALL_ID_HEADER}: ${id} (client ${client}) with ${url}`;
}

// ../../packages/shared/src/install-parse.ts
var MAX_IDS = 8;
function shellWords(line) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
var NPM_EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
var PY_EXACT = /^\d+(?:\.\d+)*(?:[-_.]?(?:a|b|rc|alpha|beta|c|pre|preview|post|rev|r|dev)[-_.]?\d*)*(?:\+[0-9A-Za-z.]+)?$/i;
function npmSpec(spec) {
  if (!spec || spec.startsWith("-")) return null;
  if (/^(\.{0,2}\/|~|file:|link:|workspace:|git\+|git:|https?:|ssh:)/.test(spec)) return null;
  if (/^github:/.test(spec)) return null;
  const m = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(?:@(.*))?$/i.exec(spec);
  if (!m) return null;
  if (!spec.startsWith("@") && spec.includes("/")) return null;
  const version = m[2]?.replace(/^=/, "");
  return { name: m[1].toLowerCase(), ...version && NPM_EXACT.test(version) ? { version } : {} };
}
function pySpec(spec) {
  if (!spec || spec.startsWith("-") || /[/\\:]/.test(spec) || /\.(whl|zip|tar\.gz|tgz)$/i.test(spec)) return null;
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[A-Za-z0-9,._ -]*\])?\s*(?:(===?|@)\s*([^;\s]+)|(?:[<>!~]=?|=)[^;]*)?\s*(?:;.*)?$/.exec(spec);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/[-_.]+/g, "-");
  const version = m[3];
  return { name, ...version && PY_EXACT.test(version) ? { version } : {} };
}
var npmRef = (spec) => {
  const s = npmSpec(spec);
  return s ? [{ id: `npm:${s.name}`, ...s.version ? { version: s.version } : {} }] : [];
};
var pyRef = (spec) => {
  const s = pySpec(spec);
  return s ? [{ id: `pypi:${s.name}`, ...s.version ? { version: s.version } : {} }] : [];
};
var NPM_INSTALL = /* @__PURE__ */ new Set(["install", "i", "add", "isntall", "in"]);
var PY_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-r",
  "--requirement",
  "-c",
  "--constraint",
  "-e",
  "--editable",
  "-i",
  "--index-url",
  "--extra-index-url",
  "--index",
  "--default-index",
  "-f",
  "--find-links",
  "-t",
  "--target",
  "--prefix",
  "--root",
  "--src",
  "-p",
  "--python",
  "--python-version",
  "--platform",
  "--implementation",
  "--abi",
  "--only-binary",
  "--no-binary",
  "--upgrade-strategy",
  "--progress-bar",
  "--log",
  "--cache-dir",
  "--cert",
  "--client-cert",
  "--proxy",
  "--retries",
  "--timeout",
  "--trusted-host",
  "--group",
  "--optional",
  "--extra",
  "--package",
  "--with",
  "--with-editable",
  "--with-requirements",
  "--directory",
  "--project",
  "--config-file",
  "--suffix",
  "--pip-args",
  "--index-strategy",
  "--keyring-provider"
]);
function packagesAfter(words, start, ref, valueFlags) {
  const refs = [];
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    if (w === "--") break;
    if (w.startsWith("-")) {
      if (valueFlags?.has(w)) i++;
      continue;
    }
    refs.push(...ref(w));
  }
  return refs;
}
function runnerPackage(words, start) {
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    if (w === "-p" || w === "--package") return npmRef(words[i + 1] ?? "");
    if (w.startsWith("--package=")) return npmRef(w.slice("--package=".length));
    if (w.startsWith("-")) continue;
    return npmRef(w);
  }
  return [];
}
function pyRunnerPackage(words, start) {
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    if (w === "--from" || w === "--spec") return pyRef(words[i + 1] ?? "");
    if (w.startsWith("--from=") || w.startsWith("--spec=")) return pyRef(w.slice(w.indexOf("=") + 1));
    if (w.startsWith("-")) {
      if (PY_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    return pyRef(w);
  }
  return [];
}
function githubRepo(url) {
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}
function refsInWords(input) {
  let words = input;
  while (words.length && (/^\w+=/.test(words[0]) || words[0] === "sudo" || words[0] === "env" || words[0] === "exec"))
    words = words.slice(1);
  const [cmd, sub] = words;
  if (!cmd) return [];
  switch (cmd) {
    case "npm":
      if (sub && NPM_INSTALL.has(sub)) return packagesAfter(words, 2, npmRef);
      if (sub === "exec" || sub === "x") return runnerPackage(words, 2);
      return [];
    case "pnpm":
      if (sub === "add") return packagesAfter(words, 2, npmRef);
      if (sub === "dlx" || sub === "exec") return runnerPackage(words, 2);
      return [];
    case "yarn":
      if (sub === "add") return packagesAfter(words, 2, npmRef);
      if (sub === "dlx") return runnerPackage(words, 2);
      return [];
    case "bun":
      if (sub === "add" || sub === "install" || sub === "i") return packagesAfter(words, 2, npmRef);
      if (sub === "x") return runnerPackage(words, 2);
      return [];
    case "npx":
    case "pnpx":
    case "bunx":
      return runnerPackage(words, 1);
    case "pip":
    case "pip3":
      return sub === "install" ? packagesAfter(words, 2, pyRef, PY_VALUE_FLAGS) : [];
    case "python":
    case "python3":
      if (sub === "-m" && (words[2] === "pip" || words[2] === "pip3") && words[3] === "install")
        return packagesAfter(words, 4, pyRef, PY_VALUE_FLAGS);
      return [];
    case "uv":
      if (sub === "add") return packagesAfter(words, 2, pyRef, PY_VALUE_FLAGS);
      if (sub === "pip" && words[2] === "install") return packagesAfter(words, 3, pyRef, PY_VALUE_FLAGS);
      if (sub === "tool" && (words[2] === "install" || words[2] === "run")) return pyRunnerPackage(words, 3);
      return [];
    case "uvx":
      return pyRunnerPackage(words, 1);
    case "pipx":
      if (sub === "install") return packagesAfter(words, 2, pyRef, PY_VALUE_FLAGS);
      if (sub === "run") return pyRunnerPackage(words, 2);
      return [];
    case "git":
      if (sub === "clone") {
        for (const w of words.slice(2)) {
          const repo = githubRepo(w);
          if (repo) return [{ id: repo }];
        }
        return [];
      }
      return [];
    case "claude":
      if (sub === "mcp") {
        const i = words.findIndex((w, j) => j > 1 && (w === "npx" || w === "bunx" || w === "pnpx" || w === "uvx"));
        if (i < 0) return [];
        return words[i] === "uvx" ? pyRunnerPackage(words, i + 1) : runnerPackage(words, i + 1);
      }
      return [];
    default:
      return [];
  }
}
function installRefs(command) {
  const seen = /* @__PURE__ */ new Map();
  for (const seg of command.split(/&&|\|\||;|\||\n/))
    for (const r of refsInWords(shellWords(seg.trim()))) seen.set(`${r.id}@${r.version ?? ""}`, r);
  return [...seen.values()].slice(0, MAX_IDS);
}
var checkParams = (r) => new URLSearchParams(r.version ? { id: r.id, version: r.version } : { id: r.id });

// src/strain-state.ts
var safeSessionId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "unknown";

// src/report-draft.ts
var REDRAFT_AFTER_MS = 3 * 864e5;

// src/installs.ts
var MAX_PENDING = 50;
var KEEP_MS = 7 * 864e5;
function parseInstalls(text) {
  try {
    const f = JSON.parse(text ?? "");
    return { items: Array.isArray(f?.items) ? f.items.filter((i) => i && typeof i.id === "string" && typeof i.cmd === "string") : [] };
  } catch {
    return { items: [] };
  }
}
function addInstalls(f, items, now) {
  const fresh = f.items.filter((i) => now - i.at < KEEP_MS && !items.some((n) => n.session === i.session && n.cmd === i.cmd && n.id === i.id));
  return { items: [...fresh, ...items].slice(-MAX_PENDING) };
}

// src/hooks/common.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}
function forgeOrigin() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(readFileSync(join(here, "..", "forge.json"), "utf8"));
    if (cfg.origin && /^https:\/\/[a-z0-9.-]+$/.test(cfg.origin)) return cfg.origin;
  } catch {
  }
  return "https://theagentforge.io";
}
var OPTION_ENV = {
  CHECK_INSTALLS: "CLAUDE_PLUGIN_OPTION_CHECK_INSTALLS",
  NUDGE: "CLAUDE_PLUGIN_OPTION_NUDGE",
  TRAP_CARD: "CLAUDE_PLUGIN_OPTION_TRAP_CARD",
  REPORT_DRAFTS: "CLAUDE_PLUGIN_OPTION_REPORT_DRAFTS",
  WEEKLY_CHECK: "CLAUDE_PLUGIN_OPTION_WEEKLY_CHECK",
  INSTALL_ID: "CLAUDE_PLUGIN_OPTION_INSTALL_ID"
};
var optionOn = (key, env = process.env) => (env[OPTION_ENV[key]] ?? "true").toLowerCase() !== "false";
var emit = (obj) => process.stdout.write(JSON.stringify(obj));
var dataRoot = () => process.env.CLAUDE_PLUGIN_DATA || join(process.env.HOME || process.env.USERPROFILE || ".", ".claude-forge");
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function writeText(file, text) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  } catch {
  }
}
var memoryPath = () => join(dataRoot(), "memory.json");
var installsPath = () => join(dataRoot(), "installs.json");
var claimShownPath = () => join(dataRoot(), "claim-line.json");
var commandHash = (command) => createHash("sha256").update(command).digest("hex").slice(0, 16);
var installIdPath = () => join(dataRoot(), INSTALL_ID_FILE);
function installIdFor(origin, env = process.env) {
  try {
    if (!optionOn("INSTALL_ID")) return { headers: {}, notice: null };
    const p = planInstallId(readText(installIdPath()), env, () => randomUUID());
    if (!p.id) return { headers: {}, notice: null };
    if (p.save) {
      writeText(installIdPath(), p.save);
      if (readText(installIdPath()) !== p.save) return { headers: {}, notice: null };
    }
    if (p.debug) process.stderr.write(`${installIdDebugLine(p.id, "plugin", `${origin}/api/v1/check`)}
`);
    return { headers: p.send ? { [INSTALL_ID_HEADER]: p.send } : {}, notice: p.notice ? installIdNotice('the plugin setting "Random install ID"') : null };
  } catch {
    return { headers: {}, notice: null };
  }
}

// src/hooks/pre-install.ts
var TIMEOUT_MS = 3e3;
async function decide(command, origin, fetcher = fetch, ctx = {}) {
  const refs = installRefs(command);
  if (!refs.length) return null;
  const results = await Promise.all(
    refs.map(async (ref) => {
      try {
        const res = await fetcher(`${origin}/api/v1/check?${checkParams(ref)}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { ...ctx.headers, "User-Agent": "theagentforge-claude-plugin" }
        });
        if (!res.ok) return null;
        return { ref, check: await res.json() };
      } catch {
        return null;
      }
    })
  );
  const checked = results.filter((r) => r !== null);
  if (!checked.length) return null;
  ctx.checked?.push(...checked);
  const at = new Date(ctx.now ?? Date.now()).toISOString();
  const line = (r) => verdictLine({ ...r.check, tool: r.check.tool ?? { id: r.ref.id } });
  const subject = (r) => `${r.check.tool?.id ?? r.ref.id}${r.ref.version ? `@${r.ref.version}` : ""}`;
  const since = checked.map((r) => {
    if (!ctx.memory) return null;
    const key = checkKey(r.ref.id, r.ref.version);
    const next = checkMemo(r.check, at);
    const c = checkChanges(ctx.memory.checks[key], next);
    ctx.memory.checks[key] = next;
    return { changed: !!c?.changed, text: sinceLine(c) };
  });
  const block = checked.map((r, i) => {
    const receipt = receiptOf(r.check, origin);
    return [line(r), ...since[i] ? [`  ${since[i].text}`] : [], ...receipt ? [`  receipt: ${receipt}`] : []].join("\n");
  });
  const blocked = checked.filter((r) => ["flagged", "confirmed_malicious"].includes(displayVerdict(r.check)));
  const caution = checked.filter((r) => displayVerdict(r.check) === "caution");
  if (blocked.length) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked by The Agent Forge plugin: ${blocked.map(line).join(" | ")}. Overrides: the person runs the command themselves, or turns off the plugin's install check (check_installs).`
      },
      systemMessage: block.join("\n")
    };
  }
  const context = [
    ...caution.map(line),
    ...checked.flatMap((r, i) => since[i]?.changed ? [`${subject(r)}: ${since[i].text}`] : [])
  ];
  return {
    ...context.length ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context.join("\n") } } : {},
    systemMessage: block.join("\n")
  };
}
function withClaimLine(out, origin, lastShown, now) {
  if (!out.systemMessage || lastShown !== null && now - lastShown < CLAIM_LINE_EVERY_MS) return { out, shown: false };
  return { out: { ...out, systemMessage: `${out.systemMessage}
${claimLine(origin, "plugin")}` }, shown: true };
}
function parseClaimShown(text) {
  try {
    const at = JSON.parse(text ?? "null")?.shown_at;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}
function pendingInstalls(checked, session, command, now) {
  return checked.map((r) => ({
    session,
    cmd: commandHash(command),
    at: now,
    id: r.check.tool?.id ?? r.ref.id,
    kind: r.check.tool?.kind ?? null,
    pinned: r.ref.version ?? null,
    known: r.check.known === true,
    check_version: r.check.version ?? null,
    check_fp: typeof r.check.fingerprint === "string" ? r.check.fingerprint : null
  }));
}
function withNotice(out, notice) {
  if (!notice) return out;
  if (!out) return { systemMessage: notice };
  return { ...out, systemMessage: out.systemMessage ? `${out.systemMessage}
${notice}` : notice };
}
async function main() {
  if (!optionOn("CHECK_INSTALLS")) return;
  const input = await readStdin();
  if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return;
  const command = input.tool_input.command;
  if (!installRefs(command).length) return;
  const now = Date.now();
  const memory = parseMemory(readText(memoryPath()));
  const checked = [];
  const id = installIdFor(forgeOrigin());
  const out = withNotice(await decide(command, forgeOrigin(), fetch, { memory, now, checked, headers: id.headers }), id.notice);
  if (checked.length) {
    writeText(memoryPath(), serializeMemory(memory, now));
    if (optionOn("REPORT_DRAFTS")) {
      const session = safeSessionId(input.session_id);
      writeText(installsPath(), JSON.stringify(addInstalls(parseInstalls(readText(installsPath())), pendingInstalls(checked, session, command, now), now)));
    }
  }
  if (!out) return;
  const claim = withClaimLine(out, forgeOrigin(), parseClaimShown(readText(claimShownPath())), now);
  if (claim.shown) writeText(claimShownPath(), JSON.stringify({ shown_at: now }));
  emit(claim.out);
}
if (process.env.VITEST === void 0) main().catch(() => {
});
export {
  decide,
  parseClaimShown,
  pendingInstalls,
  withClaimLine,
  withNotice
};
