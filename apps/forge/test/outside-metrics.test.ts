import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import worker from "../src/index";
import { adoptionClaims, pageText } from "../src/services/adoption-wording";
import { getDb } from "../src/services/db";
import { COUNTER_GAPS, gapsIn, INSTALL_IDS_SINCE, outsideMetrics, publicMetricsOn, type OutsideMetrics } from "../src/services/outside-metrics";
import { bump } from "../src/services/usage";
import { outsideUseBlock, statsData } from "../src/web/stats";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";

// ADR 0126 (build list item 15): one outside-use block for /stats and /stats.json — outside tool calls (7 days and the
// 7 before), returning clients, verified owners — with our own traffic and likely bots left out, each number with its
// definition and window. Off unless PUBLIC_METRICS is "on" (Dinike's F-02 ruling, ADR 0082, keeps it private until then).

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const db = () => getDb(env);
const on = { ...env, PUBLIC_METRICS: "on" } as Env;
let seq = 0;
const uid = (p: string) => `${p}-om-${Date.now().toString(36)}-${++seq}`;
const FOUNDER = Number(env.ADMIN_GITHUB_IDS.split(",")[0]);
const item = (m: OutsideMetrics, key: string) => m.items.find((x) => x.key === key)!;

async function person(kind: "outside" | "house" | "founder", over: Partial<typeof t.humans.$inferInsert> = {}) {
  const humanId = uid("h");
  const githubId = kind === "founder" ? FOUNDER : 800_000_000 + seq * 7 + Math.floor(Math.random() * 1000);
  if (kind === "founder") {
    const [f] = await db().select().from(t.humans).where(eq(t.humans.githubId, FOUNDER));
    if (f) return { humanId: f.id, agentId: null };
  }
  await db().insert(t.humans).values({ id: humanId, githubId, githubLogin: uid("login"), githubCreatedAt: 0, tier: "verified", isHouse: kind === "house", ...over });
  const agentId = uid("a");
  await db().insert(t.agents).values({ id: agentId, humanId, handle: uid(`${kind}-agent`), framework: "claude-code", oauthClientId: uid("c") });
  return { humanId, agentId };
}

