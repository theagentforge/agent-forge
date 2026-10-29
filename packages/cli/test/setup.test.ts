import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, run, type Io } from "../src/run";
import { SETUP_MANIFEST, codexTomlEdit } from "../src/setup";

// `forge setup` (ADR 0119): every test runs against a temporary home folder with fake client configs, and a fake
// settings folder for the undo manifest. Setup must never touch the network.

const PUB = "https://theagentforge.io/mcp/public";
const homes: string[] = [];

afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function home(files: Record<string, string | null> = {}): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), "forge-setup-"));
  homes.push(h);
  for (const [p, text] of Object.entries(files)) {
    if (text === null) await mkdir(join(h, p), { recursive: true });
    else {
      await mkdir(join(h, p, ".."), { recursive: true });
      await writeFile(join(h, p), text);
    }
  }
  return h;
}

/** Every file under the folder with its bytes, to prove what changed and what didn't. */
async function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await snapshot(p, base, out);
    else out[p.slice(base.length + 1)] = await readFile(p, "utf8");
  }
  return out;
}

interface Opts {
  answer?: boolean | null | (() => boolean | null);
  platform?: string;
  env?: Record<string, string>;
  exec?: Io["exec"];
}

/** One run of the CLI against the temporary home. The settings folder is a map kept per home. */
const settings = new Map<string, Map<string, string>>();
async function forge(h: string, argv: string[], o: Opts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const fetched: string[] = [];
  const cfg = settings.get(h) ?? new Map<string, string>();
  settings.set(h, cfg);
  const code = await run(argv, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetch: (async (u: string) => {
      fetched.push(u);
      throw new Error("setup must not use the network");
    }) as unknown as typeof fetch,
    env: o.env ?? {},
    readConfig: async (n) => cfg.get(n) ?? null,
    writeConfig: async (n, t) => void cfg.set(n, t),
    setup: { home: h, platform: o.platform ?? "linux" },
    ask: async (q) => {
      asked.push(q);
      return typeof o.answer === "function" ? o.answer() : (o.answer ?? null);
    },
    exec: o.exec,
    now: () => Date.parse("2026-10-29T12:00:00Z"),
  });
  return { code, out, err, asked, fetched, manifest: cfg.get(SETUP_MANIFEST) ?? null };
}

const GEMINI_JSONC = `{
  // keep me
  "theme": "Default",
  "mcpServers": {
    "other": { "command": "other-server" } // and me
  },
}
`;
const CURSOR = `{"mcpServers": {"existing": {"url": "https://example.com/mcp"}}}\n`;
const CODEX_TOML = `model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n`;

/** One of each supported client, with existing config where it matters. */
const allClients = () =>
  home({
    ".claude": null,
    ".cursor/mcp.json": CURSOR,
    ".config/Code/User/settings.json": "{}\n",
    ".codeium/windsurf": null,
    ".codex/config.toml": CODEX_TOML,
    ".gemini/settings.json": GEMINI_JSONC,
    ".copilot": null,
    ".config/Code/User/globalStorage/saoudrizwan.claude-dev": null,
    ".cline": null,
    ".lmstudio": null,
    ".config/goose": null,
    ".config/Claude": null,
  });

describe("forge setup: detection", () => {
  it("finds only the clients whose folders exist, and says so when there are none", async () => {
    const empty = await home();
    const none = await forge(empty, ["setup", "--dry-run"]);
    expect(none.code).toBe(EXIT.ok);
    expect(none.out.join("\n")).toContain("No supported AI client found");
    const r = await forge(await home({ ".cursor": null, ".gemini": null }), ["setup", "--dry-run", "--json"]);
    expect(JSON.parse(r.out.join("\n")).clients.map((c: { id: string }) => c.id)).toEqual(["cursor", "gemini"]);
  });

  it("finds every supported client", async () => {
    const r = await forge(await allClients(), ["setup", "--dry-run", "--json"]);
    expect(JSON.parse(r.out.join("\n")).clients.map((c: { id: string }) => c.id)).toEqual([
      "claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "codex", "gemini", "copilot", "cline", "cline-cli", "lmstudio", "goose",
    ]);
  });

  it("uses each platform's folders (VS Code and Claude Desktop on macOS and Windows)", async () => {
    const mac = await home({ "Library/Application Support/Code/User": null, "Library/Application Support/Claude": null });
    const r = await forge(mac, ["setup", "--dry-run", "--json"], { platform: "darwin" });
    const ids = JSON.parse(r.out.join("\n")).clients.map((c: { id: string }) => c.id);
    expect(ids).toEqual(["claude-desktop", "vscode"]);
    const win = await home({ "Roaming/Code/User": null });
    const w = await forge(win, ["setup", "--dry-run", "--json"], { platform: "win32", env: { APPDATA: join(win, "Roaming") } });
    expect(JSON.parse(w.out.join("\n")).clients[0].items[0].file).toBe(join(win, "Roaming", "Code", "User", "mcp.json"));
  });
});

