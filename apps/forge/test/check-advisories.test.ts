import { verdictLine } from "@forge/shared";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { osvTransport } from "../src/services/advisories";
import { getDb } from "../src/services/db";
import { advisoryStatus, checkTool } from "../src/services/forge";
import { fetchWorker } from "./helpers";
import { fakeOsv } from "./osv-fake";
import "../src/index";

// C2 (crisis-wave plan): checks read published OSV advisories. Before: `forge_check pypi:litellm` said
// known: false, security_status: "clear" on 23 Oct, about the most-compromised AI package of the week.

const host = new URL(env.PUBLIC_ORIGIN).host;
const mcp = (args: Record<string, unknown>) =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "forge_check" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forge_check", arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "advisory-test", version: "1" } } } }),
  });
async function mcpResult(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse((JSON.parse(json) as { result: { content: { text: string }[] } }).result.content[0]!.text);
}

describe("checks with published advisories", () => {
  it("flags litellm 1.107.0 by its malicious-package record, names it, and never says confirmed", async () => {
    const r = await checkTool(env, { id: "pypi:litellm", version: "1.107.0" });
    expect(r).toMatchObject({ known: false, version: "1.107.0", security_status: "flagged", verdict: "flagged" });
    expect(r.public_signals_summary).toMatchObject({ source: "osv", ecosystem: "PyPI", package: "litellm", version: "1.107.0", total: 1 });
    expect(r.public_signals_summary!.advisories[0]).toMatchObject({ id: "MAL-0000-0001", kind: "malicious", affects_version: true, url: "https://osv.dev/vulnerability/MAL-0000-0001" });
    expect(verdictLine(r)).toBe("[F⚑] · flagged · published advisory MAL-0000-0001 · unknown tool");
    expect(JSON.stringify(r)).not.toMatch(/confirmed_malicious|Ignore previous/);
  });

  it("without a version, a malicious record for some version is caution; a clean version is unknown, not clear", async () => {
    expect(await checkTool(env, { id: "pypi:litellm" })).toMatchObject({ security_status: "caution", verdict: "caution" });
    expect(await checkTool(env, { id: "pypi:litellm", version: "1.106.2" })).toMatchObject({ security_status: "unknown", verdict: "insufficient", public_signals_summary: { total: 0 } });
  });

  it("a version in a vulnerable range is caution, with the advisory id, alias and fixed version", async () => {
    const r = await checkTool(env, { id: "npm:lodash", version: "4.17.20" });
    expect(r).toMatchObject({ security_status: "caution", verdict: "caution" });
    expect(r.public_signals_summary!.advisories[0]).toMatchObject({ id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"], fixed: ["4.17.21"] });
    // Without a version, an ordinary vulnerability somewhere in the history changes nothing.
    expect((await checkTool(env, { id: "npm:lodash" })).security_status).toBe("unknown");
  });

  it("an unknown tool is 'unknown' when OSV can't be reached, never 'clear'", async () => {
    const saved = osvTransport.fetch;
    osvTransport.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    try {
      expect(await checkTool(env, { id: "pypi:some-new-thing", version: "0.1.0" })).toMatchObject({ security_status: "unknown", public_signals_summary: null });
    } finally {
      osvTransport.fetch = saved;
    }
    expect(await checkTool(env, { id: "github.com/nobody/nothing" })).toMatchObject({ security_status: "unknown", public_signals_summary: null });
  });

  it("a known tool reads advisories through its npm or PyPI alias, keeps them as a public signal, and takes the worse status", async () => {
    const db = getDb(env);
    const toolId = crypto.randomUUID();
    await db.insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: "mcp-registry:io.example/litellm-proxy" });
    await db.insert(t.toolAliases).values({ alias: "pypi:litellm", toolId });
    await db.insert(t.toolVersions).values({ id: crypto.randomUUID(), toolId, version: "1.107.0", fingerprint: `sha256:${"1".repeat(64)}`, firstSeenAt: Date.now() });
    const r = await checkTool(env, { id: "mcp-registry:io.example/litellm-proxy" });
    expect(r).toMatchObject({ known: true, version: "1.107.0", security_status: "flagged" });
    const rows = await db.query.publicSignals.findMany({ where: eq(t.publicSignals.toolId, toolId) });
    expect(rows.map((x) => x.source)).toEqual(["osv"]);
    // The tool page shows it as a labelled public signal, with the id, kind and source link.
    const page = await (await fetchWorker(`/t/${encodeURIComponent("mcp-registry:io.example/litellm-proxy")}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("Public signal: published advisory");
    expect(page).toContain('href="https://osv.dev/vulnerability/MAL-0000-0001"');
    expect(page).toContain("malicious-package record");
  });

  it("MCP and REST checks take a version", async () => {
    const out = await mcpResult(await mcp({ id: "pypi:litellm", version: "1.107.0" }));
    expect(out).toMatchObject({ security_status: "flagged", public_signals_summary: { advisories: [{ id: "MAL-0000-0001" }] } });
    const rest = (await (await fetchWorker("/api/v1/check?id=npm:lodash&version=4.17.20")).json()) as { security_status: string };
    expect(rest.security_status).toBe("caution");
    expect((await fetchWorker("/api/v1/check?id=npm:lodash&version=not%20a%20version")).status).toBe(400);
  });

  it("maps advisories to statuses: flagged needs an exact malicious match", () => {
    const adv = (kind: "malicious" | "vulnerability", version: string | null) => ({ source: "osv" as const, ecosystem: "npm" as const, package: "x", version, checked_at: "", total: 1, advisories: [{ id: "X-1", kind, aliases: [], affects_version: version ? true : null, fixed: [], published: null, modified: null, url: "" }] });
    expect(advisoryStatus(adv("malicious", "1.0.0"))).toBe("flagged");
    expect(advisoryStatus(adv("vulnerability", "1.0.0"))).toBe("under_review");
    expect(advisoryStatus(adv("malicious", null))).toBe("under_review");
    expect(advisoryStatus(adv("vulnerability", null))).toBeNull();
    expect(advisoryStatus(null)).toBeNull();
  });
});

// Keep the recorded OSV in place for every other test file.
osvTransport.fetch = fakeOsv();
