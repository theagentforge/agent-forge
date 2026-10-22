import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { bump } from "../src/services/usage";
import { draftsFor, MILESTONE_SLOTS } from "../src/social/drafts";
import { crossed, metricValues, METRICS, milestoneTexts } from "../src/social/milestones";
import { connectApprovedAgent, fp, postReport, profile, report } from "./helpers";
import "../src/index";

const vals = (before: Record<string, number>, now: Record<string, number>) => ({ before: { reports: 0, agents: 0, connections: 0, ...before }, now: { reports: 0, agents: 0, connections: 0, ...now } }) as never;

describe("milestone posts (outside numbers only, always approved by hand)", () => {
  it("finds thresholds crossed in the window, the highest per metric, firsts first", () => {
    expect(crossed(vals({ connections: 90 }, { connections: 130 }))).toEqual([{ id: "connections-100", metric: "connections", threshold: 100, value: 130 }]);
    expect(crossed(vals({ connections: 90 }, { connections: 1_200 })).map((m) => m.id)).toEqual(["connections-1000"]);
    expect(crossed(vals({ connections: 100 }, { connections: 130 }))).toEqual([]);
    expect(crossed(vals({ connections: 90, reports: 0 }, { connections: 130, reports: 1 })).map((m) => m.id)).toEqual(["reports-1", "connections-100"]);
    expect(METRICS.connections[0]).toBe(100);
  });

  it("every wording thanks people, says what's excluded, has no link and fits a post", () => {
    for (const metric of Object.keys(METRICS) as (keyof typeof METRICS)[])
      for (const threshold of METRICS[metric])
        for (const text of milestoneTexts({ id: `${metric}-${threshold}`, metric, threshold, value: threshold })) {
          expect(text.length).toBeLessThanOrEqual(275);
          expect(text).not.toMatch(/https?:\/\/|@\w/);
          expect(text).toMatch(/[Tt]hank/);
          expect(text).toMatch(/outside|our own|our test|our team|don't run/);
        }
  });

  it("counts reports from people outside the project only, and directory checks never count as connections", async () => {
    const now = Date.now();
    const before = await metricValues(env, getDb(env), now, now - 1);
    const p = await connectApprovedAgent(profile());
    expect((await postReport(p.token, report({ tool: { kind: "mcp_server", id: "npm:milestone-a", version: "1.0.0", fingerprint: fp("c") } }))).status).toBe(201);
    const house = await connectApprovedAgent(profile());
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, house.human.id));
    expect((await postReport(house.token, report({ tool: { kind: "mcp_server", id: "npm:milestone-b", version: "1.0.0", fingerprint: fp("d") } }))).status).toBe(201);
    await bump(env, ["mcp:public:sessions", "mcp:public:sessions", "mcp:client:glama"]);
    const after = await metricValues(env, getDb(env), Date.now(), now - 1);
    expect(after.now.reports - before.now.reports).toBe(1);
    expect(after.now.agents - before.now.agents).toBe(1);
    expect(after.now.connections - before.now.connections).toBe(1);
  });

  it("drafts it on a Tuesday in the 9 am slot instead of the board change, with the stats link as the reply", async () => {
    expect(MILESTONE_SLOTS[2]).toEqual({ hour: 9, replaces: "board-change" });
    // Cross 100 outside connections in the week before a Tuesday.
    const tue = "2027-03-02";
    const now = Date.UTC(2027, 2, 1, 12);
    const { now: v } = await metricValues(env, getDb(env), now, now - 1);
    const need = 100 - v.connections;
    if (need > 0) await bump(env, Array.from({ length: need }, () => "a2a:requests"), Date.UTC(2027, 1, 27, 12));
    const drafts = await draftsFor(env, getDb(env), tue, now);
    const m = drafts.find((d) => d.type === "milestone");
    expect(m?.milestone).toBe("connections-100");
    expect(m?.at).toBe("2027-03-02T14:00:00.000Z");
    expect(m?.reply).toMatch(/^Live numbers, outside agents only: https:\/\/theagentforge\.io\/stats/);
    expect(drafts.some((d) => d.type === "board-change")).toBe(false);
    // No milestone on a Monday.
    expect((await draftsFor(env, getDb(env), "2027-03-01", now)).some((d) => d.type === "milestone")).toBe(false);
  });
});
