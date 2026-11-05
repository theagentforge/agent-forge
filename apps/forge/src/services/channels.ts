import { and, gte, like, lte, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import channelsFile from "../ops/channels.json";
import { clientKinds } from "./agent-funnel";
import { SKILL_TAG_PREFIX, SPRINT_SHARE_FROM, startedViaKey } from "./channel-tags";
import { getDb } from "./db";
import { ID_CLIENTS } from "./install-ids";
import type { InstallClient } from "./install-metrics";

// ADR 0133 (build plan 5 Nov, P2 items 8, 10, 11): three admin-only measures of agent awareness, all from the daily
// counters (usage_daily) and the install-ID table, never from a guess:
//   8. the channel scoreboard: per listing or surface, this week's attributable outside use and its review (kill) date;
//   10. the Sprint share loop: runs started from a Sprint result page per outside Sprint finished (a k-factor);
//   11. ClawHub install → use: calls our skills tag with ?client=, beside ClawHub's own download count.
// What isn't attributable says "not measurable". Bots are already out of every input (ADR 0124): MCP directory and
// monitor clients by name (agent-funnel.ts clientKind), crawlers and fake browsers on pages and REST, our own tagged
// callers and House everywhere.

export type SignalSpec =
  | { type: "mcp_client"; match: string }
  | { type: "install"; client: InstallClient }
  | { type: "counter"; prefix: string; what: "calls" | "arrivals" }
  | { type: "arrivals"; label: string };

export interface ExternalReading {
  date: string;
  value: number;
  unit: string;
  source: string;
}

export interface ChannelSpec {
  id: string;
  name: string;
  kind: string;
  status: string;
  listed: string | null;
  review: string | null;
  signals: SignalSpec[];
  external?: ExternalReading[];
  note?: string;
  /**
   * ADR 0133 review: the first full UTC day the channel's use signal was live (a new tag needs a production release
   * and, for a skill, the tagged version on the listing). Absent: live for the whole scoreboard span. null: not live
   * yet, so the channel reads "not yet measured" and can't be stopped for having no use.
   */
  counted_from?: string | null;
}

export const CHANNELS = channelsFile as { version: number; updated: string; channels: ChannelSpec[] };

export type Row = { day: string; key: string; n: number | string };
export type IdRow = { client: string; firstDay: string; ours: boolean | number };

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shift = (d: string, n: number) => isoDay(Date.parse(`${d}T00:00:00Z`) + n * DAY);
/** The first day the scoreboard reads (the counters behind it all exist from October 2026). */
export const SCOREBOARD_FROM = "2026-10-01";

/** A channel is measurable when at least one signal can show outside use (a call or an install check). */
export const measurable = (c: Pick<ChannelSpec, "signals">) => c.signals.some((s) => s.type === "mcp_client" || s.type === "install" || (s.type === "counter" && s.what === "calls"));

export type Decision = "not measurable" | "not yet measured" | "no review date" | "watching" | "stop" | "keep";
/** The kill rule needs four full weeks of counting: a channel counted for less is still watching after its review date. */
export const MIN_COUNTED_DAYS = 28;
export const DECISION_RULE =
  "On or after its review date, a channel with no attributable outside use since it was listed (no named outside tool call, no outside install check, no tagged call) is marked stop and gets no more effort; one with any use is kept. Before the date, or until its use signal has been counted for 28 full days, it is watching; a channel whose use signal isn't live yet (a tag waiting for a release) is not yet measured. Sessions and page arrivals are shown but are not use. Channels whose use the Worker can't see are not measurable and are decided by hand.";

interface Measures {
  calls: number;
  install_checks: number;
  sessions: number;
  arrivals: number;
}
const zero = (): Measures => ({ calls: 0, install_checks: 0, sessions: 0, arrivals: 0 });

/** Per-day measures of one channel's signals, from the rows; `kinds` says which MCP client names are agents. */
function dailyMeasures(c: ChannelSpec, rows: Row[], kinds: Map<string, string>) {
  const out = new Map<string, Measures>();
  const at = (d: string) => out.get(d) ?? (out.set(d, zero()), out.get(d)!);
  for (const s of c.signals) {
    if (s.type === "mcp_client") {
      const re = new RegExp(s.match);
      for (const r of rows) {
        const m = /^mcp:client(call)?:(.+)$/.exec(r.key);
        if (!m || !re.test(m[2]!) || kinds.get(m[2]!) !== "agent") continue;
        if (m[1]) at(r.day).calls += Number(r.n);
        else at(r.day).sessions += Number(r.n);
      }
    } else if (s.type === "install") {
      for (const r of rows) {
        if (r.key === `install:checked:${s.client}`) at(r.day).install_checks += Number(r.n);
        if (r.key === `install:ours:checked:${s.client}`) at(r.day).install_checks -= Number(r.n);
      }
    } else if (s.type === "counter") {
      for (const r of rows) if (r.key.startsWith(s.prefix)) at(r.day)[s.what] += Number(r.n);
    } else if (s.type === "arrivals") {
      for (const r of rows) if (r.key === `visit:dir:${s.label}`) at(r.day).arrivals += Number(r.n);
    }
  }
  return out;
}

const sum = (m: Map<string, Measures>, from: string, to: string) => {
  const s = zero();
  for (const [d, v] of m) if (d >= from && d <= to) for (const k of Object.keys(s) as (keyof Measures)[]) s[k] += v[k];
  return s;
};

export interface ScoreRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  listed: string | null;
  review: string | null;
  /** The first day with attributable outside use (a named call, install check or tagged call); null when none yet. */
  first_seen: string | null;
  measurable: boolean;
  /** The first day the use signal was counted (counted_from, or the scoreboard's start); null when not live yet. */
  counted_from: string | null;
  /** This week: the 7 full UTC days to as_of. Null where the channel has no signal of that kind, or it isn't live yet. */
  week: { calls: number | null; install_checks: number | null; new_installs: number | null; sessions: number | null; arrivals: number | null };
  /** Calls plus install checks since the channel was listed (or the 4 weeks to its review date when it has none). */
  use_since_listed: number | null;
  /** The week fields that are null only because their counter isn't live yet (shown as "not yet measured"). */
  not_yet: (keyof ScoreRow["week"])[];
  decision: Decision;
  days_to_review: number | null;
  external: ExternalReading[];
  note: string | null;
}

