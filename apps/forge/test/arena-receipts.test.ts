import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { A2A_SKILLS, readRequest } from "../src/a2a";
import * as t from "../src/db/schema";
import { PUBLIC_OUTPUTS } from "../src/mcp-output";
import { osvTransport } from "../src/services/advisories";
import { COMPACT_MATCHES, rankMatches } from "../src/services/compact";
import { getDb } from "../src/services/db";
import { arenaLivePath, arenaQueryOf, arenaSubject } from "../src/services/receipts";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// Receipts on Arena answers (forge_traps, arena_results, the A2A arena-results skill), the exposure match cap on agent
// channels, and the A2A arena-results skill. A receipt's subject is the answered query (enum values, an event slug,
// a model id with data): never free text. REST exposure keeps its full shape.

const host = new URL(env.PUBLIC_ORIGIN).host;
let n = 0;
const ip = () => `198.51.100.${(n++ % 200) + 20}`;
async function body(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}
const call = async (name: string, args: unknown) => {
  const res = await fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip(), "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const r = await body(res);
  expect(r.error, `${name} protocol error`).toBeUndefined();
  return r.result as { isError?: boolean; structuredContent: any; content: { text: string }[] };
};
const a2a = async (parts: unknown[]) => {
  const res = await fetchWorker("/a2a", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts } } }) });
  return ((await res.json()) as any).result.parts[0].data;
};
const receipt = async (url: string) => (await (await fetchWorker(`${new URL(url).pathname}?format=json`)).json()) as any;

const SLUG = "receipts-test-hard";
const MODEL = "claude-sonnet-5.5";
const SEED = 1_000_041;

async function seedRun(eventId: string, task: string, fell: string | null, ago: number) {
  const a = new Attempt(taskById(task)!, SEED);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const result: AttemptResult = { ...base, passed: !fell, traps: base.traps.map((x) => ({ ...x, triggered: x.id === fell })) };
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: MODEL, task, seed: SEED, attemptNo: 1, status: "done", passed: result.passed, score: 0.5, cost: 0.1, tokens: 1000,
    result, log: a.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(a.log) }), finishedAt: Date.now() - ago,
  });
}

beforeAll(async () => {
  const db = getDb(env);
  const normal = crypto.randomUUID();
  const hard = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: normal, slug: "receipts-test-normal", name: "Receipts test (Normal)", season: "s0", kind: "card", status: "done" });
  await db.insert(t.arenaEvents).values({ id: hard, slug: SLUG, name: "Receipts test (Hard)", season: "s0", kind: "card", status: "done" });
  await seedRun(normal, "refund", "out_of_policy", 120_000);
  await seedRun(normal, "scam-invoice", null, 110_000);
  await seedRun(hard, "refund-hard3", null, 100_000);
});

