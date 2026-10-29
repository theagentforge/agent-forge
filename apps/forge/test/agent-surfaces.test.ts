import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import registry from "../../../integrations/registry/server.json";
import { A2A_SKILLS } from "../src/a2a";
import { PUBLIC_TOOLS, TRAP_CARD_RESOURCE, CHECK_PROMPT, REPORT_PROMPT } from "../src/mcp-public";
import { MCP_SERVER_VERSION, SERVERS } from "../src/server-info";
import { discoveryCounters } from "../src/services/usage";
import { PUBLICATIONS } from "../src/web/publications";
import { PREFLIGHT_PATHS, PROTOCOL_VERSIONS, securityTxt } from "../src/web/discovery";
import { fetchWorker } from "./helpers";
import "../src/index";

// Red team, 26 Oct 2026 (ADR 0052): every surface an outside agent can discover, read as that agent would. They must
// agree with each other (tool list, versions, names, repository), link to each other, and be machine-correct.

const ORIGIN = env.PUBLIC_ORIGIN;
const host = new URL(ORIGIN).host;
const TOOLS = Object.keys(PUBLIC_TOOLS).sort();

/** Text files at the top of public/ (served before the Worker in production, not by the test Worker). */
const STATIC = new Set(Object.keys(import.meta.glob<string>("../public/*.{md,txt}", { eager: true, query: "?raw", import: "default" })).map((k) => k.slice("../public".length)));

async function rpc(path: string, method: string, params: Record<string, unknown> = {}, version = "2025-06-18") {
  const res = await fetchWorker(path, {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}
const initialize = (path: string, version = "2025-06-18") =>
  rpc(path, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "surface-test", version: "1" } }, version);
const llms = async () => (await fetchWorker("/llms.txt")).text();

describe("MCP serverInfo matches the Server Cards and the MCP Registry listing", () => {
  it("initialize names the server with a title, version, website and icon, the same as its card", async () => {
    for (const key of ["public", "gauntlet"] as const) {
      const s = SERVERS.find((x) => x.key === key)!;
      for (const version of ["2025-06-18", "2025-11-25", "2025-03-26"]) {
        const info = (await initialize(s.path, version)).result.serverInfo;
        expect(info, `${s.path} ${version}`).toMatchObject({ name: s.serverName, title: s.title, version: MCP_SERVER_VERSION, description: s.description, websiteUrl: `${ORIGIN}${s.websitePath}` });
        expect(info.icons[0].src).toBe(`${ORIGIN}/brand/forge-mark.svg`);
      }
      const card = (await (await fetchWorker(`${s.path}/server-card`)).json()) as { version: string; title: string; websiteUrl: string; description: string };
      expect(card).toMatchObject({ version: MCP_SERVER_VERSION, title: s.title, websiteUrl: `${ORIGIN}${s.websitePath}`, description: s.description });
    }
  });

  it("the MCP Registry listing has the same version, repository and endpoints", async () => {
    expect(registry.version).toBe(MCP_SERVER_VERSION);
    expect(registry.name).toBe(SERVERS.find((s) => s.key === "signed-in")!.name);
    expect(registry.remotes.map((r) => new URL(r.url).pathname)).toEqual(["/mcp/public", "/mcp"]);
    const card = (await (await fetchWorker("/mcp/public/server-card")).json()) as { repository: { url: string } };
    // ADR 0033: directories point at the MIT connection-files repo, not the all-rights-reserved code mirror.
    expect(card.repository.url).toBe(registry.repository.url);
    const cat = (await (await fetchWorker("/.well-known/ai-catalog.json")).json()) as { entries: { data?: { version: string; repository: { url: string } } }[] };
    const inline = cat.entries.find((e) => e.data)!.data!;
    expect(inline.version).toBe(MCP_SERVER_VERSION);
    expect(inline.repository.url).toBe(registry.repository.url);
  });
});

describe("ARD (/.well-known/ard.json)", () => {
  it("serves the AI Catalog under its newer path, with the same body and headers, counted as discovery", async () => {
    const [ard, cat] = await Promise.all([fetchWorker("/.well-known/ard.json"), fetchWorker("/.well-known/ai-catalog.json")]);
    expect(ard.status).toBe(200);
    for (const h of ["Content-Type", "Access-Control-Allow-Origin", "Cache-Control", "X-Content-Type-Options"]) expect(ard.headers.get(h), h).toBe(cat.headers.get(h));
    expect(await ard.json()).toEqual(await cat.json());
    expect(discoveryCounters({ method: "GET", url: `${ORIGIN}/.well-known/ard.json`, headers: new Headers() })).toEqual(["disc:ard"]);
    expect(await llms()).toContain("](/.well-known/ard.json)");
  });

  it("the well-known server card and the skills index are served next to it", async () => {
    const card = await fetchWorker("/.well-known/mcp/server-card.json");
    expect(card.status).toBe(200);
    expect(((await card.json()) as { name: string; version: string })).toMatchObject({ name: "io.theagentforge/forge-public", version: MCP_SERVER_VERSION });
    const skills = (await (await fetchWorker("/.well-known/agent-skills/index.json")).json()) as { $schema: string; skills: unknown[] };
    expect(skills.$schema).toContain("/discovery/0.2.0/");
    expect(skills.skills.length).toBeGreaterThan(0);
  });
});

