// Bundles the action into dist/index.mjs (GitHub runs the committed file; there is no install step).
// `--check` fails CI if someone changed src/ without rebuilding.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "index.mjs");
const r = await build({
  entryPoints: [join(here, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  write: false,
});
const code = r.outputFiles[0].text;
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {}
  if (current !== code) {
    console.error("integrations/skill-scan-action/dist/index.mjs is out of date. Run: pnpm --filter @forge/skill-scan-action build");
    process.exit(1);
  }
  console.log("skill-scan-action bundle is current");
} else {
  writeFileSync(out, code);
  console.log(`wrote ${out} (${code.length} bytes)`);
}
