import { describe, expect, it } from "vitest";
import { postReport, toReport } from "../file.mjs";
import { candidateFrom, classify, SLOW_MS } from "../probe.mjs";

const entry = (pkg) => ({ server: { name: "io.github.x/y", packages: [{ registryType: "npm", identifier: "Some-MCP", version: "1.2.3", transport: { type: "stdio" }, ...pkg }] } });

describe("choosing servers", () => {
  it("takes npm stdio servers that need no credentials or arguments", () => {
    expect(candidateFrom(entry({}))).toEqual({ registryName: "io.github.x/y", pkg: "some-mcp", version: "1.2.3" });
    expect(candidateFrom(entry({ version: "latest" }))?.version).toBeNull();
  });
  it("skips servers that need a key, an argument, another transport, or were deleted", () => {
    expect(candidateFrom(entry({ environmentVariables: [{ name: "API_KEY", isRequired: true }] }))).toBeNull();
    expect(candidateFrom(entry({ packageArguments: [{ name: "dir", isRequired: true }] }))).toBeNull();
    expect(candidateFrom(entry({ transport: { type: "streamable-http" } }))).toBeNull();
    expect(candidateFrom({ ...entry({}), _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } })).toBeNull();
    expect(candidateFrom(entry({ identifier: "bad name; rm -rf" }))).toBeNull();
    expect(candidateFrom(entry({ environmentVariables: [{ name: "OPTIONAL" }] }))).not.toBeNull();
  });
});

describe("judging a handshake", () => {
  it("reports only clear results", () => {
    expect(classify({ initialized: true, toolsListed: 4, ms: 3000, stderr: "" })).toEqual({ outcome: "worked", issues: [], toolCount: 4 });
    expect(classify({ initialized: true, toolsListed: 2, ms: SLOW_MS + 1, stderr: "" })?.issues).toEqual(["slow"]);
    expect(classify({ initialized: true, ms: 1000, stderr: "" })?.outcome).toBe("partial");
    expect(classify({ initialized: false, ms: 1000, stderr: "npm error code E404\n404 Not Found" })).toEqual({ outcome: "failed", issues: ["install_failed"], toolCount: 0 });
    // Wanted config we didn't give it, or never answered: no report, because we can't tell.
    expect(classify({ initialized: false, ms: 1000, stderr: "Error: OPENAI_API_KEY is required" })).toBeNull();
    expect(classify({ initialized: false, ms: 75000, stderr: "" })).toBeNull();
  });
});

describe("filing", () => {
  const ok = { pkg: "some-mcp", version: "1.2.3", fingerprint: `sha256:${"a".repeat(64)}`, outcome: "worked", issues: [], toolCount: 3, ms: 4200 };
  it("builds a schema-shaped report with a factual note", () => {
    expect(toReport(ok)).toMatchObject({
      tool: { kind: "mcp_server", id: "npm:some-mcp", version: "1.2.3" },
      task: { category: "mcp-handshake", framework: "other" },
      outcome: "worked",
      note: "House handshake test: started with npx, no credentials, and listed 3 tools in 4s.",
    });
  });
  it("drops anything step 1 didn't write in the expected shape (step 1 runs untrusted code)", () => {
    for (const bad of [{ ...ok, outcome: "skip" }, { ...ok, pkg: "../x" }, { ...ok, fingerprint: "sha256:zz" }, { ...ok, version: "1 2" }, null]) {
      expect(toReport(bad)).toBeNull();
    }
    expect(toReport({ ...ok, issues: ["slow", "prompt_injection_suspected"] })?.issues).toEqual(["slow"]);
  });
});

describe("postReport", () => {
  const noWait = async () => {};
  it("retries after 429 until the site accepts", async () => {
    const codes = [429, 429, 200];
    const fetcher = async () => ({ status: codes.shift() });
    const res = await postReport("https://x.test/r", {}, { fetcher, wait: noWait });
    expect(res.status).toBe(200);
    expect(codes).toHaveLength(0);
  });
  it("gives up after the last wait and returns the 429", async () => {
    let calls = 0;
    const fetcher = async () => (calls++, { status: 429 });
    const res = await postReport("https://x.test/r", {}, { fetcher, wait: noWait, waits: [1, 1] });
    expect(res.status).toBe(429);
    expect(calls).toBe(3);
  });
  it("does not retry other errors", async () => {
    let calls = 0;
    const fetcher = async () => (calls++, { status: 409 });
    expect((await postReport("https://x.test/r", {}, { fetcher, wait: noWait })).status).toBe(409);
    expect(calls).toBe(1);
  });
});

