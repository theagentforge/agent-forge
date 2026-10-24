import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { growthKpis, agentDaysSeries, PARTNERS_KV, CITATIONS_KV, DISTRIBUTION, kpiSnapshotValues, dataInventory, dataSnapshotValues, DATA_CONTROLS } from "../src/services/kpis";
import { recordCheck } from "../src/services/proof";
import { connectApprovedAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

// The growth KPIs (ADR 0039): exact, crawler-free, House-free.

const DAY = 86_400_000;
const host = new URL(env.PUBLIC_ORIGIN).host;
const mcp = (method: string, params: Record<string, unknown> = {}, ip = "203.0.113.9") =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: {
      Host: host,
      "CF-Connecting-IP": ip,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "kpi-test", version: "1" } } },
    }),
  });
const byId = (k: Awaited<ReturnType<typeof growthKpis>>, id: string) => k.kpis.find((x) => x.id === id)!;

describe("the north star: weekly active agent-days", () => {
  it("counts distinct agents per day over the last 7 full days, without House or people on the website", async () => {
    const now = Date.UTC(2027, 2, 15, 9);
    const d = (n: number) => now - n * DAY;
    // Yesterday: two agents (one of them twice), one House source, one person checking on the website.
    await recordCheck(env, "mcp", "198.51.100.1", { now: d(1) });
    await recordCheck(env, "mcp", "198.51.100.1", { now: d(1) });
    await recordCheck(env, "plugin", "198.51.100.2", { now: d(1) });
    await recordCheck(env, "mcp", "198.51.100.3", { now: d(1), house: true });
    await recordCheck(env, "web", "198.51.100.4", { now: d(1) });
    // Three days ago the same IP is a different one-day code, so it counts again (an agent-day, not a person).
    await recordCheck(env, "mcp", "198.51.100.1", { now: d(3) });
    // Eight days ago is in the previous week; today isn't counted until the day is over.
    await recordCheck(env, "api", "198.51.100.5", { now: d(8) });
    await recordCheck(env, "mcp", "198.51.100.6", { now });
    const series = await agentDaysSeries(env, now, 14);
    expect(series).toHaveLength(14);
    expect(series.at(-1)).toEqual({ day: "2027-03-14", agents: 2 });
    expect(series.at(-3)).toEqual({ day: "2027-03-12", agents: 1 });
    const k = await growthKpis(env, now);
    expect(k.as_of).toBe("2027-03-14");
    expect(byId(k, "north_star")).toMatchObject({ value: 3, status: "below", first: 500, second: 5000 });
    expect(byId(k, "north_star").detail).toMatchObject({ previous_7_days: 1, change_pct: 200 });
  });

  it("a scan, a watch check-in and a check over public MCP each make an agent active for the day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const count = async () => (await getDb(env).select().from(t.checkSources).where(eq(t.checkSources.day, today))).length;
    const before = await count();
    await (await mcp("tools/call", { name: "forge_scan", arguments: { text: "# A skill\nSays hello." } }, "192.0.2.31")).text();
    await (await mcp("tools/call", { name: "forge_watch", arguments: { fingerprints: [fp("e").slice(7)] } }, "192.0.2.32")).text();
    expect(await count()).toBe(before + 2);
  });
});

