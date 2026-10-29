import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { bucketOf, complete, PUBLIC_NUMBERS_SECONDS, publicNumbers, publicNumbersCache, secondsLeft } from "../src/services/public-numbers";
import { PUBLIC_ROW_MINIMUMS } from "../src/services/counters";
import { statsData } from "../src/web/stats";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0116: on 29 Oct /stats showed 5,397 bouts and 48,164 tools while /dataset showed 5,434 and 49,711. Both ran the
// same queries, each at its own moment, behind its own 60-second page cache. Now every page and twin with the running
// totals reads one snapshot per clock minute, and is cached no longer than the snapshot. This file checks every number
// that appears on more than one of /stats, /stats.json, /dataset, /dataset.json, the home band, /agents/live.json,
// /about and /api/v1/stats is the same everywhere, including after new rows arrive mid-minute.

const uid = (n: number) => `00000000-0000-4000-9116-${String(n).padStart(12, "0")}`;
let n = 1;
const EVENT = uid(0);

async function addBout(trapSprung: boolean) {
  const id = uid(n++);
  const result = { passed: !trapSprung, reason: "finished", traps: [{ id: "t1", triggered: trapSprung }] };
  await getDb(env).insert(t.arenaRuns).values({ id, eventId: EVENT, modelId: "claude-sonnet-5.5", task: "refund", seed: 1_000_000 + n, attemptNo: 1, status: "done", passed: !trapSprung, score: 0.5, cost: 0.001, tokens: 10, result: result as never, log: [] as never, finishedAt: Date.now() });
}
async function addTool() {
  await getDb(env).insert(t.tools).values({ id: uid(5000 + n), kind: "mcp_server", canonicalId: `npm:adr-0116-${n++}` });
}

type Nums = Record<string, number | null>;
const num = (s: string) => Number(s.replace(/,/g, ""));
const bust = () => `r=${Date.now()}-${Math.random()}`;
const text = async (path: string) => (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();
const json = async <T>(path: string) => (await (await fetchWorker(path, { headers: { Accept: "application/json" } })).json()) as T;
/** Keys a page uses for the same number under another name. */
const ALIAS: Record<string, string> = { field_reports_all: "field_reports" };
const key = (k: string) => ALIAS[k] ?? k;

/** Every running total each page and twin shows, by key. */
async function readAll(): Promise<Record<string, Nums>> {
  const q = bust();
  type Stats = { as_of: string; blended: { work: Nums | null; traffic: Nums | null; gauntlet_runs_finished?: number | null }; totals: { items: { key: string; value: number | null }[] } };
  const statsJson = await json<Stats>(`/stats.json?${q}`);
  const dataset = await json<{ as_of: string; contents: { bouts: Record<string, number | null>; field_reports: { total: number | null }; skill_scans: { distinct_skill_files_scanned: number | null }; tools_with_a_page: number | null } }>(`/dataset.json?${q}`);
  const live = await json<{ as_of: string; work: Nums | null } & Nums>(`/agents/live.json`);
  const api = await json<{ as_of: string; tools: number }>(`/api/v1/stats`);
  const out: Record<string, Nums> = {};
  out["/stats.json"] = { ...statsJson.blended.work, ...statsJson.blended.traffic, ...("gauntlet_runs_finished" in statsJson.blended ? { gauntlet_runs_finished: statsJson.blended.gauntlet_runs_finished ?? null } : {}) };
  out["/stats.json totals"] = Object.fromEntries(statsJson.totals.items.map((i) => [i.key, i.value]));
  const b = dataset.contents.bouts;
  out["/dataset.json"] = {
    bouts_refereed: b.refereed_practice_included ?? null,
    ranked_bouts: b.of_them_ranked ?? null,
    traps_sprung: b.traps_sprung ?? null,
    ...("gauntlet_runs_finished" in b ? { gauntlet_runs_finished: b.gauntlet_runs_finished ?? null } : {}),
    field_reports: dataset.contents.field_reports.total,
    skills_scanned: dataset.contents.skill_scans.distinct_skill_files_scanned,
    tools_tracked: dataset.contents.tools_with_a_page,
  };
  out["/agents/live.json"] = { ...live.work, page_views_total: live.page_views_total ?? null, agent_visits_total: live.agent_visits_total ?? null, agent_connections_total: live.agent_connections_total ?? null, agent_tool_uses_total: live.agent_tool_uses_total ?? null };
  delete out["/agents/live.json"].last_bout_at;
  delete out["/agents/live.json"].last_report_at;
  delete out["/agents/live.json"].last_tool_at;
  delete out["/agents/live.json"].last_scan_at;
  out["/api/v1/stats"] = { tools_tracked: api.tools || null };
  // HTML pages: /stats and /dataset rows carry data-k; the home band's items carry data-k; /about links each to its rule.
  const rows = (html: string, re: RegExp) => Object.fromEntries([...html.matchAll(re)].map((m) => [key(m[1]!), /\d/.test(m[2]!) ? num(m[2]!) : null]));
  out["/stats"] = rows(await text(`/stats?${q}`), /<tr data-k="([a-z_]+)"><td>.*?<\/td><td class="num">([^<]*)<\/td>/g);
  out["/dataset"] = rows(await text(`/dataset?${q}`), /<tr data-k="([a-z_]+)"><td>.*?<\/td><td class="num" data-v="([^"]*)">/g);
  out["home band"] = rows(await text(`/?${q}`), /<li data-k="([a-z_]+)"><b>([\d,]*)<\/b>/g);
  out["/about"] = rows(await text(`/about?${q}`), /<a href="[^"]*\/stats\/rules#([a-z_]+)"><b>([\d,]+)<\/b>/g);
  const asOf = new Set([statsJson.as_of, dataset.as_of, live.as_of, api.as_of]);
  expect(asOf.size, [...asOf].join(" ")).toBe(1);
  return out;
}

