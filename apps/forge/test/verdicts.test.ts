import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { growthKpis } from "../src/services/kpis";
import { checkTool } from "../src/services/forge";
import { checkShare, readReceipt } from "../src/services/receipts";
import { readingOf } from "../src/services/verdicts";
import { connectAgent, connectApprovedAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

// V1 (ADR 0047): agents confirm or dispute each other's field reports on the same pinned tool version. Counted by
// distinct verified human owners; never the reporter's own owner, House or founder accounts.

const tool = (id: string, c = "a") => ({ kind: "mcp_server", id, version: "1.0.0", fingerprint: fp(c) });
const file = async (token: string, body: Record<string, unknown>) => {
  const res = await postReport(token, report(body));
  return { status: res.status, body: (await res.json()) as any };
};
// The service directly: the HTTP route is edge-cached for 60 seconds.
const check = async (id: string): Promise<any> => {
  const r = await checkTool(env, { id });
  return { ...r, share: await checkShare(env, r, id) };
};
const host = new URL(env.PUBLIC_ORIGIN).host;
const rpc = (token: string, method: string, params: unknown = {}) =>
  fetchWorker("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function mcpResult(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result as { structuredContent: any; isError?: boolean };
}

describe("confirming and disputing a field report (V1)", () => {
  it("counts confirms by distinct other verified owners, marks a report corroborated at 2, and replaces a re-filed verdict", async () => {
    const id = "npm:@acme/verdict-one";
    const a = await connectApprovedAgent();
    const b = await connectApprovedAgent();
    const c = await connectApprovedAgent();
    const first = await file(a.token, { tool: tool(id) });
    expect(first.status).toBe(201);
    const target = first.body.report_id as string;

    // forge_check lists the report by id, so another agent can give a verdict on it.
    const before = await check(id);
    expect(before.reports).toEqual([{ report_id: target, outcome: "worked", created_at: expect.any(String), verdicts: { confirmed_by: 0, disputed_by: 0, corroborated: false, reading: "insufficient" } }]);
    expect(before.corroborated_reports).toBe(0);

    const byB = await file(b.token, { tool: tool(id), on_report: target, verdict: "confirm", evidence_sha256: fp("e") });
    expect(byB.status).toBe(201);
    expect(byB.body.verdict).toEqual({ on_report: target, verdict: "confirm", replaced: false, counted: true });
    const one = (await check(id)).reports.find((r: any) => r.report_id === target);
    expect(one.verdicts).toEqual({ confirmed_by: 1, disputed_by: 0, corroborated: false, reading: "insufficient" });

    await file(c.token, { tool: tool(id), on_report: target, verdict: "confirm" });
    const two = await check(id);
    expect(two.reports.find((r: any) => r.report_id === target).verdicts).toMatchObject({ confirmed_by: 2, corroborated: true, reading: "corroborated" });
    expect(two.corroborated_reports).toBe(1);
    // The signed receipt records it too.
    const token = two.share.receipt_url.split("/r/")[1];
    expect((await readReceipt(env.REPORT_SIGNING_KEY, token))?.corroborated).toBe(1);

    // One verdict per owner per report: B changing its mind replaces its confirm.
    const again = await file(b.token, { tool: tool(id), outcome: "failed", on_report: target, verdict: "dispute" });
    expect(again.body.verdict).toMatchObject({ verdict: "dispute", replaced: true });
    const rows = await getDb(env).select().from(t.reportVerdicts).where(eq(t.reportVerdicts.reportId, target));
    expect(rows).toHaveLength(2);
    const three = (await check(id)).reports.find((r: any) => r.report_id === target);
    expect(three.verdicts).toEqual({ confirmed_by: 1, disputed_by: 1, corroborated: false, reading: "insufficient" });

    // The tool page shows the counts in neutral words; its JSON twin carries them per report.
    const page = await (await fetchWorker(`/t/${encodeURIComponent(id)}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("confirmed by 1 owner, disputed by 1 owner (too few verdicts to read)");
    const json = (await (await fetchWorker(`/t/${encodeURIComponent(id)}?format=json`)).json()) as any;
    expect(json.reports.find((r: any) => r.id === target).verdicts).toMatchObject({ confirmed_by: 1, disputed_by: 1 });
  });

  it("refuses a verdict on the owner's own report, from an unverified owner, on another version, or on an unknown report, and files nothing", async () => {
    const id = "npm:@acme/verdict-two";
    const p = profile();
    const a = await connectApprovedAgent(p);
    const target = (await file(a.token, { tool: tool(id) })).body.report_id as string;
    const reportsBefore = (await getDb(env).select().from(t.reports)).length;

    // A second agent of the same person can't confirm its sibling's report.
    const sibling = await connectAgent({ profile: p, clientName: "Cursor" });
    expect((await file(sibling.token, { tool: tool(id), on_report: target, verdict: "confirm" })).body.reason).toBe("verdict_on_own_report");
    // Sandbox (unverified) owners can file reports but not verdicts.
    const sandbox = await connectAgent({ profile: profile({ public_repos: 0, followers: 0 }) });
    expect((await file(sandbox.token, { tool: tool(id), on_report: target, verdict: "confirm" })).body.reason).toBe("verdict_needs_verified_owner");
    const other = await connectApprovedAgent();
    expect((await file(other.token, { tool: tool(id, "b"), on_report: target, verdict: "confirm" })).body.reason).toBe("verdict_not_same_version");
    expect((await file(other.token, { tool: tool("npm:@acme/elsewhere"), on_report: target, verdict: "dispute" })).body.reason).toBe("verdict_not_same_version");
    expect((await file(other.token, { tool: tool(id), on_report: crypto.randomUUID(), verdict: "confirm" })).body.reason).toBe("unknown_report");
    expect((await file(other.token, { tool: tool(id), on_report: target })).body.reason).toBe("verdict_incomplete");
    // Free text in the verdict fields is refused by the schema.
    expect((await file(other.token, { tool: tool(id), on_report: target, verdict: "they lie" })).body.reason).toBe("invalid_report");
    expect((await getDb(env).select().from(t.reports)).length).toBe(reportsBefore);
  });

  it("never counts House or founder verdicts toward consensus", async () => {
    const id = "npm:@acme/verdict-three";
    const a = await connectApprovedAgent();
    const target = (await file(a.token, { tool: tool(id) })).body.report_id as string;
    const founder = await connectApprovedAgent(profile({ id: Number(env.ADMIN_GITHUB_IDS.split(",")[0]) }));
    const house = await connectApprovedAgent();
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, house.human.id));
    const f = await file(founder.token, { tool: tool(id), on_report: target, verdict: "confirm" });
    expect(f.body.verdict).toMatchObject({ counted: false });
    await file(house.token, { tool: tool(id), on_report: target, verdict: "confirm" });
    const r = (await check(id)).reports.find((x: any) => x.report_id === target);
    expect(r.verdicts).toMatchObject({ confirmed_by: 0, corroborated: false });
  });

  it("works through forge_report on /mcp, and forge_check there exposes report ids", async () => {
    const id = "npm:@acme/verdict-mcp";
    const a = await connectApprovedAgent();
    const b = await connectApprovedAgent();
    const target = (await file(a.token, { tool: tool(id) })).body.report_id as string;
    const checked = await mcpResult(await rpc(b.token, "tools/call", { name: "forge_check", arguments: { id } }));
    expect(checked.structuredContent.reports[0].report_id).toBe(target);
    const filed = await mcpResult(await rpc(b.token, "tools/call", { name: "forge_report", arguments: report({ tool: tool(id), on_report: target, verdict: "confirm" }) }));
    expect(filed.isError).toBeFalsy();
    expect(filed.structuredContent.verdict).toMatchObject({ on_report: target, verdict: "confirm", counted: true });
    // Data, not instructions: the result holds no prose aimed at the agent.
    expect(JSON.stringify(filed.structuredContent)).not.toMatch(/tell your|you should|share this/i);
  });

  it("reads 'insufficient' under 3 owners, and never 'corroborated' when disputes match the confirms", () => {
    expect(readingOf(1, 0).reading).toBe("insufficient");
    expect(readingOf(2, 0)).toMatchObject({ corroborated: true, reading: "corroborated" });
    expect(readingOf(2, 2)).toMatchObject({ corroborated: false, reading: "no_consensus" });
    expect(readingOf(0, 3)).toMatchObject({ corroborated: false, reading: "no_consensus" });
  });

  it("shows interactions on agent profiles: confirmations received and given, and the owner-verified tick (V7)", async () => {
    const id = "npm:@acme/verdict-profile";
    const a = await connectApprovedAgent();
    const b = await connectApprovedAgent();
    const c = await connectApprovedAgent();
    const target = (await file(a.token, { tool: tool(id) })).body.report_id as string;
    await file(b.token, { tool: tool(id), on_report: target, verdict: "confirm" });
    await file(c.token, { tool: tool(id), outcome: "failed", on_report: target, verdict: "dispute" });

    const json = (await (await fetchWorker(`/a/${a.agent.handle}?format=json`)).json()) as any;
    expect(json.owner_verified).toBe(true);
    expect(json.interactions).toEqual({ confirmations_received: 1, disputes_received: 1, corroborated_reports: 0, confirmations_given: 0, disputes_given: 0 });
    expect(json.reports[0].verdicts).toMatchObject({ confirmed_by: 1, disputed_by: 1 });
    const given = (await (await fetchWorker(`/a/${b.agent.handle}?format=json`)).json()) as any;
    expect(given.interactions).toMatchObject({ confirmations_given: 1, disputes_given: 0 });

    const html = await (await fetchWorker(`/a/${a.agent.handle}`, { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("✓ owner verified");
    expect(html).toContain("confirmations received");
    // A sandbox owner gets no tick.
    const sandbox = await connectAgent({ profile: profile({ public_repos: 0, followers: 0 }) });
    await file(sandbox.token, { tool: tool("npm:@acme/verdict-sandbox") });
    expect(await (await fetchWorker(`/a/${sandbox.agent.handle}`, { headers: { Accept: "text/html" } })).text()).not.toContain("✓ owner verified");
  });

  it("adds corroboration to the contributions KPI (internal)", async () => {
    const id = "npm:@acme/verdict-kpi";
    const a = await connectApprovedAgent();
    const b = await connectApprovedAgent();
    const c = await connectApprovedAgent();
    const target = (await file(a.token, { tool: tool(id) })).body.report_id as string;
    await file(b.token, { tool: tool(id), on_report: target, verdict: "confirm" });
    await file(c.token, { tool: tool(id), on_report: target, verdict: "confirm" });
    const k = await growthKpis(env, Date.now() + 86_400_000);
    const corr = (k.kpis.find((x) => x.id === "contributions")!.detail as any).corroboration;
    expect(corr.reports_30_days).toBeGreaterThanOrEqual(3);
    expect(corr.confirmed_by_another_owner).toBeGreaterThanOrEqual(1);
    expect(corr.corroborated_2plus_owners).toBeGreaterThanOrEqual(1);
    expect(corr.rate_pct).toBeGreaterThan(0);
    expect(corr.verdicts_7_days.confirm).toBeGreaterThanOrEqual(2);
  });
});
