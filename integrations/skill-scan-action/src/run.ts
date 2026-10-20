import { SCAN_MAX_BYTES, SCAN_RULES, SCAN_RULES_VERSION, scanSkill, type ScanFinding, type ScanSeverity } from "@forge/shared/skill-scan";

// The skill-scan action (ADR 0026): scans the agent instruction files in a repository (SKILL.md, AGENTS.md,
// CLAUDE.md, Cursor and Copilot rules) with the Forge's rules, on the runner. Nothing about the repository is sent
// to the Forge: the only network calls are to GitHub's own API, for the files a pull request changed and its one
// comment. Wording rule: "matches pattern X at line N", never "malicious".

export const DEFAULT_ORIGIN = "https://theagentforge.io";
export const MARKER = "<!-- forge-skill-scan -->";
export const MAX_FILES = 300;
export const DEFAULT_PATHS = [
  "**/SKILL.md",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/GEMINI.md",
  ".claude/commands/**/*.md",
  ".claude/agents/**/*.md",
  ".claude/rules/**/*.md",
  ".cursor/rules/**",
  "**/.cursorrules",
  "**/.windsurfrules",
  ".github/copilot-instructions.md",
  ".github/instructions/**/*.md",
];
export const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/vendor/**", "**/dist/**", ".claude/worktrees/**"];
export const FAIL_ON = ["high", "medium", "never"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface Inputs {
  paths: string[];
  ignore: string[];
  changedOnly: "auto" | "true" | "false";
  failOn: FailOn;
  comment: "auto" | "never";
  sarifFile: string;
  token: string;
  origin: string;
}

export interface Event {
  name: string;
  repo: string;
  apiUrl: string;
  serverUrl: string;
  sha: string;
  pr: number | null;
}

export interface Io {
  listFiles: () => string[];
  readFile: (path: string) => string | null;
  fetch: typeof fetch;
  log: (s: string) => void;
  command: (s: string) => void;
  summary: (markdown: string) => void;
  output: (name: string, value: string) => void;
  writeFile: (path: string, text: string) => void;
}

export interface FileResult {
  path: string;
  findings: ScanFinding[];
  suppressed: number;
}

/** Reads `INPUT_*` variables the way GitHub passes action inputs. */
export function readInputs(env: Record<string, string | undefined>): Inputs | string {
  const get = (name: string) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const lines = (v: string) => v.split(/[\n,]/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  const failOn = (get("fail-on") || "high") as FailOn;
  if (!FAIL_ON.includes(failOn)) return `fail-on must be one of ${FAIL_ON.join(", ")}`;
  const changedOnly = (get("changed-only") || "auto") as Inputs["changedOnly"];
  if (!["auto", "true", "false"].includes(changedOnly)) return "changed-only must be auto, true or false";
  const comment = (get("comment") || "auto") as Inputs["comment"];
  if (!["auto", "never"].includes(comment)) return "comment must be auto or never";
  const origin = (get("origin") || DEFAULT_ORIGIN).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return "origin must be an https:// address";
  const paths = get("paths");
  return {
    paths: paths ? lines(paths) : DEFAULT_PATHS,
    ignore: [...DEFAULT_IGNORE, ...lines(get("ignore"))],
    changedOnly,
    failOn,
    comment,
    sarifFile: get("sarif-file"),
    token: get("github-token"),
    origin,
  };
}

/** A glob as used in `paths`: `**` crosses folders, `*` and `?` stay inside one. Matched against repo-relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matcher = (globs: string[]) => {
  const res = globs.map(globToRegExp);
  return (path: string) => res.some((r) => r.test(path));
};

/**
 * A line saying `forge-scan: ignore` (optionally with rule ids, e.g. `forge-scan: ignore FS-DES-001`) silences
 * findings on that line and the next one: for guardrail lists that quote the very commands they forbid.
 */
export function suppressions(text: string): Map<number, Set<string> | "all"> {
  const out = new Map<number, Set<string> | "all">();
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /forge-scan:\s*ignore\b([^\n]*)/i.exec(line);
    if (!m) return;
    const ids = [...(m[1] ?? "").matchAll(/FS-[A-Z]{3}-\d{3}/g)].map((x) => x[0]);
    for (const n of [i + 1, i + 2]) out.set(n, ids.length ? new Set(ids) : "all");
  });
  return out;
}

export async function scanFile(path: string, text: string): Promise<FileResult> {
  const r = await scanSkill(text);
  const quiet = suppressions(text);
  const findings = r.findings.filter((f) => {
    const s = quiet.get(f.line);
    return !(s === "all" || s?.has(f.rule));
  });
  return { path, findings, suppressed: r.findings.length - findings.length };
}

