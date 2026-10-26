import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { cleanInput, createFeed, feedOwner, ladderRanks, newArenaResults, ownerWeeks, revokeFeed, sha256Hex, writeLadderSnapshot } from "../src/services/digest";
import { atomFeed, weekTitle } from "../src/web/digest-feed";
import { connectAgent, connectApprovedAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// V5 (docs/strategy/agent-social-loops.md §3): a weekly digest without email. forge_me's since_last_week, and a private
// per-owner Atom feed at a secret link (stored hashed, revocable). Only data the agent's owner may see.

afterEach(() => vi.restoreAllMocks());
const DAY = 86_400_000;
const NOTE = "Worked fine but the docs were stale";
const tool = (id: string, c: string) => ({ kind: "mcp_server", id, version: "1.0.0", fingerprint: fp(c) });
const file = async (token: string, body: Record<string, unknown>) => (await (await postReport(token, report(body))).json()) as any;
const host = new URL(env.PUBLIC_ORIGIN).host;
async function forgeMe(token: string, args: Record<string, unknown> = {}) {
  const res = await fetchWorker("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forge_me", arguments: args } }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result as { structuredContent: any; isError?: boolean };
}
const g = () => `g${crypto.randomUUID().replace(/-/g, "")}`;
const summary = (passed: number, fell: number) => ({ passed, jobs_total: 6, traps_fell: fell, traps_total: 6, jobs: [], fell: [] });

