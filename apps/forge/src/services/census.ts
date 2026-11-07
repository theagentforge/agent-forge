import { sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { descriptionHistory } from "./house-tools";
import { copyKvNights, FAMILIES, type HouseFamily } from "./house-results";
import { DATASET_LICENCE, LICENCE_ID } from "./provenance";
import { BACKFILL_SINCE, DRIFT_HEADER, driftTick, EXCLUDED_REASONS, MAX_VERSIONS, TOOL_HISTORY_HEADER, toolHistoryPath, toolHistoryRows } from "./tool-history";

// ADR 0129 (build plan 5 Nov, P0 items 1 and 2; Boardy's census ticket): the census dataset at /dataset/census.
//
// - A daily metrics snapshot: one row per metric per UTC day, written once by the hourly cron's first run after 00:00
//   UTC for the day just ended. Idempotent (the same day twice writes nothing new) and never backfilled.
// - The census files, built once a day from stored data only and frozen as a published version with a sha256 per file.
//   Days before a metric's first measured date are absent, never zero-filled. Gross numbers only (no house-vs-outside
//   split). The nightly top-500 and the weekly every-server sweep are separate families with separate denominators.
// Wording: a description match is "matched a high-severity pattern", never a verdict about the server.

export const CENSUS_DIR = "/dataset/census";
export const CENSUS_STATEMENT = "The files are the record; site counters are a live reading.";
export const DAY_BOUNDARY = "UTC. A row belongs to the UTC day its check completed (for a House night: the time the last shard finished).";

// --- Failure classes, v1 (closed) ------------------------------------------------------------------------------------

export const TAXONOMY_VERSION = "failure-classes/v1";
export const FAILURE_CLASSES = {
  install_failed: "The package couldn't be installed (not found at that version, or the build or download failed).",
  no_handshake: "It installed but never answered the MCP initialize handshake within the time limit.",
  needs_config: "It asked for configuration (an API key, token or required setting) that a no-credentials test can't give.",
  not_on_registry: "The listed package or version wasn't on npm or PyPI.",
  no_command: "The PyPI package has no command of the name the registry gave.",
  test_error: "The test itself failed (our side), so nothing is known about the server.",
  other: "Any outcome not mapped above (none in v1; kept so the list stays closed).",
} as const;
export type FailureClass = keyof typeof FAILURE_CLASSES;
/** Each House outcome, mapped once. `null`: installed (started and answered the handshake). */
export const OUTCOME_CLASS: Record<string, FailureClass | null> = {
  worked: null,
  partial: null,
  failed: "install_failed",
  no_answer: "no_handshake",
  needs_config: "needs_config",
  not_on_npm: "not_on_registry",
  not_on_pypi: "not_on_registry",
  no_command: "no_command",
  error: "test_error",
};
export const failureClass = (outcome: string): FailureClass | null => (outcome in OUTCOME_CLASS ? OUTCOME_CLASS[outcome]! : "other");

// --- Metrics ---------------------------------------------------------------------------------------------------------

export type MetricKind = "daily" | "cumulative";
export interface MetricDef {
  metric: string;
  family: string;
  unit: string;
  kind: MetricKind;
  /** How the daily snapshot measures it. */
  method: string;
  /** For days before its first snapshot: how it is counted from stored, dated records, or null if it can't be. */
  derived: string | null;
}

const houseMetrics = (family: HouseFamily, noun: string, tested: string): MetricDef[] => {
  const from = `stored per-server results of the ${noun} (house_results, family ${family}) for that UTC night`;
  const d = (what: string) => `${what}, counted from the ${from}.`;
  return [
    { metric: `${family}.${tested}`, family, unit: "servers", kind: "daily", method: d("Servers tested"), derived: d("Servers tested") },
    { metric: `${family}.servers_installed`, family, unit: "servers", kind: "daily", method: d("Servers that installed, started and answered the MCP initialize handshake (outcome worked or partial)"), derived: d("Servers that installed, started and answered the MCP initialize handshake (outcome worked or partial)") },
    { metric: `${family}.servers_failed`, family, unit: "servers", kind: "daily", method: d(`Servers tested that did not install and answer (${tested} minus installed; includes test_error, our side)`), derived: d(`Servers tested that did not install and answer (${tested} minus installed; includes test_error, our side)`) },
    ...(Object.keys(FAILURE_CLASSES) as FailureClass[]).map((c) => ({ metric: `${family}.failed.${c}`, family, unit: "servers", kind: "daily" as const, method: d(`Servers that failed with class ${c} (${TAXONOMY_VERSION})`), derived: d(`Servers that failed with class ${c} (${TAXONOMY_VERSION})`) })),
  ];
};

export const METRICS: MetricDef[] = [
  ...houseMetrics(FAMILIES.top500, "nightly top-500 run (the most-downloaded no-setup servers in the official MCP Registry)", "servers_attempted"),
  ...houseMetrics(FAMILIES.sweep, "weekly sweep (a seventh of every no-setup npm and PyPI server each day)", "servers_tested"),
  {
    metric: "tool_descriptions.scanned",
    family: "tool_descriptions",
    unit: "tool descriptions",
    kind: "daily",
    method: "Non-empty tool descriptions in the description sets the House tester sent that UTC day (sets last seen that day), scanned with the skill scanner's rules. Read by the snapshot just after the day ends.",
    derived: null,
  },
  {
    metric: "tool_descriptions.high_risk_matches",
    family: "tool_descriptions",
    unit: "servers",
    kind: "daily",
    method: "Servers whose description set sent that UTC day matched at least one high-severity scanner pattern. A match is a pattern for a person to read, not a finding about the server.",
    derived: null,
  },
  {
    metric: "skill_files.scanned_total",
    family: "skill_files",
    unit: "files",
    kind: "cumulative",
    method: "Distinct skill files (sha256 fingerprints in skill_scans) first scanned before the end of that UTC day.",
    derived: "Distinct skill files (sha256 fingerprints in skill_scans) first scanned before the end of that UTC day, counted from each file's stored first_seen; listed only on days when at least one file was first scanned.",
  },
  {
    metric: "skill_files.new",
    family: "skill_files",
    unit: "files",
    kind: "daily",
    method: "Distinct skill files first scanned during that UTC day (skill_scans.first_seen).",
    derived: "Distinct skill files first scanned during that UTC day, from each file's stored first_seen; listed only on days when at least one file was first scanned.",
  },
  { metric: "tools_tracked.total", family: "tools_tracked", unit: "tools", kind: "cumulative", method: "Tools with a page (MCP servers, skills and packages, most of them registry listings), created before the end of that UTC day.", derived: null },
  { metric: "tools_tracked.new", family: "tools_tracked", unit: "tools", kind: "daily", method: "Tools whose page was created during that UTC day.", derived: null },
];
const BY_METRIC = new Map(METRICS.map((m) => [m.metric, m]));

export const FAMILY_NOTES: Record<string, string> = {
  [FAMILIES.top500]: "The nightly top-500 run. Its denominator is the servers attempted that night; never added to the weekly sweep's.",
  [FAMILIES.sweep]: "The weekly sweep of every no-setup server, a seventh a day. Its denominator is the servers tested that day; never added to the nightly run's.",
  tool_descriptions: "Tool descriptions (tools/list) the House tester sent from working servers in either run, as scanned.",
  skill_files: "Every distinct skill file the scanner has read (bulk scans and scans by people and agents).",
  tools_tracked: "Tools with a page on the site.",
};

const DAY = 86_400_000;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The last complete UTC day at `now`. */
export const lastCompleteDay = (now: number) => utcDay(now - DAY);

export interface MetricValue {
  metric: string;
  value: number;
}

/** House family metrics from per-outcome counts of one night. */
function houseValues(family: HouseFamily, counts: Record<string, number>): MetricValue[] {
  const tested = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!tested) return [];
  const byClass = Object.fromEntries(Object.keys(FAILURE_CLASSES).map((c) => [c, 0])) as Record<FailureClass, number>;
  let installed = 0;
  for (const [outcome, n] of Object.entries(counts)) {
    const c = failureClass(outcome);
    if (c) byClass[c] += n;
    else installed += n;
  }
  return [
    { metric: `${family}.${family === FAMILIES.top500 ? "servers_attempted" : "servers_tested"}`, value: tested },
    { metric: `${family}.servers_installed`, value: installed },
    { metric: `${family}.servers_failed`, value: tested - installed },
    ...(Object.keys(byClass) as FailureClass[]).map((c) => ({ metric: `${family}.failed.${c}`, value: byClass[c] })),
  ];
}

