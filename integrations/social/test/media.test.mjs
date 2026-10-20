import { describe, expect, it } from "vitest";
import { approvalHash, approve, autoDecision, imageUrl, parsePosts, postCost, validatePosts, weightedLength } from "../post-to-x.mjs";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const BOT = { login: "github-actions[bot]" };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const withImage = (img = "https://theagentforge.io/og/arena/run/abc123.png") =>
  ["Notes.", "```post", "Crucible run: 7 of 9 jobs done.", `image: ${img}`, "```"].join("\n");

/** A fake GitHub issue, X API and theagentforge.io, with knobs for the image and upload responses. */
function world(body, { image = () => new Response(PNG, { headers: { "content-type": "image/png" } }), upload = null, postWithMedia = null } = {}) {
  const state = { comments: [], labels: ["post"], open: true, tweets: [], uploads: [], fetched: [] };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.host === "theagentforge.io") {
      state.fetched.push({ url, redirect: init.redirect });
      return image(url);
    }
    if (u.host === "api.x.com" && u.pathname === "/2/media/upload") {
      const json = JSON.parse(init.body);
      state.uploads.push({ json, auth: init.headers.Authorization });
      return upload ? upload() : Response.json({ data: { id: "777", media_key: "3_777" } });
    }
    if (u.host === "api.x.com" && u.pathname === "/2/tweets") {
      const json = JSON.parse(init.body);
      if (json.media && postWithMedia) return postWithMedia();
      state.tweets.push(json);
      return Response.json({ data: { id: String(state.tweets.length) } }, { status: 201 });
    }
    const p = u.pathname.replace("/repos/o/r", "");
    const json = init.body ? JSON.parse(init.body) : null;
    if (method === "GET" && (p === "/issues/1/comments" || p === "/issues/comments")) return Response.json(state.comments);
    if (method === "POST" && p === "/issues/1/comments") {
      state.comments.push({ user: BOT, body: json.body });
      return Response.json({}, { status: 201 });
    }
    if (method === "POST" && p === "/issues/1/labels") {
      state.labels.push(...json.labels);
      return Response.json([]);
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "PATCH" && p === "/issues/1") {
      state.open = false;
      return Response.json({});
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", ISSUE_NUMBER: "1", ISSUE_BODY: body, X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d" };
  return { state, fetcher, env };
}

