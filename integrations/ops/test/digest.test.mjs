import { describe, expect, it } from "vitest";
import { arenaLine, growthLine, releaseIssue, render } from "../digest.mjs";

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
  });
});