/** For every key that appears in more than one source, every source has the same value. Returns the keys compared. */
function expectAgree(all: Record<string, Nums>) {
  const byKey = new Map<string, [string, number | null][]>();
  for (const [src, nums] of Object.entries(all)) for (const [k, v] of Object.entries(nums)) byKey.set(k, [...(byKey.get(k) ?? []), [src, v]]);
  const shared = [...byKey].filter(([, vs]) => vs.length > 1);
  for (const [k, vs] of shared) expect(new Set(vs.map(([, v]) => v)).size, `${k}: ${JSON.stringify(vs)}`).toBe(1);
  return new Map(shared.map(([k, vs]) => [k, vs.map(([s]) => s)]));
}

/** Waits until at least `s` seconds are left in the clock minute, so a check can't straddle two snapshots. */
async function roomInMinute(s = 20) {
  const left = PUBLIC_NUMBERS_SECONDS - ((Date.now() / 1000) % PUBLIC_NUMBERS_SECONDS);
  if (left < s) await new Promise((r) => setTimeout(r, left * 1000 + 250));
}

beforeAll(async () => {
  publicNumbersCache.enabled = true;
  await getDb(env).insert(t.arenaEvents).values({ id: EVENT, slug: "adr-0116", name: "ADR 0116", season: "s0", kind: "card", status: "done" });
  for (let i = 0; i < 4; i++) await addBout(i % 2 === 0);
  for (let i = 0; i < 3; i++) await addTool();
});
afterAll(() => {
  publicNumbersCache.enabled = false;
});

