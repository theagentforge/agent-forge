import { describe, expect, it } from "vitest";
import { extractPost, oauthHeader, post, weightedLength } from "../post-to-x.mjs";

describe("approve-to-post", () => {
  it("takes only the ```post block from the issue", () => {
    const body = "Draft for launch day.\n\n```post\nThe Agent Forge is live.\nhttps://theagentforge.io\n```\n\nNotes: ignore this.";
    expect(extractPost(body)).toBe("The Agent Forge is live.\nhttps://theagentforge.io");
    expect(extractPost("no block here")).toBeNull();
  });

  it("counts links as 23 like X does", () => {
    expect(weightedLength(`hi https://theagentforge.io/t/${"x".repeat(200)}`)).toBe(3 + 23);
    expect(weightedLength("a".repeat(280))).toBe(280);
  });

  it("builds an OAuth 1.0a header with every required field", () => {
    const h = oauthHeader({
      method: "POST",
      url: "https://api.x.com/2/tweets",
      consumerKey: "ck",
      consumerSecret: "cs",
      token: "t",
      tokenSecret: "ts",
      nonce: "n",
      timestamp: 1,
    });
    expect(h).toMatch(/^OAuth oauth_consumer_key="ck", oauth_nonce="n", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1", oauth_token="t", oauth_version="1.0", oauth_signature="[A-Za-z0-9%]+"$/);
  });

  const env = { ISSUE_BODY: "```post\nhello\n```", X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d" };

  it("posts and returns the post URL", async () => {
    let sent;
    const url = await post(env, async (_u, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ data: { id: "123", text: "hello" } }, { status: 201 });
    });
    expect(sent).toEqual({ text: "hello" });
    expect(url).toBe("https://x.com/i/web/status/123");
  });

  it("refuses too-long posts, missing secrets and X errors without leaking secrets", async () => {
    await expect(post({ ...env, ISSUE_BODY: "```post\n" + "a".repeat(281) + "\n```" })).rejects.toThrow(/281/);
    await expect(post({ ...env, X_ACCESS_SECRET: "" })).rejects.toThrow(/X_ACCESS_SECRET/);
    const err = await post(env, async () => Response.json({ title: "Forbidden" }, { status: 403 })).catch((e) => e.message);
    expect(err).toBe("X refused the post (HTTP 403: Forbidden).");
  });
});
