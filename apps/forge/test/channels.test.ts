import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { startSprint } from "../src/arena/gauntlet";
import { addressTags, skillTag, skillTagKeys, startedViaKeys } from "../src/services/channel-tags";
import { CHANNELS, measurable, scoreboard, shareLoop, skillUse, type ChannelSpec, type Row } from "../src/services/channels";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { directoryLabel, visitCounters } from "../src/services/usage";
import { sprintAddCommands, SPRINT_HTTP_LINE, SPRINT_LINE } from "../src/web/sprint-picker";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, profile } from "./helpers";
import "../src/index";

// ADR 0133 (build plan 5 Nov, P2 items 8, 10, 11): the channel scoreboard with kill dates, the Sprint share loop and
// ClawHub install → use. Admin only; everything not attributable reads "not measurable".

const today = () => new Date().toISOString().slice(0, 10);
const count = async (key: string) => Number((await getDb(env).select({ n: t.usageDaily.n }).from(t.usageDaily).where(and(eq(t.usageDaily.day, today()), eq(t.usageDaily.key, key))))[0]?.n ?? 0);
const wait = () => new Promise((r) => setTimeout(r, 50));
const chan = (over: Partial<ChannelSpec>): ChannelSpec => ({ id: "x", name: "X", kind: "listing", status: "live", listed: "2026-10-22", review: "2026-11-19", signals: [], ...over });
const r = (day: string, key: string, n = 1): Row => ({ day, key, n });

describe("the channel list file", () => {
  it("has a review date on every listed channel (first reviews 19-21 Nov), unique ids and only known signal types", () => {
    const ids = CHANNELS.channels.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHANNELS.channels) {
      if (c.listed) expect(c.review, c.id).not.toBeNull();
      if (c.review) expect(c.review >= "2026-11-19", c.id).toBe(true);
      for (const s of c.signals) expect(["mcp_client", "install", "counter", "arrivals"], c.id).toContain(s.type);
      for (const x of c.external ?? []) expect(x.source.length, c.id).toBeGreaterThan(10);
    }
    expect(CHANNELS.channels.filter((c) => c.review).map((c) => c.review).sort()[0]).toBe("2026-11-19");
    // The task's channels are all on the list.
    for (const id of ["claude-code-plugin", "clawhub-check-before-install", "cli", "github-action-forge-check", "a2a", "chatgpt-app", "mcp-registry"]) expect(ids).toContain(id);
  });
});

