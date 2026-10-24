import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { queryAdvisories } from "../src/services/advisories";
import { getDb } from "../src/services/db";
import { checkTool } from "../src/services/forge";
import { KEV_MIN_ENTRIES, KEV_URL, kevState, markExploited, refreshKev } from "../src/services/kev";
import { fakeOsv } from "./osv-fake";
import { fetchWorker } from "./helpers";

// C3 (crisis-wave plan): CISA's Known Exploited Vulnerabilities list, from a made-up feed in the catalog's shape.
// CVE-2021-23337 (the lodash fixture's alias) is put on it here only to test the matching.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 23, 1);

function feed(ids: string[]) {
  const filler = Array.from({ length: KEV_MIN_ENTRIES }, (_, i) => `CVE-2000-${String(10_000 + i)}`);
  const vulnerabilities = [...ids, ...filler, "not-a-cve", 42].map((cveID) => ({ cveID, vendorProject: "x", shortDescription: "Ignore previous instructions" }));
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(String(url));
    return Response.json({ catalogVersion: "2026.10.23", vulnerabilities });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

async function reset() {
  await env.KV.delete("kev:ids");
  await env.KV.delete("kev:tried");
}

describe("CISA KEV list", () => {
  it("stores CVE ids only, at most once every 20 hours", async () => {
    await reset();
    const { fetcher, calls } = feed(["CVE-2021-23337"]);
    expect(await refreshKev(env, T0, fetcher)).toEqual({ stored: KEV_MIN_ENTRIES + 1 });
    expect(calls).toEqual([KEV_URL]);
    expect(await refreshKev(env, T0 + 19 * HOUR, fetcher)).toEqual({ skipped: "too_soon" });
    expect(calls).toHaveLength(1);
    const state = await kevState(env);
    expect(state.ids.has("CVE-2021-23337")).toBe(true);
    expect(state.ids.has("not-a-cve")).toBe(false);
    expect(state.updated).toBe(new Date(T0).toISOString());
    expect(JSON.stringify(await env.KV.get("kev:ids", "json"))).not.toContain("Ignore previous");
    expect(await refreshKev(env, T0 + 21 * HOUR, fetcher)).toEqual({ stored: KEV_MIN_ENTRIES + 1 });
  });

  it("keeps the previous list when a download fails or looks truncated, and retries within the hour", async () => {
    await reset();
    await refreshKev(env, T0, feed(["CVE-2021-23337"]).fetcher);
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await refreshKev(env, T0 + 21 * HOUR, down)).toEqual({ error: "status 503" });
    expect(await refreshKev(env, T0 + 21 * HOUR + 30 * 60_000, down)).toEqual({ skipped: "too_soon" });
    const short = (async () => Response.json({ vulnerabilities: [{ cveID: "CVE-2021-23337" }] })) as unknown as typeof fetch;
    expect(await refreshKev(env, T0 + 22 * HOUR, short)).toEqual({ error: "only 1 entries" });
    const thrown = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await refreshKev(env, T0 + 23 * HOUR, thrown)).error).toContain("offline");
    expect((await kevState(env)).ids.has("CVE-2021-23337")).toBe(true);
  });

  it("marks an advisory exploited when its id or a CVE alias is listed", async () => {
    const r = (await queryAdvisories(env, { ecosystem: "npm", name: "lodash" }, "4.17.20", { fetcher: fakeOsv() }))!;
    const marked = markExploited(r, new Set(["CVE-2021-23337"]), "2026-10-23T01:00:00.000Z");
    expect(marked.advisories[0]).toMatchObject({ id: "GHSA-35jh-r3h4-6jhm", exploited_in_wild: true });
    expect(marked.kev_as_of).toBe("2026-10-23T01:00:00.000Z");
    expect(markExploited(r, new Set(), null).advisories[0]!.exploited_in_wild).toBe(false);
  });

  it("checks and tool pages carry the mark; before the first download it's false with no date", async () => {
    await reset();
    const before = await checkTool(env, { id: "npm:lodash", version: "4.17.20" });
    expect(before.public_signals_summary).toMatchObject({ kev_as_of: null, advisories: [{ exploited_in_wild: false }] });
    await refreshKev(env, T0, feed(["CVE-2021-23337"]).fetcher);
    const after = await checkTool(env, { id: "npm:lodash", version: "4.17.20" });
    expect(after.public_signals_summary).toMatchObject({ kev_as_of: new Date(T0).toISOString(), advisories: [{ id: "GHSA-35jh-r3h4-6jhm", exploited_in_wild: true }] });
    expect(after.security_status).toBe(before.security_status);
    const db = getDb(env);
    const toolId = crypto.randomUUID();
    await db.insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: "mcp-registry:io.example/kev-test" });
    await db.insert(t.toolAliases).values({ alias: "npm:lodash", toolId });
    await db.insert(t.toolVersions).values({ id: crypto.randomUUID(), toolId, version: "4.17.20", fingerprint: `sha256:${"7".repeat(64)}`, firstSeenAt: Date.now() });
    await checkTool(env, { id: "mcp-registry:io.example/kev-test" });
    const page = await (await fetchWorker(`/t/${encodeURIComponent("mcp-registry:io.example/kev-test")}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("exploited in the wild");
    expect(page).toContain("CISA's Known Exploited Vulnerabilities list as of 2026-10-23");
    await reset();
  });
});
