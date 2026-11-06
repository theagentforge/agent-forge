// House tester isolation (ADR 0134 amendment 2). Every server/version probe runs as a fresh unprivileged OS user:
// created just before the probe (no sudo rights, its own group, a home at /tmp/probe-<n>-<random> with mode 700),
// started with a minimal explicit environment (never the runner's), and removed afterwards (every process of that
// user killed, its files in the shared temp folders deleted, then the user, its group and its home), before that
// slot's next probe. The parent process (the runner user) reads tools/list from the server's stdout and writes the
// results file itself (mode 600, in a folder only it can open). Package code therefore can't rewrite another server's
// result, read the job's environment or files, or leave a process behind that touches the next probe.
//
// Two sandboxes:
//   "user" (HOUSE_ISOLATION=user; the House workflows set it): the real thing, via `sudo -n` (GitHub-hosted runners
//          give the runner user passwordless sudo; the probe users get none).
//   "dir"  (default, for local runs and tests): the old scratch-folder sandbox, same user. Not isolation; it exists so
//          the code runs on a laptop. Any other HOUSE_ISOLATION value is refused.
// The command runner is injectable, so the user sandbox's exact commands are unit-tested without root
// (integrations/house/test/isolate.test.mjs); integrations/house/test/isolation-smoke.mjs runs a malicious fixture
// for real on a CI runner (ci.yml).
//
// CLI: node isolate.mjs lockdown [--uvx] → closes the runner's own folders to other users, then checks, as a throwaway probe
//                                     user, that none of them (nor $GITHUB_* files, the runner's directory or the
//                                     docker socket) can be read or written, that nothing it or a later probe runs code
//                                     from (node, npx, uvx and their parent folders) is writable, and that it can't
//                                     sudo; exits 1 if any can.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export class IsolationError extends Error {}

/** "user" or "dir" from HOUSE_ISOLATION (unset or empty = "dir"); anything else is refused, never guessed. */
export function isolationMode(env = process.env) {
  const v = env.HOUSE_ISOLATION ?? "";
  if (v === "" || v === "dir") return "dir";
  if (v === "user") return "user";
  throw new IsolationError(`HOUSE_ISOLATION must be "user" or "dir", not ${JSON.stringify(v)}`);
}

/** The first executable called `name` on a PATH string, or null. */
export function whichIn(name, pathStr = process.env.PATH ?? "") {
  for (const d of pathStr.split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {}
  }
  return null;
}

/**
 * The probe's PATH: the launcher's folder, node's folder, then the system folders. Never the runner's PATH. Review
 * (6 Nov): /usr/local/bin comes after /usr/bin and /bin, because GitHub's image makes it world-writable (lockdown
 * closes it, but a symlink in it can still point into a world-writable tree), so it must never shadow a system tool.
 */
export function probePath(launcherPath, execPath = process.execPath) {
  const dirs = [launcherPath && launcherPath.includes("/") ? dirname(launcherPath) : null, dirname(execPath), "/usr/bin", "/bin", "/usr/local/bin"];
  return [...new Set(dirs.filter(Boolean))].join(":");
}

/** Network settings passed through as today (none are set on GitHub-hosted runners). */
export const NETWORK_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

/**
 * The whole environment a server starts with: PATH, HOME, LANG, TMPDIR, the npm and uv caches inside its home, and
 * the network settings above. Nothing else of the runner's (no GITHUB_*, ACTIONS_*, RUNNER_* or tokens).
 */
export function probeEnv(home, { path, parentEnv = process.env } = {}) {
  return {
    PATH: path ?? probePath(null),
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: home,
    CI: "1",
    npm_config_cache: join(home, ".npm"),
    npm_config_update_notifier: "false",
    UV_CACHE_DIR: join(home, ".uv-cache"),
    UV_TOOL_DIR: join(home, ".uv-tools"),
    UV_PYTHON_INSTALL_DIR: join(home, ".uv-python"),
    UV_PYTHON_PREFERENCE: "system",
    UV_NO_CONFIG: "1",
    ...Object.fromEntries(NETWORK_VARS.filter((k) => parentEnv[k]).map((k) => [k, parentEnv[k]])),
    ...(parentEnv.NODE_EXTRA_CA_CERTS ? { npm_config_cafile: parentEnv.NODE_EXTRA_CA_CERTS } : {}),
  };
}

