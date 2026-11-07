import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { claudeByokIds } from "../src/arena/credit";
import * as t from "../src/db/schema";
import { BOT_EXCLUDED, BOT_RULE, BROWSER_ANCHORS } from "../src/services/bots";
import { COST_PER_BOUT_METHOD, costPerBout } from "../src/services/costs";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { BOT_FILTERED_KPIS, botFilterNotes, growthKpis } from "../src/services/kpis";
import { visitCounters } from "../src/services/usage";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, profile } from "./helpers";
import "../src/index";

// Diligence review, 7 Nov 2026 (internal items 4 and 5): a dated definition of "likely bot" with the excluded count
// beside each filtered KPI, and the full cost per refereed bout with Anthropic-billed Claude bouts included.

const O = env.PUBLIC_ORIGIN;
async function adminCookie(login: string) {
  const db = getDb(env);
  const founder = profile({ id: Number(env.ADMIN_GITHUB_IDS.split(",")[0]), login });
  const h = (await db.query.humans.findFirst({ where: eq(t.humans.githubId, founder.id) })) ?? (await upsertHuman(db, founder, Date.now()));
  return `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, h.id)}`;
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("the bot filter: a dated definition and the excluded counts", () => {
  it("the definition is versioned and dated, matches the code's anchors, and states the change rule", () => {
    expect(BOT_RULE).toMatchObject({ version: "likely-bot/v1", in_force_since: "2026-11-04", written: "2026-11-07" });
    expect(BOT_RULE.page.join(" ")).toContain(`Chrome ${BROWSER_ANCHORS.chrome.major} on 3 Nov 2026, Firefox ${BROWSER_ANCHORS.firefox.major} on 20 Oct 2026`);
    expect(BOT_RULE.page.join(" ")).toContain("Sec-Fetch-Mode");
    expect(BOT_RULE.change_rule).toMatch(/for 28 days from the change, each filtered KPI is shown under both the old and the new rule/);
  });

  it("a bot's tagged arrival is counted as excluded, a person's isn't", () => {
    const req = (ua: string, extra: Record<string, string> = {}) => ({ method: "GET", url: `${O}/arena?from=x`, headers: new Headers({ "user-agent": ua, referer: "https://x.com/", ...extra }) });
    expect(visitCounters(req("curl/8.0"), O)).toEqual(["visit:all", "visit:crawler", BOT_EXCLUDED.tagged_arrival]);
    const person = visitCounters(req("Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/150.0", { "sec-fetch-mode": "navigate" }), O);
    expect(person).toContain("visit:tag:x");
    expect(person).not.toContain(BOT_EXCLUDED.tagged_arrival);
    // Untagged bot page views stay in visit:crawler only.
    expect(visitCounters({ ...req("curl/8.0"), url: `${O}/arena` }, O)).toEqual(["visit:all", "visit:crawler"]);
  });

  it("a REST check by a bot bumps the excluded counter", async () => {
    const before = (await getDb(env).select().from(t.usageDaily).where(eq(t.usageDaily.key, BOT_EXCLUDED.api_check))).reduce((a, r) => a + r.n, 0);
    const res = await fetchWorker("/api/v1/check?id=npm:zz-bot-check-x", { headers: { "User-Agent": "Mozilla/5.0 (compatible; AhrefsBot/7.0)", "CF-Connecting-IP": "198.51.100.231" } });
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 50));
    const after = (await getDb(env).select().from(t.usageDaily).where(eq(t.usageDaily.key, BOT_EXCLUDED.api_check))).reduce((a, r) => a + r.n, 0);
    expect(after).toBe(before + 1);
  });

  it("each filtered KPI carries its excluded count: 'not measured' before the counter's first day, then the 7-day sum", async () => {
    const db = getDb(env);
    await db.delete(t.usageDaily).where(eq(t.usageDaily.key, BOT_EXCLUDED.tagged_arrival));
    const now = Date.UTC(2031, 0, 20, 12);
    expect((await botFilterNotes(env, now)).virality).toMatchObject({ excluded: null, counted_since: null, rule: "likely-bot/v1" });
    await db.insert(t.usageDaily).values([{ day: day(now - 3 * 86_400_000), key: BOT_EXCLUDED.tagged_arrival, n: 4 }, { day: day(now - 1 * 86_400_000), key: BOT_EXCLUDED.tagged_arrival, n: 3 }]);
    expect((await botFilterNotes(env, now)).virality).toMatchObject({ excluded: 7, counted_since: day(now - 3 * 86_400_000), unit: "tagged arrivals by likely bots" });
    expect(Object.keys(BOT_FILTERED_KPIS).sort()).toEqual(["checks", "north_star", "virality"]);
    const { kpis } = await growthKpis(env, now);
    for (const id of Object.keys(BOT_FILTERED_KPIS)) expect(kpis.find((k) => k.id === id)?.bot_filter, id).toBeDefined();
    expect(kpis.find((k) => k.id === "contributions")?.bot_filter).toBeUndefined();
  });

  it("/admin/kpis shows the count beside each filtered KPI and the dated definition; the data room has the definition", async () => {
    const cookie = await adminCookie("founder-diligence");
    const page = (await (await fetchWorker("/admin/kpis", { headers: { Cookie: cookie } })).text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    expect(page.match(/Left out by the bot filter \(likely-bot\/v1\)/g)?.length).toBe(3);
    expect(page).toContain('"Likely bot": the definition (likely-bot/v1, in force since 2026-11-04; written 2026-11-07)');
    expect(page).toContain("If the rule changes:");
    const room = await fetchWorker("/admin/data-room", { headers: { Cookie: cookie } });
    if (room.status === 200) {
      const text = (await room.text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      expect(text).toContain('"Likely bot" (likely-bot/v1, in force since 2026-11-04; written 2026-11-07)');
      expect(text).toContain("Full cost per refereed bout");
    } else await room.body?.cancel();
  });
});

describe("full cost per refereed bout", () => {
  it("adds OpenRouter credit, Anthropic BYOK and the Workers AI estimate; void bouts out; unpriced Claude bouts flagged", async () => {
    const db = getDb(env);
    const ev = { id: "ev-cpb", slug: "cpb-test", name: "Cost per bout", season: "test", kind: "practice", status: "running", createdAt: Date.now() };
    await db.insert(t.arenaEvents).values(ev as never).onConflictDoNothing();
    const at = Date.UTC(2030, 0, 10);
    const claude = claudeByokIds()[0]!;
    const run = (id: string, o: Record<string, unknown>) => ({ id, eventId: ev.id, modelId: "gpt-6.1-sol", task: "x", seed: 1, attemptNo: 1, status: "done", tokens: 1, finishedAt: at, ...o });
    await db.insert(t.arenaRuns).values([
      run("cpb-claude", { modelId: claude, cost: 0.31, byokCost: 0.3 }),
      run("cpb-claude-unpriced", { modelId: claude, cost: 0, byokCost: 0 }),
      run("cpb-openrouter", { cost: 0.05 }),
      run("cpb-wai", { modelId: "llama-practice", cost: 0.002, costEstimated: true }),
      run("cpb-void", { status: "void", cost: 1 }),
      run("cpb-before", { cost: 9, finishedAt: at - 30 * 86_400_000 }),
    ] as never);
    const r = await costPerBout(env, Date.UTC(2030, 0, 1), Date.UTC(2030, 0, 31));
    expect(r).toMatchObject({ window: { from: "2030-01-01", to: "2030-01-31" }, bouts: 4, full_usd: 0.362, claude_bouts: 2, claude_bouts_without_anthropic_cost: 1, bouts_without_cost: 0 });
    expect(r.split).toEqual({ openrouter_credit_usd: 0.06, anthropic_byok_usd: 0.3, workers_ai_estimate_usd: 0.002 });
    expect(r.per_bout_usd).toBe(0.0905);
    expect(r.paid_per_bout_usd).toBe(0.09);
    expect(COST_PER_BOUT_METHOD).toMatch(/OpenRouter credit \(cost - byok_cost\) \+ Anthropic billed through BYOK \(byok_cost\)/);
    expect((await costPerBout(env, Date.UTC(2032, 0, 1), Date.UTC(2032, 0, 2))).per_bout_usd).toBeNull();
  });

  it("/admin/costs shows it, dated, with the method; the JSON carries it", async () => {
    const cookie = await adminCookie("founder-cpb");
    const page = await (await fetchWorker("/admin/costs", { headers: { Cookie: cookie } })).text();
    expect(page).toContain('<h2 id="cost-per-bout">Full cost per refereed bout</h2>');
    expect(page).toContain("Refereed bouts = arena_runs with status done");
    expect(page).toContain('data-cpb="All time"');
    const j = (await (await fetchWorker("/admin/costs?format=json", { headers: { Cookie: cookie } })).json()) as { cost_per_bout: { as_of: string; method: string; all_time: { bouts: number } } };
    expect(j.cost_per_bout.method).toBe(COST_PER_BOUT_METHOD);
    expect(Number.isFinite(Date.parse(j.cost_per_bout.as_of))).toBe(true);
  });
});
