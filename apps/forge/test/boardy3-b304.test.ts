import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import probeSrc from "../../../integrations/house/probe.mjs?raw";
import llms from "../public/llms.txt?raw";
import * as t from "../src/db/schema";
import { PUBLIC_ROW_MINIMUMS, ROWS_APPEAR_TEXT } from "../src/services/counters";
import { liveAgentCounts } from "../src/services/agent-funnel";
import { buyerPack } from "../src/services/data-room";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { installJson } from "../src/services/install-metrics";
import { GROSS_RULES, grossJson, STATS_RULES_VERSION } from "../src/services/public-stats";
import { FIELD_REPORTS_LABEL, HOUSE_METHOD_ANCHOR, HOUSE_METHOD_PATH } from "../src/services/site-pulse";
import { boardBlock, boardTitle } from "../src/web/home-wire";
import { EDITION } from "../src/reports/reliability-edition";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { smallRows, statsData } from "../src/web/stats";
import { HOUSE_SLOW_S, HOUSE_TEST_COUNT, HOUSE_TIMEOUT_S } from "../src/web/static-pages";
import { connectAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

// B3-04 and B3-06 (ADR 0099, Boardy round 3; Dinike 29 Oct: "Hide small rows"). Small gross rows on /stats are left out
// until they pass a published minimum (no "none yet", no note); the big totals are unchanged; /admin/kpis and the data
// room still show every row. Threshold wording that told a reader how few outside owners there are is gone. The
// field-report total says most of it is our House agent's nightly install tests, with the method at /methodology.

let n = 0;
const u = () => `${Date.now()}-${++n}`;
const page = async (path: string, cookie = "") => (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}u=${u()}`, { headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) } })).text();
const json = async <T>(path: string) => (await (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}u=${u()}`)).json()) as T;
const count = async (q: string) => Number((await env.DB.prepare(q).first<{ n: number }>())!.n);

