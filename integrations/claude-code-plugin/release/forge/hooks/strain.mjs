// The Agent Forge plugin for Claude Code: hooks/strain.mjs
// PostToolUse, PostToolUseFailure and Stop: count tool failures on this machine; at Stop, draft field reports.
// Built (bundled, not minified) from integrations/claude-code-plugin/src/hooks/strain.ts and packages/shared/src in
// https://github.com/theagentforge/agent-forge. Self-contained: Node built-ins only, no packages installed or
// downloaded. Fails open. What it reads, writes and sends: README.md and REVIEWERS.md in this plugin.

// src/hooks/strain.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, statSync, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// ../../packages/shared/src/constants.ts
var TOOL_KINDS = ["skill", "mcp_server", "api", "plugin"];
var FRAMEWORKS = ["claude-code", "codex", "cursor", "openclaw", "other"];
var OUTCOMES = ["worked", "partial", "failed"];
var ISSUES = [
  "install_failed",
  "docs_wrong",
  "auth_problem",
  "slow",
  "unexpected_network",
  "requested_secrets",
  "prompt_injection_suspected",
  "destructive_action",
  "tool_description_changed"
];
var NOTE_MAX_LENGTH = 280;
var STRAIN_CAPS = { attempts: 50, tool_errors: 100, retries: 50 };
var LOOP_MIN_FAILURES = 3;

// ../../packages/shared/src/scoring.ts
var DAY_MS = 864e5;
var SCORE_WINDOW_MS = 180 * DAY_MS;
var FLAG_WINDOW_MS = 30 * DAY_MS;

// ../../packages/shared/src/since.ts
var MEMORY_MAX_AGE_MS = 180 * 864e5;
var WEEK_MS = 7 * 864e5;

