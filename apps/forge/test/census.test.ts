import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { canonicalToolId } from "../src/services/tools";
import { seedFromRegistry, toSeedTool, type RegistryEntry } from "../src/seed/mcp-registry";
import { censusBySource, MCP_NAME, mcpNamesIn, parseSitemapIndex, pypiSeedTool, seedPypiMcp, SITEMAP_INDEX } from "../src/seed/pypi-mcp";
import { BLENDED_RULES } from "../src/services/public-stats";
import { githubRepoId, seedSmithery, toSmitherySeed } from "../src/seed/smithery";
import { fetchWorker } from "./helpers";
import "../src/index";

// B3-14 (ADR 0108): PyPI MCP packages and Smithery's registry in the tools-tracked census, one page per tool.

const reg = (name: string, extra: Partial<RegistryEntry["server"]> = {}): RegistryEntry => ({
  server: { name, description: `${name} does things`, version: "1.0.0", ...extra },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
});

const index = (buckets: [string, string][]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${buckets.map(([u, m]) => `  <sitemap>\n    <loc>${u}</loc>    <lastmod>${m}</lastmod>  </sitemap>`).join("\n")}\n</sitemapindex>`;
const bucket = (names: string[]) => `<?xml version="1.0"?>\n<urlset>\n${names.map((n) => `  <url>\n    <loc>https://pypi.org/project/${n}/</loc>\n  </url>`).join("\n")}\n</urlset>`;

describe("PyPI MCP packages (sitemap only; robots.txt disallows /simple/ and /pypi/*/json)", () => {
  it("matches 'mcp' as a word in the name and reads only pypi.org buckets", () => {
    expect(["mcp-server-fetch", "weather_mcp", "Foo.MCP.bar", "mcp"].every((n) => MCP_NAME.test(n))).toBe(true);
    expect(["fastmcp", "mcpx", "compact"].some((n) => MCP_NAME.test(n))).toBe(false);
    expect(parseSitemapIndex(index([["https://pypi.org/0a.sitemap.xml", "2026-10-14"], ["https://evil.example/0b.sitemap.xml", "x"]]))).toEqual([["https://pypi.org/0a.sitemap.xml", "2026-10-14"]]);
    expect(mcpNamesIn(bucket(["Weather_MCP", "weather-mcp", "numpy", "fastmcp", "mcp-server-time"]))).toEqual(["pypi:weather-mcp", "pypi:mcp-server-time"]);
  });

  it("says it is a name match, not reviewed and not necessarily a server: in the counting rule, the labels and each tool's signal (review ADR 0115)", async () => {
    const rule = BLENDED_RULES.find((r) => r.key === "tools_tracked")!;
    expect(rule.counts).toContain("a name match");
    expect(rule.counts).toContain("MCP clients, SDKs and adapters as well as servers");
    expect(rule.counts).toContain("not reviewed");
    expect(rule.counts).not.toMatch(/public MCP registries/);
    const signal = pypiSeedTool("pypi:weather-mcp").signal as { description: string };
    expect(signal.description).toContain("may be an MCP server, client, SDK or adapter");
    expect(signal.description).toContain("Listed, not reviewed.");
    const rules = await (await fetchWorker("/stats/rules", { headers: { Accept: "text/html" } })).text();
    expect(rules).toContain("a name match");
    const stats = await (await fetchWorker("/stats", { headers: { Accept: "text/html" } })).text();
    expect(stats).not.toContain("public MCP registries");
  });

  it("adds new names once, merges names an MCP Registry server ships, and re-reads only changed buckets", async () => {
    // A registry server whose canonical id is its GitHub repo and which ships a PyPI package.
    await seedFromRegistry(env, Date.now(), (async () =>
      Response.json({ servers: [reg("io.github.acme/time", { repository: { url: "https://github.com/acme/time-mcp" }, packages: [{ registryType: "pypi", identifier: "Acme_Time_MCP" }] })], metadata: {} })) as typeof fetch);
    const db = getDb(env);
    // Existing registry rows (seeded before ADR 0108) have no PyPI alias; the census finds them from the stored signal.
    await db.delete(t.toolAliases).where(eq(t.toolAliases.alias, "pypi:acme-time-mcp"));

    const files: Record<string, string> = {
      [SITEMAP_INDEX]: index([["https://pypi.org/00.sitemap.xml", "2026-10-14"], ["https://pypi.org/01.sitemap.xml", "2026-10-15"]]),
      "https://pypi.org/00.sitemap.xml": bucket(["acme-time-mcp", "numpy", "new-mcp-one"]),
      "https://pypi.org/01.sitemap.xml": bucket(["new_mcp_one", "mcp-two"]),
    };
    const asked: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      asked.push(u);
      expect(new Headers(init?.headers).get("User-Agent")).toContain("theagentforge-census");
      return files[u] ? new Response(files[u]) : new Response("nope", { status: 404 });
    }) as typeof fetch;

    const now = Date.now();
    expect(await seedPypiMcp(env, now, fetcher, 1)).toEqual({ buckets: 1, added: 1, aliased: 1, left: 1 });
    expect(await seedPypiMcp(env, now + 1, fetcher, 4)).toEqual({ buckets: 1, added: 1, aliased: 0, left: 0 }); // new_mcp_one is already tracked
    expect(asked.every((u) => !u.includes("/simple/") && !u.includes("/json"))).toBe(true);

    // One page per tool: the registry server answers for its PyPI name.
    const check = (await (await fetchWorker("/api/v1/check?id=pypi%3AAcme_Time_MCP")).json()) as { known: boolean; tool: { id: string } };
    expect(check).toMatchObject({ known: true, tool: { id: "github.com/acme/time-mcp" } });
    const fresh = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, "pypi:new-mcp-one") });
    expect(fresh?.kind).toBe("mcp_server");
    const page = await (await fetchWorker("/t/pypi%3Amcp-two")).text();
    expect(page).toContain("pypi-mcp");
    expect(page).toContain("Listed, not reviewed.");
    expect(await censusBySource(db)).toMatchObject({ "mcp-registry": 1, "pypi-mcp": 2 });

    // Within the week, nothing is fetched or written.
    asked.length = 0;
    expect(await seedPypiMcp(env, now + 2, fetcher)).toEqual({ skipped: "up_to_date" });
    expect(asked).toEqual([]);
    // A week later only the bucket whose <lastmod> changed is read again.
    files[SITEMAP_INDEX] = index([["https://pypi.org/00.sitemap.xml", "2026-10-14"], ["https://pypi.org/01.sitemap.xml", "2026-10-22"]]);
    expect(await seedPypiMcp(env, now + 8 * 86_400_000, fetcher)).toEqual({ buckets: 1, added: 0, aliased: 0, left: 0 });
    expect(asked).toEqual([SITEMAP_INDEX, "https://pypi.org/01.sitemap.xml"]);
  });

  it("new MCP Registry rows carry their PyPI package as an alias, never as the canonical id", () => {
    const s = toSeedTool(reg("io.github.b/c", { repository: { url: "https://github.com/b/c" }, packages: [{ registryType: "pypi", identifier: "B_C.MCP" }] }))!;
    expect(s.canonicalId).toBe("github.com/b/c");
    expect(s.aliases).toContain("pypi:b-c-mcp");
  });
});

describe("Smithery registry (API key required: off until the secret is set)", () => {
  const server = (qualifiedName: string, homepage: string | null = null) => ({ qualifiedName, displayName: qualifiedName, description: "d", homepage, remote: true, verified: false, useCount: 3, createdAt: "2026-09-01T00:00:00Z" });

  it("does nothing, and calls nothing, without SMITHERY_API_KEY", async () => {
    let called = false;
    const r = await seedSmithery({ ...env, SMITHERY_API_KEY: undefined } as Env, Date.now(), (async () => ((called = true), Response.json({}))) as typeof fetch);
    expect(r).toEqual({ skipped: "no_key" });
    expect(called).toBe(false);
  });

  it("maps servers to GitHub ids when the homepage is a repo, else smithery:<name>", () => {
    expect(githubRepoId("https://github.com/Acme/Thing.git")).toBe("github.com/acme/thing");
    expect(githubRepoId("https://github.com/acme/thing/tree/main/x")).toBe("github.com/acme/thing");
    expect(githubRepoId("https://acme.dev")).toBeNull();
    expect(toSmitherySeed(server("@Acme/Thing", "https://github.com/acme/thing"))).toMatchObject({ canonicalId: "github.com/acme/thing", aliases: ["smithery:@acme/thing"] });
    expect(toSmitherySeed(server("acme/remote"))).toMatchObject({ canonicalId: "smithery:acme/remote", aliases: [] });
    expect(toSmitherySeed(server("bad name; rm"))).toBeNull();
    expect(canonicalToolId("smithery:@Acme/Thing")).toBe("smithery:@acme/thing");
  });

  it("pages with the key, merges into tools we track, skips what it already linked, and stops on an error", async () => {
    await seedFromRegistry(env, Date.now(), (async () =>
      Response.json({ servers: [reg("io.github.acme/both", { repository: { url: "https://github.com/acme/both" }, packages: [{ registryType: "npm", identifier: "acme-both" }] })], metadata: {} })) as typeof fetch);
    const pages: Record<string, unknown> = {
      "1": { servers: [server("@acme/both", "https://github.com/acme/both"), server("solo/remote")], pagination: { currentPage: 1, pageSize: 100, totalPages: 2, totalCount: 3 } },
      "2": { servers: [server("@x/new", "https://github.com/x/new")], pagination: { currentPage: 2, pageSize: 100, totalPages: 2, totalCount: 3 } },
    };
    const auth: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      auth.push(new Headers(init?.headers).get("Authorization") ?? "");
      expect(u.origin + u.pathname).toBe("https://api.smithery.ai/servers");
      return Response.json(pages[u.searchParams.get("page")!]);
    }) as typeof fetch;
    const e = { ...env, SMITHERY_API_KEY: "test-key-not-real" } as Env;
    const now = Date.now();
    expect(await seedSmithery(e, now, fetcher)).toMatchObject({ pages: 2, added: 2, merged: 1, total_count: 3 });
    expect(auth.every((a) => a === "Bearer test-key-not-real")).toBe(true);

    const both = (await (await fetchWorker("/api/v1/check?id=smithery%3A%40acme%2Fboth")).json()) as { tool: { id: string } };
    expect(both.tool.id).toBe("npm:acme-both"); // one page: the registry's npm tool, with the Smithery name as an alias
    expect(await (await fetchWorker("/t/smithery%3Asolo%2Fremote")).text()).toContain("smithery.ai/server/solo/remote");

    // Within the week: no calls. After a week: a new pass that skips everything already linked.
    expect(await seedSmithery(e, now + 1, fetcher)).toEqual({ skipped: "up_to_date" });
    const db = getDb(env);
    const before = (await db.select().from(t.publicSignals).where(eq(t.publicSignals.source, "smithery"))).length;
    expect(await seedSmithery(e, now + 8 * 86_400_000, fetcher)).toMatchObject({ pages: 2, added: 0, merged: 0 });
    expect((await db.select().from(t.publicSignals).where(eq(t.publicSignals.source, "smithery"))).length).toBe(before);

    const denied = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await seedSmithery(e, now + 16 * 86_400_000, denied)).toMatchObject({ pages: 0, error: 401 });
  });
});
