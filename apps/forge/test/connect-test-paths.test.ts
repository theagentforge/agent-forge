import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { connectTestSeen, newTestCode, testCodeOf } from "../src/services/connect-test";
import { getDb } from "../src/services/db";
import { OPS_MODE_KEY, resetOpsModeCache } from "../src/services/ops-mode";
import { COPY_APPS, CONNECT_APPS, connectStepKeys } from "../src/web/connect";
import { connectAgent, fetchWorker } from "./helpers";
import "../src/index";

// Issue #224: /connect had 0 "Test it" passes in 79 visits. These pin every path a check of npm:forge-test-<code> can
// take to the page's tick, however the AI writes the id, and the step counters that show where people stop (ADR 0050).

const host = new URL(env.PUBLIC_ORIGIN).host;
const today = () => new Date().toISOString().slice(0, 10);
const counter = async (key: string) =>
  Number((await getDb(env).select({ n: t.usageDaily.n }).from(t.usageDaily).where(and(eq(t.usageDaily.day, today()), eq(t.usageDaily.key, key))))[0]?.n ?? 0);
const seen = async (code: string) => ((await (await fetchWorker(`/api/v1/connect-test/${code}`)).json()) as { seen: boolean }).seen;
const settle = () => new Promise((r) => setTimeout(r, 50));

const mcpHeaders = { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" };
let ipN = 10;
const nextIp = () => `198.51.100.${ipN++}`;
const publicCheck = (args: Record<string, unknown>) =>
  fetchWorker("/mcp/public", {
    method: "POST",
    headers: { ...mcpHeaders, "CF-Connecting-IP": nextIp() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forge_check", arguments: args } }),
  }).then((r) => r.text());
const a2a = (parts: unknown[]) =>
  fetchWorker("/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", messageId: "m1", parts } } }),
  }).then((r) => r.text());

afterEach(async () => {
  await env.KV.delete(OPS_MODE_KEY);
  resetOpsModeCache();
});

describe("the /connect test code, however the AI writes it (#224)", () => {
  it("reads the code from every form an AI was seen or is likely to use, and nothing else", () => {
    for (const id of [
      "npm:forge-test-ab3x9z",
      "  NPM:Forge-Test-AB3X9Z  ",
      "npm: forge-test-ab3x9z",
      "forge-test-ab3x9z",
      "npm:forge-test-ab3x9z@latest",
      "npm:forge-test-ab3x9z@1.0.0",
      "npm:forge-test-ab3x9z.",
      '"npm:forge-test-ab3x9z"',
    ])
      expect(testCodeOf({ id }), id).toBe("ab3x9z");
    for (const url of ["https://www.npmjs.com/package/forge-test-ab3x9z", "https://npmjs.com/package/forge-test-ab3x9z/v/1.0.0", "https://www.npmjs.com/package/forge-test-ab3x9z?activeTab=readme"])
      expect(testCodeOf({ url }), url).toBe("ab3x9z");
    for (const id of ["npm:forge-test-ab3x9", "npm:forge-test-ab3x9zz", "npm:express", "npm:forge-test-ab3x9z-extra", "pypi:forge-test-ab3x9z", "github.com/x/forge-test-ab3x9z"])
      expect(testCodeOf({ id }), id).toBeNull();
    expect(testCodeOf({ url: "https://evil.example/package/forge-test-ab3x9z" })).toBeNull();
    expect(testCodeOf({})).toBeNull();
  });
});

