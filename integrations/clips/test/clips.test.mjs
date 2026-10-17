import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildIndex, clipIdsFromAssets } from "../clips.mjs";

// The clips workflow's helpers (docs/runbooks/clips.md): which release assets count as clips, and the index.json the
// site reads.

const assets = { assets: [{ name: "aaaa1111-run.mp4" }, { name: "bbbb2222-run.mp4" }, { name: "index.json" }, { name: "../evil.mp4" }, { name: 7 }] };

describe("clip ids from release assets", () => {
  it("keeps only <run id>.mp4 names with a well-formed run id", () => {
    expect(clipIdsFromAssets(assets)).toEqual(["aaaa1111-run", "bbbb2222-run"]);
    expect(clipIdsFromAssets(null)).toEqual([]);
  });
});

describe("index.json", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  it("lists every clip, sorted, with the time it was built", () => {
    expect(buildIndex(assets, {}, null, null, now)).toEqual({ version: 1, updated_at: "2026-10-17T12:00:00.000Z", clips: ["aaaa1111-run", "bbbb2222-run"], removed: [] });
  });

  it("a takedown leaves the clip list and is carried over to later indexes", () => {
    const first = buildIndex(assets, {}, "aaaa1111-run", null, now);
    expect(first.clips).toEqual(["bbbb2222-run"]);
    expect(first.removed).toEqual(["aaaa1111-run"]);
    // Even if the asset were uploaded again by mistake, it stays hidden until it is restored on purpose.
    expect(buildIndex(assets, first, null, null, now).clips).toEqual(["bbbb2222-run"]);
    const restored = buildIndex(assets, first, null, "aaaa1111-run", now);
    expect(restored.clips).toEqual(["aaaa1111-run", "bbbb2222-run"]);
    expect(restored.removed).toEqual([]);
  });

  it("ignores junk in an old index", () => {
    expect(buildIndex(assets, { removed: ["<script>", 3, "bbbb2222-run"] }, null, null, now).removed).toEqual(["bbbb2222-run"]);
  });
});

describe("the workflow", () => {
  const yml = readFileSync(new URL("../../../.github/workflows/clips.yml", import.meta.url), "utf8");

  it("runs the three steps of this script and publishes only from the public mirror", () => {
    for (const cmd of ["clips.mjs\" plan", "clips.mjs\" record", "clips.mjs\" index"]) expect(yml).toContain(cmd);
    expect(yml).toContain("github.repository == 'theagentforge/agent-forge'");
    expect(yml).toContain("npx playwright install --with-deps chromium");
  });

  it("never puts a workflow input straight into a shell command", () => {
    // Inputs reach the scripts as environment variables (or in an `if:`), never pasted into the script text.
    const uses = yml.split("\n").filter((l) => /\$\{\{[^}]*\binputs\./.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/^\s+([A-Z_]+|if):\s/);
  });
});