/** The scoreboard (pure; tested on fixtures). `rows` cover SCOREBOARD_FROM..asOf; `ids` are outside install IDs. */
export function scoreboard(channels: ChannelSpec[], rows: Row[], ids: IdRow[], asOf: string): ScoreRow[] {
  const weekFrom = shift(asOf, -6);
  // Which client names are agents: the trailing 7 days for this week's numbers, and the whole span for first-seen and
  // use since listing (a name with no named call in the span is a monitor, never use).
  const weekKinds = clientKinds(rows.filter((r) => r.day >= weekFrom && r.day <= asOf));
  const spanKinds = clientKinds(rows.filter((r) => r.day <= asOf));
  // Listing-site arrivals (visit:dir:*) started with ADR 0133: until the first one is counted anywhere, none are shown.
  const dirLive = rows.some((r) => r.key.startsWith("visit:dir:") && r.day <= asOf);
  return channels.map((c) => {
    const has = (type: SignalSpec["type"], what?: string) => c.signals.some((s) => s.type === type && (!what || (s.type === "counter" && s.what === what)));
    const week = sum(dailyMeasures(c, rows, weekKinds), weekFrom, asOf);
    const span = dailyMeasures(c, rows, spanKinds);
    const idClients = c.signals.filter((s): s is Extract<SignalSpec, { type: "install" }> => s.type === "install" && (ID_CLIENTS as readonly string[]).includes(s.client)).map((s) => s.client as string);
    const newInstalls = idClients.length ? ids.filter((i) => !i.ours && idClients.includes(i.client) && i.firstDay >= weekFrom && i.firstDay <= asOf).length : null;
    const useDays = [...span].filter(([d, v]) => d <= asOf && v.calls + v.install_checks > 0).map(([d]) => d);
    const idDays = ids.filter((i) => !i.ours && idClients.includes(i.client) && i.firstDay <= asOf).map((i) => i.firstDay);
    const firstSeen = [...useDays, ...idDays].sort()[0] ?? null;
    const ok = measurable(c);
    const countedFrom = c.counted_from === undefined ? SCOREBOARD_FROM : c.counted_from;
    const live = countedFrom !== null && countedFrom <= asOf;
    const listedFrom = c.listed ?? (c.review ? shift(c.review, -28) : SCOREBOARD_FROM);
    const since = live && countedFrom > listedFrom ? countedFrom : listedFrom;
    const total = sum(span, since, asOf);
    const use = ok && live ? total.calls + total.install_checks : null;
    const countedLongEnough = live && asOf >= shift(countedFrom, MIN_COUNTED_DAYS - 1);
    const decision: Decision = !ok ? "not measurable" : !live ? "not yet measured" : !c.review ? "no review date" : asOf < c.review ? "watching" : use! > 0 ? "keep" : countedLongEnough ? "stop" : "watching";
    const daysTo = c.review ? Math.round((Date.parse(`${c.review}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY) : null;
    const useCell = (v: number) => (ok && !live ? null : v);
    const calls = has("mcp_client") || has("counter", "calls") ? useCell(week.calls) : null;
    const notYet: (keyof ScoreRow["week"])[] = [];
    if (ok && !live) {
      if (has("mcp_client") || has("counter", "calls")) notYet.push("calls");
      if (has("install")) notYet.push("install_checks");
      if (newInstalls !== null) notYet.push("new_installs");
    }
    if (has("arrivals") && !has("counter", "arrivals") && !dirLive) notYet.push("arrivals");
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      status: c.status,
      listed: c.listed,
      review: c.review,
      first_seen: ok && !live ? null : firstSeen,
      measurable: ok,
      counted_from: ok && !live ? null : countedFrom,
      week: {
        calls,
        install_checks: has("install") ? useCell(week.install_checks) : null,
        new_installs: newInstalls === null ? null : useCell(newInstalls),
        sessions: has("mcp_client") ? week.sessions : null,
        arrivals: has("counter", "arrivals") || (has("arrivals") && dirLive) ? week.arrivals : null,
      },
      use_since_listed: use,
      not_yet: notYet,
      decision,
      days_to_review: daysTo,
      external: c.external ?? [],
      note: c.note ?? null,
    };
  });
}

/** Item 10: the Sprint share loop, from its counters (pure). */
export const SHARE_LOOP_METHOD =
  "k = outside runs started from a Sprint result page's own commands (the Gauntlet MCP address or HTTP start carrying ?from=sprint-result) ÷ outside Sprints finished (the House agent's and our own probes' Sprints are counted apart), over the same full UTC days. Each finished Sprint is a share link; a run started from a result page is a new run that came from one. Arrivals are people who opened a share link tagged ?from=sprint-share (bots, our probes and our own pages' links not counted). Limits: a person who added the Gauntlet server from a result page and runs again later is counted again (an upper bound); someone who opens a shared result and then uses the untagged /gauntlet/sprint commands is not counted (a lower bound). No person or run is linked to another: daily totals only.";

export function shareLoop(rows: Row[], asOf: string, days = 7) {
  const from = shift(asOf, -(days - 1));
  const seen = (k: string) => rows.some((r) => r.key === k);
  const get = (k: string) => rows.filter((r) => r.key === k && r.day >= from && r.day <= asOf).reduce((a, r) => a + Number(r.n), 0);
  const viaKeys = [startedViaKey("sprint"), startedViaKey("full")];
  const arrivalsKey = `visit:tag:${SPRINT_SHARE_FROM}`;
  const measuredSince = rows.filter((r) => [...viaKeys, arrivalsKey].includes(r.key)).map((r) => r.day).sort()[0] ?? null;
  const finished = get("sprint:finished");
  const viaSprint = get(viaKeys[0]!);
  const viaFull = get(viaKeys[1]!);
  const measured = measuredSince !== null;
  return {
    window: { from, to: asOf, days },
    measured_since: measuredSince,
    share_link_arrivals: seen(arrivalsKey) ? get(arrivalsKey) : null,
    sprints_finished_outside: finished,
    runs_from_result_page: measured ? { sprint: viaSprint, full: viaFull } : null,
    k: measured && finished > 0 ? Math.round(((viaSprint + viaFull) / finished) * 1000) / 1000 : null,
    method: SHARE_LOOP_METHOD,
  };
}

/** Item 11: calls tagged by our skills, per skill version and endpoint, beside ClawHub's own download readings. */
export const SKILL_USE_METHOD =
  "Calls carrying ?client=<skill>-<version> (skills 1.1.0+ of forge-check-before-install and 1.2.0+ of forge-run-the-gauntlet), counted on /api/v1/check, /api/v1/scan and Gauntlet starts; crawlers, fake browsers and our own tagged callers are left out. ClawHub, skills.sh and /.well-known/agent-skills serve the same file, so these are calls by the skill from any of them: an upper bound for ClawHub alone. Downloads are ClawHub's own count, read by hand (date and source given). Checks per download is shown only for a reading whose 7 days the tag was already counting.";

export function skillUse(rows: Row[], asOf: string, readings: ExternalReading[]) {
  const weekFrom = shift(asOf, -6);
  const tagged = rows.filter((r) => r.key.startsWith(SKILL_TAG_PREFIX));
  const measuredSince = tagged.map((r) => r.day).sort()[0] ?? null;
  const byKey = new Map<string, { week: number; all: number }>();
  for (const r of tagged) {
    const e = byKey.get(r.key) ?? { week: 0, all: 0 };
    e.all += Number(r.n);
    if (r.day >= weekFrom && r.day <= asOf) e.week += Number(r.n);
    byKey.set(r.key, e);
  }
  const lines = [...byKey]
    .map(([key, v]) => {
      const m = /^skilltag:([a-z-]+)@([\d.]+):([a-z-]+)$/.exec(key);
      return { skill: m?.[1] ?? key, version: m?.[2] ?? "", endpoint: m?.[3] ?? "", week: v.week, all_time: v.all };
    })
    .sort((a, b) => a.skill.localeCompare(b.skill) || a.version.localeCompare(b.version) || a.endpoint.localeCompare(b.endpoint));
  const checksIn = (to: string) =>
    tagged.filter((r) => r.key.startsWith(`${SKILL_TAG_PREFIX}forge-check-before-install@`) && r.day >= shift(to, -6) && r.day <= to).reduce((a, r) => a + Number(r.n), 0);
  const perDownload = readings.map((x) => {
    const covered = measuredSince !== null && measuredSince <= shift(x.date, -6);
    return { ...x, tagged_calls_same_week: covered ? checksIn(x.date) : null, calls_per_download: covered && x.value > 0 ? Math.round((checksIn(x.date) / x.value) * 1000) / 1000 : null };
  });
  return { as_of: asOf, measured_since: measuredSince, lines, downloads: perDownload, method: SKILL_USE_METHOD };
}

/** The counter rows the three measures read. */
const PREFIXES = ["mcp:client:", "mcp:clientcall:", "install:", SKILL_TAG_PREFIX, "a2a:skill:", "agentverse:", "visit:dir:", "visit:src:", "sprint:", "gauntlet:started_via:", `visit:tag:${SPRINT_SHARE_FROM}`];

export async function channelData(env: Env, now = Date.now()) {
  const db = getDb(env);
  const asOf = isoDay(now - DAY);
  const rows = (await db
    .select({ day: t.usageDaily.day, key: t.usageDaily.key, n: t.usageDaily.n })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, SCOREBOARD_FROM), lte(t.usageDaily.day, asOf), or(...PREFIXES.map((p) => like(t.usageDaily.key, `${p}%`)))))) as Row[];
  const ids = (await db
    .select({ client: t.installIds.client, firstDay: t.installIds.firstDay, ours: t.installIds.ours })
    .from(t.installIds)
    .where(and(gte(t.installIds.firstDay, SCOREBOARD_FROM), sql`${t.installIds.ours} = 0`))) as IdRow[];
  const clawhub = CHANNELS.channels.find((c) => c.id === "clawhub-check-before-install");
  return {
    as_of: asOf,
    list: { version: CHANNELS.version, updated: CHANNELS.updated, file: "apps/forge/src/ops/channels.json" },
    rule: DECISION_RULE,
    channels: scoreboard(CHANNELS.channels, rows, ids, asOf),
    share_loop: { week: shareLoop(rows, asOf, 7), four_weeks: shareLoop(rows, asOf, 28) },
    skill_use: skillUse(rows, asOf, clawhub?.external ?? []),
  };
}
