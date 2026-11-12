import { sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { diffTools, majorOf, ORIGINS } from "./tool-history";

// ADR 0146 (moat audit 5 Nov, gate 1): the drift report. A deterministic reading of the recorded tool-definition history
// (tool_description_history) and its consecutive-pair comparison (tool_definition_drift, ADR 0134 §6): for each server in
// the backfill set, every pair of consecutive observed definition sets whose tool names, descriptions or input schemas
// changed, with the tools named, and a flag when the change came without a semver-major bump.
//
// Two outputs, never mixed:
// - Public (behind DRIFT_PUBLIC, web/dataset-drift.ts): totals over the whole set, plus a fixed-size seeded sample of
//   pairs. "Only gross large figures public" (decision log, 29 Oct): nothing per server beyond the sample.
// - Internal (founder only, linked from the data room): every changed pair with the full before and after text.
//
// Wording: a pair is "changed tool text". Nothing here judges a server, and the public sample leaves out every pair whose
// recorded text, on either side, matched a scanner rule (those stay internal for a person to read).

export const DRIFT_REPORT_VERSION = "drift-report/1";
export const SAMPLE_SEED = "forge-drift-sample-1";
export const SAMPLE_SIZE = 20;
/** Per pair in the public sample: at most this many changed tools shown with their text, each text capped. */
export const SAMPLE_TOOLS = 3;
export const SAMPLE_TEXT = 600;
const NAMES_CAP = 25;

interface Tool {
  name: string;
  description: string;
  schema: string | null;
}

/** Why a changed pair is or isn't flagged. Pure. */
export function semverClass(from: string, to: string) {
  const a = majorOf(from);
  const b = majorOf(to);
  if (from === to) return "same_version" as const;
  if (a === null || b === null) return "unparsed" as const;
  if (a !== b) return "major_bump" as const;
  return a === 0 ? ("zero_major" as const) : ("same_major" as const);
}

/** Flagged: the tool text changed between two different versions with the same major number (0.x included, marked). */
export const flagged = (changed: boolean, cls: ReturnType<typeof semverClass>) => changed && (cls === "same_major" || cls === "zero_major");

const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const sortNames = (xs: Tool[]) => xs.map((x) => x.name).sort();

/**
 * One changed pair, in full: names of the tools added and removed, and for each tool whose description or input schema
 * changed, its text before and after. Pure, deterministic (tools sorted by name). `textCap`/`toolCap` trim it for the
 * public sample; the internal file passes none.
 */
export async function pairDetail(before: Tool[], after: Tool[], opts: { textCap?: number; toolCap?: number; namesCap?: number } = {}) {
  const d = diffTools(before, after);
  const old = new Map(before.map((x) => [x.name, x]));
  const changedNames = [...new Set([...d.described, ...d.schemas].map((x) => x.name))].sort();
  const shown = opts.toolCap === undefined ? changedNames : changedNames.slice(0, opts.toolCap);
  const text = (s: string) => (opts.textCap === undefined ? s : cap(s, opts.textCap));
  const changed = [];
  for (const name of shown) {
    const a = old.get(name)!;
    const b = after.find((x) => x.name === name)!;
    const descChanged = a.description !== b.description;
    const schemaChanged = (a.schema ?? null) !== (b.schema ?? null);
    changed.push({
      tool: name,
      description_changed: descChanged,
      schema_changed: schemaChanged,
      ...(descChanged ? { description_before: text(a.description), description_after: text(b.description) } : {}),
      ...(schemaChanged
        ? opts.textCap === undefined
          ? { schema_before: a.schema ?? null, schema_after: b.schema ?? null }
          : { schema_before_sha256: a.schema === null ? null : await sha256(a.schema), schema_after_sha256: b.schema === null ? null : await sha256(b.schema) }
        : {}),
    });
  }
  const names = (xs: string[]) => (opts.namesCap === undefined ? xs : xs.slice(0, opts.namesCap));
  return {
    change_class: d.changeClass,
    tools_before: before.length,
    tools_after: after.length,
    tools_added: names(sortNames(d.added)),
    tools_removed: names(sortNames(d.removed)),
    tools_changed: changed,
    tools_changed_count: changedNames.length,
  };
}

// --- Reading the stored history ----------------------------------------------------------------------------------------

type DriftRow = typeof t.toolDefinitionDrift.$inferSelect;
const inSet = sql`tool_id IN (SELECT tool_id FROM tool_history_servers WHERE tool_id IS NOT NULL)`;
// Parseable on both sides (majorOf: a leading digit, after an optional PEP 440 epoch, which also starts with a digit).
const parseable = sql`from_version GLOB '[0-9]*' AND to_version GLOB '[0-9]*'`;

/** The set's totals: what the public page may show (gross figures only). */
export async function driftTotals(env: Env) {
  const db = getDb(env);
  const s = ((await db.all(
    sql`SELECT count(*) AS servers, sum(source = 'top500_nightly') AS npm, sum(source = 'weekly_sweep_pypi') AS pypi FROM tool_history_servers`,
  )) as Record<string, number | null>[])[0]!;
  const d = ((await db.all(
    sql`SELECT count(DISTINCT tool_id) AS servers_compared, count(*) AS pairs, coalesce(sum(change_class != 'none'), 0) AS changed,
          count(DISTINCT CASE WHEN change_class != 'none' THEN tool_id END) AS servers_changed,
          coalesce(sum(change_class != 'none' AND NOT same_version AND NOT major_bump AND ${parseable}), 0) AS flagged,
          count(DISTINCT CASE WHEN change_class != 'none' AND NOT same_version AND NOT major_bump AND ${parseable} THEN tool_id END) AS servers_flagged,
          coalesce(sum(change_class != 'none' AND NOT same_version AND NOT major_bump AND ${parseable} AND zero_major), 0) AS flagged_zero_major,
          coalesce(sum(change_class != 'none' AND major_bump), 0) AS with_major_bump,
          coalesce(sum(change_class != 'none' AND same_version), 0) AS same_version,
          coalesce(sum(change_class LIKE '%tool_added%'), 0) AS c_added, coalesce(sum(change_class LIKE '%tool_removed%'), 0) AS c_removed,
          coalesce(sum(change_class LIKE '%description_changed%'), 0) AS c_desc, coalesce(sum(change_class LIKE '%schema_changed%'), 0) AS c_schema,
          max(computed_at) AS computed_at
        FROM tool_definition_drift WHERE ${inSet}`,
  )) as Record<string, number | null>[])[0]!;
  const n = (x: number | null | undefined) => Number(x ?? 0);
  return {
    servers_in_set: n(s.servers),
    servers_in_set_npm: n(s.npm),
    servers_in_set_pypi: n(s.pypi),
    servers_compared: n(d.servers_compared),
    pairs_compared: n(d.pairs),
    pairs_changed: n(d.changed),
    servers_changed: n(d.servers_changed),
    pairs_changed_without_major_bump: n(d.flagged),
    of_which_zero_major: n(d.flagged_zero_major),
    servers_changed_without_major_bump: n(d.servers_flagged),
    pairs_changed_with_major_bump: n(d.with_major_bump),
    pairs_changed_same_version: n(d.same_version),
    by_change: { tool_added: n(d.c_added), tool_removed: n(d.c_removed), description_changed: n(d.c_desc), schema_changed: n(d.c_schema) },
    computed_through: iso(d.computed_at),
  };
}

/** The stored set (tools) of one server version + hash; a backfill row first (the same method for every version). */
async function setsFor(env: Env, toolId: string) {
  const rows = await getDb(env)
    .select({ version: t.toolDescriptionHistory.version, sha: t.toolDescriptionHistory.descriptionSha256, origin: t.toolDescriptionHistory.origin, tools: t.toolDescriptionHistory.toolList, findings: t.toolDescriptionHistory.findings, observedAt: t.toolDescriptionHistory.observedAt, firstSeen: t.toolDescriptionHistory.firstSeen })
    .from(t.toolDescriptionHistory)
    .where(sql`${t.toolDescriptionHistory.toolId} = ${toolId}`);
  const by = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.version}|${r.sha}`;
    const had = by.get(k);
    if (!had || (r.origin === ORIGINS.backfill && had.origin !== ORIGINS.backfill)) by.set(k, r);
  }
  return by;
}

/** Each set tool's package id (npm:… or pypi:…); the best-ranked one when two share a tool page. */
async function packages(env: Env) {
  const rows = (await getDb(env).all(sql`SELECT tool_id, server FROM tool_history_servers WHERE tool_id IS NOT NULL ORDER BY rank DESC, server DESC`)) as { tool_id: string; server: string }[];
  return new Map(rows.map((r) => [r.tool_id, r.server]));
}

/** A stored set's scan matched at least one rule (any tool of the set, before or after). */
const matched = (findings: unknown) => Array.isArray(findings) && findings.length > 0;

const pairHead = (d: DriftRow, pkg: string) => {
  const cls = semverClass(d.fromVersion, d.toVersion);
  return {
    server: pkg,
    from_version: d.fromVersion,
    to_version: d.toVersion,
    from_published_at: iso(d.fromPublishedAt),
    to_published_at: iso(d.toPublishedAt),
    from_sha256: d.fromSha256,
    to_sha256: d.toSha256,
    semver: cls,
    changed_without_major_bump: flagged(d.changeClass !== "none", cls),
    untested_between: d.untestedBetween,
  };
};

/**
 * The public sample: one changed-without-major-bump pair per server, at most SAMPLE_SIZE servers, picked by
 * sha256(seed | server) so the pick is fixed for the same data. Each server's candidate is its latest such pair (≥1.x
 * before 0.x). A pair is left out (internal only) when the set on either side matched any scanner rule: the old text
 * is shown too, so a match before the change counts as much as one after (review of 5d5f8c4). Text capped.
 */
export async function driftSample(env: Env, origin: string, size = SAMPLE_SIZE) {
  const db = getDb(env);
  const totals = await driftTotals(env);
  const cands = (await db.all(
    sql`SELECT d.tool_id AS tool_id, max(d.seq) AS seq FROM tool_definition_drift d
        WHERE d.tool_id IN (SELECT tool_id FROM tool_history_servers WHERE tool_id IS NOT NULL)
          AND d.change_class != 'none' AND NOT d.same_version AND NOT d.major_bump AND d.from_version GLOB '[0-9]*' AND d.to_version GLOB '[0-9]*'
          AND json_array_length(d.new_text_rules) = 0
        GROUP BY d.tool_id, d.zero_major`,
  )) as { tool_id: string; seq: number }[];
  const rows: DriftRow[] = [];
  for (let i = 0; i < cands.length; i += 40) {
    const part = cands.slice(i, i + 40);
    const where = sql.join(
      part.map((c) => sql`(${t.toolDefinitionDrift.toolId} = ${c.tool_id} AND ${t.toolDefinitionDrift.seq} = ${Number(c.seq)})`),
      sql` OR `,
    );
    rows.push(...(await db.select().from(t.toolDefinitionDrift).where(where)));
  }
  const pkgs = await packages(env);
  // One per server: the ≥1.x candidate when there is one, else the 0.x one.
  const per = new Map<string, DriftRow>();
  for (const r of rows) {
    const had = per.get(r.toolId);
    if (!had || (had.zeroMajor && !r.zeroMajor)) per.set(r.toolId, r);
  }
  const keyed = await Promise.all([...per.values()].map(async (r) => ({ r, k: await sha256(`${SAMPLE_SEED}|${pkgs.get(r.toolId) ?? r.server}`) })));
  const picked = keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const pairs = [];
  for (const { r } of picked) {
    if (pairs.length >= size) break;
    const sets = await setsFor(env, r.toolId);
    const a = sets.get(`${r.fromVersion}|${r.fromSha256}`);
    const b = sets.get(`${r.toVersion}|${r.toSha256}`);
    if (!a || !b || matched(a.findings) || matched(b.findings)) continue;
    const detail = await pairDetail((a.tools as Tool[]) ?? [], (b.tools as Tool[]) ?? [], { textCap: SAMPLE_TEXT, toolCap: SAMPLE_TOOLS, namesCap: NAMES_CAP });
    pairs.push({ ...pairHead(r, pkgs.get(r.toolId) ?? r.server), observed_at: iso(b.observedAt ?? b.firstSeen), ...detail });
  }
  pairs.sort((x, y) => (x.server < y.server ? -1 : x.server > y.server ? 1 : 0));
  return {
    data_kind: "tool_definition_drift_sample",
    report_version: DRIFT_REPORT_VERSION,
    seed: SAMPLE_SEED,
    page: `${origin}${DRIFT_DIR}`,
    method: METHOD,
    totals,
    sample: { size: pairs.length, of_servers_changed_without_major_bump: totals.servers_changed_without_major_bump, rule: SAMPLE_RULE },
    pairs,
    not_in_this_file:
      "Every other server and pair, and the full before and after text (schemas as text, every changed tool), are in the full report, which is not public.",
  };
}

export const DRIFT_DIR = "/dataset/drift";

export const METHOD = [
  "Server set: the latest nightly top 500 MCP servers on npm (by downloads) plus the first 100 PyPI servers the weekly sweep has seen start, frozen on first use (ADR 0134).",
  "History: every stable version published since 2025-09-01 is installed in the House tester's sandbox and its tools/list recorded (origin backfill: published_at from the registry, observed_at when we ran it); the nightly House run adds new versions going forward.",
  "Pairs: for each server, consecutive recorded definition sets ordered by publish date. A pair changed when a tool was added or removed, or a tool's description text or input schema differs.",
  "Flag: changed_without_major_bump when the two versions differ but their major numbers are the same; semver 'zero_major' (0.x, where semver allows any change) is marked separately. A 1.x backport published after 2.0.0 counts as a major change.",
  "Definitions were observed when we installed each version, not on its publish day; a server that builds its tool list from the network or the date can differ. Versions between a pair that failed to start are counted in untested_between.",
  "This describes changed tool text only. It is not a judgement of any server.",
];
export const SAMPLE_RULE = `One changed-without-major-bump pair per server, at most ${SAMPLE_SIZE} servers, ordered by sha256(seed|server); each server's latest such pair, a 1.x-or-later pair before a 0.x one. Pairs where the recorded set on either side matched a scanner rule are not in the public sample. At most ${SAMPLE_TOOLS} changed tools per pair shown, text cut at ${SAMPLE_TEXT} characters, schemas as sha256.`;

// --- The full report (founder only; for the data room) ----------------------------------------------------------------

export const FULL_TOOLS_PER_PAGE = 20;
export const FULL_BYTES = 24 * 1024 * 1024;

/**
 * One page of the full report as JSON lines: every changed pair of up to FULL_TOOLS_PER_PAGE servers of the set (tool id
 * order, after `after`), with the full before and after text and the scanner rule ids the new text matched. A page stops
 * at a server boundary under the byte cap; `next` names where to continue.
 */
export async function driftFullPage(env: Env, after: string, maxBytes = FULL_BYTES, perPage = FULL_TOOLS_PER_PAGE) {
  const db = getDb(env);
  const tools = (await db.all(
    sql`SELECT DISTINCT d.tool_id AS tool_id FROM tool_definition_drift d WHERE d.tool_id > ${after} AND d.change_class != 'none'
          AND d.tool_id IN (SELECT tool_id FROM tool_history_servers WHERE tool_id IS NOT NULL) ORDER BY d.tool_id LIMIT ${perPage}`,
  )) as { tool_id: string }[];
  const pkgs = await packages(env);
  const lines: string[] = [];
  let bytes = 0;
  let last: string | null = null;
  let stoppedEarly = false;
  for (const { tool_id: toolId } of tools) {
    const drift = await db.select().from(t.toolDefinitionDrift).where(sql`${t.toolDefinitionDrift.toolId} = ${toolId} AND ${t.toolDefinitionDrift.changeClass} != 'none'`).orderBy(t.toolDefinitionDrift.seq);
    const sets = await setsFor(env, toolId);
    const out: string[] = [];
    for (const r of drift) {
      const a = sets.get(`${r.fromVersion}|${r.fromSha256}`);
      const b = sets.get(`${r.toVersion}|${r.toSha256}`);
      const detail = a && b ? await pairDetail((a.tools as Tool[]) ?? [], (b.tools as Tool[]) ?? []) : null;
      out.push(
        JSON.stringify({
          report_version: DRIFT_REPORT_VERSION,
          ...pairHead(r, pkgs.get(toolId) ?? r.server),
          seq: r.seq,
          from_observed_at: a ? iso(a.observedAt ?? a.firstSeen) : null,
          to_observed_at: b ? iso(b.observedAt ?? b.firstSeen) : null,
          new_text_rules: r.newTextRules ?? [],
          ...(detail ?? { change_class: r.changeClass, detail: "definition rows not found" }),
        }),
      );
    }
    const size = out.reduce((n, l) => n + new TextEncoder().encode(l).length + 1, 0);
    if (bytes + size > maxBytes && lines.length) {
      stoppedEarly = true;
      break;
    }
    lines.push(...out);
    bytes += size;
    last = toolId;
  }
  const more = stoppedEarly || tools.length === perPage;
  return { body: lines.length ? `${lines.join("\n")}\n` : "", next: more ? last : null, pairs: lines.length, servers: tools.length };
}
