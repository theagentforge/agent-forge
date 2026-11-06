import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { skillTag, skillTagKey, skillTagKeys } from "../src/services/channel-tags";
import { CHANNELS } from "../src/services/channels";
import { getDb } from "../src/services/db";
import { SITEMAP_STATIC } from "../src/web/answers";
import { GAUNTLET_CI_PATH, workflowExample } from "../src/web/gauntlet-ci";
import { ACTION_VERSION, CLIENT_TAG, USER_AGENT, readInputs, run, type Inputs, type Io } from "../../../integrations/gauntlet-action/src/run";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0135: the Gauntlet in CI. The Action's run start is tagged ?client=gh-action-gauntlet-<version> and counted on the
// channel scoreboard; nothing else about the caller is recorded. The Action itself is played here against the real
// Worker with a mocked model, so its HTTP contract with the Gauntlet is tested end to end.

const today = () => new Date().toISOString().slice(0, 10);
const count = async (key: string) => Number((await getDb(env).select({ n: t.usageDaily.n }).from(t.usageDaily).where(and(eq(t.usageDaily.day, today()), eq(t.usageDaily.key, key))))[0]?.n ?? 0);
const wait = () => new Promise((r) => setTimeout(r, 50));
const KEY = skillTagKey("gh-action-gauntlet", ACTION_VERSION, "gauntlet-start");
const MODEL_KEY = "sk-model-key-never-sent-to-forge";

/** The Action's io against the Worker: Forge calls go to fetchWorker from one runner address; model calls are mocked. */
function actionIo(ip: string, model: (n: number) => unknown, forgeCalls: string[]): { io: Io; out: Record<string, string>; md: () => string } {
  let n = 0;
  let md = "";
  const out: Record<string, string> = {};
  const io: Io = {
    fetch: (async (url: string, init: RequestInit = {}) => {
      if (url.startsWith("https://llm.test/")) {
        n++;
        return new Response(JSON.stringify({ choices: [{ message: model(n) }] }), { headers: { "Content-Type": "application/json" } });
      }
      const u = new URL(url);
      forgeCalls.push(JSON.stringify({ url, headers: init.headers, body: init.body }));
      return fetchWorker(`${u.pathname}${u.search}`, { ...init, headers: { ...(init.headers as Record<string, string>), "CF-Connecting-IP": ip } });
    }) as typeof fetch,
    log: () => {},
    command: () => {},
    summary: (s) => (md += s),
    output: (k, v) => (out[k] = v),
    sleep: async () => {},
  };
  return { io, out, md: () => md };
}

const inputs = (over: Record<string, string> = {}) => readInputs({ INPUT_MODEL: "m", "INPUT_API-KEY": MODEL_KEY, "INPUT_BASE-URL": "https://llm.test/v1", INPUT_ORIGIN: env.PUBLIC_ORIGIN, ...over }) as Inputs;

describe("the Action's tag", () => {
  it("is read as one of ours, with a plain version only", () => {
    expect(skillTag(CLIENT_TAG)).toEqual({ skill: "gh-action-gauntlet", version: ACTION_VERSION });
    expect(skillTag("gh-action-gauntlet")).toBeNull();
    expect(skillTag("gh-action-gauntlet-1.0")).toBeNull();
    expect(skillTagKeys(CLIENT_TAG, "gauntlet-start")).toEqual([KEY]);
    expect(skillTagKeys(CLIENT_TAG, "gauntlet-start", { internal: "action" })).toEqual([]);
  });

  it("has a channel row with a review date, counting exactly the key the Worker writes", () => {
    const row = CHANNELS.channels.find((c) => c.id === "github-action-gauntlet")!;
    expect(row.review).toMatch(/^2026-12-\d\d$/);
    expect(row.signals).toEqual([{ type: "counter", prefix: "skilltag:gh-action-gauntlet@", what: "calls" }]);
    expect(KEY.startsWith((row.signals[0] as { prefix: string }).prefix)).toBe(true);
    // Not listed yet: honest "not yet measured" until the release sets counted_from.
    expect(row.status).toBe("pending");
    expect(row.counted_from).toBeNull();
  });
});

