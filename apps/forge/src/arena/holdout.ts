import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { modelName, notEmbargoed, notEmbargoedKeepHeldOut, RANKED_KINDS } from "./views";

// The public-vs-held-out gap (ADR 0058, D1): in a ranked event that also ran private held-out seeds, each model's pass
// rate on the public seeds against its pass rate on the held-out ones. It is a contamination test only for public job
// versions that were already published before the event (a model could have been trained on them): versions drawn
// fresh for the event are as unseen as the held-out ones, so there the gap is a control and should be near zero. Each
// row says how many of its public versions were published before. Aggregates only: no held-out run is ever published.

/** Fewer attempts than this on either side: "not enough bouts yet", no gap shown. */
export const MIN_GAP_ATTEMPTS = 10;

const Z = 1.96;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Unrounded 95% Wilson interval. */
function wilson(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = Z * Z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** 95% interval for p1 − p2 (Newcombe's hybrid score method, from the two Wilson intervals). */
export function gapInterval(k1: number, n1: number, k2: number, n2: number): [number, number] {
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const [l1, u1] = wilson(k1, n1);
  const [l2, u2] = wilson(k2, n2);
  const d = p1 - p2;
  return [r3(Math.max(-1, d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2))), r3(Math.min(1, d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)))];
}

interface Side {
  attempts: number;
  passes: number;
  pass_rate: number | null;
  ci_95: [number, number] | null;
}

export interface GapRow {
  event: string;
  event_name: string;
  model: string;
  name: string;
  public: Side;
  held_out: Side;
  /** Public pass rate minus held-out pass rate (positive: better on the public seeds). Null below MIN_GAP_ATTEMPTS. */
  gap: number | null;
  gap_ci_95: [number, number] | null;
  status: "measured" | "not_enough_bouts";
  /** Distinct public job versions (task and seed) this model played in the event. */
  public_versions: number;
  /** How many of them were already in a published run of another event before this event began. */
  public_versions_published_before: number;
  /** "previously_published": every public version was published before; "fresh": none was (the gap is a control). */
  public_arm: "previously_published" | "fresh" | "mixed";
}

const side = (passes: number, attempts: number): Side => ({
  attempts,
  passes,
  pass_rate: attempts ? r3(passes / attempts) : null,
  ci_95: attempts ? (wilson(passes, attempts).map(r3) as [number, number]) : null,
});

type Pair = { eventId: string; eventAt: number; slug: string; eventName: string; model: string; pub: { n: number; k: number }; held: { n: number; k: number } };

/** Per ranked event and model: public and held-out counts, only where the event ran both for that model. */
async function gapPairs(db: Db, f: { eventId?: string; weekly?: boolean; now: number }) {
  const rows = await db
    .select({
      eventId: t.arenaEvents.id,
      eventAt: t.arenaEvents.createdAt,
      slug: t.arenaEvents.slug,
      eventName: t.arenaEvents.name,
      model: t.arenaRuns.modelId,
      heldOut: t.arenaRuns.heldOut,
      n: sql<number>`count(*)`,
      passes: sql<number>`sum(case when ${t.arenaRuns.passed} = 1 then 1 else 0 end)`,
    })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(
      and(
        eq(t.arenaRuns.status, "done"),
        isNotNull(t.arenaRuns.finishedAt),
        notEmbargoedKeepHeldOut(f.now),
        inArray(t.arenaEvents.kind, RANKED_KINDS),
        isNull(t.arenaEvents.arm),
        ...(f.eventId ? [eq(t.arenaRuns.eventId, f.eventId)] : []),
        // The weekly headline bouts (runner.ts weeklySlug): card events named weekly-<date>.
        ...(f.weekly ? [eq(t.arenaEvents.kind, "card"), sql`${t.arenaEvents.slug} like 'weekly-%'`] : []),
      ),
    )
    .groupBy(t.arenaEvents.id, t.arenaRuns.modelId, t.arenaRuns.heldOut);
  const key = (r: (typeof rows)[number]) => `${r.eventId}\u0000${r.model}`;
  const pairs = new Map<string, Omit<Pair, "pub" | "held"> & Partial<Pick<Pair, "pub" | "held">>>();
  for (const r of rows) {
    const p = pairs.get(key(r)) ?? { eventId: r.eventId, eventAt: r.eventAt, slug: r.slug, eventName: r.eventName, model: r.model };
    const v = { n: Number(r.n), k: Number(r.passes ?? 0) };
    if (r.heldOut) p.held = v;
    else p.pub = v;
    pairs.set(key(r), p);
  }
  // Only events that actually ran held-out seeds and also have public runs (the longitudinal panel has none).
  const both = [...pairs.values()].filter((p): p is Pair => !!p.held && !!p.pub);
  const prior = await publishedBefore(db, both, f.now);
  return { both, prior };
}

/** The shared numbers of a gap row (per event or pooled). */
function gapNumbers(pub: { n: number; k: number }, held: { n: number; k: number }, v: { versions: number; before: number }) {
  const enough = pub.n >= MIN_GAP_ATTEMPTS && held.n >= MIN_GAP_ATTEMPTS;
  return {
    public: side(pub.k, pub.n),
    held_out: side(held.k, held.n),
    gap: enough ? r3(pub.k / pub.n - held.k / held.n) : null,
    gap_ci_95: enough ? gapInterval(pub.k, pub.n, held.k, held.n) : null,
    status: enough ? ("measured" as const) : ("not_enough_bouts" as const),
    public_versions: v.versions,
    public_versions_published_before: v.before,
    public_arm: v.before === 0 ? ("fresh" as const) : v.before === v.versions ? ("previously_published" as const) : ("mixed" as const),
  };
}

