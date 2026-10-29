import { CANARY, HARD3_2_TASKS, HARD3_TASKS, HARD_TASKS, publicTrapId, rulesVersionAt, summarize, taskVersion, TASKS, wilsonInterval, type AttemptResult } from "@forge/arena";
import type * as t from "../db/schema";
import type { Db } from "../services/db";
import { csvCell } from "./business";
import { rulesFields } from "./rules-label";
import { LICENCE_ID, LICENCE_PATH, runProvenance, type Provenance } from "../services/provenance";
import { GAP_METHOD, heldOutGap, weeklyPooledGap } from "./holdout";
import { consistency, DATASET_LICENCE, finishedRuns, isKnockout, isRankedEvent, modelName, publicEvent, tierOf, type Tier } from "./views";

// Arena results for agents and crawlers (AGENTS.md rule 7: numbers, enums, ids and links only):
// - `arenaResults`: the data behind the public MCP tool arena_results, per job and model, for a tier or one event.
// - `eventData` / `eventCsv`: one ranked event's attempts, served at /arena/events/<slug>.json and .csv.
// Every run comes through `finishedRuns`, so embargoed models (ADR 0041), events held for review, fixtures before their
// premiere and Lab #3 arms never appear.

/** Every task in catalog order: Normal, Hard v2, Hard v3, Hard v3.2. A tier or event lists only jobs with runs. */
export const ALL_TASKS = [...TASKS, ...HARD_TASKS, ...HARD3_TASKS, ...HARD3_2_TASKS];
const ORDER = new Map(ALL_TASKS.map((x, i) => [x.id, i]));

export type Run = Awaited<ReturnType<typeof finishedRuns>>[number];
type Event = typeof t.arenaEvents.$inferSelect;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** The public trap ids (FA-*) the referee marked sprung in one attempt, once each. */
export const trapsFell = (task: string, result: AttemptResult | null | undefined) =>
  uniq((result?.traps ?? []).filter((x) => x.triggered).map((x) => publicTrapId(task, x.id) ?? `${task}/${x.id}`));

/** How the figures are counted, as data. */
export const RESULTS_METHOD = {
  unit: "attempt",
  interval: "wilson_95_passes_div_attempts",
  consistency: "task_seed_groups_with_every_attempt_passed",
  traps_fell: "trap_marked_triggered_by_referee",
  knockout: "attempt_ended_by_stamina_limit",
} as const;

/** Rules versions, task versions and the first and last day of a set of runs. */
export function versionsAndDates(runs: Run[]) {
  const times = runs.map((r) => r.summary.finishedAt);
  return {
    rules_versions: uniq(runs.map((r) => rulesVersionAt(r.summary.finishedAt, r.result))).sort(),
    task_versions: uniq(runs.map((r) => taskVersion(r.summary.task, r.summary.finishedAt))).sort(),
    since: times.length ? day(Math.min(...times)) : null,
    as_of: times.length ? day(Math.max(...times)) : null,
  };
}

/** One model on one job. `rs` is newest first; the replays are the latest fail and the latest pass when both exist. */
export function modelRow(model: string, rs: Run[], origin: string) {
  const s = summarize(rs.map((r) => r.result));
  const c = consistency(rs.map((r) => r.summary));
  const fell = new Map<string, number>();
  for (const r of rs) for (const id of trapsFell(r.summary.task, r.result)) fell.set(id, (fell.get(id) ?? 0) + 1);
  const first = rs.find((r) => !r.summary.passed) ?? rs[0];
  const second = rs.find((r) => r !== first && r.summary.passed !== first?.summary.passed) ?? rs.find((r) => r !== first);
  return {
    model,
    name: modelName(model),
    runs: s.runs,
    passes: c.passes,
    pass_rate: s.passRate,
    ci_95: wilsonInterval(c.passes, c.attempts),
    consistency: { all_right: c.allRight, versions: c.groups, reliable: c.reliable },
    traps_avoided: s.trapResistance,
    traps_fell: [...fell.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, n]) => ({ id, n })),
    knockouts: rs.filter((r) => isKnockout(r.result)).length,
    cost_per_pass_usd: Number.isFinite(s.costOfPass) ? s.costOfPass : null,
    status: s.status,
    replays: [first, second].filter((r): r is Run => !!r).map((r) => `${origin}/arena/run/${r.summary.id}`),
  };
}

