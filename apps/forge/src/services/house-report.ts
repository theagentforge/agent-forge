import { z } from "zod";

// The Forge House Report (ADR 0011 b): every night the House tester starts the most-downloaded no-setup MCP servers
// from the official registry and sends the whole night's results here. Kept in KV: the latest run, each day's run
// (120 days) and a small history of daily counts. Public data; nothing user-supplied but package names and numbers.

export const OUTCOMES = ["worked", "partial", "failed", "needs_config", "no_answer", "not_on_npm", "error"] as const;
export type HouseOutcome = (typeof OUTCOMES)[number];

const entrySchema = z.strictObject({
  pkg: z.string().max(214).regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/),
  version: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/).nullable(),
  outcome: z.enum(OUTCOMES),
  slow: z.boolean(),
  tools: z.number().int().min(0).max(9_999).nullable(),
  ms: z.number().int().min(0).max(600_000).nullable(),
  downloads: z.number().int().min(0).max(1e12).nullable(),
  rank: z.number().int().min(1).max(10_000).nullable(),
});
export const runSchema = z.strictObject({
  probedAt: z.iso.datetime(),
  entries: z.array(entrySchema).min(1).max(1000),
});
export type HouseRun = z.infer<typeof runSchema> & { counts: Record<HouseOutcome, number> };
export type HouseEntry = z.infer<typeof entrySchema>;

export interface HistoryPoint {
  day: string;
  total: number;
  counts: Record<HouseOutcome, number>;
}

const KEY_LATEST = "house:run:latest";
const KEY_HISTORY = "house:history";
const dayKey = (day: string) => `house:run:${day}`;

export function countOutcomes(entries: HouseEntry[]) {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<HouseOutcome, number>;
  for (const e of entries) counts[e.outcome]++;
  return counts;
}

/** Stores one night's run. The same day sent twice replaces itself (a re-run), it never double counts. */
export async function storeRun(env: Env, input: unknown) {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, detail: parsed.error.issues[0]?.message };
  const entries = [...parsed.data.entries].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.pkg.localeCompare(b.pkg));
  const run: HouseRun = { probedAt: parsed.data.probedAt, entries, counts: countOutcomes(entries) };
  const day = run.probedAt.slice(0, 10);
  const history = ((await env.KV.get<HistoryPoint[]>(KEY_HISTORY, "json")) ?? []).filter((h) => h.day !== day);
  history.push({ day, total: entries.length, counts: run.counts });
  history.sort((a, b) => a.day.localeCompare(b.day));
  const body = JSON.stringify(run);
  await Promise.all([
    env.KV.put(KEY_LATEST, body),
    env.KV.put(dayKey(day), body, { expirationTtl: 120 * 86_400 }),
    env.KV.put(KEY_HISTORY, JSON.stringify(history.slice(-120))),
  ]);
  return { ok: true as const, day, servers: entries.length };
}

export const latestRun = (env: Env) => env.KV.get<HouseRun>(KEY_LATEST, "json");
export const runForDay = (env: Env, day: string) => env.KV.get<HouseRun>(dayKey(day), "json");
export const history = async (env: Env) => (await env.KV.get<HistoryPoint[]>(KEY_HISTORY, "json")) ?? [];

/** Servers that worked in the earlier run but don't now (same package, compared across versions). */
export function newlyBroken(now: HouseRun, before: HouseRun | null) {
  if (!before) return [];
  const was = new Map(before.entries.map((e) => [e.pkg, e]));
  return now.entries.filter((e) => was.get(e.pkg)?.outcome === "worked" && (e.outcome === "failed" || e.outcome === "partial" || e.outcome === "no_answer"));
}

export const pct = (n: number, total: number) => (total ? Math.round((1000 * n) / total) / 10 : 0);

export const CSV_HEADER = "rank,package,version,outcome,slow,tools,ms,weekly_downloads";
export function toCsv(run: HouseRun) {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return [CSV_HEADER, ...run.entries.map((e) => [e.rank, e.pkg, e.version, e.outcome, e.slow, e.tools, e.ms, e.downloads].map(cell).join(","))].join("\n") + "\n";
}
