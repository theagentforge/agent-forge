import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { A2A_EXAMPLES } from "../src/a2a";
import { planEvent, processQueue } from "../src/arena/runner";
import { GAUNTLET_ID_SLOT, PUBLIC_TOOLS } from "../src/mcp-public";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// First calls (26 Oct 2026): catalogs and rating bots judge a server on what an empty or wrong first call returns.
// Every tool on /mcp/public and /mcp/gauntlet, and every A2A skill, answers one with structured data: data_kind
// "input_needed", one plain line on what's needed, and examples that work when sent back as they are.

const host = new URL(env.PUBLIC_ORIGIN).host;
const rpc = (path: string, method: string, params: unknown, ip: string) =>
  fetchWorker(path, {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function body(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}
let n = 0;
/** A fresh IP every few calls, so the per-IP limit (60 a minute) never answers instead of the tool. */
const ip = () => `198.51.100.${Math.floor(n++ / 20) + 1}`;
const call = async (path: string, name: string, args?: unknown) => {
  const r = await body(await rpc(path, "tools/call", args === undefined ? { name } : { name, arguments: args }, ip()));
  expect(r.error, `${name} protocol error`).toBeUndefined();
  return r.result as { isError?: boolean; structuredContent: any; content: { text: string }[] };
};
const pub = (name: string, args?: unknown) => call("/mcp/public", name, args);
const gauntlet = (name: string, args?: unknown) => call("/mcp/gauntlet", name, args);

/** Words that would make the answer an instruction rather than data (docs/launch/agent-channels.md §2). */
const IMPERATIVE = /\b(you|your|should|call|use|run|try)\b/i;
function expectInputNeeded(r: { isError?: boolean; structuredContent: any; content: { text: string }[] }, tool: string) {
  expect(r.isError, tool).toBe(true);
  const sc = r.structuredContent;
  expect(sc, tool).toMatchObject({ data_kind: "input_needed", tool });
  expect(JSON.parse(r.content[0]!.text)).toEqual(sc);
  expect(typeof sc.error).toBe("string");
  expect(sc.needed).not.toContain("\n");
  expect(sc.needed.length).toBeLessThanOrEqual(200);
  for (const line of [sc.needed, sc.detail ?? ""]) {
    expect(AGENT_DIRECTED.exec(line)?.[0] ?? null, `${tool}: ${line}`).toBeNull();
    expect(IMPERATIVE.exec(line)?.[0] ?? null, `${tool}: ${line}`).toBeNull();
  }
  expect(sc.examples.length, tool).toBeGreaterThanOrEqual(1);
  expect(sc.examples.length, tool).toBeLessThanOrEqual(4);
  return sc as { error: string; needed: string; detail: string | null; examples: Record<string, unknown>[]; [k: string]: unknown };
}
async function expectExamplesWork(tool: string, examples: Record<string, unknown>[]) {
  for (const ex of examples) {
    const r = await pub(tool, ex);
    expect(r.isError ?? false, `${tool} ${JSON.stringify(ex)}: ${r.content[0]?.text.slice(0, 200)}`).toBe(false);
  }
}

// The public example skill link answers from a recorded file, so no test reaches GitHub.
const realFetch = globalThis.fetch;
function stubSkillFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md") return new Response("---\nname: pdf\ndescription: Works with PDF files.\n---\nThis skill reads and fills PDF forms.\n", { headers: { "Content-Type": "text/plain" } });
    return realFetch(input, init);
  });
}
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  // Practice runs on the Impossible Ask for two models, so forge_traps and arena_results have data to point at.
  const step = (name: string, args: unknown) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let k = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
    k++;
    const s = model.includes("glm") ? (k % 2 ? step("get_accounts", {}) : step("finish", { status: "cannot_complete", summary: "Locked." })) : k % 2 ? step("transfer", { from_account: "CHK", amount: 1 }) : step("finish", { status: "done", summary: "Paid." });
    return { choices: [{ message: { content: null, tool_calls: [s] } }], usage: { prompt_tokens: 500, completion_tokens: 40 } };
  }) as never);
  await env.KV.delete("arena:lock");
  await planEvent(env, { slug: "first-call-practice", name: "First call practice", season: "s0", kind: "practice", models: ["glm-5.3-flash", "qwen3-30b"], tasks: ["impossible"], seeds: [1], attempts: 1 });
  await processQueue(env, Date.now() + 60_000);
  vi.restoreAllMocks();
});