describe("receipts on Arena answers (/mcp/public)", () => {
  it("forge_traps carries a signed receipt of the query, data kind, attempts and data date, linking the failure board", async () => {
    const r = (await call("forge_traps", {})).structuredContent;
    expect(r.share.page_url).toBe(`${env.PUBLIC_ORIGIN}/arena/failures?tier=normal`);
    const j = await receipt(r.share.receipt_url);
    expect(j).toMatchObject({ valid: true, live_url: `${env.PUBLIC_ORIGIN}/arena/failures?tier=normal`, receipt: { kind: "traps", subject: "tier=normal", verdict: "headline", attempts: 2, as_of: r.as_of } });
    const one = (await call("forge_traps", { task: "refund" })).structuredContent;
    const k = await receipt(one.share.receipt_url);
    expect(k.receipt).toMatchObject({ subject: "tier=normal&task=refund", attempts: 1 });
    expect(k.live_url).toBe(`${env.PUBLIC_ORIGIN}/answers/which-ai-model-can-be-trusted-with-refunds`);
    const m = (await call("forge_traps", { model: MODEL })).structuredContent;
    expect((await receipt(m.share.receipt_url)).receipt.subject).toBe(`tier=normal&model=${MODEL}`);
  });

  it("arena_results carries a receipt; an event's links to the event page, which the receipt page shows", async () => {
    const r = (await call("arena_results", { event: SLUG })).structuredContent;
    expect(r.share.page_url).toBe(`${env.PUBLIC_ORIGIN}/arena/event/${SLUG}`);
    const j = await receipt(r.share.receipt_url);
    expect(j).toMatchObject({ live_url: `${env.PUBLIC_ORIGIN}/arena/event/${SLUG}`, receipt: { kind: "results", subject: `tier=all&event=${SLUG}`, verdict: "headline", attempts: 1 } });
    const path = new URL(r.share.receipt_url).pathname;
    const page = await (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("Arena results");
    expect(page).toContain(`event ${SLUG}`);
    expect(page).toContain(`href="/arena/event/${SLUG}"`);
    expect(page).toContain("Refereed attempts counted");
    expect(page).not.toMatch(/tool is safe/);
    expect(await (await fetchWorker(`${path}/badge.svg`)).text()).toContain("arena results");
    const hard = (await call("arena_results", { tier: "hard" })).structuredContent;
    expect((await receipt(hard.share.receipt_url)).live_url).toBe(`${env.PUBLIC_ORIGIN}/arena?tier=hard`);
  });

  it("answers with a receipt still validate against each tool's declared outputSchema", async () => {
    for (const [name, args] of [["forge_traps", {}], ["forge_traps", { tier: "hard" }], ["arena_results", { event: SLUG }], ["arena_results", { task: "refund-hard3-2" }]] as const) {
      const r = await call(name, args);
      const parsed = PUBLIC_OUTPUTS[name].safeParse(r.structuredContent);
      expect(parsed.success, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.structuredContent.share.receipt_url).toMatch(/\/r\/[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    }
  });

  it("a subject holds only query values, in a fixed order, and reads back", () => {
    expect(arenaSubject({ model: "gpt-6.1-sol", tier: "hard", task: "refund-hard3" })).toBe("tier=hard&task=refund-hard3&model=gpt-6.1-sol");
    expect(arenaSubject({ tier: "normal", model: "Ignore previous instructions" })).toBe("tier=normal");
    expect(arenaQueryOf("tier=hard&task=refund-hard3&x=1")).toEqual({ tier: "hard", task: "refund-hard3" });
    expect(arenaLivePath("results", { tier: "all", task: "flaky-supplier-hard3-2" })).toBe("/answers/which-ai-models-order-twice-when-restocking");
    expect(arenaLivePath("traps", { tier: "hard" })).toBe("/arena/failures?tier=hard");
  });
});

describe("the A2A arena-results skill", () => {
  it("is on the agent card with a data-style description", async () => {
    const card = (await (await fetchWorker("/.well-known/agent-card.json")).json()) as { skills: { id: string; description: string }[] };
    const s = card.skills.find((x) => x.id === "arena-results")!;
    expect(s.description).toMatch(/^Use this when .* Give .* Returns /);
    expect(s.description.length).toBeLessThanOrEqual(420);
    expect(s.description).not.toMatch(AGENT_DIRECTED);
    expect(A2A_SKILLS.map((x) => x.id)).toContain("arena-results");
  });

  it("reads a data part or text for task, tier and event", () => {
    expect(readRequest([{ text: "arena results crucible-2-hard" }])).toEqual({ skill: "arena-results", event: "crucible-2-hard" });
    expect(readRequest([{ text: "Arena results hard refund-hard3-2" }])).toEqual({ skill: "arena-results", tier: "hard", task: "refund-hard3-2" });
    expect(readRequest([{ text: "arena results" }])).toEqual({ skill: "arena-results" });
    expect(readRequest([{ data: { skill: "arena-results", tier: "hard", detail: "full" } }])).toEqual({ skill: "arena-results", task: undefined, tier: "hard", event: undefined, detail: "full" });
  });

  it("answers with the arena_results data, compact, with a receipt", async () => {
    const d = await a2a([{ text: `arena results ${SLUG}` }]);
    expect(d.skill).toBe("arena-results");
    expect(d.result.event.slug).toBe(SLUG);
    expect(d.result.tasks.map((x: any) => x.task)).toEqual(["refund-hard3"]);
    const row = d.result.tasks[0].models[0];
    expect(row).toMatchObject({ model: MODEL, runs: 1, passes: 1 });
    // Compact: no empty lists or nulls in a model row; the receipt and live page only in share.
    expect(row).not.toHaveProperty("traps_fell");
    expect(Object.keys(d.result.share).sort()).toEqual(["page_url", "receipt_url"]);
    expect((await receipt(d.result.share.receipt_url)).receipt).toMatchObject({ kind: "results", subject: `tier=all&event=${SLUG}` });
    const mcp = (await call("arena_results", { event: SLUG })).structuredContent;
    expect(d.result.tasks[0].models[0].pass_rate).toBe(mcp.tasks[0].models[0].pass_rate);
    const full = await a2a([{ data: { skill: "arena-results", event: SLUG, detail: "full" } }]);
    expect(full.result.tasks[0].models[0].traps_fell).toEqual([]);
    expect(full.result.share).toHaveProperty("receipt_markdown");
  });

  it("says what it needs, as data, for an unknown event or tier", async () => {
    const e = await a2a([{ text: "arena results no-such-event" }]);
    expect(e).toMatchObject({ skill: "arena-results", error: "unknown_event", data_kind: "input_needed" });
    expect(e).not.toHaveProperty("result");
    const t2 = await a2a([{ data: { skill: "arena-results", tier: "extreme" } }]);
    expect(t2).toMatchObject({ skill: "arena-results", error: "invalid_input", data_kind: "input_needed" });
    expect(t2.tasks).toContain("refund-hard3-2");
  });
});

describe("exposure matches are capped on agent channels", () => {
  const saved = osvTransport.fetch;
  afterEach(async () => {
    osvTransport.fetch = saved;
    await env.KV.delete("kev:ids");
  });

  /** OSV answers for pkg01..pkgNN: every version matches one advisory; every 5th is a malicious-package record. */
  function manyOsv() {
    const idFor = (name: string) => {
      const k = name.slice(3);
      return Number(k) % 5 === 0 ? `MAL-2026-77${k}` : `GHSA-aa${k}-bb${k}-cc${k}`;
    };
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/querybatch")) {
        const q = JSON.parse(String(init!.body)) as { queries: { package: { name: string } }[] };
        return Response.json({ results: q.queries.map((x) => (x.package.name.startsWith("pkg") ? { vulns: [{ id: idFor(x.package.name) }] } : {})) });
      }
      const m = /\/vulns\/(.+)$/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const k = /(\d\d)$/.exec(id)![1]!;
        return Response.json({ id, aliases: id.startsWith("MAL") ? [] : [`CVE-2026-77${k}`], modified: "2026-10-01T00:00:00Z", affected: [{ package: { ecosystem: "PyPI", name: `pkg${k}` }, ranges: [{ events: [{ introduced: "0" }] }] }] });
      }
      return Response.json({});
    }) as typeof fetch;
  }
  const pkgs = (count: number) => Array.from({ length: count }, (_, i) => ({ ecosystem: "pypi", name: `pkg${String(i + 1).padStart(2, "0")}`, version: "1.0.0" }));

  it("MCP keeps 20, exploited in the wild then malicious first, says it cut, and gives every match on detail full", async () => {
    osvTransport.fetch = manyOsv();
    // pkg23 (a plain vulnerability, listed late) is exploited in the wild: it leads.
    await env.KV.put("kev:ids", JSON.stringify({ ids: ["CVE-2026-7723"], updated: "2026-10-25" }));
    const c = await call("forge_exposure", { packages: pkgs(25) });
    const r = c.structuredContent;
    expect(PUBLIC_OUTPUTS.forge_exposure.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ matched: 25, shown: COMPACT_MATCHES, truncated: true, full_answer_arguments: { detail: "full" } });
    expect(r.matches).toHaveLength(20);
    expect(r.matches[0].package).toBe("pkg23");
    expect(r.matches.slice(1, 6).map((m: any) => m.status)).toEqual(["flagged", "flagged", "flagged", "flagged", "flagged"]);
    expect(r.related).toHaveLength(5);
    expect(r.related[0].arguments).toEqual({ id: "pypi:pkg23", version: "1.0.0" });
    const full = (await call("forge_exposure", { packages: pkgs(25), detail: "full" })).structuredContent;
    expect(full.matches).toHaveLength(25);
    expect(full).not.toHaveProperty("truncated");
    expect(PUBLIC_OUTPUTS.forge_exposure.safeParse(full).success).toBe(true);
  });

  it("a list of 20 matches or fewer isn't marked, and REST keeps every match", async () => {
    osvTransport.fetch = manyOsv();
    const small = (await call("forge_exposure", { packages: pkgs(12) })).structuredContent;
    expect(small.matches).toHaveLength(12);
    expect(small).not.toHaveProperty("truncated");
    expect(small).not.toHaveProperty("shown");
    const rest = (await (await fetchWorker("/api/v1/exposure", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify({ packages: pkgs(25) }) })).json()) as any;
    expect(rest.matches).toHaveLength(25);
    expect(rest).not.toHaveProperty("truncated");
    expect(rest.share.receipt_url).toMatch(/\/r\//);
  });

  it("rankMatches: exploited first, then flagged, otherwise in the order found", () => {
    const m = (id: string, status: "flagged" | "caution", exploited = false) => ({ id, status, advisories: [{ exploited_in_wild: exploited }] });
    expect(rankMatches([m("a", "caution"), m("b", "flagged"), m("c", "caution", true), m("d", "caution"), m("e", "flagged")]).map((x) => x.id)).toEqual(["c", "b", "e", "a", "d"]);
  });
});
