import { describe, expect, it } from "vitest";
import { approve, linkedInHash, parseLinkedIn, schedule, tagLinks, validateLinkedIn } from "../linkedin.mjs";
import { metadata, run, uploaded, uploadShort } from "../youtube.mjs";

// Social strategy §9.7 and §9.8: LinkedIn through Buffer (approve only), YouTube Shorts from the clips release, and
// ?from= tags on LinkedIn links.

const json = (x, status = 200, headers = {}) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json", ...headers } });
const BOT = { login: "github-actions[bot]" };

describe("LinkedIn blocks", () => {
  const body = [
    "Notes for Dinike.",
    "```linkedin profile 2026-10-23T14:00Z",
    "Two AIs, one job: restock from a flaky supplier. One ordered twice.",
    "",
    "Full replay: https://theagentforge.io/arena/run/abc",
    "image: /og/x/arena/run/abc.png",
    "```",
    "```linkedin page",
    "Same story for the page. https://theagentforge.io/?from=li-page",
    "```",
    "```post",
    "An X post, not LinkedIn.",
    "```",
  ].join("\n");

  it("reads the target, the time and the image, tags links, and ignores X blocks", () => {
    const posts = parseLinkedIn(body);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ n: 1, target: "profile", at: Date.parse("2026-10-23T14:00Z"), image: "https://theagentforge.io/og/x/arena/run/abc.png" });
    expect(posts[0].text).toContain("https://theagentforge.io/arena/run/abc?from=li-post");
    expect(posts[0].text).not.toContain("image:");
    expect(posts[1]).toMatchObject({ target: "page", at: null });
    expect(posts[1].text).toContain("?from=li-page");
    expect(posts[1].text).not.toContain("li-post");
  });

  it("refuses an empty issue, a bad time, a foreign image and a post over 3,000 characters", () => {
    expect(() => validateLinkedIn(parseLinkedIn("nothing"))).toThrow(/No ```linkedin block/);
    expect(() => parseLinkedIn("```linkedin tomorrow\nhi\n```")).toThrow(/can't read/);
    expect(() => parseLinkedIn("```linkedin\nhi\nimage: https://evil.example/x.png\n```")).toThrow(/won't fetch/);
    expect(() => validateLinkedIn(parseLinkedIn(`\`\`\`linkedin\n${"a".repeat(3001)}\n\`\`\``))).toThrow(/3000/);
    expect(tagLinks("see https://theagentforge.io/lab/3?x=1")).toBe("see https://theagentforge.io/lab/3?x=1&from=li-post");
  });

  it("schedules a timed post at its time, never in the past, and an untimed one into the queue", async () => {
    const sent = [];
    const fetcher = async (_url, init) => {
      sent.push(JSON.parse(init.body).variables.input);
      return json({ data: { createPost: { post: { id: "p1", dueAt: "2026-10-23T14:00:00.000Z" } } } });
    };
    const now = Date.parse("2026-10-23T13:55Z");
    await schedule({ BUFFER_API_KEY: "k" }, fetcher, { n: 1, at: Date.parse("2026-10-23T14:00Z"), text: "hi", image: "https://theagentforge.io/og/a.png" }, "ch1", now);
    await schedule({ BUFFER_API_KEY: "k" }, fetcher, { n: 2, at: null, text: "hi" }, "ch1", now);
    expect(sent[0]).toMatchObject({ mode: "customScheduled", dueAt: "2026-10-23T14:05:00.000Z", channelId: "ch1", assets: [{ image: { url: "https://theagentforge.io/og/a.png" } }] });
    expect(sent[1]).toMatchObject({ mode: "addToQueue" });
    expect(sent[1].dueAt).toBeUndefined();
    const refused = async () => json({ data: { createPost: { message: "Channel disconnected" } } });
    await expect(schedule({ BUFFER_API_KEY: "k" }, refused, { n: 3, at: null, text: "hi" }, "ch1")).rejects.toThrow(/Channel disconnected/);
  });

  const gh = (comments, log) => async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com")) {
      if (init.method === "POST") log.push({ url: u, body: JSON.parse(init.body) });
      return u.includes("/comments?") ? json(comments) : json({});
    }
    const q = JSON.parse(init.body).query;
    log.push({ buffer: q.slice(0, 20) });
    if (q.includes("organizations")) return json({ data: { account: { organizations: [{ id: "o1" }] } } });
    if (q.includes("channels")) return json({ data: { channels: [{ id: "li1", name: "Dinike", service: "linkedin" }, { id: "li2", name: "The Agent Forge", service: "linkedin" }, { id: "x1", name: "X", service: "twitter" }] } });
    return json({ data: { createPost: { post: { id: "p", dueAt: null } } } });
  };
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", ISSUE_NUMBER: "9", BUFFER_API_KEY: "k", BUFFER_LINKEDIN_PROFILE: "li1", BUFFER_LINKEDIN_PAGE: "li2", ISSUE_BODY: body };

  it("on approve, schedules each block on its channel once, and says so on the issue", async () => {
    const log = [];
    const lines = await approve(env, gh([], log));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Dinike");
    expect(lines[1]).toContain("The Agent Forge");
    const comment = log.find((l) => l.url?.endsWith("/comments"));
    expect(comment.body.body).toContain(`<!-- forge-linkedin ${linkedInHash(parseLinkedIn(body))} -->`);
    const again = [];
    expect(await approve(env, gh([{ user: BOT, body: comment.body.body }], again))).toEqual(["Already scheduled in Buffer."]);
    expect(again.some((l) => l.buffer)).toBe(false);
  });

  it("without a Buffer key, schedules nothing and says so once", async () => {
    const log = [];
    await approve({ ...env, BUFFER_API_KEY: "" }, gh([], log));
    expect(log.filter((l) => l.buffer)).toEqual([]);
    expect(log[0].body.body).toContain("LinkedIn isn't connected yet");
    const quiet = [];
    await approve({ ...env, BUFFER_API_KEY: "" }, gh([{ user: BOT, body: log[0].body.body }], quiet));
    expect(quiet).toEqual([]);
  });

  it("a page block with no page channel set is refused, not sent to every channel", async () => {
    const log = [];
    await expect(approve({ ...env, BUFFER_LINKEDIN_PAGE: "" }, gh([], log))).rejects.toThrow(/BUFFER_LINKEDIN_PAGE/);
  });
});