type Row = Record<string, number | string | null>;

/** Per-outcome counts per family and night, for nights up to `through`. */
async function houseCounts(env: Env, from: string, through: string) {
  const rows = (await getDb(env).all(
    sql`SELECT family, night, outcome, count(*) AS n FROM house_results WHERE night >= ${from} AND night <= ${through} GROUP BY family, night, outcome`,
  )) as { family: HouseFamily; night: string; outcome: string; n: number }[];
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = `${r.family}|${r.night}`;
    const c = out.get(key) ?? {};
    c[r.outcome] = Number(r.n);
    out.set(key, c);
  }
  return out;
}

/** Every metric measurable for one complete UTC day, from stored data. A family with nothing stored that day is absent. */
export async function measureDay(env: Env, day: string): Promise<MetricValue[]> {
  const db = getDb(env);
  const start = dayStart(day);
  const end = start + DAY;
  const one = async (q: ReturnType<typeof sql>) => ((await db.all(q)) as Row[])[0] ?? {};
  const out: MetricValue[] = [];
  for (const [key, counts] of await houseCounts(env, day, day)) out.push(...houseValues(key.split("|")[0] as HouseFamily, counts));
  const desc = await one(
    sql`SELECT count(*) AS sets, coalesce(sum(descriptions_count), 0) AS descs, coalesce(sum(CASE WHEN coalesce(json_extract(counts, '$.high'), 0) > 0 THEN 1 ELSE 0 END), 0) AS high FROM tool_description_history WHERE origin != 'backfill' AND last_seen >= ${start} AND last_seen < ${end}`,
  );
  if (Number(desc.sets) > 0) out.push({ metric: "tool_descriptions.scanned", value: Number(desc.descs) }, { metric: "tool_descriptions.high_risk_matches", value: Number(desc.high) });
  const skills = await one(sql`SELECT sum(CASE WHEN first_seen < ${end} THEN 1 ELSE 0 END) AS total, sum(CASE WHEN first_seen >= ${start} AND first_seen < ${end} THEN 1 ELSE 0 END) AS new FROM skill_scans`);
  out.push({ metric: "skill_files.scanned_total", value: Number(skills.total ?? 0) }, { metric: "skill_files.new", value: Number(skills.new ?? 0) });
  const tools = await one(sql`SELECT sum(CASE WHEN created_at < ${end} THEN 1 ELSE 0 END) AS total, sum(CASE WHEN created_at >= ${start} AND created_at < ${end} THEN 1 ELSE 0 END) AS new FROM tools`);
  out.push({ metric: "tools_tracked.total", value: Number(tools.total ?? 0) }, { metric: "tools_tracked.new", value: Number(tools.new ?? 0) });
  return out;
}

