import { publicTrapId, reach, taskById, TRAP_FAMILIES, trapEntry, type AttemptResult } from "@forge/arena";
import { and, eq } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { clipUrlFor } from "./clips";
import { failCard, verifiedReplay, type FailCard } from "./fail-card";
import { FIRST_SLOT, formatSlot, lastHeadlineSlot, slotDate, slotOn, weeklySlug } from "./headline-slot";
import { isEmbargoed, modelById } from "./lineup";
import { FAMILY_ORDER } from "./failures";
import { modelName, notEmbargoed } from "./views";

// V4, Fail of the Week (docs/strategy/agent-social-loops.md §3): after each weekly headline bout is refereed, the most
// notable refereed fail of that bout. Rules, in order (published on the page as data too):
//   1. a trap sprung in a failed attempt (the referee's verdict), never a knockout or a plain fail;
//   2. a frontier model (the lineup's Heavyweight division) first;
//   3. a trap with a public real-world source first;
//   4. the better-known model first, then money traps before the rest, then the earliest attempt, then the run id;
//   5. only attempts whose replay verifies against its signature.
// Embargoed models (ADR 0041) and runs of events held for review are never read (`notEmbargoed`). The pick is kept in
// KV once the bout is fully refereed, so the page and any post about it never shift; if that run stops being public,
// the pick is made again from what is public. Every word comes from the fail-card templates and our trap catalogue.

const KV = (date: string) => `arena:fotw:${date}`;
/** How many weeks back /arena/fail-of-the-week looks for the latest pick. */
export const LOOKBACK_WEEKS = 8;

export const FOTW_RULES = {
  candidates: "failed_attempt_with_sprung_trap",
  excluded: ["knockout_without_trap", "plain_fail", "embargoed_models", "events_held_for_review", "unverified_replays"],
  order: ["frontier_model_first", "trap_with_public_source_first", "better_known_model_first", "money_traps_first", "earliest_attempt", "run_id"],
  event: "weekly_headline_bout",
};

export interface FailOfTheWeek {
  date: string;
  slot: number;
  local: string;
  event: { id: string; slug: string; name: string };
  task: { id: string; title: string };
  run: { id: string; model: string; name: string; lab: string | null; frontier: boolean; seed: number; finished_at: number };
  trap: { id: string; public_id: string | null; label: string; family: string | null; family_name: string | null; description: string | null; pattern: string | null; source: { title: string; url: string } | null };
  card: FailCard;
  /** Traps sprung in this attempt after the first. */
  more_traps: number;
  replay_verified: true;
  clip_url: string | null;
  /** Every non-embargoed model in the bout: attempts, attempts with a trap sprung, attempts passed. */
  bout: { model: string; name: string; attempts: number; fell: number; passed: number }[];
}

/** The Thursday slot for a YYYY-MM-DD date, or null when it isn't a weekly slot date (a Thursday, from 22 Oct 2026). */
export function slotForDate(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.toISOString().slice(0, 10) !== date || day.getUTCDay() !== 4) return null;
  const slot = slotOn(y, m - 1, d);
  return slot >= FIRST_SLOT ? slot : null;
}

type Row = { run: typeof t.arenaRuns.$inferSelect; event: typeof t.arenaEvents.$inferSelect };

const familyRank = (f: string | null) => {
  const i = FAMILY_ORDER.indexOf(f as never);
  return i < 0 ? FAMILY_ORDER.length : i;
};

/** The facts for one candidate run: its first sprung trap and the catalogue entry, or null when it isn't a trap fail. */
function candidate(r: Row) {
  const result = r.run.result as AttemptResult | null;
  if (!result || result.passed || r.event.kind === "practice") return null;
  const name = modelName(r.run.modelId);
  const card = failCard({ runId: r.run.id, modelName: name, result, taskTitle: taskById(r.run.task)?.title ?? r.run.task, practice: false, finishedAt: r.run.finishedAt ?? 0 });
  if (card.kind !== "trap") return null;
  const first = result.traps.find((x) => x.triggered)!;
  const pid = publicTrapId(r.run.task, first.id);
  const entry = pid ? trapEntry(pid) : null;
  const m = modelById(r.run.modelId);
  return { r, result, card, first, pid, entry, frontier: m?.division === "heavyweight", source: !!entry?.provenance.source, reach: reach(r.run.modelId) };
}

type Candidate = NonNullable<ReturnType<typeof candidate>>;

/** The published order (FOTW_RULES.order). */
export function rankCandidates<T extends { frontier: boolean; source: boolean; reach: number; entry: { family: string } | null; r: { run: { id: string; finishedAt: number | null } } }>(xs: T[]): T[] {
  return [...xs].sort(
    (a, b) =>
      Number(b.frontier) - Number(a.frontier) ||
      Number(b.source) - Number(a.source) ||
      b.reach - a.reach ||
      familyRank(a.entry?.family ?? null) - familyRank(b.entry?.family ?? null) ||
      (a.r.run.finishedAt ?? 0) - (b.r.run.finishedAt ?? 0) ||
      a.r.run.id.localeCompare(b.r.run.id),
  );
}

async function eventRuns(env: Env, slot: number, now: number) {
  const db = getDb(env);
  const [ev] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, weeklySlug(slot)));
  if (!ev || ev.status === "planned") return null;
  const rows: Row[] = await db
    .select({ run: t.arenaRuns, event: t.arenaEvents })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(eq(t.arenaRuns.eventId, ev.id), notEmbargoed(now)));
  // Belt and braces for ADR 0041: an embargoed model is never picked, even if a filter above changes.
  return { ev, rows: rows.filter((r) => !isEmbargoed(r.run.modelId)) };
}

