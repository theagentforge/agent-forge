import {
  checkChanges,
  claimLine,
  checkKey,
  checkMemo,
  displayVerdict,
  draftComplete,
  draftLine,
  draftReport,
  draftUrl,
  fieldDraft,
  ISSUES,
  registryFingerprint,
  OUTCOMES,
  parseMemory,
  receiptOf,
  serializeMemory,
  sinceLine,
  verdictLine,
  weeklyCheck,
  type CheckAnswerLike,
  type CheckChanges,
  type FieldDraft,
  type LocalSkill,
  type MemoryFile,
  type VerdictInput,
} from "@forge/shared/light";
import { CLIENTS, hookAnswer, hookConfig, isHookClient } from "./hook";
import { LOCKFILES, parseLockfile, type Pkg } from "./lockfiles";
import { DRAFTS_FILE, MEMORY_FILE, noteTools, parseNoted, type NotedTool } from "./state";

// `forge check <tool>`: one line a human can read, or JSON for scripts. No account, no telemetry. On a repeat check
//   it says what changed since this machine's last answer (kept in the local cache, never sent).
// `forge exposure [lockfile ...]`: reads lockfiles here, sends only names and exact versions, prints advisory matches.
// `forge hook <client>`: a pre-install hook for Codex, Gemini CLI and Copilot CLI (see hook.ts).
// `forge report [<tool>]`: a ready-made field report draft and its one-step link; filing needs the owner's yes.
// `forge watch [SKILL.md ...]`: the weekly pass (forge_watch's REST twin plus re-checks), with what changed.

export const DEFAULT_ORIGIN = "https://theagentforge.io";
export const EXIT = { ok: 0, error: 1, usage: 2, blocked: 3 } as const;
export const VERSION = "0.4.2";

const HELP = `Usage: forge check <tool> [--json] [--strict] [--no-memory] [--origin <url>]
       forge report [<tool>] [--version <v>] [--outcome worked|partial|failed] [--issues <a,b>] [--note <text>]
                    [--framework <name>] [--file] [--json] [--origin <url>]
       forge watch [SKILL.md ...] [--json] [--origin <url>]
       forge exposure [lockfile ...] [--json] [--strict] [--origin <url>]
       forge hook <client> [--origin <url>]
       forge hook --print-config <client> [--json] [--origin <url>]

  <tool>     npm:<package>, github.com/<owner>/<repo>, mcp-registry:<name>, a bare npm package name, or a URL
  check      On a repeat check from this machine, also says what changed since then: new field reports, newly
             matching advisories, a changed verdict. The memory stays in this machine's cache (--no-memory: skip).
  report     A field report draft and its one-step link: the owner opens it, signs in with GitHub and files it with
             one click. Without <tool>, lists drafts for tools checked here in the last 14 days. --file files it
             from here after a yes at the terminal, with a signed-in token in FORGE_TOKEN. Nothing is filed otherwise.
  watch      Fingerprints installed skills (default ~/.claude/skills, ./.claude/skills, ~/.codex/skills and
             ~/.agents/skills) and re-checks recently checked tools. Only fingerprints and tool ids are sent.
  lockfile   package-lock.json, pnpm-lock.yaml, requirements.txt or poetry.lock (default: those found here).
             Read on this machine; only package names and exact versions are sent.
  --json     print the full result as JSON
  --strict   also exit 3 on caution (a security report under review, or any published advisory)
  client     ${Object.keys(CLIENTS).join(", ")}. The hook reads the client's tool call on stdin and denies an
             install only when The Forge has it flagged or confirmed malicious; anything else, or any error, allows.
             --print-config prints the snippet to add to that client's hook config.
  --origin   Forge address (default ${DEFAULT_ORIGIN})

Exit codes: 0 fine to proceed, 3 flagged or confirmed malicious, 1 the check failed, 2 bad usage.
Verdicts are data from field reports by human-verified agents: https://theagentforge.io/methodology`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  fetch: typeof fetch;
  /** A local file's text, or null when it isn't there (for `exposure` and `watch`). */
  readFile?: (path: string) => Promise<string | null>;
  /** Everything on stdin (for `hook`). */
  stdin?: () => Promise<string>;
  /** The local cache (memory.json, drafts.json); without it nothing is remembered. */
  readCache?: (name: string) => Promise<string | null>;
  writeCache?: (name: string, text: string) => Promise<void>;
  /** Asks the person at the terminal; null when there is no terminal (an agent's shell, CI). */
  confirm?: (question: string) => Promise<boolean | null>;
  /**
   * True when a person is reading the output at a terminal (stdout is a TTY). An agent's shell or CI isn't one, so the
   * claim line (ADR 0055), which is meant for the person, never lands in an agent's context.
   */
  terminal?: boolean;
  env?: Record<string, string | undefined>;
  sha256Hex?: (s: string) => string;
  /** SKILL.md files in the usual places (for `watch` without paths). */
  skillFiles?: () => Promise<LocalSkill[]>;
  now?: () => number;
}

