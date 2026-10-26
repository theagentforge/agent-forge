import { and, eq, like, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { osvPackageFor, queryAdvisories } from "./advisories";
import { getDb } from "./db";
import { day } from "./proof";
import { bump } from "./usage";

// Misses (ADR 0031 step 1): checks of tools we know nothing about, and scans of links on hosts we don't read from.
// The strongest demand signal for Forge Scout. Only a daily count per tool id or host is kept, in usage_daily under
// "miss:check:<id>" and "miss:scan:<host>"; nothing about who asked. House sessions and crawlers aren't counted.

/** At most this many distinct miss keys a day, so a flood of made-up ids can't grow the table. */
export const MISS_KEYS_PER_DAY = 500;
const CRAWLER_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|lighthouse|monitor/i;

/** A safe, short label for a missed tool id, or null for anything that might carry a token or isn't worth keeping. */
export function missLabel(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!s || s.length > 120 || /[\s<>"'`\\]/.test(s)) return null;
  // A long run of letters and digits with several digits looks like a key or a hash: never kept.
  for (const run of s.match(/[a-z0-9_-]{24,}/g) ?? []) if ((run.match(/\d/g)?.length ?? 0) >= 6) return null;
  return s;
}

/** Counts one miss. Never throws: a count must not break the check or scan it belongs to. */
export async function recordMiss(env: Env, kind: "check" | "scan", label: string | null, opts: { userAgent?: string | null; now?: number } = {}) {
  try {
    if (!label || CRAWLER_UA.test(opts.userAgent ?? "")) return;
    const now = opts.now ?? Date.now();
    const key = `miss:${kind}:${label}`;
    const [row] = await getDb(env)
      .select({ n: sql<number>`count(*)`, mine: sql<number>`sum(${t.usageDaily.key} = ${key})` })
      .from(t.usageDaily)
      .where(and(eq(t.usageDaily.day, day(now)), like(t.usageDaily.key, "miss:%")));
    if (!Number(row?.mine ?? 0) && Number(row?.n ?? 0) >= MISS_KEYS_PER_DAY) return;
    await bump(env, [key], now);
  } catch (e) {
    console.error("recordMiss failed", e);
  }
}

/**
 * Issue #203: a check of an unknown npm or PyPI id that OSV answered with at least one published advisory got a real
 * answer (the advisory), so it isn't a miss. Unknown ids with no advisory, and every other kind of id, still are.
 * Reads the same 6-hour OSV cache as the check itself. When OSV can't be reached, it counts as a miss.
 */
export async function answeredByAdvisories(env: Pick<Env, "KV">, id: string, version: string | null) {
  const pkg = osvPackageFor(id);
  if (!pkg) return false;
  const r = await queryAdvisories(env, pkg, version);
  return !!r && r.advisories.length > 0;
}

/** The host of a scan link we don't read from (fetchSkillText said "unsupported_url"), as the miss label. */
export function scanMissLabel(url: string, error: string): string | null {
  if (error !== "unsupported_url") return null;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? missLabel(u.hostname) : null;
  } catch {
    return null;
  }
}

/** Misses on `since` or later, most asked first: what Scout reads. */
export async function topMisses(env: Env, since: string, until: string, limit = 50) {
  const rows = await getDb(env)
    .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
    .from(t.usageDaily)
    .where(and(sql`${t.usageDaily.day} between ${since} and ${until}`, like(t.usageDaily.key, "miss:%")))
    .groupBy(t.usageDaily.key)
    .orderBy(sql`sum(${t.usageDaily.n}) desc`, t.usageDaily.key)
    .limit(limit);
  return rows.map((r) => {
    const [, kind, ...rest] = r.key.split(":");
    return { kind: kind as "check" | "scan", id: rest.join(":"), n: Number(r.n) };
  });
}
