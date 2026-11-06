import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  dirSandbox,
  IsolationError,
  isolationBroken,
  isolationMode,
  KILL_TRIES,
  launcherTrees,
  lockable,
  lockdown,
  lockTargets,
  parentsOf,
  probeEnv,
  probePath,
  resetIsolationForTests,
  SHARED_TMP,
  userSandbox,
  writeResultsFile,
} from "../isolate.mjs";
import { handshake, MAX_LINE, probeOne } from "../probe.mjs";

// ADR 0134 amendment 2: each probe runs as its own throwaway OS user. These tests need no root: the user sandbox's
// command runner is a fake that records what would run under sudo. The real thing runs in CI
// (integrations/house/test/isolation-smoke.mjs, last step of .github/workflows/ci.yml).

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A fake root command runner: records every argv; `pgrep` reports processes for the first `alivePasses` checks. */
function fakeRun({ alivePasses = 0, fail = null } = {}) {
  const calls = [];
  let pgreps = 0;
  const run = async (argv) => {
    const a = argv.map(String);
    calls.push(a);
    if (fail && a[0] === fail) return { code: 9, stdout: "", stderr: `${fail}: no` };
    if (a[0] === "pgrep") {
      pgreps++;
      return { code: pgreps <= alivePasses * 2 ? 0 : 1, stdout: "", stderr: "" };
    }
    if (a[0] === "id") return { code: 1, stdout: "", stderr: "no such user" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

afterEach(() => resetIsolationForTests());

describe("isolation mode and the probe's environment", () => {
  it("is 'dir' unless HOUSE_ISOLATION says 'user'; any other value is refused, never guessed", () => {
    expect(isolationMode({})).toBe("dir");
    expect(isolationMode({ HOUSE_ISOLATION: "" })).toBe("dir");
    expect(isolationMode({ HOUSE_ISOLATION: "user" })).toBe("user");
    expect(() => isolationMode({ HOUSE_ISOLATION: "users" })).toThrow(IsolationError);
  });

  it("gives the server PATH, HOME, LANG and caches in its home, plus network settings: nothing of the runner's", () => {
    const parentEnv = { GITHUB_ENV: "/x", GITHUB_TOKEN: "t", ACTIONS_RUNTIME_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_URL: "u", RUNNER_TEMP: "/r", PATH: "/home/runner/.local/bin:/usr/bin", HTTPS_PROXY: "http://proxy:3128" };
    const env = probeEnv("/tmp/probe-1-ab", { path: "/opt/node/bin:/usr/bin:/bin", parentEnv });
    expect(Object.keys(env).sort()).toEqual(["CI", "HOME", "HTTPS_PROXY", "LANG", "PATH", "TMPDIR", "UV_CACHE_DIR", "UV_NO_CONFIG", "UV_PYTHON_INSTALL_DIR", "UV_PYTHON_PREFERENCE", "UV_TOOL_DIR", "npm_config_cache", "npm_config_update_notifier"].sort());
    expect(env.PATH).toBe("/opt/node/bin:/usr/bin:/bin");
    for (const k of ["HOME", "TMPDIR", "npm_config_cache", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR"]) expect(env[k].startsWith("/tmp/probe-1-ab")).toBe(true);
  });

  it("builds PATH from the launcher's and node's folders and the system folders only", () => {
    // Review (6 Nov): /usr/local/bin (world-writable on GitHub's image until lockdown) last, never ahead of /usr/bin.
    expect(probePath("/opt/house-uv/bin/uvx", "/opt/hostedtoolcache/node/24/x64/bin/node")).toBe("/opt/house-uv/bin:/opt/hostedtoolcache/node/24/x64/bin:/usr/bin:/bin:/usr/local/bin");
    expect(probePath("npx", "/usr/bin/node")).toBe("/usr/bin:/bin:/usr/local/bin");
  });
});

describe("the user sandbox (fake sudo)", () => {
  it("creates a fresh user per probe: own UID and group, no sudo or docker group, a new home with mode 700", async () => {
    const { run, calls } = fakeRun();
    const sb = userSandbox({ run, random: () => "abc123" });
    const a = await sb.create();
    const b = await sb.create();
    expect(b.uid).toBeGreaterThan(a.uid);
    expect(a.name).toMatch(/^probe-\d+$/);
    expect(a.home).toMatch(/^\/tmp\/probe-\d+-abc123$/);
    const mine = calls.slice(0, 4);
    expect(mine[0]).toEqual(["groupadd", "-g", String(a.uid), a.name]);
    expect(mine[1]).toEqual(["useradd", "-M", "-N", "-l", "-u", String(a.uid), "-g", String(a.uid), "-d", a.home, "-s", "/usr/sbin/nologin", a.name]);
    expect(mine[1]).not.toContain("-G");
    // mkdir without -p: an existing (planted) path makes the probe fail instead of being taken over.
    expect(mine[2]).toEqual(["mkdir", "-m", "700", "--", a.home]);
    expect(mine[3]).toEqual(["chown", `${a.uid}:${a.uid}`, "--", a.home]);
  });

  it("starts the server as that user through sudo and env -i, with exactly the probe environment", async () => {
    const { run } = fakeRun();
    const spawned = [];
    const sb = userSandbox({ run, spawnFn: (cmd, argv, opts) => (spawned.push({ cmd, argv, opts }), new EventEmitter()) });
    const box = await sb.create();
    box.spawn("/opt/node/bin/npx", ["-y", "pkg@1.0.0"], { PATH: "/usr/bin", HOME: box.home });
    const s = spawned[0];
    expect(s.cmd).toBe("sudo");
    expect(s.argv).toEqual(["-n", "-u", box.name, "--", "/usr/bin/env", "-i", "-C", box.home, "PATH=/usr/bin", `HOME=${box.home}`, "/opt/node/bin/npx", "-y", "pkg@1.0.0"]);
    expect(s.opts.env).toEqual({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
    expect(() => box.spawn("/x", [], { A: "1\nB=2" })).toThrow(IsolationError);
  });

  it("removes the user after the probe: kills every process until none is left, then its temp files, home, user, group", async () => {
    const { run, calls } = fakeRun({ alivePasses: 3 });
    const box = await userSandbox({ run, sleep: async () => {} }).create();
    calls.length = 0;
    await box.destroy();
    const verbs = calls.map((c) => c[0]);
    expect(verbs.filter((v) => v === "pkill")).toHaveLength(8);
    expect(calls.find((c) => c[0] === "pkill")).toEqual(["pkill", "-KILL", "-u", String(box.uid)]);
    const lastKill = verbs.lastIndexOf("pkill");
    for (const v of ["find", "rm", "userdel", "groupdel"]) expect(verbs.indexOf(v)).toBeGreaterThan(lastKill);
    const find = calls.find((c) => c[0] === "find");
    for (const d of SHARED_TMP) expect(find).toContain(d);
    expect(find.join(" ")).toContain(`-uid ${box.uid} -prune -exec rm -rf -- {} +`);
    expect(calls.find((c) => c[0] === "rm")).toEqual(["rm", "-rf", "--", box.home]);
    expect(calls.find((c) => c[0] === "userdel")).toEqual(["userdel", box.name]);
  });

  it("fails closed when a probe user's processes survive: the error is raised and no later probe starts", async () => {
    const { run } = fakeRun({ alivePasses: KILL_TRIES + 1 });
    const sb = userSandbox({ run, sleep: async () => {} });
    const box = await sb.create();
    await expect(box.destroy()).rejects.toThrow(/survived/);
    expect(isolationBroken()).toMatch(/survived/);
    await expect(sb.create()).rejects.toThrow(/isolation broken/);
  });

  it("a probe whose user can't be created doesn't run, and what was made is removed", async () => {
    const { run, calls } = fakeRun({ fail: "useradd" });
    await expect(userSandbox({ run }).create()).rejects.toThrow(IsolationError);
    expect(calls.map((c) => c[0])).toContain("userdel");
    expect(calls.map((c) => c[0])).not.toContain("mkdir");
  });
});

describe("one probe at a time per slot, and the parent's results file", () => {
  it("removes each probe's sandbox before the next probe starts, even when the server can't start", async () => {
    const events = [];
    let n = 0;
    const sandbox = {
      async create() {
        const id = ++n;
        events.push(`create ${id}`);
        return {
          home: "/tmp/x",
          spawn() {
            if (id === 1) throw new Error("spawn failed");
            const child = new EventEmitter();
            child.stdin = new PassThrough();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            setTimeout(() => child.emit("exit", 1), 5);
            return child;
          },
          async destroy() {
            events.push(`destroy ${id}`);
          },
        };
      },
    };
    const shake = (pkg, version, ms, args, registry) => handshake(pkg, version, 1_000, args, registry, { sandbox });
    const npm = async () => ({ version: "1.0.0", fingerprint: "sha256:x" });
    await probeOne({ pkg: "a" }, { npm, shake });
    await probeOne({ pkg: "b" }, { npm, shake });
    expect(events).toEqual(["create 1", "destroy 1", "create 2", "destroy 2"]);
  });

  it("writes the results file with mode 600, and in user mode only into a folder closed to every other user", () => {
    const dir = mkdtempSync(join(tmpdir(), "house-results-"));
    try {
      chmodSync(dir, 0o755);
      expect(() => writeResultsFile(join(dir, "results.json"), "{}", { mode: "user", uid: process.getuid() })).toThrow(/mode 700/);
      chmodSync(dir, 0o700);
      expect(() => writeResultsFile(join(dir, "results.json"), "{}", { mode: "user", uid: process.getuid() + 1 })).toThrow(IsolationError);
      writeFileSync(join(dir, "results.json"), "old", { mode: 0o644 });
      writeResultsFile(join(dir, "results.json"), '{"results":[]}', { mode: "user", uid: process.getuid() });
      expect(statSync(join(dir, "results.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, "results.json"), "utf8")).toBe('{"results":[]}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an honest server still records its tools, and sees none of the runner's variables", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_ENV: "/tmp/x", ACTIONS_RUNTIME_TOKEN: "fake", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake", RUNNER_TEMP: "/tmp" });
    try {
      const r = await handshake("honest-fixture", "0.0.0", 10_000, [], "npm", { sandbox: dirSandbox(), command: [process.execPath, [join(fixtures, "honest-server.mjs")]] });
      expect(r.toolsListed).toBe(2);
      expect(r.tools[0]).toEqual({ name: "echo", description: "Echoes the text it is given.", schema: JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }) });
      expect(JSON.parse(r.tools[1].description)).toEqual({ planted: [], homeEntries: [], envLeak: [] });
    } finally {
      process.env = saved;
    }
  });

  it("without user isolation the malicious fixture's attacks succeed, so the CI smoke test's 'blocked' means something", async () => {
    const dir = mkdtempSync(join(tmpdir(), "house-mal-"));
    const results = join(dir, "results.json");
    writeFileSync(results, '{"results":[]}');
    const secret = join(dir, "github_env");
    writeFileSync(secret, "X=1\n");
    try {
      const r = await handshake("malicious-fixture", "0.0.0", 10_000, [], "npm", { sandbox: dirSandbox(), command: [process.execPath, [join(fixtures, "malicious-server.mjs"), results, secret]] });
      const attempts = JSON.parse(r.tools[0].description);
      expect(attempts.results_read).toMatch(/^SUCCEEDED/);
      expect(attempts.path_0_read).toMatch(/^SUCCEEDED/);
      expect(attempts.background_started).toBe("yes");
    } finally {
      // The dir sandbox can't kill a process in its own session (exactly the hole the user sandbox closes): stop it.
      for (const f of readdirSync("/tmp").filter((x) => x.startsWith("house-smoke-planted-"))) {
        try {
          process.kill(Number(f.slice("house-smoke-planted-".length)), "SIGKILL");
        } catch {}
        rmSync(join("/tmp", f), { force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lockdown (fake sudo)", () => {
  it("closes the runner's home, workspace and temp folder (never a system folder) and reports what a probe user reaches", async () => {
    const { run, calls } = fakeRun();
    const box = {
      runAs: async (argv) => {
        if (argv[0] === "/bin/sh" && argv[2].includes("-r")) return { code: 0, stdout: "/home/runner/work/_temp/_runner_file_commands/set_env_1\n", stderr: "" };
        if (argv[0] === "/bin/sh" || argv[0] === "find") return { code: 0, stdout: "", stderr: "" };
        if (argv[0] === "sudo") return { code: 0, stdout: "", stderr: "" };
        if (argv[0] === "id") return { code: 0, stdout: "probe-1 docker\n", stderr: "" };
        return { code: 0, stdout: "v1\n", stderr: "" };
      },
      destroy: async () => calls.push(["destroyed"]),
    };
    const env = { HOME: "/home/runner", GITHUB_WORKSPACE: "/home/runner/work/forge/forge", RUNNER_TEMP: "/home/runner/work/_temp", GITHUB_ENV: "/home/runner/work/_temp/_runner_file_commands/set_env_1", PATH: "/usr/bin" };
    const stat = () => ({ mode: 0o40755 });
    const r = await lockdown({ env, run, sandbox: { create: async () => box }, log: () => {}, trees: [], stat });
    expect(r.locked).toEqual(["/home/runner", "/home/runner/work/forge/forge", "/home/runner/work/_temp"]);
    expect(calls.filter((c) => c[0] === "chmod" && c[1] === "go-rwx").map((c) => c[3])).toEqual(r.locked);
    expect(r.exposed).toEqual(["/home/runner/work/_temp/_runner_file_commands/set_env_1", "sudo", "groups: probe-1 docker"]);
    expect(calls.at(-1)).toEqual(["destroyed"]);
    expect(lockTargets({ HOME: "/home/runner", RUNNER_TEMP: "relative" })).toEqual(["/home/runner"]);
    for (const p of ["/", "/usr", "/opt", "/home", "/tmp", "/home/"]) expect(lockable(p)).toBe(false);
    expect(lockable("/home/runner/actions-runner")).toBe(true);
  });
});

describe("lockdown closes what later probes run (review, 6 Nov: GitHub's image makes /opt world-writable)", () => {
  /** A toolcache-shaped node and a uv environment in a temp folder, like setup-node and the workflows' /opt/house-uv. */
  function layout() {
    const base = mkdtempSync(join(tmpdir(), "house-trees-"));
    const prefix = join(base, "opt/hostedtoolcache/node/24.11.0/x64");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "lib/node_modules/npm/bin"), { recursive: true });
    writeFileSync(join(prefix, "bin/node"), "", { mode: 0o755 });
    writeFileSync(join(prefix, "lib/node_modules/npm/bin/npx-cli.js"), "", { mode: 0o755 });
    symlinkSync("../lib/node_modules/npm/bin/npx-cli.js", join(prefix, "bin/npx"));
    const venv = join(base, "opt/house-uv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
    writeFileSync(join(venv, "bin/uvx"), "", { mode: 0o755 });
    return { base, prefix, venv, env: { PATH: `${join(prefix, "bin")}:${join(venv, "bin")}:/usr/bin` }, execPath: join(prefix, "bin/node") };
  }

  it("finds node's install prefix, npx's npm, uvx's environment and /usr/local/bin", () => {
    const l = layout();
    try {
      const trees = launcherTrees({ env: l.env, uvx: true, execPath: l.execPath });
      expect(trees).toContain(l.prefix);
      expect(trees).toContain(join(l.prefix, "lib/node_modules/npm"));
      expect(trees).toContain(l.venv);
      expect(trees).toContain("/usr/local/bin");
      expect(launcherTrees({ env: l.env, uvx: false, execPath: l.execPath })).not.toContain(l.venv);
      // A node in /usr/bin or /usr/local/bin: never /usr or /usr/local as a whole.
      const sys = launcherTrees({ env: { PATH: "/nonexistent" }, execPath: "/usr/local/bin/node", real: (p) => p });
      expect(sys).toEqual(["/usr/local/bin"]);
      expect(launcherTrees({ env: { PATH: "/nonexistent" }, execPath: "/usr/bin/node", real: (p) => p })).toEqual(["/usr/local/bin"]);
      expect(parentsOf("/opt/hostedtoolcache/node")).toEqual(["/opt/hostedtoolcache", "/opt", "/"]);
    } finally {
      rmSync(l.base, { recursive: true, force: true });
    }
  });

  it("removes group and other write from each tree and every writable parent (not sticky ones), then checks as a probe user", async () => {
    const { run, calls } = fakeRun();
    const asked = [];
    const box = {
      runAs: async (argv) => {
        asked.push(argv);
        if (argv[0] === "find") return { code: 0, stdout: argv[1] === "/opt/hostedtoolcache/node/24/x64" ? "/opt/hostedtoolcache/node/24/x64/lib/node_modules/npm/bin/npx-cli.js\n" : "", stderr: "" };
        if (argv[0] === "/bin/sh" && argv[2].includes("-r")) return { code: 0, stdout: "", stderr: "" };
        if (argv[0] === "/bin/sh") return { code: 0, stdout: argv.includes("/opt") ? "/opt\n" : "", stderr: "" };
        if (argv[0] === "sudo") return { code: argv[2] === "-l" ? 0 : 1, stdout: "", stderr: "" };
        if (argv[0] === "id") return { code: 0, stdout: "probe-1\n", stderr: "" };
        return { code: 0, stdout: "v1\n", stderr: "" };
      },
      destroy: async () => {},
    };
    // GitHub's image: /opt and the toolcache 777, /tmp sticky, the rest 755.
    const modes = { "/opt": 0o40777, "/opt/hostedtoolcache": 0o40777, "/opt/hostedtoolcache/node": 0o40777, "/opt/hostedtoolcache/node/24": 0o40777, "/opt/hostedtoolcache/node/24/x64": 0o40777, "/usr/local/bin": 0o40777, "/tmp": 0o41777 };
    const stat = (d) => ({ mode: modes[d] ?? 0o40755 });
    const trees = ["/opt/hostedtoolcache/node/24/x64", "/usr/local/bin", "/tmp/house-x"];
    const r = await lockdown({ env: { PATH: "/usr/bin" }, run, sandbox: { create: async () => box }, log: () => {}, trees, stat });
    const recursive = calls.filter((c) => c[0] === "chmod" && c[1] === "-R").map((c) => c.slice(1));
    expect(recursive).toEqual(trees.map((t) => ["-R", "go-w", "--", t]));
    const single = calls.filter((c) => c[0] === "chmod" && c[1] === "go-w").map((c) => c[3]);
    for (const d of ["/opt", "/opt/hostedtoolcache", "/opt/hostedtoolcache/node", "/opt/hostedtoolcache/node/24", "/opt/hostedtoolcache/node/24/x64", "/usr/local/bin"]) expect(single).toContain(d);
    expect(single).not.toContain("/tmp");
    expect(single).not.toContain("/usr");
    // Checked as the probe user: every non-sticky parent, and each tree with find (symlinks skipped).
    const dirCheck = asked.find((a) => a[0] === "/bin/sh" && !a[2].includes("-r"));
    expect(dirCheck).toContain("/opt");
    expect(dirCheck).not.toContain("/tmp");
    expect(asked.filter((a) => a[0] === "find").map((a) => a.slice(1))).toEqual(trees.map((t) => [t, "!", "-type", "l", "-writable", "-print", "-quit"]));
    // A rule for one command still counts as sudo (sudo -n -l).
    expect(r.exposed).toEqual(["writable: /opt", "writable: /opt/hostedtoolcache/node/24/x64/lib/node_modules/npm/bin/npx-cli.js", "sudo"]);
    expect(r.trees).toEqual(trees);
  });
});

describe("a hostile server's output can't crash or confuse the parent (review, 6 Nov)", () => {
  const shake = (mode, ms = 10_000) => handshake("hostile", "0.0.0", ms, [], "npm", { sandbox: dirSandbox(), command: [process.execPath, [join(fixtures, "hostile-output.mjs"), mode]] });

  it("skips `null` and other non-object JSON lines instead of throwing (which ended the shard's process)", async () => {
    const r = await shake("null");
    expect(r.initialized).toBe(true);
    expect(r.toolsListed).toBe(1);
  });

  it("ends the probe when a line grows past MAX_LINE without a newline, long before the time limit", async () => {
    const t0 = Date.now();
    const r = await shake("flood", 60_000);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.initialized).toBe(true);
    expect(r.toolsListed).toBeUndefined();
    expect(r.stderr).toContain(`output line over ${MAX_LINE} characters`);
    expect(MAX_LINE).toBeGreaterThanOrEqual(4 << 20);
  }, 40_000);

  it("keeps a multi-byte character that the server's writes cut in half", async () => {
    const r = await shake("split");
    expect(r.tools[0].description).toBe("Échos — “quoted” ✓");
  });
});

describe("the House workflows use the user sandbox", () => {
  const read = (f) => readFileSync(join(root, f), "utf8");
  it("every probe step sets HOUSE_ISOLATION: user after a lockdown step; uv is root-owned; CI runs the real smoke test", () => {
    for (const f of [".github/workflows/house-backfill-shard.yml", ".github/workflows/house-tester.yml"]) {
      const y = read(f);
      const lock = y.indexOf("integrations/house/isolate.mjs\" lockdown");
      const probe = y.search(/(backfill|probe)\.mjs" run plan\.json/);
      expect(lock).toBeGreaterThan(0);
      expect(probe).toBeGreaterThan(lock);
      expect(y.slice(lock, probe)).toContain("HOUSE_ISOLATION: user");
      expect(y).toContain("sudo python3 -m venv /opt/house-uv");
      expect(y).not.toContain("uv-venv");
    }
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("run: node integrations/house/test/isolation-smoke.mjs");
    // It locks the runner's home, so it is the last step.
    expect(ci.trimEnd().endsWith("run: node integrations/house/test/isolation-smoke.mjs")).toBe(true);
    expect(existsSync(join(root, "integrations/house/test/fixtures/malicious-server.mjs"))).toBe(true);
  });
});