/**
 * Writes the snapshot for the UTC day that ended before `now`, and only that day: never an earlier one. Rows already
 * written for that day stay as they are (first write wins), so a second call writes nothing.
 */
export async function writeDailySnapshot(env: Env, now = Date.now()) {
  const day = lastCompleteDay(now);
  const values = await measureDay(env, day);
  const db = getDb(env);
  const rows = values.map((v) => {
    const def = BY_METRIC.get(v.metric)!;
    return { date: day, metric: v.metric, family: def.family, value: v.value, unit: def.unit, kind: def.kind, method: def.method, createdAt: now };
  });
  const before = await db.$count(t.metricSnapshots, sql`${t.metricSnapshots.date} = ${day}`);
  // D1 allows 100 bound parameters a statement; a row has 8 columns.
  const stmts = [];
  for (let i = 0; i < rows.length; i += 12) stmts.push(db.insert(t.metricSnapshots).values(rows.slice(i, i + 12)).onConflictDoNothing());
  if (stmts.length) await db.batch(stmts as [(typeof stmts)[number], ...typeof stmts]);
  const after = await db.$count(t.metricSnapshots, sql`${t.metricSnapshots.date} = ${day}`);
  return { date: day, measured: rows.length, written: after - before };
}

// --- The files -------------------------------------------------------------------------------------------------------

export interface SeriesRow {
  metric: string;
  date_utc: string;
  /** null: not measured that day (CENSUS_GAPS). Never 0 for a day nothing was recorded. */
  value: number | null;
  unit: string;
  method: string;
  kind: MetricKind;
}

/**
 * Days a census metric wasn't recorded. Lean mode (ADR 0027) was on from 1 Nov until the afternoon of 4 Nov 2026
 * (docs/STATUS.md, 4 Nov) and, besides the usage counters (not in this dataset; services/outside-metrics.ts
 * COUNTER_GAPS), it stopped storing skill scans (services/scans.ts scanAndRecord) and the bulk scans. So skill files
 * first scanned on those days were not recorded: each gap day is a "not measured" row (empty value), never a count,
 * and the cumulative total after the gap leaves out files scanned only during it.
 */
export const NOT_MEASURED = "not measured";
export const CENSUS_GAPS = [
  {
    from: "2026-11-01",
    to: "2026-11-04",
    metrics: ["skill_files.new", "skill_files.scanned_total"],
    note: "Lean mode stopped storing skill scans from 1 to 4 Nov 2026, so skill files first scanned on these days were not recorded; totals after 4 Nov leave out files scanned only then.",
  },
] as const;
const gapDays = (g: (typeof CENSUS_GAPS)[number]) => {
  const out: string[] = [];
  for (let d = dayStart(g.from); d <= dayStart(g.to); d += DAY) out.push(utcDay(d));
  return out;
};