async function addHumans(k: number) {
  const db = getDb(env);
  for (let i = 0; i < k; i++) await db.insert(t.humans).values({ id: crypto.randomUUID(), githubId: 800_000_000 + Math.floor(Math.random() * 99_999_999), githubLogin: `b304-${u()}`, githubCreatedAt: 0, tier: "sandbox" });
}
async function addGauntlets(k: number, mode: "full" | "sprint") {
  const db = getDb(env);
  for (let i = 0; i < k; i++) await db.insert(t.arenaGauntlets).values({ id: crypto.randomUUID(), status: "done", current: 6, mode, startedAt: Date.now() - 60_000, finishedAt: Date.now() });
}
async function setInstall(key: string, v: number) {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO usage_daily (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = excluded.n").bind(day, key, v).run();
}

type Stats = Awaited<ReturnType<typeof statsData>>;
let adminCookie = "";

beforeAll(async () => {
  const founder = await upsertHuman(getDb(env), profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
  adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
});

describe("B3-04: small /stats rows are left out until they pass the minimum", () => {
  it("publishes Dinike's minimums", () => {
    expect(PUBLIC_ROW_MINIMUMS).toEqual({ gauntlet_runs_finished: 25, gauntlet_sprints_finished: 25, signed_in_people: 50, signed_in_agents: 50, install_checks: 25 });
  });

  it("the JSON builders drop a row below its minimum and keep one at it; allRows keeps every row", () => {
    const g = (people: number, agents: number) => ({ signed_in_people: people, signed_in_agents: agents, ai_tool_calls_7d: 3, skill_checks_7d: 2 });
    expect(grossJson(g(4, 3)).items.map((i) => i.key)).toEqual(["ai_tool_calls_7d", "skill_checks_7d"]);
    expect(grossJson(g(50, 49)).items.map((i) => i.key)).toEqual(["signed_in_people", "ai_tool_calls_7d", "skill_checks_7d"]);
    expect(grossJson(g(4, 3), "", { allRows: true }).items.map((i) => i.key)).toEqual(GROSS_RULES.map((r) => r.key));
    // The 7-day numbers have no minimum, exactly as before.
    expect(grossJson(g(0, 0)).items.find((i) => i.key === "skill_checks_7d")!.value).toBe(2);
    const zero = { checked: 0, blocked: 0, advisory: 0 };
    const v = { days: 7, gross: { all_time: { checked: 25, blocked: 24, advisory: 0 }, last_7_days: { checked: 24, blocked: 3, advisory: 0 } }, ours: { all_time: zero, last_7_days: zero }, by_client: {} as never };
    expect(installJson(v).items.map((i) => i.key)).toEqual(["install_checked_all"]);
    expect(installJson(v, "", { allRows: true }).items).toHaveLength(6);
  });

  it("below the minimum: absent from /stats, /stats.json, /api/v1/stats and the home band, with no 'none yet' and no note", async () => {
    const people = await count("SELECT count(*) AS n FROM humans");
    const runs = await count("SELECT count(*) AS n FROM arena_gauntlets WHERE status = 'done' AND mode = 'full'");
    const sprints = await count("SELECT count(*) AS n FROM arena_gauntlets WHERE status = 'done' AND mode = 'sprint'");
    expect(people).toBeLessThan(50);
    expect(runs).toBeLessThan(25);
    expect(sprints).toBeLessThan(25);
    await setInstall("install:checked:cli", 7);
    await setInstall("install:blocked:cli", 2);

    const html = await page("/stats");
    for (const k of ["signed_in_people", "signed_in_agents", "gauntlet_runs_finished", "gauntlet_sprints_finished"]) expect(html, k).not.toContain(`data-k="${k}"`);
    expect(html).not.toContain('id="install"');
    expect(html).not.toMatch(/data-k="install_/);
    expect(html).not.toContain("Gauntlet runs finished");
    expect(html).not.toContain("People signed in");
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    expect(main).not.toMatch(/\bhidden\b|below the minimum|appear once|below \d+|under \d+/i);
    // The big totals are still there, exactly as before.
    for (const k of ["bouts_refereed", "traps_sprung", "skills_scanned", "field_reports_all", "tools_tracked", "page_views_total", "ai_tool_calls_7d", "skill_checks_7d"]) expect(html, k).toContain(`data-k="${k}"`);

    const s = await json<Stats>("/stats.json");
    expect(s.gross.items.map((i) => i.key)).toEqual(["ai_tool_calls_7d", "skill_checks_7d"]);
    expect(s.install.items).toEqual([]);
    expect("gauntlet_runs_finished" in s.blended).toBe(false);
    expect("gauntlet_sprints_finished" in s.blended).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/below_minimum|hidden_rows/);
    const api = await json<{ gross: { items: { key: string }[] } }>("/api/v1/stats");
    expect(api.gross.items.map((i) => i.key)).toEqual(["ai_tool_calls_7d", "skill_checks_7d"]);
    // Review (ADR 0105): no trace of the hidden total either: no key, no null item, no hidden placeholder.
    const live = await json<Record<string, unknown>>("/agents/live.json");
    expect(live).not.toHaveProperty("install_checks_total");
    expect(s.totals.items.some((i) => i.key === "install_checks_total")).toBe(false);
    expect(JSON.stringify(s)).not.toContain("install_checks_total");
    expect(JSON.stringify(api)).not.toContain("install_checks_total");
    const homeJson = await json<{ stats: { totals: { items: { key: string }[] } } }>("/?format=json");
    expect(JSON.stringify(homeJson)).not.toContain("install_checks_total");
    const home = await page("/");
    expect(home).not.toContain('data-k="install_checks_total"');
    expect(await page("/about")).not.toMatch(/install checks</);
    // The reliability report's edition JSON names no hidden row (no null entry for Gauntlet runs).
    const edition = JSON.stringify(await json(EDITION.json));
    expect(edition).not.toContain("gauntlet_runs");
    expect(edition).not.toContain("Gauntlet runs finished");
  });

  it("the admin view and the data room still show every row, with exact values", async () => {
    const rows = await smallRows(env);
    expect(rows.map((r) => r.key)).toEqual([
      "gauntlet_runs_finished",
      "gauntlet_sprints_finished",
      "signed_in_people",
      "signed_in_agents",
      "install_checked_7d",
      "install_checked_all",
      "install_blocked_7d",
      "install_blocked_all",
      "install_advisory_7d",
      "install_advisory_all",
    ]);
    expect(rows.find((r) => r.key === "signed_in_people")).toMatchObject({ value: await count("SELECT count(*) AS n FROM humans"), minimum: 50, shown: false });
    expect(rows.find((r) => r.key === "install_checked_all")).toMatchObject({ value: 7, shown: false });
    const admin = await page("/admin/kpis", adminCookie);
    for (const r of rows) expect(admin, r.key).toContain(`data-small-row="${r.key}"`);
    const pack = await buyerPack(env);
    expect(pack.kpis.gross!.people_and_7_days.map((i) => i.key)).toEqual(GROSS_RULES.map((r) => r.key));
    expect(pack.kpis.gross!.install.items).toHaveLength(6);
    const full = await statsData(env, { allRows: true });
    expect(full.blended.gauntlet_runs_finished).toBe(await count("SELECT count(*) AS n FROM arena_gauntlets WHERE status = 'done' AND mode = 'full'"));
  });

  it("at the minimum: each row appears by itself, with its exact gross value", async () => {
    await addHumans(50 - (await count("SELECT count(*) AS n FROM humans")));
    await addGauntlets(25 - (await count("SELECT count(*) AS n FROM arena_gauntlets WHERE status = 'done' AND mode = 'full'")), "full");
    await addGauntlets(25 - (await count("SELECT count(*) AS n FROM arena_gauntlets WHERE status = 'done' AND mode = 'sprint'")), "sprint");
    await setInstall("install:checked:cli", 25);
    const s = await json<Stats>("/stats.json");
    expect(s.gross.items.find((i) => i.key === "signed_in_people")!.value).toBe(50);
    expect(s.gross.items.some((i) => i.key === "signed_in_agents")).toBe(false);
    expect(s.blended.gauntlet_runs_finished).toBe(25);
    expect(s.blended.gauntlet_sprints_finished).toBe(25);
    expect(s.install.items.map((i) => i.key)).toEqual(["install_checked_7d", "install_checked_all"]);
    expect(s.totals.items.find((i) => i.key === "install_checks_total")?.value).toBe(25);
    const html = await page("/stats");
    expect(html).toMatch(/<tr data-k="signed_in_people"><td>[^<]*<\/td><td class="num">50<\/td>/);
    expect(html).toMatch(/<tr data-k="gauntlet_runs_finished"><td>[^<]*<\/td><td class="num">25<\/td>/);
    expect(html).toMatch(/<tr data-k="install_checked_all"><td>[^<]*<\/td><td class="num">25<\/td>/);
    expect(html).not.toContain('data-k="install_blocked_all"');
    // /agents/live.json is edge-cached for 30 s, so read its source directly.
    expect((await liveAgentCounts(env)).install_checks_total).toBe(25);
  });

  it("the counting rules publish each minimum and say rows appear once they pass it", async () => {
    const html = await page("/stats/rules");
    expect(html).toContain('id="minimums"');
    expect(html).toContain(ROWS_APPEAR_TEXT);
    expect(ROWS_APPEAR_TEXT).toBe("Rows appear once they pass the minimum.");
    for (const m of ["Gauntlet runs finished 25", "Gauntlet Sprints finished 25", "people signed in 50", "agents linked to a signed-in person 50", "each install-check row 25"]) expect(html, m).toContain(m);
    const r = await json<{ version: string; minimums: Record<string, number>; rows_appear: string; rules: { key: string; minimum: number | null }[] }>("/stats/rules?format=json");
    expect(r.version).toBe(STATS_RULES_VERSION);
    expect(r.minimums).toEqual(PUBLIC_ROW_MINIMUMS);
    expect(r.rows_appear).toBe(ROWS_APPEAR_TEXT);
    const min = Object.fromEntries(r.rules.map((x) => [x.key, x.minimum]));
    expect(min).toMatchObject({ gauntlet_runs_finished: 25, gauntlet_sprints_finished: 25, signed_in_people: 50, signed_in_agents: 50, install_checked_all: 25, install_blocked_7d: 25, bouts_refereed: null, field_reports_all: null, ai_tool_calls_7d: null });
  });
});

describe("B3-04: no threshold wording that counts outside owners", () => {
  it("/agents, /agents.json and llms.txt say 'opening soon'; the gate is unchanged", async () => {
    const agents = await page("/agents");
    expect(agents).toContain("opening soon");
    expect(agents).not.toMatch(/outside|10 owners|opens once/i);
    const j = await json<Record<string, unknown>>("/agents.json");
    expect(j).toEqual({ status: "opening_soon" });
    const line = llms.split("\n").find((l) => l.startsWith("- [Agent index]"))!;
    expect(line).toContain("opening soon");
    expect(llms).not.toMatch(/outside owners|people outside the project|opens once 10/i);
  });

  it("/founding says 'Our first 100 owners', in the page and its meta description", async () => {
    const f = await page("/founding");
    expect(f).toContain("Our first 100 owners");
    expect(f).not.toMatch(/outside the project/i);
    expect(/<meta name="description" content="([^"]*)"/.exec(f)![1]).toMatch(/^Our first 100 owners/);
  });
});

describe("B3-04: the home chart's heading carries its date range", () => {
  it("puts {since}–{until} in the heading", () => {
    expect(boardTitle({ since: "2026-10-15", until: "2026-10-29" })).toBe("Which AI falls for it? (2026-10-15–2026-10-29)");
    expect(boardTitle({ since: null, until: null })).toBe("Which AI falls for it?");
    const row = (name: string) => ({ model: name, name, runs: 40, fell: 4, rate: 0.1 });
    const out = String(boardBlock({ rows: [row("a"), row("b"), row("c")], runs: 120, ranked: 100, practice: 20, rules_versions: [], since: "2026-10-15", until: "2026-10-29" } as never));
    expect(out).toContain('<h2 id="board-title">Which AI falls for it? (2026-10-15–2026-10-29)</h2>');
  });
});

describe("B3-06: field reports say what most of them are", () => {
  it("the label reads the same on /about, /stats and /stats.json, and the home band keeps the House caption by the number, linked to the method", async () => {
    expect(FIELD_REPORTS_LABEL).toBe("field reports filed (most are our House agent's nightly install tests)");
    expect(HOUSE_METHOD_PATH).toBe("/methodology#house-install-tests");
    // A readable report, so the total is above zero and shows.
    const { token } = await connectAgent();
    expect((await postReport(token, report({ tool: { kind: "mcp_server", id: `npm:b304-${n}`, version: "1.0.0", fingerprint: fp("b") } }))).status).toBeLessThan(300);
    const linked = `field reports filed (<a href="${HOUSE_METHOD_PATH}">most are our House agent&#39;s nightly install tests</a>)`;
    const unq = (x: string) => x.replace(/&#39;|&#x27;/g, "'");
    const home = unq(await page("/"));
    // Coordinator review, 29 Oct: the home band uses the short label with the House caption in the same stat item.
    expect(home).toMatch(/<li data-k="field_reports"><b>[\d,]+<\/b><span>field reports filed<\/span><a class="stat-note" href="\/methodology#house-install-tests">mostly our House install tests<\/a><\/li>/);
    expect(unq(await page("/about"))).toContain(unq(linked));
    expect(unq(await page("/stats"))).toContain(unq(`Field reports filed (<a href="${HOUSE_METHOD_PATH}">most are our House agent's nightly install tests</a>)`));
    const s = await json<Stats>("/stats.json");
    const item = s.totals.items.find((i) => i.key === "field_reports")! as { label: string; value: number | null; method_url?: string };
    expect(item.label).toBe(FIELD_REPORTS_LABEL);
    expect(item.value).toBeGreaterThan(0);
    expect(item.method_url).toBe(`${env.PUBLIC_ORIGIN}${HOUSE_METHOD_PATH}`);
  });

  it("/methodology has the House install-test method, matching integrations/house/probe.mjs, and the false sentence is gone", async () => {
    const m = unescape((await page("/methodology")).replace(/&#39;|&#x27;/g, "'"));
    expect(m).toContain(`id="${HOUSE_METHOD_ANCHOR}"`);
    for (const s of ["npx", "new, empty folder", "no credentials", "initialize", "tools/list", "Worked", "Partial", "Failed", "Skipped, never reported"]) expect(m, s).toContain(s);
    expect(m).not.toMatch(/left out of the signed-in people and agent counts/);
    expect(m).not.toMatch(/leave House and founder accounts out/);
    // The numbers on the page are the probe's own constants.
    expect(Number(/PROBE_TIMEOUT_MS = (\d[\d_]*)/.exec(probeSrc)![1]!.replace(/_/g, "")) / 1000).toBe(HOUSE_TIMEOUT_S);
    expect(Number(/SLOW_MS = (\d[\d_]*)/.exec(probeSrc)![1]!.replace(/_/g, "")) / 1000).toBe(HOUSE_SLOW_S);
    expect(probeSrc).toMatch(/"-y", `\$\{pkg\}@\$\{version\}`/);
    expect(probeSrc).toContain('method: "tools/list"');
    expect(probeSrc).toContain("mkdtempSync");
    // Review (ADR 0105): the time limit and "slow" run from before npx starts, so they include the install.
    const hs = probeSrc.slice(probeSrc.indexOf("export function handshake"));
    // ADR 0108: npx or uvx (launcher), still spawned after the clock starts.
    expect(hs.indexOf("const started = Date.now()")).toBeGreaterThan(-1);
    expect(hs.indexOf("const started = Date.now()")).toBeLessThan(hs.indexOf("spawn(cmd, argv"));
    expect(hs).toContain("setTimeout(finish, timeoutMs)");
    expect(m).toContain(`The whole test, install included, gets up to ${HOUSE_TIMEOUT_S} seconds`);
    expect(m).not.toContain("tools/list</code> failed");
    expect(probeSrc).toMatch(/const count = Number\(rest\[0\] \?\? (\d+)\)/);
    expect(Number(/const count = Number\(rest\[0\] \?\? (\d+)\)/.exec(probeSrc)![1])).toBe(HOUSE_TEST_COUNT);
  });

  it("the dashboard no longer says House is left out of /stats", async () => {
    const src = (await import("../src/web/dashboard.ts?raw")).default as string;
    expect(src).not.toContain("left out of every proof number on /stats");
  });
});
