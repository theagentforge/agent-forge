import { Attempt, DEFAULT_CAPS, HARD3_TASKS, type TaskType } from "@forge/arena";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import registry from "../../../integrations/registry/server.json";
import { A2A_SKILLS, agentCard, gauntletPointer, readRequest } from "../src/a2a";
import { arenaResults, defaultResultsFilter, latestHardSummary } from "../src/arena/results";
import { defaultTrapsFilter, trapsData } from "../src/arena/traps";
import { HEADLINE } from "../src/arena/lineup";
import * as t from "../src/db/schema";
import { asPlainJson, sseMessages, wantsJsonOnly } from "../src/mcp-json";
import { PUBLIC_TOOLS } from "../src/mcp-public";
import { ARENA_FIRST, SERVERS } from "../src/server-info";
import { getDb } from "../src/services/db";
import { checkTool } from "../src/services/forge";
import { registryTransport } from "../src/services/registry";
import { EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// ADR 0123 (build list P1, 4 Nov 2026): the first call is worth making. Catalogs and rating bots call each tool with
// no arguments; arena_results and forge_traps now answer with the latest ranked Hard event (the home line's), with a
// data-only summary first. Also: forge_check reads an unpinned npm/PyPI package at its latest release, /mcp/public
// answers `Accept: application/json` with plain JSON, and every surface opens with the same Arena-first sentence.

const HOUR = 3_600_000;
const now = Date.now();
const MODELS = HEADLINE.filter((m) => !m.retired && !m.embargoed).map((m) => m.id).slice(0, 6);
const host = new URL(env.PUBLIC_ORIGIN).host;
const SLUG = "crucible-first-call-hard";
const NAME = "Crucible first call: Hard";

type Run = typeof t.arenaRuns.$inferInsert;
let n = 0;
function run(eventId: string, modelId: string, task: TaskType, attemptNo: number, finishedAt: number, fell = false): Run {
  let clock = 0;
  const a = new Attempt(task, 1_400_000, { caps: task.caps ?? DEFAULT_CAPS, now: () => (clock += 1000) });
  a.recordTurn({ tokensIn: 900, tokensOut: 40, cost: 0.002, latencyMs: 700, text: "ok" });
  a.call("finish", { status: "cannot_complete", summary: "Stopping." });
  const result = structuredClone(a.result!);
  result.traps = task.traps.map((x, i) => ({ ...x, triggered: fell && i === 0 })) as typeof result.traps;
  return { id: `fc-${eventId}-${n++}`, eventId, modelId, task: task.id, seed: 1_400_000, attemptNo, status: "done", passed: !fell, score: 0.4, cost: 0.01, tokens: 940, provider: "test", result, log: a.log, finishedAt: finishedAt + n };
}

beforeAll(async () => {
  const db = getDb(env);
  await db.insert(t.arenaEvents).values([
    { id: "fc-hard", slug: SLUG, name: NAME, season: "s0", kind: "card", status: "running" },
    { id: "fc-held", slug: "crucible-first-call-held", name: "Held", season: "s0", kind: "card", status: "planned" },
  ]);
  // 36 public bouts across 6 models; the first model falls 4 times, the second twice, the third once: 7 of 36.
  const falls = new Map([[MODELS[0]!, 4], [MODELS[1]!, 2], [MODELS[2]!, 1]]);
  const runs: Run[] = [];
  for (const [i, m] of MODELS.entries())
    for (let k = 0; k < 6; k++) runs.push(run("fc-hard", m, HARD3_TASKS[k % HARD3_TASKS.length]!, 1 + (k % 3), now - 20 * HOUR + i, k < (falls.get(m) ?? 0)));
  // An embargoed model falls in the same event, and a newer held event is full of falls: neither may count or show.
  runs.push(run("fc-hard", EMBARGOED.id, HARD3_TASKS[0]!, 1, now - 20 * HOUR, true), run("fc-hard", EMBARGOED.id, HARD3_TASKS[1]!, 1, now - 20 * HOUR, true));
  for (let k = 0; k < 36; k++) runs.push(run("fc-held", MODELS[k % 6]!, HARD3_TASKS[k % HARD3_TASKS.length]!, 1, now - HOUR, true));
  await db.batch(runs.map((r) => db.insert(t.arenaRuns).values(r)) as [any, ...any[]]);
});

let ipn = 0;
const ip = () => `198.51.100.${(ipn++ % 200) + 20}`;
async function rpcRaw(path: string, method: string, params: unknown, accept = "application/json, text/event-stream") {
  return fetchWorker(path, {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip(), "Content-Type": "application/json", Accept: accept, "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
async function call(name: string, args: unknown = {}) {
  const text = await (await rpcRaw("/mcp/public", "tools/call", { name, arguments: args })).text();
  const body = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  expect(body.error, name).toBeUndefined();
  return { text, isError: !!body.result.isError, data: body.result.structuredContent };
}
const a2a = async (parts: unknown[]) => {
  const res = await fetchWorker("/a2a", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts } } }) });
  return ((await res.json()) as any).result.parts[0].data;
};
const receipt = async (url: string) => (await (await fetchWorker(`${new URL(url).pathname}?format=json`)).json()) as any;
const noEmbargoed = (text: string) => {
  expect(text).not.toContain(EMBARGOED.id);
  expect(text).not.toContain("crucible-first-call-held");
};