const SAFE_VALUE = /^[^\0\n]*$/;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `sudo -n <argv>`, never throwing: { code, stdout, stderr }. sudo itself gets a bare PATH, not the runner's env. */
export function sudoRun(argv) {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", ...argv.map(String)], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, timeout: 60_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Shared temp folders any user can write to: a probe's leftovers there are deleted with it. */
export const SHARED_TMP = ["/tmp", "/var/tmp", "/dev/shm", "/run/lock"];
/** Probe users get UIDs from here up, one new UID per probe, never reused within a run (no file outlives its owner). */
export const UID_BASE = 42_000;
export const KILL_TRIES = 50;

let counter = 0;
let broken = null;
/** Why isolation can no longer be trusted in this process (a probe user's processes survived), or null. */
export const isolationBroken = () => broken;
/** Tests only: forget a broken state. */
export const resetIsolationForTests = () => {
  broken = null;
};

/**
 * The real sandbox: a fresh OS user per probe. `run` executes one command with root rights (`sudo -n` by default) and
 * resolves { code, stdout, stderr }; `spawnFn` starts the server (as that user, through sudo).
 */
export function userSandbox({ run = sudoRun, spawnFn = spawn, random = () => randomBytes(6).toString("hex"), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), uidBase = UID_BASE } = {}) {
  const must = async (argv, what) => {
    const r = await run(argv);
    if (r.code !== 0) throw new IsolationError(`${what} failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    return r;
  };
  return {
    mode: "user",
    async create() {
      if (broken) throw new IsolationError(`isolation broken earlier: ${broken}`);
      const n = ++counter;
      const name = `probe-${n}`;
      const uid = uidBase + n;
      const home = `/tmp/probe-${n}-${random()}`;
      const box = {
        name,
        uid,
        home,
        /** Starts `cmd argv` as this user, in its home, with exactly `env` (env -i: nothing of the runner's). */
        spawn(cmd, argv, env) {
          for (const [k, v] of Object.entries(env)) if (!SAFE_KEY.test(k) || !SAFE_VALUE.test(String(v))) throw new IsolationError(`unsafe env ${k}`);
          const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
          return spawnFn("sudo", ["-n", "-u", name, "--", "/usr/bin/env", "-i", "-C", home, ...pairs, cmd, ...argv], {
            cwd: "/",
            env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
            stdio: ["pipe", "pipe", "pipe"],
          });
        },
        /** Runs a short command as this user (lockdown checks), with a bare environment. */
        runAs(argv, extraEnv = {}) {
          const pairs = Object.entries({ PATH: "/usr/bin:/bin", HOME: home, ...extraEnv }).map(([k, v]) => `${k}=${v}`);
          return run(["-u", name, "--", "/usr/bin/env", "-i", "-C", home, ...pairs, ...argv]);
        },
        async destroy() {
          // 1. Kill every process of this user (effective and real UID) until none is left; a fork loop gets more passes.
          let alive = true;
          for (let i = 0; i < KILL_TRIES && alive; i++) {
            await run(["pkill", "-KILL", "-u", uid]);
            await run(["pkill", "-KILL", "-U", uid]);
            const a = await run(["pgrep", "-u", uid]);
            const b = await run(["pgrep", "-U", uid]);
            alive = a.code === 0 || b.code === 0;
            if (alive) await sleep(100);
          }
          if (alive) {
            broken = `processes of ${name} (uid ${uid}) survived ${KILL_TRIES} kill passes`;
            throw new IsolationError(broken);
          }
          // 2. Its scheduled jobs, and its files in the shared temp folders (they could feed a later probe). Folders
          //    that aren't world-writable and aren't its own can't hold its files, so they're skipped; its own folders
          //    are removed whole.
          await run(["crontab", "-r", "-u", name]);
          await run(["find", ...SHARED_TMP, "-xdev", "(", "-type", "d", "!", "-uid", uid, "!", "-perm", "-0002", ")", "-prune", "-o", "-uid", uid, "-prune", "-exec", "rm", "-rf", "--", "{}", "+"]);
          await run(["rm", "-rf", "--", home]);
          // 3. The user and its group.
          await run(["userdel", name]);
          await run(["groupdel", name]);
          const left = await run(["id", "-u", name]);
          if (left.code === 0) throw new IsolationError(`${name} still exists after userdel`);
        },
      };
      try {
        await must(["groupadd", "-g", uid, name], "groupadd");
        await must(["useradd", "-M", "-N", "-l", "-u", uid, "-g", uid, "-d", home, "-s", "/usr/sbin/nologin", name], "useradd");
        // mkdir (not -p) fails if the path exists: nothing planted there beforehand is ever taken over.
        await must(["mkdir", "-m", "700", "--", home], "mkdir home");
        await must(["chown", `${uid}:${uid}`, "--", home], "chown home");
      } catch (e) {
        await box.destroy().catch(() => {});
        throw e;
      }
      return box;
    },
  };
}

/** The local sandbox (not isolation): a scratch folder as HOME, same user, process group killed afterwards. */
export function dirSandbox({ spawnFn = spawn } = {}) {
  return {
    mode: "dir",
    async create() {
      const home = mkdtempSync(join(tmpdir(), "house-"));
      let child = null;
      return {
        name: null,
        uid: null,
        home,
        spawn(cmd, argv, env) {
          child = spawnFn(cmd, argv, { cwd: home, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
          return child;
        },
        async destroy() {
          try {
            if (child?.pid) process.kill(-child.pid, "SIGKILL");
          } catch {}
          rmSync(home, { recursive: true, force: true });
        },
      };
    },
  };
}

const sandboxes = {};
/** The sandbox for this process's HOUSE_ISOLATION (one instance per mode). */
export function defaultSandbox(env = process.env) {
  const mode = isolationMode(env);
  return (sandboxes[mode] ??= mode === "user" ? userSandbox() : dirSandbox());
}

/**
 * Writes the results file as the parent (runner) user: mode 600. In user mode the folder must be the parent's own
 * and closed to group and others (so no probe user can open, replace or delete the file); otherwise nothing is written.
 */
export function writeResultsFile(path, text, { mode = isolationMode(), uid = process.getuid?.() } = {}) {
  if (mode === "user") {
    const st = statSync(dirname(path));
    if (st.uid !== uid || (st.mode & 0o077) !== 0) throw new IsolationError(`results folder ${dirname(path)} must be owned by the runner user with mode 700 (run isolate.mjs lockdown first)`);
  }
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The folders the lockdown closes to other users: the runner's home, workspace and temp folder (holding $GITHUB_*). */
export function lockTargets(env = process.env) {
  return [...new Set([env.HOME, env.GITHUB_WORKSPACE, env.RUNNER_TEMP].filter((p) => typeof p === "string" && p.startsWith("/")))];
}

/** Never chmod a system folder, even if a runner binary is found right under it. */
const NEVER_LOCK = new Set(["/", "/usr", "/usr/local", "/opt", "/home", "/tmp", "/var", "/etc", "/bin", "/sbin", "/lib", "/root", "/run"]);
export const lockable = (p) => typeof p === "string" && p.startsWith("/") && !NEVER_LOCK.has(p.replace(/\/+$/, "") || "/");

/**
 * Review (6 Nov): GitHub's Ubuntu image runs `chmod -R 777 /opt` (and /usr/local/bin, /usr/share) when it is built
 * (actions/runner-images, images/ubuntu/scripts/build/configure-system.sh), so the node that setup-node puts in
 * /opt/hostedtoolcache, its npx, and /opt itself are writable by every user. One probe user could then rewrite npx (or
 * rename the node folder and plant its own) and every later probe in the shard would run that code as its own user:
 * exactly the "another server's result" the sandbox exists to stop. So lockdown removes group and other write from
 * every tree a probe runs code from, and from each of their parent folders (a writable parent lets a folder be renamed
 * and replaced), then checks as a probe user that none of them is writable.
 *
 * The trees: node's install prefix (or, for a node in /usr/bin or /usr/local/bin, its bin folder and npm), npx's npm
 * package, uvx's environment (with --uvx), and /usr/local/bin (on the probe's PATH, last).
 */
export function launcherTrees({ env = process.env, uvx = false, execPath = process.execPath, real = realpathSync } = {}) {
  const trees = new Set();
  const add = (p) => {
    if (lockable(p) && p !== "/usr/bin" && p !== "/usr/sbin") trees.add(p);
  };
  const nodeBin = dirname(real(execPath));
  const prefix = dirname(nodeBin);
  if (lockable(prefix) && prefix !== "/usr") add(prefix);
  else add(nodeBin);
  const npx = whichIn("npx", env.PATH);
  if (npx) {
    add(dirname(npx));
    const r = real(npx);
    const i = r.lastIndexOf("/node_modules/npm/");
    if (i >= 0) add(r.slice(0, i + "/node_modules/npm".length));
  }
  if (uvx) {
    const u = whichIn("uvx", env.PATH);
    if (u) {
      const venv = dirname(dirname(u));
      if (existsSync(join(venv, "pyvenv.cfg"))) add(venv);
      else add(dirname(u));
    }
  }
  add("/usr/local/bin");
  return [...trees];
}

/** Every parent folder of `p`, nearest first, up to and including "/". */
export function parentsOf(p) {
  const out = [];
  for (let d = dirname(p); ; d = dirname(d)) {
    out.push(d);
    if (d === "/" || d === ".") break;
  }
  return out;
}

/** The actions runner's own directory: two levels above the Runner.Worker / Runner.Listener binary. */
export async function runnerDirs(run = sudoRun, procRoot = "/proc") {
  const out = new Set();
  let pids = [];
  try {
    pids = readdirSync(procRoot).filter((p) => /^\d+$/.test(p));
  } catch {}
  for (const pid of pids) {
    let comm = "";
    try {
      comm = readFileSync(join(procRoot, pid, "comm"), "utf8").trim();
    } catch {
      continue;
    }
    if (!/^Runner\.(Worker|Listener)$/.test(comm)) continue;
    const r = await run(["readlink", "-f", join(procRoot, pid, "exe")]);
    const exe = r.stdout.trim();
    if (r.code === 0 && exe.startsWith("/")) out.add(dirname(dirname(exe)));
  }
  return [...out];
}

/** What a probe user must never reach: the locked folders, the $GITHUB_* files, the runner's directory, docker. */
export function sensitivePaths(env, locked) {
  const files = ["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STATE", "GITHUB_STEP_SUMMARY", "GITHUB_EVENT_PATH"].map((k) => env[k]).filter((p) => typeof p === "string" && p.startsWith("/"));
  return [...new Set([...locked, ...files, "/var/run/docker.sock", "/run/docker.sock"])];
}

/**
 * Closes the runner's folders to other users, then checks as a throwaway probe user that none of the sensitive paths
 * can be read or written, that it can't sudo, isn't in the docker group, and can still run node/npx/uvx.
 */
export async function lockdown({ env = process.env, run = sudoRun, sandbox = userSandbox({ run }), log = console.log, uvx = false, trees = launcherTrees({ env, uvx }), stat = statSync } = {}) {
  const runners = (await runnerDirs(run)).filter(lockable);
  const locked = [...lockTargets(env), ...runners].filter(lockable);
  for (const p of locked) {
    const r = await run(["chmod", "go-rwx", "--", p]);
    if (r.code !== 0) throw new IsolationError(`chmod ${p} failed: ${r.stderr.trim()}`);
  }
  // Review (6 Nov): the trees probes run code from, and every parent folder of them and of the locked folders, lose
  // group and other write (see launcherTrees). A sticky world-writable parent (/tmp) is left alone: there only an
  // entry's owner can rename it.
  for (const t of trees) {
    const r = await run(["chmod", "-R", "go-w", "--", t]);
    if (r.code !== 0) throw new IsolationError(`chmod -R go-w ${t} failed: ${r.stderr.trim()}`);
  }
  const pathDirs = probePath(null).split(":");
  const parents = [...new Set([...trees, ...locked, ...pathDirs].flatMap((p) => [p, ...parentsOf(p)]))].filter((p) => p.startsWith("/"));
  const checkDirs = [];
  for (const d of parents) {
    let st;
    try {
      st = stat(d);
    } catch {
      continue;
    }
    if (st.mode & 0o1000) continue;
    checkDirs.push(d);
    if (st.mode & 0o022) {
      const r = await run(["chmod", "go-w", "--", d]);
      if (r.code !== 0) throw new IsolationError(`chmod go-w ${d} failed: ${r.stderr.trim()}`);
    }
  }
  for (const sock of ["/var/run/docker.sock", "/run/docker.sock"]) if (existsSync(sock)) await run(["chmod", "o-rwx", "--", sock]);
  const box = await sandbox.create();
  const exposed = [];
  const notes = [];
  try {
    const paths = sensitivePaths(env, locked);
    const r = await box.runAs(["/bin/sh", "-c", 'for p do if [ -r "$p" ] || [ -w "$p" ]; then echo "$p"; fi; done', "sh", ...paths]);
    for (const p of r.stdout.split("\n").filter(Boolean)) exposed.push(p);
    // Nothing a later probe runs, nor any folder above it, may be writable by a probe user (symlinks are skipped:
    // their own mode means nothing; a link pointing out of a tree is the residual noted in launcherTrees).
    const w = await box.runAs(["/bin/sh", "-c", 'for p do if [ -w "$p" ]; then echo "$p"; fi; done', "sh", ...checkDirs]);
    for (const p of w.stdout.split("\n").filter(Boolean)) exposed.push(`writable: ${p}`);
    for (const t of trees) {
      const f = await box.runAs(["find", t, "!", "-type", "l", "-writable", "-print", "-quit"]);
      for (const p of f.stdout.split("\n").filter(Boolean)) exposed.push(`writable: ${p}`);
    }
    // `sudo -n -l` also catches a sudoers rule for one command, which `sudo -n true` would miss.
    if ((await box.runAs(["sudo", "-n", "true"])).code === 0 || (await box.runAs(["sudo", "-n", "-l"])).code === 0) exposed.push("sudo");
    const groups = (await box.runAs(["id", "-Gn"])).stdout.trim().split(/\s+/);
    if (groups.includes("docker") || groups.includes("sudo") || groups.includes("adm")) exposed.push(`groups: ${groups.join(" ")}`);
    const tools = [process.execPath, whichIn("npx", env.PATH) ?? "npx", ...(uvx ? [whichIn("uvx", env.PATH) ?? "uvx"] : [])];
    for (const tool of tools) {
      const t = await box.runAs([tool, "--version"], { PATH: probePath(tool) });
      if (t.code !== 0) exposed.push(`cannot run ${tool} as a probe user (${t.stderr.trim().slice(0, 120)})`);
      else notes.push(`${tool}: ${t.stdout.trim().split("\n")[0]}`);
    }
  } finally {
    await box.destroy();
  }
  log(`Locked to the runner user: ${locked.join(", ") || "(none)"}; runner directory: ${runners.join(", ") || "not found"}`);
  log(`Not writable by other users: ${trees.join(", ") || "(none)"} and their parent folders`);
  for (const n of notes) log(`Probe user can run ${n}`);
  return { locked, runners, trees, exposed };
}

async function main() {
  const [cmd, ...flags] = process.argv.slice(2);
  if (cmd === "lockdown") {
    const r = await lockdown({ uvx: flags.includes("--uvx") });
    if (r.exposed.length) {
      for (const p of r.exposed) console.log(`::error::Probe users can reach ${p}`);
      process.exit(1);
    }
    console.log("Lockdown verified: a probe user can't read or write any of the runner's folders, $GITHUB_* files, the runner directory or the docker socket, and can't sudo.");
    return;
  }
  throw new Error("usage: node isolate.mjs lockdown");
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
