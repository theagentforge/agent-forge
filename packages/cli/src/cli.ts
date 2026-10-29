import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  writeConfig: async (name, text) => {
    await mkdir(settings, { recursive: true });
    await writeFile(join(settings, name), text);
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
}).then(
  (code) => {
    process.exitCode = code;
  },
  // Something unexpected threw. A hook still exits 0 with no output, so the client carries on (fail open).
  () => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  },
);
