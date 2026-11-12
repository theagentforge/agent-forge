import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb, newId } from "../src/services/db";
import { backfillPlan, backfillProgress, enqueueVersions, MAX_VERSIONS, recordBackfillResults, TIERS } from "../src/services/tool-history";

// ADR 0134 amendment 3 (9 Nov): the 150-versions-a-server cap is lifted. Older stable versions are queued (tier 1)
// after every first-pass version (tier 0), retries included, so they can't starve servers still waiting. Prereleases
// stay excluded. Migration 0054 re-queues the rows that were excluded as over_cap. Fixtures only.

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 86_400_000;

async function inSet(pkg: string, rank: number) {
  const id = newId();
  const server = `npm:${pkg}`;
  await getDb(env).insert(t.tools).values({ id, kind: "mcp_server", canonicalId: server, createdAt: NOW - 30 * DAY });
  await getDb(env).insert(t.toolHistoryServers).values({ server, registry: "npm", package: pkg, toolId: id, source: "top500_nightly", rank, addedAt: NOW });
  return server;
}
const q = (server: string, version: string, at: number, over: Partial<typeof t.toolHistoryQueue.$inferInsert> = {}) => ({ server, version, publishedAt: at, status: "pending", enqueuedAt: NOW, ...over });

describe("lifting the per-server cap", () => {
  it("a server with more than MAX_VERSIONS stable versions queues them all; the older ones wait for the first pass", async () => {
    const big = await inSet("cap-big-mcp", 401);
    const small = await inSet("cap-small-mcp", 402);
    const versions = Array.from({ length: MAX_VERSIONS + 5 }, (_, i) => ({ version: `1.0.${i}`, published_at: new Date(Date.UTC(2025, 9, 1) + i * 3_600_000).toISOString() }));
    versions.push({ version: "1.1.0-rc.1", published_at: "2025-12-01T00:00:00Z" });
    const r = await enqueueVersions(env, { servers: [{ server: big, status: "ok", versions }, { server: small, status: "ok", versions: [{ version: "2.0.0", published_at: "2025-10-01T00:00:00Z" }] }] }, NOW);
    expect(r).toMatchObject({ ok: true, queued: MAX_VERSIONS + 5 + 1, excluded: 1 });
    const rows = await getDb(env).select().from(t.toolHistoryQueue).where(sql`${t.toolHistoryQueue.server} = ${big}`);
    expect(rows.filter((x) => x.status === "pending" && x.tier === TIERS.first)).toHaveLength(MAX_VERSIONS);
    // The 5 oldest stable versions: tier 1.
    expect(rows.filter((x) => x.tier === TIERS.older).map((x) => x.version).sort()).toEqual(["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4"]);
    expect(rows.find((x) => x.version === "1.1.0-rc.1")).toMatchObject({ status: "excluded", reason: "prerelease" });

    // The plan: every tier-0 version (the lower-ranked server's too) before any tier-1 version.
    const plan = await backfillPlan(env);
    const mine = plan.versions.filter((v) => v.server === big || v.server === small);
    const firstOlder = mine.findIndex((v) => ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4"].includes(v.version) && v.server === big);
    expect(mine.findIndex((v) => v.server === small)).toBeLessThan(firstOlder);
    expect(mine.slice(firstOlder).every((v) => v.server === big && Number(v.version.split(".")[2]) < 5)).toBe(true);
    expect((await backfillProgress(env)).versions.pending_older).toBe(5);
  });

  it("a first-pass version waiting for a retry still goes before any tier-1 version", async () => {
    const top = await inSet("cap-top-mcp", 403);
    const low = await inSet("cap-low-mcp", 404);
    const db = getDb(env);
    await db.insert(t.toolHistoryQueue).values([q(top, "0.1.0", NOW - 400 * DAY, { tier: TIERS.older }), q(low, "3.0.0", NOW - 10 * DAY, { attempts: 2 })]);
    const plan = (await backfillPlan(env)).versions.filter((v) => v.server === top || v.server === low);
    expect(plan.map((v) => `${v.server}@${v.version}`)).toEqual([`${low}@3.0.0`, `${top}@0.1.0`]);
    // A tier-1 version is answered like any other.
    const done = await recordBackfillResults(env, { probed_at: new Date(NOW).toISOString(), results: [{ server: top, version: "0.1.0", outcome: "no_answer", tools_count: null, tools: null }] }, NOW);
    expect(done).toMatchObject({ ok: true, failed: 1 });
  });

  it("migration 0054 re-queues over_cap rows at tier 1 and leaves every other row alone", async () => {
    const s = await inSet("cap-mig-mcp", 405);
    const db = getDb(env);
    await db.insert(t.toolHistoryQueue).values([
      q(s, "1.0.0", NOW - 300 * DAY, { status: "excluded", reason: "over_cap", attempts: 0 }),
      q(s, "1.0.1-beta", NOW - 290 * DAY, { status: "excluded", reason: "prerelease" }),
      q(s, "1.1.0", NOW - 200 * DAY, { status: "done", observedAt: NOW }),
      q(s, "1.2.0", NOW - 100 * DAY, { status: "failed", reason: "no_handshake", outcome: "no_answer" }),
      q(s, "1.3.0", NOW - 50 * DAY, { attempts: 1 }),
    ]);
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0054_"))!;
    expect(m.queries.join("\n")).not.toMatch(/\b(DROP|DELETE|INSERT)\b/i);
    for (const query of m.queries) await env.DB.prepare(query).run();
    const rows = Object.fromEntries((await db.select().from(t.toolHistoryQueue).where(sql`${t.toolHistoryQueue.server} = ${s}`)).map((r) => [r.version, [r.status, r.reason, r.tier, r.attempts]]));
    expect(rows).toEqual({
      "1.0.0": ["pending", null, 1, 0],
      "1.0.1-beta": ["excluded", "prerelease", 0, 0],
      "1.1.0": ["done", null, 0, 0],
      "1.2.0": ["failed", "no_handshake", 0, 0],
      "1.3.0": ["pending", null, 0, 1],
    });
  });
});

describe("the census coverage line", () => {
  it("says older stable versions are tested after the first pass, true before and after migration 0054", async () => {
    const { censusSchema } = await import("../src/services/census");
    const schema = censusSchema("2026-11-10", {}) as unknown as { files: Record<string, { coverage?: string }> };
    const line = schema.files["tool-history/<YYYY-MM>.csv"]!.coverage!;
    expect(line).toContain(`the newest ${MAX_VERSIONS} stable versions of each server first, then its older stable versions`);
    expect(line).toContain("9 Nov 2026");
    expect(line).toContain("prerelease (");
    expect(line).not.toContain("at most the newest");
    expect(line).not.toMatch(/Not tested:[^]*over_cap/);
  });
});