describe("images on posts", () => {
  it("keeps the image line out of the posted text and the 280 count", () => {
    const [p] = parsePosts(withImage());
    expect(p.text).toBe("Crucible run: 7 of 9 jobs done.");
    expect(p.image).toBe("https://theagentforge.io/og/arena/run/abc123.png");
    const long = ["```post", "a".repeat(280), "image: /og/arena/run/x.png", "```"].join("\n");
    const [q] = parsePosts(long);
    expect(weightedLength(q.text)).toBe(280);
    expect(() => validatePosts([q])).not.toThrow();
    expect(parsePosts("```post\nno image\n```")[0]).not.toHaveProperty("image");
  });

  it("allows only /og/ PNGs on theagentforge.io, checked before anything is posted", () => {
    expect(imageUrl("/og/arena/run/abc.png")).toBe("https://theagentforge.io/og/arena/run/abc.png");
    for (const bad of [
      "https://evil.example/og/arena/run/abc.png",
      "https://theagentforge.io.evil.example/og/a.png",
      "http://theagentforge.io/og/a.png",
      "https://theagentforge.io/brand/logo.png",
      "https://theagentforge.io/og/../admin.png",
      "https://theagentforge.io/og/a.png?x=1",
      "https://user@theagentforge.io/og/a.png",
      "/og/a.jpg",
      "",
    ]) {
      expect(() => validatePosts(parsePosts(withImage(bad))), bad).toThrow(/image I won't fetch/);
    }
    expect(() => parsePosts(["```post", "x", "image: /og/a.png", "image: /og/b.png", "```"].join("\n"))).toThrow(/more than one image/);
  });

  it("a rejected image host stops approval before any post goes out", async () => {
    const w = world(withImage("https://evil.example/og/a.png"));
    await expect(approve(w.env, w.fetcher, NOW)).rejects.toThrow(/won't fetch/);
    expect(w.state.tweets).toEqual([]);
    expect(w.state.fetched).toEqual([]);
  });

  it("editing the image line after approval counts as an edit", () => {
    const a = approvalHash(parsePosts(withImage()));
    expect(approvalHash(parsePosts(withImage("/og/arena/run/other.png")))).not.toBe(a);
    // Posts without an image hash the same as before images existed.
    expect(approvalHash([{ at: null, text: "x" }])).toBe(approvalHash(parsePosts("```post\nx\n```")));
  });

  it("uploads the image with OAuth 1.0a and attaches it to the post", async () => {
    const w = world(withImage());
    await approve(w.env, w.fetcher, NOW);
    expect(w.state.fetched).toEqual([{ url: "https://theagentforge.io/og/arena/run/abc123.png", redirect: "error" }]);
    expect(w.state.uploads).toHaveLength(1);
    expect(w.state.uploads[0].json).toEqual({ media: Buffer.from(PNG).toString("base64"), media_category: "tweet_image", media_type: "image/png" });
    expect(w.state.uploads[0].auth).toMatch(/^OAuth /);
    expect(w.state.tweets).toEqual([{ text: "Crucible run: 7 of 9 jobs done.", media: { media_ids: ["777"] } }]);
    const posted = w.state.comments.find((c) => c.body.startsWith("Posted 1 of 1"));
    expect(posted.body).toContain("<!-- forge-cost 0.03 -->");
    expect(posted.body).toContain("With image.");
    expect(w.state.open).toBe(false);
  });

  it("an upload failure posts the text alone and says so", async () => {
    const w = world(withImage(), { upload: () => Response.json({ title: "Forbidden" }, { status: 403 }) });
    await approve(w.env, w.fetcher, NOW);
    expect(w.state.tweets).toEqual([{ text: "Crucible run: 7 of 9 jobs done." }]);
    const posted = w.state.comments.find((c) => c.body.startsWith("Posted 1 of 1"));
    expect(posted.body).toMatch(/<!-- forge-posted 1 --> <!-- forge-cost 0.015 --> Posted without the image: X refused the image upload \(HTTP 403: Forbidden\)\./);
  });

  it("a bad image (wrong type, too big, missing) or X refusing the attached post also falls back to text", async () => {
    const cases = [
      { image: () => new Response("<html>", { headers: { "content-type": "text/html" } }), why: /text\/html/ },
      { image: () => new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) } }), why: /over 5 MB/ },
      { image: () => new Response("nope", { status: 404 }), why: /HTTP 404/ },
      { postWithMedia: () => Response.json({ title: "Invalid media" }, { status: 400 }), why: /Invalid media/ },
    ];
    for (const c of cases) {
      const w = world(withImage(), c);
      await approve(w.env, w.fetcher, NOW);
      expect(w.state.tweets).toEqual([{ text: "Crucible run: 7 of 9 jobs done." }]);
      expect(w.state.comments.find((x) => x.body.startsWith("Posted 1 of 1")).body).toMatch(c.why);
    }
  });

  it("counts the upload in the cost and the budget", () => {
    expect(postCost("plain", true)).toBe(0.03);
    expect(postCost("https://theagentforge.io", true)).toBe(0.215);
    const issue = { number: 1, created_at: "2026-10-14T09:00:00Z", labels: ["post", "auto", "verified", "type:arena-run"].map((name) => ({ name })) };
    const d = autoDecision({ issue, posts: parsePosts(withImage()), authorIsAdmin: true, postedTypes: new Set(["type:arena-run"]), autoToday: 0, spentThisMonth: 9.98, now: NOW });
    expect(d).toMatchObject({ ok: false, capped: true });
  });
});

describe("alt text on images (social strategy §9.6)", () => {
  const block = (inner) => "```post 2026-10-22T17:00Z\n" + inner + "\n```";
  it("reads one alt line with the image, keeps it out of the post text and in the approval fingerprint", () => {
    const [p] = parsePosts(block("Same job, same hidden trap.\nimage: /og/x/arena/run/abc.png\nalt: Two pixel robots; one falls through a trapdoor."));
    expect(p.text).toBe("Same job, same hidden trap.");
    expect(p.alt).toBe("Two pixel robots; one falls through a trapdoor.");
    validatePosts([p]);
    const [q] = parsePosts(block("Same job, same hidden trap.\nimage: /og/x/arena/run/abc.png"));
    expect(approvalHash([p])).not.toBe(approvalHash([q]));
  });
  it("refuses alt text without an image, or two alt lines", () => {
    expect(() => parsePosts(block("Hi\nalt: nothing to describe"))).toThrow(/no image/);
    expect(() => parsePosts(block("Hi\nimage: /og/home.png\nalt: a\nalt: b"))).toThrow(/more than one alt/);
  });
  it("allows the new 16:9 feed cards under /og/x/", () => {
    expect(imageUrl("/og/x/gauntlet/474e8092-aa/dc5f232e-bb.png")).toBe("https://theagentforge.io/og/x/gauntlet/474e8092-aa/dc5f232e-bb.png");
  });
});
