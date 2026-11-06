import { scanSkill } from "@forge/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import * as t from "../db/schema";
// census.ts imports this file too: only functions from it are used here, never at load time.
import { failureClass } from "./census";
import { getDb, newId } from "./db";
import { findTool } from "./forge";
import { scanToolList, TOOL_CAPS, toolsText } from "./house-tools";
import { canonicalToolId } from "./tools";

// ADR 0134 (moat audit 5 Nov, gate 1): the tool-definition history, backfilled.
//
// tool_description_history (ADR 0129) keeps every tool-definition set the House tester sees, from Oct 2026. This file
// reaches it back: for each server the nightly top-500 tests (npm) and each PyPI server the weekly sweep has seen start,
// every stable version published since 2025-09-01 is installed by the House tester (house-backfill.yml, on the public
// mirror's free runners, same sandbox, no secrets), its tools/list read, and the set stored with origin `backfill`:
// first_seen is the version's publish date from the registry, observed_at is when we ran it. The two meanings never mix:
// forward (nightly) rows are untouched and every forward metric leaves backfill rows out.
//
// Then drift: for each tool, consecutive observed definition sets compared (tools added or removed, description text
// changed, input schema changed), with whether the version's major number moved, and the scanner rule ids that the new
// text matched and the old text didn't (rule ids only; a match is a pattern for a person to read, not a finding).

export const BACKFILL_SINCE = "2025-09-01";
export const SINCE_MS = Date.parse(`${BACKFILL_SINCE}T00:00:00.000Z`);
/** Versions offered to one run (10 shards of 100, 4 at a time, at most 75 s each: under 32 minutes a shard). */
export const PER_RUN = 1000;
export const SHARDS = 10;
/** The newest stable versions kept per server; older ones are listed as excluded (over_cap), never silently dropped. */
export const MAX_VERSIONS = 150;
/** PyPI servers have no download ranking; the first 100 (by name) that the weekly sweep has seen start. */
export const PYPI_CAP = 100;
/** A version offered this many times with no answer (its shard died) is closed as test_error. */
export const MAX_ATTEMPTS = 3;
export const ORIGINS = { nightly: "nightly", carried: "carried", backfill: "backfill" } as const;
export const EXCLUDED_REASONS = { prerelease: "A prerelease (npx and uvx don't install it by default).", over_cap: `Older than the newest ${MAX_VERSIONS} stable versions of its server.`, no_tool_page: "The site has no tool page for this server." } as const;

