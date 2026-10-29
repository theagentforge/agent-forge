import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { BADGE_COLORS, badgeCounts, badgeFor, badgeMarkdown, badgeSvg } from "../src/web/badge";
import { connectAgent, fetchWorker, fp, postReport, report } from "./helpers";
import "../src/index";

const base = { known: true, tool: { kind: "mcp_server", id: "npm:x" }, version: "1.2.0", fingerprint: null, forge_score: null, distinct_owners: 0, verified_owners: 0, loop_rate: null, recovers_after_reset_rate: null, strain_reports: 0, strain_hook_reports: 0, outcome_breakdown: { worked: 0, partial: 0, failed: 0 }, security_status: "clear" as const, other_versions_flagged: [], public_signals_summary: null, page_url: null, reports_for_this_version: 0, be_first: true, verdict: "insufficient" as const, contribute: { tool: "forge_report" as const, mcp_server: "x", auth: "github_oauth" as const, human_verified: true as const }, reports: [], corroborated_reports: 0 };

describe("README badge", () => {
  it("is only for versions with counted reports, pinned to the version, and honest about flags and failures", () => {
    expect(badgeFor({ ...base })).toBeNull();
    expect(badgeFor({ ...base }, { reports: 2, corroborated: 0, failed: 0 })).toMatchObject({ label: "Forge-checked v1.2.0", message: "2 reports, 0 corroborated", color: BADGE_COLORS.grey });
    expect(badgeFor({ ...base, forge_score: 88 }, { reports: 7, corroborated: 3, failed: 0 })).toMatchObject({ message: "7 reports, 3 corroborated", color: BADGE_COLORS.green });
    // The warning colour: failed reports on the version, or an advisory or review.
    expect(badgeFor({ ...base, forge_score: 88 }, { reports: 7, corroborated: 3, failed: 2 })).toMatchObject({ message: "7 reports, 3 corroborated · 2 failed", color: BADGE_COLORS.amber });
    expect(badgeFor({ ...base, security_status: "caution" }, { reports: 1, corroborated: 0, failed: 0 })).toMatchObject({ message: "1 report, 0 corroborated · under review", color: BADGE_COLORS.amber });
    expect(badgeFor({ ...base, security_status: "flagged" }, { reports: 7, corroborated: 0, failed: 0 })).toMatchObject({ message: "flagged", color: BADGE_COLORS.red });
    expect(badgeFor({ ...base }, { reports: 0, corroborated: 0, failed: 0 })).toBeNull();
    expect(badgeSvg({ label: "forge", message: "a<b", color: "#000" })).toContain("a&lt;b");
    expect(badgeMarkdown("https://x.io", "npm:a", "1.2.0")).toBe("[![Forge-checked](https://x.io/badge/npm%3Aa.svg?v=1.2.0)](https://x.io/t/npm%3Aa?from=badge)");
  });

  it("serves SVG and a shields.io endpoint for a reported tool, and 404 for one with no reports", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const { token } = await connectAgent();
    await postReport(token, report({ tool: { ...report().tool, id: "npm:badge-me" } }));
    const svg = await fetchWorker("/badge/npm%3Abadge-me.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain("Forge-checked v1.0.0: 1 report, 0 corroborated");
    const json = (await (await fetchWorker("/badge/npm%3Abadge-me.json")).json()) as { schemaVersion: number; label: string };
    expect(json).toMatchObject({ schemaVersion: 1, label: "Forge-checked v1.0.0" });
    expect((await fetchWorker("/badge/npm%3Anever-reported.svg")).status).toBe(404);
    // Pinned: the version asked for, or no badge (never another version's numbers).
    expect((await fetchWorker("/badge/npm%3Abadge-me.svg?v=1.0.0")).status).toBe(200);
    expect((await fetchWorker("/badge/npm%3Abadge-me.svg?v=9.9.9")).status).toBe(404);
    expect((await fetchWorker("/badge/npm%3Abadge-me.svg?v=%3Cscript%3E")).status).toBe(400);
    const page = await (await fetchWorker("/t/npm%3Abadge-me", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("README badge");
    expect(page).toContain("Forge-checked v1.0.0: 1 report, 0 corroborated");
    expect(page).toContain("/badge/npm%3Abadge-me.svg?v=1.0.0)](");
    expect(page).toContain("/t/npm%3Abadge-me?from=badge");
  });

  it("leaves out reports from owners affiliated with the tool, and turns amber on failed reports", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const tool = { ...report().tool, id: "npm:badge-claimed", fingerprint: fp("b") };
    const maker = await connectAgent();
    const user = await connectAgent();
    await postReport(maker.token, report({ tool }));
    await postReport(user.token, report({ tool, outcome: "failed", issues: ["install_failed"] }));
    const db = getDb(env);
    const row = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, "npm:badge-claimed") });
    await db.insert(t.publisherClaims).values({ id: crypto.randomUUID(), toolId: row!.id, humanId: maker.human.id, method: "github", verifiedAt: Date.now() });
    expect(await badgeCounts(env, db, "npm:badge-claimed", fp("b"))).toEqual({ reports: 1, corroborated: 0, failed: 1 });
    const svg = await (await fetchWorker("/badge/npm%3Abadge-claimed.svg")).text();
    expect(svg).toContain("1 report, 0 corroborated · 1 failed");
    expect(svg).toContain(BADGE_COLORS.amber);
  });

  it("counts badge embeds (served badges only) and click-ins tagged from=badge", async () => {
    const { badgeStats } = await import("../src/services/growth");
    const before = await badgeStats(env);
    await fetchWorker("/badge/npm%3Abadge-me.svg", { headers: { Referer: "https://github.com/acme/tool" } });
    await fetchWorker("/badge/npm%3Anever-reported.svg");
    await fetchWorker("/t/npm%3Abadge-me?from=badge", { headers: { Accept: "text/html", Referer: "https://github.com/acme/tool", "User-Agent": "Mozilla/5.0" } });
    await new Promise((r) => setTimeout(r, 100));
    const after = await badgeStats(env);
    expect(after.serves - before.serves).toBe(1);
    expect(after.clickins - before.clickins).toBe(1);
    const g = (await (await fetchWorker("/api/v1/growth")).json()) as Record<string, unknown>;
    expect(g).toMatchObject({ badge_serves_7d: expect.any(Number), badge_clickins_7d: expect.any(Number) });
  });
});

describe("growth signals", () => {
  it("counts outside sites that show a badge (host only, ours excluded) and exposes claims", async () => {
    const { recordBadgeReferrer, growthStats } = await import("../src/services/growth");
    await recordBadgeReferrer(env, "https://github.com/acme/tool/blob/main/README.md");
    await recordBadgeReferrer(env, "https://github.com/other/thing");
    await recordBadgeReferrer(env, `${env.PUBLIC_ORIGIN}/t/x`);
    await recordBadgeReferrer(env, "not a url");
    const g = await growthStats(env);
    expect(g.badge_sites_7d).toBe(1);
    // F-02: sites showing a badge leave our own out, so the count is internal; the public endpoint has it null.
    const res = await fetchWorker("/api/v1/growth");
    expect(await res.json()).toMatchObject({ badge_sites_7d: null, claims: expect.any(Number) });
  });
});

describe("MCP Registry ownership proof", () => {
  it("serves the registry's HTTP-auth public key at /.well-known/mcp-registry-auth", async () => {
    const res = await fetchWorker("/.well-known/mcp-registry-auth");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/);
  });
});
