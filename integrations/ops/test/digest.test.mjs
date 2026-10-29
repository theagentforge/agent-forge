import { describe, expect, it } from "vitest";
import { arenaLine, funnelLine, growthLine, internalStats, ownerLines, releaseIssue, render } from "../digest.mjs";

describe("ops digest", () => {
  it("shows external and House numbers with the change since the day before", () => {
    const body = render(
      {
        now: { weekly_reporting_agents: { external: 12, house: 1 }, reports: { external: 40, house: 300 } },
        history: [
          { date: "2026-10-14", metric: "weekly_reporting_agents", externalValue: 9 },
          { date: "2026-10-15", metric: "weekly_reporting_agents", externalValue: 12 },
          { date: "2026-10-15", metric: "cli_npm_downloads", externalValue: 31 },
        ],
      },
      "2026-10-16",
    );
    expect(body).toContain("| Agents that reported this week (north star) | **12** (+3) | 1 |");
    expect(body).toContain("| Field reports | **40**  | 300 |");
    expect(body).not.toMatch(/CLI downloads/);
  });

  it("says 'under N' for numbers /stats keeps hidden below their minimum (ADR 0023 §3)", () => {
    const body = render({ now: { agents: { external: null, below_minimum: true, minimum: 10, house: 2 } }, history: [] }, "2026-10-17");
    expect(body).toContain("| Agents connected | under 10  | 2 |");
  });

  it("adds the Arena spend line and flags 80%", () => {
    const a = { spend: { month: 23.1, monthCap: 28.4, alert: true, practiceToday: 0.04 }, queue: { queued: 5, done: 90 } };
    expect(arenaLine(a)).toBe("Arena: **$23.10** of $28.40 this month ⚠️ over 80%. Practice today: $0.040. Runs queued 5, done 90, void 0.");
    expect(render({ now: {}, history: [] }, "2026-10-16", a)).toContain("Arena: **$23.10**");
    expect(arenaLine(null)).toBeNull();
  });

  it("lists new releases and opens a weekly arena issue on Mondays only", () => {
    const a = { spend: { month: 1, monthCap: 28.4, alert: false, practiceToday: 0 }, queue: {}, new_releases: [{ id: "openai/x", name: "X", in: 1, out: 4 }] };
    expect(arenaLine(a)).toContain("New models this week: X.");
    expect(releaseIssue(a, "2026-10-19")).toMatchObject({ title: "Arena: new models to consider (2026-10-19)", labels: ["arena"] });
    expect(releaseIssue(a, "2026-10-20")).toBeNull();
    expect(releaseIssue({ ...a, new_releases: [] }, "2026-10-19")).toBeNull();
  });

  it("shows the ADR 0011 growth signals", () => {
    const g = { claims: 3, claims_verified: 2, badge_sites_7d: 5 };
    expect(growthLine(g)).toBe("Growth signals: **3** tool claims (2 verified), Forge badges shown on **5** outside sites this week.");
    expect(render({ now: {}, history: [] }, "2026-10-16", null, g)).toContain("Growth signals");
    expect(growthLine({ ...g, trap_card_copies_7d: 4, trap_card_downloads_7d: 9 })).toContain("Trap card this week: **4** copies, **9** downloads.");
    expect(growthLine({ ...g, mcp_sessions_7d: 12, mcp_sessions_signed_in_7d: 3, mcp_tool_calls_7d: 40 })).toContain("AI connections this week: **12** (3 signed in), **40** tool calls.");
    expect(growthLine({ ...g, arrivals_7d: 30, arrivals_by_source_7d: [{ name: "x", n: 20 }, { name: "direct", n: 10 }], arrivals_by_tag_7d: [{ name: "x-launch", n: 5 }] })).toContain(
      "People arriving this week: **30** (x 20, direct 10); by link tag: x-launch 5.",
    );
    // Gross page views, crawlers included, come first (Dinike, 23 Oct).
    expect(growthLine({ ...g, page_views_7d: 25000, crawler_page_views_7d: 24500, arrivals_7d: 30, arrivals_by_source_7d: [] })).toContain(
      "Page views this week, crawlers included: **25000** (crawlers 24500). People arriving this week: **30**.",
    );
  });

  it("gives the agent funnel with exact numbers, yesterday and the share of each step", () => {
    const g = {
      agent_funnel_7d: {
        days: 7,
        stages: { found: 120, connected: 12, used: 30, returned: 2, contributed: 0 },
        rates: { connected: 10, used: 250, returned: 6.7, contributed: 0 },
        detail: { directory_health_checks: 4, house_mcp_sessions: 9 },
        signed_in_agents_all_time: 1,
      },
      agent_funnel_yesterday: { found: 20, connected: 1, used: 3, returned: 0, contributed: 0 },
    };
    const line = funnelLine(g);
    expect(line).toContain("found us **120** (yesterday 20)");
    expect(line).toContain("connected **12** (yesterday 1), 10% of the step before");
    expect(line).toContain("contributed **0**");
    expect(line).toContain("4 directory health checks, 9 House sessions");
    expect(render({ now: {}, history: [] }, "2026-10-21", null, g)).toContain("AI agents using the Forge, last 7 days");
    expect(funnelLine({})).toBeNull();
  });

  it("leads with tool calls from outside clients and keeps monitors and catalogs on their own line (ADR 0050)", () => {
    const g = {
      agent_funnel_7d: {
        days: 7,
        stages: { found: 1178, connected: 30, used: 40, returned: 2, contributed: 0 },
        rates: {},
        detail: { directory_health_checks: 663, monitor_sessions: 236, house_mcp_sessions: 50, outside_tool_calls: 35, monitors_and_catalogs: { clients: 60, sessions: 899, calls: 1 } },
        signed_in_agents_all_time: 1,
      },
      agent_funnel_yesterday: { found: 100, connected: 4, used: 6, returned: 0, contributed: 0 },
      outside_tool_calls_yesterday: 5,
    };
    const line = funnelLine(g);
    expect(line).toContain("Tool calls from outside clients: **35** (yesterday 5).");
    expect(line).toContain("Monitors and catalogs: 899 sessions, 1 calls (60 names), not counted as demand.");
    expect(line).toContain("Left out: 663 directory health checks, 236 monitor sessions, 50 House sessions.");
  });
});

