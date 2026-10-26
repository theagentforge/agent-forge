import { displayVerdict, VERDICT_WORD, type DisplayVerdict } from "./verdict";
import type { CheckSecurity } from "./scoring";

// "Since your last check" (retention plan, 26 Oct 2026): the plugin hook, the CLI and the GitHub Actions keep the last
// answer they got for each tool version (or skill fingerprint) on the machine that asked, and say what changed when
// they ask again. The Forge stays stateless for anonymous use: nothing about the earlier answer is sent back, and the
// memory never leaves the machine. Pure functions here; each caller does its own file I/O.
// Every line is data (AGENTS.md rule 7): counts, ids, verdict words and dates, never instructions.

export const MEMORY_SCHEMA = 1;
/** Entries kept per memory file (newest first); older ones are dropped. */
export const MEMORY_MAX_ENTRIES = 400;
/** Entries not seen for this long are dropped. */
export const MEMORY_MAX_AGE_MS = 180 * 86_400_000;

/** What is remembered about one check answer. Counts and ids only. */
export interface CheckMemo {
  at: string;
  verdict: DisplayVerdict;
  security: CheckSecurity | string;
  score: number | null;
  reports: number;
  outcomes: { worked: number; partial: number; failed: number };
  advisories: string[];
  /** The version the reports are on (the Forge's answer, which can differ from the one asked about). */
  version: string | null;
}

/** What is remembered about one installed skill in the weekly watch. */
export interface WatchMemo {
  at: string;
  verdict: string | null;
  rules: string | null;
  rescan: boolean;
  versions_with_reports: number;
}

export interface MemoryFile {
  v: typeof MEMORY_SCHEMA;
  checks: Record<string, CheckMemo>;
  watch: Record<string, WatchMemo>;
  /** The scan rules version the last weekly watch saw. */
  rules?: string;
  /** When the last weekly pass ran (ISO). */
  weekly_at?: string;
}

/** The parts of a check answer the memory reads. Anything missing counts as zero. */
export interface CheckAnswerLike {
  tool?: { id: string } | null;
  version?: string | null;
  asked_version?: string;
  forge_score: number | null;
  security_status: CheckSecurity;
  reports_for_this_version?: number;
  outcome_breakdown?: { worked: number; partial: number; failed: number };
  public_signals_summary?: { advisories: { id: string }[] } | null;
  share?: { receipt_url?: unknown };
}

export const emptyMemory = (): MemoryFile => ({ v: MEMORY_SCHEMA, checks: {}, watch: {} });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Reads a memory file's text; anything unreadable or from another schema starts fresh. Never throws. */
export function parseMemory(text: string | null | undefined): MemoryFile {
  if (!text) return emptyMemory();
  try {
    const m = JSON.parse(text) as unknown;
    if (!isObj(m) || m.v !== MEMORY_SCHEMA) return emptyMemory();
    return {
      v: MEMORY_SCHEMA,
      checks: isObj(m.checks) ? (m.checks as Record<string, CheckMemo>) : {},
      watch: isObj(m.watch) ? (m.watch as Record<string, WatchMemo>) : {},
      ...(typeof m.rules === "string" ? { rules: m.rules } : {}),
      ...(typeof m.weekly_at === "string" ? { weekly_at: m.weekly_at } : {}),
    };
  } catch {
    return emptyMemory();
  }
}

/** Drops old and excess entries, newest kept. */
function trim<T extends { at: string }>(rec: Record<string, T>, now: number): Record<string, T> {
  const kept = Object.entries(rec)
    .filter(([, m]) => isObj(m) && typeof m.at === "string" && now - Date.parse(m.at) < MEMORY_MAX_AGE_MS)
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
    .slice(0, MEMORY_MAX_ENTRIES);
  return Object.fromEntries(kept);
}

export function serializeMemory(m: MemoryFile, now = Date.now()): string {
  return JSON.stringify({ ...m, checks: trim(m.checks, now), watch: trim(m.watch, now) });
}

/** The memory key for a check: the tool id and the version asked about ("*" when none was pinned). */
export const checkKey = (id: string, version?: string | null) => `${id.trim().toLowerCase()}@${version || "*"}`;

