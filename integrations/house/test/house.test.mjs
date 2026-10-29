import { describe, expect, it } from "vitest";
import { houseHeaders, INTERNAL_UA, postReport, toReport } from "../file.mjs";
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

  it("puts the well-known servers people check first at the top of the plan, without duplicates", async () => {
    const { withPriority, PRIORITY } = await import("../probe.mjs");
    const plan = [{ registryName: "x", pkg: "@upstash/context7-mcp", version: null, rank: 1 }, { registryName: "y", pkg: "other-mcp", version: null, rank: 2 }];
    const out = withPriority(plan, 50);
    expect(out[0]).toMatchObject({ pkg: "@modelcontextprotocol/server-filesystem", args: ["."], priority: 1 });
    expect(out.filter((c) => c.pkg === "@upstash/context7-mcp")).toHaveLength(1);
    expect(out.at(-1).pkg).toBe("other-mcp");
    expect(out).toHaveLength(PRIORITY.length + 1);
    expect(withPriority(plan, 3)).toHaveLength(3);
  });
});

describe("calls to our site (K7)", () => {
  it("are tagged as our own House probe, by header and User-Agent, next to the OIDC token", () => {
    const h = houseHeaders("tok");
    expect(h).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json", "User-Agent": INTERNAL_UA, "X-Forge-Internal": "house" });
    expect(h["User-Agent"]).toMatch(/^theagentforge-internal\/house\b/);
  });
});

