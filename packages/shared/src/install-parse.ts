// Finds the tools an install command would fetch, and the exact version when the command pins one, so the install
// hooks (Claude Code plugin, CLI `hook`) and the GitHub Action can check them before they run. The version matters:
// a published malicious-package advisory only counts as "flagged" for the versions it names.
// No dependencies (no zod), so it bundles small. Deliberately conservative: anything it doesn't understand is
// ignored (the hook never blocks on a guess).

export const MAX_IDS = 8;

/** A tool an install command fetches: a Forge id, plus the exact version when the command pins one. */
export interface InstallRef {
  id: string;
  version?: string;
}

/** Splits a shell line into words, honouring simple quotes. Not a full shell parser. */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
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

/** npm exact versions only ("1.2.3", "1.2.3-beta.1"); "1", "^1.2" or "latest" are ranges and tags, not versions. */
const NPM_EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A PEP 440 version as pinned with "==" (no wildcards, no epochs). */
const PY_EXACT = /^\d+(?:\.\d+)*(?:[-_.]?(?:a|b|rc|alpha|beta|c|pre|preview|post|rev|r|dev)[-_.]?\d*)*(?:\+[0-9A-Za-z.]+)?$/i;

/** "@scope/name@1.2.3" → { name: "@scope/name", version: "1.2.3" }; "name@latest" → { name: "name" }. Null for paths, URLs and git specs. */
export function npmSpec(spec: string): { name: string; version?: string } | null {
  if (!spec || spec.startsWith("-")) return null;
  if (/^(\.{0,2}\/|~|file:|link:|workspace:|git\+|git:|https?:|ssh:)/.test(spec)) return null;
  if (/^github:/.test(spec)) return null;
  const m = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(?:@(.*))?$/i.exec(spec);
  if (!m) return null;
  // "owner/repo" without @ is GitHub shorthand for npm; it isn't a registry package.
  if (!spec.startsWith("@") && spec.includes("/")) return null;
  const version = m[2]?.replace(/^=/, "");
  return { name: m[1]!.toLowerCase(), ...(version && NPM_EXACT.test(version) ? { version } : {}) };
}

/** "@scope/name@1.2.3" → "@scope/name"; "name@latest" → "name". Returns null for paths, URLs and git specs. */
export const npmName = (spec: string): string | null => npmSpec(spec)?.name ?? null;

/**
 * A Python requirement as typed on the command line: "litellm==1.107.0" → { name: "litellm", version: "1.107.0" };
 * "Foo_Bar[extra]>=2" → { name: "foo-bar" } (PEP 503 name; a range isn't a version). uvx-style "ruff@0.6.0" is read
 * too. Null for paths, URLs, archives and anything else that isn't a plain requirement.
 */
export function pySpec(spec: string): { name: string; version?: string } | null {
  if (!spec || spec.startsWith("-") || /[/\\:]/.test(spec) || /\.(whl|zip|tar\.gz|tgz)$/i.test(spec)) return null;
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[A-Za-z0-9,._ -]*\])?\s*(?:(===?|@)\s*([^;\s]+)|(?:[<>!~]=?|=)[^;]*)?\s*(?:;.*)?$/.exec(spec);
  if (!m) return null;
  const name = m[1]!.toLowerCase().replace(/[-_.]+/g, "-");
  const version = m[3];
  return { name, ...(version && PY_EXACT.test(version) ? { version } : {}) };
}

const npmRef = (spec: string): InstallRef[] => {
  const s = npmSpec(spec);
  return s ? [{ id: `npm:${s.name}`, ...(s.version ? { version: s.version } : {}) }] : [];
};
const pyRef = (spec: string): InstallRef[] => {
  const s = pySpec(spec);
  return s ? [{ id: `pypi:${s.name}`, ...(s.version ? { version: s.version } : {}) }] : [];
};

const NPM_INSTALL = new Set(["install", "i", "add", "isntall", "in"]);

/** pip / uv / pipx options that take a value, so the value isn't read as a package. */
const PY_VALUE_FLAGS = new Set([
  "-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "--index",
  "--default-index", "-f", "--find-links", "-t", "--target", "--prefix", "--root", "--src", "-p", "--python",
  "--python-version", "--platform", "--implementation", "--abi", "--only-binary", "--no-binary", "--upgrade-strategy",
  "--progress-bar", "--log", "--cache-dir", "--cert", "--client-cert", "--proxy", "--retries", "--timeout",
  "--trusted-host", "--group", "--optional", "--extra", "--package", "--with", "--with-editable", "--with-requirements",
  "--directory", "--project", "--config-file", "--suffix", "--pip-args", "--index-strategy", "--keyring-provider",
]);

function packagesAfter(words: string[], start: number, ref: (spec: string) => InstallRef[], valueFlags?: Set<string>): InstallRef[] {
  const refs: InstallRef[] = [];
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") break;
    if (w.startsWith("-")) {
      if (valueFlags?.has(w)) i++;
      continue;
    }
    refs.push(...ref(w));
  }
  return refs;
}

/** The first non-flag word after `start`, as an npm package (for npx-style runners). */
function runnerPackage(words: string[], start: number): InstallRef[] {
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-p" || w === "--package") return npmRef(words[i + 1] ?? "");
    if (w.startsWith("--package=")) return npmRef(w.slice("--package=".length));
    if (w.startsWith("-")) continue;
    return npmRef(w);
  }
  return [];
}

/** The package a Python runner fetches: `uvx --from pkg cmd`, `pipx run --spec pkg cmd`, or the first word. */
function pyRunnerPackage(words: string[], start: number): InstallRef[] {
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
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

function githubRepo(url: string): string | null {
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null;
}

/** The tools fetched by one already-split command (e.g. an MCP config's `command` + `args`), with pinned versions. */
export function refsInWords(input: string[]): InstallRef[] {
  let words = input;
  while (words.length && (/^\w+=/.test(words[0]!) || words[0] === "sudo" || words[0] === "env" || words[0] === "exec"))
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
      // python -m pip install <pkg>
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
      // claude mcp add <name> [--] npx -y <pkg>  →  check the package after the runner (uvx for Python servers).
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

/**
 * npm and GitHub ids fetched by one already-split command, without versions. Used by the GitHub Action, which
 * reports Python packages separately; the install hooks use `installRefs`.
 */
export function idsInWords(input: string[]): string[] {
  return refsInWords(input)
    .map((r) => r.id)
    .filter((id) => !id.startsWith("pypi:"));
}

/** Every tool an install command would fetch (npm and PyPI packages, GitHub repos) with pinned versions, deduplicated and capped. */
export function installRefs(command: string): InstallRef[] {
  const seen = new Map<string, InstallRef>();
  for (const seg of command.split(/&&|\|\||;|\||\n/))
    for (const r of refsInWords(shellWords(seg.trim()))) seen.set(`${r.id}@${r.version ?? ""}`, r);
  return [...seen.values()].slice(0, MAX_IDS);
}

/** The ids of `installRefs` (versions dropped), deduplicated and capped. */
export function installTargets(command: string): string[] {
  return [...new Set(installRefs(command).map((r) => r.id))].slice(0, MAX_IDS);
}

/** The /api/v1/check query for one ref: `id=…`, plus `version=…` when the command pinned one. */
export const checkParams = (r: InstallRef) => new URLSearchParams(r.version ? { id: r.id, version: r.version } : { id: r.id });
