import { LONGITUDINAL, longitudinalPanel, SEASON, wilsonInterval } from "@forge/arena";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, newId } from "../services/db";
import { modelById } from "./lineup";
import { modelName, notEmbargoedKeepHeldOut } from "./views";

// The longitudinal panel (ADR 0058, D7): the same frozen held-out Normal job versions (12 bouts, one attempt each) re-run
// on every new model version, so pass rates can be compared across versions over time. The panel is held out, so only
// aggregates are ever shown (/arena/history); no run is published.
//
// Queued by an admin (/admin/arena-panel) or by a session writing model ids to KV `arena:panel`; the normal runner
// plays the bouts (same harness, pinned provider, the monthly OpenRouter cap and the headline Workers AI allowance).
// Never queued automatically: every queueing is a person's decision to spend.

export const PANEL_KV = "arena:panel";
/** At most this many panel queueings start in one calendar month (UTC): at most 4 × 12 = 48 Normal bouts. */
export const PANEL_MAX_PER_MONTH = 4;

export type QueueOutcome =
  | { ok: true; model: string; event: string; bouts: number; pinned_model: string; provider: string }
  | { ok: false; model: string; reason: "unknown_model" | "retired_model" | "no_panel" | "already_queued" | "monthly_limit" | "over_cap" };

const monthStart = (now: number) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
const pinOf = (m: NonNullable<ReturnType<typeof modelById>>) => (m.route.kind === "openrouter" ? { pinned: m.route.model, provider: m.route.provider } : { pinned: m.route.model, provider: "cloudflare-workers-ai" });

/**
 * Queues the panel for one lineup model: one event (kind "guest", every run held out) and one `arena_panel` row with the
 * pinned model string and provider. Refused for an unknown or retired model, a version already queued on this panel,
 * the monthly limit, or a panel over the hard cap.
 */
export async function queuePanel(env: Env, modelId: string, queuedBy: string, now = Date.now()): Promise<QueueOutcome> {
  const model = modelById(modelId);
  if (!model) return { ok: false, model: modelId, reason: "unknown_model" };
  if (model.retired) return { ok: false, model: modelId, reason: "retired_model" };
  const panel = longitudinalPanel();
  if (!panel.length) return { ok: false, model: modelId, reason: "no_panel" };
  const bouts = panel.length * LONGITUDINAL.attempts;
  if (bouts > LONGITUDINAL.maxBoutsPerModel) return { ok: false, model: modelId, reason: "over_cap" };
  const db = getDb(env);
  const { pinned, provider } = pinOf(model);
  const [dupe] = await db
    .select({ id: t.arenaPanel.id })
    .from(t.arenaPanel)
    .where(and(eq(t.arenaPanel.modelId, modelId), eq(t.arenaPanel.pinnedModel, pinned), eq(t.arenaPanel.provider, provider), eq(t.arenaPanel.panelVersion, LONGITUDINAL.version)));
  if (dupe) return { ok: false, model: modelId, reason: "already_queued" };
  const [month] = await db.select({ n: sql<number>`count(*)` }).from(t.arenaPanel).where(gte(t.arenaPanel.createdAt, monthStart(now)));
  if ((month?.n ?? 0) >= PANEL_MAX_PER_MONTH) return { ok: false, model: modelId, reason: "monthly_limit" };

  const eventId = newId();
  const day = new Date(now).toISOString().slice(0, 10);
  const slug = `panel-${LONGITUDINAL.version}-${modelId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${day}`.slice(0, 64);
  const runs = panel.flatMap(({ task, seed }) =>
    Array.from({ length: LONGITUDINAL.attempts }, (_, i) => ({ id: newId(), eventId, modelId, task, seed, attemptNo: i + 1, status: "queued" as const, heldOut: true })),
  );
  // The checks above are a fast path only. Two clicks, or the cron and an admin at once, can both pass them, so the
  // batch (one D1 transaction) checks again: the event row is inserted only while this version isn't on the panel and the
  // month is under its limit. If it isn't inserted, the panel row and the runs that reference it fail their foreign key
  // and the whole batch rolls back, so nothing is queued.
  const name = `Longitudinal panel ${LONGITUDINAL.version}: ${model.name}, ${day}`;
  const statements = [
    // Insert-select fills every arena_events column in table order: id, slug, name, season, kind, status, twist, arm, created_at.
    db.insert(t.arenaEvents).select(
      sql`select ${eventId}, ${slug}, ${name}, ${SEASON.id}, 'guest', 'running', null, null, ${now}
        where (select count(*) from arena_panel where created_at >= ${monthStart(now)}) < ${PANEL_MAX_PER_MONTH}
          and not exists (select 1 from arena_panel where model_id = ${modelId} and pinned_model = ${pinned} and provider = ${provider} and panel_version = ${LONGITUDINAL.version})`,
    ),
    db.insert(t.arenaPanel).values({ id: newId(), eventId, modelId, pinnedModel: pinned, provider, panelVersion: LONGITUDINAL.version, bouts, queuedBy: queuedBy.slice(0, 80), createdAt: now }),
  ];
  // One more bound value than a normal run row (held_out), so 9 rows to a statement (D1's 100-value limit).
  for (let i = 0; i < runs.length; i += 9) statements.push(db.insert(t.arenaRuns).values(runs.slice(i, i + 9)) as never);
  const [first, ...rest] = statements;
  try {
    await db.batch([first!, ...rest]);
  } catch (e) {
    // Lost a race (or the same slug today): say why from what is now stored, never queue twice.
    const [again] = await db
      .select({ id: t.arenaPanel.id })
      .from(t.arenaPanel)
      .where(and(eq(t.arenaPanel.modelId, modelId), eq(t.arenaPanel.pinnedModel, pinned), eq(t.arenaPanel.provider, provider), eq(t.arenaPanel.panelVersion, LONGITUDINAL.version)));
    if (again) return { ok: false, model: modelId, reason: "already_queued" };
    const [m] = await db.select({ n: sql<number>`count(*)` }).from(t.arenaPanel).where(gte(t.arenaPanel.createdAt, monthStart(now)));
    if ((m?.n ?? 0) >= PANEL_MAX_PER_MONTH) return { ok: false, model: modelId, reason: "monthly_limit" };
    throw e;
  }
  return { ok: true, model: modelId, event: slug, bouts, pinned_model: pinned, provider };
}

