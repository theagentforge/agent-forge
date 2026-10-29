// Bundles the CLI (dist/cli.mjs). `forge verify` bundles the open Arena referee from @forge/arena; the private job
// families and held-out seeds (packages/arena/src/private, ADR 0040/0058) are swapped for an empty module here, so the
// published package never carries them. test/build.test.ts checks the bundle.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export const PRIVATE_STUB = `export const PRIVATE_TASKS = []; export const PRIVATE_TRAP_CATALOG = []; export const HELDOUT_PANEL_VERSION = "none"; export const HELDOUT_SEEDS = {};`;

export const noPrivate = {
  name: "no-private-arena",
  setup(b) {
    b.onResolve({ filter: /(^|\/)private(\/index(\.ts)?)?$/ }, (args) => (/[\\/]packages[\\/]arena[\\/]src[\\/]/.test(args.importer) ? { path: "arena-private-stub", namespace: "forge-stub" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "forge-stub" }, () => ({ contents: PRIVATE_STUB, loader: "js" }));
  },
};

export function bundle(outfile = "dist/cli.mjs", extra = {}) {
  return build({
    entryPoints: [fileURLToPath(new URL("src/cli.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    minify: true,
    legalComments: "none",
    banner: { js: "#!/usr/bin/env node" },
    outfile,
    plugins: [noPrivate],
    ...extra,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundle(fileURLToPath(new URL("dist/cli.mjs", import.meta.url)));
