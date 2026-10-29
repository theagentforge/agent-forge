// Builds the ZIP that Dinike uploads at platform.openai.com/plugins ("Upload new or existing plugin") to list
// The Agent Forge in the ChatGPT and Codex Plugins Directory. Codex layout (OpenAI docs, read 29 Oct 2026):
// .codex-plugin/plugin.json, .mcp.json with exactly one remote MCP server, and the icons the manifest names.
// No hooks and no skills: OpenAI can't take lifecycle hooks in a submitted ZIP, and the app is MCP only.
// Deterministic like the Claude plugin zips (local-midnight mtime, sorted entries), so `--check` gives the same
// answer in every time zone and CI fails if someone forgot to rebuild.
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const brand = join(here, "..", "..", "public", "brand");
const distDir = join(here, "release");
// Local midnight on purpose: zip stores local DOS time fields (see integrations/claude-code-plugin/build.mjs).
const MTIME = new Date(2026, 0, 1, 0, 0, 0);

function walk(dir, root = dir) {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) Object.assign(out, walk(p, root));
    else out[relative(root, p).split("\\").join("/")] = readFileSync(p);
  }
  return out;
}

/** Every file in the package, by its path inside the ZIP. */
export function packageFiles() {
  return {
    ...walk(join(here, "plugin")),
    // The brand's square marks (BRAND.md): 512 px for the directory logo, 400 px for the composer icon.
    "assets/logo.png": readFileSync(join(brand, "forge-logo-512.png")),
    "assets/icon.png": readFileSync(join(brand, "forge-logo-400.png")),
  };
}

const files = packageFiles();
const { version } = JSON.parse(files[".codex-plugin/plugin.json"].toString());
const entries = Object.fromEntries(Object.keys(files).sort().map((k) => [k, [new Uint8Array(files[k]), { mtime: MTIME, level: 9 }]]));
const zip = zipSync(entries);
const name = `the-agent-forge-openai-${version}.zip`;
const sha256 = createHash("sha256").update(zip).digest("hex");

if (process.argv.includes("--check")) {
  let have = null;
  try {
    have = readFileSync(join(distDir, name));
  } catch {}
  const others = (() => {
    try {
      return readdirSync(distDir).filter((f) => f !== name);
    } catch {
      return [];
    }
  })();
  if (!have || !Buffer.from(zip).equals(have) || others.length) {
    console.error(`OpenAI plugin ZIP is out of date (${name}). Run: pnpm --filter @forge/openai-plugin build`);
    process.exit(1);
  }
  console.log(`OpenAI plugin ZIP is up to date (${name}, sha256 ${sha256.slice(0, 12)}).`);
} else {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, name), zip);
  console.log(`Built release/${name} (sha256 ${sha256.slice(0, 12)})`);
}