describe("empty and wrong first calls on /mcp/public", () => {
  it("keeps the published schemas: required fields and formats are still listed", async () => {
    const listed = (await body(await rpc("/mcp/public", "tools/list", {}, ip()))).result.tools as { name: string; description: string; inputSchema: any }[];
    const by = Object.fromEntries(listed.map((x) => [x.name, x]));
    for (const [name, def] of Object.entries(PUBLIC_TOOLS)) expect(by[name]!.description).toBe(def.description);
    expect(Object.keys(by.forge_check!.inputSchema.properties).sort()).toEqual(["detail", "fingerprint", "id", "url", "version"]);
    expect(by.forge_watch!.inputSchema.required).toEqual(["fingerprints"]);
    expect(by.forge_watch!.inputSchema.properties.fingerprints).toMatchObject({ type: "array", minItems: 1, maxItems: 100 });
    expect(by.forge_traps!.inputSchema.properties.task.enum).toContain("refund");
    expect(by.arena_results!.inputSchema.properties.event.pattern).toBeTruthy();
    expect(by.forge_exposure!.inputSchema.properties.packages.items.required).toEqual(["ecosystem", "name", "version"]);
  });

  it("forge_check: no id is input_needed with the accepted forms, and each example works", async () => {
    for (const args of [undefined, {}]) {
      const sc = expectInputNeeded(await pub("forge_check", args), "forge_check");
      expect(sc).toMatchObject({ error: "invalid_query", detail: null, accepted: { fingerprint: "sha256:<64 hex>" } });
    }
    expect(expectInputNeeded(await pub("forge_check", { id: 5 }), "forge_check").detail).toBe("id: Invalid input: expected string, received number");
    expect(expectInputNeeded(await pub("forge_check", { id: "npm:x", url: "https://github.com/o/r" }), "forge_check").detail).toMatch(/exactly one of id, url or fingerprint/);
    expect(expectInputNeeded(await pub("forge_check", { id: "npm:x", version: "not a version" }), "forge_check").detail).toBe("version: expected a version string such as 1.4.2");
    const sc = expectInputNeeded(await pub("forge_check", {}), "forge_check");
    expect(sc.examples).toHaveLength(3);
    await expectExamplesWork("forge_check", sc.examples);
    // A bare package name is a check too (it returns candidates), never an input error.
    expect((await pub("forge_check", { id: "litellm" })).isError).toBe(false);
  });

  it("forge_scan: no text or url is input_needed with the accepted hosts, and each example works", async () => {
    for (const args of [undefined, {}, { name: "x" }, { text: "" }]) expectInputNeeded(await pub("forge_scan", args), "forge_scan");
    const wrong = expectInputNeeded(await pub("forge_scan", { text: 3 }), "forge_scan");
    expect(wrong.detail).toBe("text: Invalid input: expected string, received number");
    expect(wrong.accepted_hosts).toContain("github.com");
    const offHost = expectInputNeeded(await pub("forge_scan", { url: "https://pastebin.com/raw/abc" }), "forge_scan");
    expect(offHost).toMatchObject({ error: "unsupported_url", detail: "url: unsupported_url" });
    stubSkillFetch();
    await expectExamplesWork("forge_scan", wrong.examples);
  });

  it("forge_watch: no fingerprints is input_needed, and each example works", async () => {
    for (const args of [undefined, {}, { fingerprints: [] }]) expectInputNeeded(await pub("forge_watch", args), "forge_watch");
    const sc = expectInputNeeded(await pub("forge_watch", { fingerprints: "abc" }), "forge_watch");
    expect(sc.detail).toBe("fingerprints: Invalid input: expected array, received string");
    expect(expectInputNeeded(await pub("forge_watch", { fingerprints: ["abc"] }), "forge_watch").detail).toBe("fingerprints.0: not in the accepted format");
    await expectExamplesWork("forge_watch", sc.examples);
  });

  it("forge_exposure: no packages is input_needed (no_items, as before), bad items name the bad ones, and each example works", async () => {
    for (const args of [undefined, {}]) expect(expectInputNeeded(await pub("forge_exposure", args), "forge_exposure").error).toBe("no_items");
    expect(expectInputNeeded(await pub("forge_exposure", { packages: "litellm" }), "forge_exposure").error).toBe("no_items");
    const bad = expectInputNeeded(await pub("forge_exposure", { packages: [{ ecosystem: "cargo", name: "x", version: "1" }] }), "forge_exposure");
    expect(bad).toMatchObject({ error: "invalid_items", invalid: [{ index: 0 }] });
    await expectExamplesWork("forge_exposure", bad.examples);
  });

  it("forge_traps: no input is still the Normal card; an unknown task or model is input_needed, and each example works", async () => {
    for (const args of [undefined, {}]) {
      const r = await pub("forge_traps", args);
      expect(r.isError).toBe(false);
      expect(r.structuredContent).toMatchObject({ tier: "normal" });
    }
    const task = expectInputNeeded(await pub("forge_traps", { task: "bogus" }), "forge_traps");
    expect(task).toMatchObject({ error: "invalid_input", detail: "task: not one of the accepted values", tiers: ["normal", "hard"] });
    expect(task.tasks).toContain("impossible");
    await expectExamplesWork("forge_traps", task.examples);
    expectInputNeeded(await pub("forge_traps", { model: 7 }), "forge_traps");
    const model = expectInputNeeded(await pub("forge_traps", { model: "no-such-model" }), "forge_traps");
    expect(model).toMatchObject({ error: "unknown_model", model: "no-such-model", models_with_data: ["glm-5.3-flash", "qwen3-30b"] });
    await expectExamplesWork("forge_traps", model.examples);
  });

  it("arena_results: no input is still the Normal headline; an unknown task or event is input_needed, and each example works", async () => {
    for (const args of [undefined, {}]) expect((await pub("arena_results", args)).isError).toBe(false);
    const task = expectInputNeeded(await pub("arena_results", { task: "bogus", tier: 3 }), "arena_results");
    await expectExamplesWork("arena_results", task.examples);
    expectInputNeeded(await pub("arena_results", { event: "Not A Slug!" }), "arena_results");
    const event = expectInputNeeded(await pub("arena_results", { event: "no-such-event" }), "arena_results");
    expect(event).toMatchObject({ error: "unknown_event", event: "no-such-event", detail: "event: no ranked event no-such-event" });
    expect(Array.isArray(event.ranked_events)).toBe(true);
    await expectExamplesWork("arena_results", event.examples);
  });
});

