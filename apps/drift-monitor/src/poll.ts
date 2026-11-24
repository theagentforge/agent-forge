import { CANARY_FLAG, CANARY_ID, CANARY_NAME, CANARY_VERSION, utcDay } from "@forge/shared/drift-canary";
import { MONITOR_POLICY, optedOut, type Optout } from "@forge/shared/drift-monitor";
import { pollEndpoint, type Fetcher } from "./mcp-client";
import { syncRegistry } from "./registry";
import { getMeta, recordOutcome, recordSkip, setMeta, type Endpoint, type Recorded } from "./store";

// ADR 0151 §4 (amendment 2): one cron run. The Registry is read in the first run of each hour; then at most batchPerRun
// endpoints that are due are polled (re-polls of baselined endpoints first), at most `concurrency` at once and one per
// host; then the canary, once per UTC day. Opt-outs are read before every run and an opted-out endpoint is never
// contacted.

export { optedOut } from "@forge/shared/drift-monitor";

/** Runs `fn` over `items`, at most `limit` at once. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface RunSummary {
  /** Candidates read for this run (at most one per host, twice the batch). */
  due: number;
  /** Of `polled`: re-polls of endpoints that have a baseline (first priority), and the rest (first polls and retries). */
  repolls: number;
  first_polls: number;
  polled: number;
  skipped: { optout: number; needs_config: number; sse: number };
  /** Chosen endpoints left for a later run because the run's time budget was spent (they stay due). */
  deferred: number;
  results: Record<string, number>;
  changes: number;
}

export type Policy = Record<"batchPerRun" | "concurrency" | "perHostPerRun" | "skipsPerRun" | "runBudgetMs", number>;
const COLUMNS = "id, registry_name, remote_url, host, transport, registry_version, needs_config, last_ok_at, first_observed_at, consecutive_errors, ok_registry_version, ok_reported_version, ok_snapshot";
const LIVE = "listed = 1 AND next_poll_at <= ?1 AND coalesce(registry_status, '') != 'deleted'";

/**
 * ADR 0151 amendment 2: which endpoints a run polls. Per host, the endpoint that has waited longest (so a host with
 * more endpoints than runs in a day still gets each in turn); across hosts, hosts whose candidate is a due re-poll of a
 * baselined endpoint first (tier 0), then the rest (tier 1: first polls, error retries, auth re-checks), each by due
 * time. So a baselined endpoint is re-observed at its 24 h due time and first polls fill the remaining budget.
 */
export const CANDIDATES_SQL = `SELECT ${COLUMNS}, tier FROM (
  SELECT ${COLUMNS}, CASE WHEN first_observed_at IS NOT NULL THEN 0 ELSE 1 END AS tier, next_poll_at,
    row_number() OVER (PARTITION BY host ORDER BY next_poll_at, id) AS rn
  FROM drift_servers WHERE ${LIVE} AND needs_config IS NULL AND transport = 'streamable-http'
) WHERE rn <= ?2 ORDER BY tier, next_poll_at, id LIMIT ?3`;

export async function runPolls(db: D1Database, now: number, fetcher: Fetcher, policy: Policy = MONITOR_POLICY, startedAt: number = Date.now()): Promise<RunSummary> {
  const optouts = (await db.prepare("SELECT kind, value FROM drift_optouts").all<Optout>()).results;
  const summary: RunSummary = { due: 0, repolls: 0, first_polls: 0, polled: 0, skipped: { optout: 0, needs_config: 0, sse: 0 }, deferred: 0, results: {}, changes: 0 };

  // Endpoints that are never contacted (the Registry declares a key, header or URL variable; HTTP+SSE only): logged as
  // skipped and not due again for 30 days. Nothing is sent.
  const skips = (
    await db
      .prepare(`SELECT ${COLUMNS} FROM drift_servers WHERE ${LIVE} AND (needs_config IS NOT NULL OR transport != 'streamable-http') ORDER BY next_poll_at, id LIMIT ?2`)
      .bind(now, policy.skipsPerRun)
      .all<Endpoint>()
  ).results;
  for (const e of skips) {
    if (optedOut(e, optouts)) {
      await recordSkip(db, e, "skipped_optout", now);
      summary.skipped.optout++;
    } else if (e.needs_config) {
      await recordSkip(db, e, "skipped_needs_config", now);
      summary.skipped.needs_config++;
    } else {
      // The deprecated HTTP+SSE transport (and anything unknown) isn't polled in version 1 (ADR 0151 §4).
      await recordSkip(db, e, "skipped_sse", now);
      summary.skipped.sse++;
    }
  }

  // Twice the batch, so opted-out candidates (logged, never contacted) don't shrink the run.
  const due = (await db.prepare(CANDIDATES_SQL).bind(now, policy.perHostPerRun, policy.batchPerRun * 2).all<Endpoint & { tier: number }>()).results;
  summary.due = due.length;
  const chosen: (Endpoint & { tier: number })[] = [];
  for (const e of due) {
    if (optedOut(e, optouts)) {
      await recordSkip(db, e, "skipped_optout", now);
      summary.skipped.optout++;
    } else if (chosen.length < policy.batchPerRun) chosen.push(e);
  }
  const recorded = await pool(chosen, policy.concurrency, async (e): Promise<(Recorded & { tier: number }) | null> => {
    // The run's time budget: a poll not started by then waits for the next run.
    if (Date.now() - startedAt > policy.runBudgetMs) return null;
    const started = Date.now();
    const out = await pollEndpoint(e.remote_url, fetcher);
    return { ...(await recordOutcome(db, e, out, now, Date.now() - started)), tier: e.tier };
  });
  for (const r of recorded) {
    if (!r) {
      summary.deferred++;
      continue;
    }
    summary.polled++;
    if (r.tier === 0) summary.repolls++;
    else summary.first_polls++;
    summary.results[r.status] = (summary.results[r.status] ?? 0) + 1;
    summary.changes += r.changes;
  }
  await markFirstPass(db, now);
  return summary;
}

