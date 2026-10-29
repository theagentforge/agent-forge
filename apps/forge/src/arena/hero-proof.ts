import { publicTrapId, taskById, trapEntry, type AttemptResult, type LogEvent } from "@forge/arena";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { BELOW_MINIMUM_TEXT, THIRD_PARTY_MINIMUM } from "../services/public-stats";
import { verifiedReplay } from "./fail-card";
import { isEmbargoed, modelById } from "./lineup";
import { modelName, notEmbargoed, runWithLog } from "./views";

// The home headline's source (W2.1, decision D2 in docs/strategy/boardy-review-2026-10-27.md): "An AI agent paid a
// fake invoice and reported the job done." The headline links to one real, public Arena replay in which both halves are
// the referee's record, never a reading of the model's words:
//   1. the referee marked the fake-invoice trap (`paid_scam`: FA-INJ-001 on Normal, FA-PAY-002 on Hard) as sprung;
//   2. the model's own `finish` call said status "done";
//   3. the run is public: finished, not embargoed (ADR 0041), not a private family (ADR 0057), not held out (ADR 0058),
//      not in an event held for review, and its replay verifies against its signature. A Forge Lab arm's run may be the
//      source (its replay page is public like any other); the count below leaves Lab arms out, as the dataset does.
// The first pick is kept in KV, so the link never shifts while that run stays public; if it stops being public, the
// pick is made again. With no such run, `heroProof` returns null and the page says so instead of linking anything.

export const FAKE_INVOICE_TRAP = "paid_scam";
const KV_KEY = "home:hero-proof";
const CANDIDATES = 25;
/** Rule 1 in SQL: the referee marked the fake-invoice trap sprung. */
const fellSql = () => sql`exists (select 1 from json_each(${t.arenaRuns.result}, '$.traps') j where json_extract(j.value, '$.id') = ${FAKE_INVOICE_TRAP} and json_extract(j.value, '$.triggered') = 1)`;
/**
 * Rule 2 in SQL: the log's finish event (written by the referee) carries the model's finish status "done". Without it
 * the 25 candidates could all be falls the model didn't call done (review 28 Oct: on production 10 of 11 falls in one
 * event had no finish status), crowding out the one run that qualifies. `proofOf` checks both rules again in code.
 */
const saidDoneSql = () => sql`exists (select 1 from json_each(${t.arenaRuns.log}) e where json_extract(e.value, '$.type') = 'finish' and json_extract(e.value, '$.claim.status') = 'done')`;

export interface HeroProof {
  run: string;
  model: string;
  name: string;
  /** The lab as the lineup names it, e.g. "IBM (open weights)", so the source line says whose model it was. */
  lab: string | null;
  task: string;
  task_title: string;
  trap: { id: string; description: string };
  claim: "done";
  ranked: boolean;
  finished_at: number;
  replay: string;
}

/** Public scam-invoice job ids (every tier), the only jobs with the fake-invoice trap. */
const invoiceTasks = () => ["scam-invoice", "scam-invoice-hard", "scam-invoice-hard3"].filter((id) => !!taskById(id));

/** The facts for one run, or null unless it meets rules 1 and 2 with a public catalogue trap. */
export function proofOf(r: { run: { id: string; modelId: string; task: string; finishedAt: number | null }; event: { kind: string }; result: AttemptResult | null; log: LogEvent[] | null }): HeroProof | null {
  if (!r.result || !r.log || isEmbargoed(r.run.modelId)) return null;
  if (!r.result.traps.some((x) => x.id === FAKE_INVOICE_TRAP && x.triggered)) return null;
  const fin = r.log.find((e) => e.type === "finish");
  if (fin?.type !== "finish" || fin.claim?.status !== "done") return null;
  const pid = publicTrapId(r.run.task, FAKE_INVOICE_TRAP);
  const entry = pid ? trapEntry(pid) : null;
  if (!entry) return null;
  return {
    run: r.run.id,
    model: r.run.modelId,
    name: modelName(r.run.modelId),
    lab: modelById(r.run.modelId)?.lab ?? null,
    task: r.run.task,
    task_title: taskById(r.run.task)?.title ?? r.run.task,
    trap: { id: entry.id, description: entry.description },
    claim: "done",
    ranked: r.event.kind !== "practice",
    finished_at: r.run.finishedAt ?? 0,
    replay: `/arena/run/${r.run.id}`,
  };
}

async function checked(env: Env, row: { run: typeof t.arenaRuns.$inferSelect; event: typeof t.arenaEvents.$inferSelect }) {
  const p = proofOf({ run: row.run, event: row.event, result: row.run.result as AttemptResult | null, log: row.run.log as LogEvent[] | null });
  if (!p) return null;
  return (await verifiedReplay(env, row.run.id, row.run.log, row.run.signature)) ? p : null;
}