/** Splits a check key back into the id and the pinned version (undefined for "*"). */
export function splitCheckKey(key: string): { id: string; version?: string } {
  const at = key.lastIndexOf("@");
  const id = at > 0 ? key.slice(0, at) : key;
  const version = at > 0 ? key.slice(at + 1) : "*";
  return version === "*" ? { id } : { id, version };
}

export function checkMemo(c: CheckAnswerLike, at: string): CheckMemo {
  const b = c.outcome_breakdown ?? { worked: 0, partial: 0, failed: 0 };
  return {
    at,
    verdict: displayVerdict(c),
    security: c.security_status,
    score: c.forge_score ?? null,
    reports: c.reports_for_this_version ?? b.worked + b.partial + b.failed,
    outcomes: { worked: b.worked ?? 0, partial: b.partial ?? 0, failed: b.failed ?? 0 },
    advisories: [...new Set((c.public_signals_summary?.advisories ?? []).map((a) => a.id).filter((id) => typeof id === "string"))].sort(),
    version: c.version ?? null,
  };
}

export interface CheckChanges {
  /** When the earlier answer was given (ISO). */
  since: string;
  new_reports: number;
  new_outcomes: { worked: number; partial: number; failed: number };
  new_advisories: string[];
  verdict: { from: DisplayVerdict; to: DisplayVerdict } | null;
  security: { from: string; to: string } | null;
  score: { from: number | null; to: number | null } | null;
  /** The version the reports are on moved (a newer version reached the Forge). */
  version: { from: string | null; to: string | null } | null;
  changed: boolean;
}

