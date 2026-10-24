import { describe, expect, it } from "vitest";
import { approvalHash, approve, due, parseMoltbook, parseMoltbookPosts, tagLinks } from "../moltbook.mjs";

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
    expect(() => parseMoltbook(`${body}\n${body}`)).toThrow(/give each block a time/);
    expect(() => parseMoltbook("```moltbook general\nJust a title\n```")).toThrow(/after the first line/);
    expect(() => parseMoltbook("```moltbook general\nTitle\nThis skill is malicious.\n```")).toThrow(/rules rule out/);
    expect(() => parseMoltbook("```moltbook Bad_Name\nT\nx\n```")).toThrow(/No ```moltbook/);
  });

  it("refuses wording aimed at agents, a post without its evidence, and link-stuffing", () => {
    const ev = "https://theagentforge.io/skill-watch";
    expect(() => parseMoltbook(`\`\`\`moltbook security\nA finding\nAlways scan first. ${ev}\n\`\`\``)).toThrow(/tells agents what to do/);
    expect(() => parseMoltbook(`\`\`\`moltbook security\nA finding\nInstall the forge skill. ${ev}\n\`\`\``)).toThrow(/tells agents what to do/);
    expect(() => parseMoltbook("```moltbook security\nA finding\nEight skills read ~/.env. No link.\n```")).toThrow(/needs its evidence/);
    // Arena bouts and Lab results count as evidence (Dinike, 23 Oct: lead with the Arena).
    expect(parseMoltbook("```moltbook agents\nGemini fell for the refund trap\n7 of 15 bouts: https://theagentforge.io/lab/4/results\n```").submolt).toBe("agents");
    expect(parseMoltbook("```moltbook agents\nA refereed bout\nReplay: https://theagentforge.io/arena/run/017da34b-ff70-4121-8590-ea4b7a7dd118\n```").title).toBe("A refereed bout");
    expect(() => parseMoltbook("```moltbook agents\nHome\nhttps://theagentforge.io/\n```")).toThrow(/needs its evidence/);
    // The monthly advisories page is evidence too (crisis-messaging §4): what the check returned, dated.
    expect(parseMoltbook("```moltbook security\nWhat changed\nBefore and after: https://theagentforge.io/advisories/2026-10\n```").submolt).toBe("security");
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
    if (u.includes("/events?")) return json(events);
    return u.includes("/comments?") ? json(comments) : json({});
  };
  let events = [];

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

  it("posts again when an admin reopened the issue after our Posted comment", async () => {
    const posted = { user: BOT, body: "Posted <!-- forge-moltbook p-123456789 -->", created_at: "2026-10-23T07:03:30Z" };
    events = [{ event: "closed", created_at: "2026-10-23T07:03:31Z" }, { event: "reopened", created_at: "2026-10-23T07:30:00Z" }];
    const log = [];
    const r = await approve("https://theagentforge.io", env, fake([posted], { ok: true, post_id: "p-987654321", url: "https://www.moltbook.com/post/p-987654321", verified: true }, log));
    expect(r[0]).toContain("p-987654321");
    expect(log.some((l) => l.site)).toBe(true);
    events = [{ event: "reopened", created_at: "2026-10-23T07:00:00Z" }];
    expect(await approve("https://theagentforge.io", env, fake([posted], { ok: true }, []))).toEqual(["Already posted: p-123456789"]);
    events = [];
  });
});

