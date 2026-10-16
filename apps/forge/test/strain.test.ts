import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

beforeEach(() => {
  vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
});

const strain = {
  source: "hook",
  attempts: 2,
  tool_errors: 4,
  retries: 3,
  loop_detected: true,
  context_reset: true,
  outcome_after_reset: "worked",
  escalated_to_human: false,
};

describe("strain in field reports (§6.10)", () => {
  it("stores counts and shows loop rate once 5 people (2 verified) reported", async () => {
    const tool = { kind: "mcp_server", id: "npm:loopy-mcp", version: "1.0.0", fingerprint: fp("1") };
    for (let i = 0; i < 5; i++) {
      const { token } = await connectAgent();
      const s = i < 2 ? strain : { ...strain, loop_detected: false, tool_errors: 0, retries: 0, context_reset: false, outcome_after_reset: "none" };
      const res = await postReport(token, report({ tool, outcome: "partial", strain: s }));
      expect(res.status).toBe(201);
    }
    const check = (await (await fetchWorker("/api/v1/check?id=npm:loopy-mcp")).json()) as Record<string, unknown>;
    expect(check).toMatchObject({ loop_rate: 0.4, strain_reports: 5, strain_hook_reports: 5, recovers_after_reset_rate: null });
    const page = await (await fetchWorker(`/t/${encodeURIComponent("npm:loopy-mcp")}`)).text();
    expect(page).toContain("40%");
    expect(page).toContain("loop rate");
  });

  it("rejects inflated or inconsistent strain counts", async () => {
    const { token } = await connectAgent();
    for (const bad of [{ ...strain, retries: 999 }, { ...strain, tool_errors: 0, retries: 0 }, { ...strain, error: "trace" }]) {
      const res = await postReport(token, report({ strain: bad }));
      expect(res.status).toBe(422);
    }
  });
});

describe("anomaly holds", () => {
  it("a burst of brand-new sandbox accounts on one version is held and doesn't count", async () => {
    const tool = { kind: "skill", id: "github.com/burst/target", version: "1", fingerprint: fp("2") };
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      const { token } = await connectAgent({ profile: profile({ public_repos: 0, public_gists: 0, followers: 0 }) });
      results.push((await (await postReport(token, report({ tool, outcome: "worked" }))).json()) as Record<string, unknown>);
    }
    expect(results.slice(0, 4).every((r) => r.reason === "sandbox_reduced_weight")).toBe(true);
    expect(results[4]).toMatchObject({ counted: false, reason: "held_for_review" });
    expect(results[5]).toMatchObject({ counted: false, reason: "held_for_review" });
    const check = (await (await fetchWorker(`/api/v1/check?fingerprint=${fp("2")}`)).json()) as Record<string, unknown>;
    expect(check.distinct_owners).toBe(4);
  });

  it("verified people are never held by the new-account rule", async () => {
    const tool = { kind: "skill", id: "github.com/burst/other", version: "1", fingerprint: fp("4") };
    for (let i = 0; i < 6; i++) {
      const { token } = await connectAgent();
      expect(((await (await postReport(token, report({ tool }))).json()) as { reason: string }).reason).toBe("counted");
    }
  });
});
