import { describe, expect, it } from "vitest";
import { arenaLine, funnelLine, growthLine, releaseIssue, render } from "../digest.mjs";

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
    expect(body).toContain("CLI downloads on 2026-10-15: **31**.");
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