describe("the scoreboard (pure)", () => {
  const mcpbeat = chan({ id: "monitor", signals: [{ type: "mcp_client", match: "^mcpbeat" }] });
  const cursor = chan({ id: "cursor", signals: [{ type: "mcp_client", match: "^cursor" }] });
  const plugin = chan({ id: "plugin", signals: [{ type: "install", client: "plugin" }] });
  const glama = chan({ id: "glama", signals: [{ type: "arrivals", label: "glama" }] });
  const rows: Row[] = [
    r("2026-11-18", "mcp:client:mcpbeat", 40),
    r("2026-11-19", "mcp:client:mcpbeat", 40),
    r("2026-11-15", "mcp:client:cursor", 2),
    r("2026-11-15", "mcp:clientcall:cursor", 1),
    r("2026-11-17", "install:checked:plugin", 5),
    r("2026-11-17", "install:ours:checked:plugin", 5),
    r("2026-11-19", "visit:dir:glama", 3),
  ];

  it("a monitor-only channel is marked stop at its review date; a channel with one real call is kept", () => {
    const [m, c] = scoreboard([mcpbeat, cursor], rows, [], "2026-11-19");
    expect(m).toMatchObject({ decision: "stop", use_since_listed: 0, first_seen: null, week: { calls: 0, sessions: 0 } });
    expect(c).toMatchObject({ decision: "keep", use_since_listed: 1, first_seen: "2026-11-15", week: { calls: 1, sessions: 2 } });
  });

  it("before the review date it is watching, and says how many days are left", () => {
    expect(scoreboard([mcpbeat], rows, [], "2026-11-12")[0]).toMatchObject({ decision: "watching", days_to_review: 7 });
  });

  it("install checks are outside only (ours taken off); new installs are outside install IDs first seen this week", () => {
    const [p] = scoreboard([plugin], [...rows, r("2026-11-16", "install:checked:plugin", 1)], [{ client: "plugin", firstDay: "2026-11-16", ours: false }, { client: "plugin", firstDay: "2026-11-16", ours: true }, { client: "cli", firstDay: "2026-11-16", ours: false }], "2026-11-19");
    expect(p).toMatchObject({ week: { install_checks: 1, new_installs: 1, calls: null, sessions: null, arrivals: null }, first_seen: "2026-11-16", decision: "keep" });
  });

  it("only our own install checks leave a plugin channel with no use", () => {
    expect(scoreboard([plugin], rows, [], "2026-11-19")[0]).toMatchObject({ week: { install_checks: 0, new_installs: 0 }, use_since_listed: 0, decision: "stop" });
  });

  it("a channel with only page arrivals is not measurable (arrivals are shown, never counted as use)", () => {
    const [g] = scoreboard([glama], rows, [], "2026-11-19");
    expect(g).toMatchObject({ measurable: false, decision: "not measurable", use_since_listed: null, week: { arrivals: 3, calls: null, install_checks: null } });
    expect(measurable(chan({ signals: [] }))).toBe(false);
  });

  // Review of ADR 0133: a tag that isn't live yet (skill 1.1.0 not yet on ClawHub or not yet released) must not read as
  // zero use, and a channel counted for less than four weeks can't be stopped at its review date.
  it("a channel whose use signal isn't live yet is not yet measured, never stopped", () => {
    const skill = chan({ id: "skill", listed: "2026-10-28", review: "2026-11-25", counted_from: null, signals: [{ type: "counter", prefix: "skilltag:forge-check-before-install@", what: "calls" }, { type: "arrivals", label: "clawhub" }] });
    const [x] = scoreboard([skill], rows, [], "2026-11-30");
    expect(x).toMatchObject({ decision: "not yet measured", use_since_listed: null, first_seen: null, counted_from: null, week: { calls: null, arrivals: 0 } });
    expect(x!.not_yet).toEqual(["calls"]);
  });

  it("the kill rule needs 28 full days of counting; use is counted from the later of listing and counting", () => {
    const live = (from: string) => chan({ id: "skill", listed: "2026-10-28", review: "2026-11-25", counted_from: from, signals: [{ type: "counter", prefix: "skilltag:forge-check-before-install@", what: "calls" }] });
    expect(scoreboard([live("2026-11-12")], rows, [], "2026-11-25")[0]).toMatchObject({ decision: "watching", use_since_listed: 0, counted_from: "2026-11-12", week: { calls: 0 } });
    expect(scoreboard([live("2026-11-12")], rows, [], "2026-12-09")[0]!.decision).toBe("stop");
    expect(scoreboard([live("2026-11-12")], [...rows, r("2026-11-20", "skilltag:forge-check-before-install@1.1.0:scan", 1)], [], "2026-11-25")[0]).toMatchObject({ decision: "keep", use_since_listed: 1 });
  });

  it("listing-site arrivals read 'not yet measured' until the first one is counted anywhere", () => {
    const [g] = scoreboard([glama], rows.filter((x) => !x.key.startsWith("visit:dir:")), [], "2026-11-19");
    expect(g).toMatchObject({ week: { arrivals: null }, not_yet: ["arrivals"] });
  });

  it("every skill-tag channel in the list says when its tag went live (null until it is)", () => {
    for (const c of CHANNELS.channels.filter((x) => x.signals.some((s) => s.type === "counter" && s.prefix.startsWith("skilltag:")))) expect(c.counted_from, c.id).not.toBeUndefined();
  });

  it("a channel with no review date says so instead of a decision", () => {
    expect(scoreboard([chan({ listed: null, review: null, signals: [{ type: "mcp_client", match: "^cursor" }] })], rows, [], "2026-11-19")[0]!.decision).toBe("no review date");
  });
});

