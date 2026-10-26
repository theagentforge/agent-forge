import { env } from "cloudflare:workers";
import { heldOutSeeds, TASKS } from "@forge/arena";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { easternDaylight, FIRST_SLOT, formatSlot, headlineIcs, lastHeadlineSlot, nextHeadlineSlot, slotDate, weeklyModels, weeklyTask } from "../src/arena/headline-slot";
import { HEADLINE } from "../src/arena/lineup";
import { arenaTick, queueWeeklyHeadline, SEASON_SEED_MIN } from "../src/arena/runner";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

// The weekly frontier headline bout (ADR 0023 §2): Thursday 8 pm US Eastern, shown on /arena with a calendar file,
// and queued once by the runner's tick.

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

describe("nextHeadlineSlot", () => {
  it("is Thursday 8 pm US Eastern: 00:00 UTC Friday in daylight time, 01:00 UTC Friday in standard time", () => {
    expect(FIRST_SLOT).toBe(utc(2026, 10, 23, 0));
    expect(nextHeadlineSlot(utc(2026, 10, 17, 12))).toBe(utc(2026, 10, 23, 0)); // before the first slot
    expect(nextHeadlineSlot(utc(2026, 10, 23, 0))).toBe(utc(2026, 10, 23, 0)); // exactly at the slot
    expect(nextHeadlineSlot(utc(2026, 10, 23, 0, 1))).toBe(utc(2026, 10, 30, 0)); // a minute after: next week (still EDT)
  });

  it("follows the clock change on Sunday 1 Nov 2026", () => {
    expect(easternDaylight(2026, 9, 29)).toBe(true); // Thu 29 Oct
    expect(easternDaylight(2026, 10, 5)).toBe(false); // Thu 5 Nov
    expect(nextHeadlineSlot(utc(2026, 10, 30, 0, 1))).toBe(utc(2026, 11, 6, 1)); // Thu 5 Nov, 8 pm EST = 01:00 UTC Fri
    expect(nextHeadlineSlot(utc(2026, 11, 1, 6, 30))).toBe(utc(2026, 11, 6, 1)); // just after the change
    // Between 00:00 and 01:00 UTC on Fri 6 Nov it's still Thursday evening in New York, before the slot.
    expect(nextHeadlineSlot(utc(2026, 11, 6, 0, 30))).toBe(utc(2026, 11, 6, 1));
    expect(lastHeadlineSlot(utc(2026, 11, 6, 0, 30))).toBe(utc(2026, 10, 30, 0));
    expect(nextHeadlineSlot(utc(2026, 11, 6, 1) + 1)).toBe(utc(2026, 11, 13, 1));
  });

  it("follows the spring change (second Sunday of March 2027) and the year end", () => {
    expect(nextHeadlineSlot(utc(2027, 3, 5, 2))).toBe(utc(2027, 3, 12, 1)); // Thu 11 Mar 2027, before the 14 Mar change: EST
    expect(nextHeadlineSlot(utc(2027, 3, 12, 2))).toBe(utc(2027, 3, 19, 0)); // Thu 18 Mar: EDT
    expect(nextHeadlineSlot(utc(2026, 12, 30, 12))).toBe(utc(2027, 1, 1, 1)); // Thu 31 Dec 2026
    expect(slotDate(utc(2027, 1, 1, 1))).toBe("2026-12-31");
  });

  it("formats as 'Thu 22 Oct, 8 pm ET (Fri 00:00 UTC)'", () => {
    expect(formatSlot(FIRST_SLOT)).toBe("Thu 22 Oct, 8 pm ET (Fri 00:00 UTC)");
    expect(formatSlot(utc(2026, 11, 6, 1))).toBe("Thu 5 Nov, 8 pm ET (Fri 01:00 UTC)");
    expect(lastHeadlineSlot(utc(2026, 10, 22, 23, 59))).toBeNull();
  });

  it("the job rotates through the six Normal jobs by ISO week; the lineup is one flagship per lab, no Grok", () => {
    // 22 Oct 2026 is ISO week 43; 43 mod 6 = 1.
    expect(weeklyTask(FIRST_SLOT).id).toBe(TASKS[1]!.id);
    const six = Array.from({ length: 6 }, (_, i) => weeklyTask(FIRST_SLOT + i * 7 * 86_400_000).id);
    expect(new Set(six).size).toBe(6);
    const models = weeklyModels();
    expect(models.length).toBeGreaterThanOrEqual(5);
    expect(models.every((id) => HEADLINE.find((m) => m.id === id)?.division === "heavyweight")).toBe(true);
    expect(new Set(models.map((id) => HEADLINE.find((m) => m.id === id)!.lab.replace(/ \(open weights\)$/, ""))).size).toBe(models.length);
    expect(models.join(" ")).not.toMatch(/grok/i);
  });
});

