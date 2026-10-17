import { TASKS } from "@forge/arena";
import { isoWeek } from "./fans";
import { HEADLINE } from "./lineup";

// The weekly frontier headline bout (ADR 0023 §2): every Thursday at 8 pm US Eastern, one bout between each lab's
// flagship. Pure date maths here (no clock, no database), so it can be tested across the clock changes.

/** The first weekly slot: Thursday 22 Oct 2026, 8 pm EDT (00:00 UTC on Fri 23 Oct). */
export const FIRST_SLOT = Date.UTC(2026, 9, 23, 0, 0);
/** Slot time in US Eastern local time. */
export const SLOT_HOUR_ET = 20;
const DAY = 86_400_000;

/** The nth Sunday (1-based) of a month, as a UTC day number of the month. */
const nthSunday = (y: number, m: number, n: number) => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + 7 * (n - 1);
};

/**
 * Whether a local date in US Eastern is in daylight time (EDT, UTC−4): from the second Sunday of March to the day before
 * the first Sunday of November (the US rule since 2007). Thursdays are never a changeover day, so the date is enough.
 */
export function easternDaylight(y: number, m: number, d: number) {
  const day = Date.UTC(y, m, d);
  return day >= Date.UTC(y, 2, nthSunday(y, 2, 2)) && day < Date.UTC(y, 10, nthSunday(y, 10, 1));
}

/** The slot on a given US Eastern Thursday: 20:00 local, as a UTC timestamp. */
export function slotOn(y: number, m: number, d: number) {
  return Date.UTC(y, m, d, SLOT_HOUR_ET + (easternDaylight(y, m, d) ? 4 : 5));
}

/** The US Eastern Thursday (local date) of each candidate slot near `now`, oldest first. */
function slotsAround(now: number) {
  const start = new Date(now - 9 * DAY);
  const out: number[] = [];
  for (let i = 0; i < 20; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
    if (d.getUTCDay() === 4) out.push(slotOn(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  return out.filter((s) => s >= FIRST_SLOT);
}

/** The next weekly slot at or after `now` (never before the first one, 22 Oct 2026). */
export function nextHeadlineSlot(now: number): number {
  if (now <= FIRST_SLOT) return FIRST_SLOT;
  return slotsAround(now).find((s) => s >= now)!;
}

/** The latest slot at or before `now`, or null before the first one. */
export function lastHeadlineSlot(now: number): number | null {
  return slotsAround(now).filter((s) => s <= now).at(-1) ?? null;
}

/** The slot's US Eastern date (the Thursday), YYYY-MM-DD. */
export function slotDate(slot: number) {
  // 8 pm ET is midnight or 1 am UTC on Friday, so the Eastern date is always the UTC date of 6 hours earlier.
  return new Date(slot - 6 * 3_600_000).toISOString().slice(0, 10);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 22 Oct, 8 pm ET (Fri 00:00 UTC)". */
export function formatSlot(slot: number) {
  const et = new Date(`${slotDate(slot)}T00:00:00Z`);
  const utc = new Date(slot);
  const hhmm = `${String(utc.getUTCHours()).padStart(2, "0")}:${String(utc.getUTCMinutes()).padStart(2, "0")}`;
  return `${DAYS[et.getUTCDay()]} ${et.getUTCDate()} ${MONTHS[et.getUTCMonth()]}, 8 pm ET (${DAYS[utc.getUTCDay()]} ${hhmm} UTC)`;
}

/** The published rule (/arena/rules#weekly): the Normal jobs in order, one per week, by the slot's ISO week number. */
export function weeklyTask(slot: number) {
  const week = Number(isoWeek(Date.parse(`${slotDate(slot)}T12:00:00Z`)).slice(-2));
  return TASKS[week % TASKS.length]!;
}

/** One flagship per lab: the main lineup's Heavyweight division, Grok never entered (ADR 0013). */
export function weeklyModels() {
  const seen = new Set<string>();
  return HEADLINE.filter((m) => {
    const lab = m.lab.replace(/ \(open weights\)$/, "");
    if (m.division !== "heavyweight" || m.retired || /xai|grok/i.test(`${m.lab} ${m.id}`) || seen.has(lab)) return false;
    seen.add(lab);
    return true;
  }).map((m) => m.id);
}

export const WEEKLY_ATTEMPTS = 3;
/** The tick that queues a slot's bout must come within this long of the slot; a missed week isn't played late. */
export const WEEKLY_QUEUE_WINDOW_MS = 12 * 3_600_000;
export const weeklySlug = (slot: number) => `weekly-${slotDate(slot)}`;

/** The structured "next headline bout" for /arena?format=json. */
export function nextHeadlineJson(now: number) {
  const slot = nextHeadlineSlot(now);
  return { at: new Date(slot).toISOString(), local: formatSlot(slot), time_zone: "America/New_York", task: weeklyTask(slot).id, models: weeklyModels(), calendar: "/arena/headline.ics", rule: "/arena/rules#weekly" };
}

/**
 * A weekly recurring calendar event (RFC 5545) with the US Eastern time zone written out, so calendar apps keep it at
 * 8 pm local across the clock changes. Static: the UID and DTSTAMP never change, so a subscription doesn't duplicate.
 */
export function headlineIcs() {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//The Agent Forge//Forge Arena//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Forge Arena headline bout",
    "X-WR-TIMEZONE:America/New_York",
    "BEGIN:VTIMEZONE",
    "TZID:America/New_York",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "TZNAME:EDT",
    "DTSTART:20070311T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "TZNAME:EST",
    "DTSTART:20071104T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:weekly-headline-bout@theagentforge.io",
    "DTSTAMP:20261017T000000Z",
    "DTSTART;TZID=America/New_York:20261022T200000",
    "DURATION:PT1H",
    "RRULE:FREQ=WEEKLY;BYDAY=TH",
    "SUMMARY:Forge Arena: weekly headline bout",
    // Folded (RFC 5545 §3.1): a continuation line starts with one space, which is removed when it is read.
    "DESCRIPTION:One bout between each lab's flagship model on one everyday",
    "  job\\, refereed and replayed. Rules:",
    "  https://theagentforge.io/arena/rules#weekly",
    "URL:https://theagentforge.io/arena",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}
