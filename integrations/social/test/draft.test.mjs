import { describe, expect, it } from "vitest";
import { chooseDraft, claimedNumbers, draftBody, easternDate, opening, tagLinks, verifyIssue } from "../draft.mjs";
import { approveOnlyReason, autoDecision, parsePosts, uploadVideo, validatePosts, videoUrl } from "../post-to-x.mjs";

// Social strategy §9.1–§9.5: the drafter's guards, the separate verifier (fails closed), polls and native video.

const RUN_A = "474e8092-8920-4248-98da-590d617870c5";
const RUN_B = "dc5f232e-76b7-4b5e-a4ab-7ff872b8696a";
const draft = {
  type: "trap-of-the-day",
  at: "2026-10-26T18:00:00.000Z",
  texts: [
    "Same job. Same hidden trap.\n\nRestock through a supplier that keeps timing out.\n\nDeepSeek V4 Pro ordered the same goods twice. Claude Sonnet 5.5 didn't.\n\nRanked bout, 17 Oct.",
    "DeepSeek V4 Pro ordered the same goods twice, in our Flaky Supplier (Hard) test. Claude Sonnet 5.5 did the same job without falling for it.",
  ],
  image: `/og/x/gauntlet/${RUN_A}/${RUN_B}.png`,
  alt: "Two pixel robots.",
  facts: {
    runs: [
      { id: RUN_B, model: "deepseek-v4-pro", fell: true, passed: false },
      { id: RUN_A, model: "claude-sonnet-5.5", fell: false, passed: true },
    ],
    numbers: [],
    names: ["DeepSeek V4 Pro", "Claude Sonnet 5.5", "The Flaky Supplier (Hard)"],
    sources: [],
  },
};

/** A fake site: the drafts endpoint and two refereed bouts. */
const site = (over = {}) => async (url) => {
  const u = String(url);
  const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/v1/social/drafts")) return json({ drafts: [over.draft ?? draft] });
  if (u.endsWith(`${RUN_A}.json`)) return json({ model: "claude-sonnet-5.5", result: { passed: true, traps: [{ id: "double_order", triggered: false }] } });
  if (u.endsWith(`${RUN_B}.json`)) return json({ model: over.bModel ?? "deepseek-v4-pro", result: { passed: false, traps: [{ id: "double_order", triggered: over.bFell ?? true }] } });
  return json({}, 404);
};

describe("the drafter's guards", () => {
  it("skips a wording whose opening was used in the last 14 days (X's duplicate rule)", () => {
    const recent = new Set([opening(draft.texts[0])]);
    expect(chooseDraft(draft, { recentOpenings: recent, linkReplyToday: false }).text).toBe(draft.texts[1]);
    expect(chooseDraft(draft, { recentOpenings: new Set(draft.texts.map(opening)), linkReplyToday: false })).toBeNull();
  });
  it("never puts a URL in a main post, and allows one link reply a day, tagged ?from=x-<type>", () => {
    const d = { ...draft, texts: ["Look: https://theagentforge.io/arena now"], reply: "Every bout: https://theagentforge.io/arena" };
    const c = chooseDraft(d, { recentOpenings: new Set(), linkReplyToday: false });
    expect(c.text).not.toMatch(/https?:/);
    expect(c.reply).toBe("Every bout: https://theagentforge.io/arena?from=x-trap-of-the-day");
    expect(chooseDraft(d, { recentOpenings: new Set(), linkReplyToday: true }).reply).toBeNull();
    expect(tagLinks("a https://theagentforge.io/x?from=x-recap b", "recap")).toBe("a https://theagentforge.io/x?from=x-recap b");
  });
  it("files a post block the poster can read, with its image, alt text and facts", () => {
    const body = draftBody(draft, chooseDraft(draft, { recentOpenings: new Set(), linkReplyToday: false }), "2026-10-26");
    const [p] = parsePosts(body);
    validatePosts([p]);
    expect(p.at).toBe(Date.parse("2026-10-26T18:00Z"));
    expect(p.image).toBe(draft.image);
    expect(body).toContain("<!-- forge-draft ");
  });
  it("works in US Eastern dates", () => {
    expect(easternDate(Date.parse("2026-10-27T03:00Z"))).toBe("2026-10-26");
  });
});

describe("the verifier (separate code, fails closed)", () => {
  const body = draftBody(draft, { text: draft.texts[0], reply: null }, "2026-10-26");
  it("verifies a draft whose bouts and wording match the public record", async () => {
    expect(await verifyIssue({ body }, "https://site", site())).toEqual({ ok: true, why: [] });
  });
  it("fails when a bout's refereed result doesn't match", async () => {
    expect((await verifyIssue({ body }, "https://site", site({ bFell: false }))).ok).toBe(false);
    expect((await verifyIssue({ body }, "https://site", site({ bModel: "gpt-6.1-sol" }))).why.join()).toMatch(/model is gpt-6.1-sol/);
  });
  it("fails when the text holds a number that isn't a recorded fact", async () => {
    const bad = { ...draft, texts: ["DeepSeek V4 Pro ordered the same goods 3 times. Claude Sonnet 5.5 didn't."] };
    const b2 = draftBody(bad, { text: bad.texts[0], reply: null }, "2026-10-26");
    const r = await verifyIssue({ body: b2 }, "https://site", site({ draft: bad }));
    expect(r.why.join()).toMatch(/numbers not in the recorded facts: 3/);
  });
  it("fails when today's data no longer gives the same wording", async () => {
    const r = await verifyIssue({ body }, "https://site", site({ draft: { ...draft, texts: ["Something else."] } }));
    expect(r.why.join()).toMatch(/data changed/);
  });
  it("keeps model names, dates and times out of the number check", () => {
    expect(claimedNumbers("Claude Sonnet 5.5 and GPT-6.1 Sol, 17 Oct, 8 pm ET: 39 of 100", ["Claude Sonnet 5.5", "GPT-6.1 Sol"])).toEqual([39, 100]);
  });
});