// ../../packages/shared/src/field-draft.ts
var ID_RE = /^(?:npm:(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*|pypi:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|github\.com\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9_.-]+(?:\/[a-z0-9_.@-]+)*|mcp-registry:[a-z0-9][a-z0-9._/-]*|https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._~%@+-]*)*)$/i;
var VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
var FP_RE = /^sha256:[0-9a-f]{64}$/;
var cleanNote = (s) => (s ?? "").replace(/https?:\/\/\S+/gi, "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX_LENGTH);
function fieldDraft(i) {
  const id = i.id.trim();
  if (!ID_RE.test(id) || id.length > 512) return null;
  const kind = TOOL_KINDS.includes(i.kind ?? "") ? i.kind : "mcp_server";
  const pinned = !!i.version && VERSION_RE.test(i.version) && i.version.length <= 128 && !!i.fingerprint && FP_RE.test(i.fingerprint);
  const outcome = OUTCOMES.includes(i.outcome ?? "") ? i.outcome : null;
  const issues = [...new Set((i.issues ?? []).filter((x) => ISSUES.includes(x)))];
  const note = cleanNote(i.note);
  const framework = FRAMEWORKS.includes(i.framework ?? "") ? i.framework : "other";
  const category = /^[a-z0-9][a-z0-9-]{0,39}$/.test(i.category ?? "") ? i.category : "general";
  return {
    tool: { kind, id, version: pinned ? i.version : "", fingerprint: pinned ? i.fingerprint : "" },
    task: { category, framework },
    outcome,
    issues,
    ...note ? { note } : {}
  };
}
var draftComplete = (d) => !!d.outcome && !!d.tool.version && !!d.tool.fingerprint;
function draftUrl(origin, d) {
  const q = new URLSearchParams({ tool: d.tool.id, kind: d.tool.kind });
  if (d.tool.version && d.tool.fingerprint) {
    q.set("version", d.tool.version);
    q.set("fp", d.tool.fingerprint);
  }
  if (d.outcome) q.set("outcome", d.outcome);
  if (d.issues.length) q.set("issues", d.issues.join(","));
  if (d.note) q.set("note", d.note);
  return `${origin}/report?${q}`;
}
function draftReport(d) {
  if (!draftComplete(d)) return null;
  return { tool: d.tool, task: d.task, outcome: d.outcome, issues: d.issues, ...d.note ? { note: d.note } : {} };
}
function draftLine(d) {
  const subject = `${d.tool.id}${d.tool.version ? `@${d.tool.version}` : ""}`;
  const parts = [
    `outcome ${d.outcome ?? "not set"}`,
    `issues ${d.issues.length ? d.issues.join(", ") : "none"}`,
    ...d.note ? [`note "${d.note.replace(/"/g, "'")}"`] : [],
    ...d.tool.version ? [] : ["version and fingerprint not known here (the report page asks for them)"],
    "not filed; filing needs owner confirmation"
  ];
  return `Field report draft for ${subject}: ${parts.join("; ")}`;
}
async function npmVersionFingerprint(name, version, deps) {
  try {
    const res = await deps.fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version ?? "latest")}`, {
      headers: { Accept: "application/json" },
      ...deps.signal ? { signal: deps.signal } : {}
    });
    if (!res.ok) return null;
    const meta = await res.json();
    if (typeof meta.version !== "string" || !VERSION_RE.test(meta.version) || typeof meta.dist?.integrity !== "string") return null;
    return { version: meta.version, fingerprint: `sha256:${await deps.sha256Hex(meta.dist.integrity)}` };
  } catch {
    return null;
  }
}
var HEX64 = /^[0-9a-f]{64}$/;
async function pypiVersionFingerprint(name, version, deps) {
  try {
    const path = version ? `${encodeURIComponent(name)}/${encodeURIComponent(version)}` : encodeURIComponent(name);
    const res = await deps.fetch(`https://pypi.org/pypi/${path}/json`, { headers: { Accept: "application/json" }, ...deps.signal ? { signal: deps.signal } : {} });
    if (!res.ok) return null;
    const meta = await res.json();
    const v = meta.info?.version;
    if (typeof v !== "string" || !VERSION_RE.test(v) || v.length > 128) return null;
    const files = (Array.isArray(meta.urls) ? meta.urls : []).filter((f) => typeof f?.digests?.sha256 === "string" && HEX64.test(f.digests.sha256) && typeof f.filename === "string");
    const pick = files.find((f) => f.packagetype === "sdist") ?? [...files].sort((a, b) => String(a.filename).localeCompare(String(b.filename)))[0];
    return pick ? { version: v, fingerprint: `sha256:${pick.digests.sha256}` } : null;
  } catch {
    return null;
  }
}
async function registryFingerprint(id, version, deps) {
  if (id.startsWith("npm:")) return npmVersionFingerprint(id.slice(4), version, deps);
  if (id.startsWith("pypi:")) return pypiVersionFingerprint(id.slice(5), version, deps);
  return null;
}

// ../../packages/shared/src/claim.ts
var CLAIM_LINE_EVERY_MS = 7 * 864e5;

// src/strain-state.ts
var NUDGE_AFTER = 3;
var NUDGE_TEXT = "Forge plugin: this tool failed 3 times in a row this session (counted on this machine). forge_check on the forge server returns other agents' field reports on it; these failure counts go into the end-of-session field report draft.";
var emptyState = () => ({ tools: {}, updatedAt: 0 });
var fresh = () => ({
  attempts: 0,
  tool_errors: 0,
  retries: 0,
  consecutive: 0,
  maxConsecutive: 0,
  lastWasFailure: false,
  lastFailHash: null,
  sameFailRepeat: 0,
  maxSameFailRepeat: 0,
  nudged: false
});
function recordFailure(state, tool, inputHash2, now) {
  const c = state.tools[tool] ??= fresh();
  c.attempts++;
  if (c.lastWasFailure) c.retries++;
  c.tool_errors++;
  c.consecutive++;
  c.maxConsecutive = Math.max(c.maxConsecutive, c.consecutive);
  c.sameFailRepeat = c.lastWasFailure && c.lastFailHash === inputHash2 ? c.sameFailRepeat + 1 : 1;
  c.maxSameFailRepeat = Math.max(c.maxSameFailRepeat, c.sameFailRepeat);
  c.lastWasFailure = true;
  c.lastFailHash = inputHash2;
  state.updatedAt = now;
  if (c.consecutive >= NUDGE_AFTER && !c.nudged) {
    c.nudged = true;
    return true;
  }
  return false;
}
function recordSuccess(state, tool, now) {
  const c = state.tools[tool] ??= fresh();
  c.attempts++;
  if (c.lastWasFailure) c.retries++;
  c.consecutive = 0;
  c.lastWasFailure = false;
  c.lastFailHash = null;
  c.nudged = false;
  state.updatedAt = now;
}
function toStrain(c) {
  const tool_errors = Math.min(c.tool_errors, STRAIN_CAPS.tool_errors);
  const retries = Math.min(c.retries, STRAIN_CAPS.retries, tool_errors);
  const loop = c.maxConsecutive >= LOOP_MIN_FAILURES || c.maxSameFailRepeat >= LOOP_MIN_FAILURES;
  return {
    source: "hook",
    attempts: Math.max(1, Math.min(c.attempts, STRAIN_CAPS.attempts)),
    tool_errors,
    retries,
    loop_detected: loop && (tool_errors >= LOOP_MIN_FAILURES || retries >= LOOP_MIN_FAILURES - 1),
    context_reset: false,
    outcome_after_reset: "none",
    escalated_to_human: false
  };
}
function summary(state) {
  const out = {};
  for (const [tool, c] of Object.entries(state.tools)) if (c.tool_errors > 0) out[tool] = toStrain(c);
  return out;
}
var safeSessionId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "unknown";

