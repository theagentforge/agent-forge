import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { storeRun, storeSweep, weekOfTests } from "../src/services/house-report";
import { fetchWorker } from "./helpers";
import "../src/index";

// Weekly brief 9 Nov: at 03:32 UTC /reports/house said the sweep "has run on 6 of the last 7 days" while the census
// series had a sweep row for each of the 7 days (2 to 8 Nov). The window counted today, whose sweep runs later in the
// morning. The 7 days now end yesterday until today's sweep has run.

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const entry = (pkg: string) => ({ pkg, version: "1.0.0", outcome: "worked", slow: false, tools: 2, ms: 4000, downloads: null, rank: null });
const sweepOn = (ms: number, pkg: string) => storeSweep(env, { probedAt: new Date(ms).toISOString(), entries: [entry(pkg)] });

describe("the House sweep's 7 days", () => {
  it("a week with every sweep run reads 7 of 7 before today's sweep, and moves to today once it runs", async () => {
    const today = Date.parse("2027-03-10T03:32:00Z");
    for (let i = 1; i <= 7; i++) expect((await sweepOn(today - i * DAY, `sweep-window-${i}`)).ok).toBe(true);
    const early = await weekOfTests(env, today);
    expect(early.sweep_days).toBe(7);
    expect(early.window).toEqual({ from: iso(today - 7 * DAY), to: iso(today - DAY) });

    expect((await sweepOn(today + 3 * 3_600_000, "sweep-window-0")).ok).toBe(true);
    const later = await weekOfTests(env, today + 4 * 3_600_000);
    expect(later.sweep_days).toBe(7);
    expect(later.window).toEqual({ from: iso(today - 6 * DAY), to: iso(today) });
  });

  it("a day with no sweep inside the window is still counted as missing", async () => {
    const today = Date.parse("2027-04-20T12:00:00Z");
    for (const i of [0, 1, 2, 4, 5, 6]) await sweepOn(today - i * DAY, `sweep-gap-${i}`);
    const w = await weekOfTests(env, today);
    expect(w.sweep_days).toBe(6);
    expect(w.window).toEqual({ from: iso(today - 6 * DAY), to: iso(today) });
  });

  it("the page names the 7 days it counts", async () => {
    expect((await storeRun(env, { probedAt: new Date().toISOString(), entries: [{ ...entry("night-mcp"), rank: 1 }] })).ok).toBe(true);
    await env.KV.delete(`house:sweep:${iso(Date.now())}`);
    await sweepOn(Date.now() - DAY, "sweep-page-1");
    const page = await (await fetchWorker(`/reports/house?w=${Date.now()}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain('data-k="sweep-window"');
    expect(page).toContain("they end today once today's sweep has run, and yesterday until then");
    expect(page).not.toContain("of the last 7 days, so this covers part of the rotation");
  });
});
