import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readInputs, run } from "./run";

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const append = (file: string | undefined, text: string) => {
  if (file) appendFileSync(file, text);
};
// The state file may live in the workspace or the runner's temp folder (where actions/cache restores it), nowhere else.
const temp = process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP) : null;
const statePath = (p: string) => {
  const full = isAbsolute(p) ? resolve(p) : resolve(join(root, p));
  return [root, temp].some((d) => d && (full === d || full.startsWith(d + sep))) ? full : null;
};

const inputs = readInputs(process.env);
if (typeof inputs === "string") {
  process.stdout.write(`::error title=forge-check::${inputs}\n`);
  process.exitCode = 1;
} else {
  run(inputs, {
    // Only files inside the checked-out repository are read.
    readFile: (p) => {
      const full = resolve(join(root, p));
      if (full !== root && !full.startsWith(root + sep)) return null;
      try {
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },
    fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (s) => process.stdout.write(`${s}\n`),
    command: (s) => process.stdout.write(`${s.replace(/\r?\n/g, " ")}\n`),
    summary: (md) => append(process.env.GITHUB_STEP_SUMMARY, md),
    output: (name, value) => append(process.env.GITHUB_OUTPUT, `${name}=${value.replace(/\r?\n/g, " ")}\n`),
    readState: (p) => {
      const full = statePath(p);
      if (!full) return null;
      try {
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },
    writeState: (p, text) => {
      const full = statePath(p);
      if (!full) return process.stdout.write(`::warning title=forge-check::state-file must be inside the workspace or the runner's temp folder\n`);
      try {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      } catch {}
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stdout.write(`::error title=forge-check::${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
