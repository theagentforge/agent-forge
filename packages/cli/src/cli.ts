import { execFile } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { LocalSkill } from "@forge/shared/light";
import { run } from "./run";
import { cacheDir, configDir } from "./state";

/** All of stdin, up to 1 MB, giving up after 2 s so a hook never hangs the client waiting for input. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, 2000);
    process.stdin.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) return done();
      chunks.push(c);
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

const home = homedir();
const dir = cacheDir(process.env, process.platform, home);
const settings = configDir(process.env, process.platform, home);

/** A yes at a real terminal only: an agent's shell or CI has no TTY, so it can't confirm a filing. */
async function confirm(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** `setup`'s questions go to stderr, so `setup --json` keeps stdout for the result. A yes needs a real terminal. */
async function ask(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Runs a program (setup: `claude mcp add`). Windows installs `claude` as a .cmd shim, which only cmd.exe can start; the
 * arguments are fixed strings from setup.ts (no quotes or shell characters), so passing them through cmd is safe.
 */
function exec(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [file, ...rest] = process.platform === "win32" ? [process.env.ComSpec || "cmd.exe", "/d", "/c", ...argv] : argv;
  return new Promise((resolve, reject) => {
    execFile(file!, rest, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** SKILL.md files in the usual skill folders (Claude Code, Codex, the shared .agents folder), at most 50. */
async function skillFiles(): Promise<LocalSkill[]> {
  const dirs = [join(home, ".claude", "skills"), join(process.cwd(), ".claude", "skills"), join(home, ".codex", "skills"), join(home, ".agents", "skills")];
  const out: LocalSkill[] = [];
  for (const d of dirs) {
    const names = await readdir(d).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (out.length >= 50) return out;
      const text = await readFile(join(d, name, "SKILL.md"), "utf8").catch(() => null);
      if (text !== null && text.length <= 262_144) out.push({ label: name, text });
    }
  }
  return out;
}

run(process.argv.slice(2), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  fetch,
  readFile: (path) => readFile(path, "utf8").catch(() => null),
  stdin: readStdin,
  readCache: (name) => readFile(join(dir, name), "utf8").catch(() => null),
  writeCache: async (name, text) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), text);
  },
  readConfig: (name) => readFile(join(settings, name), "utf8").catch(() => null),
  // Atomic (a random temporary name, then a rename): a crash mid-write never leaves a half-written settings file,
  // which matters for setup's manifest (`setup --undo` stops on a damaged one).
  writeConfig: async (name, text) => {
    await mkdir(settings, { recursive: true });
    const tmp = join(settings, `${name}.tmp-${randomBytes(6).toString("hex")}`);
    try {
      await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
      await rename(tmp, join(settings, name));
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  },
  randomUUID: () => randomUUID(),
  confirm,
  terminal: process.stdout.isTTY === true,
  env: process.env,
  sha256Hex: (s) => createHash("sha256").update(s).digest("hex"),
  ed25519Verify: (x, message, signature) => {
    try {
      return verify(null, Buffer.from(message, "utf8"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(signature, "base64url"));
    } catch {
      return false;
    }
  },
  skillFiles,
  setup: { home, platform: process.platform },
  ask,
  exec,
}).then(
  (code) => {
    process.exitCode = code;
  },
  // Something unexpected threw. A hook still exits 0 with no output, so the client carries on (fail open).
  () => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  },
);
