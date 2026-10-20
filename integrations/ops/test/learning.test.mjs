import { describe, expect, it } from "vitest";
import { learning, learningSection, median, readings, sentPosts } from "../learning.mjs";
import { swapFromDigests } from "../../social/draft.mjs";

// Social strategy §9.9: the weekly learning report in Monday's Ops Digest, and the slot move the drafter reads.

const BOT = { login: "github-actions[bot]" };
const MON = Date.parse("2026-11-23T00:47:00Z");
const DAY = 86_400_000;

const issue = (number, type, body = "```post\nhello\n```") => ({ number, body, labels: [{ name: "post" }, ...(type ? [{ name: `type:${type}` }] : [])] });
const posted = (number, id, at, n = 1) => ({ user: BOT, issue_url: `https://api.github.com/repos/o/r/issues/${number}`, created_at: new Date(at).toISOString(), body: `Posted ${n} of 1: https://x.com/i/status/${id} <!-- forge-posted ${n} -->` });
const table = (rows) => ({ user: BOT, body: `X post metrics.\n\n| Post | Posted | Impressions | Likes | Reposts | Replies | Quotes | Bookmarks | Link clicks |\n|---|---|--:|--:|--:|--:|--:|--:|--:|\n${rows.map(([id, imp, likes = 0]) => `| [${id}](https://x.com/i/web/status/${id}) | 2026-11-01 | ${imp.toLocaleString("en-US")} | ${likes} | 0 | 0 | 0 | 0 | 1 |`).join("\n")}\n\n<!-- forge-metrics 2026-11-22 -->` });

describe("reading what was posted and how it did", () => {
  it("takes each post's latest reading, ignores other people's comments, and parses thousands", () => {
    const m = readings([table([["1", 100]]), table([["1", 1500, 30]]), { user: { login: "x" }, body: "| [1](u) | 2026-11-01 | 9 | 9 | 9 | 9 | 9 | 9 | 9 | <!-- forge-metrics -->" }]);
    expect(m.get("1")).toMatchObject({ impressions: 1500, engagements: 30, clicks: 1 });
  });

  it("types each main post from its label, skips link replies, and calls the rest hand-written", () => {
    const issues = [issue(1, "clip", "```post\na\n```\n```post reply\nhttps://theagentforge.io\n```"), issue(2, null)];
    const comments = [posted(1, "10", MON - DAY), posted(1, "11", MON - DAY, 2), posted(2, "20", MON - DAY)];
    expect(sentPosts(issues, comments).map((p) => [p.id, p.type])).toEqual([["10", "clip"], ["20", "hand-written"]]);
  });

  it("has a plain median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("the report", () => {
  // Three full weeks of posts: clips do well, skill-watch does badly every week.
  const posts = [];
  const metrics = new Map();
  let id = 0;
  for (let w = 1; w <= 3; w++)
    for (const [type, imp] of [["clip", 2000], ["clip", 1800], ["skill-watch", 100], ["skill-watch", 120], ["trap-of-the-day", 900], ["trap-of-the-day", 1000], ["bout-result", 50]]) {
      const at = MON - w * 7 * DAY + 2 * DAY;
      posts.push({ id: String(++id), type, at });
      metrics.set(String(id), { id: String(id), impressions: imp, engagements: imp / 50, clicks: 1 });
    }

  it("ranks types, flags the one under half the median for 3 weeks, and moves one slot to the best", () => {
    const r = learning({ posts, metrics, tags: [{ name: "x-clip", n: 7 }], now: MON });
    expect(r.rows[0]).toMatchObject({ type: "clip", posts: 6, median: 1900, clickIns: 7 });
    expect(r.rows[0].rate).toBeCloseTo(0.02);
    // bout-result is low too, but the bout cycle is never moved; it can still be flagged for a change of wording.
    expect(r.kill).toEqual(expect.arrayContaining(["skill-watch", "bout-result"]));
    expect(r.swap).toEqual({ from: "skill-watch", to: "clip" });
    expect(r.week).toBe("2026-11-23");
    const text = learningSection(r);
    expect(text).toContain("| clip | 6 | 1,900 | 2.0% | 6 | 7 |");
    expect(text).toContain('<!-- forge-mix {"week":"2026-11-23","from":"skill-watch","to":"clip"} -->');
  });

  it("moves nothing without enough measured posts", () => {
    const r = learning({ posts: posts.slice(0, 1), metrics, now: MON });
    expect(r.swap).toBeNull();
    expect(learningSection(r)).not.toContain("forge-mix");
    expect(learningSection({ rows: [], kill: [], swap: null })).toContain("no measured posts yet");
  });

  it("the drafter applies the move only in its week, from the newest digest", () => {
    const text = learningSection(learning({ posts, metrics, now: MON }));
    const digests = [{ created_at: "2026-11-16T00:50:00Z", body: '<!-- forge-mix {"week":"2026-11-16","from":"clip","to":"catch-card"} -->' }, { created_at: "2026-11-23T00:50:00Z", body: text }];
    expect(swapFromDigests(digests, "2026-11-23")).toBe("skill-watch,clip");
    expect(swapFromDigests(digests, "2026-11-29")).toBe("skill-watch,clip");
    expect(swapFromDigests(digests, "2026-11-30")).toBeNull();
    expect(swapFromDigests([], "2026-11-23")).toBeNull();
    expect(swapFromDigests({ message: "not a list" }, "2026-11-23")).toBeNull();
  });
});