const UA = `theagentforge-cli/${VERSION}`;
const nowOf = (io: Io) => io.now?.() ?? Date.now();

async function loadMemory(io: Io): Promise<MemoryFile | null> {
  if (!io.readCache) return null;
  try {
    return parseMemory(await io.readCache(MEMORY_FILE));
  } catch {
    return parseMemory(null);
  }
}

async function save(io: Io, name: string, text: string) {
  try {
    await io.writeCache?.(name, text);
  } catch {
    // A read-only cache only means nothing is remembered.
  }
}

async function note(io: Io, tools: NotedTool[], now: number) {
  if (!io.readCache || !tools.length) return;
  const list = parseNoted(await io.readCache(DRAFTS_FILE).catch(() => null));
  await save(io, DRAFTS_FILE, noteTools(list, tools, now));
}

async function hook(args: string[], o: { json: boolean; origin: string }, io: Io): Promise<number> {
  const printConfig = args[0] === "--print-config";
  const [client, ...extra] = printConfig ? args.slice(1) : args;
  // Exit 1, not 2, on bad usage: every supported client treats exit 2 from a hook as "block this command".
  if (!isHookClient(client) || extra.length) {
    io.err(`Usage: forge hook <client> | forge hook --print-config <client>  (client: ${Object.keys(CLIENTS).join(", ")})`);
    return EXIT.error;
  }
  if (printConfig) {
    const c = hookConfig(client, o.origin === DEFAULT_ORIGIN ? undefined : o.origin);
    if (o.json) io.out(JSON.stringify(c, null, 2));
    else {
      io.err(`Merge into ${c.files.join(" (this project) or ")} (all projects):`);
      io.out(JSON.stringify(c.config, null, 2));
    }
    return EXIT.ok;
  }
  // Always exit 0: Copilot CLI denies the tool call on any other non-zero exit, and this hook fails open.
  let text = "";
  try {
    text = (await io.stdin?.()) ?? "";
  } catch {}
  const now = nowOf(io);
  const memory = await loadMemory(io).catch(() => null);
  const noted: NotedTool[] = [];
  const answer = await hookAnswer(client, text, { origin: o.origin, fetch: io.fetch, userAgent: `${UA} (hook ${client})`, memory: memory ?? undefined, now, noted, client });
  if (memory && noted.length) {
    await save(io, MEMORY_FILE, serializeMemory(memory, now));
    await note(io, noted, now).catch(() => {});
  }
  if (answer) io.out(answer);
  return EXIT.ok;
}
const BATCH = 500;

interface ExposureAnswer {
  items: number;
  checked: number;
  matched: number;
  not_checked: unknown[];
  matches: { status: string; line: string }[];
}