describe("the share loop and skill use (pure)", () => {
  it("k = runs from a result page ÷ outside Sprints finished, and 'not yet measured' before any tag is seen", () => {
    expect(shareLoop([r("2026-11-18", "sprint:finished", 4)], "2026-11-19")).toMatchObject({ k: null, runs_from_result_page: null, share_link_arrivals: null, measured_since: null });
    const loop = shareLoop([r("2026-11-18", "sprint:finished", 4), r("2026-11-18", "sprint:started_via:sprint-result", 1), r("2026-11-19", "gauntlet:started_via:sprint-result", 1), r("2026-11-19", "visit:tag:sprint-share", 9), r("2026-11-01", "sprint:started_via:sprint-result", 5)], "2026-11-19");
    expect(loop).toMatchObject({ k: 0.5, runs_from_result_page: { sprint: 1, full: 1 }, share_link_arrivals: 9, sprints_finished_outside: 4, measured_since: "2026-11-01" });
    expect(loop.method).toMatch(/upper bound[\s\S]*lower bound/);
  });

  it("skill use lists tagged calls by version and endpoint, and calls per download only for a week the tag covered", () => {
    const rows = [r("2026-11-10", "skilltag:forge-check-before-install@1.1.0:scan", 3), r("2026-11-18", "skilltag:forge-check-before-install@1.1.0:check", 2)];
    const u = skillUse(rows, "2026-11-19", [{ date: "2026-10-31", value: 500, unit: "downloads", source: "ClawHub page" }, { date: "2026-11-19", value: 100, unit: "downloads", source: "ClawHub page" }]);
    expect(u.lines).toEqual([
      { skill: "forge-check-before-install", version: "1.1.0", endpoint: "check", week: 2, all_time: 2 },
      { skill: "forge-check-before-install", version: "1.1.0", endpoint: "scan", week: 0, all_time: 3 },
    ]);
    expect(u.downloads[0]).toMatchObject({ tagged_calls_same_week: null, calls_per_download: null });
    expect(u.downloads[1]).toMatchObject({ tagged_calls_same_week: 2, calls_per_download: 0.02 });
  });
});

