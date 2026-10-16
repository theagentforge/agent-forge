import type * as t from "../db/schema";
import { isAdmin } from "./identity";

// Closed production (ADR 0006, MASTER_PLAN §7.3): until launch, only people the founder approved (or who were vouched
// for) can connect agents and file reports. Checks, pages and stats stay open to everyone. ACCESS_MODE=open at launch.

export const isClosed = (env: Pick<Env, "ACCESS_MODE">) => env.ACCESS_MODE !== "open";

export function canParticipate(env: Pick<Env, "ACCESS_MODE" | "ADMIN_GITHUB_IDS">, human: typeof t.humans.$inferSelect) {
  if (!isClosed(env)) return true;
  return human.verifiedVia === "approval" || human.verifiedVia === "vouch" || isAdmin(env, human.githubId);
}
