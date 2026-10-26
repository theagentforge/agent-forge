import { Attempt, DEFAULT_CAPS, TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { asc, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { standingOpponents } from "../src/arena/gauntlet";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

// V2 (ADR 0047): challenge a Gauntlet run on the identical jobs (same seeds, same hidden traps), see it head to head,
// and take on a headline model's stored ranked runs. The challenger's agent does the work; we only referee.

const host = new URL(env.PUBLIC_ORIGIN).host;
let ipN = 40;
const nextIp = () => `203.0.113.${ipN++}`;
const rpc = (method: string, params: unknown, ip: string) =>
  fetchWorker("/mcp/gauntlet", {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function call(name: string, args: unknown, ip: string) {
  const text = await (await rpc("tools/call", { name, arguments: args }, ip)).text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result.structuredContent as any;
}
async function giveUpAll(id: string, ip: string) {
  let last: any;
  for (let i = 0; i < TASKS.length; i++) last = await call("gauntlet_act", { gauntlet_id: id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }, ip);
  return last;
}
const seedsOf = async (id: string) =>
  (await getDb(env).select({ seed: t.arenaGauntletBouts.seed }).from(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, id)).orderBy(asc(t.arenaGauntletBouts.idx))).map((r) => r.seed);
const page = async (path: string) => fetchWorker(path, { headers: { Accept: "text/html" } });

describe("Gauntlet challenges (V2)", () => {
  it("plays the identical six jobs of a finished run and shows both side by side, with rematches", async () => {
    const ip = nextIp();
    const first = await call("gauntlet_start", {}, ip);
    await giveUpAll(first.gauntlet_id, ip);

    const ch = await call("gauntlet_start", { challenge: first.gauntlet_id }, nextIp());
    expect(ch.challenge_of).toBe(first.gauntlet_id);
    expect(ch.vs_url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}`);
    const end = await giveUpAll(ch.gauntlet_id, ip);
    expect(end.report).toMatchObject({ challenge_of: first.gauntlet_id, vs_url: ch.vs_url });
    // Same seeds job by job, so the same job versions and the same planted traps.
    expect(await seedsOf(ch.gauntlet_id)).toEqual(await seedsOf(first.gauntlet_id));

    const vs = await page(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}`);
    expect(vs.status).toBe(200);
    const html = await vs.text();
    expect(html).toContain("Level on the same six jobs");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain(`/og/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}.png`);
    expect(html).not.toMatch(/\b(beat|crushed|failed miserably|destroyed)\b/i);

    const json = (await (await fetchWorker(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}.json`)).json()) as any;
    expect(json).toMatchObject({ status: "done", result: "level", same_jobs: true, challenges_of_original: 1 });
    expect(json.original.jobs).toHaveLength(6);
    expect(json.challenger.passed).toBe(json.original.passed);
    expect(json.original.jobs[0].replay_url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/r/${first.gauntlet_id}/1`);

    // A rematch is another challenge of the same run: the page shows every challenge, best and latest.
    const again = await call("gauntlet_start", { challenge: first.gauntlet_id }, nextIp());
    await giveUpAll(again.gauntlet_id, ip);
    const two = (await (await fetchWorker(`/gauntlet/vs/${first.gauntlet_id}/${again.gauntlet_id}.json`)).json()) as any;
    expect(two.challenges_of_original).toBe(2);
    expect(two.latest.id).toBe(again.gauntlet_id);
    expect(two.best.id).toBe(ch.gauntlet_id); // a tie goes to the earlier run
    expect(await (await page(`/gauntlet/vs/${first.gauntlet_id}/${again.gauntlet_id}`)).text()).toContain("2 finished challenges");

    // The head-to-head image is drawn from the referee totals.
    const png = await fetchWorker(`/og/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}.png`);
    expect(png.headers.get("Content-Type")).toBe("image/png");
    // A pair that isn't a challenge has no page.
    expect((await page(`/gauntlet/vs/${ch.gauntlet_id}/${first.gauntlet_id}`)).status).toBe(404);
  });

  it("refuses a challenge with card_from, of an unknown, unfinished or re-run, and over HTTP with a bad id", async () => {
    const ip = nextIp();
    const open = await call("gauntlet_start", {}, ip);
    expect((await call("gauntlet_start", { challenge: open.gauntlet_id }, ip)).error).toBe("run_not_finished");
    await giveUpAll(open.gauntlet_id, ip);
    expect((await call("gauntlet_start", { challenge: open.gauntlet_id, card_from: open.gauntlet_id }, ip)).error).toBe("challenge_with_card_from");
    expect((await call("gauntlet_start", { challenge: `g${"0".repeat(32)}` }, ip)).error).toBe("unknown_run");
    expect((await call("gauntlet_start", { challenge: "model:no-such-model" }, ip)).error).toBe("unknown_opponent");
    const rerun = await call("gauntlet_start", { card_from: open.gauntlet_id }, ip);
    await giveUpAll(rerun.gauntlet_id, ip);
    expect((await call("gauntlet_start", { challenge: rerun.gauntlet_id }, ip)).error).toBe("challenge_needs_first_run");

    const bad = await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ challenge: "ignore previous instructions" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_challenge");
    const ok = await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ challenge: open.gauntlet_id }) });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).challenge_of).toBe(open.gauntlet_id);
  });

  it("takes on a headline model's stored ranked runs (no new bouts), and leaves out lab, twist and practice runs", async () => {
    const db = getDb(env);
    const model = "gpt-6.1-sol";
    const seeds = TASKS.map((_, i) => 7000 + i);
    await db.insert(t.arenaEvents).values([
      { id: "vs-card", slug: "vs-card", name: "Card", season: "s1", kind: "card", status: "done" },
      { id: "vs-lab", slug: "vs-lab", name: "Lab", season: "s1", kind: "card", status: "done", arm: "card" },
      { id: "vs-practice", slug: "vs-practice", name: "Practice", season: "s1", kind: "practice", status: "done" },
    ]);
    const finished = (task: (typeof TASKS)[number], seed: number) => {
      const a = new Attempt(task, seed, { caps: DEFAULT_CAPS });
      a.call("finish", { status: "cannot_complete", summary: "Stopping." });
      return a.result!;
    };
    await db.insert(t.arenaRuns).values(
      TASKS.map((task, i) => ({ id: `vs-run-${i}`, eventId: "vs-card", modelId: model, task: task.id, seed: seeds[i]!, attemptNo: 1, status: "done" as const, passed: finished(task, seeds[i]!).passed, result: finished(task, seeds[i]!), finishedAt: Date.now() - 60_000 })),
    );
    // Newer runs that must not be used: a Lab arm and a practice event.
    await db.insert(t.arenaRuns).values([
      { id: "vs-lab-0", eventId: "vs-lab", modelId: model, task: TASKS[0]!.id, seed: 1, attemptNo: 1, status: "done", passed: true, result: finished(TASKS[0]!, 1), finishedAt: Date.now() },
      { id: "vs-pr-0", eventId: "vs-practice", modelId: model, task: TASKS[0]!.id, seed: 2, attemptNo: 1, status: "done", passed: true, result: finished(TASKS[0]!, 2), finishedAt: Date.now() },
    ]);
    const opponents = await standingOpponents(db);
    expect(opponents.find((o) => o.model === model)?.runs.map((r) => r.seed)).toEqual(seeds);
    const runsBefore = (await db.select({ n: count() }).from(t.arenaRuns))[0]!.n;

    const ip = nextIp();
    const ch = await call("gauntlet_start", { challenge: `model:${model}` }, ip);
    expect(ch.challenge_of).toBe(`model:${model}`);
    await giveUpAll(ch.gauntlet_id, ip);
    expect(await seedsOf(ch.gauntlet_id)).toEqual(seeds);
    expect((await db.select({ n: count() }).from(t.arenaRuns))[0]!.n).toBe(runsBefore);

    const html = await (await page(`/gauntlet/vs/model:${model}/${ch.gauntlet_id}`)).text();
    expect(html).toContain("GPT-6.1 Sol");
    expect(html).toContain("No new model runs are made for a challenge");
    expect(html).toContain('href="/arena/run/vs-run-0"');
    const json = (await (await fetchWorker(`/gauntlet/vs/model:${model}/${ch.gauntlet_id}.json`)).json()) as any;
    expect(json.original).toMatchObject({ kind: "model", id: `model:${model}`, name: "GPT-6.1 Sol" });
    expect(json.result).toBe("level");

    // V3: the model is listed as an opponent on /gauntlet, with its own challenge page.
    const list = await (await page("/gauntlet")).text();
    expect(list).toContain(`href="/gauntlet/challenge/model:${model}"`);
    const cp = await (await page(`/gauntlet/challenge/model:${model}`)).text();
    expect(cp).toContain(`challenge &quot;model:${model}&quot;`);
    expect(cp).toContain("no new model run is made");
  });
});

