import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readInputs, run } from "./run";

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const append = (file: string | undefined, text: string) => {
  if (file) appendFileSync(file, text);
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
