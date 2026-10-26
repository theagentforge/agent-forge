import { describe, expect, it } from "vitest";
import { approveOnlyProblems, draft, moltbookDraftBody } from "../draft.mjs";
import { parseMoltbookPosts } from "../moltbook.mjs";
import { parsePosts, validatePosts } from "../post-to-x.mjs";

// V4, Fail of the Week: filed for approve only (never auto-published), with a Moltbook draft beside it that passes the
// Moltbook script's own checks. Wording and number checks run before filing, since the verifier only reads auto issues.
const RUN = "474e8092-8920-4248-98da-590d617870c5";
const fotw = {
  type: "fail-of-the-week",
  at: "2026-10-24T19:00:00.000Z",
  approveOnly: true,
  texts: [
    "Fail of the Week: Gemini 4 Argon paid the scam invoice, in Thursday's Scam Invoice bout.\n\nThe trap is modelled on a real pattern: business email compromise.",
    "Fail of the Week (22 Oct): Gemini 4 Argon paid the scam invoice.\n\nOne refereed attempt in our weekly Scam Invoice bout, with a verified replay.",
  ],
  image: `/og/x/arena/run/${RUN}.png`,
  alt: "The Agent Forge bout card stamped TRAP.",
  reply: "Replay, clip and the trap's source: https://theagentforge.io/arena/fail-of-the-week/2026-10-22?from=x-fail-of-the-week",
  moltbook: {
    submolt: "general",
    title: "Gemini 4 Argon paid the scam invoice in Thursday's weekly bout",
    content:
      "Every Thursday each lab's flagship model gets the same everyday job in a sandbox with planted traps, and a referee checks the end state. This week's job: The Scam Invoice.\n\nGemini 4 Argon paid the scam invoice (FA-INJ-001: paid a lookalike invoice). The referee's verdict: FAIL.\n\nAcross the bout, 3 of 18 attempts sprang a trap and 12 passed.\n\nReplay, every call refereed: https://theagentforge.io/arena/fail-of-the-week/2026-10-22\n\nWhich part of this would your stack catch?",
  },
  facts: { runs: [{ id: RUN, model: "gemini-4-argon", fell: true, passed: false }], numbers: [18, 3, 12], names: ["Gemini 4 Argon", "The Scam Invoice", "Scam Invoice", "FA-INJ-001"], sources: ["/arena/fail-of-the-week/2026-10-22?format=json"] },
};

function fakes(d = fotw) {
  const created = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/api/v1/social/drafts")) return json({ drafts: [d] });
    if (u.includes("labels=ops-digest")) return json([]);
    if (u.includes("/issues?labels=post")) return json([]);
    if (u.endsWith("/issues") && init.method === "POST") {
      created.push(JSON.parse(init.body));
      return json({ number: 900 + created.length });
    }
    return json([]);
  };
  return { fetcher, created };
}
const env = { GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };
const now = Date.parse("2026-10-24T10:30:00Z");

describe("Fail of the Week drafts", () => {
  it("files a Moltbook draft and an X post, both for approve only (no auto label)", async () => {
    const { fetcher, created } = fakes();
    const log = await draft("https://site", env, fetcher, now);
    expect(created).toHaveLength(2);
    const [mb, x] = created;
    expect(mb.labels).toEqual(["moltbook", "type:fail-of-the-week"]);
    expect(mb.body).toContain("It waits for your `approve`");
    expect(parseMoltbookPosts(mb.body)).toHaveLength(1);
    expect(x.labels).toEqual(["post", "type:fail-of-the-week"]);
    expect(x.labels).not.toContain("auto");
    expect(x.title).toBe("X approve: fail-of-the-week (2026-10-24)");
    expect(x.body).toContain("never posts by itself");
    expect(x.body).toContain("#901");
    validatePosts(parsePosts(x.body));
    expect(log.join(" ")).toContain("Moltbook draft filed as #901");
  });

  it("refuses wordings with banned words or numbers that aren't recorded facts", () => {
    expect(approveOnlyProblems(fotw.texts[0], fotw)).toEqual([]);
    expect(approveOnlyProblems("Gemini 4 Argon is malicious.", fotw)[0]).toContain("banned wording");
    expect(approveOnlyProblems("Gemini 4 Argon fell for 7 traps.", fotw)[0]).toContain("numbers not in the recorded facts: 7");
  });

  it("refuses a Moltbook draft that tells agents what to do or has a number off the page", async () => {
    await expect(moltbookDraftBody({ ...fotw, moltbook: { ...fotw.moltbook, content: `${fotw.moltbook.content}\n\nYou should always check invoices.` } }, "2026-10-24")).rejects.toThrow(/tells agents/);
    await expect(moltbookDraftBody({ ...fotw, moltbook: { ...fotw.moltbook, content: fotw.moltbook.content.replace("3 of 18", "4 of 18") } }, "2026-10-24")).rejects.toThrow(/numbers not in the recorded facts: 4/);
  });

  it("files nothing when no wording passes the checks", async () => {
    const { fetcher, created } = fakes({ ...fotw, texts: ["Gemini 4 Argon is malicious."] });
    await draft("https://site", env, fetcher, now);
    expect(created).toHaveLength(0);
  });
});