/** The long-format series through `through`: snapshot rows, then stored dated records for days without a snapshot. */
export async function buildSeries(env: Env, through: string): Promise<SeriesRow[]> {
  const db = getDb(env);
  const snaps = await db.select().from(t.metricSnapshots).where(sql`${t.metricSnapshots.date} <= ${through}`);
  const rows = new Map<string, SeriesRow>();
  const put = (r: SeriesRow) => rows.has(`${r.metric}|${r.date_utc}`) || rows.set(`${r.metric}|${r.date_utc}`, r);
  for (const s of snaps) put({ metric: s.metric, date_utc: s.date, value: s.value, unit: s.unit, method: s.method, kind: s.kind as MetricKind });
  // House nights: every night stored per server, from its real first date.
  for (const [key, counts] of await houseCounts(env, "0000-00-00", through)) {
    const [family, night] = key.split("|") as [HouseFamily, string];
    for (const v of houseValues(family, counts)) {
      const def = BY_METRIC.get(v.metric)!;
      put({ metric: v.metric, date_utc: night, value: v.value, unit: def.unit, method: def.derived!, kind: def.kind });
    }
  }
  // Skill files: each file's stored first_seen, only on days when at least one was first scanned.
  const days = (await db.all(
    sql`SELECT strftime('%Y-%m-%d', first_seen / 1000, 'unixepoch') AS day, count(*) AS n FROM skill_scans WHERE first_seen < ${dayStart(through) + DAY} GROUP BY day ORDER BY day`,
  )) as { day: string; n: number }[];
  let total = 0;
  const total_ = BY_METRIC.get("skill_files.scanned_total")!;
  const new_ = BY_METRIC.get("skill_files.new")!;
  for (const d of days) {
    total += Number(d.n);
    put({ metric: new_.metric, date_utc: d.day, value: Number(d.n), unit: new_.unit, method: new_.derived!, kind: new_.kind });
    put({ metric: total_.metric, date_utc: d.day, value: total, unit: total_.unit, method: total_.derived!, kind: total_.kind });
  }
  // Gap days: one "not measured" row per affected metric and day, replacing whatever stored records show for it.
  for (const g of CENSUS_GAPS)
    for (const day of gapDays(g))
      if (day <= through)
        for (const metric of g.metrics) {
          const def = BY_METRIC.get(metric)!;
          rows.set(`${metric}|${day}`, { metric, date_utc: day, value: null, unit: def.unit, method: `${NOT_MEASURED}: ${g.note}`, kind: def.kind });
        }
  const order = new Map(METRICS.map((m, i) => [m.metric, i]));
  return [...rows.values()].sort((a, b) => (order.get(a.metric) ?? 999) - (order.get(b.metric) ?? 999) || a.metric.localeCompare(b.metric) || a.date_utc.localeCompare(b.date_utc));
}

/** The first date each metric has a value (null: not yet measured). */
export const firstDates = (series: SeriesRow[]) =>
  Object.fromEntries(METRICS.map((m) => [m.metric, series.filter((r) => r.metric === m.metric && r.value !== null).reduce<string | null>((a, r) => (a === null || r.date_utc < a ? r.date_utc : a), null)]));

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: unknown[][]) => [header.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n";

export const SERIES_HEADER = ["metric", "date_utc", "value", "unit", "method", "kind"];
export const SERVER_HISTORY_HEADER = ["family", "server", "version", "night_utc", "outcome", "failure_class", "tool_count", "description_sha256"];
export const ROSTER_HEADER = ["rank", "server", "version", "weekly_downloads", "outcome"];

/** The description set a server + version showed on a night: the latest set whose first..last sighting covers it. */
function descriptionAt(sets: { sha256: string; first: string; last: string }[] | undefined, night: string) {
  let hit: string | null = null;
  for (const s of sets ?? []) if (s.first <= night && night <= s.last) hit = s.sha256;
  return hit ?? "";
}

/** One month's server history (UTC month, YYYY-MM). */
export const historyPath = (month: string) => `server-history/${month}.csv`;
/**
 * A file that only changes if its stored rows do (review of ADR 0129): each night's roster, and the server history of
 * every month before the version's month. Such a file is reused from the previous version when what it is built from
 * is unchanged, and its stored copy never expires; the current month, the series and the schema are rebuilt every day.
 */
export const frozenPath = (path: string, version: string) => path.startsWith("roster/") || (/^server-history\/\d{4}-\d{2}\.csv$/.test(path) && path.slice(15, 22) < version.slice(0, 7));
/** Workers KV holds at most 25 MiB a value; a file is refused well before that. */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;

const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return Date.UTC(y, m, 1);
};

