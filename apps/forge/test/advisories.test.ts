import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { mergeAliases, osvPackageFor, pypiName, queryAdvisories, queryAdvisoriesBatch, recordAdvisories } from "../src/services/advisories";
import { getDb } from "../src/services/db";
import { fakeOsv } from "./osv-fake";

// C1 (crisis-wave plan): OSV advisories, from recorded responses. No test reaches the network.

describe("advisories (OSV)", () => {
  it("lists each advisory once when OSV gives it under several ids, keeping MAL, then GHSA, ids", () => {
    const a = (id: string, kind: "malicious" | "vulnerability", aliases: string[], fixed: string[] = [], modified = "2026-10-01T00:00:00Z") =>
      ({ id, kind, aliases, affects_version: null, fixed, published: null, modified, url: `https://osv.dev/vulnerability/${id}` });
    const merged = mergeAliases([
      a("PYSEC-2026-2", "malicious", ["MAL-2026-2144"]),
      a("MAL-2026-2144", "malicious", ["PYSEC-2026-2"]),
      a("PYSEC-2026-4070", "vulnerability", ["CVE-2026-59823", "GHSA-hx8v-g79f-8w5f"], ["1.83.9"], "2026-10-02T00:00:00Z"),
      a("GHSA-hx8v-g79f-8w5f", "vulnerability", ["CVE-2026-59823", "PYSEC-2026-4070"], ["1.83.9"]),
      a("GHSA-other", "vulnerability", ["CVE-2026-1"], ["2.0"]),
    ]);
    expect(merged.map((x) => x.id)).toEqual(["MAL-2026-2144", "GHSA-hx8v-g79f-8w5f", "GHSA-other"]);
    expect(merged[0]!.aliases).toEqual(["PYSEC-2026-2"]);
    expect(merged[1]).toMatchObject({ aliases: ["CVE-2026-59823", "PYSEC-2026-4070"], fixed: ["1.83.9"], modified: "2026-10-02T00:00:00Z" });
  });

  it("maps Forge ids to OSV packages, with PEP 503 names for PyPI", () => {
    expect(osvPackageFor("pypi:LiteLLM")).toEqual({ ecosystem: "PyPI", name: "litellm" });
    expect(osvPackageFor("pypi:Some_Pkg.Name")).toEqual({ ecosystem: "PyPI", name: "some-pkg-name" });
    expect(osvPackageFor("npm:@scope/Name")).toEqual({ ecosystem: "npm", name: "@scope/name" });
    expect(osvPackageFor("github.com/a/b")).toBeNull();
    expect(osvPackageFor("pypi:bad name")).toBeNull();
    expect(pypiName("A__b..c")).toBe("a-b-c");
  });

  it("flags a malicious-package record for the exact version, with identifiers only", async () => {
    const r = await queryAdvisories(env, { ecosystem: "PyPI", name: "litellm" }, "1.107.0", { fetcher: fakeOsv(), now: Date.UTC(2026, 9, 23, 12) });
    expect(r).toMatchObject({ source: "osv", ecosystem: "PyPI", package: "litellm", version: "1.107.0", total: 1, checked_at: "2026-10-23T12:00:00.000Z" });
    expect(r!.advisories[0]).toEqual({
      id: "MAL-0000-0001",
      kind: "malicious",
      aliases: [],
      affects_version: true,
      fixed: [],
      published: "2026-10-21T17:40:03Z",
      modified: "2026-10-21T18:02:11Z",
      url: "https://osv.dev/vulnerability/MAL-0000-0001",
    });
    // OSV's free text never reaches a result (it would be a prompt-injection channel).
    expect(JSON.stringify(r)).not.toMatch(/Ignore previous|curl|Malicious code in/);
  });

  it("gives a vulnerability's id, aliases and fixed version, and nothing for no match", async () => {
    const r = await queryAdvisories(env, { ecosystem: "npm", name: "lodash" }, "4.17.20", { fetcher: fakeOsv() });
    expect(r!.advisories[0]).toMatchObject({ id: "GHSA-35jh-r3h4-6jhm", kind: "vulnerability", aliases: ["CVE-2021-23337"], fixed: ["4.17.21"], affects_version: true });
    expect(JSON.stringify(r)).not.toMatch(/You should|install now/);
    const clean = await queryAdvisories(env, { ecosystem: "npm", name: "lodash" }, "4.17.21", { fetcher: fakeOsv() });
    expect(clean).toMatchObject({ total: 0, advisories: [] });
  });

  it("caches answers for 6 hours, and reports 'not checked' (null) when OSV is down", async () => {
    const calls: string[] = [];
    await queryAdvisories(env, { ecosystem: "npm", name: "lodash" }, "4.17.19", { fetcher: fakeOsv(calls) });
    await queryAdvisories(env, { ecosystem: "npm", name: "lodash" }, "4.17.19", { fetcher: fakeOsv(calls) });
    expect(calls).toHaveLength(1);
    const down = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    expect(await queryAdvisories(env, { ecosystem: "npm", name: "left-pad" }, "1.0.0", { fetcher: down })).toBeNull();
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await queryAdvisories(env, { ecosystem: "npm", name: "left-pad" }, "1.0.1", { fetcher: broken })).toBeNull();
  });

  it("drops malformed records and ones about another package", async () => {
    const odd = (async () =>
      Response.json({
        vulns: [
          { id: "not an id", affected: [{ package: { ecosystem: "npm", name: "x" } }] },
          { id: "GHSA-aaaa-bbbb-cccc", affected: [{ package: { ecosystem: "npm", name: "other" } }] },
          { id: "GHSA-dddd-eeee-ffff", aliases: ["bad alias!"], affected: [{ package: { ecosystem: "npm", name: "x" }, ranges: [{ events: [{ fixed: "1.0.1; rm -rf" }, { fixed: "1.0.2" }] }] }] },
        ],
      })) as unknown as typeof fetch;
    const r = await queryAdvisories(env, { ecosystem: "npm", name: "x" }, "1.0.0", { fetcher: odd });
    expect(r!.advisories.map((a) => [a.id, a.aliases, a.fixed])).toEqual([["GHSA-dddd-eeee-ffff", [], ["1.0.2"]]]);
  });

  it("batches exact versions and reads each hit's record", async () => {
    const r = await queryAdvisoriesBatch(
      env,
      [
        { pkg: { ecosystem: "PyPI", name: "litellm" }, version: "1.107.0" },
        { pkg: { ecosystem: "npm", name: "lodash" }, version: "4.17.20" },
        { pkg: { ecosystem: "npm", name: "left-pad" }, version: "1.3.0" },
      ],
      { fetcher: fakeOsv() },
    );
    expect(r.map((x) => x?.advisories.map((a) => a.id))).toEqual([["MAL-0000-0001"], ["GHSA-35jh-r3h4-6jhm"], []]);
    const down = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await queryAdvisoriesBatch(env, [{ pkg: { ecosystem: "npm", name: "a" }, version: "1.0.0" }], { fetcher: down })).toEqual([null]);
  });

  it("keeps the latest answer for a known tool in public_signals, source osv", async () => {
    const db = getDb(env);
    const toolId = crypto.randomUUID();
    await db.insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: "pypi:advisory-test" });
    const r = (await queryAdvisories(env, { ecosystem: "PyPI", name: "litellm" }, "1.107.0", { fetcher: fakeOsv() }))!;
    await recordAdvisories(db, toolId, r);
    await recordAdvisories(db, toolId, r);
    const rows = await db.query.publicSignals.findMany({ where: eq(t.publicSignals.toolId, toolId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "osv", payload: { package: "litellm", total: 1 } });
  });
});
