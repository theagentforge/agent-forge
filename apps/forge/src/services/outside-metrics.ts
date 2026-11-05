import { and, eq, gte, lte, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { agentFunnel, outsidePeople } from "./agent-funnel";
import { getDb } from "./db";
import { ownerActivity } from "./owners";

// ADR 0126 (build list item 15): one block of outside-only numbers for /stats and /stats.json, the page an acquirer
// reads first. Each number carries its definition, its date range and what it leaves out, so it can be checked.
// Our own traffic is left out the way the internal KPIs already split it: tagged tests and probes (internal:*), House
// and founder accounts, our install IDs (HOUSE_INSTALL_IDS mark them ours), and directory, catalogue, checker and
// monitor clients (services/agent-funnel.ts). Real numbers, however small; nothing is rounded or floored.
//
// Off by default: Dinike's ruling of 28 Oct (ADR 0082, F-02) keeps outside-only numbers off public pages. The block is
// shown only when PUBLIC_METRICS is "on"; until then it is an admin preview (/admin/kpis, third-party.json).

/** True when the outside-use block is public (PUBLIC_METRICS "on"; anything else, or unset, is off). */
export const publicMetricsOn = (env: Pick<Env, "PUBLIC_METRICS">) => (env.PUBLIC_METRICS ?? "").trim().toLowerCase() === "on";

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Days whose counters are missing or partial. Lean mode (ADR 0027) stopped every usage counter, check source and
 * install ID write from 1 Nov until it was switched off on 4 Nov 2026 (ADR 0124 now keeps metric writes on in lean mode).
 */
export const COUNTER_GAPS = [
  { from: "2026-11-01", to: "2026-11-04", note: "Lean mode stopped the usage counters, check sources and install IDs from 1 to 4 Nov 2026, so those days are missing or partial." },
] as const;

/** Install IDs were first recorded with the 29 Oct 2026 release (ADR 0103, migration 0034). */
export const INSTALL_IDS_SINCE = "2026-10-29";

export interface Window {
  from: string;
  to: string;
  days: number;
}
const windowOf = (endMs: number, days: number): Window => ({ from: isoDay(endMs - (days - 1) * DAY), to: isoDay(endMs), days });

/** The gaps that overlap a window, as notes. */
export function gapsIn(w: Pick<Window, "from" | "to">): string[] {
  return COUNTER_GAPS.filter((g) => g.from <= w.to && g.to >= w.from).map((g) => g.note);
}

export interface OutsideMetric {
  key: string;
  label: string;
  value: number;
  window: Window | null;
  /** When the data starts later than the window (the number covers less than its window). */
  since?: string;
  /** For a count with no window: when it was counted. */
  as_of?: string;
  detail?: Record<string, number>;
  /** For a 7-day number: the 7 days before, for the trend. */
  previous?: { value: number; window: Window; gaps?: string[] };
  definition: string;
  excludes: string[];
  /** What the number can't tell apart or doesn't cover. */
  limits: string[];
  gaps?: string[];
}

const OUR_TRAFFIC = "our tagged tests and probes (X-Forge-Internal, theagentforge-internal clients), counted apart as internal:*";
const HOUSE = "House and founder accounts";

/** The outside-use block. `now` is when it is built; 7-day windows are whole UTC days ending yesterday. */
export async function outsideMetrics(env: Env, now = Date.now()) {
  const db = getDb(env);
  const yesterday = now - DAY;
  const week = windowOf(yesterday, 7);
  const before = windowOf(yesterday - 7 * DAY, 7);
  const recent = windowOf(now, 28);

  const [cur, prev, owners, returningIds, returningAgents, firstCheckDay] = await Promise.all([
    agentFunnel(env, yesterday, 7),
    agentFunnel(env, yesterday - 7 * DAY, 7),
    ownerActivity(env, now, 30),
    // Install IDs first seen in the window and seen again on a later day: two distinct days, both in the window.
    db
      .select({ n: sql<number>`count(*)` })
      .from(t.installIds)
      .where(and(eq(t.installIds.ours, false), gte(t.installIds.firstDay, recent.from), lte(t.installIds.lastDay, recent.to), sql`${t.installIds.lastDay} > ${t.installIds.firstDay}`)),
    // Signed-in agents of outside owners (their check source is the agent id, never a daily code) on 2+ distinct days.
    db
      .select({ source: t.checkSources.source })
      .from(t.checkSources)
      .innerJoin(t.agents, eq(t.agents.id, t.checkSources.source))
      .innerJoin(t.humans, eq(t.humans.id, t.agents.humanId))
      .where(and(gte(t.checkSources.day, recent.from), lte(t.checkSources.day, recent.to), eq(t.checkSources.isHouse, false), outsidePeople(env)))
      .groupBy(t.checkSources.source)
      .having(sql`count(distinct ${t.checkSources.day}) >= 2`),
    db.select({ day: sql<string | null>`min(${t.checkSources.day})` }).from(t.checkSources),
  ]);

  const weekGaps = gapsIn(week);
  const prevGaps = gapsIn(before);
  const recentGaps = gapsIn(recent);
  const checksSince = firstCheckDay[0]?.day ?? null;
  const items: OutsideMetric[] = [
    {
      key: "outside_tool_calls_7d",
      label: "Outside tool calls, last 7 full days",
      value: cur.detail.outside_tool_calls,
      window: week,
      previous: { value: prev.detail.outside_tool_calls, window: before, ...(prevGaps.length ? { gaps: prevGaps } : {}) },
      definition:
        "MCP tool calls (tools/call) on /mcp/public, /mcp/gauntlet and the signed-in /mcp, plus A2A requests, summed from the daily counters (mcp:<endpoint>:calls, a2a:requests) over whole UTC days. A count of calls, not of distinct agents.",
      excludes: [
        OUR_TRAFFIC,
        `${HOUSE}' signed-in sessions (mcp:house:*)`,
        "calls made under the name of a directory, catalogue, checker or monitor client (services/agent-funnel.ts, ADR 0050), which is how likely bots are left out of MCP counts",
      ],
      limits: [
        "REST checks (/api/v1/check), API scans and web pages are not in it.",
        "Calls from clients that don't name themselves (most 2025-protocol apps) can't be classified and are counted.",
        "Our own Claude connectors on /mcp/public carry no House tag yet (ADR 0124), so they are counted.",
        "MCP and A2A calls have no user-agent bot test (ADR 0124); only named catalogue and monitor clients are taken off.",
      ],
      ...(weekGaps.length ? { gaps: weekGaps } : {}),
    },
    {
      key: "returning_install_ids_28d",
      label: "Install IDs seen on 2 or more days, last 28 days",
      value: Number(returningIds[0]?.n ?? 0),
      window: recent,
      ...(INSTALL_IDS_SINCE > recent.from ? { since: INSTALL_IDS_SINCE } : {}),
      definition:
        "Anonymous install IDs (sent with install-time checks by the CLI, its hooks and the Claude Code plugin; ADR 0103) first seen in the window and seen again on a later day in it. Only the first and last day of each ID are kept, so an ID first seen before the window is not counted.",
      excludes: ["IDs marked ours: our tagged tests and the IDs listed in HOUSE_INSTALL_IDS", "CI machines and people who opted out (they send no ID)"],
      limits: ["Counts install IDs, not people: one person can have several installs."],
      ...(recentGaps.length ? { gaps: recentGaps } : {}),
    },
    {
      key: "returning_signed_in_agents_28d",
      label: "Signed-in agents that checked on 2 or more days, last 28 days",
      value: returningAgents.length,
      window: recent,
      ...(checksSince && checksSince > recent.from ? { since: checksSince } : {}),
      definition:
        "Agents linked to a person outside the project that ran forge_check on the signed-in /mcp on at least 2 distinct UTC days in the window (check_sources rows keyed by the agent id).",
      excludes: [HOUSE, OUR_TRAFFIC],
      limits: ["Anonymous callers can't be followed across days (their source code changes daily, by design), so they are not in it."],
      ...(recentGaps.length ? { gaps: recentGaps } : {}),
    },
    {
      key: "verified_owners",
      label: "Verified owners",
      value: owners.owners,
      window: null,
      as_of: new Date(now).toISOString(),
      detail: { active_30d: owners.active },
      definition:
        "People outside the project who signed in with GitHub, are verified and have at least one active agent (ADR 0073), counted when the page was built. active_30d: of them, those whose agent made a signed-in check, filed a report, claimed a Gauntlet run or played a Ranked Ladder bout in the last 30 days.",
      excludes: [HOUSE],
      limits: ["A current count, not a window: an owner whose agents are all revoked drops out."],
    },
  ];
  return {
    key: "outside_use",
    label: "Outside use (our own traffic and likely bots left out)",
    house_excluded: true as const,
    generated_at: new Date(now).toISOString(),
    items,
    /** Numbers asked for that can't be computed honestly from the data we keep, and why. */
    not_measured: [
      {
        key: "returning_mcp_clients",
        why: "Anonymous MCP calls are counted per day by client app name only (claude-code, cursor…), with no per-client id, so one app name seen on two days may be two different people.",
      },
    ],
  };
}
export type OutsideMetrics = Awaited<ReturnType<typeof outsideMetrics>>;