export interface ResultsFilter {
  task?: string;
  /** Normal if omitted, unless an event is given: then every tier of that event. A task sets its own tier. */
  tier?: Tier;
  /** A public event (from `publicEvent`): only its runs. */
  event?: Event | null;
}

/**
 * Per job and model: attempts, passes, pass rate with its 95% Wilson interval, 3-of-3 consistency, trap ids fallen for,
 * knockouts and replays. Without an event: headline (card and guest) runs if any exist for the tier, else practice.
 */
export async function arenaResults(db: Db, f: ResultsFilter = {}, origin = "") {
  const tier: Tier | null = f.task ? tierOf(f.task) : (f.tier ?? (f.event ? null : "normal"));
  let runs: Run[];
  let kind: "headline" | "practice";
  if (f.event) {
    runs = await finishedRuns(db, { eventId: f.event.id, task: f.task });
    kind = f.event.kind === "practice" ? "practice" : "headline";
  } else {
    const q = { task: f.task, ...(tier === "hard" ? { tier: "hard" as const } : {}) };
    const headline = await finishedRuns(db, { kinds: ["card", "guest"], ...q });
    runs = headline.length ? headline : await finishedRuns(db, { kinds: ["practice"], ...q });
    kind = headline.length ? "headline" : "practice";
  }
  runs = runs.filter((r) => !tier || tierOf(r.summary.task) === tier);
  // The Normal card lists its six jobs even before they have runs (as it always has); a tier or event lists jobs with runs.
  const listAll = tier === "normal" && !f.event;
  const tasks = (listAll ? TASKS : ALL_TASKS).filter((x) => (!f.task || x.id === f.task) && (listAll || runs.some((r) => r.summary.task === x.id)));
  // ADR 0058: public-vs-held-out pass rates per model, for this event or every ranked event that ran held-out seeds.
  const [gap, pooled] = await Promise.all([heldOutGap(db, { eventId: f.event?.id }), weeklyPooledGap(db)]);
  return {
    data_kind: !runs.length ? "none" : kind,
    tier: tier ?? "all",
    event: f.event ? { slug: f.event.slug, name: f.event.name, kind: f.event.kind, url: `${origin}/arena/event/${f.event.slug}`, ...(isRankedEvent(f.event) ? { data_url: `${origin}/arena/events/${f.event.slug}.json` } : {}) } : null,
    ...versionsAndDates(runs),
    method: RESULTS_METHOD,
    tasks: tasks.map((x) => {
      const by = new Map<string, Run[]>();
      for (const r of runs.filter((r) => r.summary.task === x.id)) by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r]);
      return {
        task: x.id,
        title: x.title,
        tier: tierOf(x.id),
        guide_url: `${origin}/best/${x.id}`,
        models: [...by.entries()].map(([model, rs]) => modelRow(model, rs, origin)).sort((a, b) => b.pass_rate - a.pass_rate || a.name.localeCompare(b.name)),
      };
    }),
    held_out_gap: {
      status: [...gap, ...pooled].some((g) => g.status === "measured") ? "measured" : gap.length || pooled.length ? "not_enough_bouts" : "not_yet_measured",
      method: GAP_METHOD,
      rows: gap,
      // Every weekly headline bout pooled per model (3 attempts a side each, too few alone), whatever the filter.
      weekly_pooled: { label: "weekly bouts pooled", rows: pooled },
      url: `${origin}/arena/history#gap`,
    },
  };
}

export type ArenaResults = Awaited<ReturnType<typeof arenaResults>>;

/**
 * One ranked event's attempts, for /arena/events/<slug>.json and .csv: no logs and no model output, only the referee's
 * verdict per attempt. Null (a 404) for an unknown event, one held for review, or one that isn't ranked.
 */
