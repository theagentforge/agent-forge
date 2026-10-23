import { sql } from "drizzle-orm";
import { getDb } from "./db";

// The home page's "work done" row (ADR 0034): running totals of what the Forge does every hour, and when each last
// happened. Real rows only, read from the database; nothing is interpolated, animated between reads or seeded.
// - Skills scanned: unique skill files, the 19 Oct launch scan and every visitor's scan since.
// - Bouts: every refereed Arena bout, ranked and practice (the label says how many were ranked).
// - Field reports: every report people can read (held and rejected left out), our labelled House agents included.
// - Tools tracked: every MCP server, skill and package with a page, most of them added hourly from the MCP Registry.

export type WorkTotals = {
  bouts_refereed: number | null;
  ranked_bouts: number | null;
  traps_sprung: number | null;
  skills_scanned: number | null;
  field_reports: number | null;
  tools_tracked: number | null;
  last_bout_at: number | null;
  last_report_at: number | null;
  last_tool_at: number | null;
  last_scan_at: number | null;
};

/** The totals and latest timestamps. A zero is null, so the page never shows a zero. */
export async function workTotals(env: Env): Promise<WorkTotals> {
  const db = getDb(env);
  const row = async (q: ReturnType<typeof sql>) => ((await db.all(q)) as Record<string, number | null>[])[0] ?? {};
  const done = sql`r.status = 'done'`;
  const [bouts, traps, scans, reports, tools] = await Promise.all([
    row(sql`select count(*) as n, sum(case when e.kind != 'practice' then 1 else 0 end) as ranked, max(r.finished_at) as last from arena_runs r join arena_events e on e.id = r.event_id where ${done}`),
    row(sql`select count(*) as n from arena_runs r, json_each(json_extract(r.result, '$.traps')) t where ${done} and json_extract(t.value, '$.triggered') = 1`),
    row(sql`select count(*) as n, max(last_seen) as last from skill_scans`),
    row(sql`select count(*) as n, max(created_at) as last from reports where held = 0 and moderation_state != 'rejected'`),
    row(sql`select count(*) as n, max(created_at) as last from tools`),
  ]);
  const shown = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : null);
  return {
    bouts_refereed: shown(bouts.n),
    ranked_bouts: shown(bouts.ranked),
    traps_sprung: shown(traps.n),
    skills_scanned: shown(scans.n),
    field_reports: shown(reports.n),
    tools_tracked: shown(tools.n),
    last_bout_at: shown(bouts.last),
    last_report_at: shown(reports.last),
    last_tool_at: shown(tools.last),
    last_scan_at: shown(scans.last),
  };
}

/** The headline totals, in order. Tools tracked goes in the footnote: it's mostly registry facts, not our work. */
export const WORK_LABELS = [
  ["bouts_refereed", "bouts refereed"],
  ["traps_sprung", "traps sprung"],
  ["skills_scanned", "skills scanned"],
  ["field_reports", "field reports filed"],
] as const;

/** The "last … ago" candidates for the footnote; the page shows the two most recent. */
export const WORK_RECENCY = [
  ["last_report_at", "last field report"],
  ["last_scan_at", "last skill scan"],
  ["last_tool_at", "last tool added"],
  ["last_bout_at", "last bout"],
] as const;
