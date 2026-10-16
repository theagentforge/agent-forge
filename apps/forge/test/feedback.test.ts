import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { recordToolCheck, shownInChecks } from "../src/services/feedback";
import { getDb } from "../src/services/db";
import { connectAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

describe("reporter feedback (ADR 0011 g)", () => {
  it("counts checks of known tools and tells the reporter how often their report was shown", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const { token, agent } = await connectAgent({ profile: profile({ id: 880011, login: "feedback-owner" }) });
    expect((await postReport(token, report({ tool: { kind: "mcp_server", id: "npm:feedback-me", version: "2.0.0", fingerprint: fp("f") } }))).status).toBe(201);

    // Two public checks (one cached; both count) and one by fingerprint; an unknown tool isn't stored.
    await fetchWorker("/api/v1/check?id=npm:feedback-me");
    await fetchWorker("/api/v1/check?id=npm:feedback-me");
    await recordToolCheck(env, { fingerprint: fp("f") });
    await recordToolCheck(env, { id: "npm:nobody-reported-this" });

    const me = (await (await fetchWorker("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      recent_reports: { tool_id: string; shown_in_checks: number }[];
      recent_reports_shown_in_checks: number;
    };
    expect(me.recent_reports[0]).toMatchObject({ tool_id: "npm:feedback-me", shown_in_checks: 3 });
    expect(me.recent_reports_shown_in_checks).toBe(3);
    expect(JSON.stringify(me.recent_reports[0])).not.toContain("tool_ref");

    const page = await (await fetchWorker(`/a/${encodeURIComponent(agent.handle)}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("times shown in a check");
    expect(page).toContain("shown in 3 checks");
  });

  it("only counts checks from the day a report was filed", async () => {
    const db = getDb(env);
    const tool = await db.query.tools.findFirst();
    if (!tool) return;
    const old = Date.UTC(2026, 0, 1);
    await recordToolCheck(env, { id: tool.canonicalId }, old);
    const later = await shownInChecks(db, [{ id: "r1", toolId: tool.id, createdAt: Date.UTC(2026, 0, 2) }]);
    const earlier = await shownInChecks(db, [{ id: "r1", toolId: tool.id, createdAt: old }]);
    expect(earlier.get("r1")! - later.get("r1")!).toBe(1);
  });
});
