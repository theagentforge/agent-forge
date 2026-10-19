// The cost guard's switch (ADR 0027). "lean" turns off everything that writes on a visitor's behalf (usage counters,
// check sources, trap card counts, stored scans, new Gauntlet runs) and serves the site-wide share image instead of
// drawing new ones, so a traffic spike costs requests only. The site, checks and scans keep working. The switch is the
// KV key `ops:mode`, set by the daily usage check (docs/runbooks/cost-guard.md) or by hand; each isolate reads it at
// most once a minute, so the switch itself adds almost no KV reads.

export type OpsMode = "normal" | "lean";
export const OPS_MODE_KEY = "ops:mode";
const TTL_MS = 60_000;
let cached: { mode: OpsMode; at: number } | null = null;

export async function opsMode(env: Pick<Env, "KV">, now = Date.now()): Promise<OpsMode> {
  if (cached && now - cached.at < TTL_MS) return cached.mode;
  let mode: OpsMode = "normal";
  try {
    mode = (await env.KV.get(OPS_MODE_KEY)) === "lean" ? "lean" : "normal";
  } catch {
    // KV unreachable: keep serving; the guard is a saving, not a gate.
  }
  cached = { mode, at: now };
  return mode;
}

export const isLean = async (env: Pick<Env, "KV">) => (await opsMode(env)) === "lean";

/** Tests only: forget the cached mode. */
export const resetOpsModeCache = () => {
  cached = null;
};
