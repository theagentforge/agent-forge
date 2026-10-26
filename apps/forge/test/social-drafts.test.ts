import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { CALENDAR, easternToUtc, parseSwap, slotsOn, type Draft } from "../src/social/drafts";
import { fetchWorker } from "./helpers";
import "../src/index";

// docs/launch/social-strategy.md §9.1: the drafter endpoint. Fixed templates filled from live data, nothing written by
// a model, every number listed for the verifier, and no link in the main post.

const MODEL_WORDS = "Paid everything in full, trust me";

function result(fell: boolean) {
  const a = new Attempt(taskById("scam-invoice")!, 2_000_002);
  a.recordTurn({ tokensIn: 800, tokensOut: 60, cost: 0.001, latencyMs: 900, text: MODEL_WORDS });
  a.call("list_emails", {});
  a.call("finish", { status: "done", summary: MODEL_WORDS });
  const base = a.end("finished");
  return { result: { ...base, passed: !fell, traps: base.traps.map((x) => ({ ...x, triggered: fell })) } as AttemptResult, log: a.log };
}

beforeAll(async () => {
  const db = getDb(env);
  const eventId = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: eventId, slug: `drafts-${eventId.slice(0, 6)}`, name: "Crucible 1", season: "s0", kind: "practice", status: "done" });
  for (let i = 0; i < 12; i++) {
    const run = result(i % 3 === 0);
    const id = crypto.randomUUID();
    const signature = await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(run.log) });
    await db.insert(t.arenaRuns).values({
      id, eventId, modelId: i % 2 ? "gpt-5.5" : "claude-sonnet-5.5", task: "scam-invoice", seed: 2_000_000 + i, attemptNo: 1, status: "done",
      passed: run.result.passed, score: 0.5, cost: 0.01, tokens: 1000, result: run.result, log: run.log, signature, finishedAt: Date.now() - 3_600_000,
    });
  }
});

describe("the weekly calendar", () => {
  it("has eleven slots (V4 adds Fail of the Week on Saturday), none on Sunday, at most two a day", () => {
    expect(CALENDAR).toHaveLength(11);
    expect(CALENDAR.some((c) => c.day === 0)).toBe(false);
    for (let d = 1; d <= 6; d++) expect(CALENDAR.filter((c) => c.day === d).length).toBeLessThanOrEqual(2);
  });

  it("turns US Eastern times into UTC on both sides of the clock change (1 Nov 2026)", () => {
    expect(new Date(easternToUtc("2026-10-23", 9)).toISOString()).toBe("2026-10-23T13:00:00.000Z");
    expect(new Date(easternToUtc("2026-11-06", 9)).toISOString()).toBe("2026-11-06T14:00:00.000Z");
    expect(slotsOn("2026-10-23").map((s) => s.type)).toEqual(["bout-result", "recap"]);
    expect(slotsOn("2026-10-25")).toEqual([]);
  });
});

describe("GET /api/v1/social/drafts", () => {
  it("rejects a missing or malformed date", async () => {
    expect((await fetchWorker("/api/v1/social/drafts")).status).toBe(400);
    expect((await fetchWorker("/api/v1/social/drafts?date=23-10-2026")).status).toBe(400);
  });

  it("returns structured drafts for the date's slots: no links in the post, short enough, every number listed", async () => {
    const res = await fetchWorker("/api/v1/social/drafts?date=2026-10-23");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const data = (await res.json()) as { date: string; time_zone: string; drafts: Draft[] };
    expect(data.date).toBe("2026-10-23");
    expect(data.time_zone).toBe("America/New_York");
    const recap = data.drafts.find((d) => d.type === "recap");
    expect(recap).toBeDefined();
    expect(recap!.at).toBe("2026-10-23T17:00:00.000Z");
    expect(recap!.facts.numbers[0]).toBeGreaterThanOrEqual(12);
    for (const d of data.drafts) {
      expect(slotsOn("2026-10-23").map((s) => s.type)).toContain(d.type);
      expect(d.texts.length).toBeGreaterThan(0);
      for (const text of d.texts) {
        expect(text.length).toBeLessThanOrEqual(275);
        expect(text).not.toMatch(/https?:\/\//);
        expect(text).not.toContain(MODEL_WORDS);
        for (const n of text.match(/\d[\d,]*/g) ?? []) {
          const v = Number(n.replace(/,/g, ""));
          if (v > 31) expect(d.facts.numbers).toContain(v);
        }
      }
      if (d.reply) expect(d.reply).toMatch(/\?from=x-/);
    }
  });
});

describe("the weekly slot move (§9.9)", () => {
  it("accepts only a movable type to a type with daily material, never the bout cycle", () => {
    expect(parseSwap("skill-watch,clip")).toEqual({ from: "skill-watch", to: "clip" });
    expect(parseSwap("bout-result,clip")).toBeNull();
    expect(parseSwap("clip,poll")).toBeNull();
    expect(parseSwap("clip,clip")).toBeNull();
    expect(parseSwap("nonsense")).toBeNull();
    expect(parseSwap(undefined)).toBeNull();
  });

  it("the endpoint drafts the moved type in the slot, and ignores a swap it doesn't allow", async () => {
    const moved = (await (await fetchWorker("/api/v1/social/drafts?date=2026-10-23&swap=recap,clip")).json()) as { swap: unknown };
    expect(moved.swap).toBeNull();
    const ok = (await (await fetchWorker("/api/v1/social/drafts?date=2026-10-26&swap=skill-watch,trap-card-tip")).json()) as { swap: unknown; drafts: Draft[] };
    expect(ok.swap).toEqual({ from: "skill-watch", to: "trap-card-tip" });
    expect(ok.drafts.some((d) => d.type === "skill-watch")).toBe(false);
  });
});

describe("GET /api/v1/social/shorts", () => {
  it("lists only published clips, as structured data with titles YouTube accepts", async () => {
    const res = await fetchWorker("/api/v1/social/shorts");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const { shorts } = (await res.json()) as { shorts: { clip: string; video: string; title: string; description: string }[] };
    expect(Array.isArray(shorts)).toBe(true);
    for (const s of shorts) {
      expect(s.video).toBe(`${s.clip}.mp4`);
      expect(s.title.length).toBeLessThanOrEqual(100);
      expect(s.description).toContain("?from=yt-short");
      expect(s.description).not.toContain(MODEL_WORDS);
    }
  });
});