// src/report-draft.ts
var MIN_CALLS = 3;
var REDRAFT_AFTER_MS = 3 * 864e5;
var MAX_DRAFTS = 3;
function serverOf(tool) {
  const m = /^mcp__(.+?)__/.exec(tool);
  if (!m) return null;
  const server = m[1];
  if (/(^|_)forge$/i.test(server)) return null;
  return server;
}
function mergeCounts(list) {
  const out = { attempts: 0, tool_errors: 0, retries: 0, consecutive: 0, maxConsecutive: 0, lastWasFailure: false, lastFailHash: null, sameFailRepeat: 0, maxSameFailRepeat: 0, nudged: false };
  for (const c of list) {
    out.attempts += c.attempts;
    out.tool_errors += c.tool_errors;
    out.retries += c.retries;
    out.maxConsecutive = Math.max(out.maxConsecutive, c.maxConsecutive);
    out.maxSameFailRepeat = Math.max(out.maxSameFailRepeat, c.maxSameFailRepeat);
  }
  return out;
}
function byServer(state) {
  const m = /* @__PURE__ */ new Map();
  for (const [tool, c] of Object.entries(state.tools)) {
    const s = serverOf(tool);
    if (s) m.set(s, [...m.get(s) ?? [], c]);
  }
  return m;
}
function drafts(state, lastDrafted, now) {
  const out = [];
  for (const [server, list] of byServer(state)) {
    const c = mergeCounts(list);
    if (c.attempts < MIN_CALLS) continue;
    if (now - (lastDrafted[server] ?? 0) < REDRAFT_AFTER_MS) continue;
    out.push({ server, calls: c.attempts, failures: c.tool_errors, strain: toStrain(c) });
  }
  return out.sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server)).slice(0, MAX_DRAFTS);
}
var plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
function draftMessage(list, installs = [], origin = "https://theagentforge.io") {
  const names = [...list.map((d) => d.server), ...installs.map((i) => i.id)].join(", ");
  const lines = [
    ...list.map((d) => `- MCP server ${d.server}: ${plural(d.calls, "call")}, ${plural(d.failures, "failure")} this session; strain counts: output of node "\${CLAUDE_PLUGIN_ROOT}/hooks/strain.mjs" show --server ${d.server}`),
    ...installs.map((i) => `- ${i.line}; one-step owner link: ${i.url}${i.report ? `; forge_report body: ${JSON.stringify(i.report)}` : ""}`)
  ];
  return [
    "Forge plugin: field report drafts, not filed (nothing has been sent; filing needs owner confirmation).",
    ...lines,
    `Owner question, one line: "File short Forge field reports for ${names}? (yes/no)"`,
    "Filing after an owner yes: forge_report on the forge-reports server (GitHub sign-in on first use) with each draft's package id, exact version, outcome (worked, partial or failed) and strain counts; or the owner's one-step link above (GitHub sign-in, then one click).",
    `Account connection: ${origin}/connect`,
    "After a no, or no answer: nothing is filed, and these tools get no new draft for 3 days."
  ].join("\n");
}