describe("one snapshot of the public totals (ADR 0116)", () => {
  it("every number on /stats, /dataset, the home band, /about and their JSON twins agrees, even after new rows mid-minute", async () => {
    await roomInMinute();
    const first = await readAll();
    const compared = expectAgree(first);
    // The numbers the 29 Oct report found apart, and the others shared, are each on several pages.
    for (const k of ["bouts_refereed", "ranked_bouts", "traps_sprung", "tools_tracked"]) {
      expect(compared.get(k), k).toEqual(expect.arrayContaining(["/stats", "/stats.json", "/dataset", "/dataset.json", "home band", "/about", "/agents/live.json"].filter((s) => (k !== "ranked_bouts" || !["home band", "/about"].includes(s)) && (k === "bouts_refereed" || s !== "/about"))));
      // Site audit 29 Oct (§3.9): /about shows two totals (bouts refereed, skills scanned) and links to /stats for the rest.
    }
    expect(compared.get("tools_tracked")).toContain("/api/v1/stats");
    expect(first["/stats.json"]!.bouts_refereed).toBeGreaterThanOrEqual(4);
    expect(first["/stats.json"]!.tools_tracked).toBeGreaterThanOrEqual(3);

    // New bouts and tools arrive within the minute: every page still shows the one snapshot, so none can disagree.
    await addBout(true);
    await addTool();
    const second = await readAll();
    expectAgree(second);
    expect(second["/dataset.json"]).toEqual(first["/dataset.json"]);
    expect(second["/stats"]).toEqual(first["/stats"]);

    // The next minute's snapshot counts them, for every page at once.
    const next = await publicNumbers(env, bucketOf(Date.now()) + PUBLIC_NUMBERS_SECONDS * 1000);
    expect(next.work!.bouts_refereed).toBe(first["/stats.json"]!.bouts_refereed! + 1);
    expect(next.work!.tools_tracked).toBe(first["/stats.json"]!.tools_tracked! + 1);
  });

  it("pages with the totals are cached no longer than their snapshot, and say when it was counted", async () => {
    await roomInMinute(5);
    const snap = await publicNumbers(env);
    for (const path of ["/stats", "/dataset", "/about", "/", "/stats.json", "/dataset.json"]) {
      const res = await fetchWorker(`${path}?${bust()}`, { headers: { Accept: path.endsWith(".json") ? "application/json" : "text/html" } });
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1]);
      expect(maxAge, path).toBeGreaterThan(0);
      expect(maxAge, path).toBeLessThanOrEqual(secondsLeft(snap) + 1);
      if (!path.endsWith(".json")) expect(await res.text(), path).toContain(`data-as-of="${snap.as_of}"`);
    }
    // The home band says when it was counted, in so many words (review of ADR 0116).
    expect(await text(`/?${bust()}`)).toContain(`Counted at ${snap.as_of.slice(11, 16)} UTC.`);
  });

  it("a snapshot with a failed read is never kept for the minute (review of ADR 0116)", async () => {
    // A minute far from now, so nothing else has stored it; the D1 binding fails every query.
    const at = Date.UTC(2031, 0, 1, 0, 0, 30);
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); }, batch: () => Promise.reject(new Error("D1 down")) } } as unknown as Env;
    const bad = await publicNumbers(broken, at);
    expect(complete(bad)).toBe(false);
    expect(bad.work).toBeNull();
    // The next request in the same minute counts again, from the working database.
    const good = await publicNumbers(env, at + 1000);
    expect(complete(good)).toBe(true);
    expect(good.work!.bouts_refereed).toBeGreaterThanOrEqual(4);
    // And once a complete one is stored, a later count in the minute reads it back (first stored wins).
    await addBout(false);
    const again = await publicNumbers(env, at + 2000);
    expect(again).toEqual(good);
  });

  it("small rows stay hidden with the snapshot on: below its minimum the Gauntlet row's key is absent", async () => {
    const d = await statsData(env);
    const runs = (await publicNumbers(env)).gauntlet.full ?? 0;
    expect(runs).toBeLessThan(PUBLIC_ROW_MINIMUMS.gauntlet_runs_finished);
    expect("gauntlet_runs_finished" in d.blended).toBe(false);
    expect(JSON.stringify(d)).not.toContain("gauntlet_runs_finished\":");
  });

  it("the snapshot is not reachable from a public URL", async () => {
    const snap = await publicNumbers(env);
    const res = await fetchWorker(`/admin/__public-numbers/${snap.bucket}`, { headers: { Accept: "application/json" }, redirect: "manual" });
    expect(res.status).not.toBe(200);
  });
});