describe("one tool list everywhere", () => {
  it("tools/list, llms.txt and the connection repo's install notes name the same six public tools", async () => {
    const listed = ((await rpc("/mcp/public", "tools/list")).result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(listed).toEqual(TOOLS);
    const text = await llms();
    const line = text.split("\n").find((l) => l.includes("`/mcp/public` (Streamable HTTP"))!;
    expect([...line.matchAll(/`((?:forge|arena)_[a-z_]+)`/g)].map((m) => m[1]).sort()).toEqual(TOOLS);
    const install = import.meta.glob<string>("../../../public-repo/forge-mcp/llms-install.md", { eager: true, query: "?raw", import: "default" });
    for (const doc of Object.values(install)) for (const tool of TOOLS) expect(doc, tool).toContain(`\`${tool}\``);
  });

  it("llms.txt lists the prompts, the resource, the protocol versions and the A2A skills that are served", async () => {
    const text = await llms();
    for (const p of [CHECK_PROMPT.name, REPORT_PROMPT.name]) expect(text).toContain(`\`${p}\``);
    expect(text).toContain(TRAP_CARD_RESOURCE.uri);
    for (const v of PROTOCOL_VERSIONS) expect(text).toContain(v);
    for (const s of A2A_SKILLS) expect(text).toContain(`\`${s.id}\``);
    const prompts = ((await rpc("/mcp/public", "prompts/list")).result.prompts as { name: string }[]).map((p) => p.name).sort();
    expect(prompts).toEqual([CHECK_PROMPT.name, REPORT_PROMPT.name].sort());
    const resources = ((await rpc("/mcp/public", "resources/list")).result.resources as { uri: string }[]).map((r) => r.uri);
    expect(resources).toEqual([TRAP_CARD_RESOURCE.uri]);
  });
});

describe("findable from each other, and nothing dead", () => {
  it("every page llms.txt links to is served", async () => {
    const links = [...(await llms()).matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]!).filter((p) => !p.includes("?"));
    expect(links.length).toBeGreaterThan(30);
    for (const path of new Set(links)) {
      if (STATIC.has(path)) continue;
      const res = await fetchWorker(path, { headers: { Host: host, Accept: "text/html" }, redirect: "manual" });
      expect(res.status, path).toBeLessThan(400);
      await res.body?.cancel();
    }
  });

  it("the sitemap lists every live publication and every HTML page llms.txt links to", async () => {
    const xml = await (await fetchWorker("/sitemap.xml")).text();
    const locs = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.slice(ORIGIN.length)));
    for (const p of PUBLICATIONS.filter((x) => x.live)) expect(locs.has(p.path), p.path).toBe(true);
    const pages = [...(await llms()).matchAll(/\]\((\/[^)\s?#]*)\)/g)].map((m) => m[1]!).filter((p) => !/\.[a-z]+$/.test(p) && !p.startsWith("/.well-known") && !p.startsWith("/api/"));
    // Gated pages (ADR 0094: /agents is noindex and out of the sitemap until 10 outside owners show a run).
    // ADR 0110: /pricing is noindex while PRICING_MODE is "keys", and /dashboard/keys is a signed-in page.
    const gated = new Set(["/agents", "/pricing", "/dashboard/keys"]);
    for (const p of new Set(pages)) if (!gated.has(p)) expect(locs.has(p), p).toBe(true);
  });

  it("the API catalog, the agent card and every page's Link header point at the other discovery files", async () => {
    const cat = JSON.stringify(await (await fetchWorker("/.well-known/api-catalog")).json());
    for (const p of ["/mcp/public/server-card", "/mcp/gauntlet/server-card", "/.well-known/agent-card.json", "/openapi.json", "/llms.txt"]) expect(cat).toContain(`${ORIGIN}${p}`);
    const card = (await (await fetchWorker("/.well-known/agent-card.json")).json()) as { documentationUrl: string; url: string };
    expect(card.documentationUrl).toBe(`${ORIGIN}/skill.md`);
    const link = (await fetchWorker("/connect", { headers: { Accept: "text/html" } })).headers.get("Link") ?? "";
    for (const p of ["/.well-known/api-catalog", "/llms.txt", "/.well-known/agent-card.json", "/mcp/public/server-card", "/openapi.json"]) expect(link).toContain(`<${p}>`);
  });
});

describe("machine-correct", () => {
  it("serves security.txt (RFC 9116) with a contact, a canonical URL and an expiry under a year away", async () => {
    const res = await fetchWorker("/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    expect(text).toMatch(/^Contact: mailto:hello@theagentforge\.io$/m);
    expect(text).toContain(`Canonical: ${ORIGIN}/.well-known/security.txt`);
    const now = Date.UTC(2026, 9, 26);
    const expires = Date.parse(/^Expires: (.+)$/m.exec(securityTxt(ORIGIN, now))![1]!);
    expect(expires - now).toBeGreaterThan(90 * 86_400_000);
    expect(expires - now).toBeLessThan(365 * 86_400_000);
  });

  it("answers CORS preflights on the read-only discovery files, and llms.txt and skill.md are CORS-open", async () => {
    for (const path of PREFLIGHT_PATHS) {
      const res = await fetchWorker(path, { method: "OPTIONS", headers: { Origin: "https://agent.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "mcp-protocol-version" } });
      expect(res.status, path).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
    }
    for (const path of ["/llms.txt", "/skill.md"]) {
      const res = await fetchWorker(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
      await res.body?.cancel();
    }
  });

  it("the signed-in /mcp refuses without a token in a way MCP clients can start OAuth from", async () => {
    const res = await fetchWorker("/mcp", { method: "POST", headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    const metadata = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(metadata).toBe(`${ORIGIN}/.well-known/oauth-protected-resource`);
    const prm = (await (await fetchWorker(new URL(metadata!).pathname)).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.authorization_servers).toEqual([ORIGIN]);
    const as = (await (await fetchWorker("/.well-known/oauth-authorization-server")).json()) as { code_challenge_methods_supported: string[]; registration_endpoint: string };
    expect(as.code_challenge_methods_supported).toContain("S256");
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(await llms()).toContain("](/.well-known/oauth-protected-resource)");
  });
});
