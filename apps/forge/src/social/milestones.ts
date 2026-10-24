import { and, eq, gte, lt, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { directorySessions, outsidePeople } from "../services/agent-funnel";
import type { Db } from "../services/db";

// Milestone posts (Dinike, 22 Oct 2026: "100, 1000, and then another suitable milestone going forward to show
// traction"; research brief in STATUS.md, 22 Oct). Rules from that research:
// - Only numbers from outside the project, and the post says so. The home page totals (ADR 0030) include our own
//   tests and directory health checks, so they're never quoted in a post.
// - Firsts and round numbers of things that are hard to fake: field reports, signed-in agents, AI app connections.
// - At most one a day, Tue–Thu mornings (US Eastern), always approved by Dinike before posting (so a person can
//   thank and tag the people behind it by hand; X forbids automated mentions).

export const MILESTONE_WINDOW_MS = 7 * 86_400_000;

export const METRICS = {
  /** Field reports filed by agents of people outside the project. */
  reports: [1, 10, 100, 1_000, 10_000],
  /** Distinct signed-in agents of people outside the project. */
  agents: [1, 10, 100, 1_000, 10_000],
  /** MCP sessions and A2A requests from AI apps, less our House sessions and directory health checks. */
  connections: [100, 1_000, 10_000, 100_000],
} as const;
export type Metric = keyof typeof METRICS;

export interface Milestone {
  id: string;
  metric: Metric;
  threshold: number;
  /** The value now (at least `threshold`). */
  value: number;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Outside-only values of each metric at `before` (exclusive) and now. */
export async function metricValues(env: Env, db: Db, now: number, before: number) {
  const outside = outsidePeople(env);
  const reportsAt = async (until: number) =>
    Number((await db.select({ n: sql<number>`count(*)` }).from(t.reports).innerJoin(t.humans, eq(t.reports.humanId, t.humans.id)).where(and(outside, lt(t.reports.createdAt, until))))[0]?.n ?? 0);
  const agentsAt = async (until: number) =>
    Number((await db.select({ n: sql<number>`count(*)` }).from(t.agents).innerJoin(t.humans, eq(t.agents.humanId, t.humans.id)).where(and(outside, lt(t.agents.createdAt, until))))[0]?.n ?? 0);
  // Connections are daily totals: the days before `before`'s day, and all days.
  const connectionsAt = async (untilDay: string | null) => {
    const rows = await db
      .select({ key: t.usageDaily.key, n: sql<number>`sum(${t.usageDaily.n})` })
      .from(t.usageDaily)
      .where(
        and(
          sql`(${t.usageDaily.key} in ('mcp:public:sessions', 'mcp:gauntlet:sessions', 'mcp:signed_in:sessions', 'a2a:requests') or ${t.usageDaily.key} like 'mcp:client:%')`,
          untilDay ? lt(t.usageDaily.day, untilDay) : sql`1 = 1`,
        ),
      )
      .groupBy(t.usageDaily.key);
    const get = (k: string) => Number(rows.find((r) => r.key === k)?.n ?? 0);
    const sessions = get("mcp:public:sessions") + get("mcp:gauntlet:sessions") + get("mcp:signed_in:sessions");
    const directory = directorySessions(rows);
    return Math.max(0, sessions - directory) + get("a2a:requests");
  };
  return {
    now: { reports: await reportsAt(now + 1), agents: await agentsAt(now + 1), connections: await connectionsAt(null) },
    before: { reports: await reportsAt(before), agents: await agentsAt(before), connections: await connectionsAt(day(before)) },
  };
}

/** Thresholds crossed in the window, biggest first (a metric's highest crossing only). */
export function crossed(values: Awaited<ReturnType<typeof metricValues>>): Milestone[] {
  const out: Milestone[] = [];
  for (const metric of Object.keys(METRICS) as Metric[]) {
    const hit = METRICS[metric].filter((th) => values.before[metric] < th && values.now[metric] >= th).at(-1);
    if (hit !== undefined) out.push({ id: `${metric}-${hit}`, metric, threshold: hit, value: values.now[metric] });
  }
  // Firsts and bigger steps lead: a first report outranks 100 connections.
  const weight = (m: Milestone) => (m.threshold === 1 ? 1e9 : 0) + m.threshold * (m.metric === "connections" ? 1 : 10);
  return out.sort((a, b) => weight(b) - weight(a));
}

const n = (v: number) => v.toLocaleString("en-US");

/** The post, in a few wordings. Thanks people, says what's excluded, ends with one specific question. */
export function milestoneTexts(m: Milestone): string[] {
  if (m.metric === "reports" && m.threshold === 1)
    return [
      "The first field report from an agent outside our team just landed on The Forge. Thank you to whoever's agent filed it.\n\nThat's the whole idea: agents telling each other which tools held up. Which tool should yours report on next?",
      "First outside field report on The Forge: an agent we don't run told other agents how a tool behaved. Thank you!\n\nOur own House agents never count. Which tool would you want a report on?",
    ];
  if (m.metric === "agents" && m.threshold === 1)
    return [
      "The first AI agent from outside our team just signed in to The Forge. Thank you for trusting it with your agent.\n\nWhat should it check first?",
    ];
  if (m.metric === "reports")
    return [
      `${n(m.threshold)} field reports on The Forge from agents outside our team. Our own House agents never count.\n\nThank you to everyone whose agent took a minute to report. Which tool should get more reports?`,
      `${n(m.threshold)} field reports from outside agents now, every one about a specific version of a tool. Thank you!\n\nWhich tool do you wish had more reports?`,
    ];
  if (m.metric === "agents")
    return [
      `${n(m.threshold)} AI agents from outside our team are now signed in to The Forge (our test agents don't count). Thank you!\n\nWhat should we build for them next?`,
    ];
  return [
    `${n(m.threshold)} connections to The Forge from AI apps, not counting our own test agents or directories checking we're up. Thank you to everyone who plugged it in.\n\nWhich MCP server should we check next?`,
    `AI apps have now connected to The Forge ${n(m.threshold)} times, our own tests and directory health checks left out. Thank you!\n\nWhich tool should we look at next?`,
  ];
}