async function exposure(files: string[], o: { json: boolean; strict: boolean; origin: string }, io: Io): Promise<number> {
  if (!io.readFile) {
    io.err("This build can't read files.");
    return EXIT.error;
  }
  const names = files.length ? files : [...LOCKFILES];
  const pkgs: Pkg[] = [];
  const read: string[] = [];
  for (const f of names) {
    const text = await io.readFile(f);
    if (text === null) {
      if (files.length) {
        io.err(`Can't read ${f}.`);
        return EXIT.usage;
      }
      continue;
    }
    try {
      pkgs.push(...parseLockfile(f, text));
      read.push(f);
    } catch {
      io.err(`Can't parse ${f}.`);
      return EXIT.error;
    }
  }
  if (!read.length) {
    io.err(`No lockfile found here (looked for ${LOCKFILES.join(", ")}). Name one: forge exposure path/to/package-lock.json`);
    return EXIT.usage;
  }
  const total: ExposureAnswer = { items: 0, checked: 0, matched: 0, not_checked: [], matches: [] };
  for (let i = 0; i < pkgs.length; i += BATCH) {
    let res: Response;
    try {
      res = await io.fetch(`${o.origin}/api/v1/exposure`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ packages: pkgs.slice(i, i + BATCH) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      io.err(`Couldn't reach The Forge (${(e as Error).message}).`);
      return EXIT.error;
    }
    if (!res.ok) {
      io.err(`The Forge answered ${res.status}. ${res.status === 429 ? "Too many checks; wait a minute." : ""}`.trim());
      return EXIT.error;
    }
    const a = (await res.json()) as ExposureAnswer;
    total.items += a.items;
    total.checked += a.checked;
    total.matched += a.matched;
    total.not_checked.push(...a.not_checked);
    total.matches.push(...a.matches);
  }
  if (o.json) io.out(JSON.stringify({ files: read, ...total }, null, 2));
  else {
    for (const m of total.matches) io.out(`${m.status === "flagged" ? "[F⚑]" : "[F!]"} ${m.line}`);
    io.out(`${total.checked} of ${total.items} packages checked against published advisories (OSV, CISA KEV) from ${read.join(", ")}: ${total.matched} matched.${total.not_checked.length ? ` ${total.not_checked.length} not checked (advisory source unreachable).` : ""}`);
  }
  if (total.matches.some((m) => m.status === "flagged")) return EXIT.blocked;
  if (o.strict && total.matched) return EXIT.blocked;
  return total.not_checked.length ? EXIT.error : EXIT.ok;
}

/** Turns what the user typed into a check query: URLs go in `url`, everything else is an id. Bare names mean npm. */
export function toQuery(tool: string): URLSearchParams {
  const t = tool.trim();
  if (/^https?:\/\//i.test(t)) return new URLSearchParams({ url: t });
  if (/^sha256:[0-9a-f]{64}$/.test(t)) return new URLSearchParams({ fingerprint: t });
  if (/^(npm:|github\.com\/|mcp-registry:)/i.test(t)) return new URLSearchParams({ id: t });
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(t)) return new URLSearchParams({ id: `npm:${t}` });
  return new URLSearchParams({ id: t });
}

type Answer = VerdictInput & CheckAnswerLike & { tool: { id: string; kind?: string } | null; fingerprint?: string | null; known: boolean };

/** One check, or an error message for the person. */
async function fetchCheck(q: URLSearchParams, origin: string, io: Io): Promise<Answer | string> {
  let res: Response;
  try {
    res = await io.fetch(`${origin}/api/v1/check?${q}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return `Couldn't reach The Forge (${(e as Error).message}).`;
  }
  if (!res.ok) return `The Forge answered ${res.status}. ${res.status === 429 ? "Too many checks; wait a minute." : ""}`.trim();
  return (await res.json()) as Answer;
}

/** The memory key: the id asked about, without a version written into it, and the version asked about. */
function askedKey(q: URLSearchParams, check: Answer): string {
  const asked = q.get("id") ?? q.get("url") ?? q.get("fingerprint") ?? "";
  const v = check.asked_version ?? q.get("version") ?? null;
  const id = v && asked.endsWith(`@${v}`) ? asked.slice(0, -v.length - 1) : asked;
  return checkKey(id, v);
}

async function check(tool: string, o: { json: boolean; strict: boolean; origin: string; memory: boolean }, io: Io): Promise<number> {
  const q = toQuery(tool);
  const checkOrError = await fetchCheck(q, o.origin, io);
  if (typeof checkOrError === "string") {
    io.err(checkOrError);
    return EXIT.error;
  }
  const c = checkOrError;
  const now = nowOf(io);
  const memory = o.memory ? await loadMemory(io) : null;
  let since: CheckChanges | null | undefined;
  if (memory) {
    const key = askedKey(q, c);
    const next = checkMemo(c, new Date(now).toISOString());
    since = checkChanges(memory.checks[key], next);
    memory.checks[key] = next;
    await save(io, MEMORY_FILE, serializeMemory(memory, now));
    if (c.known && c.tool) await note(io, [{ id: c.tool.id, kind: c.tool.kind ?? null, pinned: c.asked_version ?? null, check_version: c.version ?? null, check_fp: typeof c.fingerprint === "string" ? c.fingerprint : null, via: "check", at: new Date(now).toISOString() }], now).catch(() => {});
  }
  // The signed, dated link to this answer, for a pull request or README (Forge receipts, 24 Oct 2026).
  const receipt = receiptOf(c, o.origin);
  if (o.json) io.out(JSON.stringify(since === undefined ? c : { ...c, since_last: since }, null, 2));
  else {
    io.out(verdictLine({ ...c, tool: c.tool ?? { id: tool } }));
    if (since !== undefined) io.out(sinceLine(since));
    if (c.known && c.tool) io.out(`report draft after use: forge report ${c.tool.id}${c.asked_version ? ` --version ${c.asked_version}` : ""} (nothing is filed without the owner's confirmation)`);
    if (receipt) io.out(`receipt: ${receipt}`);
    // ADR 0055: one plain line for the person, after a finished check (not with --json, and only at a terminal: never
    // in an agent's shell, where it would read as an instruction in the agent's context).
    if (io.terminal === true) io.out(claimLine(o.origin, "cli"));
  }
  const v = displayVerdict(c);
  if (v === "flagged" || v === "confirmed_malicious") return EXIT.blocked;
  if (o.strict && v === "caution") return EXIT.blocked;
  return EXIT.ok;
}

interface ReportOpts {
  json: boolean;
  origin: string;
  file: boolean;
  version?: string;
  outcome?: string;
  issues?: string;
  note?: string;
  framework?: string;
}

/** Fills in the version and fingerprint: the Forge's when it matches, else the npm or PyPI registry's. */
async function resolveDraft(t: { id: string; kind: string | null; version: string | null; check_version: string | null; check_fp: string | null }, o: ReportOpts, io: Io): Promise<FieldDraft | null> {
  let version: string | null = null;
  let fingerprint: string | null = null;
  if (t.version && t.version === t.check_version && t.check_fp) [version, fingerprint] = [t.check_version, t.check_fp];
  else if ((t.id.startsWith("npm:") || t.id.startsWith("pypi:")) && io.sha256Hex) {
    const r = await registryFingerprint(t.id, t.version ?? undefined, { fetch: io.fetch, sha256Hex: io.sha256Hex, signal: AbortSignal.timeout(5000) });
    if (r) [version, fingerprint] = [r.version, r.version === t.check_version && t.check_fp ? t.check_fp : r.fingerprint];
  }
  const issues = (o.issues ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return fieldDraft({ id: t.id, kind: t.kind ?? undefined, version, fingerprint, outcome: o.outcome ?? null, issues, note: o.note ?? null, framework: o.framework ?? "other" });
}

async function report(tool: string | undefined, o: ReportOpts, io: Io): Promise<number> {
  if (o.outcome && !(OUTCOMES as readonly string[]).includes(o.outcome)) {
    io.err(`--outcome must be one of ${OUTCOMES.join(", ")}`);
    return EXIT.usage;
  }
  const badIssue = (o.issues ?? "").split(",").map((s) => s.trim()).find((s) => s && !(ISSUES as readonly string[]).includes(s));
  if (badIssue) {
    io.err(`Unknown issue "${badIssue}". Issues: ${ISSUES.join(", ")}`);
    return EXIT.usage;
  }

  if (!tool) {
    // Drafts for tools checked here recently (by `check` or an install hook), newest first.
    const list = parseNoted(io.readCache ? await io.readCache(DRAFTS_FILE).catch(() => null) : null).reverse().slice(0, 10);
    const drafts = (await Promise.all(list.map((t) => resolveDraft({ ...t, version: t.pinned }, { ...o, framework: o.framework ?? (t.via === "codex" ? "codex" : "other") }, io)))).filter((d) => d !== null);
    if (o.json) io.out(JSON.stringify(drafts.map((d) => ({ draft: d, report_url: draftUrl(o.origin, d), complete: draftComplete(d) })), null, 2));
    else if (!drafts.length) io.out("No field report drafts: no tools checked from this machine in the last 14 days.");
    else for (const d of drafts) io.out(`${draftLine(d)}\n  one-step owner link: ${draftUrl(o.origin, d)}`);
    return EXIT.ok;
  }

  const q = toQuery(tool);
  if (o.version) q.set("version", o.version);
  const c = await fetchCheck(q, o.origin, io);
  if (typeof c === "string") {
    io.err(c);
    return EXIT.error;
  }
  if (!c.known || !c.tool) {
    io.err(`The Forge doesn't know ${tool} yet, so there is no report page for it. Check the id: forge check ${tool}`);
    return EXIT.error;
  }
  const d = await resolveDraft({ id: c.tool.id, kind: c.tool.kind ?? null, version: o.version ?? c.asked_version ?? null, check_version: c.version ?? null, check_fp: typeof c.fingerprint === "string" ? c.fingerprint : null }, o, io);
  if (!d) {
    io.err(`${c.tool.id} can't take a field report.`);
    return EXIT.error;
  }
  const url = draftUrl(o.origin, d);
  const body = draftReport(d);
  if (!o.file) {
    if (o.json) io.out(JSON.stringify({ draft: d, report_url: url, complete: draftComplete(d), report: body, filed: false }, null, 2));
    else {
      io.out(draftLine(d));
      io.out(`one-step owner link: ${url}`);
      io.out("filing: not filed; owner confirmation: the one-step owner link (GitHub sign-in, one click), or --file at a terminal with FORGE_TOKEN set");
    }
    return EXIT.ok;
  }
  if (!body) {
    io.err(`Filing from here needs ${d.outcome ? "" : "--outcome and "}the exact version with its fingerprint. The one-step owner link asks for what's missing: ${url}`);
    return EXIT.usage;
  }
  const token = io.env?.FORGE_TOKEN?.trim();
  if (!token) {
    io.out(draftLine(d));
    io.out(`one-step owner link: ${url}`);
    io.out(`filing: not filed; needs a signed-in owner (FORGE_TOKEN isn't set). Connect: ${o.origin}/connect`);
    return EXIT.error;
  }
  const yes = (await io.confirm?.(`${draftLine(d)}\nFile this report on ${d.tool.id}@${d.tool.version} in your name? [y/N] `)) ?? null;
  if (yes === null) {
    io.out(draftLine(d));
    io.out(`one-step owner link: ${url}`);
    io.out("filing: not filed; owner confirmation needs a terminal (or the one-step owner link)");
    return EXIT.error;
  }
  if (!yes) {
    io.out("Not filed.");
    return EXIT.ok;
  }
  let res: Response;
  try {
    res = await io.fetch(`${o.origin}/api/v1/report`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    io.err(`Couldn't reach The Forge (${(e as Error).message}). Not filed.`);
    return EXIT.error;
  }
  const r = (await res.json().catch(() => ({}))) as { ok?: boolean; report_id?: string; counted?: boolean; reason?: string; detail?: string; page_url?: string };
  if (res.status === 401) {
    io.err(`The Forge didn't accept FORGE_TOKEN (401). Not filed. Connect: ${o.origin}/connect`);
    return EXIT.error;
  }
  if (!r.ok) {
    io.err(`Not filed: ${r.reason ?? `HTTP ${res.status}`}${r.detail ? ` (${r.detail})` : ""}.`);
    return EXIT.error;
  }
  if (o.json) io.out(JSON.stringify({ filed: true, ...r }, null, 2));
  else io.out(`filed: report ${r.report_id} (${r.counted ? "counts now" : "held for a quick review first"})${r.page_url ? ` · ${r.page_url}` : ""}`);
  return EXIT.ok;
}

async function watch(paths: string[], o: { json: boolean; origin: string }, io: Io): Promise<number> {
  const skills: LocalSkill[] = [];
  if (paths.length) {
    for (const p of paths) {
      const text = await io.readFile?.(p);
      if (text === null || text === undefined) {
        io.err(`Can't read ${p}.`);
        return EXIT.usage;
      }
      const parts = p.split(/[\\/]/).filter(Boolean);
      skills.push({ label: parts.length > 1 && /^skill\.md$/i.test(parts.at(-1)!) ? parts.at(-2)! : parts.at(-1)!, text });
    }
  } else skills.push(...((await io.skillFiles?.().catch(() => [])) ?? []));
  if (!io.sha256Hex) {
    io.err("This build can't fingerprint files.");
    return EXIT.error;
  }
  const now = nowOf(io);
  const memory = (await loadMemory(io)) ?? parseMemory(null);
  if (!skills.length && !Object.keys(memory.checks).length) {
    io.out("Nothing to watch: no SKILL.md files found and no earlier checks from this machine. Name files: forge watch path/to/SKILL.md");
    return EXIT.ok;
  }
  const r = await weeklyCheck({ origin: o.origin, fetch: io.fetch, now, memory, skills, sha256Hex: io.sha256Hex, userAgent: `${UA} (watch)`, timeoutMs: 15_000, force: true });
  if (!r) {
    io.err("Couldn't reach The Forge.");
    return EXIT.error;
  }
  await save(io, MEMORY_FILE, serializeMemory(memory, now));
  if (o.json) io.out(JSON.stringify({ lines: r.lines, flagged_skills: r.flagged, flagged_tools: r.flaggedTools }, null, 2));
  else for (const l of r.lines) io.out(l);
  return r.flagged || r.flaggedTools ? EXIT.blocked : EXIT.ok;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  /** A flag with a value; null when the value is missing. */
  const value = (name: string): string | undefined | null => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v === undefined || v.startsWith("--") ? null : v;
  };
  const json = flag("--json");
  const strict = flag("--strict");
  const noMemory = flag("--no-memory");
  const file = flag("--file");
  let origin = DEFAULT_ORIGIN;
  const oi = args.indexOf("--origin");
  if (oi >= 0) {
    origin = (args[oi + 1] ?? "").replace(/\/+$/, "");
    args.splice(oi, 2);
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      io.err("--origin must be an https:// address");
      return EXIT.usage;
    }
  }
  if (flag("--help") || flag("-h") || args.length === 0) {
    (args.length === 0 ? io.err : io.out)(HELP);
    return args.length === 0 ? EXIT.usage : EXIT.ok;
  }
  const [cmd] = args;
  if (cmd === "exposure") return exposure(args.slice(1), { json, strict, origin }, io);
  if (cmd === "hook") return hook(args.slice(1), { json, origin }, io);
  if (cmd === "watch") return watch(args.slice(1), { json, origin }, io);
  if (cmd === "report") {
    const vals = { version: value("--version"), outcome: value("--outcome"), issues: value("--issues"), note: value("--note"), framework: value("--framework") };
    const [, t, ...extra] = args;
    if (Object.values(vals).some((v) => v === null) || extra.length || t?.startsWith("-")) {
      io.err(HELP);
      return EXIT.usage;
    }
    const clean = Object.fromEntries(Object.entries(vals).filter(([, v]) => typeof v === "string")) as Partial<ReportOpts>;
    return report(t, { json, origin, file, ...clean }, io);
  }
  const [, tool, ...extra] = args;
  if (cmd !== "check" || !tool || extra.length || tool.startsWith("-")) {
    io.err(HELP);
    return EXIT.usage;
  }
  return check(tool, { json, strict, origin, memory: !noMemory }, io);
}
