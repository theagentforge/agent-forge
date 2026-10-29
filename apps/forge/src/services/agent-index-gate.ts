import { and, eq, isNull } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { isAdmin } from "./identity";

// ADR 0094: the public agent index (/agents, /agents.json) stays closed until AGENT_INDEX_OPENS_AT outside owners
// (not House, not the founder or an admin) each have an active agent with a claimed, shown, finished run. Until then
// the index lists no rows at all, house or otherwise, so nobody can count outside agents by walking it (Dinike's rule,
// 28 Oct: no outside-only numbers anywhere public). Same pattern as /founding (ADR 0082/0086). The number of outside
// owners is never returned or printed: only whether the threshold is reached.

export const AGENT_INDEX_OPENS_AT = 10;
/**
 * B3-04 (ADR 0099): the public wording says "opening soon" and never the threshold, which would tell a reader how many
 * outside owners there are not yet. The gate itself (agentIndexOpen, AGENT_INDEX_OPENS_AT) is unchanged and never
 * reads this text.
 */
export const AGENT_INDEX_CLOSED_NOTE =
  "The public index of claimed agents is opening soon. Run the Gauntlet or the 90-second Sprint and claim it to be among the first.";

/** True once at least AGENT_INDEX_OPENS_AT outside owners have an active agent with a claimed, shown, finished run. */
export async function agentIndexOpen(env: Pick<Env, "DB" | "ADMIN_GITHUB_IDS">, opensAt = AGENT_INDEX_OPENS_AT): Promise<boolean> {
  const admins = (env.ADMIN_GITHUB_IDS ?? "").split(",").filter((x) => x.trim()).length;
  const owners = await getDb(env as Env)
    .selectDistinct({ githubId: t.humans.githubId })
    .from(t.gauntletClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .innerJoin(t.humans, eq(t.humans.id, t.agents.humanId))
    .where(
      and(
        eq(t.gauntletClaims.hidden, false),
        eq(t.arenaGauntlets.status, "done"),
        isNull(t.arenaGauntlets.cardFrom),
        eq(t.agents.status, "active"),
        eq(t.humans.isHouse, false),
      ),
    )
    // Enough rows to still reach the threshold after dropping admin accounts; never a full count.
    .limit(opensAt + admins);
  return owners.filter((o) => !isAdmin(env, o.githubId)).length >= opensAt;
}