describe("weekly sweep of every no-setup server, npm and PyPI (ADR 0108)", () => {
  const py = (p = {}) => ({ server: { name: "io.github.x/py", packages: [{ registryType: "pypi", identifier: "Weather_MCP.Server", version: "0.4.1", transport: { type: "stdio" }, ...p }] } });

  it("takes PyPI stdio servers that need nothing, with PEP 503 names", async () => {
    const { pypiCandidateFrom } = await import("../probe.mjs");
    expect(pypiCandidateFrom(py())).toEqual({ registry: "pypi", registryName: "io.github.x/py", pkg: "weather-mcp-server", version: "0.4.1" });
    expect(pypiCandidateFrom(py({ environmentVariables: [{ name: "KEY", isRequired: true }] }))).toBeNull();
    expect(pypiCandidateFrom(py({ transport: { type: "sse" } }))).toBeNull();
    expect(pypiCandidateFrom(py({ identifier: "x; rm -rf /" }))).toBeNull();
    expect(pypiCandidateFrom(py({ version: "latest" }))?.version).toBeNull();
    // npm entries aren't PyPI candidates, and the npm path is unchanged.
    expect(pypiCandidateFrom(entry({}))).toBeNull();
    expect(candidateFrom(py())).toBeNull();
  });

  it("lists PyPI candidates only when asked, each package once", async () => {
    const { allCandidates } = await import("../probe.mjs");
    const page = { servers: [entry({}), py(), py()], metadata: {} };
    const fetcher = async () => ({ ok: true, json: async () => page });
    expect((await allCandidates(fetcher, 1)).map((c) => c.pkg)).toEqual(["some-mcp"]);
    expect((await allCandidates(fetcher, 1, { pypi: true })).map((c) => `${c.registry ?? "npm"}:${c.pkg}`)).toEqual(["npm:some-mcp", "pypi:weather-mcp-server"]);
  });

  it("splits the pool into 7 stable days that cover every server exactly once", async () => {
    const { sweepSlice, sweepDay, sweepDayFor, SWEEP_DAYS } = await import("../probe.mjs");
    const pool = Array.from({ length: 700 }, (_, i) => (i % 3 ? { pkg: `npm-${i}` } : { registry: "pypi", pkg: `py-${i}` }));
    const days = Array.from({ length: SWEEP_DAYS }, (_, d) => sweepSlice(pool, d));
    expect(days.reduce((a, d) => a + d.length, 0)).toBe(700);
    expect(new Set(days.flat().map((c) => `${c.registry ?? "npm"}:${c.pkg}`)).size).toBe(700);
    for (const d of days) expect(d.length).toBeGreaterThan(60); // roughly even
    // Stable: the same server lands on the same day whatever else is in the pool.
    expect(sweepSlice([pool[5]], sweepDay(pool[5]))).toEqual([pool[5]]);
    expect(sweepDayFor(Date.UTC(2026, 9, 29))).toBe(Math.floor(Date.UTC(2026, 9, 29) / 86_400_000) % 7);
  });

  it("starts PyPI servers with uvx and npm servers with npx, with safe arguments only", async () => {
    const { launcher } = await import("../probe.mjs");
    expect(launcher("pypi", "weather-mcp", "0.4.1")).toEqual(["uvx", ["weather-mcp@0.4.1"]]);
    expect(launcher("npm", "some-mcp", "1.0.0", [".", "; rm -rf /"])).toEqual(["npx", ["-y", "some-mcp@1.0.0", "."]]);
  });

  it("pins a PyPI version and fingerprints its files from the project index", async () => {
    const { pypiVersion, versionFromFilename } = await import("../probe.mjs");
    expect(versionFromFilename("weather_mcp-0.4.1-py3-none-any.whl", "weather-mcp")).toBe("0.4.1");
    expect(versionFromFilename("weather-mcp-0.4.1.tar.gz", "weather-mcp")).toBe("0.4.1");
    expect(versionFromFilename("other-1.0.tar.gz", "weather-mcp")).toBeNull();
    const h = (c) => ({ sha256: c.repeat(64) });
    const files = [
      { filename: "weather_mcp-0.4.0-py3-none-any.whl", hashes: h("1"), "upload-time": "2026-09-01T00:00:00Z" },
      { filename: "weather_mcp-0.4.1-py3-none-any.whl", hashes: h("2"), "upload-time": "2026-10-01T00:00:00Z" },
      { filename: "weather_mcp-0.4.1.tar.gz", hashes: h("3"), "upload-time": "2026-10-01T00:00:00Z" },
      { filename: "weather_mcp-0.5.0.tar.gz", hashes: h("4"), "upload-time": "2026-10-20T00:00:00Z", yanked: true },
    ];
    let asked;
    const fetcher = async (u, init) => ((asked = { u, init }), { ok: true, status: 200, json: async () => ({ files }) });
    const pinned = await pypiVersion("Weather_MCP", "0.4.1", fetcher);
    expect(asked.u).toBe("https://pypi.org/simple/weather-mcp/");
    expect(asked.init.headers.Accept).toBe("application/vnd.pypi.simple.v1+json");
    expect(pinned.version).toBe("0.4.1");
    expect(pinned.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await pypiVersion("weather-mcp", null, fetcher)).version).toBe("0.4.1"); // newest upload that isn't yanked
    expect(await pypiVersion("weather-mcp", "9.9.9", fetcher)).toEqual({ missing: true });
    expect(await pypiVersion("nope", null, async () => ({ ok: false, status: 404 }))).toEqual({ missing: true });
  });

  it("keeps tools/list descriptions and schemas, capped", async () => {
    const { keepTools, TOOL_CAPS } = await import("../probe.mjs");
    const big = { type: "object", properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, { type: "string" }])) };
    const kept = keepTools([{ name: "read", description: "x".repeat(5000), inputSchema: { type: "object" } }, { name: "huge", description: "ok", inputSchema: big }, { description: "no name" }, { name: 7 }]);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toEqual({ name: "read", description: "x".repeat(TOOL_CAPS.description), schema: '{"type":"object"}' });
    expect(kept[1].schema).toBeNull(); // over the schema cap: dropped, not cut into invalid JSON
    expect(keepTools(Array.from({ length: 300 }, (_, i) => ({ name: `t${i}`, description: "d" })))).toHaveLength(TOOL_CAPS.tools);
    expect(keepTools(Array.from({ length: 100 }, (_, i) => ({ name: `t${i}`, description: "d".repeat(2000) }))).length).toBeLessThan(40); // total cap
  });

  it("probes one server end to end with the right launcher and keeps its tools only when it worked", async () => {
    const { probeOne } = await import("../probe.mjs");
    const shake = async (pkg, version, _t, _a, registry) => ({ initialized: true, toolsListed: 1, ms: 900, stderr: "", tools: [{ name: `${registry}-tool`, description: "d", schema: null }] });
    const npm = async () => ({ version: "1.0.0", fingerprint: `sha256:${"a".repeat(64)}` });
    const pypi = async () => ({ version: "0.4.1", fingerprint: `sha256:${"b".repeat(64)}` });
    const r = await probeOne({ registry: "pypi", pkg: "weather-mcp", version: null }, { npm, pypi, shake });
    expect(r).toMatchObject({ registry: "pypi", version: "0.4.1", outcome: "worked", tools: [{ name: "pypi-tool" }] });
    expect(await probeOne({ registry: "pypi", pkg: "gone", version: "1" }, { npm, pypi: async () => ({ missing: true }), shake })).toMatchObject({ outcome: "skip", why: "not_on_pypi" });
    const cfg = await probeOne({ pkg: "k-mcp", version: null }, { npm, pypi, shake: async () => ({ initialized: false, ms: 50, stderr: "Error: API_KEY is required", tools: [] }) });
    expect(cfg).toMatchObject({ outcome: "skip", why: "needs_config" });
    expect(cfg.tools).toBeUndefined();
  });

  it("says when uvx found no command named after the package", async () => {
    const { skipReason } = await import("../probe.mjs");
    expect(skipReason({ stderr: "An executable named `weather-mcp` is not provided by package `weather-mcp`." })).toBe("no_command");
    expect(classify({ initialized: false, ms: 900, stderr: "  × No solution found when resolving tool dependencies:" })).toMatchObject({ outcome: "failed" });
  });

  it("files PyPI reports as pypi: ids with the uvx note the site recognises", async () => {
    const { toRunEntry } = await import("../file.mjs");
    const TEMPLATE = /^House handshake test: (started with (npx|uvx), no credentials, and listed \d{1,4} tools? in \d{1,4}s\.|started and answered initialize, but tools\/list failed\.|(npx|uvx) could not install this version\.)$/;
    const base = { registry: "pypi", pkg: "weather-mcp", version: "0.4.1", fingerprint: `sha256:${"a".repeat(64)}`, issues: [], ms: 4200 };
    const rep = toReport({ ...base, outcome: "worked", toolCount: 2 });
    expect(rep.tool.id).toBe("pypi:weather-mcp");
    expect(rep.note).toBe("House handshake test: started with uvx, no credentials, and listed 2 tools in 4s.");
    expect(toReport({ ...base, outcome: "failed" }).note).toBe("House handshake test: uvx could not install this version.");
    for (const o of ["worked", "partial", "failed"]) expect(toReport({ ...base, outcome: o, toolCount: 1 }).note).toMatch(TEMPLATE);
    expect(toReport({ ...base, registry: "cargo", outcome: "worked" })).toBeNull();
    expect(toRunEntry({ ...base, outcome: "skip", why: "no_command" })).toMatchObject({ registry: "pypi", outcome: "no_command" });
    // npm rows keep exactly their old shape, so an older site still accepts them.
    expect(Object.keys(toRunEntry({ pkg: "one", outcome: "worked", version: "1.0.0" }))).not.toContain("registry");
  });

  it("re-validates and caps the descriptions step 1 sent (it ran untrusted code)", async () => {
    const { toDescriptions, batches, mergeResults } = await import("../file.mjs");
    const ok = { registry: "pypi", pkg: "weather-mcp", version: "0.4.1", outcome: "worked", tools: [{ name: "get", description: "Gets weather.", schema: '{"type":"object"}' }] };
    expect(toDescriptions(ok)).toEqual({ id: "pypi:weather-mcp", version: "0.4.1", tools: [{ name: "get", description: "Gets weather.", schema: '{"type":"object"}' }] });
    expect(toDescriptions({ ...ok, outcome: "partial" })).toBeNull();
    expect(toDescriptions({ ...ok, pkg: "../x" })).toBeNull();
    expect(toDescriptions({ ...ok, tools: [{ name: { evil: 1 } }] })).toBeNull();
    const cut = toDescriptions({ ...ok, tools: [{ name: "n".repeat(500), description: "d".repeat(9000), schema: "s".repeat(9000), extra: "dropped" }] });
    expect(cut.tools[0]).toEqual({ name: "n".repeat(128), description: "d".repeat(2000), schema: null });
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    // The same name on npm and PyPI is two servers.
    const files = { a: JSON.stringify({ results: [{ pkg: "same", outcome: "worked" }, { registry: "pypi", pkg: "same", outcome: "worked" }] }) };
    expect(mergeResults(["a"], (f) => files[f]).results).toHaveLength(2);
  });
});
