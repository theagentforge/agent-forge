import { env } from "cloudflare:workers";
import { TRAP_CARD_MAX_CHARS, TRAP_CHECKS, trapCardText } from "@forge/shared";
import { TASKS } from "@forge/arena";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TRAP_NAMES, trapsData } from "../src/arena/traps";
import { planEvent, processQueue } from "../src/arena/runner";
import { PUBLIC_TOOLS } from "../src/mcp-public";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

const host = new URL(env.PUBLIC_ORIGIN).host;
const publicRpc = (method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function result(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}

beforeAll(async () => {
  // Practice runs on the Impossible Ask: one model sends part of the money (falls for the trap), one taps out.
  const call = (name: string, args: unknown) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let n = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
    n++;
    const careful = model.includes("glm");
    const step = careful ? (n % 2 ? call("get_accounts", {}) : call("finish", { status: "cannot_complete", summary: "Locked." })) : n % 2 ? call("transfer", { from_account: "CHK", amount: 1 }) : call("finish", { status: "done", summary: "Paid." });
    return { choices: [{ message: { content: null, tool_calls: [step] } }], usage: { prompt_tokens: 500, completion_tokens: 40 } };
  }) as never);
  await env.KV.delete("arena:lock");
  await planEvent(env, { slug: "traps-test", name: "Traps test", season: "s0", kind: "practice", models: ["glm-5.3-flash", "qwen3-30b"], tasks: ["impossible"], seeds: [1], attempts: 1 });
  await processQueue(env, Date.now() + 60_000);
});

describe("trap card (ADR 0017 §1)", () => {
  it("is one generic card under 1,500 characters with no links, each check tied to real Arena traps", () => {
    const text = trapCardText();
    expect(text.length).toBeLessThan(TRAP_CARD_MAX_CHARS);
    expect(text).not.toMatch(/https?:|www\.|<|\]\(/);
    const traps = new Set(TASKS.flatMap((t) => t.traps.map((x) => `${t.id}/${x.id}`)));
    for (const c of TRAP_CHECKS) for (const t of c.traps) expect(traps.has(t), t).toBe(true);
    // Every Arena trap is covered by at least one check.
    for (const t of traps) expect(TRAP_CHECKS.some((c) => c.traps.includes(t)), t).toBe(true);
  });

  it("the page, .txt and .json agree, with version, hash and signature, and make no protection claims", async () => {
    const page = await (await fetchWorker("/trap-card", { headers: { Accept: "text/html" } })).text();
    const txt = await (await fetchWorker("/trap-card.txt")).text();
    const j = (await (await fetchWorker("/trap-card.json")).json()) as { text: string; sha256: string; signature: string; version: string; model_specific_lines: string };
    expect(txt).toBe(trapCardText());
    expect(j.text).toBe(txt);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(j.sha256).toBe(`sha256:${digest}`);
    expect(j.signature).toMatch(/^hmac-sha256:/);
    expect(j.model_specific_lines).toContain("Lab #3");
    expect(page).toContain(j.sha256);
    expect(page).toContain("It doesn't change your AI, it reminds it what to check. Keep your own approval step for payments.");
    expect(page).toContain("Keep your own approval step for payments.");
    for (const app of ["ChatGPT", "Claude", "Gemini", "Copilot"]) expect(page).toContain(`<h3>${app}</h3>`);
    expect(page).not.toMatch(/protects you|stops fraud|\d+\s?%/i);
  });
});

describe("forge_traps data (ADR 0017 §2)", () => {
  it("returns fall rates with n and the card version, as data only", async () => {
    const d = await trapsData(getDb(env), { task: "impossible" });
    expect(d.data_kind).toBe("practice");
    const partial = d.tasks[0]!.traps.find((t) => t.trap === "partial")!;
    expect(partial).toMatchObject({ attempts: 2, fell: 1, fall_rate: 0.5, card_checks: ["cant"] });
    const one = await trapsData(getDb(env), { task: "impossible", model: "glm-5.3-flash" });
    expect(one.tasks[0]!.traps.find((t) => t.trap === "partial")).toMatchObject({ attempts: 1, fell: 0 });
  });

  it("trap names are noun phrases, never instructions", () => {
    for (const [task, traps] of Object.entries(TRAP_NAMES)) for (const name of Object.values(traps)) expect(name, `${task}: ${name}`).toMatch(/^[A-Z][a-z]+ing\b/);
  });
});

describe("/mcp/public (ADR 0017 §3)", () => {
  it("works without signing in, read-only tools only, each annotated", async () => {
    const list = await result(await publicRpc("tools/list"));
    const tools = list.result.tools as { name: string; title: string; annotations: Record<string, boolean> }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["arena_results", "forge_check", "forge_traps"]);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    const traps = await result(await publicRpc("tools/call", { name: "forge_traps", arguments: { task: "impossible" } }));
    expect(traps.result.structuredContent.tasks[0].task).toBe("impossible");
    const results = await result(await publicRpc("tools/call", { name: "arena_results", arguments: { task: "impossible" } }));
    expect(results.result.structuredContent.tasks[0].models).toHaveLength(2);
    const check = await result(await publicRpc("tools/call", { name: "forge_check", arguments: { id: "npm:anything" } }));
    expect(check.result.structuredContent).toHaveProperty("known");
  });

  it("can't file reports, and the signed-in /mcp still needs a token", async () => {
    const r = await result(await publicRpc("tools/call", { name: "forge_report", arguments: {} }));
    expect(JSON.stringify(r)).toMatch(/not found|Unknown tool|Tool forge_report/i);
    const signedIn = await fetchWorker("/mcp", { method: "POST", headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(signedIn.status).toBe(401);
  });

  it("tool names, titles and descriptions are pinned", async () => {
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(PUBLIC_TOOLS))))].map((b) => b.toString(16).padStart(2, "0")).join("");
    // Changing what an agent reads about a tool is deliberate: update this hash in the same change, with a reason.
    expect(digest).toBe("7c61c382d963acab55e1037cef6c6fd832b81b371f3c2dd2bb086a7577256d80");
  });
});

describe("trap card use counts (daily totals, no visitor data)", () => {
  it("counts copies from the page, and plain-text and JSON downloads, into the growth stats", async () => {
    const { growthStats } = await import("../src/services/growth");
    const before = await growthStats(env);
    const res = await fetchWorker("/trap-card/copied", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" } });
    expect(res.status).toBe(204);
    await (await fetchWorker("/trap-card.txt")).text();
    await (await fetchWorker("/trap-card.json")).text();
    const after = await growthStats(env);
    expect(after.trap_card_copies_7d).toBe(before.trap_card_copies_7d + 1);
    expect(after.trap_card_downloads_7d).toBe(before.trap_card_downloads_7d + 2);
  });

  it("the Copy button pings the counter only for the trap card itself", async () => {
    const js = (await import("../public/site.js?raw")).default as string;
    expect(js).toContain('btn.getAttribute("data-copy") === "trap-card-text" && navigator.sendBeacon) navigator.sendBeacon("/trap-card/copied")');
  });
});
