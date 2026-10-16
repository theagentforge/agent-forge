import { and, eq, isNotNull } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { moderateWithinBudget } from "./moderation";

// Hourly: moderate notes left "pending" (the model was down, or the day's allowance ran out). Pending notes are never
// shown, so this only ever publishes or removes them.
export async function sweepPendingNotes(env: Env, limit = 30, now = Date.now()) {
  const db = getDb(env);
  const rows = await db
    .select({ id: t.reports.id, note: t.reports.note })
    .from(t.reports)
    .where(and(eq(t.reports.moderationState, "pending"), isNotNull(t.reports.note)))
    .limit(limit);
  const out = { checked: 0, approved: 0, rejected: 0 };
  for (const r of rows) {
    const state = await moderateWithinBudget(env, r.note!, now);
    if (state === "pending") break;
    out.checked++;
    out[state]++;
    await db
      .update(t.reports)
      .set(state === "rejected" ? { moderationState: state, note: null } : { moderationState: state })
      .where(eq(t.reports.id, r.id));
  }
  return out;
}