function boutTable(rows: Row[]) {
  const by = new Map<string, { attempts: number; fell: number; passed: number }>();
  for (const r of rows) {
    if (r.run.status !== "done") continue;
    const res = r.run.result as AttemptResult | null;
    const s = by.get(r.run.modelId) ?? { attempts: 0, fell: 0, passed: 0 };
    s.attempts++;
    if (res?.traps.some((x) => x.triggered)) s.fell++;
    if (r.run.passed) s.passed++;
    by.set(r.run.modelId, s);
  }
  return [...by].map(([model, s]) => ({ model, name: modelName(model), ...s })).sort((a, b) => a.name.localeCompare(b.name));
}

async function describe(env: Env, slot: number, ev: Row["event"], c: Candidate, rows: Row[]): Promise<FailOfTheWeek> {
  const m = modelById(c.r.run.modelId);
  const e = c.entry;
  return {
    date: slotDate(slot),
    slot,
    local: formatSlot(slot),
    event: { id: ev.id, slug: ev.slug, name: ev.name },
    task: { id: c.r.run.task, title: taskById(c.r.run.task)?.title ?? c.r.run.task },
    run: { id: c.r.run.id, model: c.r.run.modelId, name: modelName(c.r.run.modelId), lab: m?.lab ?? null, frontier: c.frontier, seed: c.r.run.seed, finished_at: c.r.run.finishedAt ?? 0 },
    trap: {
      id: c.first.id,
      public_id: c.pid,
      label: c.first.label,
      family: e?.family ?? null,
      family_name: e ? TRAP_FAMILIES[e.family].name : null,
      description: e?.description ?? null,
      pattern: e?.provenance.pattern ?? null,
      source: e?.provenance.source ?? null,
    },
    card: c.card,
    more_traps: c.card.moreTraps,
    replay_verified: true,
    clip_url: await clipUrlFor(env, c.r.run.id).catch(() => null),
    bout: boutTable(rows),
  };
}

/**
 * The Fail of the Week for one weekly slot, or null: no event, not fully refereed yet, or no qualifying fail. The
 * first pick made after the bout is fully refereed is kept, so it never shifts.
 */
export async function failOfTheWeek(env: Env, slot: number, now = Date.now()): Promise<FailOfTheWeek | null> {
  if (slot > now) return null;
  const data = await eventRuns(env, slot, now);
  if (!data || !data.rows.length) return null;
  const { ev, rows } = data;
  if (rows.some((r) => r.run.status === "queued" || r.run.status === "running")) return null;
  const date = slotDate(slot);
  const stored = await env.KV.get(KV(date)).catch(() => null);
  const verified = async (c: Candidate) => verifiedReplay(env, c.r.run.id, c.r.run.log, c.r.run.signature);
  if (stored) {
    const row = rows.find((r) => r.run.id === stored && r.run.status === "done");
    const c = row ? candidate(row) : null;
    if (c && (await verified(c))) return describe(env, slot, ev, c, rows);
  }
  const ranked = rankCandidates(rows.filter((r) => r.run.status === "done").map(candidate).filter((x): x is Candidate => !!x));
  for (const c of ranked) {
    if (!(await verified(c))) continue;
    await env.KV.put(KV(date), c.r.run.id, { expirationTtl: 400 * 86_400 }).catch(() => {});
    return describe(env, slot, ev, c, rows);
  }
  return null;
}

/** The latest weekly slot with a Fail of the Week, looking back LOOKBACK_WEEKS weeks. */
export async function latestFailOfTheWeek(env: Env, now = Date.now()) {
  let slot = lastHeadlineSlot(now);
  for (let i = 0; slot !== null && i < LOOKBACK_WEEKS; i++) {
    const f = await failOfTheWeek(env, slot, now);
    if (f) return f;
    slot = lastHeadlineSlot(slot - 86_400_000);
  }
  return null;
}

export const fotwPath = (date: string) => `/arena/fail-of-the-week/${date}`;

/** The page's JSON twin: ids, numbers, our own template sentence and catalogue phrases; nothing a model wrote. */
export function fotwJson(f: FailOfTheWeek, origin: string) {
  return {
    name: "Fail of the Week",
    date: f.date,
    bout_at: new Date(f.slot).toISOString(),
    event: f.event.slug,
    task: f.task.id,
    task_title: f.task.title,
    run: f.run.id,
    model: f.run.model,
    model_name: f.run.name,
    lab: f.run.lab,
    frontier: f.run.frontier,
    seed: f.run.seed,
    finished_at: new Date(f.run.finished_at).toISOString(),
    verdict: "FAIL",
    trap: { id: f.trap.public_id, referee_id: f.trap.id, family: f.trap.family, description: f.trap.description, pattern: f.trap.pattern, source_title: f.trap.source?.title ?? null, source_url: f.trap.source?.url ?? null },
    more_traps: f.more_traps,
    sentence: f.card.sentence,
    replay_verified: f.replay_verified,
    replay_url: `${origin}/arena/run/${f.run.id}`,
    clip_page: `${origin}/arena/run/${f.run.id}/clip`,
    clip_url: f.clip_url,
    image: `${origin}/og/arena/run/${f.run.id}.png`,
    bout: f.bout.map((b) => ({ model: b.model, name: b.name, attempts: b.attempts, fell: b.fell, passed: b.passed })),
    rules: FOTW_RULES,
    url: `${origin}${fotwPath(f.date)}`,
  };
}