/**
 * The first full polling pass: dated once (never moved) in the first run after the Registry's first full pass in which
 * no endpoint we may contact is still untried. /drift/coverage shows "in progress" until then.
 */
export async function markFirstPass(db: D1Database, now: number) {
  if ((await getMeta(db, "poll_first_pass_done_at")) || !(await getMeta(db, "registry_first_pass_done_at"))) return false;
  const left = await db
    .prepare("SELECT 1 AS x FROM drift_servers WHERE listed = 1 AND coalesce(registry_status, '') != 'deleted' AND needs_config IS NULL AND transport = 'streamable-http' AND last_status IS NULL LIMIT 1")
    .first<{ x: number }>();
  if (left) return false;
  await db.prepare("INSERT OR IGNORE INTO drift_meta (key, value, updated_at) VALUES ('poll_first_pass_done_at', ?1, ?2)").bind(new Date(now).toISOString(), now).run();
  return true;
}

/**
 * ADR 0151 amendment 2: the canary (packages/shared/src/drift-canary.ts), polled once per UTC day with the same client
 * and the same store as every other endpoint. Its row is listed = 0 and flagged registry_status = 'canary', so no
 * Registry pass, no run's candidates and no coverage or change total ever include it.
 */
export async function runCanary(db: D1Database, now: number, fetcher: Fetcher, url: string): Promise<{ polled: boolean; status?: string; changes?: number }> {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return { polled: false, status: "invalid_url" };
  }
  await db
    .prepare(
      `INSERT INTO drift_servers (id, registry_name, remote_url, host, transport, registry_version, registry_status, listed, first_listed_at, last_listed_at, next_poll_at)
       VALUES (?1, ?2, ?3, ?4, 'streamable-http', ?5, ?6, 0, ?7, ?7, ?7)
       ON CONFLICT(id) DO UPDATE SET remote_url = excluded.remote_url, host = excluded.host, registry_version = excluded.registry_version, registry_status = excluded.registry_status, listed = 0`,
    )
    .bind(CANARY_ID, CANARY_NAME, url, host, CANARY_VERSION, CANARY_FLAG, now)
    .run();
  const e = await db.prepare(`SELECT ${COLUMNS}, last_poll_at FROM drift_servers WHERE id = ?1`).bind(CANARY_ID).first<Endpoint & { last_poll_at: number | null }>();
  if (!e) return { polled: false };
  if (e.last_poll_at !== null && utcDay(e.last_poll_at) >= utcDay(now)) return { polled: false };
  const started = Date.now();
  const r = await recordOutcome(db, e, await pollEndpoint(e.remote_url, fetcher), now, Date.now() - started);
  return { polled: true, status: r.status, changes: r.changes };
}

/** One scheduled run: the hourly Registry sync (first run of the hour), then a batch of polls, then the daily canary. */
export async function runCycle(env: { DB: D1Database; POLL_ENABLED?: string; CANARY_URL?: string }, now: number, fetcher: Fetcher = (u, i) => fetch(u, i), policy: Policy = MONITOR_POLICY) {
  if ((env.POLL_ENABLED ?? "").trim().toLowerCase() !== "on") return { enabled: false as const };
  const startedAt = Date.now();
  let registry: Awaited<ReturnType<typeof syncRegistry>> | { error: string } | null = null;
  if (new Date(now).getUTCMinutes() < 10) {
    try {
      registry = await syncRegistry(env.DB, now, fetcher);
    } catch (e) {
      // A Registry outage never stops the polls of endpoints already known; the next hour resumes from the cursor.
      registry = { error: String(e).slice(0, 200) };
      await setMeta(env.DB, "registry_sync_error", `${new Date(now).toISOString()} ${registry.error}`, now).catch(() => {});
    }
  }
  const polls = await runPolls(env.DB, now, fetcher, policy, startedAt);
  let canary: Awaited<ReturnType<typeof runCanary>> | { error: string } | null = null;
  const url = (env.CANARY_URL ?? "").trim();
  if (url) {
    try {
      canary = await runCanary(env.DB, now, fetcher, url);
    } catch (e) {
      canary = { error: String(e).slice(0, 200) };
    }
  }
  return { enabled: true as const, registry, polls, canary };
}
