import { TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GAUNTLET_DAILY_PER_SOURCE, GAUNTLET_KEEP_LOGS_MS, GAUNTLET_TIME_LIMIT_MS, gauntletAct, startGauntlet, sweepGauntletLogs, tailoredCard } from "../src/arena/gauntlet";
import * as t from "../src/db/schema";
import { GAUNTLET_TOOLS, PUBLIC_TOOLS } from "../src/mcp-public";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";
import { eq } from "drizzle-orm";

// ADR 0024: the Gauntlet. Six everyday jobs for any agent with no account, a report card, a trap card made from what
// it fell for, and a measured re-run with that card.

const host = new URL(env.PUBLIC_ORIGIN).host;
const publicRpc = (method: string, params: unknown = {}, ip = "203.0.113.10") =>
  fetchWorker("/mcp/gauntlet", {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function result(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}
const call = async (name: string, args: unknown, ip?: string) => (await result(await publicRpc("tools/call", { name, arguments: args }, ip))).result.structuredContent;
const page = async (path: string) => fetchWorker(path, { headers: { Accept: "text/html" } });

/** Plays every job by giving up at once: honest on the impossible job, not passed on the others. */
async function giveUpAll(id: string, ip?: string) {
  let last: any;
  for (let i = 0; i < TASKS.length; i++) last = await call("gauntlet_act", { gauntlet_id: id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }, ip);
  return last;
}

describe("the Gauntlet over its own anonymous MCP endpoint (no account)", () => {
  it("lists its tools, starts without trap names, plays six jobs and ends with a report and a tailored card", async () => {
    const listed = await result(await publicRpc("tools/list"));
    expect(listed.result.tools.map((x: { name: string }) => x.name).sort()).toEqual(["gauntlet_act", "gauntlet_start", "gauntlet_status"]);

    const start = await call("gauntlet_start", {});
    expect(start.gauntlet_id).toMatch(/^g[0-9a-f]{32}$/);
    expect(start.jobs).toEqual(TASKS.map((x) => x.id));
    expect(start.current).toMatchObject({ job: 1, of: 6, task: TASKS[0]!.id });
    expect(start.current.tools.map((x: { name: string }) => x.name)).toContain("finish");
    // Fairness (ADR 0024 §6): like the headline models, the agent is never told the traps.
    const text = JSON.stringify(start);
    for (const trap of TASKS[0]!.traps) expect(text).not.toContain(trap.label);
    expect(text).not.toContain("traps_named_in_advance");

    const look = await call("gauntlet_act", { gauntlet_id: start.gauntlet_id, tool: start.current.tools[0].name, args: {} });
    expect(look).toHaveProperty("tool_calls_left");
    const status = await call("gauntlet_status", { gauntlet_id: start.gauntlet_id });
    expect(status).toMatchObject({ status: "open", current: { job: 1 } });

    const first = await call("gauntlet_act", { gauntlet_id: start.gauntlet_id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping." } });
    expect(first.job_verdict).toHaveProperty("passed");
    expect(first.next).toMatchObject({ job: 2, task: TASKS[1]!.id });

    let end: any;
    for (let i = 1; i < TASKS.length; i++) end = await call("gauntlet_act", { gauntlet_id: start.gauntlet_id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping." } });
    expect(end.report).toMatchObject({ jobs_total: 6, report_url: `/gauntlet/r/${start.gauntlet_id}`, measured_rerun_of: null });
    // A shareable link and a factual one-line summary (data only).
    expect(end.report.share.url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/r/${start.gauntlet_id}`);
    expect(end.report.share.summary).toMatch(/^Forge Gauntlet, \d{4}-\d{2}-\d{2}: passed \d of 6 everyday jobs; fell for \d+ of \d+ planted traps\.$/);
    expect(end.report.passed).toBeGreaterThanOrEqual(1); // the impossible job: an honest "can't be done" passes
    expect(end.report.trap_card).toContain("tailored from Gauntlet run");

    const over = await call("gauntlet_act", { gauntlet_id: start.gauntlet_id, tool: "finish", args: {} });
    expect(over.error).toBe("gauntlet_over");

    const report = await page(`/gauntlet/r/${start.gauntlet_id}`);
    expect(report.status).toBe(200);
    const body = await report.text();
    expect(body).toContain("of 6 jobs right");
    expect(body).toContain("Your agent's trap card");
    expect(body).toContain(`card_from &quot;${start.gauntlet_id}&quot;`);
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect((await page(`/gauntlet/r/${start.gauntlet_id}/6`)).status).toBe(200);
    expect((await page(`/gauntlet/r/${start.gauntlet_id}/7`)).status).toBe(404);
    expect((await page(`/gauntlet/r/g${"0".repeat(32)}`)).status).toBe(404);
  });

  it("a measured re-run puts the card in every brief, and the first run's page shows before and after", async () => {
    const base = await call("gauntlet_start", {}, "203.0.113.20");
    const unfinished = await call("gauntlet_start", { card_from: base.gauntlet_id }, "203.0.113.20");
    expect(unfinished.error).toBe("run_not_finished");
    const done = await giveUpAll(base.gauntlet_id, "203.0.113.20");

    const rerun = await call("gauntlet_start", { card_from: base.gauntlet_id }, "203.0.113.20");
    expect(rerun.measured_rerun_of).toBe(base.gauntlet_id);
    expect(rerun.current.brief).toMatch(/^Your owner's standing instructions:\n/);
    expect(rerun.current.brief).toContain(done.report.trap_card);
    const end = await giveUpAll(rerun.gauntlet_id, "203.0.113.20");
    expect(end.report).toMatchObject({ measured_rerun_of: base.gauntlet_id, trap_card: null });

    // A re-run of a re-run isn't allowed: measure against the first run only.
    expect((await call("gauntlet_start", { card_from: rerun.gauntlet_id }, "203.0.113.20")).error).toBe("unknown_run");

    const body = await (await page(`/gauntlet/r/${base.gauntlet_id}`)).text();
    expect(body).toContain("before and after the trap card");
    expect(body).toContain(`/gauntlet/r/${rerun.gauntlet_id}`);
    expect(await (await page(`/gauntlet/r/${rerun.gauntlet_id}`)).text()).toContain("measured re-run with the trap card");
  });
});

describe("the Gauntlet over HTTP", () => {
  it("start, act, status and validation", async () => {
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.30" };
    const res = await fetchWorker("/api/v1/gauntlet", { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(201);
    const s = (await res.json()) as { gauntlet_id: string; current: { tools: { name: string }[] } };
    const act = await fetchWorker(`/api/v1/gauntlet/${s.gauntlet_id}/act`, { method: "POST", headers, body: JSON.stringify({ tool: s.current.tools[0]!.name, args: {} }) });
    expect(act.status).toBe(200);
    expect((await fetchWorker(`/api/v1/gauntlet/${s.gauntlet_id}`)).status).toBe(200);
    expect((await fetchWorker(`/api/v1/gauntlet/${s.gauntlet_id}/act`, { method: "POST", headers, body: JSON.stringify({ args: {} }) })).status).toBe(400);
    expect((await fetchWorker("/api/v1/gauntlet/nope/act", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await fetchWorker("/api/v1/gauntlet", { method: "POST", headers, body: JSON.stringify({ card_from: "x" }) })).status).toBe(400);
  });
});

describe("Gauntlet limits and retention", () => {
  it("ends at the time limit, with jobs never reached counted as not passed", async () => {
    const now = Date.now();
    const s = (await startGauntlet(env, "203.0.113.40", {}, now)) as { gauntlet_id: string };
    const r = (await gauntletAct(env, s.gauntlet_id, "finish", {}, now + GAUNTLET_TIME_LIMIT_MS + 1)) as { error: string; report: { passed: number; jobs_total: number } };
    expect(r.error).toBe("gauntlet_over");
    expect(r.report).toMatchObject({ passed: 0, jobs_total: 6 });
  });

  it("caps starts per visitor per day without storing the IP", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < GAUNTLET_DAILY_PER_SOURCE; i++) expect(await startGauntlet(env, ip)).toHaveProperty("gauntlet_id");
    expect(await startGauntlet(env, ip)).toMatchObject({ error: "daily_limit" });
    const keys = (await env.KV.list({ prefix: "gauntlet-src:" })).keys.map((k) => k.name);
    expect(keys.join(" ")).not.toContain(ip);
  });

  it("deletes tool calls and logs after 30 days and keeps the summary", async () => {
    const now = Date.now();
    const s = (await startGauntlet(env, "203.0.113.60", {}, now - GAUNTLET_KEEP_LOGS_MS - 86_400_000)) as { gauntlet_id: string };
    await gauntletAct(env, s.gauntlet_id, "finish", { status: "cannot_complete", summary: "x" }, now - GAUNTLET_KEEP_LOGS_MS - 86_400_000);
    expect((await sweepGauntletLogs(env, now)).cleared).toBeGreaterThanOrEqual(1);
    const bouts = await getDb(env).select().from(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, s.gauntlet_id));
    expect(bouts.find((b) => b.idx === 0)).toMatchObject({ calls: [], log: null, status: "done" });
    expect(bouts.find((b) => b.idx === 0)!.result).not.toBeNull();
  });
});

describe("the Gauntlet's tool definitions", () => {
  it("are pinned, and /mcp/public stays read-only as submitted to the Claude directory", async () => {
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(GAUNTLET_TOOLS))))].map((b) => b.toString(16).padStart(2, "0")).join("");
    // Changing what an agent reads about a tool is deliberate: update this hash in the same change, with a reason.
    // 20 Oct 2026: descriptions rewritten as "Use this when… Give… Returns…" (docs/launch/agent-channels.md §4.1).
    // 24 Oct 2026: gauntlet_start takes `challenge` (V2, ADR 0047): play the identical jobs of a finished run.
    expect(digest).toBe("d9f55dc0c88e9b9dc2e29fad813dd3db0d70e4ecd84d2f24272cdc93b968258e");
    expect(Object.keys(PUBLIC_TOOLS)).not.toContain("gauntlet_start");
  });
});

describe("the tailored trap card", () => {
  it("puts the checks for traps it fell for first, in the public card's own words", () => {
    const card = tailoredCard(["refund/over_refund"], `g${"a".repeat(32)}`);
    const lines = card.split("\n");
    expect(lines[1]).toBe("Most important (it slipped on these):");
    expect(lines[2]).toContain("exact amount needed");
    expect(card).toContain("Also:");
    expect(tailoredCard([], `g${"a".repeat(32)}`)).not.toContain("Most important");
  });
});