describe("YouTube Shorts", () => {
  const short = { clip: "gx-474e8092-dc5f232e", video: "gx-474e8092-dc5f232e.mp4", title: "Claude Sonnet 5.5 vs DeepSeek V4 Pro: who falls for the hidden trap?", description: "Restock <now>.\n\nReplay: https://theagentforge.io/arena/run/x?from=yt-short", runs: [] };

  it("builds the metadata YouTube accepts: no angle brackets, not for kids", () => {
    const m = metadata(short);
    expect(m.snippet.description).not.toMatch(/[<>]/);
    expect(m.snippet.title.length).toBeLessThanOrEqual(100);
    expect(m.status).toMatchObject({ privacyStatus: "public", selfDeclaredMadeForKids: false });
  });

  it("uploads with a resumable session and returns the video id", async () => {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers });
      if (String(url).includes("uploadType=resumable")) return json({}, 200, { Location: "https://upload.example/session1" });
      return json({ id: "vid123" });
    };
    expect(await uploadShort(short, new Uint8Array(10), "tok", fetcher)).toBe("vid123");
    expect(calls[0].headers["X-Upload-Content-Length"]).toBe("10");
    expect(calls[1]).toMatchObject({ url: "https://upload.example/session1", method: "PUT" });
  });

  it("reads uploaded clips only from the bot's own comments", () => {
    const m = uploaded([
      { user: BOT, body: "Uploaded: https://youtube.com/shorts/v1 <!-- forge-short gx-aaaa-bbbb v1 -->" },
      { user: { login: "someone" }, body: "<!-- forge-short gx-cccc-dddd v2 -->" },
    ]);
    expect([...m.keys()]).toEqual(["gx-aaaa-bbbb"]);
  });

  it("does nothing until YouTube is connected", async () => {
    const r = await run("https://theagentforge.io", {}, async () => {
      throw new Error("no network expected");
    });
    expect(r[0]).toContain("isn't connected");
  });

  it("uploads only clips not already on YouTube, and records each one", async () => {
    const posted = [];
    const fetcher = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/issues?state=all")) return json([{ number: 5, title: "YouTube Shorts" }]);
      if (u.includes("/issues/5/comments?")) return json([{ user: BOT, body: "<!-- forge-short gx-old-old v0 -->" }]);
      if (u.endsWith("/issues/5/comments")) {
        posted.push(JSON.parse(init.body).body);
        return json({});
      }
      if (u.endsWith("/api/v1/social/shorts")) return json({ shorts: [{ ...short, clip: "gx-old-old", video: "gx-old-old.mp4" }, short] });
      if (u.startsWith("https://oauth2.googleapis.com")) return json({ access_token: "tok" });
      if (u.endsWith(".mp4")) return new Response(new Uint8Array(20));
      if (u.includes("uploadType=resumable")) return json({}, 200, { Location: "https://upload.example/s" });
      return json({ id: "vNEW" });
    };
    const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", YOUTUBE_CLIENT_ID: "c", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" };
    const log = await run("https://theagentforge.io", env, fetcher);
    expect(log).toEqual([`${short.clip}: https://youtube.com/shorts/vNEW`]);
    expect(posted[0]).toContain(`<!-- forge-short ${short.clip} vNEW -->`);
  });
});

describe("?from= tags on hand-written X posts", () => {
  it("tags untagged links when sending, and leaves tagged ones alone", async () => {
    const { tagXLinks } = await import("../post-to-x.mjs");
    expect(tagXLinks("Replay: https://theagentforge.io/arena/run/abc")).toBe("Replay: https://theagentforge.io/arena/run/abc?from=x-post");
    expect(tagXLinks("https://theagentforge.io")).toBe("https://theagentforge.io?from=x-post");
    expect(tagXLinks("https://theagentforge.io/lab/3?from=x-lab")).toBe("https://theagentforge.io/lab/3?from=x-lab");
    expect(tagXLinks("https://example.com/x")).toBe("https://example.com/x");
  });
});
