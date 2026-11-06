// House probe isolation, for real (ADR 0134 amendment 2). Runs in CI (.github/workflows/ci.yml, last step) on a
// GitHub-hosted runner, where the runner user has passwordless sudo, so real throwaway users can be created. Not a
// vitest file: it needs root rights (through sudo) and it locks the runner's home, so it runs as its own CI step.
//
//   1. lockdown(): closes the runner's folders and checks, as a probe user, that nothing sensitive is reachable;
//   2. a malicious fixture runs as probe user A: it tries to (a) overwrite the results file, (b) read GITHUB_ENV,
//      ACTIONS_RUNTIME_TOKEN and OIDC variables (planted canaries), (c) leave a background process behind, and
//      (d) change node, npx, uvx or /usr/local/bin, which every later probe runs (review, 6 Nov);
//   3. an honest fixture runs next as probe user B, in the same slot: it must list its tools, untouched;
//   4. the results file must hold exactly what this (parent) process wrote, with mode 600.
// Exit 0 only if every attack failed and the honest probe recorded its tools.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockdown, runnerDirs, sudoRun, userSandbox, whichIn, writeResultsFile } from "../isolate.mjs";
import { handshake } from "../probe.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const self = fileURLToPath(import.meta.url);

// Stage 0: re-run this script with canary secrets in its own environment (so they sit in /proc/<pid>/environ, where
// a real runner keeps its tokens) and a GITHUB_ENV file holding the canary, in a folder only this user can open.
if (!process.env.FORGE_SMOKE_CANARY) {
  const canary = `canary-${randomBytes(12).toString("hex")}`;
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "house-smoke-"));
  chmodSync(work, 0o700);
  const ghEnv = process.env.GITHUB_ENV ?? join(work, "github_env");
  if (!process.env.GITHUB_ENV) writeFileSync(ghEnv, `FORGE_SMOKE_CANARY=${canary}\n`, { mode: 0o600 });
  const r = spawnSync(process.execPath, [self], {
    stdio: "inherit",
    env: {
      ...process.env,
      HOUSE_ISOLATION: "user",
      FORGE_SMOKE_CANARY: canary,
      FORGE_SMOKE_WORK: work,
      GITHUB_ENV: ghEnv,
      ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN ?? canary,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? canary,
      ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? `https://example.invalid/${canary}`,
    },
  });
  rmSync(work, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const work = process.env.FORGE_SMOKE_WORK;
const canary = process.env.FORGE_SMOKE_CANARY;

// 1. Lockdown, verified as a throwaway probe user.
const lock = await lockdown();
check(lock.exposed.length === 0, `lockdown: nothing reachable by a probe user${lock.exposed.length ? ` (reachable: ${lock.exposed.join(", ")})` : ""}`);

// The fixtures, in a folder probe users can read but not change.
const fixtures = mkdtempSync(join("/tmp", "house-fixture-"));
for (const f of ["mcp-stdio.mjs", "malicious-server.mjs", "honest-server.mjs"]) {
  copyFileSync(join(here, "fixtures", f), join(fixtures, f));
  chmodSync(join(fixtures, f), 0o644);
}
chmodSync(fixtures, 0o755);

const resultsPath = join(work, "results.json");
const results = [];
const write = () => writeResultsFile(resultsPath, JSON.stringify({ results }), { mode: "user" });
write();

// One sandbox for both probes, like one slot of a shard; remember each probe's user.
const real = userSandbox();
const boxes = [];
const sandbox = { mode: "user", create: async () => boxes[boxes.push(await real.create()) - 1] };

// 2. The malicious probe.
const runners = await runnerDirs();
const targets = [process.env.GITHUB_ENV, process.env.GITHUB_OUTPUT, process.env.GITHUB_PATH, process.env.RUNNER_TEMP, process.env.GITHUB_WORKSPACE, process.env.HOME, work, ...runners].filter(Boolean);
// Review (6 Nov): what later probes run (node, npx, uvx and /usr/local/bin, which lockdown closed) and npx's own file.
const npx = whichIn("npx");
const launchers = [...lock.trees, ...(npx ? [realpathSync(npx)] : [])].map((p) => `launcher:${p}`);
const before = readFileSync(resultsPath, "utf8");
const bad = await handshake("malicious-fixture", "0.0.0", 30_000, [], "npm", { sandbox, command: [process.execPath, [join(fixtures, "malicious-server.mjs"), resultsPath, ...targets, ...launchers]] });
const attempts = (() => {
  try {
    return JSON.parse(bad.tools.find((t) => t.name === "attempts")?.description ?? "null");
  } catch {
    return null;
  }
})();
check(attempts !== null, "malicious fixture answered with its attempts");
for (const [k, v] of Object.entries(attempts ?? {})) {
  if (k === "background_started") check(v === "yes", "(c) the malicious fixture's background process was running before cleanup");
  else check(v === "blocked", `${k}: ${v}`);
}
check(readFileSync(resultsPath, "utf8") === before, "(a) the results file is unchanged after the malicious probe");
check(!JSON.stringify(bad).includes(canary), "(b) no canary secret in anything the malicious probe returned");
const a = boxes[0];
check((await sudoRun(["pgrep", "-u", a.uid])).code === 1, `(c) no process of ${a.name} (uid ${a.uid}) is left`);
check((await sudoRun(["id", "-u", a.name])).code !== 0, `${a.name} was deleted`);
check(!readdirSync("/tmp").some((f) => f.startsWith("house-smoke-planted-")), "(c) nothing the malicious probe planted in /tmp is left");
results.push({ server: "npm:malicious-fixture", version: "0.0.0", outcome: "worked", tools_count: bad.toolsListed ?? null });
write();

// Give a surviving background process (there shouldn't be one) time to act before the next probe.
await new Promise((r) => setTimeout(r, 1000));

// 3. The honest probe, next in the same slot.
const good = await handshake("honest-fixture", "0.0.0", 30_000, [], "npm", { sandbox, command: [process.execPath, [join(fixtures, "honest-server.mjs")]] });
check(good.toolsListed === 2 && good.tools[0]?.name === "echo" && good.tools[0]?.description === "Echoes the text it is given.", "the honest probe recorded its tools");
const seen = (() => {
  try {
    return JSON.parse(good.tools.find((t) => t.name === "observations")?.description ?? "null");
  } catch {
    return null;
  }
})();
check(seen && seen.planted.length === 0 && seen.homeEntries.length === 0 && seen.envLeak.length === 0, `the honest probe found nothing planted and no runner variables (${JSON.stringify(seen)})`);
check(boxes.length === 2 && boxes[0].uid !== boxes[1].uid && boxes[0].home !== boxes[1].home, "each probe had its own user and home");
results.push({ server: "npm:honest-fixture", version: "0.0.0", outcome: "worked", tools_count: good.toolsListed ?? null });
write();

// 4. The results file is the parent's, exactly.
const st = statSync(resultsPath);
check((st.mode & 0o777) === 0o600 && st.uid === process.getuid(), "results file is the runner user's, mode 600");
check(readFileSync(resultsPath, "utf8") === JSON.stringify({ results }), "results file holds exactly what the parent wrote");

rmSync(fixtures, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} isolation check(s) failed` : "\nIsolation smoke test passed: every attack failed and the honest probe recorded its tools.");
process.exit(failures.length ? 1 : 0);