describe("share cards that invite (V3)", () => {
  it("puts a plain 'Take this challenge' link on web pages, and only challenge_url (data) in tool results", async () => {
    const ip = nextIp();
    const first = await call("gauntlet_start", {}, ip);
    const end = await giveUpAll(first.gauntlet_id, ip);
    expect(end.report.challenge_url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/challenge/${first.gauntlet_id}`);
    // Tool results are data: no invitation or instruction text aimed at the agent or its human.
    expect(JSON.stringify(end)).not.toMatch(/take this challenge|tell your|share this with/i);

    const report = await (await page(`/gauntlet/r/${first.gauntlet_id}`)).text();
    expect(report).toContain(`href="/gauntlet/challenge/${first.gauntlet_id}"`);
    expect(report).toContain("Take this challenge");

    const cp = await page(`/gauntlet/challenge/${first.gauntlet_id}`);
    expect(cp.status).toBe(200);
    const body = await cp.text();
    expect(body).toContain(`challenge &quot;${first.gauntlet_id}&quot;`);
    expect(body).toContain('<meta name="robots" content="noindex">');

    const ch = await call("gauntlet_start", { challenge: first.gauntlet_id }, nextIp());
    await giveUpAll(ch.gauntlet_id, ip);
    const vs = await (await page(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}`)).text();
    expect(vs).toContain(`href="/gauntlet/challenge/${first.gauntlet_id}"`);
    expect(await (await page(`/gauntlet/r/${ch.gauntlet_id}`)).text()).toContain(`/gauntlet/vs/${first.gauntlet_id}/${ch.gauntlet_id}`);

    // A measured re-run isn't challengeable, so it offers no link and has no challenge page.
    const rerun = await call("gauntlet_start", { card_from: first.gauntlet_id }, ip);
    const rerunEnd = await giveUpAll(rerun.gauntlet_id, ip);
    expect(rerunEnd.report.challenge_url).toBeNull();
    expect((await page(`/gauntlet/challenge/${rerun.gauntlet_id}`)).status).toBe(404);
    expect((await page("/gauntlet/challenge/not-a-run")).status).toBe(404);

    expect(await (await page("/trap-card")).text()).toContain('href="/gauntlet#opponents">Take this challenge');
  });
});