describe("forge setup: dry run", () => {
  it("prints the exact changes and writes nothing, not even the manifest", async () => {
    const h = await allClients();
    const before = await snapshot(h);
    const r = await forge(h, ["setup", "--dry-run"]);
    expect(r.code).toBe(EXIT.ok);
    expect(await snapshot(h)).toEqual(before);
    expect(r.manifest).toBeNull();
    expect(r.asked).toEqual([]);
    const text = r.out.join("\n");
    expect(text).toContain(`"httpUrl": "${PUB}"`);
    expect(text).toContain(`[mcp_servers.forge]\n      url = "${PUB}"`);
    expect(text).toContain(`would run: claude mcp add --scope user --transport http forge ${PUB}`);
    expect(text).toContain("npx -y @theagentforge/cli hook codex");
    expect(r.fetched).toEqual([]);
  });
});

describe("forge setup: writing", () => {
  it("adds the server (and hooks) to every client after a yes, keeping what was there", async () => {
    const h = await allClients();
    const calls: string[][] = [];
    const r = await forge(h, ["setup", "--yes"], { exec: async (argv) => (calls.push(argv), { code: 0, stdout: "", stderr: "" }) });
    expect(r.code).toBe(EXIT.ok);
    expect(r.fetched).toEqual([]);
    expect(calls).toEqual([["claude", "mcp", "add", "--scope", "user", "--transport", "http", "forge", PUB]]);

    const cursor = JSON.parse(await readFile(join(h, ".cursor/mcp.json"), "utf8"));
    expect(cursor.mcpServers).toEqual({ existing: { url: "https://example.com/mcp" }, forge: { url: PUB } });
    expect(JSON.parse(await readFile(join(h, ".config/Code/User/mcp.json"), "utf8"))).toEqual({ servers: { forge: { type: "http", url: PUB } } });
    expect(JSON.parse(await readFile(join(h, ".codeium/windsurf/mcp_config.json"), "utf8"))).toEqual({ mcpServers: { forge: { serverUrl: PUB } } });
    expect(JSON.parse(await readFile(join(h, ".copilot/mcp-config.json"), "utf8"))).toEqual({ mcpServers: { forge: { type: "http", url: PUB, tools: ["*"] } } });
    expect(await readFile(join(h, ".copilot/hooks/agent-forge.json"), "utf8")).toContain("@theagentforge/cli hook copilot");
    expect(JSON.parse(await readFile(join(h, ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"), "utf8"))).toEqual({ mcpServers: { forge: { type: "streamableHttp", url: PUB } } });
    expect(JSON.parse(await readFile(join(h, ".cline/data/settings/cline_mcp_settings.json"), "utf8")).mcpServers.forge.type).toBe("streamableHttp");
    expect(JSON.parse(await readFile(join(h, ".lmstudio/mcp.json"), "utf8"))).toEqual({ mcpServers: { forge: { url: PUB } } });

    // Codex: the TOML is only appended to; the hook goes in hooks.json.
    const toml = await readFile(join(h, ".codex/config.toml"), "utf8");
    expect(toml).toBe(`${CODEX_TOML}\n[mcp_servers.forge]\nurl = "${PUB}"\n`);
    expect(JSON.parse(await readFile(join(h, ".codex/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command).toBe("npx -y @theagentforge/cli hook codex");

    // Gemini: one file holds both, comments and the trailing comma kept, written once with one backup.
    const gemini = await readFile(join(h, ".gemini/settings.json"), "utf8");
    expect(gemini).toContain("// keep me");
    expect(gemini).toContain("// and me");
    expect(gemini).toContain(`"httpUrl": "${PUB}"`);
    expect(gemini).toContain("@theagentforge/cli hook gemini");
    expect(gemini).toContain('"command": "other-server"');
    expect(await readFile(join(h, ".gemini/settings.json.forge-bak"), "utf8")).toBe(GEMINI_JSONC);
    expect(await stat(join(h, ".gemini/settings.json.forge-bak.2")).catch(() => null)).toBeNull();

    // Backups exist for every file that was there before, and the manifest lists every change.
    expect(await readFile(join(h, ".cursor/mcp.json.forge-bak"), "utf8")).toBe(CURSOR);
    expect(await readFile(join(h, ".codex/config.toml.forge-bak"), "utf8")).toBe(CODEX_TOML);
    const m = JSON.parse(r.manifest!).entries as { type: string; client: string }[];
    expect(m.filter((e) => e.type === "file")).toHaveLength(11);
    expect(m.filter((e) => e.type === "command")).toHaveLength(1);
    // Manual clients get steps only; the hook's install ID is mentioned with its opt-out.
    const text = r.out.join("\n");
    expect(text).toContain("Settings → Connectors → Add custom connector");
    expect(text).toContain("Goose keeps its settings in YAML");
    expect(text).toContain("/plugin install forge@theagentforge");
    expect(text).toContain("forge telemetry disable");
    expect(text).toContain("privacy#install-id");
  });

  it("is idempotent: a second run finds everything already there and writes nothing", async () => {
    const h = await allClients();
    await forge(h, ["setup", "--yes"], { exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    // Claude Code's own command would have written this; the fake doesn't, so put it there.
    await writeFile(join(h, ".claude.json"), JSON.stringify({ mcpServers: { forge: { type: "http", url: PUB } } }));
    const before = await snapshot(h);
    const manifestBefore = settings.get(h)!.get(SETUP_MANIFEST);
    const calls: string[][] = [];
    const r = await forge(h, ["setup", "--yes", "--json"], { exec: async (argv) => (calls.push(argv), { code: 0, stdout: "", stderr: "" }) });
    expect(await snapshot(h)).toEqual(before);
    expect(calls).toEqual([]);
    expect(r.manifest).toBe(manifestBefore);
    const items = JSON.parse(r.out.join("\n")).clients.flatMap((c: { items: { kind: string; status: string }[] }) => c.items);
    for (const i of items.filter((i: { kind: string }) => i.kind === "mcp" || i.kind === "hook")) expect(i.status).toBe("present");
  });

  it("treats the Forge under another name, or the Claude Code plugin, as already there", async () => {
    const h = await home({
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { "agent-forge": { url: "https://theagentforge.io/mcp" } } }),
      ".claude/plugins/installed_plugins.json": JSON.stringify({ plugins: { "forge@theagentforge": [{}] } }),
    });
    const before = await snapshot(h);
    const r = await forge(h, ["setup", "--yes", "--json"], { exec: async () => { throw new Error("not called"); } });
    expect(await snapshot(h)).toEqual(before);
    const c = JSON.parse(r.out.join("\n")).clients;
    expect(c[0].items).toEqual([
      { kind: "mcp", status: "present", reason: "already there through the Forge plugin" },
      { kind: "plugin", status: "present", reason: "the Forge plugin is installed" },
    ]);
    expect(c[1].items[0]).toMatchObject({ status: "present", reason: 'already set up as "agent-forge"' });
  });

  it("asks y/N per item and changes nothing on a no, or without a terminal and --yes", async () => {
    const h = await home({ ".cursor/mcp.json": CURSOR, ".gemini/settings.json": GEMINI_JSONC });
    const before = await snapshot(h);
    const no = await forge(h, ["setup"], { answer: false });
    expect(no.asked).toEqual(["  Add it to Cursor? [y/N] ", "  Add it to Gemini CLI? [y/N] ", "  Add it to Gemini CLI? [y/N] "]);
    expect(await snapshot(h)).toEqual(before);
    const tty = await forge(h, ["setup", "--json"], { answer: null });
    expect(await snapshot(h)).toEqual(before);
    expect(tty.manifest).toBeNull();
    const items = JSON.parse(tty.out.join("\n")).clients.flatMap((c: { items: { status: string }[] }) => c.items.map((i) => i.status));
    expect(items).toEqual(["needs_yes", "needs_yes", "needs_yes"]);
    expect(tty.err.join("\n")).toContain("Nothing was changed without a yes");
  });

  it("adds only the items answered yes", async () => {
    const h = await home({ ".gemini/settings.json": GEMINI_JSONC });
    let n = 0;
    const r = await forge(h, ["setup"], { answer: () => n++ === 0 }); // yes to the server, no to the hook
    expect(r.code).toBe(EXIT.ok);
    const text = await readFile(join(h, ".gemini/settings.json"), "utf8");
    expect(text).toContain("httpUrl");
    expect(text).not.toContain("hook gemini");
  });

  it("names the staging address in the server and the hook with --origin", async () => {
    const h = await home({ ".codex": null });
    await forge(h, ["setup", "--yes", "--origin", "https://staging.theagentforge.io"]);
    expect(await readFile(join(h, ".codex/config.toml"), "utf8")).toBe('[mcp_servers.forge]\nurl = "https://staging.theagentforge.io/mcp/public"\n');
    expect(await readFile(join(h, ".codex/hooks.json"), "utf8")).toContain("hook codex --origin https://staging.theagentforge.io");
  });

  it("reports a missing claude command and shows the command to run", async () => {
    const h = await home({ ".claude": null });
    const r = await forge(h, ["setup", "--yes"], { exec: async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); } });
    expect(r.code).toBe(EXIT.error);
    expect(r.out.join("\n")).toContain(`not added: the claude command isn't on PATH. To add it yourself: claude mcp add --scope user --transport http forge ${PUB}`);
    expect(r.manifest).toBeNull();
  });
});

describe("forge setup: malformed and conflicting configs are skipped untouched", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["invalid JSON", { ".cursor/mcp.json": '{"mcpServers": {' }, "isn't valid JSON"],
    ["comments in a strict JSON file", { ".cursor/mcp.json": '{ // note\n "mcpServers": {} }' }, "has comments"],
    ["a top level that isn't an object", { ".cursor/mcp.json": "[1, 2]" }, "top level isn't a JSON object"],
    ["mcpServers that isn't an object", { ".cursor/mcp.json": '{"mcpServers": []}' }, '"mcpServers" isn\'t an object'],
    ["another server already named forge", { ".cursor/mcp.json": '{"mcpServers": {"forge": {"url": "https://elsewhere.example/mcp"}}}' }, 'a different server is already named "forge"'],
    ["invalid JSONC in Gemini", { ".gemini/settings.json": '{ "a": 1 // ok\n "b": }' }, "isn't valid JSON"],
    ["Codex hooks.json that isn't valid", { ".codex/config.toml": `[mcp_servers.forge]\nurl = "${PUB}"\n`, ".codex/hooks.json": "{nope" }, "isn't valid JSON"],
    ["a Copilot hook file with other content", { ".copilot/mcp-config.json": '{"mcpServers": {"forge": {"url": "https://theagentforge.io/mcp/public"}}}', ".copilot/hooks/agent-forge.json": '{"version": 1}' }, "exists with other content"],
  ];
  for (const [name, files, reason] of cases) {
    it(name, async () => {
      const h = await home(files);
      const before = await snapshot(h);
      const r = await forge(h, ["setup", "--yes", "--json"]);
      expect(await snapshot(h)).toEqual(before);
      const skipped = JSON.parse(r.out.join("\n")).clients.flatMap((c: { items: { status: string; reason?: string }[] }) => c.items).filter((i: { status: string }) => i.status === "skipped");
      expect(skipped.map((i: { reason: string }) => i.reason).join(" | ")).toContain(reason);
    });
  }

  it("Codex TOML: skips an existing forge server in any spelling, inline mcp_servers, or an unclosed string", () => {
    const edit = codexTomlEdit({ home: "/h", platform: "linux", env: {}, origin: "https://theagentforge.io", defaultOrigin: true });
    for (const t of ['[mcp_servers.forge]\ncommand = "x"\n', '[mcp_servers."forge"]\nurl = "x"\n', '[mcp_servers.forge.env]\nA = "1"\n', 'mcp_servers.forge.url = "x"\n', 'mcp_servers = { forge = { url = "x" } }\n', '[mcp_servers]\nforge.url = "x"\n'])
      expect(edit(t).status, t).toBe("skip");
    expect(edit('notes = """\nopen\n').status).toBe("skip");
    expect(edit('[mcp_servers.f]\nurl = "https://theagentforge.io/mcp"\n').status).toBe("present");
    expect(edit('a = 1').status === "add" && (edit("a = 1") as { text: string }).text).toBe(`a = 1\n\n[mcp_servers.forge]\nurl = "${PUB}"\n`);
    expect(edit(null)).toMatchObject({ status: "add", text: `[mcp_servers.forge]\nurl = "${PUB}"\n` });
  });
});

describe("forge setup --undo", () => {
  it("puts back the exact bytes, removes files setup created and its backups, and runs claude mcp remove", async () => {
    const h = await allClients();
    const before = await snapshot(h);
    const calls: string[][] = [];
    const exec: Io["exec"] = async (argv) => {
      calls.push(argv);
      if (argv[2] === "add") await writeFile(join(h, ".claude.json"), JSON.stringify({ mcpServers: { forge: { type: "http", url: PUB } } }));
      if (argv[2] === "remove") await rm(join(h, ".claude.json"));
      return { code: 0, stdout: "", stderr: "" };
    };
    await forge(h, ["setup", "--yes"], { exec });
    expect(await snapshot(h)).not.toEqual(before);

    const dry = await forge(h, ["setup", "--undo", "--dry-run"], { exec });
    expect(dry.out.join("\n")).toContain("would restore");
    expect(calls).toHaveLength(1);

    const r = await forge(h, ["setup", "--undo", "--yes"], { exec });
    expect(r.code).toBe(EXIT.ok);
    expect(calls.at(-1)).toEqual(["claude", "mcp", "remove", "--scope", "user", "forge"]);
    expect(await snapshot(h)).toEqual(before);
    expect(JSON.parse(r.manifest!).entries).toEqual([]);
    const again = await forge(h, ["setup", "--undo", "--yes"]);
    expect(again.out.join("\n")).toContain("Nothing to undo");
  });

  it("leaves a file that changed after setup alone, and keeps its backup", async () => {
    const h = await home({ ".cursor/mcp.json": CURSOR });
    await forge(h, ["setup", "--yes"]);
    const edited = `${await readFile(join(h, ".cursor/mcp.json"), "utf8")}\n`;
    await writeFile(join(h, ".cursor/mcp.json"), edited);
    const r = await forge(h, ["setup", "--undo", "--yes"]);
    expect(await readFile(join(h, ".cursor/mcp.json"), "utf8")).toBe(edited);
    expect(await readFile(join(h, ".cursor/mcp.json.forge-bak"), "utf8")).toBe(CURSOR);
    expect(r.out.join("\n")).toContain("the file changed after setup; left as it is");
    expect(JSON.parse(r.manifest!).entries).toHaveLength(1);
  });

  it("undoes two setup runs in order (a second backup is .forge-bak.2)", async () => {
    const h = await home({ ".gemini/settings.json": GEMINI_JSONC });
    let n = 0;
    await forge(h, ["setup"], { answer: () => n++ === 0 }); // the server only
    const afterFirst = await readFile(join(h, ".gemini/settings.json"), "utf8");
    await forge(h, ["setup", "--yes"]); // now the hook
    expect(await readFile(join(h, ".gemini/settings.json"), "utf8")).toContain("hook gemini");
    expect(await readFile(join(h, ".gemini/settings.json.forge-bak"), "utf8")).toBe(GEMINI_JSONC);
    expect(await readFile(join(h, ".gemini/settings.json.forge-bak.2"), "utf8")).toBe(afterFirst);
    await forge(h, ["setup", "--undo", "--yes"]);
    expect(await snapshot(h)).toEqual({ ".gemini/settings.json": GEMINI_JSONC });
  });

  it("asks before undoing, and does nothing without a yes", async () => {
    const h = await home({ ".cursor/mcp.json": CURSOR });
    await forge(h, ["setup", "--yes"]);
    const changed = await snapshot(h);
    const r = await forge(h, ["setup", "--undo"], { answer: null });
    expect(r.asked).toEqual(["Undo this change? [y/N] "]);
    expect(await snapshot(h)).toEqual(changed);
  });
});

describe("forge setup --json", () => {
  it("writes only the result JSON to stdout, in every mode", async () => {
    for (const argv of [["setup", "--json", "--dry-run"], ["setup", "--json", "--yes"], ["setup", "--json"], ["setup", "--json", "--undo", "--yes"], ["setup", "--json", "--undo"]]) {
      const h = await allClients();
      const r = await forge(h, argv, { exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
      expect(r.out, argv.join(" ")).toHaveLength(1);
      const j = JSON.parse(r.out[0]!);
      expect(j.sent).toBe("nothing");
      // The person-facing lines still appear, on stderr.
      if (!argv.includes("--undo")) expect(r.err.join("\n")).toContain("The Agent Forge setup");
    }
  });
});

describe("forge setup: usage", () => {
  it("rejects extra arguments and is listed in the help", async () => {
    const h = await home();
    expect((await forge(h, ["setup", "cursor"])).code).toBe(EXIT.usage);
    const help: string[] = [];
    await run(["setup", "--help"], { out: (s) => help.push(s), err: () => {}, fetch });
    expect(help.join("\n")).toContain("forge setup [--dry-run] [--yes]");
  });
});

describe("forge setup: review fixes (29 Oct)", () => {
  const ok = async () => ({ code: 0, stdout: "", stderr: "" });

  it("writes the real file behind a symbolic link and keeps the link, through undo too", async () => {
    const h = await home({ "dotfiles/cursor-mcp.json": CURSOR, ".cursor": null });
    await symlink(join(h, "dotfiles/cursor-mcp.json"), join(h, ".cursor/mcp.json"));
    const r = await forge(h, ["setup", "--yes"]);
    expect(r.code).toBe(EXIT.ok);
    expect((await lstat(join(h, ".cursor/mcp.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(join(h, "dotfiles/cursor-mcp.json"), "utf8")).mcpServers.forge.url).toBe(PUB);
    expect(await readFile(join(h, "dotfiles/cursor-mcp.json.forge-bak"), "utf8")).toBe(CURSOR);
    expect(r.out.join("\n")).toContain("a link; wrote the real file ~/dotfiles/cursor-mcp.json");
    await forge(h, ["setup", "--undo", "--yes"]);
    expect((await lstat(join(h, ".cursor/mcp.json"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(h, "dotfiles/cursor-mcp.json"), "utf8")).toBe(CURSOR);
  });

  it("writes nothing through a link that points to nothing", async () => {
    const h = await home({ ".cursor": null });
    await symlink(join(h, "missing.json"), join(h, ".cursor/mcp.json"));
    const r = await forge(h, ["setup", "--yes"]);
    expect(r.code).toBe(EXIT.error);
    expect(r.out.join("\n")).toContain("symbolic link to something that isn't there");
    expect(await stat(join(h, "missing.json")).catch(() => null)).toBeNull();
  });

  it("keeps an existing file's mode, makes new files 0600 and leaves no temporary files", async () => {
    const h = await home({ ".cursor/mcp.json": CURSOR, ".lmstudio": null });
    await chmod(join(h, ".cursor/mcp.json"), 0o640);
    await forge(h, ["setup", "--yes"]);
    expect((await stat(join(h, ".cursor/mcp.json"))).mode & 0o777).toBe(0o640);
    expect((await stat(join(h, ".lmstudio/mcp.json"))).mode & 0o777).toBe(0o600);
    expect(Object.keys(await snapshot(h)).filter((f) => f.includes("forge-tmp"))).toEqual([]);
  });

  it("keeps CRLF line endings, tab indents and a byte-order mark", async () => {
    const crlfTabs = '{\r\n\t"mcpServers": {\r\n\t\t"a": {\r\n\t\t\t"url": "https://a.example"\r\n\t\t}\r\n\t}\r\n}\r\n';
    const bom = `﻿${CURSOR}`;
    const h = await home({ ".cursor/mcp.json": crlfTabs, ".lmstudio/mcp.json": bom, ".codex/config.toml": 'model = "o3"\r\n' });
    await forge(h, ["setup", "--yes"]);
    const cursor = await readFile(join(h, ".cursor/mcp.json"), "utf8");
    expect(cursor.replace(/\r\n/g, "")).not.toContain("\n");
    expect(cursor).toContain('\t\t"forge": {');
    expect(JSON.parse(cursor).mcpServers.forge.url).toBe(PUB);
    const lm = await readFile(join(h, ".lmstudio/mcp.json"), "utf8");
    expect(lm.startsWith("﻿")).toBe(true);
    expect(JSON.parse(lm.slice(1)).mcpServers.forge.url).toBe(PUB);
    expect(await readFile(join(h, ".codex/config.toml"), "utf8")).toBe(`model = "o3"\r\n\r\n[mcp_servers.forge]\r\nurl = "${PUB}"\r\n`);
  });

  it("writes nothing to a file that changed while setup was waiting for a yes", async () => {
    const h = await home({ ".cursor/mcp.json": CURSOR });
    const theirs = '{"mcpServers": {}, "changed": true}\n';
    const r = await forge(h, ["setup"], { answer: () => (writeFileSync(join(h, ".cursor/mcp.json"), theirs), true) });
    expect(r.code).toBe(EXIT.error);
    expect(r.out.join("\n")).toContain("the file changed while setup was running");
    expect(await readFile(join(h, ".cursor/mcp.json"), "utf8")).toBe(theirs);
    expect(await stat(join(h, ".cursor/mcp.json.forge-bak")).catch(() => null)).toBeNull();
  });

  it("stops on a damaged manifest instead of treating it as empty", async () => {
    const h = await home({ ".cursor/mcp.json": CURSOR });
    const before = await snapshot(h);
    for (const bad of ["{not json", '{"entries": [{"type": "command", "client": "claude-code"}]}', '{"entries": "x"}']) {
      settings.set(h, new Map([[SETUP_MANIFEST, bad]]));
      for (const argv of [["setup", "--yes"], ["setup", "--undo", "--yes"]]) {
        const r = await forge(h, argv);
        expect(r.code, `${bad} ${argv.join(" ")}`).toBe(EXIT.error);
        expect(r.err.join("\n")).toContain("is damaged, so nothing was changed");
        expect(r.manifest).toBe(bad);
      }
    }
    expect(await snapshot(h)).toEqual(before);
    const j = await forge(h, ["setup", "--yes", "--json"]);
    expect(JSON.parse(j.out.join("\n"))).toMatchObject({ error: "manifest_unreadable" });
  });

  it("undo never runs a command from the manifest: it rebuilds claude mcp remove, or refuses", async () => {
    const h = await home({ ".claude.json": JSON.stringify({ mcpServers: { forge: { type: "http", url: PUB } } }) });
    const calls: string[][] = [];
    const exec: Io["exec"] = async (argv) => (calls.push(argv), { code: 0, stdout: "", stderr: "" });
    const at = "2026-10-29T12:00:00.000Z";
    settings.set(h, new Map([[SETUP_MANIFEST, JSON.stringify({ version: 1, entries: [
      { type: "command", at, client: "cursor", url: PUB, undo: ["rm", "-rf", "/"] },
      { type: "command", at, client: "claude-code", url: PUB, undo: ["rm", "-rf", "/"] },
    ] })]]));
    const r = await forge(h, ["setup", "--undo", "--yes"], { exec });
    expect(calls).toEqual([["claude", "mcp", "remove", "--scope", "user", "forge"]]);
    expect(r.out.join("\n")).toContain("setup only runs commands for Claude Code");
    expect(r.code).toBe(EXIT.error);
  });

  it("keeps the backup and the file when the backup is gone at undo", async () => {
    const h = await home({ ".cursor/mcp.json": CURSOR });
    await forge(h, ["setup", "--yes"]);
    const written = await readFile(join(h, ".cursor/mcp.json"), "utf8");
    await rm(join(h, ".cursor/mcp.json.forge-bak"));
    const r = await forge(h, ["setup", "--undo", "--yes"]);
    expect(r.out.join("\n")).toContain("the backup");
    expect(r.out.join("\n")).toContain("is gone; the file is left as it is");
    expect(await readFile(join(h, ".cursor/mcp.json"), "utf8")).toBe(written);
    expect(JSON.parse(r.manifest!).entries).toHaveLength(1);
  });

  it("undo removes the folders setup created, only when empty", async () => {
    const h = await home({ ".copilot": null, ".cline": null });
    await forge(h, ["setup", "--yes"]);
    expect(await stat(join(h, ".copilot/hooks")).catch(() => null)).not.toBeNull();
    expect(await stat(join(h, ".cline/data/settings")).catch(() => null)).not.toBeNull();
    await writeFile(join(h, ".cline/data/mine.txt"), "keep");
    await forge(h, ["setup", "--undo", "--yes"]);
    expect(await snapshot(h)).toEqual({ ".cline/data/mine.txt": "keep" });
    expect(await stat(join(h, ".copilot/hooks")).catch(() => null)).toBeNull();
    expect(await stat(join(h, ".copilot")).catch(() => null)).not.toBeNull();
    expect(await stat(join(h, ".cline/data/settings")).catch(() => null)).toBeNull();
    expect(await stat(join(h, ".cline/data")).catch(() => null)).not.toBeNull();
  });

  it("honours COPILOT_HOME, CLINE_DIR, CLINE_DATA_DIR and CLAUDE_CONFIG_DIR", async () => {
    const h = await home({ "cop": null, "cl": null, "cld": null, "cc/plugins/installed_plugins.json": '{"plugins": {"forge@theagentforge": []}}' });
    const env = { COPILOT_HOME: join(h, "cop"), CLINE_DIR: join(h, "cl"), CLAUDE_CONFIG_DIR: join(h, "cc") };
    const r = await forge(h, ["setup", "--dry-run", "--json"], { env });
    const c = JSON.parse(r.out.join("\n")).clients as { id: string; items: { file?: string; status: string }[] }[];
    expect(c.find((x) => x.id === "copilot")!.items.map((i) => i.file)).toEqual([join(h, "cop/mcp-config.json"), join(h, "cop/hooks/agent-forge.json")]);
    expect(c.find((x) => x.id === "cline-cli")!.items[0]!.file).toBe(join(h, "cl/data/settings/cline_mcp_settings.json"));
    expect(c.find((x) => x.id === "claude-code")!.items[0]!.status).toBe("present"); // the plugin, read from CLAUDE_CONFIG_DIR
    const d = await forge(h, ["setup", "--dry-run", "--json"], { env: { CLINE_DATA_DIR: join(h, "cld") } });
    expect(JSON.parse(d.out.join("\n")).clients.find((x: { id: string }) => x.id === "cline-cli").items[0].file).toBe(join(h, "cld/settings/cline_mcp_settings.json"));
  });

  it("tells the person to approve the new Codex hook in /hooks", async () => {
    const h = await home({ ".codex": null });
    const r = await forge(h, ["setup", "--yes"]);
    expect(r.out.join("\n")).toContain("Codex skips a new hook until you approve it: type /hooks in Codex");
  });

  it("reports claude mcp add exiting non-zero, records nothing, and says how to add it by hand", async () => {
    const h = await home({ ".claude": null });
    const r = await forge(h, ["setup", "--yes"], { exec: async () => ({ code: 1, stdout: "", stderr: "MCP server forge already exists in user config" }) });
    expect(r.code).toBe(EXIT.error);
    expect(r.out.join("\n")).toContain("not added: MCP server forge already exists in user config. To add it yourself: claude mcp add");
    expect(r.manifest).toBeNull();
  });

  it("still reports the server added when the manifest can't be saved after claude mcp add", async () => {
    const h = await home({ ".claude": null });
    const r = await run(["setup", "--yes"], {
      out: () => {},
      err: () => {},
      fetch,
      readConfig: async () => null,
      writeConfig: async () => { throw new Error("EROFS"); },
      setup: { home: h, platform: "linux" },
      exec: ok,
    });
    expect(r).toBe(EXIT.ok);
  });

  it("accepts only https origins, and http://localhost only with --dev", async () => {
    const h = await home({ ".codex": null });
    for (const bad of ["http://example.com", "http://localhost:8787", "http://127.0.0.1", "ftp://theagentforge.io", "https://user@theagentforge.io", "https://theagentforge.io/path", "https://-bad.example", "https://", "javascript:alert(1)"]) {
      const r = await forge(h, ["setup", "--dry-run", "--origin", bad]);
      expect(r.code, bad).toBe(EXIT.usage);
    }
    expect((await forge(h, ["setup", "--dry-run", "--origin", "http://localhost:8787", "--dev"])).code).toBe(EXIT.ok);
    expect((await forge(h, ["setup", "--dry-run", "--origin", "https://staging.theagentforge.io"])).code).toBe(EXIT.ok);
    expect(await snapshot(h)).toEqual({});
  });
});
