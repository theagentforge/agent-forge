import { desc, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { newReleases } from "./catalog";
import { spend } from "./runner";

/** Spend against budget, the run queue and recent events. Read by the Ops Digest (80% warning → needs-dinike). */
export async function arenaStatus(env: Env, now = Date.now()) {
  const db = getDb(env);
  const counts = await db.select({ status: t.arenaRuns.status, n: sql<number>`count(*)` }).from(t.arenaRuns).groupBy(t.arenaRuns.status);
  const events = await db.select({ slug: t.arenaEvents.slug, name: t.arenaEvents.name, kind: t.arenaEvents.kind, status: t.arenaEvents.status }).from(t.arenaEvents).orderBy(desc(t.arenaEvents.createdAt)).limit(5);
  return {
    spend: await spend(env, now),
    queue: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    events,
    new_releases: await newReleases(env, now),
  };
}