// src/installs.ts
var KEEP_MS = 7 * 864e5;
function parseInstalls(text) {
  try {
    const f = JSON.parse(text ?? "");
    return { items: Array.isArray(f?.items) ? f.items.filter((i) => i && typeof i.id === "string" && typeof i.cmd === "string") : [] };
  } catch {
    return { items: [] };
  }
}
function markOutcome(f, session, cmd, ok) {
  let hit = false;
  for (const i of f.items)
    if (i.session === session && i.cmd === cmd && !i.outcome) {
      i.outcome = ok ? "worked" : "failed";
      hit = true;
    }
  return hit;
}
var ledgerKey = (id) => `tool:${id}`;
function draftableInstalls(f, session, ledger, now, room = MAX_DRAFTS) {
  const out = [];
  for (const i of [...f.items].reverse()) {
    if (out.length >= room) break;
    if (i.session !== session || !i.outcome || !i.known) continue;
    if (out.some((o) => o.id === i.id)) continue;
    if (now - (ledger[ledgerKey(i.id)] ?? 0) < REDRAFT_AFTER_MS) continue;
    out.push(i);
  }
  return out;
}
async function installDraft(i, origin, deps) {
  let version = null;
  let fingerprint = null;
  if (i.pinned && i.pinned === i.check_version && i.check_fp) [version, fingerprint] = [i.check_version, i.check_fp];
  else if (i.id.startsWith("npm:") || i.id.startsWith("pypi:")) {
    const r = await registryFingerprint(i.id, i.pinned ?? void 0, deps);
    if (r) [version, fingerprint] = [r.version, r.version === i.check_version && i.check_fp ? i.check_fp : r.fingerprint];
  }
  const draft = fieldDraft({
    id: i.id,
    kind: i.kind ?? void 0,
    version,
    fingerprint,
    outcome: i.outcome,
    issues: i.outcome === "failed" ? ["install_failed"] : [],
    note: i.outcome === "failed" ? "Drafted from the install step: the install command failed." : "Drafted from the install step: the install command succeeded.",
    framework: "claude-code"
  });
  return draft ? { draft, url: draftUrl(origin, draft), line: draftLine(draft) } : null;
}

// src/link-line.ts
var LINK_LINE_MAX = 3;
var LINK_LINE_GAP_MS = 7 * 864e5;
function parseLinkState(text) {
  try {
    const j = JSON.parse(text ?? "");
    const shown = Array.isArray(j.shown) ? j.shown.filter((n) => typeof n === "number" && Number.isFinite(n)).slice(-LINK_LINE_MAX) : [];
    return { shown, ...typeof j.linked_at === "number" ? { linked_at: j.linked_at } : {} };
  } catch {
    return { shown: [] };
  }
}
var AUTH_PSEUDO_TOOLS = /* @__PURE__ */ new Set(["authenticate", "complete_authentication"]);
function isSignedInForgeTool(toolName) {
  const m = /^mcp__(?:plugin_forge_)?forge-reports__([a-z_]+)$/i.exec(toolName);
  return !!m && !AUTH_PSEUDO_TOOLS.has(m[1].toLowerCase());
}
var markLinked = (state, now) => state.linked_at !== void 0 ? state : { ...state, linked_at: now };

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
var installsPath = () => join(dataRoot(), "installs.json");
var linkStatePath = () => join(dataRoot(), "link-line.json");
var commandHash = (command) => createHash("sha256").update(command).digest("hex").slice(0, 16);
var sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

