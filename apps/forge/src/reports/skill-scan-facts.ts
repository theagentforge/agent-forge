import skillScanReport from "../../../../docs/reports/2026-10-skill-scan.md";

// The launch skill scan's headline numbers, read from the report itself (docs/reports/2026-10-skill-scan.md, the page
// at /reports/skill-scan-2026-10): its "What we found" table and its dated byline. The home page's launch-scan line is
// built from this, so no number on it is typed twice (a denominator can't be typed wrong in one place only). The rate
// is computed from the two counts and must match the rate the report prints; if the table can't be read, or the two
// disagree, this returns null and the line is left out rather than shown with a guess.

export interface LaunchScanFacts {
  /** "19 Oct 2026", from the report's byline. */
  date: string;
  /** Ordinary skills scanned (the table's Files row, first column). */
  ordinary: number;
  /** Ordinary skills flagged (the table's Flagged row, first column). */
  flagged: number;
  /** flagged / ordinary as a percentage to 2 decimals, e.g. "0.33". */
  pct: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const int = (s: string) => Number(s.replace(/,/g, ""));

export function parseLaunchScan(markdown: string): LaunchScanFacts | null {
  const files = /^\|\s*Files\s*\|\s*([\d,]+)\s*\|/m.exec(markdown);
  const flagged = /^\|\s*Flagged\s*\|\s*([\d,]+)\s*\(([\d.]+)%\)/m.exec(markdown);
  const by = new RegExp(`^\\*The Agent Forge, (\\d{1,2}) (${MONTHS.join("|")}) (\\d{4})\\.`, "m").exec(markdown);
  if (!files || !flagged || !by) return null;
  const ordinary = int(files[1]!);
  const n = int(flagged[1]!);
  if (!(ordinary > 0) || !Number.isInteger(n)) return null;
  const pct = (Math.round((n / ordinary) * 10000) / 100).toFixed(2);
  if (pct !== flagged[2]) return null;
  return { date: `${by[1]} ${by[2]!.slice(0, 3)} ${by[3]}`, ordinary, flagged: n, pct };
}

export const LAUNCH_SCAN: LaunchScanFacts | null = parseLaunchScan(skillScanReport);

/** "Launch scan, 19 Oct 2026: 30 of 9,014 ordinary public skills flagged (0.33%)", or null when unreadable. */
export const launchScanHeadline = (f: LaunchScanFacts | null = LAUNCH_SCAN) =>
  f ? `Launch scan, ${f.date}: ${f.flagged} of ${f.ordinary.toLocaleString("en-US")} ordinary public skills flagged (${f.pct}%)` : null;
