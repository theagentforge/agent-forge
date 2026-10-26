import { idsInWords } from "@forge/shared/install-parse";

// Finds the third-party tools a repository configures for its agents: MCP servers in the usual config files,
// plus anything listed by hand. Conservative like the plugin hook: anything it can't map to a Forge id is
// listed as "not checked" rather than guessed.

/** Config files the action reads by default (paths relative to the repository root). */
export const DEFAULT_CONFIGS = [
  ".mcp.json",
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".gemini/settings.json",
  ".roo/mcp.json",
  "claude_desktop_config.json",
];

export interface Found {
  /** The Forge query: `id=npm:…`, `url=https://…`, etc. */
  query: { id: string } | { url: string };
  /** Where it came from, for the summary: "file › server name". */
  source: string;
}

export interface Skipped {
  source: string;
  reason: string;
}

/** JSON with // and /* comments and trailing commas (VS Code and Cursor allow both). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i;

/** One MCP server entry → a Forge query, or why it can't be checked. */
export function serverTarget(entry: unknown): { query: Found["query"] } | { reason: string } {
  if (!isObj(entry)) return { reason: "not a server entry" };
  const url = entry.url ?? entry.serverUrl ?? entry.httpUrl;
  if (typeof url === "string") {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { reason: "URL uses a variable or isn't valid" };
    }
    if (!/^https?:$/.test(u.protocol)) return { reason: "not an http(s) URL" };
    if (LOCAL_HOST.test(u.hostname)) return { reason: "local server" };
    return { query: { url: `${u.origin}${u.pathname}`.replace(/\/+$/, "") } };
  }
  if (typeof entry.command !== "string") return { reason: "no command or url" };
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  let words = [entry.command.split(/[\\/]/).pop()!.replace(/\.(cmd|exe)$/i, ""), ...args];
  // Windows configs wrap the runner: "cmd /c npx -y pkg".
  if (words[0]?.toLowerCase() === "cmd" && words[1]?.toLowerCase() === "/c") words = words.slice(2);
  const [id] = idsInWords(words);
  if (id) return { query: { id } };
  const runner = words[0] ?? "";
  if (/^(uvx|uv|pipx|python3?|pip)$/.test(runner)) return { reason: "Python packages aren't covered by the Forge yet" };
  if (runner === "docker" || runner === "podman") return { reason: "container images aren't covered by the Forge yet" };
  return { reason: "local command" };
}

/** Every server in one parsed config file. Reads `mcpServers` (most clients) and `servers` (VS Code). */
export function serversIn(file: string, config: unknown): { found: Found[]; skipped: Skipped[] } {
  const found: Found[] = [];
  const skipped: Skipped[] = [];
  if (!isObj(config)) return { found, skipped };
  const blocks = [config.mcpServers, config.servers, isObj(config.mcp) ? config.mcp.servers : undefined];
  for (const block of blocks) {
    if (!isObj(block)) continue;
    for (const [name, entry] of Object.entries(block)) {
      const source = `${file} › ${name}`;
      const t = serverTarget(entry);
      if ("query" in t) found.push({ query: t.query, source });
      else skipped.push({ source, reason: t.reason });
    }
  }
  return { found, skipped };
}

/** A hand-listed tool (the `tools` input): same forms as the CLI. Bare names mean npm. */
export function toolTarget(tool: string): Found["query"] | null {
  const t = tool.trim();
  if (!t || t.startsWith("#")) return null;
  if (/^https?:\/\//i.test(t)) return { url: t };
  if (/^(npm:|github\.com\/|mcp-registry:)/i.test(t)) return { id: t };
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(t)) return { id: `npm:${t.toLowerCase()}` };
  return { id: t };
}

/** Same tool from several files is checked once; its sources are joined. */
export function dedupe(found: Found[]): Found[] {
  const by = new Map<string, Found>();
  for (const f of found) {
    const key = JSON.stringify(f.query);
    const prev = by.get(key);
    if (prev) prev.source += `; ${f.source}`;
    else by.set(key, { ...f });
  }
  return [...by.values()];
}