async function getPage(path: string, e: Env, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, { headers }) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("outside-use block (ADR 0126)", () => {
  it("is off by default: /stats and /stats.json stay gross-only (F-02)", async () => {
    expect(publicMetricsOn(env)).toBe(false);
    expect(publicMetricsOn({ PUBLIC_METRICS: "off" })).toBe(false);
    expect(publicMetricsOn({ PUBLIC_METRICS: " ON " })).toBe(true);
    const json = (await (await fetchWorker(`/stats.json?u=${uid("s")}`)).json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("outside_use");
    expect(json.house_excluded).toBe(false);
    const page = await (await fetchWorker(`/stats?u=${uid("s")}`)).text();
    expect(page).not.toContain('id="outside-use"');
    expect(page).toContain("Every number counts everything");
  });

  it("when on, /stats shows it under the disclosure and above the totals, and the JSON twin carries the same block", async () => {
    const page = await (await getPage(`/stats?u=${uid("s")}`, on)).text();
    expect(page).toContain('id="outside-use"');
    expect(page).toContain("Outside use (our own traffic and likely bots left out)");
    expect(page.indexOf('class="disclosure"')).toBeLessThan(page.indexOf('id="outside-use"'));
    expect(page.indexOf('id="outside-use"')).toBeLessThan(page.indexOf('id="blended"'));
    expect(page).toContain("Apart from the outside-use block, every number counts everything");
    for (const k of ["outside_tool_calls_7d", "returning_install_ids_28d", "returning_signed_in_agents_28d", "verified_owners"]) expect(page).toContain(`<tr data-k="${k}">`);
    // Small numbers are shown exactly: a 0 is a 0, never "none yet" or "below 10".
    expect(page).not.toMatch(/outside-use[\s\S]*below 10[\s\S]*id="blended"/);
    const json = (await (await getPage(`/stats.json?u=${uid("s")}`, on)).json()) as { outside_use: OutsideMetrics; house_excluded: boolean };
    expect(json.outside_use.house_excluded).toBe(true);
    expect(json.outside_use.items.map((x) => x.key)).toEqual(["outside_tool_calls_7d", "returning_install_ids_28d", "returning_signed_in_agents_28d", "verified_owners"]);
    // Each number carries its definition, its date range (or the moment it was counted) and what it leaves out.
    for (const x of json.outside_use.items) {
      expect(x.definition.length, x.key).toBeGreaterThan(40);
      expect(x.excludes.length, x.key).toBeGreaterThan(0);
      expect(x.window ?? x.as_of, x.key).toBeTruthy();
      expect(Number.isInteger(x.value), x.key).toBe(true);
    }
    // The returning-MCP-clients number can't be computed honestly; the block says so instead of approximating.
    expect(json.outside_use.not_measured.map((x) => x.key)).toEqual(["returning_mcp_clients"]);
  });

  it("outside tool calls: whole UTC days, our own and catalogue clients left out, with the 7 days before for the trend", async () => {
    const now = Date.now();
    const a = await outsideMetrics(env, now);
    const calls = item(a, "outside_tool_calls_7d");
    expect(calls.window).toEqual({ from: iso(now - 7 * DAY), to: iso(now - DAY), days: 7 });
    expect(calls.previous!.window).toEqual({ from: iso(now - 14 * DAY), to: iso(now - 8 * DAY), days: 7 });
    // Yesterday: 3 calls by an agent app and 2 by a directory health check (each also in mcp:public:calls), House and
    // tagged calls, 2 A2A requests. Today (partial): 9 calls, not in a whole-day window. Eight days ago: 1 A2A request.
    await bump(env, [...Array(5).fill("mcp:public:calls"), "mcp:clientcall:glama", "mcp:clientcall:glama", "mcp:clientcall:cursor", ...Array(4).fill("mcp:house:calls"), ...Array(6).fill("internal:scout:calls"), "a2a:requests", "a2a:requests"], now - DAY);
    await bump(env, Array(9).fill("mcp:public:calls"), now);
    await bump(env, ["a2a:requests"], now - 8 * DAY);
    const b = await outsideMetrics(env, now);
    expect(item(b, "outside_tool_calls_7d").value - calls.value).toBe(5);
    expect(item(b, "outside_tool_calls_7d").previous!.value - calls.previous!.value).toBe(1);
    for (const w of ["internal", "House", "directory, catalogue, checker or monitor"]) expect(calls.excludes.join(" "), w).toContain(w);
    expect(calls.limits.join(" ")).toMatch(/Claude connectors/);
  });

  it("names the 1–4 Nov lean-mode gap when a window covers it, and says since when data starts late", async () => {
    expect(COUNTER_GAPS[0]).toMatchObject({ from: "2026-11-01", to: "2026-11-04" });
    expect(gapsIn({ from: "2026-10-29", to: "2026-11-04" })).toHaveLength(1);
    expect(gapsIn({ from: "2026-11-04", to: "2026-11-10" })).toHaveLength(1);
    expect(gapsIn({ from: "2026-10-22", to: "2026-10-28" })).toEqual([]);
    expect(gapsIn({ from: "2026-11-05", to: "2026-11-11" })).toEqual([]);
    const m = await outsideMetrics(env, Date.parse("2026-11-05T12:00:00Z"));
    const calls = item(m, "outside_tool_calls_7d");
    expect(calls.window).toEqual({ from: "2026-10-29", to: "2026-11-04", days: 7 });
    expect(calls.gaps![0]).toMatch(/1 to 4 Nov 2026/);
    expect(calls.previous!.gaps).toBeUndefined();
    expect(item(m, "returning_install_ids_28d").since).toBe(INSTALL_IDS_SINCE);
    expect(item(m, "returning_install_ids_28d").gaps).toHaveLength(1);
    // The page says so next to the definition.
    expect(outsideUseBlock(m).toString()).toContain("<b>Gap:</b> Lean mode stopped");
    // A window wholly after the gap carries no note.
    const later = await outsideMetrics(env, Date.parse("2026-12-20T12:00:00Z"));
    expect(item(later, "outside_tool_calls_7d").gaps).toBeUndefined();
    expect(item(later, "outside_tool_calls_7d").previous!.gaps).toBeUndefined();
  });

  it("returning install IDs: outside IDs seen on two days inside the window; ours, one-day and older IDs left out", async () => {
    const now = Date.now();
    const before = item(await outsideMetrics(env, now), "returning_install_ids_28d").value;
    const row = (first: number, last: number, ours = false) => ({ idHash: uid("id").padEnd(32, "0").slice(0, 32), client: "cli", firstDay: iso(now - first * DAY), lastDay: iso(now - last * DAY), ours });
    await db().insert(t.installIds).values([row(5, 1), row(3, 0), row(5, 1, true), row(2, 2), row(40, 0)]);
    expect(item(await outsideMetrics(env, now), "returning_install_ids_28d").value - before).toBe(2);
  });

  it("returning signed-in agents: outside agents with checks on 2+ days; House, founders and one-day agents left out", async () => {
    const now = Date.now();
    const before = item(await outsideMetrics(env, now), "returning_signed_in_agents_28d").value;
    const out = await person("outside");
    const oneDay = await person("outside");
    const house = await person("house");
    const src = (source: string, d: number, isHouse = false) => ({ day: iso(now - d * DAY), source, kind: "mcp" as const, isHouse });
    await db().insert(t.checkSources).values([src(out.agentId!, 3), src(out.agentId!, 1), src(oneDay.agentId!, 2), src(house.agentId!, 4, true), src(house.agentId!, 2, true), src("anon-daily-code", 3), src("anon-daily-code", 2)]);
    expect(item(await outsideMetrics(env, now), "returning_signed_in_agents_28d").value - before).toBe(1);
  });

  it("verified owners: outside, verified, with an active agent; House, founders and sandbox people left out", async () => {
    const before = await outsideMetrics(env);
    await person("outside");
    await person("outside", { tier: "sandbox" });
    await person("house");
    await person("founder");
    const after = await outsideMetrics(env);
    expect(item(after, "verified_owners").value - item(before, "verified_owners").value).toBe(1);
    expect(item(after, "verified_owners").detail).toHaveProperty("active_30d");
    expect(item(after, "verified_owners").window).toBeNull();
    expect(item(after, "verified_owners").as_of).toBeTruthy();
  });

  it("reads as data: no steering wording and no adoption claim beside a number", async () => {
    const m = await outsideMetrics(env);
    const text = pageText(outsideUseBlock(m).toString());
    expect(AGENT_DIRECTED.exec(text)?.[0] ?? null).toBeNull();
    expect(adoptionClaims(text)).toEqual([]);
    expect(AGENT_DIRECTED.exec(JSON.stringify(m))?.[0] ?? null).toBeNull();
  });

  it("statsData carries it only when on; the admin JSON always has the preview and whether it is public", async () => {
    expect(await statsData(env)).not.toHaveProperty("outside_use");
    expect((await statsData(on)).outside_use?.items).toHaveLength(4);
    const f = await person("founder");
    const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, f.humanId)}`;
    const j = (await (await fetchWorker("/admin/stats/third-party.json", { headers: { Cookie: cookie } })).json()) as { public_metrics: { on: boolean; preview: OutsideMetrics } };
    expect(j.public_metrics.on).toBe(false);
    expect(j.public_metrics.preview.items).toHaveLength(4);
    const admin = await (await fetchWorker("/admin/kpis", { headers: { Cookie: cookie } })).text();
    expect(admin).toContain("(preview, not public)");
  });
});