/**
 * What each roster and month file is built from, as a fingerprint: per family and night, the row count and the sum of
 * probe times (a same-night re-run changes it); for a month, also the description sets whose sightings reach into it,
 * clipped to the month. Aggregates only: one row per family and night, one query per month.
 */
async function partPrints(env: Env, version: string) {
  const db = getDb(env);
  const nights = (await db.all(
    sql`SELECT family, night, count(*) AS n, coalesce(sum(probed_at), 0) AS p FROM house_results WHERE night <= ${version} GROUP BY family, night ORDER BY family, night`,
  )) as { family: HouseFamily; night: string; n: number; p: number }[];
  const prints = new Map<string, string>();
  const months = new Map<string, { family: HouseFamily; night: string }[]>();
  const parts = new Map<string, string[]>();
  for (const r of nights) {
    if (r.family === FAMILIES.top500) prints.set(`roster/${r.night}.csv`, `${r.n}:${r.p}`);
    const m = r.night.slice(0, 7);
    months.set(m, [...(months.get(m) ?? []), { family: r.family, night: r.night }]);
    parts.set(m, [...(parts.get(m) ?? []), `${r.family}/${r.night}/${r.n}/${r.p}`]);
  }
  for (const m of months.keys()) {
    const start = dayStart(`${m}-01`);
    const end = monthEnd(m);
    const [d] = (await db.all(
      sql`SELECT count(*) AS n, coalesce(sum(min(last_seen, ${end})), 0) AS l, coalesce(sum(max(first_seen, ${start})), 0) AS f FROM tool_description_history WHERE origin != 'backfill' AND first_seen < ${end} AND last_seen >= ${start}`,
    )) as { n: number; l: number; f: number }[];
    prints.set(historyPath(m), await sha256Hex(`${parts.get(m)!.join(",")}|${d?.n ?? 0}:${d?.l ?? 0}:${d?.f ?? 0}`));
  }
  return { months, prints };
}

/**
 * The files of one version, from stored data through `version` (a UTC date). `keep(path, fp)` says a file is unchanged
 * since the previous version and frozen, so it isn't rebuilt (its rows aren't even read): the build reads one month of
 * House rows a day, not the whole record, however long the record grows.
 */
