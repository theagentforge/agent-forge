import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { REPORT_NEEDED } from "../src/mcp";
import { getDb } from "../src/services/db";
import { checkTool, submitReport } from "../src/services/forge";
import { lookupFingerprint, registryTransport } from "../src/services/registry";
import { canonicalToolId } from "../src/services/tools";
import { connectAgent, fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// The contribution path, walked as an outside agent (26 Oct 2026, ADR 0056). Before: 0 field reports from outside in a
// week. A check of an unknown tool had no report link; PyPI tools (pypi:litellm, our top check) couldn't be reported
// on at all; every report needed a sha256 fingerprint that neither the agent nor its person could know; a malformed
// forge_report got the SDK's one-line validation error; and honest notes like "token: expired" were refused whole.

const host = new URL(env.PUBLIC_ORIGIN).host;
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const SDIST = "b".repeat(64);

/** A recorded npm registry and PyPI: one version of each test package; anything else is a 404. */
function fakeRegistry(calls: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://registry.npmjs.org/path-npm-pkg/1.2.0") return Response.json({ version: "1.2.0", dist: { integrity: "sha512-pathnpm" } });
    if (url === "https://registry.npmjs.org/path-npm-new/2.0.0") return Response.json({ version: "2.0.0", dist: { integrity: "sha512-pathnew" } });
    if (url === "https://pypi.org/pypi/path-py-pkg/0.4.1/json")
      return Response.json({ info: { version: "0.4.1" }, urls: [{ packagetype: "bdist_wheel", filename: "path_py_pkg-0.4.1-py3-none-any.whl", digests: { sha256: "a".repeat(64) } }, { packagetype: "sdist", filename: "path_py_pkg-0.4.1.tar.gz", digests: { sha256: SDIST } }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const saved = registryTransport.fetch;
afterEach(() => {
  registryTransport.fetch = saved;
  vi.restoreAllMocks();
});

async function mcp(token: string, name: string, args: unknown) {
  const res = await fetchWorker("/mcp", {
    method: "POST",
    headers: { Host: host, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const json = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  expect(json.error, JSON.stringify(json.error)).toBeUndefined();
  return json.result as { isError?: boolean; structuredContent: any };
}

const reportOn = (id: string, { version = "0.4.1", ...extra }: Record<string, unknown> = {}) => ({ tool: { kind: "api", id, version }, task: { category: "coding", framework: "claude-code" }, outcome: "worked", ...extra });

describe("filing a first report from outside", () => {
  it("PyPI ids are reportable: a forge_report without a fingerprint gets PyPI's sha256 of the sdist", async () => {
    const calls: string[] = [];
    registryTransport.fetch = fakeRegistry(calls);
    const { token } = await connectAgent();
    const r = await mcp(token, "forge_report", reportOn("pypi:Path_Py.Pkg"));
    expect(r.isError, JSON.stringify(r.structuredContent)).toBe(false);
    expect(r.structuredContent).toMatchObject({ ok: true, page_url: `${env.PUBLIC_ORIGIN}/t/pypi%3Apath-py-pkg` });
    expect(calls).toEqual(["https://pypi.org/pypi/path-py-pkg/0.4.1/json"]);
    const db = getDb(env);
    const tool = (await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, "pypi:path-py-pkg") }))!;
    const v = await db.query.toolVersions.findFirst({ where: eq(t.toolVersions.toolId, tool.id) });
    expect(v).toMatchObject({ version: "0.4.1", fingerprint: `sha256:${SDIST}` });
    // A check by any spelling of the name finds it now.
    expect(await checkTool(env, { id: "pypi:PATH-py_pkg" })).toMatchObject({ known: true, version: "0.4.1", reports_for_this_version: 1 });
  });

  it("npm: the fingerprint is the same sha256 of dist.integrity the House, plugin and CLI use, cached after one look-up", async () => {
    const calls: string[] = [];
    registryTransport.fetch = fakeRegistry(calls);
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const { token } = await connectAgent();
    const r = await mcp(token, "forge_report", reportOn("npm:path-npm-pkg", { version: "1.2.0", note: "OAuth refresh failed, token: expired after an hour." }));
    // The honest note about an expired token is published, not refused as a credential.
    expect(r.structuredContent).toMatchObject({ ok: true, note_status: "published" });
    const v = await getDb(env).query.toolVersions.findFirst({ where: eq(t.toolVersions.version, "1.2.0") });
    expect(v?.fingerprint).toBe(`sha256:${await sha("sha512-pathnpm")}`);
    expect(await lookupFingerprint(env, "npm:path-npm-pkg", "1.2.0")).toEqual({ version: "1.2.0", fingerprint: v!.fingerprint });
    expect(calls).toHaveLength(1);
  });

  it("a version the registry doesn't have, or a malformed report, is answered as data with the field and what a report holds", async () => {
    registryTransport.fetch = fakeRegistry();
    const { token } = await connectAgent();
    const missing = await mcp(token, "forge_report", reportOn("pypi:path-py-pkg", { version: "9.9.9" }));
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ ok: false, reason: "invalid_report", field: "tool.fingerprint", needed: REPORT_NEEDED });
    const bad = await mcp(token, "forge_report", { tool: { id: "npm:x" } });
    expect(bad.structuredContent).toMatchObject({ ok: false, reason: "invalid_report", field: "tool.kind", needed: REPORT_NEEDED });
    // No ready-to-send example: this tool writes, and an example sent back as-is would be a false report.
    expect(bad.structuredContent).not.toHaveProperty("examples");
    expect(AGENT_DIRECTED.exec(REPORT_NEEDED)).toBeNull();
  });

  it("a check of an unknown package links to /report with the asked version, and the page files it in one step", async () => {
    registryTransport.fetch = fakeRegistry();
    const c = await checkTool(env, { id: "npm:path-npm-new@2.0.0" });
    expect(c.contribute).toMatchObject({ report_url: `${env.PUBLIC_ORIGIN}/report?tool=npm%3Apath-npm-new&kind=mcp_server&version=2.0.0`, reports_needed: { people: 5, verified: 2 } });
    // Filed through the same path the page uses (submitReport), with no fingerprint in the draft.
    const { props } = await connectAgent();
    const r = await submitReport(env, props, { tool: { kind: "mcp_server", id: "npm:path-npm-new", version: "2.0.0", fingerprint: "" }, task: { category: "general", framework: "other" }, outcome: "partial" });
    expect(r).toMatchObject({ ok: true });
  });

  it("the signed-in forge_report publishes the fingerprint as optional, and canonical PyPI ids follow PEP 503", async () => {
    const { token } = await connectAgent();
    const res = await fetchWorker("/mcp", {
      method: "POST",
      headers: { Host: host, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const text = await res.text();
    const tools = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)).result.tools as { name: string; inputSchema: any }[];
    const report = tools.find((x) => x.name === "forge_report")!;
    expect(report.inputSchema.properties.tool.required).toEqual(["kind", "id", "version"]);
    expect(tools.find((x) => x.name === "forge_check")!.inputSchema.properties).toHaveProperty("version");
    expect(canonicalToolId("pypi:LiteLLM")).toBe("pypi:litellm");
    expect(canonicalToolId("pypi:Foo_Bar.baz")).toBe("pypi:foo-bar-baz");
  });
});
