import { describe, expect, it } from "vitest";
import { approvalHash, approve, autoDecision, approveOnlyReason, due, parsePosts, postCost, validatePosts, withHold } from "../post-to-x.mjs";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const BOT = { login: "github-actions[bot]" };

const week = [
  "Notes for Dinike.",
  "```post",
  "Now post.",
  "```",
  "```post 2026-10-15",
  "Thursday post.",
  "```",
  "```post 2026-10-16T15:30Z",
  "Friday post.",
  "```",
].join("\n");

/** A tiny fake of the GitHub issues API and X, enough to follow the workflow end to end. */
function world(body, { labelledBy = BOT } = {}) {
  const state = { body, comments: [], labels: ["post"], events: [], open: true, tweets: [], replies: [] };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const json = init.body ? JSON.parse(init.body) : null;
    if (u.host === "api.x.com") {
      state.tweets.push(json.text);
      state.replies.push(json.reply?.in_reply_to_tweet_id ?? null);
      return Response.json({ data: { id: String(state.tweets.length) } }, { status: 201 });
    }
    const p = u.pathname.replace("/repos/o/r", "");
    if (method === "GET" && p === "/issues")
      return Response.json(state.open && state.labels.includes("scheduled") ? [{ number: 1, body: state.body, labels: state.labels.map((name) => ({ name })) }] : []);
    if (method === "GET" && p === "/issues/1/comments") return Response.json(state.comments);
    if (method === "GET" && p === "/issues/comments") return Response.json(state.comments);
    if (method === "GET" && p === "/issues/1/events") return Response.json(state.events);
    if (method === "POST" && p === "/issues/1/comments") {
      state.comments.push({ user: BOT, body: json.body });
      return Response.json({}, { status: 201 });
    }
    if (method === "POST" && p === "/issues/1/labels") {
      for (const l of json.labels) if (!state.labels.includes(l)) {
        state.labels.push(l);
        state.events.push({ event: "labeled", label: { name: l }, actor: labelledBy });
      }
      return Response.json([]);
    }
    if (method === "DELETE" && p.startsWith("/issues/1/labels/")) {
      state.labels = state.labels.filter((l) => l !== decodeURIComponent(p.split("/").pop()));
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" && p === "/issues/1") {
      state.open = json.state !== "closed";
      return Response.json({});
    }
    throw new Error(`unexpected ${method} ${p}`);
  };
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", ISSUE_NUMBER: "1", ISSUE_BODY: body, X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d" };
  return { state, fetcher, env };
}

