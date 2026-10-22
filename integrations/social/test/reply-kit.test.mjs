import { describe, expect, it } from "vitest";
import { FACTS, factFor, kitBody, kitSpent, pick, QUERIES, replyIntent, REPLY_KIT_CAP_USD, run, suggestedReply } from "../reply-kit.mjs";

const AGENT_DIRECTED = /\b(always|must|prefer(red)?|you should|install (this|it|our)|tell (your|the) (human|user|owner)|ignore (previous|prior|other))\b/i;
const post = (id, text, likes, followers, username = `user${id}`) => ({
  id: String(id),
  text,
  author_id: `a${username}`,
  public_metrics: { like_count: likes, reply_count: 0, retweet_count: 0, quote_count: 0 },
  author: { id: `a${username}`, username, name: username, public_metrics: { followers_count: followers } },
});

describe("reply kit (posted by hand; this script never posts)", () => {
  it("picks big conversations only, one per author, never our own", () => {
    const picks = pick([
      post(1, "MCP server security", 5, 50_000, "big"),
      post(2, "agent skills", 3, 200, "small"),
      post(3, "prompt injection", 40, 300, "liked"),
      post(4, "another", 100, 50_000, "big"),
      post(5, "ours", 999, 9_999, "theagentforgeio"),
    ]);
    expect(picks.map((p) => p.id)).toEqual(["4", "3"]);
    // A lively thread from a mid-size account outranks a huge account's quiet post.
    expect(pick([post(6, "quiet", 2, 500_000, "huge"), post(7, "lively", 60, 5_000, "mid")]).map((p) => p.id)).toEqual(["7", "6"]);
  });

  it("matches each post to a published fact, with its link, inside X's length", () => {
    expect(factFor("Are Claude Code skills safe? SKILL.md files run anything").id).toBe("skill-scan");
    expect(factFor("tool poisoning in MCP servers").id).toBe("mcp");
    expect(factFor("prompt injection beat GPT again").id).toBe("trap-frontier");
    expect(factFor("prompt injection is unsolved").id).toBe("trap-small");
    expect(factFor("my AI agent got scammed").id).toBe("arena");
    for (const f of FACTS) {
      // A link counts as 23 characters on X; the fact is never cut short.
      expect(f.text.length + 1 + 23).toBeLessThanOrEqual(280);
      expect(suggestedReply({ text: "" }).text.endsWith(FACTS.at(-1).link)).toBe(true);
      expect(f.link).toMatch(/^https:\/\/theagentforge\.io\/[^ ]*\?from=x-reply$/);
      expect(f.text).not.toMatch(AGENT_DIRECTED);
    }
  });

  it("links X's own reply box with the text filled in, and says it never posts by itself", () => {
    expect(replyIntent("123", "hi there")).toBe("https://x.com/intent/post?in_reply_to=123&text=hi%20there");
    const body = kitBody("2026-10-22", [post(9, "agent skills are a mess", 50, 20_000, "dev")], 0.15);
    expect(body).toContain("Reply on X with this text");
    expect(body).toContain("https://x.com/i/web/status/9");
    expect(body).toContain("never posts or replies by itself");
    expect(body).toContain("<!-- forge-kit-cost 0.15 -->");
    expect(QUERIES.every((q) => q.q.includes("-is:retweet") && q.q.includes("-is:reply"))).toBe(true);
  });

  it("keeps its own monthly cap from its issues' cost marks", () => {
    const issues = [
      { user: { login: "github-actions[bot]" }, created_at: "2026-10-21T12:35:00Z", body: "<!-- forge-kit-cost 0.2 -->" },
      { user: { login: "github-actions[bot]" }, created_at: "2026-09-30T12:35:00Z", body: "<!-- forge-kit-cost 5 -->" },
      { user: { login: "someone" }, created_at: "2026-10-21T12:35:00Z", body: "<!-- forge-kit-cost 9 -->" },
    ];
    expect(kitSpent(issues, Date.UTC(2026, 9, 22))).toBeCloseTo(0.2);
    expect(REPLY_KIT_CAP_USD).toBe(8);
  });

  it("runs once a day: searches with signed reads, opens today's issue, closes yesterday's", async () => {
    const calls = [];
    const fetcher = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
      const u = String(url);
      if (u.startsWith("https://api.x.com/2/tweets/search/recent")) {
        return Response.json({ data: [{ id: "77", text: "MCP server hijacked my agent", author_id: "u1", public_metrics: { like_count: 80, reply_count: 5, retweet_count: 2, quote_count: 0 } }], includes: { users: [{ id: "u1", username: "sec", name: "Sec", public_metrics: { followers_count: 12_000 } }] } });
      }
      if (u.includes("/issues?state=all")) return Response.json([{ number: 5, title: "Reply kit (2026-10-21)", state: "open", user: { login: "github-actions[bot]" }, created_at: "2026-10-21T12:35:00Z", body: "<!-- forge-kit-cost 0.02 -->" }]);
      if (u.endsWith("/issues/5")) return Response.json({});
      if (u.endsWith("/issues")) return Response.json({ number: 6 });
      throw new Error(`unexpected ${u}`);
    };
    const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "a", X_ACCESS_SECRET: "b" };
    const log = await run(env, fetcher, Date.UTC(2026, 9, 22, 12, 35));
    expect(log[0]).toMatch(/^2026-10-22: 1 conversation\(s\) in #6, 4 reads for \$0\.02$/);
    const searches = calls.filter((c) => c.url.includes("search/recent"));
    expect(searches).toHaveLength(2);
    expect(searches[0].auth).toMatch(/^OAuth /);
    expect(calls.some((c) => c.url.endsWith("/issues/5") && c.body?.state === "closed")).toBe(true);
    const made = calls.find((c) => c.url.endsWith("/issues") && c.method === "POST");
    expect(made.body.title).toBe("Reply kit (2026-10-22)");
    expect(made.body.body).toContain("@sec");
    // Nothing is ever sent to X but searches.
    expect(calls.filter((c) => c.url.includes("api.x.com") && c.method !== "GET")).toHaveLength(0);
    expect(await run(env, async (u, i) => (String(u).includes("/issues?state=all") ? Response.json([{ title: "Reply kit (2026-10-22)" }]) : fetcher(u, i)), Date.UTC(2026, 9, 22, 13))).toEqual(["2026-10-22: already done"]);
  });
});
