import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { gate, type Gated } from "./counters";

// ADR 0018 §3: the live proof strip under the home hero. Real counts only, each linked to its source page.
// ADR 0023 §3: each number is hidden until it reaches its minimum (services/counters.ts). Practice and dry-run bouts
// are tests, so they aren't counted; tool checks by the House and /connect test checks are never recorded in
// tool_checks (mcp.ts, services/feedback.ts), so "tools checked" is people other than the House.

export interface ProofStrip {
  bouts: number;
  models: number;
  traps_sprung: number;
  tools_checked: number;
}

const KEY = "proof-strip:v2";

/** The raw counts (cached for 5 minutes). Pages and JSON twins use `gatedProofStrip`, never these directly. */
export async function proofStrip(env: Pick<Env, "KV" | "DB">): Promise<ProofStrip> {
  const hit = await env.KV.get<ProofStrip>(KEY, "json");
  if (hit) return hit;
  const db = getDb(env as Env);
  const one = async (q: ReturnType<typeof sql>) => Number(((await db.all(q)) as { n: number }[])[0]?.n ?? 0);
  const headline = sql`r.status = 'done' and e.kind != 'practice'`;
  const strip: ProofStrip = {
    bouts: await one(sql`select count(*) as n from arena_runs r join arena_events e on e.id = r.event_id where ${headline}`),
    models: await one(sql`select count(distinct r.model_id) as n from arena_runs r join arena_events e on e.id = r.event_id where ${headline}`),
    traps_sprung: await one(
      sql`select count(*) as n from arena_runs r join arena_events e on e.id = r.event_id, json_each(json_extract(r.result, '$.traps')) t where ${headline} and json_extract(t.value, '$.triggered') = 1`,
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