describe("the tags", () => {
  it("reads only our skill names with a plain version, and never for our own callers or bots", () => {
    expect(skillTag("forge-check-before-install-1.1.0")).toEqual({ skill: "forge-check-before-install", version: "1.1.0" });
    for (const bad of ["forge-check-before-install", "someone-else-1.0.0", "forge-check-before-install-1.1.0;drop", "forge-run-the-gauntlet-1.2"]) expect(skillTag(bad), bad).toBeNull();
    expect(skillTagKeys("forge-run-the-gauntlet-1.2.0", "gauntlet-start")).toEqual(["skilltag:forge-run-the-gauntlet@1.2.0:gauntlet-start"]);
    expect(skillTagKeys("forge-run-the-gauntlet-1.2.0", "gauntlet-start", { internal: "house" })).toEqual([]);
    expect(skillTagKeys("forge-run-the-gauntlet-1.2.0", "gauntlet-start", { bot: true })).toEqual([]);
    expect(startedViaKeys("sprint-result", "sprint")).toEqual(["sprint:started_via:sprint-result"]);
    expect(startedViaKeys("sprint-share", "sprint")).toEqual([]);
    expect(addressTags("https://x.test/mcp/gauntlet?from=sprint-result&client=a")).toEqual({ client: "a", from: "sprint-result" });
  });

  it("the ClawHub skills carry their tag on every Forge address they call", async () => {
    const before = (await import("../../../integrations/skill/forge-check-before-install/SKILL.md")).default as string;
    const gauntlet = (await import("../../../integrations/skill/forge-run-the-gauntlet/SKILL.md")).default as string;
    for (const u of before.match(/https:\/\/theagentforge\.io\/api\/v1\/[^\s'`]+/g) ?? []) expect(u).toContain("client=forge-check-before-install-1.1.0");
    expect(before).toMatch(/^ {2}version: "1\.1\.0"$/m);
    expect(gauntlet).toContain("https://theagentforge.io/mcp/gauntlet?client=forge-run-the-gauntlet-1.2.0");
    expect(gauntlet).toContain("POST https://theagentforge.io/api/v1/gauntlet?client=forge-run-the-gauntlet-1.2.0");
    for (const md of [before, gauntlet]) expect(md).toMatch(/carries nothing about you/);
  });

  it("a click from a listing site counts as an arrival for that listing; other referrers add nothing", () => {
    expect(directoryLabel("https://glama.ai/mcp/servers/forge")).toBe("glama");
    expect(directoryLabel("https://clawhub.ai/skills/forge-check-before-install")).toBe("clawhub");
    expect(directoryLabel("https://example.com/")).toBeNull();
    const req = (referer: string) => ({ method: "GET", url: `${env.PUBLIC_ORIGIN}/scan`, headers: new Headers({ referer, "user-agent": "Mozilla/5.0 Firefox/150.0", "sec-fetch-mode": "navigate" }) });
    expect(visitCounters(req("https://www.lobehub.com/mcp/x"), env.PUBLIC_ORIGIN)).toContain("visit:dir:lobehub");
    expect(visitCounters(req("https://example.com/"), env.PUBLIC_ORIGIN).some((k) => k.startsWith("visit:dir:"))).toBe(false);
  });
});

describe("tagged calls are counted (Worker)", () => {
  it("a tagged check and scan count once each; a fake tag, our own tagged caller and a fake browser don't", async () => {
    const tag = "client=forge-check-before-install-1.1.0";
    const checkKey = "skilltag:forge-check-before-install@1.1.0:check";
    const scanKey = "skilltag:forge-check-before-install@1.1.0:scan";
    const [c0, s0] = [await count(checkKey), await count(scanKey)];
    const ip = { "CF-Connecting-IP": "198.51.100.71", "User-Agent": "curl/8.9" };
    expect((await fetchWorker(`/api/v1/check?${tag}&id=npm:channels-tag-test`, { headers: ip })).status).toBe(200);
    await fetchWorker(`/api/v1/check?client=nobody-1.0.0&id=npm:channels-tag-test`, { headers: ip });
    await fetchWorker(`/api/v1/check?${tag}&id=npm:channels-tag-test`, { headers: { ...ip, "X-Forge-Internal": "screens" } });
    await fetchWorker(`/api/v1/check?${tag}&id=npm:channels-tag-test`, { headers: { "CF-Connecting-IP": "198.51.100.72", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/150.0" } });
    const scan = await fetchWorker(`/api/v1/scan?${tag}`, { method: "POST", headers: { ...ip, "Content-Type": "application/json" }, body: JSON.stringify({ text: "---\nname: x\ndescription: Lists files.\n---\nLists the files.", name: "x" }) });
    expect(scan.status).toBe(200);
    await wait();
    expect(await count(checkKey)).toBe(c0 + 1);
    expect(await count(scanKey)).toBe(s0 + 1);
    expect(await count("skilltag:nobody@1.0.0:check")).toBe(0);
  });

  it("runs started from a Sprint result page's commands count, over HTTP and MCP; untagged starts don't", async () => {
    const via = "sprint:started_via:sprint-result";
    const full = "gauntlet:started_via:sprint-result";
    const skill = "skilltag:forge-run-the-gauntlet@1.2.0:gauntlet-start";
    const [v0, f0, k0] = [await count(via), await count(full), await count(skill)];
    const post = (q: string, body: unknown, n: number) =>
      fetchWorker(`/api/v1/gauntlet${q}`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${n}` }, body: JSON.stringify(body) });
    expect((await post("?from=sprint-result", { mode: "sprint" }, 80)).status).toBe(201);
    expect((await post("?from=sprint-result&client=forge-run-the-gauntlet-1.2.0", {}, 81)).status).toBe(201);
    expect((await post("", { mode: "sprint" }, 82)).status).toBe(201);
    const host = new URL(env.PUBLIC_ORIGIN).host;
    const mcp = await fetchWorker("/mcp/gauntlet?from=sprint-result", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: host, "CF-Connecting-IP": "198.51.100.83" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gauntlet_start", arguments: { mode: "sprint" } } }),
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("gauntlet_id");
    await wait();
    expect(await count(via)).toBe(v0 + 2);
    expect(await count(full)).toBe(f0 + 1);
    expect(await count(skill)).toBe(k0 + 1);
  });

  it("a cached tagged check replayed from one address counts at most 60 a minute (review of ADR 0133)", async () => {
    const key = "skilltag:forge-check-before-install@1.1.0:check";
    const go = () => fetchWorker("/api/v1/check?client=forge-check-before-install-1.1.0&id=npm:channels-tag-replay", { headers: { "CF-Connecting-IP": "198.51.100.77", "User-Agent": "curl/8.9" } });
    const before = await count(key);
    for (let i = 0; i < 75; i++) expect([200, 429]).toContain((await go()).status);
    await new Promise((res) => setTimeout(res, 500));
    const counted = (await count(key)) - before;
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThanOrEqual(60);
  });

  it("our own probes' Sprints are counted apart, so the share loop's denominator is outside runs only", async () => {
    const [s0, o0] = [await count("sprint:started"), await count("sprint:ours_started")];
    const res = await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.95", "User-Agent": "theagentforge-internal/sprint-smoke" }, body: JSON.stringify({ mode: "sprint" }) });
    expect(res.status).toBe(201);
    const { gauntlet_id: id } = (await res.json()) as { gauntlet_id: string };
    expect([await count("sprint:started"), await count("sprint:ours_started")]).toEqual([s0, o0 + 1]);
    const f0 = [await count("sprint:finished"), await count("sprint:ours_finished")];
    await fetchWorker(`/api/v1/gauntlet/${id}/act`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.95" }, body: JSON.stringify({ tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }) });
    expect([await count("sprint:finished"), await count("sprint:ours_finished")]).toEqual([f0[0], f0[1]! + 1]);
    // The flag is never shown on the public run page's JSON.
    const pub = await (await fetchWorker(`/gauntlet/r/${id}?format=json`)).text();
    expect(pub).toContain('"sprint"');
    expect(pub).not.toContain('"ours"');
  });

  it("a Sprint's share link is tagged, and its result page offers the tagged commands to people", async () => {
    const s = await startSprint(env, "198.51.100.90");
    if ("error" in s) throw new Error(s.error);
    const id = s.gauntlet_id;
    await fetchWorker(`/api/v1/gauntlet/${id}/act`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.90" }, body: JSON.stringify({ tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }) });
    const status = (await (await fetchWorker(`/api/v1/gauntlet/${id}`)).json()) as { report?: { share: { url: string } } };
    expect(status.report?.share.url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/r/${id}?from=sprint-share`);
    const page = await (await fetchWorker(`/gauntlet/r/${id}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("Try it on your agent (90 s)");
    expect(page).toContain(`${env.PUBLIC_ORIGIN}/mcp/gauntlet?from=sprint-result`);
    expect(page).toContain("POST /api/v1/gauntlet?from=sprint-result");
    expect(page).toContain(`/gauntlet/r/${id}?from=sprint-share`);
    // The ordinary picker and lines stay untagged.
    expect(sprintAddCommands(env.PUBLIC_ORIGIN)[0]!.command).toMatch(/\/mcp\/gauntlet$/);
    expect(SPRINT_LINE(env.PUBLIC_ORIGIN)).not.toContain("from=");
    expect(SPRINT_HTTP_LINE(env.PUBLIC_ORIGIN)).not.toContain("from=");
  });
});

describe("/admin/channels", () => {
  let admin = "";
  let someone = "";
  beforeAll(async () => {
    const db = getDb(env);
    const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
    admin = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
    const other = await upsertHuman(db, profile(), Date.now());
    someone = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, other.id)}`;
  });

  it("is founder-only, never cached or indexed", async () => {
    expect((await fetchWorker("/admin/channels.json")).status).toBe(403);
    expect((await fetchWorker("/admin/channels.json", { headers: { Cookie: someone } })).status).toBe(403);
    expect((await fetchWorker("/admin/channels", { headers: { Cookie: someone }, redirect: "manual" })).status).toBe(302);
    const res = await fetchWorker("/admin/channels.json", { headers: { Cookie: admin } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("shows every channel with its review date and decision, the share loop's method and the ClawHub rows", async () => {
    const d = (await (await fetchWorker("/admin/channels.json", { headers: { Cookie: admin } })).json()) as { channels: { id: string; decision: string; review: string | null }[]; share_loop: { week: { method: string } }; skill_use: { downloads: unknown[] } };
    expect(d.channels.map((c) => c.id)).toEqual(CHANNELS.channels.map((c) => c.id));
    expect(d.channels.find((c) => c.id === "glama")!.decision).toBe("not measurable");
    expect(d.share_loop.week.method).toContain("k = ");
    expect(d.skill_use.downloads).toHaveLength(CHANNELS.channels.find((c) => c.id === "clawhub-check-before-install")!.external?.length ?? 0);
    const html = await (await fetchWorker("/admin/channels", { headers: { Cookie: admin, Accept: "text/html" } })).text();
    for (const w of ["Channel scoreboard", "Sprint share loop (k-factor)", "ClawHub install → use", "not measurable", "2026-11-19"]) expect(html).toContain(w);
    expect(await (await fetchWorker("/admin/kpis", { headers: { Cookie: admin, Accept: "text/html" } })).text()).toContain('href="/admin/channels"');
  });
});