export async function eventData(db: Db, slug: string, origin = "") {
  const event = await publicEvent(db, slug);
  if (!event || !isRankedEvent(event)) return null;
  const runs = await finishedRuns(db, { eventId: event.id });
  const rows = runs
    .map((r) => {
      const s = r.summary;
      return {
        run: s.id,
        model: s.model,
        model_name: modelName(s.model),
        task: s.task,
        tier: tierOf(s.task),
        seed: s.seed,
        attempt: s.attempt,
        passed: s.passed,
        reason: r.result?.reason ?? null,
        traps_fell: trapsFell(s.task, r.result),
        knockout: isKnockout(r.result),
        replay_url: `${origin}/arena/run/${s.id}`,
        ...rulesFields(s.finishedAt, r.result),
        task_version: taskVersion(s.task, s.finishedAt),
        finished_at: new Date(s.finishedAt).toISOString(),
        provenance: runProvenance(s),
      };
    })
    .sort((a, b) => (ORDER.get(a.task) ?? 99) - (ORDER.get(b.task) ?? 99) || a.model.localeCompare(b.model) || a.seed - b.seed || a.attempt - b.attempt);
  return {
    canary: CANARY,
    event: { slug: event.slug, name: event.name, kind: event.kind, season: event.season, page: `${origin}/arena/event/${event.slug}`, csv: `${origin}/arena/events/${event.slug}.csv` },
    licence: DATASET_LICENCE,
    licence_id: LICENCE_ID,
    licence_url: `${origin}${LICENCE_PATH}`,
    ...versionsAndDates(runs),
    attempts: rows.length,
    models: uniq(rows.map((r) => r.model)).sort(),
    tasks: uniq(rows.map((r) => r.task)),
    runs: rows,
  };
}

export type EventData = NonNullable<Awaited<ReturnType<typeof eventData>>>;

export const EVENT_CSV_HEADER = "event,run,model,model_name,task,tier,seed,attempt,passed,reason,traps_fell,knockout,replay_url,rules_version,task_version,finished_at,source,model_exact,model_maker,served_by,terms_version,privacy_version,licence,canary";

/** One row per attempt; trap ids are joined with ";". The last column is the canary line (ADR 0058) on every row. */
export function eventCsv(d: EventData) {
  const lines = d.runs.map((r) =>
    [d.event.slug, r.run, r.model, r.model_name, r.task, r.tier, r.seed, r.attempt, r.passed, r.reason, r.traps_fell.join(";"), r.knockout, r.replay_url, r.rules_version, r.task_version, r.finished_at, ...provenanceCells(r.provenance), CANARY].map(csvCell).join(","),
  );
  return `${[EVENT_CSV_HEADER, ...lines].join("\n")}\n`;
}

/** The provenance columns at the end of each CSV row (ADR 0053). */
const provenanceCells = (p: Provenance) => [p.source, p.model?.exact ?? null, p.model?.maker ?? null, p.model?.served_by ?? null, p.terms_version, p.privacy_version, p.licence];

/** schema.org Dataset markup for a ranked event's page (search engines and dataset crawlers). */
export function eventDatasetLd(d: EventData, origin: string) {
  const last = d.runs.reduce((m, r) => (r.finished_at > m ? r.finished_at : m), "");
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${d.event.name}: refereed Arena results`,
    description: `Every refereed attempt in ${d.event.name} on The Forge Arena (${d.attempts} attempts, ${d.models.length} models, ${d.tasks.length} jobs): model, job, attempt, pass or fail, end reason, planted trap ids sprung, knockouts, rules version and a replay link for each.`,
    url: `${origin}/arena/event/${d.event.slug}`,
    ...(last ? { dateModified: last } : {}),
    ...(d.since && d.as_of ? { temporalCoverage: `${d.since}/${d.as_of}` } : {}),
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "The Agent Forge", url: origin },
    license: { "@type": "CreativeWork", name: DATASET_LICENCE, url: `${origin}${LICENCE_PATH}` },
    distribution: [
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${origin}/arena/events/${d.event.slug}.json` },
      { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `${origin}/arena/events/${d.event.slug}.csv` },
    ],
  };
}