describe("the growth KPIs in the digest (ADR 0039)", () => {
  it("leads with the north star and lists the rest against their targets", async () => {
    const { kpiLine, render } = await import("../digest.mjs");
    const k = {
      as_of: "2026-10-23",
      kpis: [
        { id: "north_star", name: "Weekly active agent-days (north star)", value: 120, unit: "agent-days in 7 days", first: 500, second: 5000, status: "below", detail: { change_pct: 25 } },
        { id: "retention", name: "4-week retention (signed-in agents)", value: null, unit: "%", first: 15, second: 25, status: "untracked" },
        { id: "distribution", name: "Live listings", value: 12, unit: "live", first: 12, second: 20, status: "first" },
      ],
    };
    const line = kpiLine(k);
    expect(line).toContain("**North star: 120 agent-days** in the 7 days to 2026-10-23 (+25% on the week before); targets 500 / 5,000.");
    expect(line).toContain("| Live listings | 12 live | 12 | 20 | first target met |");
    expect(line).toContain("| 4-week retention (signed-in agents) | – % | 15 | 25 | parked |");
    expect(kpiLine(null)).toBeNull();
    expect(render({ now: {}, history: [] }, "2026-10-24", null, null, null, null, null, k)).toContain("North star");
  });
});

// OA-11 (owner acquisition plan, ADR 0078): the owner funnel in the digest, from the private Scout snapshot.
describe("the owner lines (OA-11)", () => {
  const funnel = {
    day: "2026-11-03",
    new_owners_yesterday: { total: 3, by_source: { founding: 2, plugin: 1, connect: 0 } },
    active_owners_30d: { owners: 9, active: 5, connected_active: 4, web_only_active: 1 },
    connect_7d: {
      steps: [
        { id: "opened", label: "opened /connect", n: 40 },
        { id: "said_yes", label: "said yes, it flagged it", n: 12 },
        { id: "link_shown", label: "saw step 2 (link to you)", n: 10 },
        { id: "link_copied", label: "copied the link step", n: 4 },
      ],
      biggest_drop: "opened /connect → said yes, it flagged it (70% lost)",
      said_no: 3,
    },
    pending_claims: { claims: 2, people: 2 },
    reviews_waiting: 1,
  };

  it("shows the four lines: new owners by source, active owners, the biggest /connect drop, and what waits on Dinike", () => {
    expect(ownerLines(funnel)).toEqual([
      "**Owners, new on 2026-11-03 by source:** **3** (founding 2, plugin 1).",
      "**Active owners, last 30 days:** **5** of 9 owners (connected an app 4, web-only 1).",
      "**/connect, last 7 days, biggest drop:** opened /connect → said yes, it flagged it (70% lost). Steps: opened /connect 40 → said yes, it flagged it 12 → saw step 2 (link to you) 10 → copied the link step 4; said no 3.",
      "**Waiting on you:** 2 pending sandbox claims (2 people), 1 review requests at /admin/owners.",
    ]);
    const body = render({ now: {}, history: [] }, "2026-11-04", null, null, null, null, null, null, funnel);
    for (const l of ownerLines(funnel)) expect(body).toContain(l);
  });

  it("says not yet measured for counters never written, and never guesses a 0", () => {
    const lines = ownerLines({
      ...funnel,
      new_owners_yesterday: { total: null, by_source: {} },
      connect_7d: { steps: funnel.connect_7d.steps.map((s, i) => ({ ...s, n: i ? null : 7 })), biggest_drop: null, said_no: null },
    });
    expect(lines[0]).toBe("**Owners, new on 2026-11-03 by source:** not yet measured.");
    expect(lines[2]).toBe("**/connect, last 7 days, biggest drop:** not yet measured. Steps: opened /connect 7 → said yes, it flagged it not yet measured → saw step 2 (link to you) not yet measured → copied the link step not yet measured; said no not yet measured.");
    expect(ownerLines(null)[0]).toMatch(/not available today/);
    expect(ownerLines({ error: "boom" })[0]).toBe("**Owners:** not available today (boom).");
    // Older digests without the owner numbers render as before.
    expect(render({ now: {}, history: [] }, "2026-11-04")).not.toContain("Owners");
  });

  it("carries counts only: no names, logins or @handles in the owner lines", () => {
    const text = ownerLines({ ...funnel, names: ["@someone"], logins: ["octocat"] }).join("\n");
    expect(text).not.toMatch(/@[A-Za-z0-9]/);
    expect(text).not.toContain("octocat");
  });
});

