import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { readInputs, run, type Event } from "./run";

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const inside = (p: string) => {
  const full = resolve(join(root, p));
  return full === root || full.startsWith(root + sep) ? full : null;
};
const append = (file: string | undefined, text: string) => {
  if (file) appendFileSync(file, text);
};
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", ".venv", "target"]);

/** Every file in the checkout, repo-relative with forward slashes, up to 20,000 (big folders are skipped). */
function listFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= 20_000) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

function readEvent(): Event {
  let payload: { pull_request?: { number?: number; head?: { sha?: string } } } = {};
  try {
    payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  } catch {
    // Not in Actions, or no event file: scan everything, no comment.
  }
  return {
    name: process.env.GITHUB_EVENT_NAME ?? "",
    repo: process.env.GITHUB_REPOSITORY ?? "",
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
    sha: payload.pull_request?.head?.sha ?? process.env.GITHUB_SHA ?? "HEAD",
    pr: typeof payload.pull_request?.number === "number" ? payload.pull_request.number : null,
  };
}

const inputs = readInputs(process.env);
if (typeof inputs === "string") {
  process.stdout.write(`::error title=forge-skill-scan::${inputs}\n`);
  process.exitCode = 1;
} else {
  run(inputs, readEvent(), {
    listFiles,
    // Only files inside the checked-out repository are read.
    readFile: (p) => {
      const full = inside(p);
      if (!full) return null;
      try {
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },
    fetch,
    log: (s) => process.stdout.write(`${s}\n`),
    command: (s) => process.stdout.write(`${s}\n`),
    summary: (md) => append(process.env.GITHUB_STEP_SUMMARY, md),
    output: (name, value) => append(process.env.GITHUB_OUTPUT, `${name}=${value.replace(/\r?\n/g, " ")}\n`),
    writeFile: (p, text) => {
      const full = inside(p);
      if (full) writeFileSync(full, text);
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stdout.write(`::error title=forge-skill-scan::${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