export async function buildCensusFiles(env: Env, version: string, keep: (path: string, fp: string) => boolean = () => false) {
  const db = getDb(env);
  const series = await buildSeries(env, version);
  const files: Record<string, string> = {};
  const kept = new Set<string>();
  files["series.csv"] = csv(SERIES_HEADER, series.map((r) => [r.metric, r.date_utc, r.value, r.unit, r.method, r.kind]));
  files["series.json"] = JSON.stringify({ version, rows: series }, null, 1) + "\n";

  const { months, prints } = await partPrints(env, version);
  let sets: Map<string, { sha256: string; first: string; last: string }[]> | null = null;
  for (const [month, nights] of months) {
    const path = historyPath(month);
    const rosters = nights.filter((n) => n.family === FAMILIES.top500).map((n) => `roster/${n.night}.csv`);
    if (keep(path, prints.get(path)!) && rosters.every((r) => keep(r, prints.get(r)!))) {
      kept.add(path);
      for (const r of rosters) kept.add(r);
      continue;
    }
    if (!sets) {
      sets = new Map();
      for (const h of await descriptionHistory(env)) {
        const key = `${h.server}@${h.version}`;
        sets.set(key, [...(sets.get(key) ?? []), { sha256: h.sha256, first: utcDay(h.firstSeen), last: utcDay(h.lastSeen) }]);
      }
    }
    const history: unknown[][] = [];
    for (const n of nights) {
      const rows = await db
        .select()
        .from(t.houseResults)
        .where(sql`${t.houseResults.family} = ${n.family} AND ${t.houseResults.night} = ${n.night}`)
        .orderBy(t.houseResults.server);
      for (const r of rows)
        history.push([r.family, r.server, r.version, r.night, r.outcome, failureClass(r.outcome) ?? "", r.tools, r.outcome === "worked" && r.version ? descriptionAt(sets.get(`${r.server}@${r.version}`), r.night) : ""]);
      if (n.family === FAMILIES.top500) {
        const roster = `roster/${n.night}.csv`;
        if (keep(roster, prints.get(roster)!)) kept.add(roster);
        else
          files[roster] = csv(
            ROSTER_HEADER,
            [...rows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.server.localeCompare(b.server)).map((r) => [r.rank, r.server, r.version, r.downloads, r.outcome]),
          );
      }
    }
    files[path] = csv(SERVER_HISTORY_HEADER, history);
  }
  // ADR 0134: the tool-definition history (forward and backfilled, origin on every row) and its drift. Hashes and
  // change classes only; the tool text itself is buyer-only (an admin download). Rebuilt each day (small files).
  const th = await toolHistoryRows(env);
  for (const [month, rows] of [...th.months].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (month <= version.slice(0, 7)) files[toolHistoryPath(month)] = csv(TOOL_HISTORY_HEADER, rows);
  files["drift.csv"] = csv(DRIFT_HEADER, th.drift);
  files["schema.json"] = JSON.stringify(censusSchema(version, firstDates(series)), null, 1) + "\n";
  return { files, kept, prints };
}

export function censusSchema(version: string, first: Record<string, string | null>) {
  return {
    name: "The Forge census",
    version,
    statement: CENSUS_STATEMENT,
    day_boundary: DAY_BOUNDARY,
    generated_from: "Stored data only. Days before a metric's first measured date are absent, never zero-filled. Gross numbers only.",
    licence: DATASET_LICENCE,
    licence_id: LICENCE_ID,
    gaps: CENSUS_GAPS.map((g) => ({ from: g.from, to: g.to, metrics: [...g.metrics], status: NOT_MEASURED, note: g.note })),
    files: {
      "series.csv": { format: "CSV, long format, one row per metric per UTC day", fields: { metric: "Metric id (see metrics)", date_utc: "YYYY-MM-DD, UTC", value: `Number; empty (null in series.json) when ${NOT_MEASURED} that day (see gaps), never 0`, unit: "What the number counts", method: `How this row was measured, or "${NOT_MEASURED}: <why>"`, kind: "daily (that day only) or cumulative (everything up to the end of that day)" } },
      "series.json": { format: "JSON: { version, rows: [same fields as series.csv] }" },
      "server-history/<YYYY-MM>.csv": {
        format: "CSV, one row per server per night per family, one file per UTC month (a complete month's file changes only if its stored rows do)",
        fields: {
          family: "top500_nightly or weekly_sweep (separate denominators)",
          server: "npm:<package> or pypi:<package>",
          version: "The version tested (empty if it couldn't be resolved)",
          night_utc: "YYYY-MM-DD, the UTC day the run completed",
          outcome: "The House tester's raw outcome (worked, partial, failed, no_answer, needs_config, not_on_npm, not_on_pypi, no_command, error)",
          failure_class: `The outcome's class in ${TAXONOMY_VERSION}; empty when it installed`,
          tool_count: "Tools listed (empty when it listed none)",
          description_sha256: "sha256 (hex) of the tool-description set seen for that server and version on that night; empty when it didn't list tools or before descriptions were captured",
        },
      },
      "tool-history/<YYYY-MM>.csv": {
        format: "CSV, one row per tool-definition set seen per server version (tools/list), one file per UTC month of the version's publish date (or of when we saw it, when the publish date isn't known). Hashes only: the tool text is not in the public files.",
        fields: {
          server: "The tool's id on the site (npm:<package>, pypi:<package> or the repository it resolves to)",
          package: "npm:<package> or pypi:<package> for servers in the backfill set; empty otherwise",
          version: "The published version",
          published_at: "When the registry says the version was published (npm time, PyPI earliest upload); empty when not known",
          observed_at: "When the House tester actually ran that version and read its tools/list",
          origin: `nightly (seen by the nightly or weekly House run), carried (the one current row each server had on 5 Nov 2026, copied in), or backfill (an older version installed later, from ${BACKFILL_SINCE}). A backfill row's published_at is the registry's date, never a date we saw it`,
          tools_count: "Tools listed",
          description_sha256: "sha256 (hex) of the set's names, descriptions and input schemas as scanned",
          change_class: "Against the server's previous observed set: first, none, or tool_added; tool_removed; description_changed; schema_changed (joined by ;). not_yet_computed until the daily drift step has read it",
          failure_class: `For a backfill version that didn't start: its class in ${TAXONOMY_VERSION} (the other fields are empty)`,
        },
        coverage: `Backfill: stable versions published since ${BACKFILL_SINCE} of the latest nightly top-500 servers (npm) and up to 100 PyPI servers the weekly sweep has seen start, at most the newest ${MAX_VERSIONS} per server. Not tested: ${Object.entries(EXCLUDED_REASONS).map(([k, v]) => `${k} (${v})`).join("; ")}`,
      },
      "drift.csv": {
        format: "CSV, one row per consecutive pair of observed tool-definition sets of a server whose definitions changed",
        fields: {
          server: "As in tool-history",
          package: "As in tool-history",
          from_version: "The earlier version",
          to_version: "The later version (equal to from_version when the definitions changed without a version change)",
          from_published_at: "Publish date of from_version, where known",
          to_published_at: "Publish date of to_version, where known",
          change_class: "tool_added; tool_removed; description_changed; schema_changed (joined by ;)",
          tools_added: "Tools in the later set only",
          tools_removed: "Tools in the earlier set only",
          descriptions_changed: "Tools in both whose description text differs",
          schemas_changed: "Tools in both whose input schema differs",
          major_bump: "true when the two versions' major numbers differ (semver; for PyPI the first release number), in either direction: pairs follow publish order, so a backport to an older major published after a newer one counts as a major change",
          zero_major: "true when both versions are 0.x, where semver allows any change in a minor release",
          same_version: "true when the definitions changed with no version change",
          untested_between: "Versions published between the two that didn't start, so their definitions are unknown",
          new_text_rules: "Skill-scanner rule ids (joined by ;) matched by the new text of added or changed tools and not by those tools' earlier text. A rule id names a pattern for a person to read, not a finding about the server",
        },
      },
      "roster/<date>.csv": { format: "CSV, the night's top-500 roster", fields: { rank: "Rank by last week's downloads", server: "npm:<package> or pypi:<package>", version: "Version tested", weekly_downloads: "Downloads in the week before, as the registry reported them", outcome: "The night's raw outcome" } },
      "manifest.json": { format: "JSON: the sha256 and size of every file in this version, and every published version with the address of its own manifest" },
      "manifest/<version>.json": { format: "JSON: the sha256 and size of every file in that published version" },
    },
    families: FAMILY_NOTES,
    metrics: METRICS.map((m) => ({ ...m, first_measured: first[m.metric] ?? null, ...(first[m.metric] ? {} : { status: "not yet measured" }) })),
    failure_classes: { version: TAXONOMY_VERSION, closed: true, classes: FAILURE_CLASSES, outcome_map: OUTCOME_CLASS, installed_outcomes: ["worked", "partial"] },
  };
}

export async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Publishing ------------------------------------------------------------------------------------------------------

const LATEST_KEY = "census:latest";
/** A version's file list, served for 8 days (D1 keeps it for good). */
const indexKey = (version: string) => `census:index:${version}`;
/** One file's bytes, by sha256: a frozen file is stored once, without expiry; the rest expire after 8 days. */
const blobKey = (sha256: string) => `census:blob:${sha256}`;
const KEEP_SECONDS = 8 * 86_400;
export interface CensusFile {
  path: string;
  sha256: string;
  bytes: number;
  /** What a roster or month file was built from (internal; never served). */
  fp?: string;
}
export interface CensusIndex {
  version: string;
  published_at: string;
  hashes: CensusFile[];
}
const publicHashes = (fs: CensusFile[]) => fs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));

