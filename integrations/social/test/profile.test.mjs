import { describe, expect, it } from "vitest";
import { approveProfile, oauthHeader, parseProfile } from "../post-to-x.mjs";

describe("OAuth 1.0a signature with request parameters", () => {
  it("matches X's published example (parameters are part of the signature)", () => {
    // From X's "Creating a signature" guide.
    const h = oauthHeader({
      method: "post",
      url: "https://api.twitter.com/1.1/statuses/update.json",
      consumerKey: "xvz1evFS4wEEPTGEFPHBog",
      consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: 1318622958,
      extra: { status: "Hello Ladies + Gentlemen, a signed OAuth request!", include_entities: "true" },
    });
    expect(h).toContain(`oauth_signature="${encodeURIComponent("hCtSmYh+iHYCEqBWrE7C7hYmtUk=")}"`);
    // The extra parameters go in the body, never in the header.
    expect(h).not.toContain("status=");
  });
});

describe("profile issues", () => {
  const body = [
    "Notes are ignored.",
    "```bio\nAI, tested on everyday jobs.\n```",
    "```url\nhttps://theagentforge.io\n```",
    "```banner\napps/forge/public/brand/social/x-header-2026-10.png\n```",
  ].join("\n\n");

  it("reads the bio, website and banner blocks, and checks X's limits", () => {
    expect(parseProfile(body)).toEqual({ bio: "AI, tested on everyday jobs.", url: "https://theagentforge.io", banner: "apps/forge/public/brand/social/x-header-2026-10.png" });
    expect(() => parseProfile("```bio\n" + "x".repeat(161) + "\n```")).toThrow(/161 characters/);
    expect(() => parseProfile("```url\njavascript:alert(1)\n```")).toThrow(/https/);
    expect(() => parseProfile("```banner\n../../etc/passwd\n```")).toThrow(/PNG/);
    expect(() => parseProfile("nothing here")).toThrow(/No /);
  });

  it("updates the profile and header through signed form posts, then closes the issue", async () => {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url, init });
      return new Response(url.includes("api.github.com") ? "{}" : "", { status: 200 });
    };
    const env = { X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_SECRET: "ts", GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r", ISSUE_NUMBER: "9", ISSUE_BODY: body };
    const done = await approveProfile(env, fetcher, async () => new Uint8Array([137, 80, 78, 71]));
    expect(done).toEqual(["bio, url", "header image"]);
    const profile = calls.find((c) => c.url.endsWith("update_profile.json"));
    expect(profile.init.body).toBe("description=AI%2C%20tested%20on%20everyday%20jobs.&url=https%3A%2F%2Ftheagentforge.io");
    expect(profile.init.headers.Authorization).toMatch(/^OAuth /);
    expect(calls.find((c) => c.url.endsWith("update_profile_banner.json")).init.body).toBe("banner=iVBORw%3D%3D");
    expect(calls.some((c) => c.url.endsWith("/issues/9") && c.init.method === "PATCH")).toBe(true);
  });

  it("when X refuses, says so on the issue with the steps to do it by hand", async () => {
    const comments = [];
    const fetcher = async (url, init) => {
      if (url.includes("api.github.com")) {
        if (init.method === "POST") comments.push(JSON.parse(init.body).body);
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: "You currently have access to a subset of X API endpoints" }] }), { status: 403 });
    };
    const env = { X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_SECRET: "ts", GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r", ISSUE_NUMBER: "9", ISSUE_BODY: body };
    await expect(approveProfile(env, fetcher, async () => new Uint8Array([1]))).rejects.toThrow(/HTTP 403/);
    expect(comments[0]).toContain("Edit profile");
  });
});
