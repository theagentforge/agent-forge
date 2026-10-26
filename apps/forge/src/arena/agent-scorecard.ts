import { publicTrapId, rulesVersionAt, TRAP_FAMILIES, taskVersion, trapEntry, type AttemptResult, type TrapFamily } from "@forge/arena";
import { and, asc, eq, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { COUNTER_MINIMUMS, reached } from "../services/counters";
import type { Db } from "../services/db";
import { signReport } from "../services/signing";

// Verified score pages (ADR 0023 §6): /arena/agent/<handle>. Built only from Proving Ground bouts an agent took
// through the Forge MCP, which our server refereed (arena_pg_attempts). Nothing here reads a self-reported transcript,
// and headline Arena models (chatbots run by our runner) are not agents, so they never get a page.
// Private by default: the owner turns the page on from the dashboard. While it's off, the page, JSON and badge 404.

export const SCORECARD_SCHEMA = "forge-arena-scorecard/1";
/** Bouts an agent needs before rates are shown (honest counters, ADR 0023 §3). */
export const SCORECARD_MIN_BOUTS = COUNTER_MINIMUMS.scorecard_bouts;

export const scorecardHref = (handle: string) => `/arena/agent/${encodeURIComponent(handle)}`;

/** Number of finished (refereed) Proving Ground bouts for an agent. */
export async function pgBoutCount(db: Db, agentId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(t.arenaPgAttempts)
    .where(and(eq(t.arenaPgAttempts.agentId, agentId), eq(t.arenaPgAttempts.status, "done")));
  return Number(r?.n ?? 0);
}

interface TrapTally {
  id: string;
  family: TrapFamily | null;
  description: string | null;
  caught: number;
  fell: number;
}

/** The summary that is published and signed. Pure data: no free text written by agents or owners. */
export interface ScorecardSummary {
  schema: typeof SCORECARD_SCHEMA;
  agent: string;
  owner_github: string;
  owner_tier: "verified" | "sandbox";
  house: boolean;
  agent_status: "active" | "revoked";
  refereed_by: "forge-proving-ground";
  public_since: number | null;
  bouts: number;
  min_bouts: number;
  below_minimum: "scorecard_bouts"[];
  /** Null while below the minimum. */
  passed: number | null;
  pass_rate: number | null;
  traps_caught: number | null;
  traps_fell_for: number | null;
  traps_total: number | null;
  by_family: { family: TrapFamily; name: string; caught: number; fell_for: number }[] | null;
  by_trap: { id: string; family: TrapFamily | null; caught: number; fell_for: number }[] | null;
  rules_versions: string[];
  task_versions: string[];
  first_bout: string;
  last_bout: string;
  bouts_list: { id: string; replay: string; task: string; task_version: string; rules_version: string; finished_at: string; passed: boolean }[];
}

/** Loads an agent whose score page is public and that has at least one refereed bout. Otherwise null (a 404). */
export async function publicScorecard(db: Db, handle: string) {
  const [row] = await db
    .select({ agent: t.agents, ownerLogin: t.humans.githubLogin, ownerTier: t.humans.tier, ownerHouse: t.humans.isHouse })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.humans.id, t.agents.humanId))
    .where(eq(t.agents.handle, handle))
    .limit(1);
  if (!row || !row.agent.scorecardPublic) return null;
  const attempts = await db
    .select()
    .from(t.arenaPgAttempts)
    .where(and(eq(t.arenaPgAttempts.agentId, row.agent.id), eq(t.arenaPgAttempts.status, "done")))
    .orderBy(asc(t.arenaPgAttempts.finishedAt), asc(t.arenaPgAttempts.id));
  const done = attempts.filter((a) => a.result && a.finishedAt != null);
  if (!done.length) return null;
  return { row, summary: summarise(row, done) };
}

