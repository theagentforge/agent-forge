import { and, count, eq, gte, like, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { agentFunnel, outsidePeople } from "./agent-funnel";
import { getDb } from "./db";
import { INSTALL_CLIENTS, type InstallClient } from "./install-metrics";
import { ownerActivity } from "./owners";

// Outside use, founder-only (Dinike, 13 Nov 2026 09:43 Colombo: "I dont want outside numbers on the main site still
// until we have a substantial number that is a strength to show....right now outside numbers only on inside"). Shown on
// /admin/kpis only, never on /stats or /stats.json. Every row leaves our own traffic out by construction (the query
// itself excludes it), never by subtracting afterwards from a gross total:
//   - people: House accounts and founder accounts (ADMIN_GITHUB_IDS) are left out (agent-funnel.ts outsidePeople);
//   - install checks: calls tagged as ours (X-Forge-Internal, services/internal.ts) are counted apart as install:ours:*;
//   - MCP connections: our tagged callers never add a session, and directory health checks and monitors (client names
//     with sessions but no tool call in 7 days) are taken out by the agent funnel (ADR 0050).

const DAY = 86_400_000;

export interface OutsideUse {
  as_of: string;
  rows: { key: string; label: string; value: number; window: string; definition: string; by_client?: Record<InstallClient, number> }[];
}

export async function outsideUse(env: Env, now = Date.now()): Promise<OutsideUse> {
  const db = getDb(env);
  const outside = outsidePeople(env);
  const since30 = now - 30 * DAY;
  const [reports] = await db
    .select({ all: count(), recent: sql<number>`coalesce(sum(case when ${t.reports.createdAt} >= ${since30} then 1 else 0 end), 0)` })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.reports.humanId, t.humans.id))
    .where(and(outside, eq(t.reports.held, false)));
  const [claims] = await db
    .select({ n: count() })
    .from(t.gauntletClaims)
    .innerJoin(t.humans, eq(t.gauntletClaims.humanId, t.humans.id))
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .where(and(outside, eq(t.arenaGauntlets.mode, "full")));
  const installRows = await db
    .select({ key: t.usageDaily.key, n: sql<number>`coalesce(sum(${t.usageDaily.n}), 0)` })
    .from(t.usageDaily)
    .where(and(like(t.usageDaily.key, "install:%checked:%"), gte(t.usageDaily.day, "2026-10-28")))
    .groupBy(t.usageDaily.key);
  const byClient = Object.fromEntries(
    INSTALL_CLIENTS.map((c) => {
      const all = Number(installRows.find((r) => r.key === `install:checked:${c}`)?.n ?? 0);
      const ours = Number(installRows.find((r) => r.key === `install:ours:checked:${c}`)?.n ?? 0);
      return [c, Math.max(0, all - ours)];
    }),
  ) as Record<InstallClient, number>;
  const [activity, funnel] = await Promise.all([ownerActivity(env, now, 30), agentFunnel(env, now, 7)]);
  return {
    as_of: new Date(now).toISOString(),
    rows: [
      { key: "outside_field_reports", label: "Outside field reports", value: Number(reports?.all ?? 0), window: "All time", definition: "Shown (not held) field reports by agents of people outside the project: not House, not a founder account." },
      { key: "outside_field_reports_30d", label: "Outside field reports, last 30 days", value: Number(reports?.recent ?? 0), window: "Last 30 days", definition: "The same, filed in the last 30 days." },
      { key: "outside_arena_bouts", label: "Outside Arena bouts (claimed Gauntlet runs)", value: Number(claims?.n ?? 0), window: "All time", definition: "Six-job Gauntlet runs claimed by owners outside the project. Unclaimed runs are anonymous and can't be told apart from ours, so they aren't counted here." },
      {
        key: "outside_install_checks",
        label: "Outside install checks, by client",
        value: Object.values(byClient).reduce((a, b) => a + b, 0),
        window: "All time (install counting began 28 Oct 2026)",
        definition: "Install-time checks from the plugin, the CLI and its hooks and the Actions, each client's count less the checks our CI and repositories made under the X-Forge-Internal tag (counted apart as install:ours:*).",
        by_client: byClient,
      },
      { key: "verified_owners_active_30d", label: "Verified owners active in the last 30 days", value: activity.active, window: "Last 30 days", definition: activity.definition },
      { key: "outside_mcp_connections_7d", label: "Outside MCP connections (monitors left out)", value: funnel.stages.connected, window: "Last 7 UTC days", definition: "MCP sessions on /mcp/public, /mcp/gauntlet and /mcp, plus A2A requests, less directory health checks and monitors; our tagged callers never add a session." },
    ],
  };
}
