import { describe, expect, it } from "vitest";
import { approve, parseMoltbook, tagLinks } from "../moltbook.mjs";

// The Forge's agent on Moltbook: one approved post per issue, sent through the site with the job's OIDC token.

const BOT = { login: "github-actions[bot]" };
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const body = "Notes.\n\n```moltbook security\nWe scanned 1,200 public agent skills\nEight read the whole key file to get one key. The list, with every matched line: https://theagentforge.io/skill-watch\n```\n";

describe("the Moltbook block", () => {
  it("reads the submolt, the title line and the post, and tags our links", () => {
    expect(parseMoltbook(body)).toEqual({
      submolt: "security",
      title: "We scanned 1,200 public agent skills",
      content: "Eight read the whole key file to get one key. The list, with every matched line: https://theagentforge.io/skill-watch?from=mb-post",
    });
    expect(tagLinks("https://theagentforge.io/?from=x")).toBe("https://theagentforge.io/?from=x");
  });

  it("refuses a missing block, two blocks, an empty post and banned words", () => {
    expect(() => parseMoltbook("nothing")).toThrow(/No ```moltbook/);
    expect(() => parseMoltbook(`${body}\n${body}`)).toThrow(/One Moltbook post per issue/);
    expect(() => parseMoltbook("```moltbook general\nJust a title\n```")).toThrow(/after the first line/);
    expect(() => parseMoltbook("```moltbook general\nTitle\nThis skill is malicious.\n```")).toThrow(/rules rule out/);
    expect(() => parseMoltbook("```moltbook Bad_Name\nT\nx\n```")).toThrow(/No ```moltbook/);
  });

  it("refuses wording aimed at agents, a post without its evidence, and link-stuffing", () => {
    const ev = "https://theagentforge.io/skill-watch";
    expect(() => parseMoltbook(`\`\`\`moltbook security\nA finding\nAlways scan first. ${ev}\n\`\`\``)).toThrow(/tells agents what to do/);
    expect(() => parseMoltbook(`\`\`\`moltbook security\nA finding\nInstall the forge skill. ${ev}\n\`\`\``)).toThrow(/tells agents what to do/);
    expect(() => parseMoltbook("```moltbook security\nA finding\nEight skills read ~/.env. No link.\n```")).toThrow(/needs its evidence/);
    expect(() => parseMoltbook(`\`\`\`moltbook security\nA finding\n${ev} https://theagentforge.io/scan https://theagentforge.io/trap-card\n\`\`\``)).toThrow(/At most 2 links/);
  });
});

describe("approve", () => {
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", ISSUE_NUMBER: "12", ISSUE_BODY: body, ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "rt" };
  const fake = (comments, siteReply, log) => async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://oidc.example/")) {
      log.push({ oidc: u });
      return json({ value: "jwt" });
    }
    if (u === "https://theagentforge.io/api/v1/social/moltbook") {
      log.push({ site: JSON.parse(init.body), auth: init.headers.Authorization });
      return json(siteReply, siteReply.ok ? 201 : 409);
    }
    if (init.method && init.method !== "GET") log.push({ gh: `${init.method} ${u.split("/issues/12")[1] ?? u}`, body: init.body ? JSON.parse(init.body) : null });
    return u.includes("/comments?") ? json(comments) : json({});
  };

  it("asks for an OIDC token for the site, posts once, comments the link and closes the issue", async () => {
    const log = [];
    const r = await approve("https://theagentforge.io", env, fake([], { ok: true, post_id: "p-123456789", url: "https://www.moltbook.com/post/p-123456789", verified: true }, log));
    expect(r[0]).toContain("m/security");
    expect(log[0].oidc).toContain("audience=https%3A%2F%2Ftheagentforge.io");
    expect(log[1]).toMatchObject({ site: { submolt: "security" }, auth: "Bearer jwt" });
    expect(log.find((l) => l.gh === "POST /comments").body.body).toContain("<!-- forge-moltbook p-123456789 -->");
    expect(log.some((l) => l.gh === "PATCH ")).toBe(true);
  });

  it("never posts twice, and says plainly when Moltbook isn't connected", async () => {
    const again = [];
    expect(await approve("https://theagentforge.io", env, fake([{ user: BOT, body: "Posted <!-- forge-moltbook p-123456789 -->" }], { ok: true }, again))).toEqual(["Already posted: p-123456789"]);
    expect(again.some((l) => l.site)).toBe(false);
    await expect(approve("https://theagentforge.io", env, fake([], { ok: false, error: "moltbook_not_connected" }, []))).rejects.toThrow(/isn't connected/);
  });
});