describe("no arguments: the latest ranked Hard event, summary first", () => {
  it("arena_results answers for the event with a data-only summary as its first field", async () => {
    const r = await call("arena_results", {});
    expect(r.isError).toBe(false);
    expect(Object.keys(r.data)[0]).toBe("summary");
    expect(r.data.summary).toMatchObject({
      scope: "latest_ranked_hard_event",
      event: SLUG,
      event_name: NAME,
      tier: "hard",
      attempts: 36,
      fell: 7,
      fell_rate: 0.194,
      models: 6,
      worst_model: { model: MODELS[0], attempts: 6, fell: 4, fell_rate: 0.667 },
      fall: "trap_marked_triggered_by_referee",
      falls_url: `${env.PUBLIC_ORIGIN}/arena/event/${SLUG}/falls`,
    });
    expect(r.data.summary.ci_95).toHaveLength(2);
    // Every field of the summary is a number, an id, an enum, a date or a link: nothing an agent could take as an instruction.
    for (const v of Object.values(r.data.summary).filter((x): x is string => typeof x === "string")) expect(AGENT_DIRECTED.exec(v)?.[0] ?? null).toBeNull();
    expect(r.data).toMatchObject({ tier: "hard", data_kind: "headline", event: { slug: SLUG } });
    expect(r.data.tasks.every((x: { tier: string }) => x.tier === "hard")).toBe(true);
    noEmbargoed(r.text);
    // The receipt names the event and links its page.
    expect(r.data.share.page_url).toBe(`${env.PUBLIC_ORIGIN}/arena/event/${SLUG}`);
    expect((await receipt(r.data.share.receipt_url)).receipt).toMatchObject({ kind: "results", subject: `tier=hard&event=${SLUG}`, attempts: 36 });
  });

  it("forge_traps answers for the same event, summary first, with the same counts", async () => {
    const r = await call("forge_traps", {});
    expect(r.isError).toBe(false);
    expect(Object.keys(r.data)[0]).toBe("summary");
    expect(r.data.summary).toMatchObject({ event: SLUG, attempts: 36, fell: 7, models: 6, worst_model: { model: MODELS[0] } });
    expect(r.data).toMatchObject({ tier: "hard", data_kind: "headline", event: { slug: SLUG, url: `${env.PUBLIC_ORIGIN}/arena/event/${SLUG}` } });
    const fell = r.data.tasks.flatMap((x: { traps: { fell: number }[] }) => x.traps).reduce((s: number, x: { fell: number }) => s + x.fell, 0);
    expect(fell).toBe(7);
    noEmbargoed(r.text);
    expect((await receipt(r.data.share.receipt_url)).receipt).toMatchObject({ kind: "traps", subject: `tier=hard&event=${SLUG}` });
  });

  it("explicit arguments work exactly as before: no summary, Normal unless asked", async () => {
    const normal = await call("arena_results", { tier: "normal" });
    expect(normal.data.summary).toBeUndefined();
    expect(normal.data.tier).toBe("normal");
    const hard = await call("arena_results", { tier: "hard" });
    expect(hard.data.summary).toBeUndefined();
    expect(hard.data.event).toBeNull();
    const ev = await call("arena_results", { event: SLUG });
    expect(ev.data).toMatchObject({ tier: "all", event: { slug: SLUG } });
    expect(ev.data.summary).toBeUndefined();
    const traps = await call("forge_traps", { tier: "normal" });
    expect(traps.data.summary).toBeUndefined();
    expect(traps.data.tier).toBe("normal");
    // A model alone keeps its Normal default.
    expect((await call("forge_traps", { model: MODELS[0] })).data.tier).toBe("normal");
  });

  it("the signed-in forge_traps and A2A arena-results read the same default", async () => {
    const db = getDb(env);
    const traps = await trapsData(db, await defaultTrapsFilter(env, db), env.PUBLIC_ORIGIN);
    expect(traps.summary).toMatchObject({ event: SLUG, attempts: 36, fell: 7 });
    const res = await a2a([{ text: "arena results" }]);
    expect(res.skill).toBe("arena-results");
    expect(Object.keys(res.result)[0]).toBe("summary");
    expect(res.result.summary).toMatchObject({ event: SLUG, fell: 7, attempts: 36 });
    noEmbargoed(JSON.stringify(res));
    const hard = await a2a([{ text: "arena results hard" }]);
    expect(hard.result.summary).toBeUndefined();
  });

  it("with no ranked Hard event yet, the default stays the Normal headline (with a summary)", async () => {
    const db = getDb(env);
    const f = await defaultResultsFilter({ KV: { get: async () => ({ none: true }), put: async () => {} } as unknown as KVNamespace }, db);
    expect(f).toEqual({ summary: true });
    const r = await arenaResults(db, f, env.PUBLIC_ORIGIN);
    expect(r.tier).toBe("normal");
    expect(r.summary).toMatchObject({ scope: "normal_headline", event: null });
  });
});