describe("every check path ticks the page and counts once (#224)", () => {
  it("public MCP forge_check: by id, odd casing and spacing, bare name, inline version, and the npm page URL", async () => {
    const before = await counter("connect:test-passed");
    const forms = (c: string) => [{ id: `npm:forge-test-${c}` }, { id: `  NPM:FORGE-TEST-${c.toUpperCase()} ` }, { id: `forge-test-${c}` }, { id: `npm:forge-test-${c}@latest` }, { url: `https://www.npmjs.com/package/forge-test-${c}` }];
    for (let i = 0; i < 5; i++) {
      const code = newTestCode();
      expect(await seen(code)).toBe(false);
      const text = await publicCheck(forms(code)[i]!);
      expect(text, JSON.stringify(forms(code)[i])).toContain("security_status");
      expect(await seen(code), JSON.stringify(forms(code)[i])).toBe(true);
    }
    expect((await counter("connect:test-passed")) - before).toBe(5);
    expect(await counter("connect:test-passed:mcp")).toBeGreaterThanOrEqual(5);
  });

  it("a second check of the same code (any path) doesn't count again", async () => {
    const code = newTestCode();
    const before = await counter("connect:test-passed");
    await publicCheck({ id: `npm:forge-test-${code}` });
    await publicCheck({ id: `npm:forge-test-${code}` });
    await fetchWorker(`/api/v1/check?id=npm:forge-test-${code}`, { headers: { "CF-Connecting-IP": nextIp() } });
    await settle();
    expect((await counter("connect:test-passed")) - before).toBe(1);
  });

  it("signed-in /mcp forge_check", async () => {
    const { token } = await connectAgent();
    const code = newTestCode();
    const before = await counter("connect:test-passed:mcp-signed-in");
    const res = await fetchWorker("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forge_check", arguments: { id: `npm:forge-test-${code}` } } }),
    });
    expect(await res.text()).toContain("security_status");
    expect(await seen(code)).toBe(true);
    expect((await counter("connect:test-passed:mcp-signed-in")) - before).toBe(1);
  });

  it("REST /api/v1/check, from the CLI and plugin too, also when the answer comes from the edge cache", async () => {
    const before = await counter("connect:test-passed:api");
    for (const ua of ["theagentforge-cli/1.4.0", "theagentforge-claude-plugin/0.9.0", "curl/8"]) {
      const code = newTestCode();
      const url = `/api/v1/check?id=npm:forge-test-${code}`;
      // A first request fills the edge cache for this URL; the tick is recorded before the cache is read.
      await (await fetchWorker(url, { headers: { "CF-Connecting-IP": nextIp(), "User-Agent": ua } })).text();
      await settle();
      expect(await seen(code), ua).toBe(true);
    }
    const cached = newTestCode();
    const url = `/api/v1/check?id=forge-test-${cached}`;
    await (await fetchWorker(url, { headers: { "CF-Connecting-IP": nextIp() } })).text();
    await env.KV.delete(`connect-test:${cached}`);
    await (await fetchWorker(url, { headers: { "CF-Connecting-IP": nextIp() } })).text();
    await settle();
    expect(await seen(cached)).toBe(true);
    expect((await counter("connect:test-passed:api")) - before).toBe(5);
  });

  it("A2A: a text message (with a full stop, or the bare name) and a check-tool data part", async () => {
    const before = await counter("connect:test-passed:a2a");
    const codes = [newTestCode(), newTestCode(), newTestCode()];
    await a2a([{ text: `Use The Agent Forge to check the tool npm:forge-test-${codes[0]}.` }]);
    await a2a([{ text: `check forge-test-${codes[1]} please` }]);
    expect(await a2a([{ data: { skill: "check-tool", id: `npm:forge-test-${codes[2]}` } }])).toContain("security_status");
    for (const c of codes) expect(await seen(c), c).toBe(true);
    expect((await counter("connect:test-passed:a2a")) - before).toBe(3);
  });

  it("the site's own check form ticks the page, but counts apart: no AI app was involved", async () => {
    const code = newTestCode();
    const passed = await counter("connect:test-passed");
    const web = await counter("connect:test-passed:web");
    await (await fetchWorker(`/check?q=npm:forge-test-${code}`, { headers: { Accept: "text/html", "CF-Connecting-IP": nextIp() } })).text();
    await settle();
    expect(await seen(code)).toBe(true);
    expect(await counter("connect:test-passed")).toBe(passed);
    expect((await counter("connect:test-passed:web")) - web).toBe(1);
    // The AI's own check of the same code afterwards is the conversion.
    await publicCheck({ id: `npm:forge-test-${code}` });
    expect((await counter("connect:test-passed")) - passed).toBe(1);
  });

  it("still ticks in lean mode, when the cost guard has switched counters off", async () => {
    await env.KV.put(OPS_MODE_KEY, "lean");
    resetOpsModeCache();
    const code = newTestCode();
    await publicCheck({ id: `npm:forge-test-${code}` });
    expect(await seen(code)).toBe(true);
    expect(await connectTestSeen(env, "../../x")).toBe(false);
  });

  it("the page polls the code it shows, uncached", async () => {
    const body = await (await fetchWorker("/connect", { headers: { Accept: "text/html" } })).text();
    const code = /data-test-code="([a-z0-9]{6})"/.exec(body)![1]!;
    expect(body).toContain(`<code id="test-prompt">Use The Agent Forge to check the tool npm:forge-test-${code}</code>`);
    expect(testCodeOf({ id: `npm:forge-test-${code}` })).toBe(code);
    const poll = await fetchWorker(`/api/v1/connect-test/${code}`);
    expect(poll.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("the /connect steps before the test (ADR 0050)", () => {
  const beacon = (q: string, headers: Record<string, string> = {}) =>
    fetchWorker(`/connect/step?${q}`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", Origin: env.PUBLIC_ORIGIN, Referer: `${env.PUBLIC_ORIGIN}/connect`, "User-Agent": "Mozilla/5.0 Chrome/140", "CF-Connecting-IP": nextIp(), ...headers } });

  it("counts tiles, copies and the code shown, by fixed names only, with no body back", async () => {
    const tile = await counter("connect:tile:claude");
    const copied = await counter("connect:copied:claude-code");
    const shown = await counter("connect:code-shown");
    for (const q of ["e=tile&app=claude", "e=copied&app=claude-code", "e=code-shown"]) {
      const res = await beacon(q);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
    await settle();
    expect((await counter("connect:tile:claude")) - tile).toBe(1);
    expect((await counter("connect:copied:claude-code")) - copied).toBe(1);
    expect((await counter("connect:code-shown")) - shown).toBe(1);
  });

  it("ignores made-up names, crawlers, other sites and our own probes", async () => {
    expect(connectStepKeys("tile", "made-up")).toEqual([]);
    expect(connectStepKeys("copied", "<script>")).toEqual([]);
    expect(connectStepKeys("visit", "claude")).toEqual([]);
    expect(connectStepKeys("tile", "developers")).toEqual(["connect:tile:developers"]);
    const before = await counter("connect:tile:gemini");
    await beacon("e=tile&app=gemini", { "User-Agent": "Googlebot/2.1" });
    await beacon("e=tile&app=gemini", { "Sec-Fetch-Site": "cross-site", Origin: "https://elsewhere.example" });
    await beacon("e=tile&app=gemini", { "X-Forge-Internal": "screens" });
    expect((await beacon("e=tile&app=nope")).status).toBe(204);
    await settle();
    expect(await counter("connect:tile:gemini")).toBe(before);
    expect(await counter("connect:tile:nope")).toBe(0);
  });

  it("the page names the app behind every install link and copy box it counts", async () => {
    const body = await (await fetchWorker("/connect", { headers: { Accept: "text/html" } })).text();
    for (const id of Object.keys(COPY_APPS)) expect(body, id).toContain(`<code id="${id}">`);
    for (const app of Object.values(COPY_APPS)) expect(CONNECT_APPS).toContain(app);
    const installs = [...body.matchAll(/data-install="([a-z-]+)"/g)].map((m) => m[1]!);
    expect(new Set(installs)).toEqual(new Set(["signed-in", "claude", "trap-card", "lmstudio", "goose", "cursor", "vscode"]));
    for (const app of installs) expect(CONNECT_APPS).toContain(app);
    const attr = /data-copy-apps="([^"]*)"/.exec(body)![1]!.replace(/&quot;|&#34;/g, '"');
    expect(JSON.parse(attr)).toEqual(COPY_APPS);
  });
});
