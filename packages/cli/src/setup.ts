import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { PRIVACY_INSTALL_ID_URL } from "@forge/shared/light";
import { hookConfig, type HookClient } from "./hook";

// `forge setup` (ADR 0119): finds the AI clients on this machine and, after a yes per item, adds the read-only Forge
// MCP server (/mcp/public, no account) and, where the client takes one, the install-check hook. It sends nothing over
// the network. Every edited file is backed up first (<file>.forge-bak) and listed in a manifest in the CLI's settings
// folder, so `forge setup --undo` puts back exactly what was there. Existing servers are never removed or changed;
// a file that doesn't parse is left alone.
//
// Each client's config path and format, from its own docs (read 29 Oct 2026):
//   Claude Code     https://code.claude.com/docs/en/mcp (user scope lives in ~/.claude.json, which Claude Code rewrites
//                   itself, so setup runs Claude Code's own `claude mcp add --scope user --transport http` instead
//                   of editing it; the same command /connect gives). Plugin: /plugin marketplace add + /plugin install.
//                   CLAUDE_CONFIG_DIR (https://code.claude.com/docs/en/env-vars) moves the config folder; Claude Code
//                   then keeps .claude.json and plugins/ inside it. Setup only reads those two (the command it runs
//                   inherits the same environment, so it writes to the same place).
//   Claude Desktop  remote servers are added as custom connectors (Settings → Connectors), not in
//                   claude_desktop_config.json, which only starts local commands: setup prints the steps only.
//   Cursor          https://cursor.com/docs/mcp: ~/.cursor/mcp.json, { "mcpServers": { name: { "url": … } } }
//   VS Code         https://code.visualstudio.com/docs/agents/reference/mcp-configuration: mcp.json in the user
//                   profile folder (Code/User), { "servers": { name: { "type": "http", "url": … } } }; JSONC.
//   Windsurf        https://docs.windsurf.com/windsurf/cascade/mcp: ~/.codeium/windsurf/mcp_config.json,
//                   { "mcpServers": { name: { "serverUrl": … } } }
//   Codex CLI       https://developers.openai.com/codex/mcp and codex-rs/core/config.schema.json (RawMcpServerConfig
//                   `url`): ~/.codex/config.toml (CODEX_HOME overrides), [mcp_servers.<name>] url = "…". Hooks:
//                   ~/.codex/hooks.json (see hook.ts; the `hooks` feature is stable and on by default,
//                   codex-rs/features/src/lib.rs). A new user hook isn't trusted until approved in Codex's /hooks
//                   (hook_trust_status in codex-rs/hooks/src/engine/discovery.rs), so setup says so after adding it.
//   Gemini CLI      https://geminicli.com/docs/tools/mcp-server: ~/.gemini/settings.json, mcpServers.<name>.httpUrl
//                   (streamable HTTP; `url` means SSE). Comments allowed (strip-json-comments in
//                   packages/cli/src/config/settings.ts). Hooks: same file, hooks.BeforeTool (docs/hooks/index.md).
//   Copilot CLI     https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers:
//                   ~/.copilot/mcp-config.json, { "mcpServers": { name: { "type": "http", "url": …, "tools": ["*"] } } }.
//                   Hooks: ~/.copilot/hooks/agent-forge.json (see hook.ts). COPILOT_HOME replaces ~/.copilot
//                   (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference).
//   Cline           https://docs.cline.bot/mcp/connecting-to-a-remote-server: cline_mcp_settings.json,
//                   { "mcpServers": { name: { "type": "streamableHttp", "url": … } } }; that page also documents
//                   CLINE_MCP_SETTINGS_PATH for the file itself. CLI: ~/.cline/data/settings/; CLINE_DIR replaces
//                   ~/.cline and CLINE_DATA_DIR replaces ~/.cline/data (https://docs.cline.bot/cline-cli/configuration).
//                   VS Code extension: Code/User/globalStorage/saoudrizwan.claude-dev/settings/.
//   LM Studio       https://lmstudio.ai/docs/app/mcp: ~/.lmstudio/mcp.json, Cursor's notation ({ "url": … }).
//   Goose           config.yaml: YAML, which setup doesn't edit; it prints the one-click link /connect gives.

export const SETUP_MANIFEST = "setup-manifest.json";
export const SERVER_NAME = "forge";
/** The Claude Code plugin's id. Renamed from `forge@theagentforge` in plugin 0.8.0 (ADR 0121). */
export const PLUGIN_ID = "theagentforge@theagentforge";
/** Ids that count as the plugin being installed: the current one and the name before the rename. */
export const PLUGIN_IDS = [PLUGIN_ID, "forge@theagentforge"] as const;

/** Which of PLUGIN_IDS Claude Code's installed_plugins.json lists, if any (the current id first). */
export function installedPluginId(pluginList: string | null): string | null {
  if (!pluginList) return null;
  let keys: string[];
  try {
    const plugins = (JSON.parse(pluginList) as { plugins?: unknown }).plugins;
    keys = plugins && typeof plugins === "object" ? Object.keys(plugins) : [];
  } catch {
    // Not JSON we can read: fall back to the exact quoted key.
    return PLUGIN_IDS.find((id) => pluginList.includes(`"${id}"`)) ?? null;
  }
  return PLUGIN_IDS.find((id) => keys.includes(id)) ?? null;
}

type Json = Record<string, unknown>;
type Format = "json" | "jsonc" | "toml";
type Kind = "mcp" | "hook";

