import { and, eq, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { liveAgentCounts } from "./agent-funnel";
import { getDb } from "./db";
import { workTotals, type WorkTotals } from "./site-pulse";

// ADR 0116 (Dinike's operating procedure, 29 Oct): /stats showed 5,397 bouts and 48,164 tools while /dataset showed
// 5,434 and 49,711. Both pages already ran the same queries (workTotals), but each ran them at its own moment and each
// page was then edge-cached on its own 60-second clock, so two pages open side by side could show two different
// moments. Now every public page and JSON twin that shows a running total (/stats, /stats.json, /dataset,
// /dataset.json, the home band and /agents/live.json, /about, /api/v1/stats) reads this one function. It takes one
// snapshot per clock minute, keeps it in the edge cache until the minute ends, and those pages are cached only until
// the same moment, so pages served together show the same numbers, with the time they were counted (`as_of`).

/** One snapshot per this many seconds, aligned to the clock (a page cached with it expires when the snapshot does). */
export const PUBLIC_NUMBERS_SECONDS = 60;
const SPAN = PUBLIC_NUMBERS_SECONDS * 1000;

/**
 * The snapshot cache can be switched off (tests that add rows and read the totals straight back turn it off in the
 * test setup; test/public-numbers.test.ts turns it on to check the cache). Always on in the Worker.
 */
export const publicNumbersCache = { enabled: true };

export type LiveCounts = Awaited<ReturnType<typeof liveAgentCounts>>;

export interface PublicNumbers {
  /** When the numbers were counted (ISO 8601, UTC). */
  as_of: string;
  /** The snapshot's clock minute starts (ms) and ends (ms). */
  bucket: number;
  until: number;
  work: WorkTotals | null;
  live: LiveCounts | null;
  /** Finished six-job Gauntlet runs and one-job Sprints (anyone). */
  gauntlet: { full: number | null; sprint: number | null };
}

export const bucketOf = (now: number) => Math.floor(now / SPAN) * SPAN;

/** The cache key: under /admin, which the public page cache never looks up, so no request URL can read it. */
const keyOf = (env: Pick<Env, "PUBLIC_ORIGIN">, bucket: number) => new Request(`${env.PUBLIC_ORIGIN}/admin/__public-numbers/${bucket}`);

/** Seconds until the snapshot ends: the max-age of every page that shows it (at least 1). */
export const secondsLeft = (n: Pick<PublicNumbers, "until">, now = Date.now()) => Math.max(1, Math.ceil((n.until - now) / 1000));

async function gauntletsFinished(env: Env, mode: "full" | "sprint") {
  const [r] = await getDb(env).select({ n: sql<number>`count(*)` }).from(t.arenaGauntlets).where(and(eq(t.arenaGauntlets.status, "done"), eq(t.arenaGauntlets.mode, mode)));
  return Number(r?.n ?? 0);
}

/** Every part of the snapshot was read (none failed): only then is it kept for the minute. */
export const complete = (n: PublicNumbers) => n.work !== null && n.live !== null && n.gauntlet.full !== null && n.gauntlet.sprint !== null;

/** The public running totals, one snapshot per clock minute (see the note at the top). */
export async function publicNumbers(env: Env, now = Date.now()): Promise<PublicNumbers> {
  const bucket = bucketOf(now);
  const key = keyOf(env, bucket);
  if (publicNumbersCache.enabled) {
    const hit = await caches.default.match(key).catch(() => undefined);
    if (hit) return (await hit.json()) as PublicNumbers;
  }
  const [work, live, full, sprint] = await Promise.all([
    workTotals(env).catch(() => null),
    liveAgentCounts(env, now).catch(() => null),
    gauntletsFinished(env, "full").catch(() => null),
    gauntletsFinished(env, "sprint").catch(() => null),
  ]);
  const out: PublicNumbers = { as_of: new Date(now).toISOString(), bucket, until: bucket + SPAN, work, live, gauntlet: { full, sprint } };
  // Review of ADR 0116: a read that failed is never kept for the minute (the next request counts again), and when
  // another request stored its snapshot for this minute while this one counted, that stored one wins, so pages served
  // in the same minute from this data centre read one count.
  if (publicNumbersCache.enabled && complete(out)) {
    const first = await caches.default.match(key).catch(() => undefined);
    if (first) return (await first.json()) as PublicNumbers;
    await caches.default
      .put(key, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${secondsLeft(out, now)}` } }))
      .catch(() => {});
  }
  return out;
}

/** The same, from a snapshot's `as_of` alone (the snapshot ends at the end of that clock minute). */
export const secondsLeftOf = (asOf: string, now = Date.now()) => secondsLeft({ until: bucketOf(Date.parse(asOf)) + SPAN }, now);

/** The line every page with these numbers shows under them. */
// Review of ADR 0116: the edge cache is per data centre, so the line claims one count a minute, not one count everywhere.
export const asOfText = (n: Pick<PublicNumbers, "as_of">) => `Counted at ${n.as_of.slice(11, 16)} UTC on ${n.as_of.slice(0, 10)}; the pages showing these totals share one count each minute.`;

/** The home band's short form of the same line. */
export const asOfShort = (asOf: string) => `Counted at ${asOf.slice(11, 16)} UTC.`;
