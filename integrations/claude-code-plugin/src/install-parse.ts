// Finds the tools an install command would fetch, so the hook can check them before they run.
// Deliberately conservative: anything it doesn't understand is ignored (the hook never blocks on a guess).

export const MAX_IDS = 8;

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

/** "@scope/name@1.2.3" → "@scope/name"; "name@latest" → "name". Returns null for paths, URLs and git specs. */
export function npmName(spec: string): string | null {
  if (!spec || spec.startsWith("-")) return null;
  if (/^(\.{0,2}\/|~|file:|link:|workspace:|git\+|git:|https?:|ssh:)/.test(spec)) return null;
  if (/^github:/.test(spec)) return null;
  const m = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(?:@.*)?$/i.exec(spec);
  if (!m) return null;
  // "owner/repo" without @ is GitHub shorthand for npm; it isn't a registry package.
  if (!spec.startsWith("@") && spec.includes("/")) return null;
  return m[1]!.toLowerCase();
}

const NPM_INSTALL = new Set(["install", "i", "add", "isntall", "in"]);

function packagesAfter(words: string[], start: number): string[] {
  const ids: string[] = [];
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") break;
    if (w.startsWith("-")) continue;
    const name = npmName(w);
    if (name) ids.push(`npm:${name}`);
  }
  return ids;
}

/** The first non-flag word after `start`, as an npm package (for npx-style runners). */
function runnerPackage(words: string[], start: number): string[] {
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-p" || w === "--package") {
      const name = npmName(words[i + 1] ?? "");
      return name ? [`npm:${name}`] : [];
    }
    if (w.startsWith("--package=")) {
      const name = npmName(w.slice("--package=".length));
      return name ? [`npm:${name}`] : [];
    }
    if (w.startsWith("-")) continue;
    const name = npmName(w);
    return name ? [`npm:${name}`] : [];
  }
  return [];
}

function githubRepo(url: string): string | null {
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null;
}

function idsInSegment(segment: string): string[] {
  return idsInWords(shellWords(segment.trim()));
}

/** Tool ids fetched by one already-split command (e.g. an MCP config's `command` + `args`). */
export function idsInWords(input: string[]): string[] {
  let words = input;
  while (words.length && (/^\w+=/.test(words[0]!) || words[0] === "sudo" || words[0] === "env" || words[0] === "exec"))
    words = words.slice(1);
  const [cmd, sub] = words;
  if (!cmd) return [];
  switch (cmd) {
    case "npm":
      if (sub && NPM_INSTALL.has(sub)) return packagesAfter(words, 2);
      if (sub === "exec" || sub === "x") return runnerPackage(words, 2);
      return [];
    case "pnpm":
      if (sub === "add") return packagesAfter(words, 2);
      if (sub === "dlx" || sub === "exec") return runnerPackage(words, 2);
      return [];
    case "yarn":
      if (sub === "add") return packagesAfter(words, 2);
      if (sub === "dlx") return runnerPackage(words, 2);
      return [];
    case "bun":
      if (sub === "add" || sub === "install" || sub === "i") return packagesAfter(words, 2);
      if (sub === "x") return runnerPackage(words, 2);
      return [];
    case "npx":
    case "pnpx":
    case "bunx":
      return runnerPackage(words, 1);
    case "git":
      if (sub === "clone") {
        for (const w of words.slice(2)) {
          const repo = githubRepo(w);
          if (repo) return [repo];
        }
        return [];
      }
      return [];
    case "claude":
      // claude mcp add <name> [--] npx -y <pkg>  →  check the package after the runner.
      if (sub === "mcp") {
        const i = words.findIndex((w, j) => j > 1 && (w === "npx" || w === "bunx" || w === "pnpx"));
        return i > 0 ? runnerPackage(words, i + 1) : [];
      }
      return [];
    default:
      return [];
  }
}

/** All tool ids an install command would fetch (npm packages, GitHub repos), deduplicated and capped. */
export function installTargets(command: string): string[] {
  const segments = command.split(/&&|\|\||;|\||\n/);
  const ids = new Set<string>();
  for (const seg of segments) for (const id of idsInSegment(seg)) ids.add(id);
  return [...ids].slice(0, MAX_IDS);
}