/** Reads KV `arena:panel` (a model id or a list of up to 10), queues each, and clears the key. */
export async function queuePanelsFromKv(env: Env, now = Date.now()) {
  const raw = await env.KV.get(PANEL_KV, "json").catch(() => null);
  await env.KV.delete(PANEL_KV);
  const ids = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64).slice(0, 10);
  const out: QueueOutcome[] = [];
  for (const id of ids) out.push(await queuePanel(env, id, "kv", now));
  return out;
}

export interface PanelPoint {
  model: string;
  name: string;
  pinned_model: string;
  provider: string;
  /** Model strings the provider reported serving during these bouts. */
  served_versions: string[];
  panel_version: string;
  queued_at: string;
  /** First and last day a panel bout finished (null until one has). */
  first_run: string | null;
  last_run: string | null;
  bouts_planned: number;
  bouts_done: number;
  passes: number;
  pass_rate: number | null;
  ci_95: [number, number] | null;
  status: "complete" | "in_progress" | "not_started";
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/** Every panel queueing with its aggregate result, oldest first. Embargoed models and held events never appear. */
export async function panelHistory(db: ReturnType<typeof getDb>, now = Date.now()): Promise<PanelPoint[]> {
  const entries = await db.select().from(t.arenaPanel).orderBy(asc(t.arenaPanel.createdAt));
  if (!entries.length) return [];
  const rows = await db
    .select({
      eventId: t.arenaRuns.eventId,
      done: sql<number>`sum(case when ${t.arenaRuns.status} = 'done' then 1 else 0 end)`,
      passes: sql<number>`sum(case when ${t.arenaRuns.status} = 'done' and ${t.arenaRuns.passed} = 1 then 1 else 0 end)`,
      first: sql<number | null>`min(${t.arenaRuns.finishedAt})`,
      last: sql<number | null>`max(${t.arenaRuns.finishedAt})`,
      served: sql<string | null>`group_concat(distinct ${t.arenaRuns.modelVersion})`,
    })
    .from(t.arenaRuns)
    .where(and(inArray(t.arenaRuns.eventId, entries.map((e) => e.eventId)), notEmbargoedKeepHeldOut(now)))
    .groupBy(t.arenaRuns.eventId);
  const by = new Map(rows.map((r) => [r.eventId, r]));
  return entries
    .filter((e) => by.has(e.eventId))
    .map((e) => {
      const r = by.get(e.eventId)!;
      const done = Number(r.done ?? 0);
      const passes = Number(r.passes ?? 0);
      return {
        model: e.modelId,
        name: modelName(e.modelId),
        pinned_model: e.pinnedModel,
        provider: e.provider,
        served_versions: (r.served ?? "").split(",").filter(Boolean).sort(),
        panel_version: e.panelVersion,
        queued_at: iso(e.createdAt)!,
        first_run: iso(r.first),
        last_run: iso(r.last),
        bouts_planned: e.bouts,
        bouts_done: done,
        passes,
        pass_rate: done ? Math.round((passes / done) * 1000) / 1000 : null,
        ci_95: done ? wilsonInterval(passes, done) : null,
        status: done >= e.bouts ? "complete" : done ? "in_progress" : "not_started",
      } satisfies PanelPoint;
    });
}
