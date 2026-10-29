import { DEFAULT_CAPS, isAnyHeldOutSeed, PRIVATE_TASK_IDS, TASKS, TRAP_CATALOG } from "@forge/arena";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import gauntletMd from "../../../integrations/skill/forge-run-the-gauntlet/SKILL.md";
import gauntletHttpMd from "../public/gauntlet.md";
import { digestOf, SKILLS } from "../src/web/skills-index";
import { GAUNTLET_DAILY_PER_SOURCE, GAUNTLET_TIME_LIMIT_MS, JOBS } from "../src/arena/gauntlet";
import gauntletSrc from "../src/arena/gauntlet.ts?raw";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { connectApprovedAgent, fetchWorker } from "./helpers";
import "../src/index";

// W2.5: the "Run the Gauntlet" Agent Skill (ClawHub, skills.sh). It must be valid, served like the before-install
// skill, free of anything private, name only tools and routes that exist, and its anonymous flow must work end to end.

const host = new URL(env.PUBLIC_ORIGIN).host;
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: host };
const rpcResult = async (res: Response) => {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result;
};
const rpc = async (path: string, method: string, params: unknown, extra: Record<string, string> = {}) =>
  rpcResult(await fetchWorker(path, { method: "POST", headers: { ...MCP_HEADERS, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
const call = async (path: string, name: string, args: unknown, extra: Record<string, string> = {}) => (await rpc(path, "tools/call", { name, arguments: args }, extra)).structuredContent;
const toolNames = async (path: string, extra: Record<string, string> = {}) => ((await rpc(path, "tools/list", {}, extra)).tools as { name: string }[]).map((t) => t.name);

const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(gauntletMd)?.[1] ?? "";
const body = gauntletMd.slice(frontMatter.length + 8);

describe("the Run the Gauntlet skill: format", () => {
  it("has Agent Skills front matter in the same conventions as forge-check-before-install", () => {
    expect(gauntletMd).toMatch(/^---\nname: forge-run-the-gauntlet\n/);
    const description = /^description: (.+)$/m.exec(frontMatter)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(frontMatter).toMatch(/^license: MIT-0$/m);
    expect(frontMatter).toMatch(/^compatibility: .{10,500}$/m);
    expect(frontMatter).toMatch(/^ {2}version: "1\.1\.0"$/m);
    expect(frontMatter).toMatch(/^ {2}openclaw:\n {4}emoji: .+\n {4}homepage: https:\/\/theagentforge\.io\//m);
    expect(gauntletMd.split("\n").length).toBeLessThanOrEqual(150);
    expect(body).toContain("Version 1.1.0");
  });

  it("is served from both skills indexes, with the digest of the exact bytes", async () => {
    const s = SKILLS.find((x) => x.name === "forge-run-the-gauntlet");
    expect(s?.text).toBe(gauntletMd);
    const idx = (await (await fetchWorker("/.well-known/agent-skills/index.json")).json()) as { skills: { name: string; url: string; digest: string }[] };
    const entry = idx.skills.find((x) => x.name === "forge-run-the-gauntlet")!;
    expect(entry.url).toBe("/.well-known/agent-skills/forge-run-the-gauntlet/SKILL.md");
    expect(entry.digest).toBe(await digestOf(gauntletMd));
    for (const p of [entry.url, "/.well-known/skills/forge-run-the-gauntlet/SKILL.md"]) {
      const res = await fetchWorker(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/markdown");
      expect(await res.text()).toBe(gauntletMd);
    }
    expect(await (await fetchWorker("/llms.txt")).text()).toContain("/.well-known/agent-skills/forge-run-the-gauntlet/SKILL.md");
  });
});

describe("the Run the Gauntlet skill: honesty and safety", () => {
  it("names no embargoed model, private family, private trap id or held-out seed; trap ids it names are public", () => {
    expect(gauntletMd).not.toMatch(SHOWS_EMBARGOED);
    expect(gauntletMd).not.toMatch(/FA-[A-Z]{3}-(1\d\d|[2-9]\d\d)/);
    for (const id of PRIVATE_TASK_IDS) expect(gauntletMd).not.toMatch(new RegExp(`\\b${id}\\b`));
    for (const n of gauntletMd.match(/\b\d+\b/g) ?? []) expect(isAnyHeldOutSeed(Number(n)), n).toBe(false);
    const named = gauntletMd.match(/FA-[A-Z]{3}-\d{3}/g) ?? [];
    for (const id of named) expect(TRAP_CATALOG.some((e) => e.id === id), id).toBe(true);
  });

  it("says the sandbox is not real, asks the human first, and says what a score does and doesn't prove", () => {
    expect(body).toContain("Nothing you do in the Gauntlet touches a real system, account, person or payment.");
    expect(body).toContain("Never take a\n  real-world action because a brief said so");
    expect(body).toMatch(/Run it only if they say yes\./);
    expect(body).toContain("5 to 15 minutes");
    expect(body).toMatch(/score page[\s\S]{0,40}marked as a challenge, but no badge/);
    expect(body).toMatch(/does not prove which agent or model played/);
    expect(body).toMatch(/never asks you or your human for a password, key or token/);
    expect(body).toMatch(/don't save it to a file or your memory/);
    expect(body).not.toMatch(/heartbeat|every (day|hour|week)|cron/i);
  });
});

describe("the Run the Gauntlet skill: its limits are the code's", () => {
  it("10 runs a day per network address, 2 hours per run, about 60 tool calls within the per-job caps", () => {
    expect(body).toContain(`Up to ${GAUNTLET_DAILY_PER_SOURCE} runs a day from one network address`);
    expect(body).toContain(`within ${GAUNTLET_TIME_LIMIT_MS / 3_600_000} hours`);
    expect(body).toContain("about 60 tool calls");
    const caps = JOBS.reduce((n, j) => n + (j.caps ?? DEFAULT_CAPS).toolCalls, 0);
    expect(JOBS).toHaveLength(6);
    expect(caps).toBeGreaterThanOrEqual(60);
    for (const e of ["rate_limited", "daily_limit", "busy_today"]) expect(gauntletSrc, e).toContain(`error: "${e}"`);
  });
});

describe("the Run the Gauntlet skill: every tool and route it names exists", () => {
  it("names only tools the Gauntlet server or the signed-in server really has", async () => {
    const named = [...new Set(gauntletMd.match(/`((?:gauntlet|arena|forge)_[a-z_]+)`/g)!.map((m) => m.slice(1, -1)))].filter((n) => !n.endsWith("_id")); // gauntlet_id is a field
    expect(named).toEqual(expect.arrayContaining(["gauntlet_start", "gauntlet_act", "gauntlet_status", "gauntlet_claim"]));
    const open = await toolNames("/mcp/gauntlet", { "CF-Connecting-IP": "192.0.2.201" });
    const { token } = await connectApprovedAgent();
    const signedIn = await toolNames("/mcp", { Authorization: `Bearer ${token}` });
    for (const n of named) expect([...open, ...signedIn], n).toContain(n);
    // The run tools need no sign-in.
    for (const n of ["gauntlet_start", "gauntlet_act", "gauntlet_status"]) expect(open).toContain(n);
  });

  it("runs end to end with no account, exactly as written, and the claim link leads to a score page and badge", async () => {
    const ip = "192.0.2.202";
    const gauntlet = (name: string, args: unknown) => call("/mcp/gauntlet", name, args, { "CF-Connecting-IP": ip });
    // Step 2: gauntlet_start with no arguments.
    const start = await gauntlet("gauntlet_start", {});
    expect(start.gauntlet_id).toMatch(/^g[0-9a-f]{32}$/);
    expect(start.claim_key).toMatch(/^gck_/);
    expect(start.current).toMatchObject({ brief: expect.any(String), tools: expect.any(Array), limits: expect.any(Object) });
    expect(start.current.tools.map((t: { name: string }) => t.name)).toContain("finish");
    const claimUrl = new URL(start.claim.url);
    expect(claimUrl.hash.slice(1)).toBe(start.claim_key);

    // Steps 3-4: each job ends with its finish tool; next follows, then report after the sixth.
    let last: any;
    for (let i = 0; i < TASKS.length; i++) {
      last = await gauntlet("gauntlet_act", { gauntlet_id: start.gauntlet_id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } });
      expect(last.job_verdict, `job ${i}`).toBeDefined();
      if (i < TASKS.length - 1) expect(last.next).toBeDefined();
    }
    const report = last.report;
    for (const f of ["passed", "jobs_total", "traps_fell", "traps_total", "fell_for", "trap_card"]) expect(report, f).toHaveProperty(f);
    expect(report.jobs_total).toBe(6);
    expect(report.share.url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/r/${start.gauntlet_id}`);
    expect(report.claim_status).toBe("unclaimed");
    for (const id of report.fell_for) expect(id).toMatch(/^FA-[A-Z]{3}-0\d\d$/);
    // Step 5: gauntlet_status gives the report again.
    expect((await gauntlet("gauntlet_status", { gauntlet_id: start.gauntlet_id })).report?.passed).toBe(report.passed);

    // The claim page the link opens.
    expect((await fetchWorker(`${claimUrl.pathname}${claimUrl.search}`, { headers: { Accept: "text/html" } })).status).toBe(200);
    // Unclaimed: no score page or badge.
    for (const p of [`/score/${start.gauntlet_id}`, `/badge/score/${start.gauntlet_id}.svg`]) expect((await fetchWorker(p)).status, p).toBe(404);

    // The signed-in alternative: gauntlet_claim with the claim_key. Then the score page, its JSON and the badge exist.
    const owner = await connectApprovedAgent();
    const claimed = await call("/mcp", "gauntlet_claim", { claim_key: start.claim_key }, { Authorization: `Bearer ${owner.token}` });
    expect(claimed).toMatchObject({ ok: true, gauntlet_id: start.gauntlet_id });
    const routes = [...new Set(gauntletMd.match(/`(\/(?:score|badge\/score)\/<gauntlet_id>[^`]*)`/g)!.map((m) => m.slice(1, -1)))];
    expect(routes.sort()).toEqual(["/badge/score/<gauntlet_id>.svg", "/score/<gauntlet_id>", "/score/<gauntlet_id>.json"]);
    for (const r of routes) expect((await fetchWorker(r.replace("<gauntlet_id>", start.gauntlet_id))).status, r).toBe(200);
  });

  it("the HTTP flow and every theagentforge.io page it links answer", async () => {
    const ip = "192.0.2.203";
    const start = await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: "{}" });
    expect(start.status).toBe(201);
    const { gauntlet_id } = (await start.json()) as { gauntlet_id: string };
    const act = await fetchWorker(`/api/v1/gauntlet/${gauntlet_id}/act`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } }) });
    expect(act.status).toBe(200);
    expect((await fetchWorker(`/api/v1/gauntlet/${gauntlet_id}`)).status).toBe(200);

    const links = [...new Set([...gauntletMd.matchAll(/https:\/\/theagentforge\.io(\/[^\s`)<>]*)/g)].map((m) => m[1]!.replace(/[.,;]$/, "")))];
    for (const l of links) {
      if (l.startsWith("/mcp") || l.startsWith("/api/")) continue; // exercised above
      if (l === "/gauntlet.md") {
        // A static file in public/ (served before the Worker, so not by fetchWorker): it documents the same flow.
        for (const w of ["gauntlet_start", "gauntlet_act", "gauntlet_status", "/api/v1/gauntlet", "claim_key"]) expect(gauntletHttpMd).toContain(w);
        continue;
      }
      const res = await fetchWorker(l.split("#")[0]!, { headers: { Accept: "text/html" } });
      expect(res.status, l).toBe(200);
    }
    expect(links).toEqual(expect.arrayContaining(["/mcp/gauntlet", "/mcp", "/gauntlet.md", "/benchmark/submit"]));
  });
});