describe("/security and the press release open on the same figure", () => {
  it("/security leads its Arena section with the latest ranked Hard event, and its JSON carries the summary", async () => {
    const sum = await latestHardSummary(env, getDb(env), env.PUBLIC_ORIGIN);
    expect(sum).toMatchObject({ event: SLUG, attempts: 36, fell: 7 });
    const j = (await (await fetchWorker("/security?format=json")).json()) as any;
    expect(j.arena.latest_ranked_hard).toEqual(sum);
    const html = await (await fetchWorker("/security", { headers: { Accept: "text/html" } })).text();
    const arena = html.slice(html.indexOf('id="arena"'));
    expect(arena).toContain(`In ${NAME}, the latest ranked Hard event, 7 of 36 attempts (19%) fell for a planted trap`);
    expect(arena.indexOf("data-latest-hard")).toBeLessThan(arena.indexOf("The numbers below count only"));
    noEmbargoed(html);
  });

  it("/press/2026-11 §1 opens with it, before the current-rules figure", async () => {
    const html = await (await fetchWorker(`/press/2026-11?v=${Date.now()}`, { headers: { Accept: "text/html" } })).text();
    const at = html.indexOf('data-k="arena-latest-hard"');
    expect(at).toBeGreaterThan(0);
    expect(html.slice(at, at + 400)).toContain(`In ${NAME}, the latest ranked Hard event: 7 of 36 attempts (19%) fell for a planted trap`);
    const overall = html.indexOf('data-k="arena-overall"');
    if (overall > 0) expect(at).toBeLessThan(overall);
  });
});

describe("forge_check reads an unpinned npm or PyPI package at its latest release", () => {
  const withRegistry = async <T>(latest: string | null, fn: () => Promise<T>) => {
    const was = registryTransport.fetch;
    registryTransport.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (latest && url === "https://registry.npmjs.org/lodash/latest") return Response.json({ name: "lodash", version: latest, dist: { integrity: "sha512-test" } });
      return new Response("offline", { status: 503 });
    }) as typeof fetch;
    await env.KV.delete("reglatest:npm:lodash");
    try {
      return await fn();
    } finally {
      registryTransport.fetch = was;
    }
  };

  beforeAll(async () => {
    // A tool on file whose id contains "lodash": the old answer listed it as a near-miss suggestion.
    await getDb(env).insert(t.tools).values({ id: crypto.randomUUID(), kind: "npm", canonicalId: "npm:lodash-fork-for-test" });
  });

  it("an advisory on the latest release: caution, scoped to that version, no near-miss suggestions", async () => {
    const r = await withRegistry("4.17.20", () => checkTool(env, { id: "npm:lodash" }));
    expect(r).toMatchObject({ known: false, security_status: "caution", latest_version: "4.17.20", advisory_scope: "latest_version", version: "4.17.20" });
    expect(r.public_signals_summary).toMatchObject({ version: "4.17.20", total: 1 });
    expect(r.candidates).toBeUndefined();
  });

  it("no advisory on the latest release: clear for security, still insufficient as a verdict", async () => {
    const r = await withRegistry("4.17.21", () => checkTool(env, { id: "npm:lodash" }));
    expect(r).toMatchObject({ security_status: "clear", verdict: "insufficient", latest_version: "4.17.21", advisory_scope: "latest_version" });
    expect(r.candidates).toBeUndefined();
    // Over MCP: the summary says which version and scope.
    const mcp = await withRegistry("4.17.21", () => call("forge_check", { id: "npm:lodash" }));
    expect(mcp.data.summary).toMatchObject({ security_status: "clear", version: "4.17.21", advisory_scope: "latest_version", advisories_checked: true });
    expect(mcp.data.related ?? []).not.toContainEqual(expect.objectContaining({ relation: "candidate" }));
  });

  it("registry unreachable: every version's advisories, marked some_versions, and the old suggestions", async () => {
    const r = await withRegistry(null, () => checkTool(env, { id: "npm:lodash" }));
    expect(r).toMatchObject({ security_status: "unknown", advisory_scope: "some_versions", version: null });
    expect(r.latest_version).toBeUndefined();
    expect(r.candidates?.map((c) => c.id)).toContain("npm:lodash-fork-for-test");
  });

  it("a pinned version is answered as before", async () => {
    const r = await withRegistry("4.17.21", () => checkTool(env, { id: "npm:lodash", version: "4.17.20" }));
    expect(r).toMatchObject({ security_status: "caution", asked_version: "4.17.20" });
    expect(r.latest_version).toBeUndefined();
    expect(r.advisory_scope).toBeUndefined();
  });
});