describe("forge_me since_last_week", () => {
  it("lists new reports on tools the agent reported on, verdicts received, watched versions, ladder moves and challenges", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const a = await connectApprovedAgent();
    const b = await connectApprovedAgent();
    const c = await connectAgent();
    const mine = await file(a.token, { tool: tool("npm:@acme/digest-mine", "1") });
    // Another owner reports on the same tool (failed) and confirms our report.
    await file(b.token, { tool: tool("npm:@acme/digest-mine", "1"), outcome: "failed", issues: ["install_failed"], note: NOTE, on_report: mine.report_id, verdict: "confirm" });
    // A tool the agent only watches (by fingerprint), reported by someone else.
    await file(c.token, { tool: tool("npm:@acme/digest-watched", "2") });

    // Ranked Ladder: rank 3 in the snapshot 7 days ago, rank 1 now.
    const db = getDb(env);
    await db.insert(t.arenaRatings).values({ subject: `agent:${a.agent.id}`, rating: 3000, rd: 30, vol: 0.06, games: 2, wins: 2, updatedAt: Date.now() });
    await env.KV.put(`ladder:ranks:${new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10)}`, JSON.stringify({ [a.agent.id]: 3 }));

    // A Gauntlet run of the agent's and two challenges to it (one beat it, one didn't).
    const run = g();
    await db.insert(t.arenaGauntlets).values({ id: run, status: "done", summary: summary(4, 1), startedAt: Date.now() - 2 * DAY, finishedAt: Date.now() - 2 * DAY });
    await db.insert(t.arenaGauntlets).values({ id: g(), status: "done", challengeOf: run, challenge: { seeds: [] }, summary: summary(5, 0), startedAt: Date.now() - DAY, finishedAt: Date.now() - DAY });
    await db.insert(t.arenaGauntlets).values({ id: g(), status: "done", challengeOf: run, challenge: { seeds: [] }, summary: summary(2, 3), startedAt: Date.now() - DAY, finishedAt: Date.now() - DAY });
    // Too old to count.
    await db.insert(t.arenaGauntlets).values({ id: g(), status: "done", challengeOf: run, challenge: { seeds: [] }, summary: summary(6, 0), startedAt: Date.now() - 9 * DAY, finishedAt: Date.now() - 9 * DAY });

    const r = await forgeMe(a.token, { watch: [fp("2"), "not-a-fingerprint"], gauntlet_ids: [run, "nope"] });
    expect(r.isError).toBeFalsy();
    const w = r.structuredContent.since_last_week;
    expect(w.new_reports_on_tools_you_reported).toEqual([expect.objectContaining({ tool_id: "npm:@acme/digest-mine", new_reports: 1, failed: 1 })]);
    expect(w.verdicts_received).toMatchObject({ confirmations: 1, disputes: 0, reports: [{ report_id: mine.report_id, confirmations: 1, disputes: 0 }] });
    expect(w.watched).toEqual([expect.objectContaining({ fingerprint: fp("2"), known: true, tool_id: "npm:@acme/digest-watched", new_reports_on_tool: 1, on_this_version: true })]);
    expect(w.ranked_ladder).toMatchObject({ rank: 1, rank_before: 3, moved: 2 });
    expect(w.gauntlet_challenges).toEqual([{ gauntlet_id: run, challenges_started: 2, challenges_finished: 2, your_run_ahead: 1, challenger_ahead: 1, level: 0 }]);
    // Data only: no other owner's login, note or challenger id.
    const all = JSON.stringify(w);
    expect(all).not.toContain(b.human.githubLogin);
    expect(all).not.toContain(NOTE);

    // The same over REST.
    const rest = (await (await fetchWorker(`/api/v1/me?watch=${fp("2")}&gauntlet_ids=${run}`, { headers: { Authorization: `Bearer ${a.token}` } })).json()) as any;
    expect(rest.since_last_week.gauntlet_challenges[0].challenges_started).toBe(2);
    expect(rest.since_last_week.watched).toHaveLength(1);
  });

  it("is empty but present for a new agent, and drops malformed input", async () => {
    const x = await connectAgent();
    const w = (await forgeMe(x.token)).structuredContent.since_last_week;
    expect(w).toMatchObject({ new_reports_on_tools_you_reported: [], watched: [], verdicts_received: { confirmations: 0, disputes: 0 }, ranked_ladder: null, gauntlet_challenges: [] });
    expect(cleanInput({ watch: ["A".repeat(64), `sha256:${"b".repeat(64)}`, "x"], gauntlet_ids: "g" + "0".repeat(32) + ",bad" })).toEqual({ watch: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`], gauntlets: ["g" + "0".repeat(32)] });
  });

  it("keeps one ladder snapshot a day", async () => {
    const now = Date.parse("2026-12-01T05:00:00Z");
    expect((await writeLadderSnapshot(env, getDb(env), now)).written).toBe(true);
    expect((await writeLadderSnapshot(env, getDb(env), now + 3_600_000)).written).toBe(false);
    expect(await env.KV.get("ladder:ranks:2026-12-01", "json")).toEqual(await ladderRanks(getDb(env)));
  });
});

const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function webLogin(p: ReturnType<typeof profile>) {
  const start = await fetchWorker("/auth/login", { redirect: "manual" });
  const gh = new URL(start.headers.get("Location")!);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_x" });
    if (url === "https://api.github.com/user") return Response.json(p);
    if (url.startsWith("https://api.github.com/users/")) return Response.json([]);
    return realFetch(input, init);
  });
  const hop = await fetchWorker(`/callback?code=c&state=${gh.searchParams.get("state")}`, { redirect: "manual" });
  const cb = await fetchWorker(hop.headers.get("Location")!, { headers: { Cookie: cookiesFrom(start) }, redirect: "manual" });
  vi.restoreAllMocks();
  return cb.headers.getSetCookie().find((c) => c.startsWith("__Host-forge_session="))!.split(";")[0]!;
}
const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetchWorker(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });

describe("the private Atom feed", () => {
  it("is made from the dashboard, shown once, stored hashed, served as Atom, replaced and revoked", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const p = profile();
    const a = await connectAgent({ profile: p });
    const other = await connectAgent();
    await file(a.token, { tool: tool("npm:@acme/digest-feed", "3") });
    await file(other.token, { tool: tool("npm:@acme/digest-feed", "3"), outcome: "failed", issues: ["install_failed"], note: NOTE });

    const cookie = await webLogin(p);
    const dash = await (await fetchWorker("/dashboard", { headers: { Cookie: cookie } })).text();
    expect(dash).toContain("Weekly digest (feed)");
    expect(dash).toContain("No email");
    const csrf = /name="csrf" value="([^"]+)"/.exec(dash)![1]!;
    const made = await post("/dashboard/feed", cookie, { csrf });
    expect(made.status).toBe(200);
    expect(made.headers.get("Cache-Control")).toBe("no-store");
    const url = /(https?:\/\/[^\s<]+\/feed\/[A-Za-z0-9_-]{43}\.atom)/.exec(await made.text())![1]!;
    const token = /\/feed\/([A-Za-z0-9_-]{43})\.atom/.exec(url)![1]!;

    // Only the hash is stored.
    const [row] = await getDb(env).select().from(t.digestFeeds).where(eq(t.digestFeeds.humanId, a.human.id));
    expect(row!.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const feed = await fetchWorker(new URL(url).pathname);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("Content-Type")).toContain("application/atom+xml");
    expect(feed.headers.get("Cache-Control")).toContain("no-store");
    expect(feed.headers.get("Referrer-Policy")).toBe("no-referrer");
    const xml = await feed.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("npm:@acme/digest-feed");
    expect(xml).toContain("1 new report");
    expect(xml).not.toContain(NOTE);
    expect(xml).not.toContain(other.human.githubLogin);
    expect(xml).not.toContain(a.human.id);
    expect((xml.match(/<entry>/g) ?? []).length).toBe(4);

    // The dashboard says it's on, without showing the link again.
    const after = await (await fetchWorker("/dashboard", { headers: { Cookie: cookie } })).text();
    expect(after).toContain("Your feed is <strong>on</strong>");
    expect(after).not.toContain(token);

    // A new link stops the old one.
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(after)![1]!;
    const again = await post("/dashboard/feed", cookie, { csrf: csrf2 });
    const token2 = /\/feed\/([A-Za-z0-9_-]{43})\.atom/.exec(await again.text())![1]!;
    expect(token2).not.toBe(token);
    expect((await fetchWorker(`/feed/${token}.atom`)).status).toBe(404);
    expect((await fetchWorker(`/feed/${token2}.atom`)).status).toBe(200);

    // Turning it off.
    const off = await post("/dashboard/feed/revoke", cookie, { csrf: csrf2 });
    expect(off.status).toBe(303);
    expect((await fetchWorker(`/feed/${token2}.atom`)).status).toBe(404);
    // Without the CSRF token nothing happens.
    expect((await post("/dashboard/feed", cookie, { csrf: "wrong" })).status).toBe(403);
  });

  it("has helpers that round-trip and escape", async () => {
    const x = await connectAgent();
    const token = await createFeed(getDb(env), x.human.id);
    expect((await feedOwner(getDb(env), token))!.humanId).toBe(x.human.id);
    expect(await feedOwner(getDb(env), "short")).toBeNull();
    await revokeFeed(getDb(env), x.human.id);
    expect(await feedOwner(getDb(env), token)).toBeNull();
    const weeks = await ownerWeeks(env, getDb(env), x.human.id);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]!.current).toBe(true);
    const xml = atomFeed("https://x.io", "k", "https://x.io/feed/t.atom", [{ ...weeks[0]!, new_reports: [{ tool_id: "npm:<a>&b", page_url: "https://x.io/t/a", new_reports: 2, failed: 0 }] }], Date.now());
    expect(xml).toContain("npm:&amp;lt;a&amp;gt;&amp;amp;b");
    expect(xml).not.toContain("npm:<a>");
  });
});

// 25 Oct 2026: new ranked Arena results go in the digest, so an agent that checks its week learns of an event like
// Crucible 2 without anyone posting about it. Held events, Lab and practice events, embargoed models and old runs
// never count.
describe("new ranked Arena results in the digest", () => {
  async function arenaEvent(slug: string, kind: "card" | "guest" | "practice", status: "planned" | "running", arm: "card" | null = null) {
    const id = crypto.randomUUID();
    await getDb(env).insert(t.arenaEvents).values({ id, slug, name: `Event ${slug}`, season: "s0", kind, status, arm });
    return id;
  }
  async function arenaRun(eventId: string, modelId: string, ago: number) {
    await getDb(env).insert(t.arenaRuns).values({ id: crypto.randomUUID(), eventId, modelId, task: "refund-hard3", seed: 1, attemptNo: 1, status: "done", passed: true, score: 1, cost: 0, tokens: 0, result: {}, log: [], signature: "x", finishedAt: Date.now() - ago });
  }

  it("lists a published ranked event once, and never a held, Lab, practice or embargoed one", async () => {
    const pub = await arenaEvent("digest-ranked", "card", "running");
    await arenaRun(pub, "claude-sonnet-5.5", DAY);
    await arenaRun(pub, "gpt-6.1-sol", 2 * DAY);
    await arenaRun(pub, EMBARGOED.id, DAY);
    await arenaRun(pub, "gpt-6.1-sol", 9 * DAY);
    await arenaRun(await arenaEvent("digest-held", "card", "planned"), "claude-sonnet-5.5", DAY);
    await arenaRun(await arenaEvent("digest-lab", "card", "running", "card"), "claude-sonnet-5.5", DAY);
    await arenaRun(await arenaEvent("digest-practice", "practice", "running"), "claude-sonnet-5.5", DAY);
    await arenaRun(await arenaEvent("digest-embargoed-only", "guest", "running"), EMBARGOED.id, DAY);

    const now = Date.now();
    const got = await newArenaResults(env, getDb(env), now - 7 * DAY, now);
    expect(got).toEqual([
      { event: "digest-ranked", name: "Event digest-ranked", attempts: 2, models: 2, page_url: `${env.PUBLIC_ORIGIN}/arena/event/digest-ranked`, data_url: `${env.PUBLIC_ORIGIN}/arena/events/digest-ranked.json` },
    ]);

    // forge_me carries it, and so does the owner's feed (title and body).
    const a = await connectAgent();
    expect((await forgeMe(a.token)).structuredContent.since_last_week.new_arena_results).toEqual(got);
    const weeks = await ownerWeeks(env, getDb(env), a.human.id, now);
    // One entry per ISO week, so the 9-day-old run is in an earlier week's entry; the embargoed model's never is.
    const all = weeks.flatMap((w) => w.arena_results);
    expect(new Set(all.map((x) => x.event))).toEqual(new Set(["digest-ranked"]));
    expect(all.reduce((n, x) => n + x.attempts, 0)).toBe(3);
    const week = weeks.find((w) => w.arena_results.length)!;
    expect(weekTitle(week)).toContain("1 new Arena result");
    const xml = atomFeed("https://x.io", "k", "https://x.io/feed/t.atom", [week], now);
    expect(xml).toContain("Event digest-ranked");
    expect(xml).not.toContain("digest-held");
    expect(xml).not.toMatch(SHOWS_EMBARGOED);
  });
});
