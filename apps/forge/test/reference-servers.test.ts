import { env } from "cloudflare:workers";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { REFERENCE_SERVERS, referenceSeedTool, seedReferenceServers } from "../src/seed/reference-servers";
import { getDb } from "../src/services/db";
import { recordToolCheck } from "../src/services/feedback";
import { day } from "../src/services/proof";
import { fetchWorker } from "./helpers";
import "../src/index";

// Issue #170: our own example id (npm:@modelcontextprotocol/server-filesystem) came back "unknown", because the MCP
// project's reference servers aren't in the official MCP Registry that seeds our tool list.

const check = async (id: string) =>
  (await (await fetchWorker(`/api/v1/check?id=${encodeURIComponent(id)}`)).json()) as { known: boolean; tool: { id: string } | null };

describe("MCP reference servers (issue #170)", () => {
  it("maps each server to its npm package, else its GitHub folder, keeping the old and PyPI forms as aliases", () => {
    const fs = referenceSeedTool(REFERENCE_SERVERS.find((r) => r.dir === "filesystem")!);
    expect(fs.canonicalId).toBe("npm:@modelcontextprotocol/server-filesystem");
    expect(fs.aliases).toEqual(["github.com/modelcontextprotocol/servers/tree/main/src/filesystem"]);
    expect(fs.signal).toMatchObject({ status: "active", package_deprecated: false, reference_server: true });

    const fetchSrv = referenceSeedTool(REFERENCE_SERVERS.find((r) => r.dir === "fetch")!);
    expect(fetchSrv.canonicalId).toBe("github.com/modelcontextprotocol/servers/tree/main/src/fetch");
    expect(fetchSrv.aliases).toEqual(["pypi:mcp-server-fetch"]);

    const gh = referenceSeedTool(REFERENCE_SERVERS.find((r) => r.dir === "github")!);
    expect(gh.canonicalId).toBe("npm:@modelcontextprotocol/server-github");
    expect(gh.aliases).toContain("github.com/modelcontextprotocol/servers-archived/tree/main/src/github");
    expect(gh.aliases).toContain("github.com/modelcontextprotocol/servers/tree/main/src/github");
    expect(gh.signal).toMatchObject({ status: "archived", package_deprecated: true });

    // Every id is unique, so seeding can't merge two servers.
    const all = REFERENCE_SERVERS.map(referenceSeedTool).flatMap((s) => [s.canonicalId, ...s.aliases]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("seeds once, after which the example ids are known tools and no longer count as misses", async () => {
    expect(await seedReferenceServers(env)).toBe(REFERENCE_SERVERS.length);
    expect(await seedReferenceServers(env)).toBe(0);

    expect(await check("npm:@modelcontextprotocol/server-filesystem")).toMatchObject({
      known: true,
      tool: { id: "npm:@modelcontextprotocol/server-filesystem" },
    });
    expect((await check("https://github.com/modelcontextprotocol/servers/tree/main/src/fetch")).known).toBe(true);
    expect(await check("pypi:mcp-server-fetch")).toMatchObject({ known: true, tool: { id: "github.com/modelcontextprotocol/servers/tree/main/src/fetch" } });
    expect(await check("npm:@modelcontextprotocol/server-github")).toMatchObject({ known: true });

    const now = Date.now();
    await recordToolCheck(env, { id: "npm:@modelcontextprotocol/server-filesystem" }, now);
    const misses = await getDb(env)
      .select()
      .from(t.usageDaily)
      .where(and(eq(t.usageDaily.day, day(now)), like(t.usageDaily.key, "miss:check:npm:@modelcontextprotocol/%")));
    expect(misses).toEqual([]);

    // A2A answers the same way (the example in our agent card).
    const res = await fetchWorker("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "user", messageId: "m1", parts: [{ kind: "text", text: "check npm:@modelcontextprotocol/server-filesystem" }] } },
      }),
    });
    const body = (await res.json()) as { result: { parts: { data: { result: { known: boolean } } }[] } };
    expect(body.result.parts[0]!.data.result.known).toBe(true);
  });
});
