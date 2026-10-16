import { getDb } from "./db";
import { sql } from "drizzle-orm";

// ADR 0018 §3: the live proof strip under the home hero. Real counts only, each linked to its source page.

export interface ProofStrip {
  bouts: number;
  models: number;
  traps_sprung: number;
  tools_checked: number;
}

const KEY = "proof-strip";

export async function proofStrip(env: Pick<Env, "KV" | "DB">): Promise<ProofStrip> {
  const hit = await env.KV.get<ProofStrip>(KEY, "json");
  if (hit) return hit;
  const db = getDb(env as Env);
  const one = async (q: ReturnType<typeof sql>) => Number(((await db.all(q)) as { n: number }[])[0]?.n ?? 0);
  const strip: ProofStrip = {
    bouts: await one(sql`select count(*) as n from arena_runs where status = 'done'`),
    models: await one(sql`select count(distinct model_id) as n from arena_runs where status = 'done'`),
    traps_sprung: await one(
      sql`select count(*) as n from arena_runs r, json_each(json_extract(r.result, '$.traps')) t where r.status = 'done' and json_extract(t.value, '$.triggered') = 1`,
    ),
    tools_checked: await one(sql`select count(distinct tool_id) as n from tool_checks`),
  };
  await env.KV.put(KEY, JSON.stringify(strip), { expirationTtl: 300 });
  return strip;
}
