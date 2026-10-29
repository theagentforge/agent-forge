import { isRescoredGroup, RULES_VERSION, rulesReading, rulesVersionAt, scoredUnderOf } from "@forge/arena";

// F-01 (build plan 28 Oct, Boardy 0.1; ADR 0082): every chart and rate names the referee rules that scored it, or links
// to a page that does. A count across several rules versions says which versions and how many under each, and points
// to the current-rules results (/security#arena), which never pool rules versions (ADR 0068 Amendment 1).

/** Where the ranked results scored under the current rules alone are published. */
export const CURRENT_RULES_PATH = "/security#arena";

export interface RulesCount {
  version: string;
  n: number;
}

const byVersion = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** Bouts per rules version, oldest version first. */
export function tallyRules(runs: { finishedAt: number; result: unknown }[]): RulesCount[] {
  const by = new Map<string, number>();
  for (const r of runs) {
    const v = rulesVersionAt(r.finishedAt, r.result as { rules?: unknown } | null);
    by.set(v, (by.get(v) ?? 0) + 1);
  }
  return [...by.entries()].map(([version, n]) => ({ version, n })).sort((a, b) => byVersion(a.version, b.version));
}

/**
 * "rules 0.6", or "rules 0.2–0.6" across several versions; null with none. A re-scored group (B2-01, "rules 0.6
 * re-scored") spans as the rules that scored it; alone it keeps its full name.
 */
export function rulesSpan(list: { version: string }[]): string | null {
  const groups = [...new Set(list.map((x) => x.version))];
  if (groups.length === 1) return groups[0]!;
  const v = [...new Set(groups.map(scoredUnderOf))].sort(byVersion);
  if (!v.length) return null;
  return v.length === 1 ? v[0]! : `${v[0]}–${v.at(-1)!.replace(/^rules\s+/, "")}`;
}

/** "0.6 re-scored from signed logs" for a re-scored group, "0.4" for a native one. */
const short = (group: string) => (isRescoredGroup(group) ? `${scoredUnderOf(group).replace(/^rules\s+/, "")} re-scored from signed logs` : group.replace(/^rules\s+/, ""));

/**
 * "rules 0.2–0.6 (0.2: 190; 0.4: 91; 0.6: 12; 0.6 re-scored from signed logs: 200)": the span with every group present
 * and its count, so runs re-scored under a version are never read as played under it (ADR 0088).
 */
export function rulesText(list: RulesCount[]): string | null {
  const span = rulesSpan(list);
  if (!span) return null;
  if (list.length === 1) return isRescoredGroup(list[0]!.version) ? `${scoredUnderOf(list[0]!.version)}, re-scored from signed logs` : span;
  return `${span} (${list.map((x) => `${short(x.version)}: ${x.n.toLocaleString("en-US")}`).join("; ")})`;
}

/** As structured data: version → bouts. */
export const rulesRecord = (list: RulesCount[]) => Object.fromEntries(list.map((x) => [x.version, x.n]));

export { RULES_VERSION };

/**
 * One run's rules, as data (ADR 0088): the group it is counted in, the rules that scored it, the rules it was played
 * under, and whether it was re-scored from its signed log.
 */
export function rulesFields(finishedAt: number, result: unknown) {
  const r = rulesReading(finishedAt, result as { rules?: unknown; rescored?: unknown } | null);
  return { rules_version: rulesVersionAt(finishedAt, result as { rules?: unknown } | null), scored_under: r.scored_under, played_under: r.played_under, rescored_from_signed_logs: r.rescored };
}