const RANK: Record<ScanSeverity, number> = { high: 3, medium: 2, low: 1 };
const blocks = (f: ScanFinding, failOn: FailOn) => failOn !== "never" && RANK[f.severity] >= RANK[failOn];
const LEVEL: Record<ScanSeverity, "error" | "warning" | "notice"> = { high: "error", medium: "warning", low: "notice" };
const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

async function gh(event: Event, token: string, io: Io, method: string, path: string, body?: unknown) {
  const res = await io.fetch(`${event.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "theagentforge-skill-scan/1", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

/** The files a pull request changed (added or modified), or null if GitHub won't say. */
async function changedFiles(event: Event, token: string, io: Io): Promise<string[] | null> {
  if (!event.pr || !token) return null;
  const out: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh(event, token, io, "GET", `/repos/${event.repo}/pulls/${event.pr}/files?per_page=100&page=${page}`).catch(() => null);
    if (!res?.ok) return null;
    const files = (await res.json()) as { filename: string; status: string }[];
    out.push(...files.filter((f) => f.status !== "removed").map((f) => f.filename));
    if (files.length < 100) break;
  }
  return out;
}

export function commentBody(results: FileResult[], scanned: number, inputs: Inputs, event: Event, failed: boolean) {
  const all = results.flatMap((r) => r.findings.map((f) => ({ ...f, path: r.path })));
  const count = (s: ScanSeverity) => all.filter((f) => f.severity === s).length;
  const fileUrl = (p: string, line: number) => `${event.serverUrl}/${event.repo}/blob/${event.sha}/${p.split("/").map(encodeURIComponent).join("/")}#L${line}`;
  const head = all.length
    ? `**Forge skill scan** · ${scanned} file${scanned === 1 ? "" : "s"} · ${all.length} finding${all.length === 1 ? "" : "s"} (${count("high")} high, ${count("medium")} medium, ${count("low")} low)${failed ? " · this check fails on " + inputs.failOn + (inputs.failOn === "high" ? "" : " and above") : ""}`
    : `**Forge skill scan** · ${scanned} file${scanned === 1 ? "" : "s"} · no known risky patterns`;
  const rows = all
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, 50)
    .map((f) => `| [\`${cell(f.path)}:${f.line}\`](${fileUrl(f.path, f.line)}) | ${cell(f.title)} ([${f.rule}](${inputs.origin}/scan/rules#${f.rule})) | ${f.severity} |`);
  return [
    MARKER,
    head,
    "",
    ...(rows.length ? ["| File | Pattern | Severity |", "|---|---|---|", ...rows, ...(all.length > 50 ? [`| … | ${all.length - 50} more in the job summary | |`] : []), ""] : []),
    all.length
      ? `A match is a reason to read the line, not a verdict on its author. Quoting a pattern on purpose (a guardrail list, say)? Add \`forge-scan: ignore FS-XXX-000\` on that line or the line above.`
      : `Agent instruction files in this PR matched none of the ${SCAN_RULES.length} rules. That isn't a guarantee.`,
    "",
    `<sub>Scanned on the runner with [The Agent Forge](${inputs.origin}/scan?from=skill-scan-action) skill-scan rules ${SCAN_RULES_VERSION}; no file left GitHub. [The rules](${inputs.origin}/scan/rules?from=skill-scan-action) · [Check any skill or MCP server](${inputs.origin}/scan?from=skill-scan-action)</sub>`,
  ].join("\n");
}

/** One comment per pull request, edited in place; posted only when there's something to say or to clear. */
async function upsertComment(body: string, hasFindings: boolean, event: Event, inputs: Inputs, io: Io) {
  if (inputs.comment === "never" || !event.pr || !inputs.token) return "skipped";
  let existing: { id: number } | undefined;
  for (let page = 1; page <= 5 && !existing; page++) {
    const res = await gh(event, inputs.token, io, "GET", `/repos/${event.repo}/issues/${event.pr}/comments?per_page=100&page=${page}`).catch(() => null);
    if (!res?.ok) return "no access";
    const list = (await res.json()) as { id: number; body?: string }[];
    existing = list.find((c) => c.body?.startsWith(MARKER));
    if (list.length < 100) break;
  }
  if (!existing && !hasFindings) return "nothing to say";
  const res = existing
    ? await gh(event, inputs.token, io, "PATCH", `/repos/${event.repo}/issues/comments/${existing.id}`, { body }).catch(() => null)
    : await gh(event, inputs.token, io, "POST", `/repos/${event.repo}/issues/${event.pr}/comments`, { body }).catch(() => null);
  // A fork's pull request gets a read-only token: the annotations and job summary still carry the result.
  return res?.ok ? (existing ? "updated" : "posted") : "no access";
}

