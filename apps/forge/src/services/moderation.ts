// Llama Guard moderation of free-text notes (MASTER_PLAN §6.8). Returns "pending" if the model is unavailable,
// in which case the note is stored but never shown until it is moderated.

export type ModerationResult = "approved" | "rejected" | "pending";

export const MODERATION_MODEL = "@cf/meta/llama-guard-3-8b";

export async function moderateNote(ai: Ai, note: string): Promise<ModerationResult> {
  try {
    const out = (await ai.run(MODERATION_MODEL as keyof AiModels, {
      messages: [{ role: "user", content: note }],
    } as never)) as { response?: unknown };
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

export async function moderateWithinBudget(env: Pick<Env, "AI" | "KV">, note: string, now = Date.now()): Promise<ModerationResult> {
  if (!(await takeModerationBudget(env.KV, now))) return "pending";
  return moderateNote(env.AI, note);
}