/**
 * Publishes the version for the last complete UTC day, once. Each file is stored by its sha256 (frozen files once, for
 * good; see `frozenPath`), the version's file list in D1 for good and in KV for serving. A version already published
 * is left alone (its KV list is put back if it went missing). Nothing is stored if any file is too large for KV.
 */
export async function publishCensus(env: Env, now = Date.now()) {
  const version = lastCompleteDay(now);
  const db = getDb(env);
  const [had] = await db.select().from(t.censusVersions).where(sql`${t.censusVersions.version} = ${version}`);
  if (had) {
    if (!(await env.KV.get(indexKey(version)))) await putIndex(env, { version, published_at: new Date(had.publishedAt).toISOString(), hashes: had.files });
    return { version, published: false };
  }
  const [prev] = await db.select().from(t.censusVersions).where(sql`${t.censusVersions.version} < ${version}`).orderBy(sql`${t.censusVersions.version} DESC`).limit(1);
  const before = new Map((prev?.files ?? []).map((f) => [f.path, f]));
  const unchanged = (path: string, fp: string) => !!prev && before.get(path)?.fp === fp && frozenPath(path, prev.version) && frozenPath(path, version);
  const { files, kept, prints } = await buildCensusFiles(env, version, unchanged);
  const enc = new TextEncoder();
  const built = await Promise.all(
    Object.keys(files).map(async (path): Promise<CensusFile> => {
      const bytes = enc.encode(files[path]!).length;
      if (bytes > MAX_FILE_BYTES) throw new Error(`census file ${path} is ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte limit`);
      return { path, sha256: await sha256Hex(files[path]!), bytes, ...(prints.has(path) ? { fp: prints.get(path)! } : {}) };
    }),
  );
  const hashes = [...built, ...[...kept].map((p) => before.get(p)!)].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // A frozen file's bytes are stored without expiry (unless the same bytes are already stored that way); the rest for 8 days.
  const frozenShas = new Set(hashes.filter((h) => frozenPath(h.path, version)).map((h) => h.sha256));
  for (const h of built) {
    const was = before.get(h.path);
    if (prev && was?.sha256 === h.sha256 && frozenPath(h.path, prev.version) && frozenPath(h.path, version)) continue;
    await env.KV.put(blobKey(h.sha256), files[h.path]!, frozenShas.has(h.sha256) ? undefined : { expirationTtl: KEEP_SECONDS });
  }
  const publishedAt = now;
  const inserted = await db.insert(t.censusVersions).values({ version, publishedAt, files: hashes }).onConflictDoNothing().returning({ v: t.censusVersions.version });
  // Two runs at once: the first insert wins and its list is the one served.
  if (!inserted.length) return { version, published: false };
  await putIndex(env, { version, published_at: new Date(publishedAt).toISOString(), hashes });
  return { version, published: true, files: hashes.length, rebuilt: built.length, reused: kept.size };
}

