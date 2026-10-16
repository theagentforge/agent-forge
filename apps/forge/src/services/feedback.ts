import type { CheckQuery } from "@forge/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "./db";
import { findTool } from "./forge";
import { markConnectTest } from "./connect-test";
import { day } from "./proof";
import { canonicalFromUrl, canonicalToolId } from "./tools";

// Reporter feedback (ADR 0011 g): "your reports were shown in N checks". Uniqueness and feedback, never points.
// Only a per-tool, per-day count is kept; nothing about who checked.

/** Counts one check of a known tool. Unknown tools aren't counted. Errors never affect the check itself. */
export async function recordToolCheck(env: Env, q: CheckQuery, now = Date.now()) {
  try {
    if (await markConnectTest(env, q)) return;
    const db = getDb(env);
    let toolId: string | undefined;
    if (q.fingerprint) {
      const v = await db.query.toolVersions.findFirst({ where: eq(t.toolVersions.fingerprint, q.fingerprint), columns: { toolId: true } });
      toolId = v?.toolId;
    } else {
      toolId = (await findTool(db, q.id ? canonicalToolId(q.id) : canonicalFromUrl(q.url!)))?.id;
    }
    if (!toolId) return;
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
