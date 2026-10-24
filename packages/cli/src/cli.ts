import { readFile } from "node:fs/promises";
import { run } from "./run";

run(process.argv.slice(2), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  fetch,
  readFile: (path) => readFile(path, "utf8").catch(() => null),
}).then((code) => {
  process.exitCode = code;
});