async function putIndex(env: Env, index: CensusIndex) {
  await env.KV.put(indexKey(index.version), JSON.stringify(index), { expirationTtl: KEEP_SECONDS });
  await env.KV.put(LATEST_KEY, index.version);
}

/** The latest published version's file list, or null before the first one. */
export async function latestBundle(env: Env): Promise<CensusIndex | null> {
  const version = await env.KV.get(LATEST_KEY);
  return version ? env.KV.get<CensusIndex>(indexKey(version), "json") : null;
}

/** One file's bytes from a version's list, or null if it isn't in the list or its bytes are no longer stored. */
export async function censusFile(env: Env, index: CensusIndex, path: string) {
  const h = index.hashes.find((x) => x.path === path);
  if (!h) return null;
  const body = await env.KV.get(blobKey(h.sha256));
  return body === null ? null : { body, sha256: h.sha256 };
}

/** manifest.json: this version's files, and every published version (newest first) with the address of its manifest. */
export async function manifest(env: Env, index: CensusIndex) {
  // Only the two small columns: every version's file list in one read would grow with the square of the record.
  const versions = await getDb(env).select({ version: t.censusVersions.version, publishedAt: t.censusVersions.publishedAt }).from(t.censusVersions).orderBy(sql`${t.censusVersions.version} DESC`);
  return {
    version: index.version,
    published_at: index.published_at,
    statement: CENSUS_STATEMENT,
    hash: "sha256 of each file's bytes (UTF-8), hex",
    files: publicHashes(index.hashes),
    versions: versions.map((v) => ({ version: v.version, published_at: new Date(v.publishedAt).toISOString(), manifest: `${env.PUBLIC_ORIGIN}${CENSUS_DIR}/manifest/${v.version}.json` })),
  };
}

/** manifest/<version>.json: one published version's files, from D1 (kept for good), or null if there is no such version. */
export async function versionManifest(env: Env, version: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) return null;
  const [v] = await getDb(env).select().from(t.censusVersions).where(sql`${t.censusVersions.version} = ${version}`);
  return v ? { version: v.version, published_at: new Date(v.publishedAt).toISOString(), hash: "sha256 of each file's bytes (UTF-8), hex", files: publicHashes(v.files) } : null;
}

/**
 * The hourly cron's census step: copy House nights still only in KV, write yesterday's snapshot in the first run after
 * 00:00 UTC, then publish yesterday's version if it isn't yet. Each step logs and goes on if another fails.
 */
export async function censusTick(env: Env, now = Date.now()) {
  const out: Record<string, unknown> = {};
  try {
    out.copy = await copyKvNights(env, now);
  } catch (e) {
    out.copy = { error: String(e).slice(0, 120) };
  }
  if (new Date(now).getUTCHours() === 0)
    try {
      out.snapshot = await writeDailySnapshot(env, now);
    } catch (e) {
      out.snapshot = { error: String(e).slice(0, 120) };
    }
  // ADR 0134: drift for tools whose definition history changed, before the day's files are built.
  try {
    out.drift = await driftTick(env, now);
  } catch (e) {
    out.drift = { error: String(e).slice(0, 120) };
  }
  try {
    out.publish = await publishCensus(env, now);
  } catch (e) {
    out.publish = { error: String(e).slice(0, 120) };
  }
  return out;
}