/** What one item would do to its file's text. */
export type Edit = { status: "add"; text: string; preview: string } | { status: "present"; reason: string } | { status: "skip"; reason: string };

interface FileItem {
  kind: Kind;
  file: string;
  format: Format;
  /** null when the file doesn't exist yet. */
  edit(text: string | null): Edit;
}

export interface ClientDef {
  id: string;
  name: string;
  /** Any of these existing means the client is installed. */
  markers: string[];
  items: FileItem[];
  /** Claude Code: run its own command instead of editing its state file. */
  command?: { add: string[]; remove: string[]; state: string; pluginList: string };
  /** Printed only: steps for a client whose config setup doesn't edit. */
  manual?: string;
}

export interface SetupContext {
  home: string;
  platform: string;
  env: Record<string, string | undefined>;
  origin: string;
  /** Whether the Forge's default address is in use (then hook commands carry no --origin). */
  defaultOrigin: boolean;
}

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

function vscodeUser(c: SetupContext): string {
  if (c.platform === "darwin") return join(c.home, "Library", "Application Support", "Code", "User");
  if (c.platform === "win32") return join(c.env.APPDATA || join(c.home, "AppData", "Roaming"), "Code", "User");
  const xdg = c.env.XDG_CONFIG_HOME && isAbsolute(c.env.XDG_CONFIG_HOME) ? c.env.XDG_CONFIG_HOME : join(c.home, ".config");
  return join(xdg, "Code", "User");
}

function claudeDesktop(c: SetupContext): string {
  if (c.platform === "darwin") return join(c.home, "Library", "Application Support", "Claude");
  if (c.platform === "win32") return join(c.env.APPDATA || join(c.home, "AppData", "Roaming"), "Claude");
  return join(c.home, ".config", "Claude");
}

function gooseDir(c: SetupContext): string {
  if (c.platform === "win32") return join(c.env.APPDATA || join(c.home, "AppData", "Roaming"), "Block", "goose", "config");
  const xdg = c.env.XDG_CONFIG_HOME && isAbsolute(c.env.XDG_CONFIG_HOME) ? c.env.XDG_CONFIG_HOME : join(c.home, ".config");
  return join(xdg, "goose");
}

