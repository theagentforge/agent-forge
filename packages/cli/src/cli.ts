import { run } from "./run";

run(process.argv.slice(2), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  fetch,
}).then((code) => {
  process.exitCode = code;
});