export function sarif(results: FileResult[], origin: string) {
  const used = new Set(results.flatMap((r) => r.findings.map((f) => f.rule)));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Forge skill scan",
            informationUri: `${origin}/scan/rules`,
            version: SCAN_RULES_VERSION,
            rules: SCAN_RULES.filter((r) => used.has(r.id)).map((r) => ({
              id: r.id,
              name: r.id.replace(/-/g, ""),
              shortDescription: { text: r.title },
              fullDescription: { text: r.why },
              helpUri: `${origin}/scan/rules#${r.id}`,
              defaultConfiguration: { level: LEVEL[r.severity] === "notice" ? "note" : LEVEL[r.severity] },
            })),
          },
        },
        results: results.flatMap((r) =>
          r.findings.map((f) => ({
            ruleId: f.rule,
            level: LEVEL[f.severity] === "notice" ? "note" : LEVEL[f.severity],
            message: { text: `${f.title}. ${f.why}` },
            locations: [{ physicalLocation: { artifactLocation: { uri: r.path }, region: { startLine: f.line, startColumn: f.column } } }],
          })),
        ),
      },
    ],
  };
}

export async function run(inputs: Inputs, event: Event, io: Io): Promise<number> {
  const wanted = matcher(inputs.paths);
  const ignored = matcher(inputs.ignore);
  const onPr = event.pr !== null;
  const changedOnly = inputs.changedOnly === "true" || (inputs.changedOnly === "auto" && onPr);
  let candidates = io.listFiles();
  let scope = "every matching file";
  if (changedOnly) {
    const changed = await changedFiles(event, inputs.token, io);
    if (changed) {
      const set = new Set(changed);
      candidates = candidates.filter((p) => set.has(p));
      scope = "files this pull request changed";
    } else io.log("Couldn't list the pull request's files, so every matching file is scanned.");
  }
  const paths = candidates.filter((p) => wanted(p) && !ignored(p)).sort().slice(0, MAX_FILES);
  const results: FileResult[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    const text = io.readFile(p);
    if (text === null || text.length > SCAN_MAX_BYTES || text.includes("\u0000")) {
      skipped.push(p);
      continue;
    }
    results.push(await scanFile(p, text));
  }
  const all = results.flatMap((r) => r.findings.map((f) => ({ ...f, path: r.path })));
  for (const f of all)
    io.command(`::${LEVEL[f.severity]} file=${escProp(f.path)},line=${f.line},col=${f.column},title=${escProp(`Forge ${f.rule}: ${f.title}`)}::${esc(`${f.why} A match is a reason to read the line, not a verdict. ${inputs.origin}/scan/rules#${f.rule}`)}`);
  const failed = all.some((f) => blocks(f, inputs.failOn));
  const body = commentBody(results, results.length, inputs, event, failed);
  const posted = await upsertComment(body, all.length > 0, event, inputs, io);
  if (inputs.sarifFile) io.writeFile(inputs.sarifFile, JSON.stringify(sarif(results, inputs.origin), null, 2));

  const perFile = results.filter((r) => r.findings.length).map((r) => `| \`${cell(r.path)}\` | ${r.findings.map((f) => `${f.rule} (line ${f.line}, ${f.severity})`).join(", ")} |`);
  io.summary(
    [
      `## Forge skill scan`,
      "",
      `Scanned ${results.length} agent instruction file${results.length === 1 ? "" : "s"} (${scope}) with rules ${SCAN_RULES_VERSION}, on the runner.`,
      "",
      ...(perFile.length ? ["| File | Findings |", "|---|---|", ...perFile, ""] : ["No known risky patterns.", ""]),
      ...(skipped.length ? [`Not scanned (unreadable, binary or over 256 KB): ${skipped.map((s) => `\`${s}\``).join(", ")}`, ""] : []),
      ...(results.some((r) => r.suppressed) ? [`Silenced with \`forge-scan: ignore\`: ${results.reduce((n, r) => n + r.suppressed, 0)}.`, ""] : []),
      `Rules: ${inputs.origin}/scan/rules · Check any skill: ${inputs.origin}/scan?from=skill-scan-action`,
      "",
    ].join("\n"),
  );
  const count = (s: ScanSeverity) => String(all.filter((f) => f.severity === s).length);
  io.output("files", String(results.length));
  io.output("high", count("high"));
  io.output("medium", count("medium"));
  io.output("low", count("low"));
  io.output("verdict", all.some((f) => f.severity === "high") ? "flagged" : all.some((f) => f.severity === "medium") ? "caution" : "clear");
  io.log(`Forge skill scan: ${results.length} files, ${all.length} findings; comment ${posted}.`);
  return failed ? 1 : 0;
}
