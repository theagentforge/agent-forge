// Llama Guard moderation of free-text notes (MASTER_PLAN §6.8). Returns "pending" if the model is unavailable,
// in which case the note is stored but never shown until it is moderated.
import { countNeurons, NEURONS_PER_MODERATION, waiRoom } from "../arena/free-lane";
import { recordSpend } from "./llm-ledger";

export type ModerationResult = "approved" | "rejected" | "pending";

export const MODERATION_MODEL = "@cf/meta/llama-guard-3-8b";

export async function moderateNote(ai: Ai, note: string, onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number; neurons?: number } | undefined) => Promise<void>): Promise<ModerationResult> {
  try {
    const out = (await ai.run(MODERATION_MODEL as keyof AiModels, {
      messages: [{ role: "user", content: note }],
      // The verdict is "safe" or "unsafe" plus category codes: a few tokens (ADR 0113).
      max_tokens: 16,
    } as never)) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number } };
    await onUsage?.(out?.usage).catch(() => {});
    const verdict = out.response;
    const safe =
      typeof verdict === "string"
        ? verdict.trim().toLowerCase().startsWith("safe")
        : typeof verdict === "object" && verdict !== null && (verdict as { safe?: unknown }).safe === true;
    const unsafe =
      typeof verdict === "string"
        ? verdict.trim().toLowerCase().startsWith("unsafe")
        : typeof verdict === "object" && verdict !== null && (verdict as { safe?: unknown }).safe === false;
    if (safe) return "approved";
    if (unsafe) return "rejected";
    return "pending";
  } catch {
    return "pending";
  }
}

// Cost guard. Workers AI includes 10,000 neurons a day; one Llama Guard check of a short note uses about 15, so 600
// checks a day stay inside the free allowance with room to spare. Past the cap a note waits as "pending" (never shown)
// and the hourly cron moderates it once the next day's allowance starts. The count lives in KV and is approximate.
export const MODERATION_DAILY_CAP = 600;

const budgetKey = (now: number) => `mod-count:${new Date(now).toISOString().slice(0, 10)}`;

/** Reserves one moderation call from today's allowance. False when the allowance is spent. */
export async function takeModerationBudget(kv: KVNamespace, now = Date.now()): Promise<boolean> {
  const key = budgetKey(now);
  const used = Number((await kv.get(key)) ?? "0");
  if (used >= MODERATION_DAILY_CAP) return false;
  await kv.put(key, String(used + 1), { expirationTtl: 3 * 86400 });
  return true;
}

/** A verdict for exactly the same note text is kept this long, so the same note is never sent twice (ADR 0113). */
export const MODERATION_CACHE_TTL = 30 * 86_400;
const cacheKey = async (note: string) =>
  `mod-cache:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(note.trim())))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

export async function moderateWithinBudget(env: Env, note: string, now = Date.now()): Promise<ModerationResult> {
  // ADR 0113: an identical note already judged gets the same verdict without a model call.
  const key = await cacheKey(note);
  const cached = await env.KV.get(key).catch(() => null);
  if (cached === "approved" || cached === "rejected") return cached;
  // ADR 0113: moderation shares the day's Workers AI line with everything else; past it, the note waits (never shown).
  if (!(await waiRoom(env, "moderation", NEURONS_PER_MODERATION, Number.POSITIVE_INFINITY, now))) return "pending";
  if (!(await takeModerationBudget(env.KV, now))) return "pending";
  const verdict = await moderateNote(env.AI, note, async (usage) => {
    const neurons = await countNeurons(env.KV, "moderation", MODERATION_MODEL, usage, { tokensIn: Math.ceil(note.length / 3) + 200, tokensOut: 8 }, now);
    await recordSpend(env.KV, "moderation", { neurons }, now);
  });
  if (verdict !== "pending") await env.KV.put(key, verdict, { expirationTtl: MODERATION_CACHE_TTL }).catch(() => {});
  return verdict;
}
