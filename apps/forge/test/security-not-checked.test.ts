import { verdictLine } from "@forge/shared";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { osvTransport } from "../src/services/advisories";
import { checkTool } from "../src/services/forge";
import { connectAgent, fetchWorker, fp, postReport, report } from "./helpers";
import { fakeOsv } from "./osv-fake";
// The verdict code that installed clients (plugin 0.9.0, the published CLI, forge-check@v1) run today, unchanged.
import * as old from "./fixtures/old-clients/verdict-plugin-0.9.0.mjs";
import "../src/index";

// ADR 0152 (13 Nov outside walkthrough): GitHub's own MCP server answered security_status "clear" while no advisory
// source had been checked (advisories exist only for npm and PyPI). security_status keeps its values, so installed
// clients keep working; a separate field, advisories_checked, says whether an advisory source answered.

const GH = "github.com/github/github-mcp-server";

describe("advisories_checked: a field beside security_status", () => {
  beforeAll(() => {
    osvTransport.fetch = fakeOsv();
  });

  it("a github.com tool: clear (nothing flagged it), advisories_checked false, said everywhere a person or agent reads it", async () => {
    vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
    const { token } = await connectAgent();
    const res = await postReport(token, report({ tool: { kind: "mcp_server", id: GH, version: "0.20.1", fingerprint: fp("9") } }));
    expect(res.status).toBe(201);
    const r = await checkTool(env, { id: GH });
    expect(r).toMatchObject({ known: true, security_status: "clear", advisories_checked: false, verdict: "insufficient", public_signals_summary: null });
    expect(verdictLine(r)).toContain("advisories not checked");

    const api = (await (await fetchWorker(`/api/v1/check?id=${encodeURIComponent(GH)}`)).json()) as { security_status: string; advisories_checked: boolean; summary?: { security_status: string; advisories_checked: boolean }; share?: { receipt_url: string } };
    expect(api).toMatchObject({ security_status: "clear", advisories_checked: false });
    if (api.summary) expect(api.summary).toMatchObject({ security_status: "clear", advisories_checked: false });

    // The receipt keeps security "clear" and adds advisories_checked false; its page says "not flagged" and "not checked".
    if (api.share?.receipt_url) {
      const rc = await (await fetchWorker(new URL(api.share.receipt_url).pathname, { headers: { Accept: "text/html" } })).text();
      expect(rc).toContain("<dt>Security status</dt><dd>not flagged</dd>");
      expect(rc).toContain("not checked (no advisory source for this tool)");
    }

    const page = await (await fetchWorker(`/t/${encodeURIComponent(GH)}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toMatch(/id="answer">As of [^<]*security status for github\.com\/github\/github-mcp-server@0\.20\.1: not flagged, advisories not checked\. 1 field report: 1 worked\. No advisory lookup for this kind of tool/);
    expect(page).toMatch(/<title>github\.com\/github\/github-mcp-server: security not flagged, advisories not checked, 1 field report/);
  });

  it("an npm tool whose OSV lookup answered with nothing: clear, advisories_checked true", async () => {
    const { token } = await connectAgent();
    vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
    await postReport(token, report({ tool: { kind: "mcp_server", id: "npm:lodash", version: "4.17.21", fingerprint: fp("a") } }));
    expect(await checkTool(env, { id: "npm:lodash", version: "4.17.21" })).toMatchObject({ security_status: "clear", advisories_checked: true });
  });

  it("an npm tool whose OSV lookup failed: advisories_checked false", async () => {
    const { token } = await connectAgent();
    vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
    await postReport(token, report({ tool: { kind: "mcp_server", id: "npm:some-offline-pkg", version: "1.0.0", fingerprint: fp("b") } }));
    const saved = osvTransport.fetch;
    osvTransport.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    try {
      expect(await checkTool(env, { id: "npm:some-offline-pkg", version: "1.0.0" })).toMatchObject({ security_status: "clear", advisories_checked: false });
    } finally {
      osvTransport.fetch = saved;
    }
  });
});

describe("installed clients (plugin 0.9.0's verdict code, unchanged) read a new answer without 'undefined'", () => {
  it("the REST answer for a no-advisory tool, and a few shapes around it", async () => {
    const api = (await (await fetchWorker(`/api/v1/check?id=${encodeURIComponent(GH)}`)).json()) as Record<string, unknown>;
    const scored = { ...api, forge_score: 88, distinct_owners: 6, verified_owners: 3 };
    for (const a of [api, scored, { ...api, known: false, tool: null }]) {
      const line = old.verdictLine(a as never);
      expect(line, JSON.stringify(a).slice(0, 120)).not.toMatch(/undefined|null|NaN/);
      expect(["clear", "insufficient"]).toContain(old.displayVerdict(a as never));
    }
    expect(old.verdictLine(scored as never)).toMatch(/^\[F✓\] · clear · Forge Score 88/);
  });
});