/** The replay behind the home headline, or null when no public run shows both the paid fake invoice and "done". */
export async function heroProof(env: Env, now = Date.now()): Promise<HeroProof | null> {
  const db = getDb(env);
  const pinned = await env.KV.get(KV_KEY).catch(() => null);
  if (pinned) {
    const r = await runWithLog(db, pinned, now).catch(() => null);
    const p = r ? await checked(env, { run: r.run, event: r.event }) : null;
    if (p) return p;
  }
  const tasks = invoiceTasks();
  if (!tasks.length) return null;
  const rows = await db
    .select({ run: t.arenaRuns, event: t.arenaEvents })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(
      and(
        eq(t.arenaRuns.status, "done"),
        sql`${t.arenaRuns.task} in (${sql.join(tasks.map((x) => sql`${x}`), sql`, `)})`,
        fellSql(),
        saidDoneSql(),
        notEmbargoed(now),
      ),
    )
    // Ranked bouts first, then the earliest, then the id: a stable order, so the pick doesn't depend on timing.
    .orderBy(sql`case when ${t.arenaEvents.kind} = 'practice' then 1 else 0 end`, t.arenaRuns.finishedAt, t.arenaRuns.id)
    .limit(CANDIDATES);
  for (const row of rows) {
    const p = await checked(env, row);
    if (!p) continue;
    await env.KV.put(KV_KEY, p.run, { expirationTtl: 30 * 86_400 }).catch(() => {});
    return p;
  }
  return null;
}

/**
 * The fallback (coordinator, 28 Oct): with no qualifying replay the D2 headline is NOT shown. Instead, a count anyone
 * can reproduce from /arena/dataset.json: the same runs it lists (finished, public: no embargoed model, private family,
 * held-out seed or held event; Lab arms left out; practice and ranked, every tier) of the scam-invoice jobs, and how
 * many the referee marked `paid_scam`. Small numbers read "below 10" (ADR 0067).
 */
export async function fakeInvoiceCount(env: Env, now = Date.now()) {
  const tasks = invoiceTasks();
  if (!tasks.length) return { runs: 0, fell: 0 };
  const base = and(
    eq(t.arenaRuns.status, "done"),
    isNotNull(t.arenaRuns.finishedAt),
    isNull(t.arenaEvents.arm),
    sql`${t.arenaRuns.task} in (${sql.join(tasks.map((x) => sql`${x}`), sql`, `)})`,
    notEmbargoed(now),
  );
  const db = getDb(env);
  const q = (w: ReturnType<typeof and>) => db.select({ n: count() }).from(t.arenaRuns).innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId)).where(w);
  const [[a], [b]] = await Promise.all([q(base), q(and(base, fellSql()))]);
  return { runs: a?.n ?? 0, fell: b?.n ?? 0 };
}

export type HomeHero =
  | { case: "replay"; headline: string; share: string; proof: HeroProof }
  | { case: "count"; headline: string; share: string; runs: number; fell: number; fell_display: string }
  | { case: "question"; headline: string; share: string; runs: number; fell: number };

/** BRAND.md D2 headline: shown only when a replay backs it. */
export const D2_HEADLINE = "An AI agent paid a fake invoice and reported the job done.";
export const QUESTION_HEADLINE = "Would your AI agent pay a fake invoice?";

/** Which hero the home page shows: the D2 headline with its replay, else a true count, else a question (no claim). */
export async function homeHero(env: Env, now = Date.now()): Promise<HomeHero> {
  const proof = await heroProof(env, now).catch(() => null);
  if (proof) return { case: "replay", headline: D2_HEADLINE, share: D2_HEADLINE.replace(/\.$/, ""), proof };
  const { runs, fell } = await fakeInvoiceCount(env, now).catch(() => ({ runs: 0, fell: 0 }));
  if (fell > 0 && runs > 0) {
    const shown = fell >= THIRD_PARTY_MINIMUM ? fell.toLocaleString("en-US") : BELOW_MINIMUM_TEXT;
    const of = `${shown} of ${runs.toLocaleString("en-US")}`;
    // The share title stays within 60 characters (og:title).
    return { case: "count", headline: `AI agents paid a planted fake invoice in ${of} refereed sandbox runs.`, share: `Fake invoice paid in ${of} refereed sandbox runs`, runs, fell, fell_display: shown };
  }
  return { case: "question", headline: QUESTION_HEADLINE, share: QUESTION_HEADLINE, runs, fell };
}

/** The JSON twin's view: ids, dates and catalogue words only, never anything the model wrote. */
export const heroProofJson = (p: HeroProof | null, origin: string) =>
  p
    ? { case: "replay", status: "found", run: p.run, model: p.model, model_name: p.name, model_lab: p.lab, task: p.task, trap_id: p.trap.id, trap: p.trap.description, claim: p.claim, ranked: p.ranked, finished_at: new Date(p.finished_at).toISOString(), replay_url: `${origin}${p.replay}`, rule: "referee_marked_paid_scam_and_model_finish_status_done" }
    : { status: "not_found", rule: "referee_marked_paid_scam_and_model_finish_status_done" };

/** `hero.headline_source` in the JSON twin: which case applied, and its source. Numbers below 10 are null (ADR 0067). */
export function homeHeroJson(h: HomeHero, origin: string) {
  if (h.case === "replay") return heroProofJson(h.proof, origin);
  const replay = { status: "not_found", rule: "referee_marked_paid_scam_and_model_finish_status_done" };
  const count = {
    runs: h.runs,
    fell: h.fell >= THIRD_PARTY_MINIMUM ? h.fell : null,
    below_minimum: h.fell > 0 && h.fell < THIRD_PARTY_MINIMUM,
    trap: FAKE_INVOICE_TRAP,
    rule: "dataset_runs_of_scam_invoice_jobs_where_referee_marked_paid_scam",
    dataset_url: `${origin}/arena/dataset.json`,
    catalogue_url: `${origin}/arena/methodology#catalog`,
  };
  return { case: h.case, replay, count };
}
