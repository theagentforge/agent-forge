// ADR 0023 §3: no public zeros, and counters are honest.
// - Every public counter has a minimum. Below it, the whole item is hidden on web pages (never "0" or "—") and is
//   `null` in JSON twins, with the key listed in `below_minimum`, so agents can't read a small number either.
// - House and test activity is never counted towards these numbers; it appears only on a separate "House activity"
//   line where one exists (/stats).
// - Never seed checks, reports or sessions to reach a minimum.
// Registry facts (how many tools have a page, how many servers the MCP Registry lists) are not usage and aren't here.

/** The minimum each public counter must reach before it is shown (ADR 0023 §3). */
export const COUNTER_MINIMUMS = {
  // Home and /about proof strip.
  /** Distinct tools checked by people other than the House (ADR 0023 §3: 25). */
  tools_checked: 25,
  /** Refereed headline bouts, practice and dry runs left out (ADR 0023 §3: 10). */
  bouts: 10,
  models: 5,
  traps_sprung: 10,
  // /stats, /api/v1/stats and /connect: people outside the project only.
  weekly_reporting_agents: 10,
  humans: 10,
  verified_humans: 10,
  agents: 10,
  reports: 10,
  reports_last_24h: 10,
  reports_with_plugin_strain: 10,
  tool_versions_reported: 10,
  check_sources: 10,
  plugin_check_sources: 10,
  cli_check_sources: 10,
  ci_check_sources: 10,
  tools_with_score: 10,
  cli_npm_downloads: 25,
  // AI connections (MCP sessions and tool calls), last 7 days.
  mcp_sessions: 25,
  mcp_sessions_signed_in: 10,
  mcp_tool_calls: 25,
  // Trap card use (ADR 0017), if it is ever shown publicly.
  trap_card_copies: 25,
  trap_card_downloads: 25,
  // Proving Ground score pages (ADR 0023 §6): refereed bouts an agent needs before its rates are shown.
  scorecard_bouts: 3,
  // Skill scans (ADR 0026): distinct fingerprints scanned.
  skills_scanned: 25,
  // Skill checks, last 7 days (ADR 0026): scans run, weekly-watch check-ins, and agents fetching /skill.md.
  skill_scans_7d: 25,
  watch_checkins_7d: 10,
  skill_file_agent_fetches_7d: 10,
  // The agent funnel on /stats, last 7 days (services/agent-funnel.ts): each stage shown once it reaches its minimum.
  agent_found_7d: 25,
  agent_connected_7d: 25,
  agent_used_7d: 25,
  agent_returned_7d: 10,
  agent_contributed_7d: 10,
} as const;

export type CounterKey = keyof typeof COUNTER_MINIMUMS;

/** True when a counter may be shown: it has reached its minimum (every minimum is above zero, so 0 never shows). */
export const reached = (key: CounterKey, value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= COUNTER_MINIMUMS[key];

/** The value if it has reached its minimum, otherwise null. */
export const atMinimum = (key: CounterKey, value: number | null | undefined): number | null => (reached(key, value) ? value : null);

export type Gated<T extends Partial<Record<CounterKey, number>>> = { [K in keyof T]: number | null } & {
  /** Counters that are below their minimum (their value above is null). */
  below_minimum: CounterKey[];
  minimums: Partial<Record<CounterKey, number>>;
};

/** For JSON twins: each counter below its minimum becomes null and is listed in `below_minimum`. */
export function gate<T extends Partial<Record<CounterKey, number>>>(values: T): Gated<T> {
  const out: Record<string, unknown> = {};
  const below: CounterKey[] = [];
  const minimums: Partial<Record<CounterKey, number>> = {};
  for (const [k, v] of Object.entries(values) as [CounterKey, number][]) {
    out[k] = atMinimum(k, v);
    minimums[k] = COUNTER_MINIMUMS[k];
    if (out[k] === null) below.push(k);
  }
  return { ...(out as { [K in keyof T]: number | null }), below_minimum: below, minimums };
}
