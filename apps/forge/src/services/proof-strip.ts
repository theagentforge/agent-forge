import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { gate, type Gated } from "./counters";
import * as t from "../db/schema";
import { notEmbargoed } from "../arena/views";

// ADR 0018 §3: the live proof strip under the home hero. Real counts only, each linked to its source page.
// ADR 0023 §3: each number is hidden until it reaches its minimum (services/counters.ts). Practice and dry-run bouts
// are tests, so they aren't counted, and nor is any run no public page may show (v3, 9 Nov); tool checks by the House and /connect test checks are never recorded in
// tool_checks (mcp.ts, services/feedback.ts), so "tools checked" is people other than the House.

export interface ProofStrip {
  bouts: number;
  models: number;
  traps_sprung: number;
  tools_checked: number;
}

const KEY = "proof-strip:v3";

/**
 * The published ranked bouts: the same rule as /arena's ranked model list (views.ts rankedModelIds): finished, card or
 * guest event, no Lab arm, and past `notEmbargoed` (no held event, embargoed model, private or practice-only job,
 * frontier calibration seed, held-out seed or unpremiered fixture). Weekly brief 9 Nov: before v3 this counted every
 * non-practice run, the held Crucible 3 event and embargoed and held-out runs included (540 bouts on 9 models while
 * /arena and /benchmark showed 6).
 */
const publishedRanked = (now: number) =>
  sql`${t.arenaRuns.status} = 'done' and ${t.arenaRuns.finishedAt} is not null and ${t.arenaEvents.kind} in ('card', 'guest') and ${t.arenaEvents.arm} is null and ${notEmbargoed(now)}`;

/** The raw counts (cached for 5 minutes). Pages and JSON twins use `gatedProofStrip`, never these directly. */
export async function proofStrip(env: Pick<Env, "KV" | "DB">, now = Date.now()): Promise<ProofStrip> {
  const hit = await env.KV.get<ProofStrip>(KEY, "json");
  if (hit) return hit;
  const db = getDb(env as Env);
  const one = async (q: ReturnType<typeof sql>) => Number(((await db.all(q)) as { n: number }[])[0]?.n ?? 0);
  const from = sql`arena_runs join arena_events on arena_events.id = arena_runs.event_id`;
  const where = publishedRanked(now);
  const strip: ProofStrip = {
    bouts: await one(sql`select count(*) as n from ${from} where ${where}`),
    models: await one(sql`select count(distinct arena_runs.model_id) as n from ${from} where ${where}`),
    traps_sprung: await one(
      sql`select count(*) as n from ${from}, json_each(json_extract(arena_runs.result, '$.traps')) tr where ${where} and json_extract(tr.value, '$.triggered') = 1`,
    ),
    tools_checked: await one(sql`select count(distinct tool_id) as n from tool_checks`),
  };
  await env.KV.put(KEY, JSON.stringify(strip), { expirationTtl: 300 });
  return strip;
}

/** The proof strip with every counter below its minimum set to null (ADR 0023 §3). */
export async function gatedProofStrip(env: Pick<Env, "KV" | "DB">): Promise<Gated<ProofStrip>> {
  return gate(await proofStrip(env));
}
