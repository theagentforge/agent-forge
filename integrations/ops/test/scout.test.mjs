import { describe, expect, it } from "vitest";
import { hasEvidence, scoutAlarms, scoutSection, scoutWeekly, topicOf } from "../scout.mjs";
import { render } from "../digest.mjs";

const now = Date.parse("2026-11-02T00:47:00Z"); // a Monday
const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();
const body = (topic, link = "https://theagentforge.io/stats") => `Topic: ${topic}\nRisk: risk:low\n\n## Problem\nx\n\n## Evidence\n<!-- links -->\n- ${link}\n\n## Change\ny\n`;
const issue = (number, h, extra = {}) => ({ number, created_at: hoursAgo(h), updated_at: hoursAgo(h), labels: [{ name: "proposal" }], state: "open", body: body(`topic-${number}`), ...extra });

describe("Forge Scout checks in the Ops Digest (ADR 0031)", () => {
  it("reads the topic and finds evidence links only in the Evidence or Why section", () => {
    expect(topicOf(body("scan-pastebin"))).toBe("scan-pastebin");
    expect(topicOf("no topic here")).toBeNull();
    expect(hasEvidence(body("a"))).toBe(true);
    expect(hasEvidence(body("a", "(none yet)"))).toBe(false);
    expect(hasEvidence("## Problem\nsee https://x.org\n\n## Evidence\n<!-- https://in-a-comment.org -->\n- \n")).toBe(false);
    expect(hasEvidence("## Why\n- https://github.com/cline/mcp-marketplace\n")).toBe(true);
  });

  it("raises no alarm before the routine's first brief, then alarms when a day is missed", () => {
    expect(scoutAlarms({ briefs: [], proposals: [], now })).toEqual([]);
    expect(scoutAlarms({ briefs: [{ number: 5, created_at: hoursAgo(23) }], now })).toEqual([]);
    expect(scoutAlarms({ briefs: [{ number: 5, created_at: hoursAgo(50) }], now })[0]).toMatch(/No Improvement Brief in the last 26 hours \(last one #5\)/);
  });

  it("flags too many proposals, missing evidence, missing topics and repeats within 30 days", () => {
    const proposals = [
      issue(1, 2),
      issue(2, 3, { body: body("topic-2", "nothing") }),
      issue(3, 4, { body: "## Evidence\n- https://a.org\n" }),
      issue(4, 5, { body: body("topic-old") }),
      issue(9, 24 * 20, { body: body("topic-old") }),
      issue(10, 24 * 40, { body: body("topic-1") }),
    ];
    const alarms = scoutAlarms({ briefs: [{ number: 1, created_at: hoursAgo(1) }], proposals, now });
    expect(alarms).toContain("4 proposals in a day (limit 3): #1, #2, #3, #4.");
    expect(alarms).toContain("Proposal without evidence links: #2.");
    expect(alarms).toContain("Proposal #3 has no Topic line, so repeats can't be caught.");
    expect(alarms).toContain('Topic "topic-old" re-proposed within 30 days: #4 repeats #9.');
    expect(alarms.join(" ")).not.toContain("topic-1"); // 40 days apart is fine
  });

  it("limits Agent Reach issues to 2 a day and ignores pull requests", () => {
    const reach = (n) => issue(n, 1, { labels: [{ name: "agent-reach" }] });
    expect(scoutAlarms({ proposals: [reach(1), reach(2), reach(3)], now })).toContain("3 Agent Reach issues in a day (limit 2): #1, #2, #3.");
    expect(scoutAlarms({ proposals: [issue(7, 1, { pull_request: {}, body: "" })], now })).toEqual([]);
  });

  it("gives the weekly numbers on Mondays: made, approved, shipped, closed, and verdicts", () => {
    const proposals = [
      issue(1, 24 * 2),
      issue(2, 24 * 3, { labels: [{ name: "proposal" }, { name: "approved" }] }),
      issue(3, 24 * 20, { labels: [{ name: "proposal" }, { name: "shipped" }, { name: "verdict:helped" }], state: "closed", closed_at: hoursAgo(24 * 2) }),
      issue(4, 24 * 6, { state: "closed", closed_at: hoursAgo(24) }),
    ];
    expect(scoutWeekly({ proposals, now })).toBe(
      "Forge Scout this week: **3** proposals made, 1 approved, 1 shipped, 1 closed without building. Shipped **1 of 4** proposed in the last 30 days. Verdicts on shipped proposals (last 30 days): helped 1, hurt 0, inconclusive 0.",
    );
    const section = scoutSection({ briefs: [{ number: 8, created_at: hoursAgo(30) }], proposals, now });
    expect(section).toMatch(/^Forge Scout this week/);
    expect(section).toContain("⚠️ Scout: No Improvement Brief");
    expect(scoutSection({ proposals, now: now + 86_400_000 })).toBeNull(); // Tuesday, nothing wrong
    expect(render({ now: {}, history: [] }, "2026-11-02", null, null, null, null, section)).toContain("⚠️ Scout: No Improvement Brief");
  });
});
