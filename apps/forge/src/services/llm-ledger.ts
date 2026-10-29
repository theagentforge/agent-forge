// ADR 0113: what each automated task spends on model calls outside the Arena, by day, for /admin/costs. Arena bouts are
// stored per run in D1 (arena_runs.cost and byok_cost), so they aren't counted here. One KV entry per UTC day, kept 40
// days; read-modify-write, so two calls in the same instant can under-count by one call (an estimate, labelled so).

export type LedgerTask = "moltbook_replies" | "moltbook_challenge" | "moderation";
export interface LedgerLine {
  calls: number;
  /** Dollars billed to the Anthropic key through OpenRouter BYOK (OpenRouter's reported upstream cost). */
  anthropic_usd: number;
  /** Dollars billed to OpenRouter credit (a BYOK fallback, or a non-BYOK route). */
  credit_usd: number;
  /** Workers AI neurons (Workers AI's own figure when it reports one, else the published rates). */
  neurons: number;
  /** Prompt tokens read from the provider's cache, and written to it (when it reports them). */
  cached_tokens: number;
  cache_write_tokens: number;
}
export type LedgerDay = Partial<Record<LedgerTask, LedgerLine>>;

export const LEDGER_TTL = 40 * 86_400;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const ledgerKey = (ms: number) => `llmcost:${utcDay(ms)}`;
const empty = (): LedgerLine => ({ calls: 0, anthropic_usd: 0, credit_usd: 0, neurons: 0, cached_tokens: 0, cache_write_tokens: 0 });

/** Adds one call's spend to today's line for `task`. Never throws. */
export async function recordSpend(kv: KVNamespace, task: LedgerTask, add: Partial<LedgerLine>, now = Date.now()) {
  try {
    const key = ledgerKey(now);
    const day = (await kv.get<LedgerDay>(key, "json")) ?? {};
    const line = { ...empty(), ...day[task] };
    for (const k of Object.keys(line) as (keyof LedgerLine)[]) {
      const v = Number(add[k] ?? (k === "calls" ? 1 : 0));
      if (Number.isFinite(v) && v > 0) line[k] = Math.round((line[k] + v) * 1e8) / 1e8;
    }
    day[task] = line;
    await kv.put(key, JSON.stringify(day), { expirationTtl: LEDGER_TTL });
  } catch (e) {
    console.warn("llm_ledger_write_failed", task, String(e));
  }
}

/** The ledger's days from `from` to `to` (inclusive, UTC days), summed by task, plus the per-day lines. */
export async function readLedger(kv: KVNamespace, from: number, to: number) {
  const days: { day: string; lines: LedgerDay }[] = [];
  const total: Partial<Record<LedgerTask, LedgerLine>> = {};
  for (let d = Date.parse(`${utcDay(from)}T00:00:00Z`); d <= to; d += 86_400_000) {
    const lines = (await kv.get<LedgerDay>(ledgerKey(d), "json").catch(() => null)) ?? {};
    days.push({ day: utcDay(d), lines });
    for (const [task, line] of Object.entries(lines) as [LedgerTask, LedgerLine][]) {
      const t = (total[task] ??= empty());
      for (const k of Object.keys(t) as (keyof LedgerLine)[]) t[k] = Math.round((t[k] + Number(line[k] ?? 0)) * 1e8) / 1e8;
    }
  }
  return { days, total };
}