// F-02 (ADR 0082, 0085): /stats and /api/v1/growth are gross only, so the digest reads the outside-only numbers from the
// OIDC-gated /api/v1/ops/internal-stats with its own workflow token, and says so when it can't.
describe("outside-only numbers through the internal endpoint", () => {
  const ORIGIN = "https://theagentforge.io";
  const ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token" };
  const DATA = { data_kind: "internal_stats", internal_only: true, stats_page: { now: { agents: { external: 14, house: 3 } }, history: [] }, growth: { claims: 1, claims_verified: 0, badge_sites_7d: 2, mcp_tool_calls_7d: 33 } };
  const fetcher = (status = 200, body = DATA) => {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, auth: init?.headers?.Authorization });
      if (url.startsWith("https://actions.example/token")) return new Response(JSON.stringify({ value: "jwt-1" }), { status: 200 });
      if (url === `${ORIGIN}/api/v1/ops/internal-stats`) return init?.headers?.Authorization === "Bearer jwt-1" ? new Response(JSON.stringify(body), { status }) : new Response("{}", { status: 401 });
      return new Response("{}", { status: 404 });
    };
    return { f, calls };
  };

  it("asks GitHub for a token for the site's audience and sends it to the internal endpoint only", async () => {
    const { f, calls } = fetcher();
    const r = await internalStats(ORIGIN, ENV, f);
    expect(r.data.stats_page.now.agents.external).toBe(14);
    expect(r.data.growth.mcp_tool_calls_7d).toBe(33);
    expect(calls[0]).toEqual({ url: `https://actions.example/token?x=1&audience=${encodeURIComponent(ORIGIN)}`, auth: "Bearer req-token" });
    expect(calls[1]).toEqual({ url: `${ORIGIN}/api/v1/ops/internal-stats`, auth: "Bearer jwt-1" });
    expect(calls).toHaveLength(2);
    // The digest table shows them, as before F-02.
    expect(render(r.data.stats_page, "2026-10-29", null, r.data.growth)).toContain("| Agents connected | **14**  | 3 |");
  });

  it("returns an error, never throws, without a token, on a refusal or on the wrong shape; the digest says so", async () => {
    expect((await internalStats(ORIGIN, {}, fetcher().f)).error).toMatch(/id-token: write/);
    expect((await internalStats(ORIGIN, ENV, fetcher(401).f)).error).toBe("internal stats: HTTP 401");
    expect((await internalStats(ORIGIN, ENV, fetcher(200, { growth: {} }).f)).error).toBe("internal stats: unexpected shape");
    expect((await internalStats(ORIGIN, ENV, async () => Promise.reject(new Error("network down")))).error).toBe("network down");
    const body = render({ now: null, history: null }, "2026-10-29", null, null, null, null, null, null, undefined, "internal stats: HTTP 401");
    expect(body).toContain("**Outside-only numbers:** not available today (internal stats: HTTP 401).");
    expect(render({ now: {}, history: [] }, "2026-10-29")).not.toContain("Outside-only numbers");
  });
});
