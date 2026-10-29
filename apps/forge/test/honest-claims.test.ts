import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SAMPLE_META_CACHE_TTL_S } from "../src/arena/sample";
import { HOUSE_SWEEP_FIRST_DAY, sweepLine } from "../src/web/static-pages";
import { fetchWorker } from "./helpers";
import "../src/index";

// Claim verifier evaluation (docs/strategy/claim-verifier-eval-2026-10-29.md, C04, C13, C17): three claims on buyer
// and public material were untrue. These tests pin the honest wording. The buyer brief's own wording is pinned in
// buyer-brief.test.ts (private: it reads the private brief).

describe("Trap Set versions (C17)", () => {
  it("/benchmark no longer calls every version frozen", async () => {
    const page = await (await fetchWorker("/benchmark?honest", { headers: { Accept: "text/html" } })).text();
    expect(page).not.toContain(">Frozen versions<");
    expect(page).toContain("Released versions");
    expect(page).toContain("reconstructed on");
  });
});

describe("weekly sweep (C04)", () => {
  it("before any sweep day is stored, says when it starts and that it hasn't run", () => {
    const s = String(sweepLine([]));
    expect(s).toContain(`From ${HOUSE_SWEEP_FIRST_DAY}, a second daily job will test`);
    expect(s).toContain("It has not run yet.");
    expect(s).not.toContain("Since ");
  });

  it("once days are stored, says since when and how many days", () => {
    const s = String(sweepLine(["2026-10-31", "2026-10-30"]));
    expect(s).toContain("Since 2026-10-30, a second daily job tests");
    expect(s).toContain("It has run on 2 days so far");
  });

  it("/methodology reads the sweep history", async () => {
    await env.KV.delete("house:sweep:history");
    const before = await (await fetchWorker("/methodology?sweep-a", { headers: { Accept: "text/html" } })).text();
    expect(before).toContain('data-sweep="not-run"');
    expect(before).not.toContain("so each is tested once a week (ADR 0108).</li>");
    await env.KV.put("house:sweep:history", JSON.stringify([{ day: "2026-10-30", total: 10, counts: {} }]));
    const after = await (await fetchWorker("/methodology?sweep-b", { headers: { Accept: "text/html" } })).text();
    expect(after).toContain('data-sweep="running"');
    expect(after).toContain("Since 2026-10-30");
    expect(after).toContain("It has run on 1 day so far");
  });
});

describe("sample status cache", () => {
  it("the sample meta is read-cached for 60 seconds, not 5 minutes", () => {
    expect(SAMPLE_META_CACHE_TTL_S).toBe(60);
  });
});
