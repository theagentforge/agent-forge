// Builds the Claude Code plugin into one zip per environment, served by the Worker from /plugins/.
// Deterministic: the same source always gives the same bytes, so the sha256 in /marketplace.json is stable and
// `pnpm --filter @forge/claude-code-plugin build --check` fails CI if someone forgot to rebuild.
import { build } from "esbuild";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "apps", "forge", "public", "plugins");
// The complete production plugin as plain files, for directories that install from a Git folder (the Claude plugin
// directory reads the public mirror). Same bytes as the production zip's contents; CI checks it like the zips.
const distDir = join(here, "release", "forge");
const check = process.argv.includes("--check");
const ENVS = { staging: "https://staging.theagentforge.io", production: "https://theagentforge.io" };
// Local-time midnight on purpose: zip stores times in local DOS fields (fflate reads getFullYear/getHours), so a UTC
// instant gave different bytes in Colombo and on CI (29 Oct). Local midnight writes the same fields in every time zone.
const MTIME = new Date(2026, 0, 1, 0, 0, 0);

// What each hook does, printed at the top of its built file for the directory's reviewers (REVIEWERS.md).
const HOOK_HEADERS = {
  "pre-install": "PreToolUse (Bash): before an install command runs, look the package up at <origin>/api/v1/check.",
  strain: "PostToolUse, PostToolUseFailure and Stop: count tool failures on this machine; at Stop, draft field reports.",
  "session-start": "SessionStart: add the trap card; once a week send skill fingerprints to <origin>/api/v1/watch.",
};

const hooks = {};
for (const name of ["pre-install", "strain", "session-start"]) {
  const r = await build({
    entryPoints: [join(here, "src", "hooks", `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    // Readable, not minified (29 Oct): the directory's security scan holds code it can't read, and its checklist
    // asks for "readable source instead of compiled, packed, or minified code". Self-contained: one file per hook,
    // Node built-ins only, nothing downloaded or installed at run time.
    minify: false,
    legalComments: "none",
    banner: {
      js: [
        `// The Agent Forge plugin for Claude Code: hooks/${name}.mjs`,
        `// ${HOOK_HEADERS[name]}`,
        `// Built (bundled, not minified) from integrations/claude-code-plugin/src/hooks/${name}.ts and packages/shared/src in`,
        "// https://github.com/theagentforge/agent-forge. Self-contained: Node built-ins only, no packages installed or",
        "// downloaded. Fails open. What it reads, writes and sends: README.md and REVIEWERS.md in this plugin.",
      ].join("\n"),
    },
    write: false,
  });
  hooks[`hooks/${name}.mjs`] = r.outputFiles[0].contents;
}

function walk(dir) {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) Object.assign(out, walk(p));
    else out[relative(join(here, "plugin"), p).split("\\").join("/")] = readFileSync(p);
  }
  return out;
}
const base = walk(join(here, "plugin"));
const { version, description } = JSON.parse(base[".claude-plugin/plugin.json"].toString());

// The description too, so /marketplace.json says what this version does (it lists the plugin before install).
const manifest = { version, description, files: {} };
const outputs = {};
for (const [env, origin] of Object.entries(ENVS)) {
  const files = {
    ...base,
    ...hooks,
    "forge.json": Buffer.from(JSON.stringify({ origin }) + "\n"),
    // The anonymous read-only address first, so the tools work straight after install with no sign-in (as /connect
    // says); the signed-in address alongside, for filing the field reports the Stop hook drafts. It asks for GitHub
    // sign-in only when it's first used. The Gauntlet's no-sign-in server is for /forge:gauntlet (OA-04).
    ".mcp.json": Buffer.from(JSON.stringify({ mcpServers: { forge: { type: "http", url: `${origin}/mcp/public` }, "forge-reports": { type: "http", url: `${origin}/mcp` }, "forge-gauntlet": { type: "http", url: `${origin}/mcp/gauntlet` } } }, null, 2) + "\n"),
  };
  const entries = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((k) => [`forge/${k}`, [new Uint8Array(files[k]), { mtime: MTIME, level: 9 }]]),
  );
  const zip = zipSync(entries);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const file = `forge-${env}-${version}-${sha256.slice(0, 12)}.zip`;
  manifest.files[env] = { file, sha256 };
  if (env === "production") outputs.__dist = files;
  outputs[file] = zip;
}
outputs["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
const dist = outputs.__dist;
delete outputs.__dist;

/** Files in a folder, relative paths to bytes (empty if the folder doesn't exist). */
function readTree(dir) {
  try {
    const out = {};
    for (const f of readdirSync(dir, { recursive: true })) {
      const p = join(dir, f);
      if (statSync(p).isFile()) out[String(f).split("\\").join("/")] = readFileSync(p);
    }
    return out;
  } catch {
    return {};
  }
}

if (check) {
  const stale = Object.keys(outputs).filter((f) => {
    try {
      return !Buffer.from(outputs[f]).equals(readFileSync(join(outDir, f)));
    } catch {
      return true;
    }
  });
  const have = readTree(distDir);
  const distStale = Object.keys(dist).length !== Object.keys(have).length || Object.entries(dist).some(([k, v]) => !have[k] || !Buffer.from(v).equals(have[k]));
  if (distStale) stale.push("release/forge");
  if (stale.length) {
    console.error(`Plugin build is out of date (${stale.join(", ")}). Run: pnpm --filter @forge/claude-code-plugin build`);
    process.exit(1);
  }
  console.log("Plugin build is up to date.");
} else {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [f, b] of Object.entries(outputs)) writeFileSync(join(outDir, f), b);
  rmSync(distDir, { recursive: true, force: true });
  for (const [f, b] of Object.entries(dist)) {
    mkdirSync(dirname(join(distDir, f)), { recursive: true });
    writeFileSync(join(distDir, f), b);
  }
  console.log(`Built ${Object.keys(manifest.files).map((e) => manifest.files[e].file).join(", ")}`);
}
