import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { EXPOSURE_MAX_ITEMS, exposureRequest, parsePipFreeze } from "../src/services/exposure";
import { refreshKev } from "../src/services/kev";
import { fetchWorker } from "./helpers";
import { fakeOsv } from "./osv-fake";
import "../src/index";

// C4 (crisis-wave plan P2): installed packages in (names and versions only), advisory matches out, from recorded
// OSV answers (test/osv-fake.ts). No test reaches the network.

const host = new URL(env.PUBLIC_ORIGIN).host;
const publicRpc = (method: string, params: unknown = {}) =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function result(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}
const STACK = [
  { ecosystem: "pypi", name: "LiteLLM", version: "1.107.0" },
  { ecosystem: "npm", name: "lodash", version: "4.17.20" },
  { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
];

describe("exposure check (forge_exposure, POST /api/v1/exposure)", () => {
  it("reads only name==version lines from pip freeze", () => {
    const text = "# comment\nlitellm==1.107.0\nrequests[socks]==2.34.2 ; python_version>'3.8'\n-e git+https://x/y#egg=z\nflask>=3\nsecret_token = abc\nNumPy === 2.1.0  # pinned\n";
    expect(parsePipFreeze(text)).toEqual([
      { ecosystem: "pypi", name: "litellm", version: "1.107.0" },
      { ecosystem: "pypi", name: "requests", version: "2.34.2" },
      { ecosystem: "pypi", name: "NumPy", version: "2.1.0" },
    ]);
  });

  it("returns each match as data: flagged for a malicious-package record, caution for a vulnerability, nothing for no match", async () => {
    const r = await exposureRequest(env, { packages: STACK }, { fetcher: fakeOsv(), now: Date.UTC(2026, 9, 23, 12) });
    if ("error" in r) throw new Error(r.detail);
    expect(r).toMatchObject({ source: "osv", items: 3, checked: 3, matched: 2, not_checked: [] });
    expect(r.matches.map((m) => [m.package, m.status])).toEqual([["litellm", "flagged"], ["lodash", "caution"]]);
    expect(r.matches[0]!.line).toBe("litellm 1.107.0 matches MAL-0000-0001; no fixed version listed; source https://osv.dev/vulnerability/MAL-0000-0001");
    expect(r.matches[1]!.line).toBe("lodash 4.17.20 matches GHSA-35jh-r3h4-6jhm; fixed 4.17.21; source https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm");
    // Data, never instructions, and none of OSV's own text.
    expect(JSON.stringify(r)).not.toMatch(/you should|install now|run |Ignore previous|curl/i);
  });

  it("adds the CISA exploited flag when an alias is on the KEV list", async () => {
    await env.KV.delete("kev:tried");
    const feed = (async () => Response.json({ vulnerabilities: ["CVE-2021-23337", ...Array.from({ length: 500 }, (_, i) => `CVE-2000-${10_000 + i}`)].map((cveID) => ({ cveID })) })) as unknown as typeof fetch;
    await refreshKev(env, Date.UTC(2026, 9, 23, 1), feed);
    const r = await exposureRequest(env, { packages: [STACK[1]] }, { fetcher: fakeOsv() });
    if ("error" in r) throw new Error(r.detail);
    expect(r.matches[0]).toMatchObject({ advisories: [{ id: "GHSA-35jh-r3h4-6jhm", exploited_in_wild: true }] });
    expect(r.matches[0]!.line).toContain("exploited in the wild (CISA KEV)");
    await env.KV.delete("kev:ids");
    await env.KV.delete("kev:tried");
  });

  it("gives structured errors, and 'not checked' (never clear) when OSV is down", async () => {
    expect(await exposureRequest(env, {})).toMatchObject({ error: "no_items" });
    expect(await exposureRequest(env, { packages: [{ ecosystem: "npm", name: "ok", version: "1.0.0" }, { ecosystem: "cargo", name: "x", version: "1" }, { ecosystem: "npm", name: "y", version: "not a version" }] })).toMatchObject({
      error: "invalid_items",
      invalid: [{ index: 1, reason: "name" }, { index: 2, reason: "version" }],
    });
    const many = Array.from({ length: EXPOSURE_MAX_ITEMS + 1 }, (_, i) => ({ ecosystem: "npm", name: `p${i}`, version: "1.0.0" }));
    expect(await exposureRequest(env, { packages: many })).toMatchObject({ error: "invalid_items" });
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r = await exposureRequest(env, { packages: [{ ecosystem: "npm", name: "never-cached-pkg", version: "9.9.9" }] }, { fetcher: down });
    expect(r).toMatchObject({ checked: 0, matched: 0, not_checked: [{ name: "never-cached-pkg", version: "9.9.9" }] });
  });

  it("works over HTTP and MCP, and stores daily counts only", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const http = await fetchWorker("/api/v1/exposure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pip_freeze: "litellm==1.107.0\nrequests==2.34.2\n" }) });
    expect(http.status).toBe(200);
    expect(await http.json()).toMatchObject({ matched: 1, matches: [{ package: "litellm", status: "flagged" }] });
    expect((await fetchWorker("/api/v1/exposure", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(400);

    const list = await result(await publicRpc("tools/list"));
    expect(list.result.tools.map((x: { name: string }) => x.name)).toContain("forge_exposure");
    const call = await result(await publicRpc("tools/call", { name: "forge_exposure", arguments: { packages: STACK.slice(0, 2) } }));
    expect(call.result.isError).toBe(false);
    expect(call.result.structuredContent).toMatchObject({ matched: 2 });

    const rows = await getDb(env).select().from(t.usageDaily).where(eq(t.usageDaily.day, day));
    const n = (k: string) => rows.find((x) => x.key === k)?.n ?? 0;
    expect(n("exposure:checks")).toBeGreaterThanOrEqual(2);
    expect(n("exposure:hits")).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rows)).not.toContain("litellm");
  });
});