/**
 * Per ranked event and model, only where the event ran held-out seeds for that model. `eventId` narrows to one event.
 * Embargoed models, events held for review and Lab arm events never appear.
 */
export async function heldOutGap(db: Db, f: { eventId?: string; now?: number } = {}): Promise<GapRow[]> {
  const { both, prior } = await gapPairs(db, { eventId: f.eventId, now: f.now ?? Date.now() });
  return both
    .map((p) => ({
      event: p.slug,
      event_name: p.eventName,
      model: p.model,
      name: modelName(p.model),
      ...gapNumbers(p.pub, p.held, prior.get(`${p.eventId}\u0000${p.model}`) ?? { versions: 0, before: 0 }),
    }))
    .sort((a, b) => a.event.localeCompare(b.event) || a.name.localeCompare(b.name));
}

export interface PooledGapRow extends Omit<GapRow, "event" | "event_name"> {
  pooled: "weekly_headline_bouts";
  /** Weekly bouts pooled for this model (each ran both public and held-out attempts). */
  events: number;
}

/**
 * The gap per model with every weekly headline bout pooled (each has only 3 attempts a side, so one bout alone never
 * reaches MIN_GAP_ATTEMPTS). Only weekly bouts that ran held-out attempts for that model count, on both sides; same
 * statistics as per event (counts summed, Wilson and Newcombe intervals).
 */
export async function weeklyPooledGap(db: Db, f: { now?: number } = {}): Promise<PooledGapRow[]> {
  const { both, prior } = await gapPairs(db, { weekly: true, now: f.now ?? Date.now() });
  const by = new Map<string, { events: number; pub: { n: number; k: number }; held: { n: number; k: number }; v: { versions: number; before: number } }>();
  for (const p of both) {
    const m = by.get(p.model) ?? { events: 0, pub: { n: 0, k: 0 }, held: { n: 0, k: 0 }, v: { versions: 0, before: 0 } };
    const v = prior.get(`${p.eventId}\u0000${p.model}`) ?? { versions: 0, before: 0 };
    m.events++;
    m.pub = { n: m.pub.n + p.pub.n, k: m.pub.k + p.pub.k };
    m.held = { n: m.held.n + p.held.n, k: m.held.k + p.held.k };
    m.v = { versions: m.v.versions + v.versions, before: m.v.before + v.before };
    by.set(p.model, m);
  }
  return [...by.entries()]
    .map(([model, m]) => ({ pooled: "weekly_headline_bouts" as const, model, name: modelName(model), events: m.events, ...gapNumbers(m.pub, m.held, m.v) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * For each (event, model) gap row: its distinct public job versions, and how many of them were in a published (public,
 * finished, not held) run of another event that finished before this event was created. Reads only gap events' runs,
 * then one pass over runs on those seeds (chunked under D1's bound-value limit).
 */
async function publishedBefore(db: Db, both: { eventId: string; eventAt: number; model: string }[], now: number) {
  const out = new Map<string, { versions: number; before: number }>();
  const events = [...new Set(both.map((p) => p.eventId))];
  if (!events.length) return out;
  const at = new Map(both.map((p) => [p.eventId, p.eventAt]));
  const played = await db
    .selectDistinct({ eventId: t.arenaRuns.eventId, model: t.arenaRuns.modelId, task: t.arenaRuns.task, seed: t.arenaRuns.seed })
    .from(t.arenaRuns)
    .where(and(inArray(t.arenaRuns.eventId, events), eq(t.arenaRuns.status, "done"), notEmbargoed(now)));
  const seeds = [...new Set(played.map((r) => r.seed))];
  const earliest = new Map<string, { eventId: string; at: number }[]>();
  for (let i = 0; i < seeds.length; i += 90) {
    const found = await db
      .select({ task: t.arenaRuns.task, seed: t.arenaRuns.seed, eventId: t.arenaRuns.eventId, at: sql<number>`min(${t.arenaRuns.finishedAt})` })
      .from(t.arenaRuns)
      .where(and(inArray(t.arenaRuns.seed, seeds.slice(i, i + 90)), eq(t.arenaRuns.status, "done"), isNotNull(t.arenaRuns.finishedAt), notEmbargoed(now)))
      .groupBy(t.arenaRuns.task, t.arenaRuns.seed, t.arenaRuns.eventId);
    for (const r of found) earliest.set(`${r.task}:${r.seed}`, [...(earliest.get(`${r.task}:${r.seed}`) ?? []), { eventId: r.eventId, at: Number(r.at) }]);
  }
  for (const r of played) {
    const k = `${r.eventId}\u0000${r.model}`;
    const o = out.get(k) ?? { versions: 0, before: 0 };
    o.versions++;
    if ((earliest.get(`${r.task}:${r.seed}`) ?? []).some((e) => e.eventId !== r.eventId && e.at < (at.get(r.eventId) ?? 0))) o.before++;
    out.set(k, o);
  }
  return out;
}

/** How the gap is counted, as data (arena_results and /arena/history JSON). */
export const GAP_METHOD = {
  unit: "attempt",
  gap: "public_pass_rate_minus_held_out_pass_rate",
  interval: "newcombe_hybrid_score_95",
  min_attempts_each_side: MIN_GAP_ATTEMPTS,
  held_out_runs_published: false,
  /** The gap tests contamination only where public_arm is "previously_published"; with "fresh" it is a control. */
  contamination_test_needs: "public_versions_published_before_the_event",
} as const;