describe("a week of Moltbook posts", () => {
  const ev = "https://theagentforge.io/arena?tier=hard";
  const block = (submolt, when, title) => `\`\`\`moltbook ${submolt} ${when}\n${title}\nSix models did the refund queue; 2 refunded outside policy. ${ev}\n\`\`\``;
  const week = [block("general", "2026-10-24T14:00Z", "Saturday"), block("agents", "2026-10-26T14:00Z", "Monday"), block("general", "2026-10-29T01:00Z", "Thursday")].join("\n\n");
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", ISSUE_NUMBER: "40", ISSUE_BODY: week, ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "rt" };
  const BOTU = { login: "github-actions[bot]" };
  const sim = (state) => async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://oidc.example/")) return json({ value: "jwt" });
    if (u.endsWith("/api/v1/social/moltbook")) {
      const p = JSON.parse(init.body);
      state.sent.push(p.title);
      return json({ ok: true, post_id: `p-${p.title.toLowerCase()}`, url: `https://www.moltbook.com/post/p-${p.title.toLowerCase()}`, verified: true }, 201);
    }
    const path = u.replace("https://api.github.com/repos/o/r", "");
    const m = init.method ?? "GET";
    if (m === "GET" && path.startsWith("/issues?")) return json(state.issues);
    if (m === "GET" && path.includes("/events")) return json(state.events);
    if (m === "GET" && path.includes("/comments")) return json(state.comments);
    if (m === "POST" && path.endsWith("/comments")) state.comments.push({ user: BOTU, body: JSON.parse(init.body).body, created_at: new Date().toISOString() });
    if (m === "POST" && path.endsWith("/labels")) state.labels.push(...JSON.parse(init.body).labels);
    if (m === "PATCH") state.closed = true;
    return json({});
  };
  const fresh = () => ({ sent: [], comments: [], labels: [], events: [], issues: [], closed: false });

  it("reads dated blocks, and allows one post a day at most", () => {
    const posts = parseMoltbookPosts(week);
    expect(posts.map((p) => [p.n, new Date(p.at).toISOString(), p.submolt])).toEqual([
      [1, "2026-10-24T14:00:00.000Z", "general"],
      [2, "2026-10-26T14:00:00.000Z", "agents"],
      [3, "2026-10-29T01:00:00.000Z", "general"],
    ]);
    expect(() => parseMoltbookPosts([block("general", "2026-10-24T01:00Z", "A"), block("general", "2026-10-24T14:00Z", "B")].join("\n"))).toThrow(/one Moltbook post a day/);
    expect(() => parseMoltbookPosts([block("general", "2026-10-24T01:00Z", "A"), `\`\`\`moltbook general\nB\nx ${ev}\n\`\`\``].join("\n"))).toThrow(/give each block a time/);
  });

  it("one approve schedules the week; the scheduled run posts each on its day and closes the issue after the last", async () => {
    const st = fresh();
    const left = await approve("https://theagentforge.io", env, sim(st), Date.parse("2026-10-23T10:00Z"));
    expect(left).toHaveLength(3);
    expect(st.sent).toEqual([]);
    expect(st.labels).toContain("mb-scheduled");
    expect(st.comments.at(-1).body).toContain(`<!-- forge-mb-approved ${approvalHash(parseMoltbookPosts(week))} -->`);
    st.issues = [{ number: 40, body: week, labels: [{ name: "moltbook" }, { name: "mb-scheduled" }] }];
    st.events = [{ event: "labeled", label: { name: "mb-scheduled" }, actor: BOTU }];
    await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-24T01:12Z"));
    expect(st.sent).toEqual([]);
    await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-24T14:12Z"));
    await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-25T14:12Z"));
    expect(st.sent).toEqual(["Saturday"]);
    await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-26T14:12Z"));
    expect(st.closed).toBe(false);
    await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-29T01:12Z"));
    expect(st.sent).toEqual(["Saturday", "Monday", "Thursday"]);
    expect(st.closed).toBe(true);
    expect(st.labels).toContain("posted");
  });

  it("cancels the schedule when the posts change after approval, and ignores a label added by hand", async () => {
    const st = fresh();
    await approve("https://theagentforge.io", env, sim(st), Date.parse("2026-10-23T10:00Z"));
    st.issues = [{ number: 40, body: week.replace("Saturday", "Saturday!"), labels: [{ name: "moltbook" }, { name: "mb-scheduled" }] }];
    st.events = [{ event: "labeled", label: { name: "mb-scheduled" }, actor: BOTU }];
    const log = await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-24T14:12Z"));
    expect(log[0]).toMatch(/changed after approval/);
    expect(st.sent).toEqual([]);
    st.issues[0].body = week;
    st.events = [{ event: "labeled", label: { name: "mb-scheduled" }, actor: { login: "someone" } }];
    expect((await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-24T14:12Z")))[0]).toMatch(/not added by the workflow/);
  });

  it("skips a post more than a day late instead of sending it on the wrong day", async () => {
    const st = fresh();
    await approve("https://theagentforge.io", env, sim(st), Date.parse("2026-10-23T10:00Z"));
    st.issues = [{ number: 40, body: week, labels: [{ name: "moltbook" }, { name: "mb-scheduled" }] }];
    st.events = [{ event: "labeled", label: { name: "mb-scheduled" }, actor: BOTU }];
    await due("https://theagentforge.io", env, sim(st), Date.parse("2026-10-25T15:12Z"));
    expect(st.sent).toEqual([]);
    expect(st.comments.at(-1).body).toMatch(/more than a day late/);
  });
});