describe("/mcp/public and /mcp/gauntlet answer Accept: application/json with plain JSON", () => {
  it("reads which clients want JSON only", () => {
    for (const a of ["application/json", "application/json; charset=utf-8", "Application/JSON", "text/plain, application/json", "application/*"]) expect(wantsJsonOnly(a), a).toBe(true);
    for (const a of ["application/json, text/event-stream", "text/event-stream", "*/*", "", null, "text/html", "application/jsonl"]) expect(wantsJsonOnly(a), String(a)).toBe(false);
  });

  it("turns an event stream into its JSON-RPC response, dropping notifications and keep-alives", async () => {
    const sse = ': ping\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
    expect(sseMessages(sse)).toHaveLength(2);
    const res = await asPlainJson(new Response(sse, { headers: { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" } }));
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    const plain = new Response("{}", { status: 202 });
    expect(await asPlainJson(plain)).toBe(plain);
  });

  for (const path of ["/mcp/public", "/mcp/gauntlet"])
    it(`${path}: initialize and tools/list with Accept: application/json are 200 JSON; SSE clients still get a stream`, async () => {
      const init = await rpcRaw(path, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uptime", version: "1" } }, "application/json");
      expect(init.status).toBe(200);
      expect(init.headers.get("Content-Type")).toContain("application/json");
      const body = (await init.json()) as any;
      expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: SERVERS.find((s) => s.path === path)!.serverName } } });
      const list = await rpcRaw(path, "tools/list", {}, "application/json");
      expect(list.status).toBe(200);
      expect(((await list.json()) as any).result.tools.length).toBeGreaterThan(0);
      const sse = await rpcRaw(path, "tools/list", {});
      expect(sse.status).toBe(200);
      expect(sse.headers.get("Content-Type")).toContain("text/event-stream");
      await sse.body?.cancel();
    });

  it("a tool call over plain JSON gets the same structured answer", async () => {
    const res = await rpcRaw("/mcp/public", "tools/call", { name: "arena_results", arguments: {} }, "application/json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.structuredContent.summary.event).toBe(SLUG);
  });
});

describe("one Arena-first description everywhere, and three more A2A skills", () => {
  it("serverInfo, the Agent Card and the MCP Registry listing open with the same sentence", () => {
    expect(registry.description).toBe(ARENA_FIRST);
    for (const key of ["public", "signed-in"]) expect(SERVERS.find((s) => s.key === key)!.description.startsWith(ARENA_FIRST), key).toBe(true);
    expect(agentCard(env.PUBLIC_ORIGIN).description.startsWith(ARENA_FIRST)).toBe(true);
    const manifests = import.meta.glob<string>(["../../../public-repo/forge-mcp/plugin.json", "../../../public-repo/forge-mcp/gemini-extension.json", "../../../public-repo/forge-mcp/.cursor-plugin/plugin.json"], { eager: true, query: "?raw", import: "default" });
    for (const [f, raw] of Object.entries(manifests)) expect((JSON.parse(raw) as { description: string }).description.startsWith(ARENA_FIRST.slice(0, -1)), f).toBe(true);
  });

  it("the Agent Card lists check-exposure, watch-skills and run-gauntlet", async () => {
    const card = (await (await fetchWorker("/.well-known/agent-card.json")).json()) as { skills: { id: string }[] };
    expect(card.skills.map((s) => s.id)).toEqual(A2A_SKILLS.map((s) => s.id));
    expect(card.skills.map((s) => s.id)).toEqual(expect.arrayContaining(["check-exposure", "watch-skills", "run-gauntlet"]));
    expect(PUBLIC_TOOLS.arena_results.description).toContain("latest ranked Hard event");
  });

  it("reads the new skills from data parts and from a leading word", () => {
    expect(readRequest([{ data: { skill: "watch-skills", fingerprints: [`sha256:${"a".repeat(64)}`] } }])).toEqual({ skill: "watch-skills", fingerprints: [`sha256:${"a".repeat(64)}`] });
    expect(readRequest([{ text: `watch sha256:${"b".repeat(64)} ${"c".repeat(64)}` }])).toEqual({ skill: "watch-skills", fingerprints: [`sha256:${"b".repeat(64)}`, "c".repeat(64)] });
    expect(readRequest([{ text: "exposure litellm==1.107.0, requests==2.32.3" }])).toEqual({ skill: "check-exposure", pip_freeze: "litellm==1.107.0\nrequests==2.32.3" });
    expect(readRequest([{ text: "gauntlet sprint" }])).toEqual({ skill: "run-gauntlet", mode: "sprint" });
    expect(readRequest([{ text: "run the gauntlet" }])).toEqual({ skill: "run-gauntlet" });
    // A bare fingerprint is still a check.
    expect(readRequest([{ text: `sha256:${"d".repeat(64)}` }])).toMatchObject({ skill: "check-tool" });
  });

  it("check-exposure matches installed versions against advisories, with a receipt", async () => {
    const r = await a2a([{ data: { skill: "check-exposure", packages: [{ ecosystem: "pypi", name: "litellm", version: "1.107.0" }, { ecosystem: "npm", name: "left-pad", version: "1.3.0" }] } }]);
    expect(r.skill).toBe("check-exposure");
    expect(r.result).toMatchObject({ source: "osv", checked: 2, matched: 1 });
    expect(r.result.matches[0]).toMatchObject({ package: "litellm", status: "flagged" });
    expect(r.result.share.receipt_url).toMatch(/\/r\//);
    // The next call, in A2A terms.
    expect(r.result.related[0]).toMatchObject({ skill: "check-tool", data: { skill: "check-tool", id: "pypi:litellm", version: "1.107.0" } });
    const text = await a2a([{ text: "exposure litellm==1.107.0" }]);
    expect(text.result.matched).toBe(1);
    const none = await a2a([{ data: { skill: "check-exposure" } }]);
    expect(none).toMatchObject({ skill: "check-exposure", data_kind: "input_needed", error: "no_items" });
  });

  it("watch-skills answers per fingerprint, and asks for fingerprints when given none", async () => {
    const fp = `sha256:${"e".repeat(64)}`;
    const r = await a2a([{ data: { skill: "watch-skills", fingerprints: [fp] } }]);
    expect(r.result).toMatchObject({ checked: 1, unknown: 1, items: [{ fingerprint: fp, known: false }] });
    expect(r.result.share.receipt_url).toMatch(/\/r\//);
    expect(await a2a([{ text: "watch" }])).toMatchObject({ skill: "watch-skills", data_kind: "input_needed" });
  });

  it("run-gauntlet says where the Gauntlet runs and the call that starts it, as data", async () => {
    const r = await a2a([{ text: "gauntlet" }]);
    expect(r).toEqual({ skill: "run-gauntlet", result: gauntletPointer(env.PUBLIC_ORIGIN, "full") });
    expect(r.result).toMatchObject({ mcp_server: `${env.PUBLIC_ORIGIN}/mcp/gauntlet`, start: { tool: "gauntlet_start", arguments: {} }, jobs: 6, account_needed: false });
    const sprint = await a2a([{ data: { skill: "run-gauntlet", mode: "sprint" } }]);
    expect(sprint.result).toMatchObject({ mode: "sprint", jobs: 1, start: { arguments: { mode: "sprint" } }, http_start: { body: { mode: "sprint" } } });
    // The start call it names works on /mcp/gauntlet as given.
    const start = await rpcRaw("/mcp/gauntlet", "tools/call", { name: r.result.start.tool, arguments: r.result.start.arguments }, "application/json");
    expect(((await start.json()) as any).result.structuredContent.gauntlet_id).toMatch(/^g[0-9a-f]{32}$/);
  });
});
