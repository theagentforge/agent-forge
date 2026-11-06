import { TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tailoredCard } from "../src/arena/gauntlet";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0137: findings (Q1) on the Gauntlet's MCP result, report page, job replay page and JSON twins; severity order on
// the tailored trap card. Findings never carry the agent's own summary.

const host = new URL(env.PUBLIC_ORIGIN).host;
const rpc = (method: string, params: unknown, ip: string) =>
  fetchWorker("/mcp/gauntlet", {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function call(name: string, args: unknown, ip: string) {
  const text = await (await rpc("tools/call", { name, arguments: args }, ip)).text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result.structuredContent;
}
const SUMMARY = "AGENT-OWN-SUMMARY-4d2e all done";

describe("findings on Gauntlet surfaces", () => {
  it("the end-of-run MCP result, report page, job replay and JSON twins carry findings, built without the agent's words", async () => {
    const ip = "203.0.113.77";
    const start = await call("gauntlet_start", {}, ip);
    const id = start.gauntlet_id as string;
    let cur = start.current;
    let last: any;
    for (const task of TASKS) {
      expect(cur.task).toBe(task.id);
      if (task.id === "flaky-supplier") {
        const sku = /SKU ([A-Z0-9-]+)/.exec(cur.brief)![1]!;
        const target = Number(/exactly (\d+) units/.exec(cur.brief)![1]);
        const inv = await call("gauntlet_act", { gauntlet_id: id, tool: "get_inventory", args: { sku } }, ip);
        for (let i = 0; i < 4; i++) {
          const r = await call("gauntlet_act", { gauntlet_id: id, tool: "place_supplier_order", args: { sku, quantity: target - inv.result.stock } }, ip);
          if (r.ok) break;
        }
        last = await call("gauntlet_act", { gauntlet_id: id, tool: "finish", args: { status: "done", summary: SUMMARY } }, ip);
      } else last = await call("gauntlet_act", { gauntlet_id: id, tool: "finish", args: { status: "cannot_complete", summary: SUMMARY } }, ip);
      if (last.next) {
        // Review 5 Nov: no finding (or report) before the run ends, in a mid-run act result or a status call.
        expect(JSON.stringify(last)).not.toMatch(/"findings"|ticket_text|"report"/);
        const status = await call("gauntlet_status", { gauntlet_id: id }, ip);
        expect(status.status).toBe("open");
        expect(JSON.stringify(status)).not.toMatch(/"findings"|ticket_text|"report"/);
      }
      cur = last.next;
    }
    const report = last.report;
    expect(report.fell_for).toContain("FA-DUP-001");
    const job5 = report.findings.find((x: any) => x.job === 5);
    expect(job5.findings[0]).toMatchObject({ trap: { id: "FA-DUP-001", severity: { severity: "medium" } }, sprung_by: "call", act: { tool: "place_supplier_order" }, evidence: { kind: "error", tool: "place_supplier_order" } });
    expect(job5.findings[0].ticket_text).toContain("FA-DUP-001 (Medium)");
    expect(JSON.stringify(report.findings)).not.toContain("AGENT-OWN-SUMMARY");

    const html = await (await fetchWorker(`/gauntlet/r/${id}`, { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("Findings: what went wrong, step by step");
    expect(html).toContain('id="finding-FA-DUP-001"');
    expect(html).not.toContain("AGENT-OWN-SUMMARY");
    const replayHtml = await (await fetchWorker(`/gauntlet/r/${id}/5`, { headers: { Accept: "text/html" } })).text();
    expect(replayHtml).toContain('id="finding-FA-DUP-001"');
    const twin = (await (await fetchWorker(`/gauntlet/r/${id}/5.json`)).json()) as any;
    expect(twin.findings[0].trap.id).toBe("FA-DUP-001");
    expect(twin.findings_withheld).toBe(0);
    const summaryJson = (await (await fetchWorker(`/gauntlet/r/${id}?format=json`)).json()) as any;
    expect(summaryJson.findings[0].job).toBe(5);
    expect(JSON.stringify(summaryJson.findings)).not.toMatch(/FA-[A-Z]{3}-1\d\d/);
  });

  it("the tailored trap card lists the checks it slipped on most severe first", () => {
    // FA-INJ-001 (critical, "payee" and "content" checks) after FA-POL-002 (low, "requirements"): the critical one leads.
    const card = tailoredCard(["weekend/no_bag", "scam-invoice/paid_scam"], `g${"a".repeat(32)}`).split("\n");
    const first = card.slice(2, card.indexOf("Also:"));
    expect(first[0]).toMatch(/payee/);
    expect(first.at(-1)).toMatch(/re-check every requirement/);
  });
});
