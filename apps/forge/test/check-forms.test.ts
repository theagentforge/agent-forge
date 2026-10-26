import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkTool } from "../src/services/forge";
import { canonicalFromUrl, splitInlineVersion, versionFromUrl } from "../src/services/tools";
import { fetchWorker } from "./helpers";
import "../src/index";

// 24 Oct production check: common ways of writing a version (inline, or in a registry URL) read as "unknown" and missed
// the malicious-package record that pypi:litellm with version 1.107.0 finds. Plus the refusals agents and directory
// checkers hit on REST and /mcp/public.

describe("versions written into the id or URL", () => {
  it("are split off the id", () => {
    expect(splitInlineVersion("npm:lodash@4.17.20")).toEqual({ id: "npm:lodash", version: "4.17.20" });
    expect(splitInlineVersion("npm:@scope/name@1.2.3")).toEqual({ id: "npm:@scope/name", version: "1.2.3" });
    expect(splitInlineVersion("npm:@scope/name")).toEqual({ id: "npm:@scope/name", version: null });
    expect(splitInlineVersion("pypi:requests==2.19.0")).toEqual({ id: "pypi:requests", version: "2.19.0" });
    expect(splitInlineVersion("pypi:litellm@1.107.0")).toEqual({ id: "pypi:litellm", version: "1.107.0" });
    expect(splitInlineVersion("github.com/a/b@v1")).toEqual({ id: "github.com/a/b@v1", version: null });
    expect(splitInlineVersion("npm:pkg@latest")).toEqual({ id: "npm:pkg@latest", version: null });
  });

  it("are read from npm and PyPI page URLs, and the page maps to the package id", () => {
    expect(canonicalFromUrl("https://pypi.org/project/litellm/")).toBe("pypi:litellm");
    expect(canonicalFromUrl("https://pypi.org/project/LiteLLM/1.107.0/")).toBe("pypi:litellm");
    expect(versionFromUrl("https://pypi.org/project/litellm/1.107.0/")).toBe("1.107.0");
    expect(canonicalFromUrl("https://www.npmjs.com/package/lodash/v/4.17.20")).toBe("npm:lodash");
    expect(canonicalFromUrl("https://www.npmjs.com/package/@scope/name/v/1.0.0")).toBe("npm:@scope/name");
    expect(versionFromUrl("https://www.npmjs.com/package/lodash/v/4.17.20")).toBe("4.17.20");
    expect(versionFromUrl("https://www.npmjs.com/package/lodash")).toBeNull();
  });

  it("find the same malicious-package record as id + version", async () => {
    const exact = await checkTool(env, { id: "pypi:litellm", version: "1.107.0" });
    expect(exact.verdict).toBe("flagged");
    for (const q of [{ id: "pypi:litellm==1.107.0" }, { id: "pypi:litellm@1.107.0" }, { url: "https://pypi.org/project/litellm/1.107.0/" }]) {
      const r = await checkTool(env, q);
      expect(r.verdict, JSON.stringify(q)).toBe("flagged");
      expect(r.asked_version, JSON.stringify(q)).toBe("1.107.0");
      expect(r.public_signals_summary?.advisories[0]?.id).toBe(exact.public_signals_summary?.advisories[0]?.id);
    }
  });
});

describe("REST and MCP doors", () => {
  it("/api/v1/check ignores link tags instead of refusing", async () => {
    const res = await fetchWorker("/api/v1/check?id=npm:express&from=tool-page&utm_source=x");
    expect(res.status).toBe(200);
  });

  it("GET on POST-only endpoints says how to call them", async () => {
    for (const p of ["/api/v1/watch", "/api/v1/exposure"]) {
      const res = await fetchWorker(p);
      expect(res.status, p).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
      expect(((await res.json()) as { method: string }).method).toBe("POST");
    }
  });

  it("/mcp/public answers a POST with no Accept header, and a browser preflight from any origin", async () => {
    const host = new URL(env.PUBLIC_ORIGIN).host;
    const res = await fetchWorker("/mcp/public", {
      method: "POST",
      headers: { Host: host, "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "no-accept", version: "1" } } }),
    });
    expect(res.status).toBe(200);
    const pre = await fetchWorker("/mcp/public", { method: "OPTIONS", headers: { Host: host, Origin: "https://agent.example", "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBeLessThan(300);
  });
});