function indentOf(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const m = /^([ \t]+)["}\]]/m.exec(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (m?.[1]?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: m?.[1]?.length || 2, eol };
}

/** Parses a JSON (or JSONC) config. An empty file counts as {}. */
function parseConfig(text: string | null, format: "json" | "jsonc"): { root: Json; text: string } | { error: string } {
  const src = text ?? "";
  if (!src.trim()) return { root: {}, text: "" };
  const errors: ParseError[] = [];
  const root = parse(src, errors, { disallowComments: format === "json", allowTrailingComma: format === "jsonc", allowEmptyContent: false });
  if (errors.length) {
    const code = printParseErrorCode(errors[0]!.error);
    return { error: code === "InvalidCommentToken" ? "the file has comments, which this client's docs don't allow in it" : `the file isn't valid JSON (${code} at offset ${errors[0]!.offset})` };
  }
  if (!obj(root)) return { error: "the file's top level isn't a JSON object" };
  return { root: root as Json, text: src };
}

/** Sets `path` to `value` in the text, keeping comments and layout, and checks the result parses. */
function setAt(text: string, path: (string | number)[], value: unknown, format: "json" | "jsonc", arrayInsert = false): string {
  if (!text.trim()) {
    // A new file: build the object from the path.
    let v: unknown = value;
    for (let i = path.length - 1; i >= 0; i--) v = typeof path[i] === "number" ? [v] : { [path[i] as string]: v };
    return `${JSON.stringify(v, null, 2)}\n`;
  }
  const f = indentOf(text);
  const out = applyEdits(text, modify(text, path, value, { formattingOptions: f, isArrayInsertion: arrayInsert }));
  const check = parseConfig(out, format);
  if ("error" in check) throw new Error(`edit gave invalid JSON (${check.error})`);
  return out;
}

const URL_KEYS = ["url", "serverUrl", "httpUrl"];
const BOM = "\uFEFF";

/** A file saved with a byte-order mark (some Windows editors add one) is edited without it, and keeps it. */
function keepBom(edit: (text: string | null) => Edit) {
  return (text: string | null): Edit => {
    if (!text?.startsWith(BOM)) return edit(text);
    const r = edit(text.slice(BOM.length));
    return r.status === "add" ? { ...r, text: BOM + r.text } : r;
  };
}

/** Adds `forge` under the servers key, unless the Forge is already there or the name is taken. */
function mcpJsonEdit(serversKey: string, entry: Json, format: "json" | "jsonc", c: SetupContext) {
  return keepBom((text: string | null): Edit => {
    const p = parseConfig(text, format);
    if ("error" in p) return { status: "skip", reason: p.error };
    const existing = p.root[serversKey];
    if (existing !== undefined && !obj(existing)) return { status: "skip", reason: `"${serversKey}" isn't an object` };
    for (const [name, v] of Object.entries(obj(existing) ?? {})) {
      const s = obj(v);
      const url = URL_KEYS.map((k) => s?.[k]).find((u) => typeof u === "string") as string | undefined;
      if (url && (url === `${c.origin}/mcp` || url.startsWith(`${c.origin}/mcp/`) || url.startsWith(`${c.origin}/mcp?`))) return { status: "present", reason: `already set up as "${name}"` };
    }
    if (obj(existing) && Object.hasOwn(obj(existing)!, SERVER_NAME)) return { status: "skip", reason: `a different server is already named "${SERVER_NAME}"; it is left as it is` };
    try {
      return { status: "add", text: setAt(p.text, [serversKey, SERVER_NAME], entry, format), preview: JSON.stringify({ [serversKey]: { [SERVER_NAME]: entry } }, null, 2) };
    } catch (e) {
      return { status: "skip", reason: (e as Error).message };
    }
  });
}

/** Appends one hook entry to an array in a JSON(C) file, unless a Forge hook for this client is already there. */
function hookJsonEdit(client: HookClient, arrayPath: string[], format: "json" | "jsonc", c: SetupContext) {
  const cfg = hookConfig(client, c.defaultOrigin ? undefined : c.origin).config;
  let entry: unknown = cfg;
  for (const k of arrayPath) entry = (entry as Json)[k];
  const item = (entry as unknown[])[0];
  return keepBom((text: string | null): Edit => {
    const p = parseConfig(text, format);
    if ("error" in p) return { status: "skip", reason: p.error };
    if (p.text.includes(`@theagentforge/cli hook ${client}`)) return { status: "present", reason: "the Forge install check is already there" };
    // Walk to the array, creating what's missing.
    let node: unknown = p.root;
    for (let i = 0; i < arrayPath.length; i++) {
      const next = obj(node)?.[arrayPath[i]!];
      if (next === undefined) {
        const rest = arrayPath.slice(i + 1);
        let v: unknown = [item];
        for (let j = rest.length - 1; j >= 0; j--) v = { [rest[j]!]: v };
        return add(p.text, arrayPath.slice(0, i + 1), v);
      }
      if (i < arrayPath.length - 1 && !obj(next)) return { status: "skip", reason: `"${arrayPath.slice(0, i + 1).join(".")}" isn't an object` };
      node = next;
    }
    if (!Array.isArray(node)) return { status: "skip", reason: `"${arrayPath.join(".")}" isn't a list` };
    return add(p.text, [...arrayPath, node.length], item, true);
    function add(t: string, path: (string | number)[], value: unknown, arrayInsert = false): Edit {
      try {
        return { status: "add", text: setAt(t, path, value, format, arrayInsert), preview: JSON.stringify(cfg, null, 2) };
      } catch (e) {
        return { status: "skip", reason: (e as Error).message };
      }
    }
  });
}

/** Copilot CLI reads every .json in ~/.copilot/hooks, so the hook gets a file of its own. */
function ownFileEdit(client: HookClient, c: SetupContext) {
  const cfg = hookConfig(client, c.defaultOrigin ? undefined : c.origin).config;
  return (text: string | null): Edit => {
    if (text === null || !text.trim()) return { status: "add", text: `${JSON.stringify(cfg, null, 2)}\n`, preview: JSON.stringify(cfg, null, 2) };
    if (text.includes(`@theagentforge/cli hook ${client}`)) return { status: "present", reason: "the Forge install check is already there" };
    return { status: "skip", reason: "the file exists with other content; it is left as it is" };
  };
}

/**
 * Codex's config.toml: setup only appends a new [mcp_servers.forge] table at the end and never touches existing lines.
 * It skips the file when a server named forge (in any TOML spelling it can recognise) or an inline mcp_servers table
 * is there, or when the file ends inside a multi-line string.
 */
export function codexTomlEdit(c: SetupContext) {
  const pub = `${c.origin}/mcp/public`;
  return (text: string | null): Edit => {
    const t = text ?? "";
    const nl = t.includes("\r\n") ? "\r\n" : "\n";
    const block = `[mcp_servers.${SERVER_NAME}]${nl}url = "${pub}"${nl}`;
    if (t.includes(`"${c.origin}/mcp`) || t.includes(`'${c.origin}/mcp`)) return { status: "present", reason: "a server with the Forge's address is already there" };
    if (/^\s*\[\s*mcp_servers\s*\.\s*(forge|"forge"|'forge')\s*[\].]/m.test(t) || /^\s*mcp_servers\s*\.\s*(forge|"forge"|'forge')\s*[.=]/m.test(t)) return { status: "skip", reason: `a server named "${SERVER_NAME}" is already there; it is left as it is` };
    if (/^\s*mcp_servers\s*=/m.test(t) || /^\s*(forge|"forge"|'forge')\s*[.=]/m.test(t)) return { status: "skip", reason: "the file defines mcp_servers in a form setup doesn't edit" };
    if ((t.split('"""').length - 1) % 2 || (t.split("'''").length - 1) % 2) return { status: "skip", reason: "the file isn't valid TOML (an unclosed multi-line string)" };
    const sep = !t ? "" : t.endsWith(nl + nl) ? "" : t.endsWith(nl) ? nl : nl + nl;
    return { status: "add", text: `${t}${sep}${block}`, preview: block.trimEnd() };
  };
}

export function clientDefs(c: SetupContext): ClientDef[] {
  const pub = `${c.origin}/mcp/public`;
  const h = c.home;
  const codexHome = c.env.CODEX_HOME && isAbsolute(c.env.CODEX_HOME) ? c.env.CODEX_HOME : join(h, ".codex");
  const vs = vscodeUser(c);
  const abs = (v: string | undefined) => (v && isAbsolute(v) ? v : null);
  const clineDir = abs(c.env.CLINE_DIR) ?? join(h, ".cline");
  const clineData = abs(c.env.CLINE_DATA_DIR) ?? join(clineDir, "data");
  const clineCli = abs(c.env.CLINE_MCP_SETTINGS_PATH) ?? join(clineData, "settings", "cline_mcp_settings.json");
  const copilot = abs(c.env.COPILOT_HOME) ?? join(h, ".copilot");
  const claudeDir = abs(c.env.CLAUDE_CONFIG_DIR);
  const claudeState = claudeDir ? join(claudeDir, ".claude.json") : join(h, ".claude.json");
  const claudePlugins = join(claudeDir ?? join(h, ".claude"), "plugins", "installed_plugins.json");
  const clineExt = join(vs, "globalStorage", "saoudrizwan.claude-dev");
  const mcp = (file: string, format: "json" | "jsonc", key: string, entry: Json): FileItem => ({ kind: "mcp", file, format, edit: mcpJsonEdit(key, entry, format, c) });
  const gemini = join(h, ".gemini", "settings.json");
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      markers: claudeDir ? [claudeDir] : [join(h, ".claude.json"), join(h, ".claude")],
      items: [],
      command: {
        add: ["claude", "mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, pub],
        remove: ["claude", "mcp", "remove", "--scope", "user", SERVER_NAME],
        state: claudeState,
        pluginList: claudePlugins,
      },
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      markers: [claudeDesktop(c)],
      items: [],
      manual: `Claude Desktop takes remote servers as custom connectors, not in its config file. In Claude: Settings → Connectors → Add custom connector, name "The Agent Forge", address ${pub} (no sign-in).`,
    },
    { id: "cursor", name: "Cursor", markers: [join(h, ".cursor")], items: [mcp(join(h, ".cursor", "mcp.json"), "json", "mcpServers", { url: pub })] },
    { id: "vscode", name: "VS Code", markers: [vs], items: [mcp(join(vs, "mcp.json"), "jsonc", "servers", { type: "http", url: pub })] },
    { id: "windsurf", name: "Windsurf", markers: [join(h, ".codeium", "windsurf")], items: [mcp(join(h, ".codeium", "windsurf", "mcp_config.json"), "json", "mcpServers", { serverUrl: pub })] },
    {
      id: "codex",
      name: "Codex CLI",
      markers: [codexHome],
      items: [
        { kind: "mcp", file: join(codexHome, "config.toml"), format: "toml", edit: codexTomlEdit(c) },
        { kind: "hook", file: join(codexHome, "hooks.json"), format: "json", edit: hookJsonEdit("codex", ["hooks", "PreToolUse"], "json", c) },
      ],
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      markers: [join(h, ".gemini")],
      items: [mcp(gemini, "jsonc", "mcpServers", { httpUrl: pub }), { kind: "hook", file: gemini, format: "jsonc", edit: hookJsonEdit("gemini", ["hooks", "BeforeTool"], "jsonc", c) }],
    },
    {
      id: "copilot",
      name: "Copilot CLI",
      markers: [copilot],
      items: [
        mcp(join(copilot, "mcp-config.json"), "json", "mcpServers", { type: "http", url: pub, tools: ["*"] }),
        { kind: "hook", file: join(copilot, "hooks", "agent-forge.json"), format: "json", edit: ownFileEdit("copilot", c) },
      ],
    },
    { id: "cline", name: "Cline (VS Code)", markers: [clineExt], items: [mcp(join(clineExt, "settings", "cline_mcp_settings.json"), "json", "mcpServers", { type: "streamableHttp", url: pub })] },
    { id: "cline-cli", name: "Cline CLI", markers: [clineDir, clineData, clineCli], items: [mcp(clineCli, "json", "mcpServers", { type: "streamableHttp", url: pub })] },
    { id: "lmstudio", name: "LM Studio", markers: [join(h, ".lmstudio")], items: [mcp(join(h, ".lmstudio", "mcp.json"), "json", "mcpServers", { url: pub })] },
    {
      id: "goose",
      name: "Goose",
      markers: [gooseDir(c)],
      items: [],
      manual: `Goose keeps its settings in YAML, which setup doesn't edit. Add it in Goose: Extensions → Add custom extension → Streamable HTTP, address ${pub}.`,
    },
  ];
}

