import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedFromRegistry, toSeedTool, type RegistryEntry } from "../src/seed/mcp-registry";
import { connectAgent, fetchWorker, postReport, report } from "./helpers";
import "../src/index";

const entry = (name: string, extra: Partial<RegistryEntry["server"]> = {}, status = "active"): RegistryEntry => ({
  server: { name, description: `${name} does things`, version: "1.2.3", ...extra },
  _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true, publishedAt: "2026-10-01T00:00:00Z" } },
});

describe("MCP Registry seeding", () => {
  it("prefers the npm package, then the GitHub repo, then the registry name", () => {
    const withNpm = toSeedTool(
      entry("io.github.acme/search", {
        repository: { url: "https://github.com/Acme/search-mcp", source: "github" },
        packages: [{ registryType: "npm", identifier: "@acme/search-mcp" }],
      }),
    )!;
    expect(withNpm.canonicalId).toBe("npm:@acme/search-mcp");
    expect(withNpm.aliases.sort()).toEqual(["github.com/acme/search-mcp", "mcp-registry:io.github.acme/search"]);
    expect(withNpm.publisherGithub).toBe("acme");

    expect(toSeedTool(entry("io.github.x/y", { repository: { url: "https://github.com/x/y", subfolder: "srv" } }))!.canonicalId).toBe(
      "github.com/x/y/srv",
    );
    expect(toSeedTool(entry("com.example/remote"))!.canonicalId).toBe("mcp-registry:com.example/remote");
    expect(toSeedTool(entry("com.example/gone", {}, "deleted"))).toBeNull();
  });

  it("pages through the registry, labels public signals, and reports land on the seeded tool", async () => {
    const pages: Record<string, unknown> = {
      first: {
        servers: [
          entry("io.github.seed/one", { packages: [{ registryType: "npm", identifier: "seed-one" }], repository: { url: "https://github.com/seed/one" } }),
        ],
        metadata: { nextCursor: "c1", count: 1 },
      },
      c1: { servers: [entry("com.example/two")], metadata: { count: 1 } },
    };
    const urls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      return Response.json(pages[url.searchParams.get("cursor") ?? "first"]);
    }) as typeof fetch;

    expect(await seedFromRegistry(env, Date.now(), fetcher)).toEqual({ written: 1, done: false });
    expect(await seedFromRegistry(env, Date.now(), fetcher)).toEqual({ written: 1, done: true });
    expect(urls[0]).toContain("/v0.1/servers?limit=100&version=latest");
    expect(urls[1]).toContain("cursor=c1");
    // After a full pass, later runs only ask for what changed.
    await seedFromRegistry(env, Date.now(), (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ servers: [], metadata: { count: 0 } });
    }) as typeof fetch);
    expect(urls[2]).toContain("updated_since=");

    const check = await (await fetchWorker("/api/v1/check?id=github.com/seed/one")).json();
    expect(check).toMatchObject({ known: true, tool: { id: "npm:seed-one" }, distinct_owners: 0 });

    const page = await fetchWorker(`/t/${encodeURIComponent("npm:seed-one")}`);
    const html = await page.text();
    expect(html).toContain("public signal");
    expect(html).toContain("io.github.seed/one does things");

    const alias = await fetchWorker(`/t/${encodeURIComponent("mcp-registry:io.github.seed/one")}`, { redirect: "manual" });
    expect(alias.status).toBe(301);

    const { token } = await connectAgent();
    const res = await postReport(token, report({ tool: { ...report().tool, id: "github.com/seed/one" } }));
    expect(await res.json()).toMatchObject({ page_url: expect.stringContaining(encodeURIComponent("npm:seed-one")) });
  });
});

describe("seed runs", () => {
  it("keep paging within one run until the registry is done", async () => {
    const { seedRun } = await import("../src/seed/mcp-registry");
    await env.KV.delete("seed:mcp-registry:v1");
    let n = 0;
    const fetcher = (async () => {
      n++;
      return Response.json({
        servers: [entry(`com.example/run-${n}`)],
        metadata: n < 3 ? { nextCursor: `p${n}`, count: 1 } : { count: 1 },
      });
    }) as typeof fetch;
    expect(await seedRun(env, 10, fetcher)).toEqual({ written: 3, pages: 3 });
  });

  it("stop at the page budget and survive a registry error", async () => {
    const { seedRun } = await import("../src/seed/mcp-registry");
    await env.KV.delete("seed:mcp-registry:v1");
    let n = 0;
    const fetcher = (async () => {
      n++;
      if (n === 2) return new Response("oops", { status: 503 });
      return Response.json({ servers: [entry(`com.example/b-${n}`)], metadata: { nextCursor: `q${n}`, count: 1 } });
    }) as typeof fetch;
    expect(await seedRun(env, 5, fetcher)).toEqual({ written: 1, pages: 1 });
  });
});