describe("calendar file and /arena", () => {
  it("/arena/headline.ics is a weekly Thursday event at 20:00 New York time with its time zone", async () => {
    const res = await fetchWorker("/arena/headline.ics");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+/);
    const ics = await res.text();
    expect(ics).toBe(headlineIcs());
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    for (const l of [
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "UID:weekly-headline-bout@theagentforge.io",
      "DTSTART;TZID=America/New_York:20261022T200000",
      "RRULE:FREQ=WEEKLY;BYDAY=TH",
      "URL:https://theagentforge.io/arena",
      "END:VCALENDAR",
    ])
      expect(lines, l).toContain(l);
    // RFC 5545: CRLF line ends, at most 75 octets a line.
    expect(ics).not.toMatch(/[^\r]\n/);
    for (const l of lines) expect(new TextEncoder().encode(l).length, l).toBeLessThanOrEqual(75);
  });

  it("both /arena views show the next slot with the calendar link, and the JSON twin carries it", async () => {
    const want = formatSlot(nextHeadlineSlot(Date.now()));
    for (const path of ["/arena", "/arena?tier=hard"]) {
      const body = await (await fetchWorker(path)).text();
      expect(body, path).toContain(`<b>Next headline bout:</b> <time datetime="${new Date(nextHeadlineSlot(Date.now())).toISOString()}">${want}</time>`);
      expect(body, path).toContain('<a href="/arena/headline.ics">Add to calendar (.ics)</a>');
      const j = (await (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}format=json`)).json()) as { next_headline_bout: { at: string; local: string; calendar: string; task: string } };
      expect(j.next_headline_bout).toMatchObject({ at: new Date(nextHeadlineSlot(Date.now())).toISOString(), local: want, calendar: "/arena/headline.ics" });
    }
    const rules = await (await fetchWorker("/arena/rules")).text();
    expect(rules).toContain('<h2 id="weekly">The weekly headline bout</h2>');
    expect(rules).toContain("ISO week number");
    expect(rules).toContain("one private held-out version of the same job, which is never published");
  });
});

describe("queueing the weekly bout", () => {
  const prod = { ...env, ENVIRONMENT: "production", OPENROUTER_API_KEY: "test-key" } as Env & { OPENROUTER_API_KEY: string };
  const weekly = async (slug: string) => {
    const db = getDb(env);
    const [ev] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, slug));
    return { ev, runs: ev ? await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, ev.id)) : [] };
  };
  afterEach(() => vi.useRealTimers());

  it("a tick just before the slot queues nothing; the first tick after queues one event; the next tick adds nothing", async () => {
    expect(await queueWeeklyHeadline(prod, FIRST_SLOT - 60_000)).toBeNull();
    expect((await weekly("weekly-2026-10-22")).ev).toBeUndefined();

    expect(await queueWeeklyHeadline(prod, FIRST_SLOT + 2 * 60_000)).toBe("weekly-2026-10-22");
    const all = await weekly("weekly-2026-10-22");
    expect(all.ev).toMatchObject({ kind: "card", season: "s0" });
    const models = weeklyModels();
    // ADR 0058: the same models and attempts on the job's first private held-out seed (none in the public mirror).
    const firstHeld = heldOutSeeds(weeklyTask(FIRST_SLOT).id).slice(0, 1);
    const held = all.runs.filter((r) => r.heldOut);
    expect(held).toHaveLength(models.length * 3 * firstHeld.length);
    expect(held.every((r) => firstHeld.includes(r.seed) && r.task === weeklyTask(FIRST_SLOT).id)).toBe(true);
    expect(held.map((r) => `${r.modelId}:${r.attemptNo}`).sort()).toEqual(firstHeld.length ? models.flatMap((m) => [1, 2, 3].map((a) => `${m}:${a}`)).sort() : []);
    const first = { ev: all.ev, runs: all.runs.filter((r) => !r.heldOut) };
    expect(first.runs).toHaveLength(models.length * 3);
    expect(new Set(first.runs.map((r) => r.task))).toEqual(new Set([weeklyTask(FIRST_SLOT).id]));
    expect(new Set(first.runs.map((r) => r.modelId))).toEqual(new Set(models));
    const seeds = new Set(first.runs.map((r) => r.seed));
    expect(seeds.size).toBe(1);
    expect([...seeds][0]).toBeGreaterThanOrEqual(SEASON_SEED_MIN);
    expect(first.runs.map((r) => r.attemptNo).sort()).toEqual(models.flatMap(() => [1, 2, 3]).sort());

    expect(await queueWeeklyHeadline(prod, FIRST_SLOT + 7 * 60_000)).toBeNull();
    expect((await weekly("weekly-2026-10-22")).runs).toHaveLength(models.length * 3 * (1 + firstHeld.length));
    const events = await getDb(env).select().from(t.arenaEvents);
    expect(events.filter((e) => e.slug.startsWith("weekly-"))).toHaveLength(1);
    await getDb(env).delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, first.ev!.id));
  });

  it("the cron tick queues it (plan only when the tick's deadline has passed)", async () => {
    const slot = utc(2026, 11, 6, 1); // Thu 5 Nov, 8 pm EST
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slot + 20 * 60_000);
    await env.KV.delete("arena:lock");
    await arenaTick(prod, slot + 60_000); // its deadline (+10 min) is already past, so no bouts are played
    const w = await weekly("weekly-2026-11-05");
    expect(w.ev?.kind).toBe("card");
    expect(w.runs.every((r) => r.status === "queued")).toBe(true);
    await getDb(env).delete(t.arenaRuns).where(eq(t.arenaRuns.eventId, w.ev!.id));
  });

  it("nothing is queued on staging, without the OpenRouter key, or long after a missed slot", async () => {
    expect(await queueWeeklyHeadline({ ...prod, ENVIRONMENT: "staging" }, utc(2026, 11, 13, 1, 5))).toBeNull();
    expect(await queueWeeklyHeadline({ ...prod, OPENROUTER_API_KEY: "" }, utc(2026, 11, 13, 1, 5))).toBeNull();
    expect(await queueWeeklyHeadline(prod, utc(2026, 11, 13, 1) + 13 * 3_600_000)).toBeNull();
    expect((await weekly("weekly-2026-11-12")).ev).toBeUndefined();
  });
});