// ---------- the file side ----------

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const exists = (p: string) => stat(p).then(() => true, () => false);
const readText = (p: string) => readFile(p, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;

/** A free backup name next to the file: <file>.forge-bak, then .forge-bak.2, .3 … */
async function backupPath(file: string): Promise<string> {
  for (let n = 1; ; n++) {
    const p = `${file}.forge-bak${n === 1 ? "" : `.${n}`}`;
    if (!(await lstat(p).then(() => true, () => false))) return p;
  }
}

/**
 * The file to write: the config path itself, or, when it is a symbolic link (dotfiles kept in a repo, for example),
 * the real file it points to, so the link stays a link. null when the link points to nothing.
 */
async function realTarget(file: string): Promise<{ target: string; link: string | null } | null> {
  const l = await lstat(file).catch(() => null);
  if (!l?.isSymbolicLink()) return { target: file, link: null };
  const target = await realpath(file).catch(() => null);
  return target ? { target, link: file } : null;
}

/** The folders that don't exist yet on the way to `file`, deepest first (so undo can remove the empty ones). */
async function missingDirs(file: string): Promise<string[]> {
  const out: string[] = [];
  for (let d = dirname(file); d !== dirname(d) && !(await exists(d)); d = dirname(d)) out.push(d);
  return out;
}

/**
 * Writes through a temporary file (random name, created exclusively, the old file's mode or 0600 for a new one) and a
 * rename, so a crash never leaves half a file and nothing can be planted at the temporary name first.
 */
async function writeAtomic(file: string, data: string | Buffer, mode: number | null): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const m = mode ?? 0o600;
  const tmp = `${file}.forge-tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, data, { mode: m, flag: "wx" });
    await chmod(tmp, m); // the umask may have narrowed the mode given to writeFile
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export type ManifestEntry =
  | { type: "file"; at: string; client: string; file: string; link?: string | null; backup: string | null; sha256: string; created_dirs?: string[] }
  | { type: "command"; at: string; client: string; url: string };

const str = (v: unknown) => typeof v === "string";

/** The manifest's entries; [] when there is none; null when it exists but can't be read as one. */
export function parseManifest(text: string | null): ManifestEntry[] | null {
  if (text === null) return [];
  try {
    const m = JSON.parse(text) as { entries?: unknown };
    if (!Array.isArray(m?.entries)) return null;
    const ok = m.entries.every((e: Record<string, unknown>) =>
      e && typeof e === "object" && str(e.client) && str(e.at) &&
      ((e.type === "file" && str(e.file) && str(e.sha256) && (e.backup === null || str(e.backup)) && (e.created_dirs === undefined || (Array.isArray(e.created_dirs) && e.created_dirs.every(str)))) ||
        (e.type === "command" && str(e.url))),
    );
    return ok ? (m.entries as ManifestEntry[]) : null;
  } catch {
    return null;
  }
}

export const serializeManifest = (entries: ManifestEntry[]) => `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;

// ---------- planning ----------

export type ItemStatus = "would_add" | "added" | "present" | "skipped" | "declined" | "needs_yes" | "failed" | "manual" | "suggested";

export interface ItemResult {
  kind: Kind | "plugin" | "connector";
  status: ItemStatus;
  file?: string;
  backup?: string | null;
  reason?: string;
  preview?: string;
  command?: string;
}

export interface ClientResult {
  id: string;
  name: string;
  items: ItemResult[];
}

export interface Planned {
  def: ClientDef;
  items: { item: FileItem; original: string | null; edit: Edit }[];
  /** Claude Code: whether the Forge is already there (its user config or the plugin). */
  command?: { present: string | null; plugin: boolean; pluginId: string | null; stateError: string | null };
}

/** Which clients are installed here, and what each item would change. Reads files only. */
export async function plan(c: SetupContext): Promise<Planned[]> {
  const out: Planned[] = [];
  for (const def of clientDefs(c)) {
    if (!(await anyExists(def.markers))) continue;
    const p: Planned = { def, items: [] };
    for (const item of def.items) {
      let original: string | null;
      try {
        original = await readText(item.file);
      } catch (e) {
        p.items.push({ item, original: null, edit: { status: "skip", reason: `can't read the file (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` } });
        continue;
      }
      p.items.push({ item, original, edit: item.edit(original) });
    }
    if (def.command) {
      const plugins = await readText(def.command.pluginList).catch(() => null);
      const pluginId = installedPluginId(plugins);
      const plugin = pluginId !== null;
      let present: string | null = null;
      let stateError: string | null = null;
      const state = await readText(def.command.state).catch(() => null);
      if (state !== null) {
        const parsed = parseConfig(state, "json");
        if ("error" in parsed) stateError = parsed.error;
        else {
          const servers = obj(parsed.root.mcpServers) ?? {};
          for (const [name, v] of Object.entries(servers)) {
            const url = obj(v)?.url;
            if (typeof url === "string" && url.startsWith(`${c.origin}/mcp`)) present = `already set up as "${name}"`;
          }
          if (!present && Object.hasOwn(servers, SERVER_NAME)) stateError = `a different server is already named "${SERVER_NAME}"; it is left as it is`;
        }
      }
      if (!present && plugin) present = "already there through the Forge plugin";
      p.command = { present, plugin, pluginId, stateError };
    }
    out.push(p);
  }
  return out;
}

async function anyExists(paths: string[]): Promise<boolean> {
  for (const p of paths) if (await exists(p)) return true;
  return false;
}

// ---------- applying ----------

export interface ApplyFileResult {
  ok: boolean;
  /** The file written: the real file when the config path is a symbolic link. */
  target: string;
  link: string | null;
  backup: string | null;
  createdDirs: string[];
  sha256?: string;
  reason?: string;
}

/**
 * Applies the accepted edits to one file in order (MCP then hook, for a file that holds both), after checking the
 * file hasn't changed since it was read. Backs the old file up first.
 */
export async function applyFile(file: string, original: string | null, edits: ((t: string | null) => Edit)[]): Promise<ApplyFileResult> {
  const fail = (reason: string, extra: Partial<ApplyFileResult> = {}): ApplyFileResult => ({ ok: false, target: file, link: null, backup: null, createdDirs: [], reason, ...extra });
  const t = await realTarget(file);
  if (!t) return fail("the file is a symbolic link to something that isn't there; nothing was written");
  const now = await readText(t.target).catch(() => undefined);
  if (now === undefined) return fail("can't read the file");
  if (now !== original) return fail("the file changed while setup was running; nothing was written");
  let text: string | null = original;
  for (const e of edits) {
    const r = e(text);
    if (r.status === "add") text = r.text;
    else if (r.status === "skip") return fail(r.reason);
  }
  if (text === original || text === null) return { ok: true, target: t.target, link: t.link, backup: null, createdDirs: [] };
  let backup: string | null = null;
  const createdDirs = original === null ? await missingDirs(t.target) : [];
  try {
    let mode: number | null = null;
    if (original !== null) {
      const bytes = await readFile(t.target);
      mode = (await stat(t.target)).mode & 0o777;
      if (sha256(bytes) !== sha256(Buffer.from(original, "utf8"))) return fail("the file changed while setup was running; nothing was written");
      backup = await backupPath(t.target);
      await writeFile(backup, bytes, { mode, flag: "wx" });
    }
    await writeAtomic(t.target, text, mode);
  } catch (e) {
    return fail(`couldn't write (${errCode(e)})`, { target: t.target, link: t.link, backup, createdDirs });
  }
  return { ok: true, target: t.target, link: t.link, backup, createdDirs, sha256: sha256(text) };
}

// ---------- undo ----------

export interface UndoResult {
  client: string;
  file?: string;
  command?: string;
  status: "restored" | "removed" | "would_restore" | "would_remove" | "skipped" | "failed";
  reason?: string;
}

export type Exec = (argv: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Undoes one manifest entry. Restores a backup only when the file still holds exactly what setup wrote. A command is
 * never taken from the manifest: it is rebuilt from this build's own client list (Claude Code's `claude mcp remove`),
 * and an entry for any other client is refused.
 */
export async function undoEntry(e: ManifestEntry, o: { dryRun: boolean; exec?: Exec; defs: ClientDef[] }): Promise<UndoResult> {
  if (e.type === "command") {
    const cmd = o.defs.find((d) => d.id === e.client)?.command;
    if (!cmd) return { client: e.client, status: "failed", reason: "setup only runs commands for Claude Code; this entry was not run" };
    const shown = cmd.remove.join(" ");
    const state = await readText(cmd.state).catch(() => null);
    const p = state === null ? null : parseConfig(state.startsWith(BOM) ? state.slice(1) : state, "json");
    const cur = p && !("error" in p) ? obj(obj(p.root.mcpServers)?.[SERVER_NAME])?.url : undefined;
    if (cur !== e.url) return { client: e.client, command: shown, status: "skipped", reason: `"${SERVER_NAME}" no longer points to ${e.url}; left as it is` };
    if (o.dryRun) return { client: e.client, command: shown, status: "would_remove" };
    if (!o.exec) return { client: e.client, command: shown, status: "failed", reason: "this build can't run commands" };
    try {
      const r = await o.exec([...cmd.remove]);
      return r.code === 0 ? { client: e.client, command: shown, status: "removed" } : { client: e.client, command: shown, status: "failed", reason: (r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}` };
    } catch (err) {
      return { client: e.client, command: shown, status: "failed", reason: (err as Error).message };
    }
  }
  const current = await readFile(e.file).catch(() => null);
  if (current === null) return { client: e.client, file: e.file, status: "skipped", reason: "the file is gone" };
  if (sha256(current) !== e.sha256) return { client: e.client, file: e.file, status: "skipped", reason: `the file changed after setup; left as it is${e.backup ? ` (the old version is in ${e.backup})` : ""}` };
  const backupBytes = e.backup ? await readFile(e.backup).catch(() => null) : null;
  if (e.backup && backupBytes === null) return { client: e.client, file: e.file, status: "skipped", reason: `the backup ${e.backup} is gone; the file is left as it is` };
  if (o.dryRun) return { client: e.client, file: e.file, status: e.backup ? "would_restore" : "would_remove" };
  try {
    if (e.backup && backupBytes) {
      // e.file is the real file (a symbolic link to it stays a link). Same atomic write, keeping the backup's mode.
      const mode = (await stat(e.backup)).mode & 0o777;
      await writeAtomic(e.file, backupBytes, mode);
      await rm(e.backup, { force: true });
      return { client: e.client, file: e.file, status: "restored" };
    }
    await rm(e.file, { force: true });
    // Folders setup made for this file go too, but only when empty.
    for (const d of e.created_dirs ?? []) await rmdir(d).catch(() => {});
    return { client: e.client, file: e.file, status: "removed" };
  } catch (err) {
    return { client: e.client, file: e.file, status: "failed", reason: errCode(err) };
  }
}

// ---------- the command ----------

export interface SetupIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** A y/N question at a real terminal, asked on stderr; null when there is no terminal (an agent's shell, CI). */
  ask?: (question: string) => Promise<boolean | null>;
  exec?: Exec;
  readConfig?: (name: string) => Promise<string | null>;
  writeConfig?: (name: string, text: string) => Promise<void>;
  now?: () => number;
}

export interface SetupOpts {
  dryRun: boolean;
  yes: boolean;
  undo: boolean;
  json: boolean;
}

const LABEL: Record<string, string> = { mcp: "Read-only Forge MCP server (no account)", hook: "Install-check hook (checks packages before the agent installs them)" };

function tilde(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

const indent = (s: string, n = 4) => s.split("\n").map((l) => `${" ".repeat(n)}${l}`).join("\n");

/** `forge setup` and `forge setup --undo`. Returns the exit code. */
export async function runSetup(o: SetupOpts, c: SetupContext, io: SetupIo): Promise<number> {
  // With --json, stdout carries the result JSON and nothing else; the person-facing lines go to stderr.
  const say = o.json ? io.err : io.out;
  if (!io.readConfig || !io.writeConfig) {
    io.err("This build can't keep settings, so it couldn't undo a change; nothing was written.");
    return 1;
  }
  const at = new Date(io.now?.() ?? Date.now()).toISOString();
  let manifestText: string | null;
  try {
    manifestText = await io.readConfig(SETUP_MANIFEST);
  } catch (e) {
    io.err(`Can't read setup's record of earlier changes (${SETUP_MANIFEST}: ${errCode(e)}); nothing was changed.`);
    return 1;
  }
  const parsed = parseManifest(manifestText);
  if (parsed === null) {
    // Treating it as empty would forget earlier changes, so --undo could no longer put them back.
    io.err(`Setup's record of earlier changes (${SETUP_MANIFEST} in the CLI settings folder) is damaged, so nothing was changed. The backups (*.forge-bak) next to each config file are untouched. Move that file away to start a new record.`);
    if (o.json) io.out(JSON.stringify({ error: "manifest_unreadable", file: SETUP_MANIFEST, sent: "nothing" }, null, 2));
    return 1;
  }
  const manifest: ManifestEntry[] = parsed;
  const saveManifest = (entries: ManifestEntry[]) => io.writeConfig!(SETUP_MANIFEST, serializeManifest(entries));
  const ask = async (q: string): Promise<boolean | null> => (o.yes ? true : ((await io.ask?.(q).catch(() => null)) ?? null));

  if (o.undo) {
    if (!manifest.length) {
      if (o.json) io.out(JSON.stringify({ undo: true, dry_run: o.dryRun, results: [], sent: "nothing" }, null, 2));
      else say("Nothing to undo: setup hasn't changed anything on this machine.");
      return 0;
    }
    say(`${o.dryRun ? "Dry run: nothing will be changed. " : ""}Setup changes to undo (newest first):`);
    const defs = clientDefs(c);
    for (const e of [...manifest].reverse()) say(`  ${e.client}: ${e.type === "file" ? (e.backup ? `restore ${tilde(e.file, c.home)} from ${tilde(e.backup, c.home)}` : `remove ${tilde(e.file, c.home)} (setup created it)`) : `run ${defs.find((d) => d.id === e.client)?.command?.remove.join(" ") ?? "(refused: not a Claude Code entry)"}`}`);
    let go = o.dryRun;
    if (!o.dryRun) {
      const yes = await ask(manifest.length === 1 ? "Undo this change? [y/N] " : `Undo these ${manifest.length} changes? [y/N] `);
      if (yes !== true) {
        if (o.json) io.out(JSON.stringify({ undo: true, dry_run: false, results: [], status: yes === null ? "needs_yes" : "declined", sent: "nothing" }, null, 2));
        else say(yes === null ? "Nothing was changed: undo needs a yes at a terminal, or --yes." : "Nothing was changed.");
        return 0;
      }
      go = true;
    }
    const results: UndoResult[] = [];
    let keep = [...manifest];
    for (const e of [...manifest].reverse()) {
      if (!go) break;
      const r = await undoEntry(e, { dryRun: o.dryRun, exec: io.exec, defs: clientDefs(c) });
      results.push(r);
      if (r.status === "restored" || r.status === "removed") {
        keep = keep.filter((k) => k !== e);
        await saveManifest(keep).catch(() => {});
      }
      say(`  ${r.client}: ${r.status.replace("_", " ")}${r.file ? ` ${tilde(r.file, c.home)}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
    }
    if (o.json) io.out(JSON.stringify({ undo: true, dry_run: o.dryRun, results, sent: "nothing" }, null, 2));
    return results.some((r) => r.status === "failed") ? 1 : 0;
  }

  const planned = await plan(c);
  const results: ClientResult[] = [];
  say(`The Agent Forge setup: ${o.dryRun ? "dry run, nothing will be written" : "each change is shown and needs a yes"}. Setup sends nothing over the network.`);
  if (!planned.length) {
    say(`No supported AI client found (looked for ${clientDefs(c).map((d) => d.name).join(", ")}).`);
  } else say(`Found: ${planned.map((p) => p.def.name).join(", ")}.`);

  const entries = [...manifest];
  let hookAdded = false;
  for (const p of planned) {
    const r: ClientResult = { id: p.def.id, name: p.def.name, items: [] };
    results.push(r);
    say("");
    say(p.def.name);
    if (p.def.manual) {
      r.items.push({ kind: "connector", status: "manual", reason: p.def.manual });
      say(indent(p.def.manual, 2));
    }
    if (p.def.command && p.command) {
      const cmd = p.def.command;
      const shown = cmd.add.join(" ");
      say(`  ${LABEL.mcp}`);
      if (p.command.present) {
        r.items.push({ kind: "mcp", status: "present", reason: p.command.present });
        say(`    ${p.command.present}`);
      } else if (p.command.stateError) {
        r.items.push({ kind: "mcp", status: "skipped", reason: p.command.stateError, command: shown });
        say(`    skipped: ${p.command.stateError}`);
      } else if (o.dryRun) {
        r.items.push({ kind: "mcp", status: "would_add", command: shown });
        say(`    would run: ${shown}`);
      } else {
        say(`    runs: ${shown}`);
        const yes = await ask(`  Add it to Claude Code? [y/N] `);
        if (yes !== true) {
          r.items.push({ kind: "mcp", status: yes === null ? "needs_yes" : "declined", command: shown });
          say(`    ${yes === null ? "not added (needs a yes)" : "not added"}`);
        } else {
          let res: Awaited<ReturnType<Exec>> | null = null;
          let why = "";
          try {
            res = io.exec ? await io.exec(cmd.add) : null;
            if (!io.exec) why = "this build can't run commands";
          } catch (e) {
            why = (e as NodeJS.ErrnoException).code === "ENOENT" ? "the claude command isn't on PATH" : (e as Error).message;
          }
          if (res && res.code === 0) {
            entries.push({ type: "command", at, client: p.def.id, url: cmd.add.at(-1)! });
            r.items.push({ kind: "mcp", status: "added", command: shown });
            say("    added");
            try {
              await saveManifest(entries);
            } catch (e) {
              say(`    warning: couldn't record this change for --undo (${errCode(e)}); to remove it: ${cmd.remove.join(" ")}`);
            }
          } else {
            const reason = why || (res ? (res.stderr || res.stdout).trim().slice(0, 200) || `exit ${res.code}` : "unknown");
            r.items.push({ kind: "mcp", status: "failed", reason, command: shown });
            say(`    not added: ${reason}. To add it yourself: ${shown}`);
          }
        }
      }
      if (!p.command.plugin) {
        const steps = `/plugin marketplace add ${c.origin}/marketplace.json, then /plugin install ${PLUGIN_ID}`;
        r.items.push({ kind: "plugin", status: "suggested", command: steps });
        say(`  Install check for Claude Code: the Forge plugin. Setup doesn't edit plugin files; in Claude Code, type ${steps}`);
      } else if (p.command.pluginId !== PLUGIN_ID) {
        // Installed under the name before the rename (ADR 0121): it still works, but gets no more updates.
        const steps = `/plugin marketplace update theagentforge, then /plugin uninstall ${p.command.pluginId}, then /plugin install ${PLUGIN_ID}`;
        r.items.push({ kind: "plugin", status: "present", reason: `the Forge plugin is installed under its old name ${p.command.pluginId}`, command: steps });
        say(`  Install check for Claude Code: the Forge plugin is installed under its old name ${p.command.pluginId}. To move to its new name, in Claude Code type ${steps}`);
      } else r.items.push({ kind: "plugin", status: "present", reason: "the Forge plugin is installed" });
    }

    // File items, grouped so a file holding both the server and the hook (Gemini) is backed up and written once.
    const accepted = new Map<string, { original: string | null; edits: ((t: string | null) => Edit)[]; results: ItemResult[] }>();
    for (const { item, original, edit } of p.items) {
      const file = tilde(item.file, c.home);
      say(`  ${LABEL[item.kind]} → ${file}`);
      if (edit.status !== "add") {
        r.items.push({ kind: item.kind, status: edit.status === "present" ? "present" : "skipped", file: item.file, reason: edit.reason });
        say(`    ${edit.status === "present" ? edit.reason : `skipped: ${edit.reason}`}`);
        continue;
      }
      say(`    ${original === null ? "new file" : "adds"}:`);
      say(indent(edit.preview, 6));
      if (o.dryRun) {
        r.items.push({ kind: item.kind, status: "would_add", file: item.file, preview: edit.preview });
        continue;
      }
      const yes = await ask(`  Add it to ${p.def.name}? [y/N] `);
      if (yes !== true) {
        r.items.push({ kind: item.kind, status: yes === null ? "needs_yes" : "declined", file: item.file });
        say(`    ${yes === null ? "not added (needs a yes)" : "not added"}`);
        continue;
      }
      const res: ItemResult = { kind: item.kind, status: "added", file: item.file };
      r.items.push(res);
      const g = accepted.get(item.file) ?? { original, edits: [], results: [] };
      g.edits.push(item.edit);
      g.results.push(res);
      accepted.set(item.file, g);
    }
    for (const [file, g] of accepted) {
      const w = await applyFile(file, g.original, g.edits);
      for (const res of g.results) {
        if (!w.ok) Object.assign(res, { status: "failed", reason: w.reason });
        else res.backup = w.backup;
      }
      if (w.ok && w.sha256) {
        entries.push({ type: "file", at, client: p.def.id, file: w.target, link: w.link, backup: w.backup, sha256: w.sha256, ...(w.createdDirs.length ? { created_dirs: w.createdDirs } : {}) });
        try {
          await saveManifest(entries);
        } catch (e) {
          say(`    warning: couldn't record this change for --undo (${(e as Error).message}); the old file is in ${w.backup ?? "(none: setup created the file)"}`);
        }
        if (g.results.some((x) => x.kind === "hook")) hookAdded = true;
      }
      say(`    ${w.ok ? `written: ${tilde(file, c.home)}${w.link ? ` (a link; wrote the real file ${tilde(w.target, c.home)})` : ""}${w.backup ? ` (backup: ${tilde(w.backup, c.home)})` : ""}` : `not written: ${w.reason}`}`);
      if (w.ok && p.def.id === "codex" && g.results.some((x) => x.kind === "hook")) say("    Codex skips a new hook until you approve it: type /hooks in Codex and approve the Forge install check.");
    }
  }

  const all = results.flatMap((r) => r.items);
  say("");
  if (all.some((i) => i.status === "added")) say("Restart each client to load the change. To undo: npx @theagentforge/cli setup --undo");
  if (all.some((i) => i.status === "needs_yes")) say("Nothing was changed without a yes: run setup at a terminal, or add --yes.");
  if (hookAdded) say(`The install-check hook sends each package it checks to The Forge with a random install ID (off: forge telemetry disable). ${PRIVACY_INSTALL_ID_URL}`);
  if (o.json) io.out(JSON.stringify({ dry_run: o.dryRun, origin: c.origin, clients: results, undo: "npx @theagentforge/cli setup --undo", sent: "nothing" }, null, 2));
  return all.some((i) => i.status === "failed") ? 1 : 0;
}
