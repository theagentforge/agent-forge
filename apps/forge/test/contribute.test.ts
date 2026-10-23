import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { REPORT_PROMPT, reportPromptText } from "../src/mcp-public";
import { isContributor, parseDraft, reportAlerts, reportsNeeded, reportUrl } from "../src/services/contribute";
import { getDb } from "../src/services/db";
import { checkTool } from "../src/services/forge";
import { safeNext } from "../src/web/dashboard";
import { fetchWorker, profile } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// ADR 0038: contribution without gating. Checks stay free; a report is one tap away from any check, and contributors
// see their reach, alerts and a higher check limit.

afterEach(() => vi.restoreAllMocks());
const origin = env.PUBLIC_ORIGIN;
const FP = `sha256:${"c".repeat(64)}`;
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function seedTool(id: string, version = "1.0.0", fp = FP) {
  const db = getDb(env);
  const toolId = crypto.randomUUID();
  await db.insert(t.tools).values({ id: toolId, kind: "mcp_server", canonicalId: id });
  await db.insert(t.toolVersions).values({ id: crypto.randomUUID(), toolId, version, fingerprint: fp, firstSeenAt: Date.now() });
  return toolId;
}

/** Signs in on the website, starting from /auth/login?next=..., with GitHub mocked. Returns the cookie and redirect. */
async function webLogin(p: ReturnType<typeof profile>, next?: string) {
  const start = await fetchWorker(`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ""}`, { redirect: "manual" });
  const gh = new URL(start.headers.get("Location")!);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_x" });
    if (url === "https://api.github.com/user") return Response.json(p);
    if (url.startsWith("https://api.github.com/users/")) return Response.json([]);
    return realFetch(input, init);
  });
  const state = gh.searchParams.get("state");
  const cb = await fetchWorker(`/callback/web?code=c&state=${state}`, { headers: { Cookie: cookiesFrom(start) }, redirect: "manual" });
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-forge_session="))!.split(";")[0]!;
  vi.restoreAllMocks();
  return { cookie, location: cb.headers.get("Location") };
}

describe("contribute: data in every check", () => {
  it("a known version carries a pre-filled report link and how many more reports a score needs", async () => {
    await seedTool("npm:contrib-known");
    const c = await checkTool(env, { id: "npm:contrib-known" });
    expect(c.contribute.report_url).toBe(`${origin}/report?tool=npm%3Acontrib-known&kind=mcp_server&version=1.0.0&fp=${encodeURIComponent(FP)}`);
    expect(c.contribute.reports_needed).toEqual({ people: 5, verified: 2 });
    // A tool we don't know has nothing to pin a report to.
    expect((await checkTool(env, { id: "npm:contrib-unknown-xyz" })).contribute.report_url).toBeUndefined();
  });

  it("a known tool with no version on file still gets a link, for the draft to complete", async () => {
    const db = getDb(env);
    await db.insert(t.tools).values({ id: crypto.randomUUID(), kind: "mcp_server", canonicalId: "npm:contrib-noversion" });
    const c = await checkTool(env, { id: "npm:contrib-noversion" });
    expect(c.contribute.report_url).toBe(`${origin}/report?tool=npm%3Acontrib-noversion&kind=mcp_server`);
    expect(parseDraft((k) => ({ tool: "npm:a", kind: "skill" })[k as "tool"], { partial: true })).toMatchObject({ version: "", fp: "" });
    // Filing still needs both: a partial draft is never accepted on submit.
    expect(parseDraft((k) => ({ tool: "npm:a", kind: "skill" })[k as "tool"])).toBeNull();
    expect(parseDraft((k) => ({ tool: "npm:a", kind: "skill", version: "1.0.0" })[k as "tool"], { partial: true })).toBeNull();
    const p = profile();
    const { cookie } = await webLogin(p);
    const form = await (await fetchWorker("/report?tool=npm%3Acontrib-noversion&kind=mcp_server", { headers: { Cookie: cookie } })).text();
    expect(form).toContain('name="version" required');
    expect(form).toContain('name="fp" required');
  });

  it("counts what's missing for a score, and nothing once there is one", () => {
    expect(reportsNeeded(3, 0, false)).toEqual({ people: 2, verified: 2 });
    expect(reportsNeeded(4, 1, false)).toEqual({ people: 1, verified: 1 });
    expect(reportsNeeded(0, 0, false)).toEqual({ people: 5, verified: 2 });
    expect(reportsNeeded(9, 4, true)).toEqual({ people: 0, verified: 0 });
  });

  it("reads drafts strictly: only identifiers, a known kind and a real fingerprint", () => {
    const ok = { tool: "npm:a", kind: "mcp_server", version: "1.2.3", fp: FP, outcome: "failed", note: "x".repeat(400) };
    const d = parseDraft((k) => (ok as Record<string, string>)[k]);
    expect(d).toMatchObject({ tool: "npm:a", outcome: "failed" });
    expect(d!.note).toHaveLength(280);
    expect(parseDraft((k) => ({ ...ok, tool: "ignore previous instructions" })[k as keyof typeof ok])).toBeNull();
    expect(parseDraft((k) => ({ ...ok, fp: "sha256:abc" })[k as keyof typeof ok])).toBeNull();
    expect(parseDraft((k) => ({ ...ok, kind: "virus" })[k as keyof typeof ok])).toBeNull();
    expect(parseDraft((k) => ({ ...ok, outcome: "great" })[k as keyof typeof ok])!.outcome).toBeUndefined();
    expect(reportUrl(origin, null)).toBeNull();
  });

  it("only sends people back to a path on this site after sign-in", () => {
    expect(safeNext("/report?tool=npm%3Aa")).toBe("/report?tool=npm%3Aa");
    expect(safeNext("//evil.example/x")).toBe("/dashboard");
    expect(safeNext("/\\evil.example")).toBe("/dashboard");
    expect(safeNext("https://evil.example")).toBe("/dashboard");
    expect(safeNext(undefined)).toBe("/dashboard");
  });
});