describe("the 500 most-downloaded (ADR 0011 b)", () => {
  it("gets weekly downloads in bulk for plain names and one by one for scoped names", async () => {
    const { weeklyDownloads } = await import("../probe.mjs");
    const urls = [];
    const fetcher = async (u) => {
      urls.push(String(u));
      if (String(u).endsWith("/a-mcp,b-mcp")) return Response.json({ "a-mcp": { downloads: 50 }, "b-mcp": null });
      if (String(u).endsWith("/@s/c-mcp")) return Response.json({ downloads: 900, package: "@s/c-mcp" });
      return new Response("", { status: 404 });
    };
    const d = await weeklyDownloads(["a-mcp", "b-mcp", "@s/c-mcp"], fetcher);
    expect(Object.fromEntries(d)).toEqual({ "a-mcp": 50, "b-mcp": 0, "@s/c-mcp": 900 });
    expect(urls.filter((u) => u.includes("a-mcp"))).toHaveLength(1);
  });

  it("ranks busiest first, stably, and splits the plan into fair shards", async () => {
    const { rankTop, shardOf } = await import("../probe.mjs");
    const c = (pkg) => ({ registryName: `x/${pkg}`, pkg, version: null });
    const plan = rankTop([c("z"), c("a"), c("m")], new Map([["z", 5], ["a", 5], ["m", 9]]), 2);
    expect(plan.map((p) => [p.rank, p.pkg, p.weeklyDownloads])).toEqual([[1, "m", 9], [2, "a", 5]]);
    const ten = Array.from({ length: 10 }, (_, i) => i);
    expect(shardOf(ten, 1, 5)).toEqual([1, 6]);
    expect([0, 1, 2, 3, 4].flatMap((s) => shardOf(ten, s, 5)).sort((a, b) => a - b)).toEqual(ten);
  });

  it("says why there's no report: asked for configuration, or never answered", async () => {
    const { skipReason } = await import("../probe.mjs");
    expect(skipReason({ stderr: "Error: GITHUB_TOKEN environment variable is required" })).toBe("needs_config");
    expect(skipReason({ stderr: "" })).toBe("no_answer");
  });

  it("merges shard files and re-validates every row for the House Report", async () => {
    const { mergeResults, toRunEntry } = await import("../file.mjs");
    const files = {
      a: JSON.stringify({ probedAt: "2026-10-15T02:30:00Z", results: [{ pkg: "one", outcome: "worked", version: "1.0.0", toolCount: 2, ms: 3000, weeklyDownloads: 10, rank: 1 }] }),
      b: JSON.stringify({ probedAt: "2026-10-15T02:40:00Z", results: [{ pkg: "two", outcome: "skip", why: "needs_config", rank: 2 }, { pkg: "one", outcome: "failed" }] }),
      c: "not json",
    };
    const m = mergeResults(["a", "b", "c"], (f) => files[f]);
    expect(m.probedAt).toBe("2026-10-15T02:40:00Z");
    expect(m.results.map((r) => r.pkg)).toEqual(["one", "two"]);
    expect(toRunEntry(m.results[0])).toEqual({ pkg: "one", version: "1.0.0", outcome: "worked", slow: false, tools: 2, ms: 3000, downloads: 10, rank: 1 });
    expect(toRunEntry(m.results[1])).toMatchObject({ pkg: "two", outcome: "needs_config", tools: null });
    expect(toRunEntry({ pkg: "x", outcome: "skip", why: "made up" })).toBeNull();
    expect(toRunEntry({ pkg: "bad name;", outcome: "worked" })).toBeNull();
  });

  it("writes notes the site recognises as the House template (so they skip AI moderation)", () => {
    // Same pattern as HOUSE_TESTER_NOTE in apps/forge/src/services/forge.ts.
    const TEMPLATE = /^House handshake test: (started with npx, no credentials, and listed \d{1,4} tools? in \d{1,4}s\.|started and answered initialize, but tools\/list failed\.|npx could not install this version\.)$/;
    const base = { pkg: "p", version: "1.0.0", fingerprint: `sha256:${"a".repeat(64)}`, issues: [], ms: 4200 };
    for (const r of [{ ...base, outcome: "worked", toolCount: 1 }, { ...base, outcome: "worked", toolCount: 12 }, { ...base, outcome: "partial" }, { ...base, outcome: "failed" }]) {
      expect(toReport(r).note).toMatch(TEMPLATE);
    }
  });
});

describe("ranking pool", () => {
  it("scans the whole registry, not just the first 120 pages", async () => {
    const { allCandidates } = await import("../probe.mjs");
    const pages = 300;
    const fetcher = async (url) => {
      const i = Number(new URL(url).searchParams.get("cursor") ?? 0);
      const server = { name: `io.test/s${i}`, packages: [{ registryType: "npm", identifier: `pkg-${i}`, transport: { type: "stdio" } }] };
      return new Response(JSON.stringify({ servers: [{ server }], metadata: i + 1 < pages ? { nextCursor: String(i + 1) } : {} }));
    };
    const all = await allCandidates(fetcher);
    expect(all).toHaveLength(pages);
    expect(all.at(-1).pkg).toBe(`pkg-${pages - 1}`);
  });
});
