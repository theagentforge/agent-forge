import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandEnv, readInputs, run, type Event } from "./run";

const append = (file: string | undefined, text: string) => {
  if (file) appendFileSync(file, text);
};

function readEvent(): Event {
  let payload: { pull_request?: { number?: number } } = {};
  try {
    payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  } catch {
    // Not in Actions, or no event file: no comment.
  }
  return {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    pr: typeof payload.pull_request?.number === "number" ? payload.pull_request.number : null,
  };
}

/** The user's command, in bash, in the workspace. Its environment is what a `run:` step gets, minus this action's inputs. */
function runCommand(cmd: string, extra: Record<string, string>, timeoutMs: number): Promise<number> {
  // The command gets none of this action's inputs (the model key in particular never reaches a harness that didn't ask)
  // and none of the runner variables a `run:` step doesn't get either (commandEnv).
  const env = commandEnv(process.env, extra);
  return new Promise((resolve) => {
    const child = spawn("bash", ["-eo", "pipefail", "-c", cmd], { cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(), env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 124 : 1));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
  });
}

const inputs = readInputs(process.env);
if (typeof inputs === "string") {
  process.stdout.write(`::error title=forge-gauntlet::${inputs}\n`);
  process.exitCode = 1;
} else {
  run(inputs, readEvent(), {
    fetch,
    log: (s) => process.stdout.write(`${s}\n`),
    command: (s) => process.stdout.write(`${s}\n`),
    summary: (md) => append(process.env.GITHUB_STEP_SUMMARY, md),
    // Multi-line safe: values here are single-line ids, counts and links.
    output: (name, value) => append(process.env.GITHUB_OUTPUT, `${name}=${value.replace(/\r?\n/g, " ")}\n`),
    runCommand,
    writeTemp: (name, text) => {
      const p = join(process.env.RUNNER_TEMP || tmpdir(), name);
      writeFileSync(p, text);
      return p;
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stdout.write(`::error title=forge-gauntlet::${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