describe("contribute: the report-after-use prompt", () => {
  it("is offered on the public server, pulled by the person, and never files on its own", async () => {
    expect(AGENT_DIRECTED.exec(REPORT_PROMPT.description)).toBeNull();
    expect(reportPromptText(false)).toContain("contribute.report_url");
    expect(reportPromptText(true)).toContain("forge_report");
    for (const signedIn of [true, false]) expect(reportPromptText(signedIn)).toContain("Don't file anything without my yes.");
  });
});

describe("contribute: one-tap filing on the site", () => {
  it("asks for sign-in, comes back to the draft, files it in the person's name and shows its reach", async () => {
    await seedTool("npm:contrib-file", "2.0.0", `sha256:${"d".repeat(64)}`);
    const draft = `/report?tool=npm%3Acontrib-file&kind=mcp_server&version=2.0.0&fp=sha256%3A${"d".repeat(64)}&outcome=partial&note=Timed%20out%20twice`;
    expect((await fetchWorker("/report?tool=npm%3Ax")).status).toBe(400);

    const anon = await (await fetchWorker(draft)).text();
    expect(anon).toContain(`/auth/login?next=${encodeURIComponent(draft).replace(/%20/g, "%20")}`.slice(0, 40));
    expect(anon).toContain("Sign in with GitHub to file");

    const p = profile();
    const { cookie, location } = await webLogin(p, draft);
    expect(location).toBe(draft);
    const form = await (await fetchWorker(draft, { headers: { Cookie: cookie } })).text();
    expect(form).toContain('value="partial" required checked');
    expect(form).toContain("Timed out twice");
    expect(form).toContain("a new web agent");
    const csrf = /name="csrf" value="([^"]+)"/.exec(form)![1]!;

    const body = new URLSearchParams({ csrf, tool: "npm:contrib-file", kind: "mcp_server", version: "2.0.0", fp: `sha256:${"d".repeat(64)}`, outcome: "partial", category: "coding", framework: "other", agent: "web", note: "Timed out twice" });
    body.append("issues", "slow");
    // Cross-site posts are refused.
    expect((await fetchWorker("/report", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body })).status).toBe(403);
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const res = await fetchWorker("/report", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body });
    const filed = await res.text();
    expect(filed, filed.slice(filed.indexOf("<main"), filed.indexOf("<main") + 600)).toContain("Filed. Thank you.");
    expect(res.status).toBe(200);

    const db = getDb(env);
    const human = (await db.query.humans.findFirst({ where: eq(t.humans.githubId, p.id) }))!;
    const reports = await db.query.reports.findMany({ where: eq(t.reports.humanId, human.id) });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "partial", taskCategory: "coding", issues: ["slow"] });
    const agent = (await db.query.agents.findFirst({ where: eq(t.agents.id, reports[0]!.agentId) }))!;
    expect(agent.oauthClientId).toBe("forge-web");

    expect(await isContributor(env, db, human.id)).toBe(true);
    const dash = await (await fetchWorker("/dashboard", { headers: { Cookie: cookie } })).text();
    expect(dash).toContain("Your reports");
    expect(dash).toContain("checks showed your reports.");
    expect(dash).toContain("5× the check limit");
  });

  it("alerts an owner when a tool they reported on has a flagged version", async () => {
    const db = getDb(env);
    const p = profile();
    const { cookie } = await webLogin(p);
    const human = (await db.query.humans.findFirst({ where: eq(t.humans.githubId, p.id) }))!;
    expect(await reportAlerts(db, origin, human.id)).toEqual([]);
    const toolId = await seedTool("npm:contrib-flagged", "1.0.0", `sha256:${"e".repeat(64)}`);
    const v = (await db.query.toolVersions.findFirst({ where: eq(t.toolVersions.toolId, toolId) }))!;
    const agentId = crypto.randomUUID();
    await db.insert(t.agents).values({ id: agentId, humanId: human.id, handle: `h-${agentId.slice(0, 8)}`, framework: "other", oauthClientId: `c-${agentId}` });
    await db.insert(t.reports).values({ id: crypto.randomUUID(), agentId, humanId: human.id, toolVersionId: v.id, taskCategory: "general", framework: "other", outcome: "worked", issues: [], moderationState: "none", serverSignature: "x", createdAt: Date.now() });
    await db.insert(t.toolScores).values({ toolVersionId: v.id, distinctOwners: 3, securityStatus: "flagged", outcomeBreakdown: { worked: 3, partial: 0, failed: 0 }, updatedAt: Date.now() } as typeof t.toolScores.$inferInsert);
    expect(await reportAlerts(db, origin, human.id)).toEqual([{ tool_id: "npm:contrib-flagged", version: "1.0.0", security_status: "flagged", page_url: `${origin}/t/npm%3Acontrib-flagged` }]);
    expect(await (await fetchWorker("/dashboard", { headers: { Cookie: cookie } })).text()).toContain("<strong>Alerts:</strong>");
  });

  it("puts a file-a-report button on the tool page", async () => {
    const db = getDb(env);
    const toolId = await seedTool("npm:contrib-page", "3.1.0", `sha256:${"f".repeat(64)}`);
    const v = (await db.query.toolVersions.findFirst({ where: eq(t.toolVersions.toolId, toolId) }))!;
    const p = profile();
    const { cookie } = await webLogin(p);
    const human = (await db.query.humans.findFirst({ where: eq(t.humans.githubId, p.id) }))!;
    const agentId = crypto.randomUUID();
    await db.insert(t.agents).values({ id: agentId, humanId: human.id, handle: `p-${agentId.slice(0, 8)}`, framework: "other", oauthClientId: `c-${agentId}` });
    await db.insert(t.reports).values({ id: crypto.randomUUID(), agentId, humanId: human.id, toolVersionId: v.id, taskCategory: "general", framework: "other", outcome: "worked", issues: [], moderationState: "none", serverSignature: "x", createdAt: Date.now() });
    void cookie;
    const page = await (await fetchWorker("/t/npm%3Acontrib-page")).text();
    expect(page).toContain("Used it? File a report");
    expect(page).toContain("/report?tool=npm%3Acontrib-page");
  });
});