const DAY = 86_400_000;
const SERVER = /^(npm:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*|pypi:[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?)$/;
const VERSION = /^[0-9][A-Za-z0-9.+_!-]{0,63}$/;

/** A prerelease: npm semver with a "-" tag; PyPI PEP 440 a/b/rc/dev (post releases are stable). */
export function isPrerelease(registry: string, version: string) {
  if (registry === "npm") return version.includes("-");
  return /\d(a|b|c|rc|alpha|beta|pre|preview)\d*/i.test(version) || /dev\d*/i.test(version);
}

/** The major number: the first release number (a PEP 440 epoch is dropped), or null if there is none. */
export function majorOf(version: string) {
  const m = /^(?:\d+!)?(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

// --- The server set ----------------------------------------------------------------------------------------------------

/** The servers the backfill covers, read from stored House nights (no writes). */
async function candidateServers(env: Env) {
  const db = getDb(env);
  const npm = (await db.all(
    sql`SELECT server, coalesce(rank, 0) AS rank FROM house_results WHERE family = 'top500_nightly' AND night = (SELECT max(night) FROM house_results WHERE family = 'top500_nightly') ORDER BY coalesce(rank, 0), server`,
  )) as { server: string; rank: number }[];
  const pypi = (await db.all(
    sql`SELECT DISTINCT server FROM house_results WHERE family = 'weekly_sweep' AND server LIKE 'pypi:%' AND outcome IN ('worked', 'partial') ORDER BY server LIMIT ${PYPI_CAP}`,
  )) as { server: string }[];
  return [
    ...npm.filter((r) => SERVER.test(r.server)).map((r) => ({ server: r.server, source: "top500_nightly", rank: Number(r.rank) })),
    ...pypi.filter((r) => SERVER.test(r.server)).map((r, i) => ({ server: r.server, source: "weekly_sweep_pypi", rank: 1000 + i })),
  ];
}

const split = (server: string) => ({ registry: server.slice(0, server.indexOf(":")), package: server.slice(server.indexOf(":") + 1) });

/** Freezes the server set the first time it is needed (later House nights don't change it). */
export async function ensureServers(env: Env, now = Date.now()) {
  const db = getDb(env);
  if ((await db.$count(t.toolHistoryServers)) > 0) return { seeded: 0 };
  const list = await candidateServers(env);
  const resolve = "coalesce((SELECT id FROM tools WHERE canonical_id = ?1), (SELECT tool_id FROM tool_aliases WHERE alias = ?1))";
  const stmts = list.map((c) =>
    env.DB.prepare(`INSERT OR IGNORE INTO tool_history_servers (server, registry, package, tool_id, source, rank, added_at) VALUES (?1, ?2, ?3, ${resolve}, ?4, ?5, ?6)`).bind(c.server, split(c.server).registry, split(c.server).package, c.source, c.rank, now),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { seeded: list.length };
}

// --- The plan (public, read only: the plan job holds no token) ---------------------------------------------------------

export interface PlanVersion {
  server: string;
  registry: string;
  package: string;
  version: string;
}

/** What tonight's run should do: servers whose version list isn't read yet, and the next pending versions. */
export async function backfillPlan(env: Env, limit = PER_RUN) {
  const db = getDb(env);
  const n = Math.max(0, Math.min(PER_RUN, Math.floor(limit)));
  const servers = await db.$count(t.toolHistoryServers);
  const enumerate = servers
    ? ((await db.all(sql`SELECT server FROM tool_history_servers WHERE enumerated_at IS NULL ORDER BY rank, server LIMIT 1000`)) as { server: string }[])
    : await candidateServers(env);
  const versions = (await db.all(
    sql`SELECT q.server AS server, s.registry AS registry, s.package AS package, q.version AS version FROM tool_history_queue q JOIN tool_history_servers s ON s.server = q.server
        WHERE q.status = 'pending' ORDER BY q.attempts, s.rank, q.server, q.published_at LIMIT ${n}`,
  )) as unknown as PlanVersion[];
  return {
    data_kind: "tool_history_backfill_plan",
    since: BACKFILL_SINCE,
    per_run: PER_RUN,
    max_versions: MAX_VERSIONS,
    enumerate: enumerate.map((r) => ({ server: r.server, ...split(r.server) })),
    versions,
  };
}

// --- Enqueue: the registry's version lists, read by the plan job -------------------------------------------------------

const enumeratedSchema = z.strictObject({
  servers: z
    .array(
      z.strictObject({
        server: z.string().regex(SERVER).max(230),
        status: z.enum(["ok", "not_found"]),
        versions: z.array(z.strictObject({ version: z.string().regex(VERSION), published_at: z.string().datetime() })).max(5000),
      }),
    )
    .min(1)
    .max(100),
});

/** Which of a server's listed versions are queued, and why the rest aren't. Pure. */
export function selectVersions(registry: string, versions: { version: string; published_at: string }[], now: number) {
  const seen = new Set<string>();
  const dated = versions
    .map((v) => ({ version: v.version, at: Date.parse(v.published_at) }))
    .filter((v) => v.at >= SINCE_MS && v.at <= now + DAY && !seen.has(v.version) && (seen.add(v.version), true))
    .sort((a, b) => b.at - a.at || (a.version < b.version ? 1 : -1));
  const stable = dated.filter((v) => !isPrerelease(registry, v.version));
  return {
    stable: stable.length,
    rows: [
      ...stable.slice(0, MAX_VERSIONS).map((v) => ({ ...v, status: "pending", reason: null as string | null })),
      ...stable.slice(MAX_VERSIONS).map((v) => ({ ...v, status: "excluded", reason: "over_cap" })),
      ...dated.filter((v) => isPrerelease(registry, v.version)).map((v) => ({ ...v, status: "excluded", reason: "prerelease" })),
    ],
  };
}

/** Stores version lists for servers in the set that weren't listed yet (a second list for a server is ignored). */
export async function enqueueVersions(env: Env, input: unknown, now = Date.now()) {
  const parsed = enumeratedSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, detail: parsed.error.issues[0]?.message };
  await ensureServers(env, now);
  const db = getDb(env);
  let servers = 0;
  let queued = 0;
  let excluded = 0;
  let ignored = 0;
  for (const s of parsed.data.servers) {
    const [row] = await db.select().from(t.toolHistoryServers).where(sql`${t.toolHistoryServers.server} = ${s.server}`);
    if (!row || row.enumeratedAt !== null) {
      ignored++;
      continue;
    }
    let toolId = row.toolId;
    if (!toolId) toolId = (await findTool(db, canonicalToolId(s.server)))?.id ?? null;
    const sel = s.status === "ok" ? selectVersions(row.registry, s.versions, now) : { stable: 0, rows: [] };
    const rows = sel.rows.map((v) => ({
      server: s.server,
      version: v.version,
      publishedAt: v.at,
      status: toolId ? v.status : "excluded",
      reason: toolId ? v.reason : v.status === "pending" ? "no_tool_page" : v.reason,
      enqueuedAt: now,
    }));
    const stmts = [];
    // D1 allows 100 bound parameters a statement; a row has up to 12 columns.
    for (let i = 0; i < rows.length; i += 8) stmts.push(db.insert(t.toolHistoryQueue).values(rows.slice(i, i + 8)).onConflictDoNothing());
    stmts.push(db.update(t.toolHistoryServers).set({ status: s.status, enumeratedAt: now, versionsListed: sel.stable, toolId }).where(sql`${t.toolHistoryServers.server} = ${s.server}`));
    await db.batch(stmts as [(typeof stmts)[number], ...typeof stmts]);
    servers++;
    queued += rows.filter((r) => r.status === "pending").length;
    excluded += rows.filter((r) => r.status === "excluded").length;
  }
  return { ok: true as const, servers, queued, excluded, ignored };
}

// --- Results: what each version listed, from the backfill shards -------------------------------------------------------

/** The House tester's raw outcomes (the keys of census.ts OUTCOME_CLASS; a test keeps the two equal). */
export const OUTCOMES = ["worked", "partial", "failed", "no_answer", "needs_config", "not_on_npm", "not_on_pypi", "no_command", "error"] as const;
const toolSchema = z.strictObject({ name: z.string().min(1).max(TOOL_CAPS.name), description: z.string().max(TOOL_CAPS.description), schema: z.string().max(TOOL_CAPS.schema).nullable() });
const resultsSchema = z.strictObject({
  probed_at: z.string().datetime(),
  results: z
    .array(
      z.strictObject({
        server: z.string().regex(SERVER).max(230),
        version: z.string().regex(VERSION),
        outcome: z.enum(OUTCOMES),
        tools_count: z.number().int().min(0).max(9_999).nullable(),
        tools: z
          .array(toolSchema)
          .min(1)
          .max(TOOL_CAPS.tools)
          .refine((xs) => xs.reduce((n, x) => n + x.name.length + x.description.length + (x.schema?.length ?? 0), 0) <= TOOL_CAPS.total)
          .nullable(),
      }),
    )
    .max(25),
  /** Every version this run was given (from its plan), sent once after the results: unanswered ones count an attempt. */
  offered: z.array(z.strictObject({ server: z.string().regex(SERVER).max(230), version: z.string().regex(VERSION) })).max(PER_RUN).optional(),
});

/**
 * Stores one batch: a version that listed tools gets a backfill history row (first_seen = its publish date,
 * observed_at = the run's time); every answered version leaves the queue as done or failed (with its failure class).
 * Only versions still pending (or closed for no answer) are written; anything else is ignored, so a replay changes nothing.
 */
export async function recordBackfillResults(env: Env, input: unknown, now = Date.now()) {
  const parsed = resultsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, detail: parsed.error.issues[0]?.message };
  const observedAt = Date.parse(parsed.data.probed_at);
  if (observedAt > now + 600_000 || observedAt < now - 3 * DAY) return { ok: false as const, detail: "probed_at out of range" };
  const db = getDb(env);
  let stored = 0;
  let done = 0;
  let failed = 0;
  let ignored = 0;
  for (const r of parsed.data.results) {
    const [q] = await db.select().from(t.toolHistoryQueue).where(sql`${t.toolHistoryQueue.server} = ${r.server} AND ${t.toolHistoryQueue.version} = ${r.version}`);
    const open = q && (q.status === "pending" || (q.status === "failed" && q.reason === "test_error" && q.outcome === null));
    if (!q || !open) {
      ignored++;
      continue;
    }
    const [s] = await db.select().from(t.toolHistoryServers).where(sql`${t.toolHistoryServers.server} = ${r.server}`);
    const tool = s?.toolId ? await db.query.tools.findFirst({ where: (x, { eq }) => eq(x.id, s.toolId!) }) : await findTool(db, canonicalToolId(r.server));
    const where = sql`${t.toolHistoryQueue.server} = ${r.server} AND ${t.toolHistoryQueue.version} = ${r.version}`;
    const cls = failureClass(r.outcome);
    if (cls) {
      await db.update(t.toolHistoryQueue).set({ status: "failed", reason: cls, outcome: r.outcome, observedAt }).where(where);
      failed++;
      continue;
    }
    if (!tool) {
      await db.update(t.toolHistoryQueue).set({ status: "excluded", reason: "no_tool_page", outcome: r.outcome, observedAt }).where(where);
      ignored++;
      continue;
    }
    if (!r.tools) {
      await db.update(t.toolHistoryQueue).set({ status: "done", reason: null, outcome: r.outcome, observedAt, toolsCount: r.tools_count ?? 0 }).where(where);
      done++;
      continue;
    }
    const p = await scanToolList({ id: r.server, version: r.version, tools: r.tools }, observedAt);
    const sha = p.fingerprint.replace(/^sha256:/, "");
    await db.batch([
      db
        .insert(t.toolDescriptionHistory)
        .values({
          id: newId(),
          toolId: tool.id,
          server: tool.canonicalId,
          version: r.version,
          descriptionSha256: sha,
          toolsCount: p.tools_count,
          descriptionsCount: p.tools.filter((x) => x.description.length > 0).length,
          verdict: p.verdict,
          counts: p.counts,
          findings: p.findings,
          rulesVersion: p.rules_version,
          toolList: p.tools,
          // The two meanings, kept apart: when the version was published, and when we ran it.
          firstSeen: q.publishedAt,
          lastSeen: observedAt,
          observedAt,
          origin: ORIGINS.backfill,
        })
        .onConflictDoNothing(),
      db.update(t.toolHistoryQueue).set({ status: "done", reason: null, outcome: r.outcome, observedAt, toolsCount: p.tools_count, descriptionSha256: sha }).where(where),
    ]);
    stored++;
    done++;
  }
  let closed = 0;
  if (parsed.data.offered?.length) {
    const stmts = parsed.data.offered.map((o) =>
      env.DB.prepare(
        `UPDATE tool_history_queue SET attempts = attempts + 1, offered_at = ?1,
           status = CASE WHEN attempts + 1 >= ?2 THEN 'failed' ELSE 'pending' END,
           reason = CASE WHEN attempts + 1 >= ?2 THEN 'test_error' ELSE NULL END
         WHERE server = ?3 AND version = ?4 AND status = 'pending'`,
      ).bind(now, MAX_ATTEMPTS, o.server, o.version),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    closed = Number(((await db.all(sql`SELECT count(*) AS n FROM tool_history_queue WHERE status = 'failed' AND reason = 'test_error' AND outcome IS NULL AND offered_at = ${now}`)) as { n: number }[])[0]?.n ?? 0);
  }
  return { ok: true as const, stored, done, failed, ignored, closed_unanswered: closed };
}

// --- Progress (admin only) ---------------------------------------------------------------------------------------------

export async function backfillProgress(env: Env) {
  const db = getDb(env);
  const servers = ((await db.all(
    sql`SELECT count(*) AS total, sum(enumerated_at IS NOT NULL) AS enumerated, sum(status = 'not_found') AS not_found,
          sum(enumerated_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tool_history_queue q WHERE q.server = s.server AND q.status = 'pending')) AS complete,
          sum(source = 'top500_nightly') AS npm, sum(source = 'weekly_sweep_pypi') AS pypi
        FROM tool_history_servers s`,
  )) as Record<string, number | null>[])[0]!;
  const byStatus = (await db.all(sql`SELECT status, coalesce(reason, '') AS reason, count(*) AS n FROM tool_history_queue GROUP BY status, reason ORDER BY status, reason`)) as { status: string; reason: string; n: number }[];
  const sum = (st: string) => byStatus.filter((r) => r.status === st).reduce((a, r) => a + Number(r.n), 0);
  const reasons = (st: string) => Object.fromEntries(byStatus.filter((r) => r.status === st).map((r) => [r.reason, Number(r.n)]));
  const last = ((await db.all(sql`SELECT max(observed_at) AS at, count(DISTINCT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch')) AS days FROM tool_history_queue WHERE observed_at IS NOT NULL`)) as { at: number | null; days: number }[])[0];
  const rows = ((await db.all(sql`SELECT count(*) AS n, count(DISTINCT tool_id) AS tools FROM tool_description_history WHERE origin = 'backfill'`)) as { n: number; tools: number }[])[0];
  const drift = ((await db.all(sql`SELECT count(*) AS pairs, sum(change_class != 'none') AS changed, sum(change_class != 'none' AND NOT major_bump) AS no_major, sum(json_array_length(new_text_rules) > 0) AS rules FROM tool_definition_drift`)) as Record<string, number | null>[])[0]!;
  const total = Number(servers.total ?? 0);
  const enumerated = Number(servers.enumerated ?? 0);
  const pending = sum("pending");
  return {
    since: BACKFILL_SINCE,
    per_run: PER_RUN,
    servers: { total, npm: Number(servers.npm ?? 0), pypi: Number(servers.pypi ?? 0), enumerated, not_found: Number(servers.not_found ?? 0), complete: Number(servers.complete ?? 0) },
    versions: { done: sum("done"), failed: sum("failed"), pending, excluded: sum("excluded"), failed_by_class: reasons("failed"), excluded_by_reason: reasons("excluded") },
    history_rows: { backfill: Number(rows?.n ?? 0), tools: Number(rows?.tools ?? 0) },
    drift: { pairs: Number(drift.pairs ?? 0), changed: Number(drift.changed ?? 0), changed_without_major_bump: Number(drift.no_major ?? 0), with_new_text_rules: Number(drift.rules ?? 0) },
    last_observed_at: last?.at ? new Date(Number(last.at)).toISOString() : null,
    run_days: Number(last?.days ?? 0),
    // Measured, not guessed: null until every server's version list has been read.
    runs_left: total && enumerated === total ? Math.ceil(pending / PER_RUN) : null,
  };
}

// --- Drift -------------------------------------------------------------------------------------------------------------

interface Tool {
  name: string;
  description: string;
  schema: string | null;
}
export interface Observation {
  version: string;
  sha: string;
  tools: Tool[];
  /** The version's publish date where known (backfill rows, or a queue row for that version) */
  publishedAt: number | null;
  firstSeen: number;
  origin: string;
}

export const CHANGE_CLASSES = ["tool_added", "tool_removed", "description_changed", "schema_changed"] as const;

/** How two definition sets differ. Pure. */
export function diffTools(before: Tool[], after: Tool[]) {
  const old = new Map(before.map((x) => [x.name, x]));
  const now = new Map(after.map((x) => [x.name, x]));
  const added = after.filter((x) => !old.has(x.name));
  const removed = before.filter((x) => !now.has(x.name));
  const described = after.filter((x) => old.has(x.name) && old.get(x.name)!.description !== x.description);
  const schemas = after.filter((x) => old.has(x.name) && (old.get(x.name)!.schema ?? null) !== (x.schema ?? null));
  const classes = [added.length && "tool_added", removed.length && "tool_removed", described.length && "description_changed", schemas.length && "schema_changed"].filter(Boolean) as string[];
  return { added, removed, described, schemas, changeClass: classes.length ? classes.join(";") : "none" };
}

const ruleIds = async (tools: Tool[]) => (tools.length ? new Set((await scanSkill(toolsText(tools).text)).findings.map((f) => f.rule)) : new Set<string>());

/** Scanner rules the new text of added or changed tools matched that the old text of the same tools didn't. */
export async function newTextRules(before: Tool[], after: Tool[]) {
  const d = diffTools(before, after);
  const changedNames = new Set([...d.described, ...d.schemas].map((x) => x.name));
  const fresh = [...d.added, ...after.filter((x) => changedNames.has(x.name))];
  if (!fresh.length) return [];
  const was = await ruleIds(before.filter((x) => changedNames.has(x.name)));
  return [...(await ruleIds(fresh))].filter((r) => !was.has(r)).sort();
}

/** One representative per version + set (a backfill row first, being the same method for every version), oldest first. */
export function orderObservations(obs: Observation[]) {
  const by = new Map<string, Observation>();
  for (const o of obs) {
    const k = `${o.version}|${o.sha}`;
    const had = by.get(k);
    if (!had || (o.origin === ORIGINS.backfill && had.origin !== ORIGINS.backfill) || (o.origin === had.origin && o.firstSeen < had.firstSeen)) by.set(k, { ...o, publishedAt: o.publishedAt ?? had?.publishedAt ?? null });
  }
  const key = (o: Observation) => o.publishedAt ?? o.firstSeen;
  return [...by.values()].sort((a, b) => key(a) - key(b) || a.firstSeen - b.firstSeen || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/** The drift rows for one tool's observations. `failedAt`: publish dates of versions that didn't start. */
export async function driftRows(toolId: string, server: string, obs: Observation[], failedAt: number[], now: number) {
  const ordered = orderObservations(obs);
  const rows: (typeof t.toolDefinitionDrift.$inferInsert)[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!;
    const b = ordered[i]!;
    const d = diffTools(a.tools, b.tools);
    const ma = majorOf(a.version);
    const mb = majorOf(b.version);
    const lo = a.publishedAt ?? a.firstSeen;
    const hi = b.publishedAt ?? b.firstSeen;
    rows.push({
      toolId,
      seq: i,
      server,
      fromVersion: a.version,
      toVersion: b.version,
      fromSha256: a.sha,
      toSha256: b.sha,
      fromPublishedAt: a.publishedAt,
      toPublishedAt: b.publishedAt,
      changeClass: d.changeClass,
      toolsAdded: d.added.length,
      toolsRemoved: d.removed.length,
      descriptionsChanged: d.described.length,
      schemasChanged: d.schemas.length,
      // The major number moved either way: publish order interleaves release lines (a 1.x backport published after
      // 2.0.0), and that pair is a major change, not drift within one major (review, 5 Nov).
      majorBump: ma !== null && mb !== null && mb !== ma,
      zeroMajor: ma === 0 && mb === 0,
      sameVersion: a.version === b.version,
      untestedBetween: failedAt.filter((x) => x > lo && x < hi).length,
      newTextRules: d.changeClass === "none" ? [] : await newTextRules(a.tools, b.tools),
      computedAt: now,
    });
  }
  return rows;
}

/** What a tool's drift is computed from: its history rows and its answered queue rows. */
const printSql = sql`count(*) || ':' || max(h.first_seen) || ':' || coalesce(max(h.observed_at), 0) || ':' ||
  (SELECT count(*) FROM tool_history_queue q JOIN tool_history_servers s ON s.server = q.server WHERE s.tool_id = h.tool_id AND q.status IN ('done', 'failed'))`;

/** Recomputes drift for up to `limit` tools whose history changed (servers in the backfill set first). */
export async function driftTick(env: Env, now = Date.now(), limit = 50) {
  const db = getDb(env);
  const todo = (await db.all(
    sql`SELECT h.tool_id AS tool_id, ${printSql} AS print FROM tool_description_history h GROUP BY h.tool_id
        HAVING print IS NOT (SELECT print FROM tool_drift_state d WHERE d.tool_id = h.tool_id)
        ORDER BY (h.tool_id IN (SELECT tool_id FROM tool_history_servers WHERE tool_id IS NOT NULL)) DESC, h.tool_id LIMIT ${limit}`,
  )) as { tool_id: string; print: string }[];
  let rows = 0;
  for (const { tool_id: toolId, print } of todo) {
    const hist = await db
      .select({ version: t.toolDescriptionHistory.version, sha: t.toolDescriptionHistory.descriptionSha256, tools: t.toolDescriptionHistory.toolList, firstSeen: t.toolDescriptionHistory.firstSeen, origin: t.toolDescriptionHistory.origin, server: t.toolDescriptionHistory.server })
      .from(t.toolDescriptionHistory)
      .where(sql`${t.toolDescriptionHistory.toolId} = ${toolId}`);
    const queue = (await db.all(
      sql`SELECT q.version AS version, q.published_at AS published_at, q.status AS status FROM tool_history_queue q JOIN tool_history_servers s ON s.server = q.server WHERE s.tool_id = ${toolId} AND q.status IN ('done', 'failed')`,
    )) as { version: string; published_at: number; status: string }[];
    const published = new Map(queue.map((q) => [q.version, Number(q.published_at)]));
    const obs: Observation[] = hist.map((h) => ({
      version: h.version,
      sha: h.sha,
      tools: (h.tools as Tool[]) ?? [],
      publishedAt: h.origin === ORIGINS.backfill ? h.firstSeen : (published.get(h.version) ?? null),
      firstSeen: h.firstSeen,
      origin: h.origin,
    }));
    const out = await driftRows(toolId, hist[0]?.server ?? toolId, obs, queue.filter((q) => q.status === "failed").map((q) => Number(q.published_at)), now);
    const stmts = [db.delete(t.toolDefinitionDrift).where(sql`${t.toolDefinitionDrift.toolId} = ${toolId}`)] as unknown[];
    // 20 columns a row, 100 bound parameters a statement.
    for (let i = 0; i < out.length; i += 4) stmts.push(db.insert(t.toolDefinitionDrift).values(out.slice(i, i + 4)));
    stmts.push(db.insert(t.toolDriftState).values({ toolId, print, computedAt: now }).onConflictDoUpdate({ target: t.toolDriftState.toolId, set: { print, computedAt: now } }));
    await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
    rows += out.length;
  }
  return { tools: todo.length, rows };
}

// --- Census files (ADR 0134 adds them to /dataset/census) -------------------------------------------------------------

export const TOOL_HISTORY_HEADER = ["server", "package", "version", "published_at", "observed_at", "origin", "tools_count", "description_sha256", "change_class", "failure_class"];
export const DRIFT_HEADER = [
  "server",
  "package",
  "from_version",
  "to_version",
  "from_published_at",
  "to_published_at",
  "change_class",
  "tools_added",
  "tools_removed",
  "descriptions_changed",
  "schemas_changed",
  "major_bump",
  "zero_major",
  "same_version",
  "untested_between",
  "new_text_rules",
];
export const toolHistoryPath = (month: string) => `tool-history/${month}.csv`;
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? "" : new Date(Number(ms)).toISOString());

/**
 * The rows of tool-history/<YYYY-MM>.csv (by the version's publish month, or the month we saw it when the publish
 * date isn't known) and drift.csv (changed pairs only). Hashes and change classes only: no tool text, no matched text.
 */
export async function toolHistoryRows(env: Env) {
  const db = getDb(env);
  const hist = (await db.all(
    sql`SELECT tool_id, server, version, description_sha256 AS sha, tools_count, first_seen, observed_at, origin FROM tool_description_history ORDER BY server, first_seen, version`,
  )) as { tool_id: string; server: string; version: string; sha: string; tools_count: number; first_seen: number; observed_at: number | null; origin: string }[];
  const servers = (await db.all(sql`SELECT server, tool_id FROM tool_history_servers WHERE tool_id IS NOT NULL`)) as { server: string; tool_id: string }[];
  const pkgOf = new Map(servers.map((s) => [s.tool_id, s.server]));
  const nameOf = new Map(hist.map((h) => [h.tool_id, h.server]));
  const queue = (await db.all(
    sql`SELECT s.tool_id AS tool_id, s.server AS server, q.version AS version, q.published_at AS published_at, q.observed_at AS observed_at, q.status AS status, q.reason AS reason FROM tool_history_queue q JOIN tool_history_servers s ON s.server = q.server WHERE q.status IN ('done', 'failed')`,
  )) as { tool_id: string | null; server: string; version: string; published_at: number; observed_at: number | null; status: string; reason: string | null }[];
  const published = new Map(queue.filter((q) => q.tool_id).map((q) => [`${q.tool_id}|${q.version}`, Number(q.published_at)]));
  const drift = await db.select().from(t.toolDefinitionDrift).orderBy(t.toolDefinitionDrift.server, t.toolDefinitionDrift.seq);
  const state = new Set(((await db.all(sql`SELECT tool_id FROM tool_drift_state`)) as { tool_id: string }[]).map((r) => r.tool_id));
  const change = new Map<string, string>();
  for (const d of drift) {
    if (d.seq === 1) change.set(`${d.toolId}|${d.fromVersion}|${d.fromSha256}`, "first");
    change.set(`${d.toolId}|${d.toVersion}|${d.toSha256}`, d.changeClass);
  }
  const months = new Map<string, unknown[][]>();
  const put = (at: number, row: unknown[]) => {
    const m = new Date(at).toISOString().slice(0, 7);
    const rows = months.get(m);
    if (rows) rows.push(row);
    else months.set(m, [row]);
  };
  for (const h of hist) {
    const pub = h.origin === ORIGINS.backfill ? Number(h.first_seen) : (published.get(`${h.tool_id}|${h.version}`) ?? null);
    const observed = h.observed_at ?? h.first_seen;
    const cls = change.get(`${h.tool_id}|${h.version}|${h.sha}`) ?? (state.has(h.tool_id) ? "first" : "not_yet_computed");
    put(pub ?? Number(observed), [h.server, pkgOf.get(h.tool_id) ?? "", h.version, iso(pub), iso(observed), h.origin, h.tools_count, h.sha, cls, ""]);
  }
  // Versions that didn't start: recorded as such, with their failure class (nothing is known about their definitions).
  for (const q of queue.filter((x) => x.status === "failed"))
    put(Number(q.published_at), [(q.tool_id && nameOf.get(q.tool_id)) || q.server, q.server, q.version, iso(q.published_at), iso(q.observed_at), ORIGINS.backfill, "", "", "", q.reason ?? "other"]);
  const driftRowsOut = drift
    .filter((d) => d.changeClass !== "none")
    .map((d) => [
      d.server,
      pkgOf.get(d.toolId) ?? "",
      d.fromVersion,
      d.toVersion,
      iso(d.fromPublishedAt),
      iso(d.toPublishedAt),
      d.changeClass,
      d.toolsAdded,
      d.toolsRemoved,
      d.descriptionsChanged,
      d.schemasChanged,
      d.majorBump,
      d.zeroMajor,
      d.sameVersion,
      d.untestedBetween,
      (d.newTextRules ?? []).join(";"),
    ]);
  return { months, drift: driftRowsOut };
}

// --- Buyer-only download (admin): the full tool text ----------------------------------------------------------------

export const FULL_PAGE_ROWS = 400;
export const FULL_PAGE_BYTES = 24 * 1024 * 1024;

/** One page of full rows (tool text included), oldest id first after `after`. Admin only; never a public file. */
export async function fullHistoryPage(env: Env, origin: string | null, after: string, maxBytes = FULL_PAGE_BYTES) {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(t.toolDescriptionHistory)
    .where(origin ? sql`${t.toolDescriptionHistory.origin} = ${origin} AND ${t.toolDescriptionHistory.id} > ${after}` : sql`${t.toolDescriptionHistory.id} > ${after}`)
    .orderBy(t.toolDescriptionHistory.id)
    .limit(FULL_PAGE_ROWS);
  const lines: string[] = [];
  let bytes = 0;
  let last: string | null = null;
  for (const r of rows) {
    const line = JSON.stringify({
      server: r.server,
      version: r.version,
      origin: r.origin,
      published_at: r.origin === ORIGINS.backfill ? iso(r.firstSeen) : null,
      first_seen: iso(r.firstSeen),
      observed_at: iso(r.observedAt ?? r.firstSeen),
      description_sha256: r.descriptionSha256,
      rules_version: r.rulesVersion,
      rules: [...new Set(((r.findings as { rule: string }[]) ?? []).map((f) => f.rule))],
      tools: r.toolList,
    });
    const size = new TextEncoder().encode(line).length + 1;
    if (bytes + size > maxBytes && lines.length) break;
    lines.push(line);
    bytes += size;
    last = r.id;
  }
  // More to read when the page stopped at its byte cap (rows left over) or was a full page of rows.
  const more = lines.length < rows.length || rows.length === FULL_PAGE_ROWS;
  return { body: lines.length ? `${lines.join("\n")}\n` : "", next: more ? last : null, rows: lines.length };
}