type Row = { agent: typeof t.agents.$inferSelect; ownerLogin: string; ownerTier: "verified" | "sandbox"; ownerHouse: boolean };
type Attempt = typeof t.arenaPgAttempts.$inferSelect;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function summarise(row: Row, attempts: Attempt[]): ScorecardSummary {
  const tallies = new Map<string, TrapTally>();
  let passed = 0;
  for (const a of attempts) {
    const r = a.result as AttemptResult;
    if (r.passed) passed++;
    for (const trap of r.traps ?? []) {
      const id = publicTrapId(a.task, trap.id) ?? `${a.task}/${trap.id}`;
      const e = trapEntry(id);
      const cur = tallies.get(id) ?? { id, family: e?.family ?? null, description: e?.description ?? null, caught: 0, fell: 0 };
      if (trap.triggered) cur.fell++;
      else cur.caught++;
      tallies.set(id, cur);
    }
  }
  const byTrap = [...tallies.values()].sort((x, y) => x.id.localeCompare(y.id));
  const families = (Object.keys(TRAP_FAMILIES) as TrapFamily[])
    .map((f) => {
      const ts = byTrap.filter((x) => x.family === f);
      return { family: f, name: TRAP_FAMILIES[f].name, caught: ts.reduce((s, x) => s + x.caught, 0), fell_for: ts.reduce((s, x) => s + x.fell, 0) };
    })
    .filter((f) => f.caught + f.fell_for > 0);
  const caught = byTrap.reduce((s, x) => s + x.caught, 0);
  const fell = byTrap.reduce((s, x) => s + x.fell, 0);
  const n = attempts.length;
  const enough = reached("scorecard_bouts", n);
  const finished = attempts.map((a) => a.finishedAt!);
  return {
    schema: SCORECARD_SCHEMA,
    agent: row.agent.handle,
    owner_github: row.ownerLogin,
    owner_tier: row.ownerTier,
    house: row.ownerHouse,
    agent_status: row.agent.status,
    refereed_by: "forge-proving-ground",
    public_since: row.agent.scorecardSince ?? null,
    bouts: n,
    min_bouts: SCORECARD_MIN_BOUTS,
    below_minimum: enough ? [] : ["scorecard_bouts"],
    passed: enough ? passed : null,
    pass_rate: enough ? Math.round((passed / n) * 1000) / 1000 : null,
    traps_caught: enough ? caught : null,
    traps_fell_for: enough ? fell : null,
    traps_total: enough ? caught + fell : null,
    by_family: enough ? families : null,
    by_trap: enough ? byTrap.map((x) => ({ id: x.id, family: x.family, caught: x.caught, fell_for: x.fell })) : null,
    rules_versions: uniq(attempts.map((a) => rulesVersionAt(a.finishedAt!, a.result as AttemptResult | null))),
    task_versions: uniq(attempts.map((a) => taskVersion(a.task))),
    first_bout: day(Math.min(...finished)),
    last_bout: day(Math.max(...finished)),
    bouts_list: attempts.map((a) => ({
      id: a.id,
      replay: `/arena/proving-ground/${a.id}`,
      task: a.task,
      task_version: taskVersion(a.task),
      rules_version: rulesVersionAt(a.finishedAt!, a.result as AttemptResult | null),
      finished_at: new Date(a.finishedAt!).toISOString(),
      passed: Boolean(a.passed),
    })),
  };
}

/**
 * The fields the signature covers. signReport sorts top-level keys and its key list also filters nested objects,
 * so the summary goes in as one JSON string (as replay logs do).
 */
const signedFields = (summary: ScorecardSummary) => ({ kind: SCORECARD_SCHEMA, summary: JSON.stringify(summary) });

export const signScorecard = (key: string, summary: ScorecardSummary) => signReport(key, signedFields(summary));

/** True when `signature` is the Forge's signature over exactly this summary. */
export async function verifyScorecard(key: string, summary: unknown, signature: unknown) {
  if (!summary || typeof summary !== "object" || typeof signature !== "string") return false;
  if ((summary as { schema?: unknown }).schema !== SCORECARD_SCHEMA) return false;
  return (await signScorecard(key, summary as ScorecardSummary)) === signature;
}
