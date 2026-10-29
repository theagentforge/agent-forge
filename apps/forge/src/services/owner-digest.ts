import { and, count, countDistinct, eq, isNull } from "drizzle-orm";
import * as t from "../db/schema";
import { outsidePeople } from "./agent-funnel";
import { getDb } from "./db";
import { counterSums } from "./owner-funnel";
import { ownerActivity, ownersBySource } from "./owners";

// OA-11 (owner acquisition plan, ADR 0078): the owner funnel for the daily Ops Digest. Internal only: it travels in
// /api/v1/ops/scout-signals (GitHub OIDC, private workflow) into the private scout-data snapshot, which the digest
// reads for its private issue. No new workflow run, and never on a public page. Counts only: no names, no logins.
// A counter that has never been written is null ("not yet measured"), never 0.

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The OA-02 /connect steps, in order: the person's own "yes", step 2 shown, and its command copied or link pressed. */
export const CONNECT_OWNER_STEPS = [
  { id: "opened", label: "opened /connect", key: "visit:human:connect", prefix: false },
  { id: "said_yes", label: "said yes, it flagged it", key: "connect:worked:yes", prefix: false },
  { id: "link_shown", label: "saw step 2 (link to you)", key: "connect:link-shown:", prefix: true },
  { id: "link_copied", label: "copied the link step", key: "connect:link-copied:", prefix: true },
] as const;

export interface OwnerDigest {
  day: string;
  new_owners_yesterday: { total: number | null; by_source: Record<string, number> };
  active_owners_30d: { owners: number; active: number; connected_active: number; web_only_active: number };
  connect_7d: { steps: { id: string; label: string; n: number | null }[]; biggest_drop: string | null; said_no: number | null };
  pending_claims: { claims: number; people: number };
  reviews_waiting: number;
}

export async function ownerDigest(env: Env, now = Date.now()): Promise<OwnerDigest> {
  const db = getDb(env);
  const yesterday = day(now - DAY);
  const weekStart = day(now - 7 * DAY);
  const [sources, activity] = await Promise.all([ownersBySource(env, now, 1), ownerActivity(env, now, 30)]);

  // /connect over the last 7 full days: each step's count (null when never written), and the step losing the most.
  const c = await counterSums(env, ["visit:human:connect", "connect:worked:yes", "connect:worked:no"], ["connect:link-shown:", "connect:link-copied:"], weekStart, yesterday);
  const seenPrefix = async (p: string) => {
    const any = await counterSums(env, [], [p], "0000-00-00", "9999-99-99");
    return Object.keys(any.byPrefix(p)).length > 0;
  };
  const steps = [];
  for (const s of CONNECT_OWNER_STEPS) {
    if (!s.prefix) steps.push({ id: s.id, label: s.label, n: c.get(s.key) });
    else steps.push({ id: s.id, label: s.label, n: (await seenPrefix(s.key)) ? Object.values(c.byPrefix(s.key)).reduce((a, n) => a + n, 0) : null });
  }
  let biggest: string | null = null, worst = -1;
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]!.n, b = steps[i]!.n;
    if (a === null || b === null || a <= 0) continue;
    const lost = (a - b) / a;
    if (lost > worst) (worst = lost), (biggest = `${steps[i - 1]!.label} → ${steps[i]!.label} (${Math.round(lost * 100)}% lost)`);
  }

  // Pending claims (OA-06) of people outside the project, and review requests nobody has decided yet.
  const [pending] = await db
    .select({ n: count(), people: countDistinct(t.pendingClaims.humanId) })
    .from(t.pendingClaims)
    .innerJoin(t.humans, eq(t.humans.id, t.pendingClaims.humanId))
    .where(outsidePeople(env));
  const [reviews] = await db
    .select({ n: count() })
    .from(t.ownerReviewRequests)
    .innerJoin(t.humans, eq(t.humans.id, t.ownerReviewRequests.humanId))
    .where(and(outsidePeople(env), isNull(t.ownerReviewRequests.decision)));

  return {
    day: yesterday,
    new_owners_yesterday: { total: sources.total, by_source: sources.by_source },
    active_owners_30d: { owners: activity.owners, active: activity.active, connected_active: activity.connected.active, web_only_active: activity.web_only.active },
    connect_7d: { steps, biggest_drop: biggest, said_no: c.get("connect:worked:no") },
    pending_claims: { claims: Number(pending?.n ?? 0), people: Number(pending?.people ?? 0) },
    reviews_waiting: Number(reviews?.n ?? 0),
  };
}