describe("the other KPIs", () => {
  it("counts verified agents and reports of people outside the project only, and retention from signed-in cohorts", async () => {
    const before = await growthKpis(env);
    const outside = await connectApprovedAgent(profile({ id: 777_001, login: "kpi-outsider" }));
    const tool = { tool: { kind: "mcp_server", id: "npm:kpi-tool", version: "1.0.0", fingerprint: fp("b") } };
    expect((await postReport(outside.token, report(tool))).status).toBe(201);
    const after = await growthKpis(env, Date.now() + DAY);
    expect(byId(after, "contributions").value).toBe(Number(byId(before, "contributions").value) + 1);
    expect(byId(after, "verified_agents").value).toBe(Number(byId(before, "verified_agents").value) + 1);
    // A founder's agent never counts.
    await connectApprovedAgent(profile({ id: Number(env.ADMIN_GITHUB_IDS), login: "founder" }));
    expect(byId(await growthKpis(env, Date.now() + DAY), "verified_agents").value).toBe(byId(after, "verified_agents").value);

    // Retention: this agent was created 30 days ago and checked (signed in, by agent id) 2 days ago.
    await getDb(env).update(t.agents).set({ createdAt: Date.now() - 30 * DAY }).where(eq(t.agents.id, outside.agent.id));
    await recordCheck(env, "mcp", outside.agent.id, { hashed: false, now: Date.now() - 2 * DAY });
    const r = byId(await growthKpis(env), "retention");
    expect(r.detail).toMatchObject({ active: 1 });
    expect(Number(r.value)).toBeGreaterThan(0);
  });

  it("lists distribution honestly, counts engaged partners by organisation, and snapshots only numbers", async () => {
    await env.KV.put(PARTNERS_KV, JSON.stringify([{ org: "Org A", stage: "contacted", date: "2026-11-01" }, { org: "Org A", stage: "replied", date: "2026-11-03" }, { org: "org a", stage: "met", date: "2026-11-09" }, { org: "Org B", stage: "researched", date: "2026-11-02" }]));
    await env.KV.put(CITATIONS_KV, JSON.stringify([{ url: "https://example.org/a", title: "A", date: "2026-11-01" }]));
    const k = await growthKpis(env);
    expect(byId(k, "partners").value).toBe(1);
    expect(byId(k, "citations").value).toBe(1);
    expect(byId(k, "distribution").value).toBe(DISTRIBUTION.filter((d) => d.status === "live").length);
    expect(byId(k, "company_readiness")).toMatchObject({ value: null, status: "untracked" });
    const snap = kpiSnapshotValues(k.kpis);
    expect(Object.keys(snap)).toContain("kpi_north_star");
    expect(Object.keys(snap)).not.toContain("kpi_company_readiness");
    expect(k.kpis).toHaveLength(12);
    await env.KV.delete(PARTNERS_KV);
    await env.KV.delete(CITATIONS_KV);
  });

  it("/admin/kpis and its forms are for signed-in admins only", async () => {
    const page = await fetchWorker("/admin/kpis", { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe("/dashboard");
    const add = await fetchWorker("/admin/kpis/partner", { method: "POST", redirect: "manual", headers: { Origin: env.PUBLIC_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "csrf=x&org=Org+A&stage=met" });
    expect(add.status).toBe(302);
    expect(await env.KV.get(PARTNERS_KV)).toBeNull();
  });
});

describe("the dataset inventory (ADR 0040)", () => {
  it("counts ranked runs, trap falls and calibration from the referee's results, leaving lab arms and practice out", async () => {
    const db = getDb(env);
    const before = await dataInventory(env);
    await db.insert(t.arenaEvents).values([
      { id: "inv-card", slug: "inv-card", name: "Inventory card", season: "s0", kind: "card", status: "done" },
      { id: "inv-lab", slug: "inv-lab", name: "Inventory lab arm", season: "s0", kind: "card", status: "done", arm: "card" },
      { id: "inv-practice", slug: "inv-practice", name: "Inventory practice", season: "s0", kind: "practice", status: "done" },
    ]);
    const run = (id: string, eventId: string, passed: boolean, fell: boolean) => ({
      id, eventId, modelId: `inv-model-${id.slice(-1)}`, task: "inv-task", seed: 1, attemptNo: 1, status: "done" as const, passed,
      result: { traps: [{ id: "x", triggered: fell }] }, finishedAt: Date.now(),
    });
    // Six ranked runs of one task: 3 pass, 3 fail, 2 of the fails with a trap sprung. 50% is inside the 3–97% band.
    await db.insert(t.arenaRuns).values([
      run("inv-a1", "inv-card", true, false), run("inv-a2", "inv-card", true, false), run("inv-a3", "inv-card", true, false),
      run("inv-b1", "inv-card", false, true), run("inv-b2", "inv-card", false, true), run("inv-b3", "inv-card", false, false),
      run("inv-c1", "inv-lab", false, true), run("inv-d1", "inv-practice", false, true),
    ]);
    const after = await dataInventory(env);
    expect(after.refereed_runs.total - before.refereed_runs.total).toBe(8);
    expect(after.refereed_runs.ranked - before.refereed_runs.ranked).toBe(6);
    expect(after.refereed_runs.with_trap_fall - before.refereed_runs.with_trap_fall).toBe(2);
    expect(after.calibration.per_task.find((x) => x.task === "inv-task")).toEqual({ task: "inv-task", n: 6, pass_rate: 50 });
    expect(after.environments).toMatchObject({ task_families: 6, job_versions: 18 });
    expect(after.controls).toEqual(DATA_CONTROLS);
    expect(Object.keys(dataSnapshotValues(after))).toContain("data_trap_falls");
  });
});