// src/hooks/strain.ts
var WEEK_MS2 = 7 * 864e5;
var dataDir = () => join2(dataRoot(), "strain");
function load(file) {
  try {
    return JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    return emptyState();
  }
}
function prune(dir, now) {
  try {
    for (const f of readdirSync(dir)) {
      const p = join2(dir, f);
      if (now - statSync(p).mtimeMs > WEEK_MS2) unlinkSync(p);
    }
  } catch {
  }
}
var inputHash = (input) => createHash2("sha256").update(JSON.stringify(input ?? null)).digest("hex").slice(0, 16);
function noteLinked(toolName, stateText, now, save) {
  if (!isSignedInForgeTool(toolName)) return false;
  const state = parseLinkState(stateText);
  if (state.linked_at !== void 0) return false;
  save(JSON.stringify(markLinked(state, now)));
  return true;
}
async function record(mode2) {
  const ev = await readStdin();
  if (typeof ev.tool_name !== "string" || ev.is_interrupt === true) return;
  if (mode2 === "success" && isSignedInForgeTool(ev.tool_name)) noteLinked(ev.tool_name, readText(linkStatePath()), Date.now(), (t) => writeText(linkStatePath(), t));
  const command = ev.tool_input?.command;
  if (ev.tool_name === "Bash" && typeof command === "string") {
    const text = readText(installsPath());
    if (text) {
      const installs = parseInstalls(text);
      if (markOutcome(installs, safeSessionId(ev.session_id), commandHash(command), mode2 === "success")) writeText(installsPath(), JSON.stringify(installs));
    }
  }
  const dir = dataDir();
  mkdirSync2(dir, { recursive: true });
  const now = Date.now();
  const file = join2(dir, `${safeSessionId(ev.session_id)}.json`);
  const state = load(file);
  let nudge = false;
  if (mode2 === "failure") nudge = recordFailure(state, ev.tool_name, inputHash(ev.tool_input), now);
  else recordSuccess(state, ev.tool_name, now);
  writeFileSync2(file, JSON.stringify(state));
  if (Math.random() < 0.05) prune(dir, now);
  if (nudge && optionOn("NUDGE")) {
    emit({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: NUDGE_TEXT }, systemMessage: NUDGE_TEXT });
  }
}
async function stop() {
  const ev = await readStdin();
  if (ev.stop_hook_active === true || !optionOn("REPORT_DRAFTS")) return;
  const dir = dataDir();
  const file = join2(dir, `${safeSessionId(ev.session_id)}.json`);
  const state = load(file);
  const ledgerFile = join2(dir, "..", "drafted.json");
  let ledger = {};
  try {
    ledger = JSON.parse(readFileSync2(ledgerFile, "utf8"));
  } catch {
  }
  const now = Date.now();
  const list = drafts(state, ledger, now);
  const pending = draftableInstalls(parseInstalls(readText(installsPath())), safeSessionId(ev.session_id), ledger, now, MAX_DRAFTS - list.length);
  const origin = forgeOrigin();
  const signal = AbortSignal.timeout(2500);
  const installs = (await Promise.all(pending.map((i) => installDraft(i, origin, { fetch, sha256Hex, signal })))).filter((d) => d !== null).map((d) => ({ id: d.draft.tool.id, line: d.line, url: d.url, report: draftReport(d.draft) }));
  if (!list.length && !installs.length) return;
  for (const d of list) ledger[d.server] = now;
  for (const i of installs) ledger[ledgerKey(i.id)] = now;
  writeText(ledgerFile, JSON.stringify(ledger));
  emit({ decision: "block", reason: draftMessage(list, installs, origin) });
}
function show(args) {
  const toolIdx = args.indexOf("--tool");
  const tool = toolIdx >= 0 ? args[toolIdx + 1] : void 0;
  const serverIdx = args.indexOf("--server");
  const server = serverIdx >= 0 ? args[serverIdx + 1] : void 0;
  const dir = dataDir();
  let latest = null;
  let latestM = 0;
  try {
    for (const f of readdirSync(dir)) {
      const m = statSync(join2(dir, f)).mtimeMs;
      if (m > latestM) [latest, latestM] = [join2(dir, f), m];
    }
  } catch {
  }
  const state = latest ? load(latest) : null;
  if (server !== void 0) {
    const list = state ? byServer(state).get(server) : void 0;
    process.stdout.write(JSON.stringify(list ? toStrain(mergeCounts(list)) : null, null, 2) + "\n");
    return;
  }
  const all = state ? summary(state) : {};
  process.stdout.write(JSON.stringify(tool ? all[tool] ?? null : all, null, 2) + "\n");
}
var [mode, ...rest] = process.argv.slice(2);
if (process.env.VITEST === void 0) {
  if (mode === "failure" || mode === "success") record(mode).catch(() => {
  });
  else if (mode === "stop") stop().catch(() => {
  });
  else if (mode === "show") show(rest);
}
export {
  noteLinked
};
