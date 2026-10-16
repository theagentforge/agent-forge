import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { connectAgent, connectApprovedAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

// Workers AI only runs remotely, so tests stand in for Llama Guard's verdict.
const guard = vi.fn(async () => ({ response: "safe" }));
beforeEach(() => {
  guard.mockResolvedValue({ response: "safe" });
  vi.spyOn(env.AI, "run").mockImplementation(guard as never);
});

describe("protected routes", () => {
  it.each(["/api/v1/me", "/mcp"])("%s requires a token", async (path) => {
    const res = await fetchWorker(path, { method: path === "/mcp" ? "POST" : "GET" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a forged token", async () => {
    const res = await fetchWorker("/api/v1/me", { headers: { Authorization: "Bearer u:g:forged" } });
    expect(res.status).toBe(401);
  });

  it("publishes protected resource metadata for MCP discovery", async () => {
    const res = await fetchWorker("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource: string }).resource).toBe(env.PUBLIC_ORIGIN);
  });
});

describe("checks invite a first report", () => {
  it("an unreported version says be_first; after a report it counts it", async () => {
    const before = (await (await fetchWorker("/api/v1/check?id=npm:first-one")).json()) as { be_first: boolean; reports_for_this_version: number };
    expect(before).toMatchObject({ be_first: true, reports_for_this_version: 0 });
    const { token } = await connectAgent();
    await postReport(token, report({ tool: { ...report().tool, id: "npm:first-one" } }));
    // The public endpoint is edge-cached for a minute, so read the fresh result directly.
    const { checkTool } = await import("../src/services/forge");
    const after = await checkTool(env, { id: "npm:first-one" });
    expect(after).toMatchObject({ be_first: false, reports_for_this_version: 1 });
  });
});

describe("reports", () => {
  it("files a report, then the public check shows it", async () => {
    const { token } = await connectAgent();
    const res = await postReport(token, report({ note: "Fast and accurate on news sites." }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, counted: true, reason: "counted", note_status: "published" });

    const check = await fetchWorker("/api/v1/check?id=npm:@acme/search-mcp");
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({
      known: true,
      tool: { kind: "mcp_server", id: "npm:@acme/search-mcp" },
      version: "1.0.0",
      forge_score: null, // fewer than 5 independent owners
      distinct_owners: 1,
      verified_owners: 1,
      outcome_breakdown: { worked: 1, partial: 0, failed: 0 },
      security_status: "clear",
    });
  });

  it("stores a server signature and no peer prose leaks into checks", async () => {
    const { token } = await connectAgent();
    await postReport(token, report({ tool: { ...report().tool, id: "npm:sig-test", fingerprint: fp("b") }, note: "ok" }));
    const row = await getDb(env).query.reports.findFirst({ where: eq(t.reports.note, "ok") });
    expect(row?.serverSignature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    const check = await (await fetchWorker("/api/v1/check?id=npm:sig-test")).text();
    expect(check).not.toContain('"ok"');
  });

  it("returns /me for the agent", async () => {
    const { token, agent } = await connectAgent();
    await postReport(token, report());
    const res = await fetchWorker("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { agent: { handle: string }; human_tier: string; recent_reports: unknown[] };
    expect(me.agent.handle).toBe(agent.handle);
    expect(me.human_tier).toBe("verified");
    expect(me.recent_reports).toHaveLength(1);
  });

  it.each([
    ["a GitHub token", "token ghp_" + "A1".repeat(18), "note_contains_credential"],
    ["a file path", "it read /home/me/.aws/credentials", "note_contains_file_path"],
    ["a link", "see https://evil.example", "note_contains_link"],
  ])("rejects a note containing %s", async (_n, note, reason) => {
    const { token } = await connectAgent();
    const res = await postReport(token, report({ note }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, counted: false, reason });
  });

  it("rejects reports that don't match the schema", async () => {
    const { token } = await connectAgent();
    const res = await postReport(token, { ...report(), prompt: "secret instructions" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ reason: "invalid_report" });
  });

  it("drops a note the moderation model rejects but keeps the report", async () => {
    guard.mockResolvedValue({ response: "unsafe\nS1" });
    const { token } = await connectAgent();
    const res = await postReport(token, report({ note: "something unsafe" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ counted: true, note_status: "removed_by_moderation" });
  });

  it("a publisher can't report its own tool (personal account or organisation)", async () => {
    const p = profile({ login: "acme-dev" });
    const { token } = await connectAgent({ profile: p, orgs: ["acme-org"] });
    for (const id of ["github.com/acme-dev/tool", "github.com/Acme-Org/skills/thing"]) {
      const res = await postReport(token, report({ tool: { ...report().tool, kind: "skill", id } }));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ reason: "publisher_cannot_report_own_tool" });
    }
  });

  it("a sandbox account's report counts with reduced weight", async () => {
    const { token } = await connectAgent({ profile: profile({ public_repos: 0, public_gists: 0, followers: 0 }) });
    const res = await postReport(token, report());
    expect(await res.json()).toMatchObject({ counted: true, reason: "sandbox_reduced_weight" });
  });

  it("a revoked agent can no longer report", async () => {
    const { token, agent } = await connectAgent();
    await getDb(env).update(t.agents).set({ status: "revoked" }).where(eq(t.agents.id, agent.id));
    const res = await postReport(token, report());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "agent_inactive" });
  });

  it("three security reports from distinct owners flag the version; a new fingerprint starts clear", async () => {
    const tool = { kind: "skill", id: "github.com/someone/sneaky-skill", version: "2.0.0", fingerprint: fp("c") };
    for (let i = 0; i < 3; i++) {
      const { token } = await connectApprovedAgent();
      const res = await postReport(token, report({ tool, outcome: "partial", issues: ["requested_secrets"] }));
      expect(res.status).toBe(201);
    }
    const check = await (await fetchWorker(`/api/v1/check?fingerprint=${fp("c")}`)).json();
    expect(check).toMatchObject({ security_status: "flagged", distinct_owners: 3 });

    const events = await getDb(env).select().from(t.statusEvents);
    expect(events.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual(
      expect.arrayContaining(["clear->under_review", "under_review->flagged"]),
    );

    const { token } = await connectAgent();
    await postReport(token, report({ tool: { ...tool, version: "2.0.1", fingerprint: fp("d") } }));
    const fresh = await (await fetchWorker(`/api/v1/check?fingerprint=${fp("d")}`)).json();
    expect(fresh).toMatchObject({ security_status: "clear", distinct_owners: 1, version: "2.0.1" });
  });

  it("people verified only by GitHub activity can raise 'under review' but not flag (M3, option b)", async () => {
    const tool = { kind: "skill", id: "github.com/someone/rival-tool", version: "1.0.0", fingerprint: fp("f") };
    for (let i = 0; i < 4; i++) {
      const { token } = await connectAgent(); // 3 public repos: verified by activity
      await postReport(token, report({ tool, outcome: "failed", issues: ["unexpected_network"] }));
    }
    const check = await (await fetchWorker(`/api/v1/check?fingerprint=${fp("f")}`)).json();
    expect(check).toMatchObject({ security_status: "caution", verified_owners: 4 });
  });

  it("one human with three agents is counted once", async () => {
    const p = profile();
    const tool = { kind: "skill", id: "github.com/x/one-human", version: "1", fingerprint: fp("e") };
    for (const clientName of ["Claude Code", "Cursor", "Codex"]) {
      const { token } = await connectAgent({ profile: p, clientName });
      expect((await postReport(token, report({ tool, issues: ["destructive_action"] }))).status).toBe(201);
    }
    const check = await (await fetchWorker(`/api/v1/check?fingerprint=${fp("e")}`)).json();
    expect(check).toMatchObject({ distinct_owners: 1, security_status: "caution" });
  });
});

describe("public stats", () => {
  it("counts everyone, sandbox included", async () => {
    await connectAgent({ profile: profile({ public_repos: 0, public_gists: 0, followers: 0 }) });
    const res = await fetchWorker("/api/v1/stats");
    expect(res.status).toBe(200);
    const stats = (await res.json()) as Record<string, number>;
    expect(stats.humans).toBeGreaterThanOrEqual(1);
    expect(stats.agents).toBeGreaterThanOrEqual(1);
    expect(stats.humans).toBeGreaterThan(stats.verified_humans ?? 0);
  });
});

describe("public check", () => {
  it("answers for unknown tools without signup", async () => {
    const res = await fetchWorker("/api/v1/check?url=https://github.com/nobody/nothing");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
    expect(await res.json()).toMatchObject({ known: false, security_status: "clear", forge_score: null });
  });

  it("rejects ambiguous queries", async () => {
    const res = await fetchWorker("/api/v1/check?id=a&fingerprint=" + fp("f"));
    expect(res.status).toBe(400);
  });
});
