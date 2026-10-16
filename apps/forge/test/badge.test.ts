import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { badgeFor, badgeSvg } from "../src/web/badge";
import { connectAgent, fetchWorker, postReport, report } from "./helpers";
import "../src/index";

const base = { known: true, tool: { kind: "mcp_server", id: "npm:x" }, version: "1.2.0", fingerprint: null, forge_score: null, distinct_owners: 0, verified_owners: 0, loop_rate: null, recovers_after_reset_rate: null, strain_reports: 0, strain_hook_reports: 0, outcome_breakdown: { worked: 0, partial: 0, failed: 0 }, security_status: "clear" as const, other_versions_flagged: [], public_signals_summary: null, page_url: null, reports_for_this_version: 0, be_first: true };

describe("README badge", () => {
  it("is only for tools with data, pinned to the version, and honest about flags", () => {
    expect(badgeFor({ ...base })).toBeNull();
    expect(badgeFor({ ...base, distinct_owners: 2 })).toMatchObject({ message: "early reports v1.2.0 · 2 people" });
    expect(badgeFor({ ...base, distinct_owners: 7, forge_score: 88 })).toMatchObject({ message: "88 v1.2.0 · 7 people", color: "#2e9e6b" });
    expect(badgeFor({ ...base, distinct_owners: 7, forge_score: 88, security_status: "flagged" })).toMatchObject({ message: "flagged v1.2.0", color: "#c43c35" });
    expect(badgeSvg({ label: "forge", message: "a<b", color: "#000" })).toContain("a&lt;b");
  });

  it("serves SVG and a shields.io endpoint for a reported tool, and 404 for one with no reports", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const { token } = await connectAgent();
    await postReport(token, report({ tool: { ...report().tool, id: "npm:badge-me" } }));
    const svg = await fetchWorker("/badge/npm%3Abadge-me.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain("early reports v1.0.0 · 1 person");
    const json = (await (await fetchWorker("/badge/npm%3Abadge-me.json")).json()) as { schemaVersion: number; label: string };
    expect(json).toMatchObject({ schemaVersion: 1, label: "forge" });
    expect((await fetchWorker("/badge/npm%3Anever-reported.svg")).status).toBe(404);
    const page = await (await fetchWorker("/t/npm%3Abadge-me", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("README badge");
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
    const res = await fetchWorker("/api/v1/growth");
    expect(await res.json()).toMatchObject({ badge_sites_7d: 1, claims: expect.any(Number) });
  });
});

describe("MCP Registry ownership proof", () => {
  it("serves the registry's HTTP-auth public key at /.well-known/mcp-registry-auth", async () => {
    const res = await fetchWorker("/.well-known/mcp-registry-auth");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/);
  });
});