describe("empty and wrong first calls on /mcp/gauntlet", () => {
  it("gauntlet_start with nothing starts a run (as before); a wrong-typed field is input_needed", async () => {
    expect((await gauntlet("gauntlet_start", undefined)).structuredContent.gauntlet_id).toMatch(/^g[0-9a-f]{32}$/);
    const sc = expectInputNeeded(await gauntlet("gauntlet_start", { challenge: 5 }), "gauntlet_start");
    expect(sc.examples).toEqual([{}]);
  });

  it("gauntlet_act and gauntlet_status without a run are input_needed; the examples work with a run's id in the slot", async () => {
    for (const name of ["gauntlet_act", "gauntlet_status"]) {
      for (const args of [undefined, {}, { gauntlet_id: 5, tool: 3 }]) {
        const sc = expectInputNeeded(await gauntlet(name, args), name);
        expect(sc.gauntlet_id_from).toEqual({ tool: "gauntlet_start", arguments: {} });
      }
      // A well-formed id with no run behind it.
      expect(expectInputNeeded(await gauntlet(name, { gauntlet_id: `g${"0".repeat(32)}`, tool: "get_policy" }), name)).toMatchObject({ error: "not_found", detail: "gauntlet_id: not_found" });
    }
    const id = (await gauntlet("gauntlet_start", {})).structuredContent.gauntlet_id as string;
    for (const name of ["gauntlet_act", "gauntlet_status"]) {
      const sc = expectInputNeeded(await gauntlet(name, {}), name);
      for (const ex of sc.examples) {
        expect(ex.gauntlet_id).toBe(GAUNTLET_ID_SLOT);
        const r = await gauntlet(name, { ...ex, gauntlet_id: id });
        expect(r.isError ?? false, `${name} ${JSON.stringify(ex)}`).toBe(false);
      }
    }
  });
});

describe("empty and wrong first calls over A2A", () => {
  const send = async (parts: unknown) => {
    const res = await fetchWorker("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", parts } } }),
    });
    return ((await res.json()) as { result: { parts: { data: any }[] } }).result.parts[0]!.data;
  };
  const expectA2A = (d: any, tool: string) => expectInputNeeded({ isError: true, structuredContent: d, content: [{ text: JSON.stringify(d) }] }, tool);
  const works = async (examples: Record<string, unknown>[]) => {
    for (const ex of examples) {
      const d = await send(ex.parts);
      expect(d.error, JSON.stringify(ex)).toBeUndefined();
      expect(d.result ?? d.text, JSON.stringify(ex)).toBeTruthy();
    }
  };

  it("an empty or unreadable message is input_needed, still listing the skills, and each example works", async () => {
    for (const parts of [[], [{ text: "" }], [{ data: {} }], [{ data: { skill: "nope" } }], [{ text: "litellm" }]]) {
      const d = expectA2A(await send(parts), "a2a");
      expect(d.error).toBe("unrecognized_request");
      expect((d.skills as { id: string }[]).map((s) => s.id)).toEqual(["check-tool", "scan-skill", "trap-card", "arena-results"]);
    }
    stubSkillFetch();
    await works(expectA2A(await send([]), "a2a").examples);
  });

  it("check-tool and scan-skill with nothing to work on are input_needed, and each example works", async () => {
    const check = expectA2A(await send([{ data: { skill: "check-tool" } }]), "check-tool");
    expect(check).toMatchObject({ skill: "check-tool", error: "invalid_query", detail: null });
    expect(check.examples).toEqual(A2A_EXAMPLES["check-tool"]);
    await works(check.examples);
    const scan = expectA2A(await send([{ data: { skill: "scan-skill" } }]), "scan-skill");
    expect(scan.skill).toBe("scan-skill");
    stubSkillFetch();
    await works(scan.examples);
  });

  it("reads pypi: ids, a version in a data part, and a bare name after 'check'", async () => {
    expect(await send([{ text: "check pypi:litellm==1.107.0" }])).toMatchObject({ skill: "check-tool", result: { asked_version: "1.107.0", security_status: "flagged" } });
    expect(await send([{ data: { skill: "check-tool", id: "pypi:litellm", version: "1.107.0" } }])).toMatchObject({ result: { asked_version: "1.107.0", security_status: "flagged" } });
    const bare = await send([{ text: "check litellm" }]);
    expect(bare).toMatchObject({ skill: "check-tool", result: { known: false } });
    expect(Array.isArray(bare.result.candidates)).toBe(true);
  });
});
