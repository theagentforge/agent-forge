import { describe, expect, it } from "vitest";
import { draft, draftBody } from "../draft.mjs";

// Milestone posts (apps/forge/src/social/milestones.ts): filed for approve only, once per milestone ever.
const milestone = {
  type: "milestone",
  at: "2026-10-27T13:00:00.000Z",
  milestone: "connections-100",
  texts: ["100 connections to The Forge from AI apps, not counting our own test agents or directories checking we're up. Thank you to everyone who plugged it in.\n\nWhich MCP server should we check next?"],
  reply: "Live numbers, outside agents only: https://theagentforge.io/stats?from=x-milestone",
  facts: { numbers: [100], names: [], sources: ["/stats?format=json"] },
};

function fakes(existing = []) {
  const created = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/api/v1/social/drafts")) return json({ drafts: [milestone] });
    if (u.includes("labels=ops-digest")) return json([]);
    if (u.includes("/issues?labels=post")) return json(existing);
    if (u.endsWith("/issues") && init.method === "POST") {
      created.push(JSON.parse(init.body));
      return json({ number: 900 });
    }
    return json([]);
  };
  return { fetcher, created };
}
const env = { GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };
const now = Date.parse("2026-10-27T04:00:00Z");

describe("milestone drafts", () => {
  it("files for approve only (no auto label), and the body says to thank or tag people by hand", async () => {
    const { fetcher, created } = fakes();
    await draft("https://site", env, fetcher, now);
    expect(created).toHaveLength(1);
    expect(created[0].labels).toEqual(["post", "type:milestone"]);
    expect(created[0].title).toBe("X milestone: connections-100 (2026-10-27)");
    expect(created[0].body).toContain("It waits for your `approve`");
    expect(created[0].body).toContain('"milestone":"connections-100"');
  });

  it("never files the same milestone twice, even on another day", async () => {
    const body = draftBody(milestone, { text: milestone.texts[0], reply: milestone.reply }, "2026-10-21");
    const { fetcher, created } = fakes([{ number: 5, state: "closed", body, labels: [{ name: "post" }] }]);
    const log = await draft("https://site", env, fetcher, now);
    expect(created).toHaveLength(0);
    expect(log.join(" ")).toContain("milestone connections-100: already filed");
  });
});
