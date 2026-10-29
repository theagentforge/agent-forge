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

/**
 * B3-06 (ADR 0099, Boardy round 3): the field-report total says what most of it is, wherever it appears (home band,
 * /about, /stats, /stats.json). The House agent's nightly install tests (integrations/house) are real installs, not
 * simulated, and the method is at HOUSE_METHOD_PATH. The number itself is unchanged; no House-only count is published
 * next to it (the total less a House count would be an outside-only number).
 */
export const FIELD_REPORTS_LABEL = "field reports filed (most are our House agent's nightly install tests)";
/**
 * The home band's short form (coordinator review, 29 Oct): the label is "field reports filed" and, in the same stat
 * item right under it, a one-line caption link to the House method note, so the House wording stays next to the
 * number (B3-06) without the long label wrapping on phones.
 */
export const FIELD_REPORTS_BAND_LABEL = "field reports filed";
export const FIELD_REPORTS_BAND_NOTE = "mostly our House install tests";
/**
 * The caption under tools tracked on the home band (review ADR 0115): most tools are registry listings, and since B3-14
 * about 20,000 are PyPI name matches ("mcp" in the name), so the number says what it is, beside it, linked to its rule.
 */
export const TOOLS_TRACKED_BAND_NOTE = "registry listings, not reviewed";
export const TOOLS_TRACKED_RULE_PATH = "/stats/rules#tools_tracked";
/** The method note for House install tests (/methodology). */
export const HOUSE_METHOD_ANCHOR = "house-install-tests";
export const HOUSE_METHOD_PATH = `/methodology#${HOUSE_METHOD_ANCHOR}`;

/**
 * The headline totals, in order. Tools tracked is a headline number too (Dinike, 29 Oct: a key metric for users and
 * buyers), shown last: our own work comes first and the registry-led count after it, the same order as PUBLIC_TOTALS
 * (/stats.json, /about, the buyer brief). It was only in the footnote before.
 */
export const WORK_LABELS = [
  ["bouts_refereed", "bouts refereed"],
  ["traps_sprung", "traps sprung"],
  ["skills_scanned", "skill files scanned"],
  ["field_reports", FIELD_REPORTS_LABEL],
  ["tools_tracked", "tools tracked"],
] as const;

/** The "last … ago" candidates for the footnote; the page shows the two most recent. */
export const WORK_RECENCY = [
  ["last_report_at", "last field report"],
  ["last_scan_at", "last skill scan"],
  ["last_tool_at", "last tool added"],
  ["last_bout_at", "last bout"],
] as const;