describe("the Action against the Worker (mocked model)", () => {
  it("plays a Sprint end to end; the start is counted once; the key and model never reach The Forge", async () => {
    const before = await count(KEY);
    const calls: string[] = [];
    // The model reads the first tool, then finishes (a careful agent that gives up is a fine smoke run).
    const w = actionIo("198.51.100.141", (n) => (n === 1 ? { content: null, tool_calls: [{ id: "c1", function: { name: "finish", arguments: '{"status":"cannot_complete","summary":"Stopping here."}' } }] } : { content: "done" }), calls);
    const code = await run(inputs(), { repo: "acme/agent", apiUrl: "https://api.github.test", pr: null }, w.io);
    expect(w.out.verdict).toMatch(/^(pass|fail)$/);
    expect(code).toBe(w.out.verdict === "pass" ? 0 : 1);
    expect(w.out["gauntlet-id"]).toMatch(/^g[0-9a-f]{32}$/);
    expect(w.out["jobs-total"]).toBe("1");
    expect(w.md()).toContain(`${env.PUBLIC_ORIGIN}/gauntlet/r/${w.out["gauntlet-id"]}/1`);
    await wait();
    expect(await count(KEY)).toBe(before + 1);
    for (const c of calls) {
      expect(c).not.toContain(MODEL_KEY);
      expect(c).toContain(USER_AGENT.split(" ")[0]);
    }
    // Nothing about the caller is stored with the run: the public JSON and the row carry no tag.
    const id = w.out["gauntlet-id"]!;
    const pub = await (await fetchWorker(`/gauntlet/r/${id}?format=json`)).text();
    expect(pub).not.toContain("gh-action");
    const [row] = await getDb(env).select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, id));
    expect(JSON.stringify(row)).not.toContain("gh-action");
    expect(row!.mode).toBe("sprint");
  });

  it("review: a script can't inflate the count: once a day per runner address, and never from an MCP start", async () => {
    const before = await count(KEY);
    const start = (ip: string) => fetchWorker(`/api/v1/gauntlet?client=${CLIENT_TAG}`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ mode: "sprint" }) });
    for (let i = 0; i < 3; i++) expect((await start("198.51.100.150")).status).toBe(201);
    await wait();
    expect(await count(KEY)).toBe(before + 1);
    expect((await start("198.51.100.151")).status).toBe(201);
    await wait();
    expect(await count(KEY)).toBe(before + 2);
    // The Action starts over HTTP only, so the tag on an MCP start is never counted.
    const mcp = await fetchWorker(`/mcp/gauntlet?client=${CLIENT_TAG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: new URL(env.PUBLIC_ORIGIN).host, "CF-Connecting-IP": "198.51.100.152" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gauntlet_start", arguments: { mode: "sprint" } } }),
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("gauntlet_id");
    await wait();
    expect(await count(KEY)).toBe(before + 2);
  });

  it("our own repositories' runs are not counted as outside runs", async () => {
    const before = await count(KEY);
    const ours0 = await count("sprint:ours_started");
    const w = actionIo("198.51.100.142", () => ({ tool_calls: [{ id: "c1", function: { name: "finish", arguments: '{"status":"done","summary":"x"}' } }] }), []);
    await run(inputs({ GITHUB_REPOSITORY_OWNER: "theagentforge" }), { repo: "theagentforge/forge", apiUrl: "https://api.github.test", pr: null }, w.io);
    await wait();
    expect(await count(KEY)).toBe(before);
    expect(await count("sprint:ours_started")).toBe(ours0 + 1);
  });

  it("an unfinished run (the model never calls a tool) fails as incomplete and stays open", async () => {
    const w = actionIo("198.51.100.143", () => ({ content: "I'd rather chat." }), []);
    expect(await run(inputs({ "INPUT_MAX-TURNS": "2" }), { repo: "acme/agent", apiUrl: "https://api.github.test", pr: null }, w.io)).toBe(1);
    expect(w.out.verdict).toBe("incomplete");
    const st = (await (await fetchWorker(`/api/v1/gauntlet/${w.out["gauntlet-id"]}`)).json()) as { status: string };
    expect(st.status).toBe("open");
  });
});

describe("the /gauntlet/ci page", () => {
  it("renders the workflow, says it isn't released yet, and never calls a pass safe", async () => {
    const res = await fetchWorker(GAUNTLET_CI_PATH);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("theagentforge/gauntlet@v1");
    expect(page).toContain("Not released yet");
    expect(page).toContain(`?client=${CLIENT_TAG}`);
    expect(page).toContain("not a statement that an agent is safe");
    // The site footer says "not certification"; the page body itself never uses the word.
    expect(page.slice(page.indexOf("<main"), page.indexOf("</main>"))).not.toMatch(/certif/i);
    expect(workflowExample().split("\n").length).toBeLessThanOrEqual(13);
    expect(SITEMAP_STATIC).toContain(GAUNTLET_CI_PATH);
    expect(await (await fetchWorker("/gauntlet")).text()).toContain(`href="${GAUNTLET_CI_PATH}"`);
  });
});
