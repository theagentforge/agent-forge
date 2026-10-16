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
const check = process.argv.includes("--check");
const ENVS = { staging: "https://staging.theagentforge.io", production: "https://theagentforge.io" };
const MTIME = new Date("2026-01-01T00:00:00Z");

const hooks = {};
for (const name of ["pre-install", "strain", "session-start"]) {
  const r = await build({
    entryPoints: [join(here, "src", "hooks", `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    minify: true,
    legalComments: "none",
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
const version = JSON.parse(base[".claude-plugin/plugin.json"].toString()).version;

const manifest = { version, files: {} };
const outputs = {};
for (const [env, origin] of Object.entries(ENVS)) {
  const files = {
    ...base,
    ...hooks,
    "forge.json": Buffer.from(JSON.stringify({ origin }) + "\n"),
    ".mcp.json": Buffer.from(JSON.stringify({ mcpServers: { forge: { type: "http", url: `${origin}/mcp` } } }, null, 2) + "\n"),
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
  outputs[file] = zip;
}
outputs["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");

if (check) {
  const stale = Object.keys(outputs).filter((f) => {
    try {
      return !Buffer.from(outputs[f]).equals(readFileSync(join(outDir, f)));
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`Plugin build is out of date (${stale.join(", ")}). Run: pnpm --filter @forge/claude-code-plugin build`);
    process.exit(1);
  }
  console.log("Plugin build is up to date.");
} else {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [f, b] of Object.entries(outputs)) writeFileSync(join(outDir, f), b);
  console.log(`Built ${Object.keys(manifest.files).map((e) => manifest.files[e].file).join(", ")}`);
}