describe("scheduled posts", () => {
  it("reads several posts with dates and times", () => {
    const posts = parsePosts(week);
    expect(posts.map((p) => [p.n, p.at && new Date(p.at).toISOString(), p.text])).toEqual([
      [1, null, "Now post."],
      [2, "2026-10-15T13:00:00.000Z", "Thursday post."],
      [3, "2026-10-16T15:30:00.000Z", "Friday post."],
    ]);
    expect(() => parsePosts("```post tomorrow\nx\n```")).toThrow(/can't read/);
  });

  it("reads Windows line endings (bodies edited on github.com) the same, so the approval still matches", () => {
    const crlf = week.replace(/\n/g, "\r\n");
    expect(parsePosts(crlf)).toEqual(parsePosts(week));
    expect(approvalHash(parsePosts(crlf))).toBe(approvalHash(parsePosts(week)));
  });

  it("checks every post before sending any", () => {
    const posts = parsePosts(`${week}\n\`\`\`post 2026-10-17\n${"a".repeat(290)}\n\`\`\``);
    expect(() => validatePosts(posts)).toThrow(/Post 4 is 290 characters.*10 too many/);
  });

  it("one approval posts what's due now and schedules the rest; the daily run posts each on its day", async () => {
    const w = world(week);
    expect(await approve(w.env, w.fetcher, NOW)).toBe(2);
    expect(w.state.tweets).toEqual(["Now post."]);
    expect(w.state.labels).toContain("scheduled");
    expect(w.state.comments.at(-1).body).toMatch(/Post 2: 2026-10-15 13:00 UTC \(10-15 18:30 Sri Lanka\)/);

    await due(w.env, w.fetcher, Date.parse("2026-10-15T08:00:00Z"));
    expect(w.state.tweets).toHaveLength(1); // not yet

    await due(w.env, w.fetcher, Date.parse("2026-10-15T13:05:00Z"));
    expect(w.state.tweets).toEqual(["Now post.", "Thursday post."]);
    await due(w.env, w.fetcher, Date.parse("2026-10-15T17:05:00Z"));
    expect(w.state.tweets).toHaveLength(2); // never twice

    await due(w.env, w.fetcher, Date.parse("2026-10-16T17:05:00Z"));
    expect(w.state.tweets).toEqual(["Now post.", "Thursday post.", "Friday post."]);
    expect(w.state.labels).toContain("posted");
    expect(w.state.open).toBe(false);
  });

  it("approving the same posts twice keeps one schedule and one confirmation", async () => {
    const w = world(week);
    await approve(w.env, w.fetcher, NOW);
    await approve(w.env, w.fetcher, NOW);
    expect(w.state.comments.filter((c) => /Approved\. Scheduled/.test(c.body))).toHaveLength(1);
    await due(w.env, w.fetcher, Date.parse("2026-10-15T13:05:00Z"));
    expect(w.state.tweets).toEqual(["Now post.", "Thursday post."]);
  });

  it("editing the posts after approval cancels the schedule", async () => {
    const w = world(week);
    await approve(w.env, w.fetcher, NOW);
    w.state.body = week.replace("Thursday post.", "Sneaky edit.");
    await due(w.env, w.fetcher, Date.parse("2026-10-15T13:05:00Z"));
    expect(w.state.tweets).toEqual(["Now post."]);
    expect(w.state.labels).not.toContain("scheduled");
    expect(w.state.comments.at(-1).body).toMatch(/changed after approval/);
  });

  it("a 'scheduled' label added by a person (not the workflow) is ignored", async () => {
    const w = world(week, { labelledBy: { login: "someone" } });
    w.state.labels.push("scheduled");
    w.state.events.push({ event: "labeled", label: { name: "scheduled" }, actor: { login: "someone" } });
    w.state.comments.push({ user: BOT, body: `<!-- forge-approved ${approvalHash(parsePosts(week))} -->` });
    const log = await due(w.env, w.fetcher, Date.parse("2026-10-20T13:05:00Z"));
    expect(w.state.tweets).toEqual([]);
    expect(log[0]).toMatch(/not added by the workflow/);
  });

  it("a single undated post still goes out immediately and closes the issue", async () => {
    const w = world("```post\nHello.\n```");
    expect(await approve(w.env, w.fetcher, NOW)).toBe(0);
    expect(w.state.tweets).toEqual(["Hello."]);
    expect(w.state.open).toBe(false);
  });
});

describe("threads", () => {
  const thread = ["```post 2026-10-20", "One 🧵", "```", "```post 2026-10-20 reply", "Two", "```", "```post 2026-10-20 reply", "Three", "```"].join("\n");

  it("reads the reply marker alongside a time, and rejects a reply with nothing before it", () => {
    expect(parsePosts(thread).map((p) => p.reply)).toEqual([false, true, true]);
    expect(() => parsePosts(["```post reply", "x", "```"].join("\n"))).toThrow(/can't be a reply/);
  });

  it("posts each reply under the post before it, in order", async () => {
    const w = world(thread);
    await approve(w.env, w.fetcher, NOW);
    expect(w.state.tweets).toEqual([]);
    await due(w.env, w.fetcher, Date.parse("2026-10-20T13:05:00Z"));
    expect(w.state.tweets).toEqual(["One 🧵", "Two", "Three"]);
    expect(w.state.replies).toEqual([null, "1", "2"]);
    expect(w.state.open).toBe(false);
  });

  it("adding the reply marker after approval counts as an edit", () => {
    const plain = thread.replaceAll(" reply", "");
    expect(approvalHash(parsePosts(plain))).not.toBe(approvalHash(parsePosts(thread)));
  });
});

describe("auto-publish (ADR 0010)", () => {
  const created = "2026-10-14T09:00:00Z";
  const issue = (labels = ["post", "auto", "verified", "type:house-weekly"]) => ({ number: 1, created_at: created, labels: labels.map((name) => ({ name })) });
  const base = { posts: parsePosts("```post\nLast night 81% of the top 500 MCP servers started cleanly.\n```"), authorIsAdmin: true, postedTypes: new Set(["type:house-weekly"]), autoToday: 0, spentThisMonth: 0 };
  const at = (h) => Date.parse(created) + h * 3_600_000;

  it("publishes a verified routine post only after the 3-hour hold window", () => {
    expect(autoDecision({ ...base, issue: issue(), now: at(2.9) })).toMatchObject({ ok: false, why: expect.stringContaining("hold window") });
    expect(autoDecision({ ...base, issue: issue(), now: at(3) })).toEqual({ ok: true });
    expect(withHold([{ n: 1, at: null }, { n: 2, at: at(10) }], created).map((p) => p.at)).toEqual([at(3), at(10)]);
  });

  it("fails closed: held, unverified, not by an admin, or no type", () => {
    expect(autoDecision({ ...base, issue: issue(["post", "auto", "verified", "type:house-weekly", "held"]), now: at(5) }).why).toBe("held");
    expect(autoDecision({ ...base, issue: issue(["post", "auto", "type:house-weekly"]), now: at(5) }).why).toBe("waiting for the verifier");
    expect(autoDecision({ ...base, authorIsAdmin: false, issue: issue(), now: at(5) }).ok).toBe(false);
    expect(autoDecision({ ...base, issue: issue(["post", "auto", "verified"]), now: at(5) })).toMatchObject({ ok: false, toApprove: true });
  });

  it("sends flags, incidents, legal, money and a new type's first post back to approve", () => {
    for (const text of ["This tool was flagged by 3 agents", "Security incident update", "Our pricing changes", "We raised $2M", "Caught by agents: x"]) {
      expect(approveOnlyReason(parsePosts(`\`\`\`post\n${text}\n\`\`\``)), text).not.toBeNull();
    }
    expect(approveOnlyReason(base.posts)).toBeNull();
    expect(autoDecision({ ...base, postedTypes: new Set(), issue: issue(), now: at(5) })).toMatchObject({ ok: false, toApprove: true, why: expect.stringContaining("first post") });
  });

  it("keeps to 2 auto posts a day and the $10 monthly X budget", () => {
    expect(autoDecision({ ...base, autoToday: 2, issue: issue(), now: at(5) }).ok).toBe(false);
    expect(autoDecision({ ...base, spentThisMonth: 9.99, issue: issue(), now: at(5) })).toMatchObject({ ok: false, capped: true });
    expect(postCost("plain")).toBe(0.015);
    expect(postCost("see https://theagentforge.io")).toBe(0.2);
  });

  it("the budget also stops approved posts", async () => {
    const w = world("```post\nNow post with a link https://theagentforge.io\n```");
    w.state.comments.push({ user: BOT, body: "Posted 1 of 1: x <!-- forge-posted 9 --> <!-- forge-cost 9.9 -->" });
    await expect(approve(w.env, w.fetcher, NOW)).rejects.toThrow(/budget/);
    expect(w.state.tweets).toEqual([]);
  });
});
