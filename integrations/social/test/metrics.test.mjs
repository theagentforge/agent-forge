import { describe, expect, it } from "vitest";
import { approve, fetchMetrics, metrics, metricsComment, metricsDue, postedFromComments } from "../post-to-x.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-17T06:20:00Z");
const BOT = { login: "github-actions[bot]" };
const ago = (days) => new Date(NOW - days * DAY - 3_600_000).toISOString();
const issueUrl = (n) => `https://api.github.com/repos/o/r/issues/${n}`;
const posted = (issue, n, id, days, user = BOT) => ({ user, issue_url: issueUrl(issue), created_at: ago(days), body: `Posted ${n} of 2: https://x.com/i/web/status/${id} <!-- forge-posted ${n} -->` });
const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d" };

const tweet = (id, extra = {}) => ({
  id,
  created_at: "2026-10-16T13:05:00.000Z",
  public_metrics: { retweet_count: 2, reply_count: 1, like_count: 1234, quote_count: 0, bookmark_count: 5, impression_count: 900 },
  ...extra,
});

/** A fake GitHub (post issues, repo comments, the tracking issue) and X tweets lookup. */
function world({ comments = [], postIssues = [1, 2], tracking = null, refusePrivate = false, spentMark = null } = {}) {
  const state = { comments: [...comments], created: [], tracking, reads: [], xCalls: 0 };
  if (spentMark) state.comments.push({ user: BOT, issue_url: issueUrl(99), created_at: ago(0), body: `<!-- forge-cost ${spentMark} -->` });
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.host === "api.x.com") {
      state.xCalls++;
      const fields = u.searchParams.get("tweet.fields");
      const ids = u.searchParams.get("ids").split(",");
      expect(init.headers.Authorization).toMatch(/^OAuth /);
      if (refusePrivate && fields.includes("non_public_metrics")) return Response.json({ title: "Unauthorized" }, { status: 403 });
      state.reads.push({ ids, fields });
      return Response.json({
        data: ids.map((id) => tweet(id, fields.includes("non_public_metrics") ? { non_public_metrics: { impression_count: 1500, url_link_clicks: 12, user_profile_clicks: 3 } } : {})),
      });
    }
    const p = u.pathname.replace("/repos/o/r", "");
    const json = init.body ? JSON.parse(init.body) : null;
    if (method === "GET" && p === "/issues" && u.searchParams.get("labels") === "post") return Response.json(postIssues.map((number) => ({ number })));
    if (method === "GET" && p === "/issues" && u.searchParams.get("labels") === "metrics") return Response.json(state.tracking ? [{ number: 50, title: "X post metrics" }] : []);
    if (method === "GET" && p === "/issues/comments") return Response.json(state.comments);
    if (method === "GET" && p === "/issues/50/comments") return Response.json(state.comments.filter((c) => c.issue_url === issueUrl(50)));
    if (method === "POST" && p === "/issues") {
      state.created.push(json);
      state.tracking = true;
      return Response.json({ number: 50 }, { status: 201 });
    }
    if (method === "POST" && p === "/issues/50/comments") {
      state.comments.push({ user: BOT, issue_url: issueUrl(50), created_at: new Date(NOW).toISOString(), body: json.body });
      return Response.json({}, { status: 201 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { state, fetcher };
}

describe("daily post metrics", () => {
  it("collects post ids from the bot's Posted comments on post issues in the last 30 days", () => {
    const comments = [
      posted(1, 1, "111", 1),
      posted(1, 2, "112", 2),
      posted(2, 1, "211", 40), // too old
      posted(3, 1, "311", 1), // not a post issue
      posted(1, 1, "999", 1, { login: "someone" }), // not the bot
      { user: BOT, issue_url: issueUrl(1), created_at: ago(1), body: "Approved. Scheduled:\n- Post 2" },
    ];
    const out = postedFromComments(comments, new Set([1, 2]), NOW);
    expect(out.map((p) => p.id)).toEqual(["112", "111"]);
  });

  it("measures each post at 1, 2, 3, 7, 14 and 28 days old only", () => {
    const posts = [0, 1, 2, 3, 4, 7, 10, 14, 28, 29].map((d) => ({ id: String(d), at: NOW - d * DAY - 3_600_000 }));
    expect(metricsDue(posts, NOW).map((p) => p.id)).toEqual(["1", "2", "3", "7", "14", "28"]);
  });

  it("reads X in batches of 100", async () => {
    const w = world();
    const ids = Array.from({ length: 230 }, (_, i) => String(1000 + i));
    const { tweets, nonPublic } = await fetchMetrics(ids, env, w.fetcher);
    expect(w.state.reads.map((r) => r.ids.length)).toEqual([100, 100, 30]);
    expect(w.state.reads[0].fields).toBe("public_metrics,non_public_metrics,created_at");
    expect(tweets).toHaveLength(230);
    expect(nonPublic).toBe(true);
  });

  it("falls back to public metrics when X refuses private ones", async () => {
    const w = world({ refusePrivate: true });
    const { tweets, nonPublic } = await fetchMetrics(["1", "2"], env, w.fetcher);
    expect(nonPublic).toBe(false);
    expect(w.state.reads.map((r) => r.fields)).toEqual(["public_metrics,created_at"]);
    expect(tweets[0].non_public_metrics).toBeUndefined();
    expect(metricsComment("2026-10-17", [{ id: "1", at: NOW, tweet: tweets[0] }], 0.005, false)).toMatch(/\| 900 \| 1,234 \| 2 \| 1 \| 0 \| 5 \| – \|[\s\S]*didn't return private metrics/);
  });

  it("writes one table comment a day on a 'X post metrics' issue it creates once, with a cost mark", async () => {
    const w = world({ comments: [posted(1, 1, "111", 1), posted(2, 1, "211", 7)] });
    const log = await metrics(env, w.fetcher, NOW);
    expect(log[0]).toMatch(/measured 2 of 2 post\(s\) for \$0.01/);
    expect(w.state.created).toEqual([expect.objectContaining({ title: "X post metrics", labels: ["metrics"] })]);
    const body = w.state.comments.at(-1).body;
    expect(body).toContain("| Post | Posted | Impressions | Likes | Reposts | Replies | Quotes | Bookmarks | Link clicks |");
    expect(body).toContain("| [111](https://x.com/i/web/status/111) | 2026-10-16 | 1,500 | 1,234 | 2 | 1 | 0 | 5 | 12 |");
    expect(body).toContain("<!-- forge-metrics 2026-10-17 --> <!-- forge-cost 0.01 -->");

    // The same day again: no second comment, no second read.
    expect((await metrics(env, w.fetcher, NOW + 3_600_000))[0]).toMatch(/already measured/);
    expect(w.state.xCalls).toBe(1);
    expect(w.state.created).toHaveLength(1);
  });

  it("the metrics cost counts against the monthly X budget that posting checks", async () => {
    const w = world({ comments: [posted(1, 1, "111", 1)], spentMark: "9.99" });
    // Read cost $0.005 brings the month to $9.995; a $0.015 post would then pass $10.
    await metrics(env, w.fetcher, NOW);
    expect(w.state.comments.at(-1).body).toContain("<!-- forge-cost 0.005 -->");
    const gw = {
      ...w,
      fetcher: async (url, init = {}) => {
        if (new URL(url).pathname.endsWith("/issues/1/comments") && (init.method ?? "GET") === "GET") return Response.json([]);
        if (new URL(url).host === "api.x.com") throw new Error("must not post over budget");
        return w.fetcher(url, init);
      },
    };
    await expect(approve({ ...env, ISSUE_NUMBER: "1", ISSUE_BODY: "```post\nplain\n```" }, gw.fetcher, NOW)).rejects.toThrow(/budget/);
  });

  it("skips the read when it would pass the monthly cap", async () => {
    const w = world({ comments: [posted(1, 1, "111", 1), posted(1, 2, "112", 2)], tracking: true, spentMark: "9.995" });
    const log = await metrics(env, w.fetcher, NOW);
    expect(log[0]).toMatch(/budget/);
    expect(w.state.xCalls).toBe(0);
  });

  it("does nothing (no issue, no read) when no post is due a reading", async () => {
    const w = world({ comments: [posted(1, 1, "111", 5)] });
    expect((await metrics(env, w.fetcher, NOW))[0]).toMatch(/no posts due/);
    expect(w.state.created).toEqual([]);
    expect(w.state.xCalls).toBe(0);
  });
});