describe("auto-publishing the drafter's issues", () => {
  it("referee facts like 'caught the trap' or 'paid the fake invoice' no longer force approve; tool flags and prices still do", () => {
    expect(approveOnlyReason([{ n: 1, text: "Claude Sonnet 5.5 caught the trap. GPT paid the fake invoice." }])).toBeNull();
    expect(approveOnlyReason([{ n: 1, text: "Flagged by agents this week" }])).not.toBeNull();
    expect(approveOnlyReason([{ n: 1, text: "Pricing starts at $9" }])).not.toBeNull();
  });
  it("still needs the verified label, and approve for a new type", () => {
    const issue = { labels: [{ name: "post" }, { name: "auto" }, { name: "type:recap" }], created_at: "2026-10-30T06:30:00Z" };
    const base = { posts: [{ n: 1, text: "Hi" }], authorIsAdmin: true, postedTypes: new Set(), autoToday: 0, spentThisMonth: 0, now: Date.parse("2026-10-30T17:00Z") };
    expect(autoDecision({ ...base, issue }).why).toMatch(/verifier/);
    expect(autoDecision({ ...base, issue: { ...issue, labels: [...issue.labels, { name: "verified" }] } }).why).toMatch(/first post of type:recap/);
  });
});

describe("polls and native video (§9.4, §9.5)", () => {
  it("reads a poll line, and refuses media on polls or too many options", () => {
    const [p] = parsePosts("```post 2026-10-28T13:00Z\nWhich one falls for it?\npoll: Claude Sonnet 5.5 | GPT-6.1 Sol | DeepSeek V4 Pro (2100 min)\n```");
    expect(p.poll).toEqual({ options: ["Claude Sonnet 5.5", "GPT-6.1 Sol", "DeepSeek V4 Pro"], duration_minutes: 2100 });
    expect(p.text).toBe("Which one falls for it?");
    validatePosts([p]);
    expect(() => validatePosts([{ ...p, image: "/og/home.png" }])).toThrow(/no media/);
    expect(() => validatePosts([{ ...p, poll: { options: ["a", "b", "c", "d", "e"], duration_minutes: 60 } }])).toThrow(/2–4/);
  });
  it("only fetches clips from the public clips release", () => {
    expect(videoUrl("gx-474e8092-dc5f232e.mp4")).toBe("https://github.com/theagentforge/agent-forge/releases/download/clips/gx-474e8092-dc5f232e.mp4");
    expect(() => videoUrl("../evil.mp4")).toThrow();
  });
  it("uploads a clip in chunks: initialize, append, finalize, then waits for processing", async () => {
    const calls = [];
    const fake = async (url, init) => {
      calls.push(`${init.method} ${String(url).replace("https://api.x.com/2/media/upload", "")}`);
      const u = String(url);
      const data = u.endsWith("/initialize") ? { data: { id: "77" } } : u.endsWith("/finalize") ? { data: { processing_info: { state: "pending", check_after_secs: 1 } } } : u.includes("STATUS") ? { data: { processing_info: { state: "succeeded" } } } : {};
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const env = { X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_SECRET: "u" };
    expect(await uploadVideo(new Uint8Array(1000), env, fake, async () => {})).toBe("77");
    expect(calls).toEqual(["POST /initialize", "POST /77/append", "POST /77/finalize", "GET ?command=STATUS&media_id=77"]);
  });
});

describe("filing drafts", () => {
  const issue = (n, body, state = "open") => ({ number: n, state, body, labels: [{ name: "post" }] });
  const runDraft = async (existing, drafts, now) => {
    const { draft: fileDrafts } = await import("../draft.mjs");
    const created = [];
    const fake = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/api/v1/social/drafts")) return new Response(JSON.stringify({ drafts }), { status: 200 });
      if (u.includes("/issues?labels=post")) return new Response(JSON.stringify(existing), { status: 200 });
      if (init.method === "POST" && u.endsWith("/issues")) {
        created.push(JSON.parse(init.body));
        return new Response("{}", { status: 201 });
      }
      return new Response("{}", { status: 200 });
    };
    const log = await fileDrafts("https://site", { GITHUB_REPOSITORY: "o/r", GH_TOKEN: "x" }, fake, now);
    return { log, created };
  };
  const d = { type: "poll", at: "2026-10-21T13:00:00.000Z", texts: ["Which one falls for it?"], poll: { options: ["A", "B"], duration_minutes: 600 }, facts: { numbers: [], names: [], sources: [] } };
  it("keeps 3 hours from any post already on the schedule", async () => {
    const { created, log } = await runDraft([issue(18, "```post 2026-10-21\nTomorrow: something.\n```")], [d], Date.parse("2026-10-21T06:30Z"));
    expect(created).toHaveLength(0);
    expect(log[0]).toMatch(/within 3 hours/);
  });
  it("files a free slot once, labelled post, auto and type:<slug>", async () => {
    const { created } = await runDraft([], [d], Date.parse("2026-10-21T06:30Z"));
    expect(created).toHaveLength(1);
    expect(created[0].labels).toEqual(["post", "auto", "type:poll"]);
    const again = await runDraft([issue(200, created[0].body)], [d], Date.parse("2026-10-21T06:35Z"));
    expect(again.created).toHaveLength(0);
  });
});
