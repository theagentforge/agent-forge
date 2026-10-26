import type { CheckQuery } from "@forge/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "./db";
import { findTool } from "./forge";
import { markConnectTest, type TestChannel } from "./connect-test";
import { day } from "./proof";
import { canonicalFromUrl, canonicalToolId, splitInlineVersion, versionFromUrl } from "./tools";
import { answeredByAdvisories, missLabel, recordMiss } from "./misses";

// Reporter feedback (ADR 0011 g): "your reports were shown in N checks". Uniqueness and feedback, never points.
// Only a per-tool, per-day count is kept; nothing about who checked.

/**
 * Counts one check of a known tool. A check of a tool we don't know is counted as a miss instead (services/misses.ts),
 * by id only (a version written into the id is dropped), unless published advisories answered it (issue #203).
 * Callers skip this for House sessions. Errors never affect the check itself.
 */
export async function recordToolCheck(env: Env, q: CheckQuery, now = Date.now(), opts: { userAgent?: string | null; internal?: string | null; channel?: TestChannel } = {}) {
  try {
    // Our own probes (services/internal.ts) aren't counted, but the /connect "Test it" tick still works for them.
    if ((await markConnectTest(env, q, opts.channel)) || opts.internal) return;
    const db = getDb(env);
    let toolId: string | undefined, asked: string | undefined, version: string | null = null;
    if (q.fingerprint) {
      const v = await db.query.toolVersions.findFirst({ where: eq(t.toolVersions.fingerprint, q.fingerprint), columns: { toolId: true } });
      toolId = v?.toolId;
    } else {
      // The same id and version checkTool reads: pypi:litellm==1.107.0 is pypi:litellm at 1.107.0.
      const split = q.id ? splitInlineVersion(q.id) : { id: "", version: null };
      version = q.version ?? split.version ?? (q.url ? versionFromUrl(q.url) : null);
      asked = q.id ? canonicalToolId(split.id) : canonicalFromUrl(q.url!);
      toolId = (await findTool(db, asked))?.id;
    }
    if (!toolId) {
      if (!asked || (await answeredByAdvisories(env, asked, version))) return;
      return recordMiss(env, "check", missLabel(asked), { userAgent: opts.userAgent, now });
    }
    await db
      .insert(t.toolChecks)
      .values({ toolId, day: day(now), n: 1 })
      .onConflictDoUpdate({ target: [t.toolChecks.toolId, t.toolChecks.day], set: { n: sql`${t.toolChecks.n} + 1` } });
  } catch (e) {
    console.error("recordToolCheck failed", e);
  }
}

/**
 * For each report, how many checks of its tool happened from the day it was filed. A check shows every report
 * on that tool, so this is how often a report was in front of someone deciding whether to trust the tool.
 */
export async function shownInChecks(db: Db, reports: { id: string; toolId: string; createdAt: number }[]) {
  const out = new Map<string, number>();
  if (!reports.length) return out;
  const toolIds = [...new Set(reports.map((r) => r.toolId))].slice(0, 90);
  const earliest = day(Math.min(...reports.map((r) => r.createdAt)));
  const rows = await db
    .select({ toolId: t.toolChecks.toolId, day: t.toolChecks.day, n: t.toolChecks.n })
    .from(t.toolChecks)
    .where(and(inArray(t.toolChecks.toolId, toolIds), gte(t.toolChecks.day, earliest)));
  for (const r of reports) {
    const since = day(r.createdAt);
    out.set(r.id, rows.filter((x) => x.toolId === r.toolId && x.day >= since).reduce((a, x) => a + x.n, 0));
  }
  return out;
}
