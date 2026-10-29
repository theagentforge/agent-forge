import { FINISH_TOOL } from "@forge/arena";
import { isLean } from "../services/ops-mode";
import { day } from "../services/proof";
import { BYOK_EXPIRES, byokFallbackSeen, byokHeld, isClaudeByok, noteByokFallback } from "./credit";
import { eq } from "drizzle-orm";
import * as t from "../db/schema";
import { endHouseSprint, gauntletAct, gauntletRun, startSprint } from "./gauntlet";
import { getDb } from "../services/db";
import { HEADLINE, testedModels, type ArenaModel } from "./lineup";
import { playBout, spend } from "./runner";
import { SPRINT_CAPS } from "./sprint";

// ADR 0083: the house agent's daily Sprint, so the Sprint pages and share cards are never empty and the Sprint
// counter is honest about what it includes. One Sprint a day, played by a tested headline model through our own
// harness on the Anthropic key (BYOK) where one is in the lineup, then fed move by move into the ordinary Sprint
// endpoint so the referee, seal and report are exactly a visitor's. Labelled "house" with the model's name.
// Skipped in lean mode, without a provider key, when the month's Arena budget is used up, or over this own small cap.
// Review (ADR 0084): Claude on our Anthropic key (BYOK) only, never another model on OpenRouter credit; skipped while
// Claude bouts are held or a BYOK fallback was seen, and after the key's funding ends; a turn billed to credit stops
// the Sprint and holds Claude bouts; and a Sprint starts only if the month's spend plus a reserve stays within the cap.

export const HOUSE_SPRINT_MONTHLY_USD = 1;
/** The least a house Sprint is assumed to cost when the cap is checked (twice the last one's cost, if more). */
export const HOUSE_SPRINT_MIN_RESERVE_USD = 0.1;
const doneKey = (now: number) => `sprint:house:${day(now)}`;
const costKey = (now: number) => `sprint:house:cost:${new Date(now).toISOString().slice(0, 7)}`;
const LAST_COST_KEY = "sprint:house:last-cost";

/**
 * Today's house model: a tested headline Claude model on our own Anthropic key (BYOK), never retired or embargoed.
 * No other model: every other OpenRouter route spends prepaid OpenRouter credit (Dinike, 28 Oct), so with no such
 * Claude model there is no house Sprint.
 */
export function houseSprintModel(now: number): ArenaModel | null {
  const tested = new Set(testedModels().map((m) => m.id));
  const list = HEADLINE.filter((m) => tested.has(m.id) && !m.embargoed && !m.retired && isClaudeByok(m));
  if (!list.length) return null;
  return list[Math.floor(now / 86_400_000) % list.length]!;
}

export async function houseSprint(env: Env & { OPENROUTER_API_KEY?: string }, now = Date.now(), fetcher: typeof fetch = fetch) {
  if (!env.OPENROUTER_API_KEY) return { skipped: "no_provider_key" as const };
  if (now >= BYOK_EXPIRES) return { skipped: "byok_expired" as const };
  if (await env.KV.get(doneKey(now))) return { skipped: "done_today" as const };
  if (await isLean(env)) return { skipped: "lean" as const };
  // A Claude turn was billed to OpenRouter credit recently: no Claude bout of ours starts until that clears.
  if ((await byokHeld(env)) || (await byokFallbackSeen(env))) return { skipped: "byok_held" as const };
  const s = await spend(env, now);
  if (s.month >= s.monthCap) return { skipped: "arena_budget" as const };
  const spent = Number((await env.KV.get(costKey(now))) ?? 0) || 0;
  const last = Number((await env.KV.get(LAST_COST_KEY)) ?? 0) || 0;
  const reserve = Math.max(HOUSE_SPRINT_MIN_RESERVE_USD, 2 * last);
  if (spent + reserve > HOUSE_SPRINT_MONTHLY_USD) return { skipped: "house_sprint_budget" as const };
  const model = houseSprintModel(now);
  if (!model) return { skipped: "no_byok_model" as const };
  // Marked first, so a failure can't make it retry (and spend) every hour.
  await env.KV.put(doneKey(now), "1", { expirationTtl: 3 * 86_400 });
  const start = await startSprint(env, "house", { house: model.name }, now);
  if ("error" in start) return { skipped: start.error };
  // The seed is never in the start result (an agent could rebuild the sandbox offline); the runner reads it here.
  const bout = (await gauntletRun(getDb(env), start.gauntlet_id))?.bouts[0];
  if (!bout) return { skipped: "no_bout" as const };
  const addCost = async (usd: number) => {
    await env.KV.put(costKey(now), String(spent + usd), { expirationTtl: 40 * 86_400 });
    await env.KV.put(LAST_COST_KEY, String(usd), { expirationTtl: 40 * 86_400 });
  };
  let played: Awaited<ReturnType<typeof playBout>>;
  try {
    played = await playBout(env, model, { task: bout.task, seed: bout.seed }, null, { fetcher, caps: SPRINT_CAPS });
  } catch (e) {
    // The provider failed: nothing is known to be spent beyond the reserve; count the reserve so the cap stays real.
    await addCost(reserve);
    await voidHouseSprint(env, start.gauntlet_id);
    throw e;
  }
  if ("suspended" in played) {
    // Rate limited, or a turn was billed to OpenRouter credit instead of our key: stop here, never carry on.
    if (played.byokMissedNow) await noteByokFallback(env, model.id, now);
    await addCost(reserve);
    await voidHouseSprint(env, start.gauntlet_id);
    return { gauntlet_id: start.gauntlet_id, model: model.id, stopped: played.byokMissedNow ? ("byok_fallback" as const) : ("rate_limited" as const) };
  }
  if (played.byokMissed) await noteByokFallback(env, model.id, now);
  await addCost(played.result.cost);
  let finished = false;
  for (const e of played.log) {
    if (e.type !== "call") continue;
    const r = await gauntletAct(env, start.gauntlet_id, e.name, e.args, now);
    if (e.name === FINISH_TOOL.name || ("report" in r && r.report)) {
      finished = true;
      break;
    }
  }
  if (!finished) await endHouseSprint(env, start.gauntlet_id, played.result.reason === "knockout_tokens" || played.result.reason === "knockout_time" ? played.result.reason : "knockout_turns", now);
  return { gauntlet_id: start.gauntlet_id, model: model.id, reason: played.result.reason, cost: played.result.cost };
}

/**
 * A house Sprint whose model never played to the end (provider error, rate limit, or a turn billed to credit) is void:
 * deleted, like a voided Arena bout, so a provider's failure is never published or counted as the model's result.
 */
async function voidHouseSprint(env: Env, id: string) {
  const db = getDb(env);
  await db.delete(t.arenaGauntletBouts).where(eq(t.arenaGauntletBouts.gauntletId, id));
  await db.delete(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, id));
}