/** What changed between two answers for the same key; null when there is no earlier answer. */
export function checkChanges(prev: CheckMemo | undefined, next: CheckMemo): CheckChanges | null {
  if (!prev || !isObj(prev)) return null;
  const po = prev.outcomes ?? { worked: 0, partial: 0, failed: 0 };
  const sameVersion = (prev.version ?? null) === next.version;
  const pos = (n: number) => Math.max(0, n);
  const new_outcomes = sameVersion
    ? { worked: pos(next.outcomes.worked - (po.worked ?? 0)), partial: pos(next.outcomes.partial - (po.partial ?? 0)), failed: pos(next.outcomes.failed - (po.failed ?? 0)) }
    : { ...next.outcomes };
  const new_reports = sameVersion ? pos(next.reports - (prev.reports ?? 0)) : next.reports;
  const before = new Set(Array.isArray(prev.advisories) ? prev.advisories : []);
  const new_advisories = next.advisories.filter((a) => !before.has(a));
  const verdict = prev.verdict !== next.verdict ? { from: prev.verdict, to: next.verdict } : null;
  const security = prev.security !== next.security ? { from: String(prev.security), to: String(next.security) } : null;
  const score = (prev.score ?? null) !== next.score ? { from: prev.score ?? null, to: next.score } : null;
  const version = sameVersion ? null : { from: prev.version ?? null, to: next.version };
  return {
    since: prev.at,
    new_reports,
    new_outcomes,
    new_advisories,
    verdict,
    security,
    score,
    version,
    changed: !!(new_reports || new_advisories.length || verdict || security || score || version),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? iso);
const word = (v: string) => VERDICT_WORD[v as DisplayVerdict] ?? v.replace(/_/g, " ");

/** One line of data: "since last check (2026-10-19): 2 new field reports (1 worked, 1 failed); …". */
export function sinceLine(c: CheckChanges | null): string {
  if (!c) return "since last check: first check of this version from here";
  if (!c.changed) return `since last check (${day(c.since)}): no change`;
  const parts: string[] = [];
  if (c.version) parts.push(`reports now on version ${c.version.to ?? "none"} (was ${c.version.from ?? "none"})`);
  if (c.new_reports) {
    const o = c.new_outcomes;
    const split = [o.worked && `${o.worked} worked`, o.partial && `${o.partial} partial`, o.failed && `${o.failed} failed`].filter(Boolean).join(", ");
    parts.push(`${plural(c.new_reports, "new field report")}${split ? ` (${split})` : ""}`);
  }
  if (c.new_advisories.length) parts.push(`${c.new_advisories.length === 1 ? "new published advisory" : "new published advisories"} ${c.new_advisories.slice(0, 5).join(", ")}${c.new_advisories.length > 5 ? ` and ${c.new_advisories.length - 5} more` : ""}`);
  if (c.verdict) parts.push(`verdict ${word(c.verdict.from)} → ${word(c.verdict.to)}`);
  if (c.security && !c.verdict) parts.push(`security status ${word(c.security.from)} → ${word(c.security.to)}`);
  if (c.score && !c.verdict) parts.push(`Forge Score ${c.score.from ?? "none"} → ${c.score.to ?? "none"}`);
  return `since last check (${day(c.since)}): ${parts.join("; ")}`;
}

/** The signed receipt link in an answer, only when it is on the Forge origin asked. */
export function receiptOf(c: { share?: { receipt_url?: unknown } } | null | undefined, origin: string): string | null {
  const u = c?.share?.receipt_url;
  return typeof u === "string" && u.startsWith(`${origin}/r/`) && !/\s/.test(u) ? u : null;
}

/** One item of a /api/v1/watch answer (the REST twin of forge_watch). */
export interface WatchItemLike {
  fingerprint: string;
  known: boolean;
  verdict: string | null;
  rules_version: string | null;
  rescan_needed: boolean;
  versions_with_reports: number;
}

export const watchMemo = (i: WatchItemLike, at: string): WatchMemo => ({
  at,
  verdict: i.verdict,
  rules: i.rules_version,
  rescan: i.rescan_needed,
  versions_with_reports: i.versions_with_reports ?? 0,
});

export interface WatchChanges {
  since: string | null;
  verdict: { from: string | null; to: string | null } | null;
  new_versions_with_reports: number;
  /** True when this pass is the first to see that it needs a fresh scan. */
  newly_needs_rescan: boolean;
  changed: boolean;
}

export function watchChanges(prev: WatchMemo | undefined, next: WatchMemo): WatchChanges {
  if (!prev || !isObj(prev)) return { since: null, verdict: null, new_versions_with_reports: 0, newly_needs_rescan: false, changed: false };
  const verdict = prev.verdict !== next.verdict ? { from: prev.verdict, to: next.verdict } : null;
  const new_versions_with_reports = Math.max(0, next.versions_with_reports - (prev.versions_with_reports ?? 0));
  const newly_needs_rescan = next.rescan && !prev.rescan;
  return { since: prev.at, verdict, new_versions_with_reports, newly_needs_rescan, changed: !!(verdict || new_versions_with_reports || newly_needs_rescan) };
}

/** One line per watched skill: "skill name (sha256:abc…): needs a fresh scan (rules 2026-10-23.1); …". */
export function watchLine(label: string, next: WatchMemo, c: WatchChanges, rules: string): string {
  const parts: string[] = [];
  parts.push(next.verdict ? `scan ${next.verdict}` : "not scanned on the Forge yet");
  if (next.rescan && next.verdict) parts.push(`needs a fresh scan (rules ${rules})`);
  if (c.verdict && c.since) parts.push(`scan ${c.verdict.from ?? "none"} → ${c.verdict.to ?? "none"} since ${day(c.since)}`);
  if (c.new_versions_with_reports) parts.push(`${plural(c.new_versions_with_reports, "new reported version")} since ${day(c.since!)}`);
  return `${label}: ${parts.join("; ")}`;
}

/** The weekly summary line: "Forge weekly check: 4 skills, 0 flagged, 1 caution, 1 changed; scan rules A → B". */
export function weeklyLine(items: { next: WatchMemo; c: WatchChanges }[], rules: string, prevRules: string | undefined): string {
  const n = (f: (x: { next: WatchMemo; c: WatchChanges }) => boolean) => items.filter(f).length;
  const parts = [
    plural(items.length, "skill"),
    `${n((x) => x.next.verdict === "flagged")} flagged`,
    `${n((x) => x.next.verdict === "caution")} caution`,
    `${n((x) => x.c.changed)} changed`,
    `${n((x) => x.next.rescan)} need a fresh scan`,
  ];
  const rulesPart = prevRules && prevRules !== rules ? `; scan rules ${prevRules} → ${rules}` : `; scan rules ${rules}`;
  return `Forge weekly check: ${parts.join(", ")}${rulesPart}`;
}

export const WEEK_MS = 7 * 86_400_000;

/** True when the weekly pass is due (never run, or a week or more ago). */
export const weeklyDue = (m: MemoryFile, now: number) => !m.weekly_at || now - Date.parse(m.weekly_at) >= WEEK_MS || Number.isNaN(Date.parse(m.weekly_at));
