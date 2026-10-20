import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSIONS, SERVER_CARD_SCHEMA } from "../src/web/discovery";
import { fetchWorker } from "./helpers";
import "../src/index";

// Discovery files (agent-channels §4.4): the AI Catalog and MCP Server Cards, checked against SEP-2127's schema rules.

type Card = { $schema: string; name: string; version: string; description: string; title?: string; remotes: { type: string; url: string; supportedProtocolVersions: string[] }[]; repository: { url: string; source: string } };

function validCard(card: Card) {
  expect(card.$schema).toBe(SERVER_CARD_SCHEMA);
  expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  expect(card.name.length).toBeGreaterThanOrEqual(3);
  expect(card.description.length).toBeGreaterThanOrEqual(1);
  expect(card.description.length).toBeLessThanOrEqual(100);
  expect((card.title ?? "x").length).toBeLessThanOrEqual(100);
  expect(card.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(card.repository.source).toBe("github");
  for (const r of card.remotes) {
    expect(["streamable-http", "sse"]).toContain(r.type);
    expect(r.url).toMatch(/^https?:\/\/[^\s]+$/);
    expect(r.supportedProtocolVersions).toEqual(PROTOCOL_VERSIONS);
  }
  expect(JSON.stringify(card)).not.toMatch(/"tools"|"resources"|"prompts"/);
}

describe("the AI Catalog", () => {
  it("lists a Server Card per MCP server, by url or inline, with domain-anchored identifiers", async () => {
    const res = await fetchWorker("/.well-known/ai-catalog.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ai-catalog+json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const cat = (await res.json()) as { specVersion: string; entries: { identifier: string; type: string; url?: string; data?: Card }[] };
    expect(cat.specVersion).toBe("1.0");
    const host = new URL(env.PUBLIC_ORIGIN).hostname;
    for (const e of cat.entries) {
      expect(e.type).toBe("application/mcp-server-card+json");
      expect(e.identifier).toMatch(new RegExp(`^urn:air:${host.replace(/\./g, "\\.")}:mcp:[a-z-]+$`));
      expect(!!e.url !== !!e.data).toBe(true);
      if (e.data) validCard(e.data);
    }
    expect(new Set(cat.entries.map((e) => e.identifier)).size).toBe(cat.entries.length);
  });

  it("serves each hosted card at <endpoint>/server-card, and it describes that endpoint", async () => {
    for (const path of ["/mcp/public", "/mcp/gauntlet"]) {
      const res = await fetchWorker(`${path}/server-card`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/mcp-server-card+json");
      const card = (await res.json()) as Card;
      validCard(card);
      expect(card.remotes[0]!.url).toBe(`${env.PUBLIC_ORIGIN}${path}`);
    }
  });

  it("the A2A agent card is still served alongside", async () => {
    expect((await fetchWorker("/.well-known/agent-card.json")).status).toBe(200);
  });
});
