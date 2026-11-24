import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { CHECK_CACHE_HEADER } from "../src/api";
import { checkKvCache } from "../src/services/forge";
import { exposureClient, exposureOutcome, INSTALL_NOT_MEASURED } from "../src/services/install-metrics";
import { statsData } from "../src/web/stats";
import { ORIGIN } from "./helpers";

// ADR 0155 (16 Nov production read: no install:* row on any day, yet one check source of kind "cli" on 5 Nov). One
// test per install-time client path, each proving the usage_daily row lands: every client's GET check (fresh, edge-
// cached and KV-cached), our own tagged calls under install:ours:*, the CLI's POST lockfile check (forge exposure, the
// path that wrote a "cli" check source and never an install count), and the skill-scan Action's run count.

const PLUGIN = "theagentforge-claude-plugin";
const CLI = "theagentforge-cli/0.9.1";
const ACTION = "theagentforge-action/1";
const ACTION_OURS = { "User-Agent": "theagentforge-action/1 theagentforge-internal/action", "X-Forge-Internal": "action" };

let n = 0;
const addr = () => `192.0.2.${(++n % 200) + 20}`;
const today = () => new Date().toISOString().slice(0, 10);

/** One request through the Worker, waiting for its waitUntil work (the counters) to finish. */
async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", addr());
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }) as never, env, ctx);
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { res, body };
}

/** Today's value of each counter key. */
async function rows(...keys: string[]) {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (await env.DB.prepare("SELECT n FROM usage_daily WHERE day = ? AND key = ?").bind(today(), k).first<{ n: number }>())?.n ?? 0;
  return out;
}

/** Runs `go` and returns how much each key moved. */
async function moved(keys: string[], go: () => Promise<unknown>) {
  const before = await rows(...keys);
  await go();
  const after = await rows(...keys);
  return Object.fromEntries(keys.map((k) => [k, after[k]! - before[k]!]));
}

const exposure = (packages: unknown[], headers: Record<string, string>) =>
  call("/api/v1/exposure", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ packages }) });

describe("ADR 0155: every install-time client path writes its usage_daily row", () => {
  it("GET /api/v1/check, fresh answer: plugin, CLI and each CLI hook add one install:checked row each", async () => {
    for (const [ua, client] of [
      [PLUGIN, "plugin"],
      [CLI, "cli"],
      [`${CLI} (hook codex)`, "hook-codex"],
      [`${CLI} (hook gemini)`, "hook-gemini"],
      [`${CLI} (hook copilot)`, "hook-copilot"],
      [ACTION, "action"],
    ] as const) {
      const d = await moved([`install:checked:${client}`, `install:ours:checked:${client}`], async () => {
        const { res } = await call(`/api/v1/check?id=npm:paths-fresh-${client}`, { headers: { "User-Agent": ua } });
        expect(res.status, client).toBe(200);
      });
      expect(d, client).toEqual({ [`install:checked:${client}`]: 1, [`install:ours:checked:${client}`]: 0 });
    }
  });

  it("GET /api/v1/check, edge-cached answer: counted once per check, with its outcome", async () => {
    const q = "/api/v1/check?id=pypi:litellm&version=1.107.0&paths=edge";
    await call(q, { headers: { "User-Agent": "curl/8.0" } }); // fills the edge cache; not an install client
    const d = await moved(["install:checked:cli", "install:blocked:cli"], async () => {
      const { res } = await call(q, { headers: { "User-Agent": CLI } });
      expect(res.status).toBe(200);
    });
    expect(d).toEqual({ "install:checked:cli": 1, "install:blocked:cli": 1 });
  });

  it("GET /api/v1/check, KV-cached answer (ADR 0154): counted once, with its outcome", async () => {
    checkKvCache.enabled = true;
    try {
      // The same question with its keys in another order: a different edge-cache entry, the same KV entry.
      await call("/api/v1/check?id=pypi:litellm&version=1.107.0", { headers: { "User-Agent": "curl/8.0" } });
      const d = await moved(["install:checked:plugin", "install:blocked:plugin"], async () => {
        const { res } = await call("/api/v1/check?version=1.107.0&id=pypi:litellm", { headers: { "User-Agent": PLUGIN } });
        expect(res.status).toBe(200);
        expect(res.headers.get(CHECK_CACHE_HEADER)).toBe("kv");
      });
      expect(d).toEqual({ "install:checked:plugin": 1, "install:blocked:plugin": 1 });
    } finally {
      checkKvCache.enabled = false;
    }
  });

  it("GET /api/v1/check from our own tagged Action: gross and install:ours:*", async () => {
    const d = await moved(["install:checked:action", "install:ours:checked:action"], async () => {
      expect((await call("/api/v1/check?id=npm:paths-ours", { headers: ACTION_OURS })).res.status).toBe(200);
    });
    expect(d).toEqual({ "install:checked:action": 1, "install:ours:checked:action": 1 });
  });

  it("POST /api/v1/exposure from the CLI (forge exposure): one install:checked:cli-exposure per request, with its outcome", async () => {
    const keys = ["install:checked:cli-exposure", "install:blocked:cli-exposure", "install:advisory:cli-exposure", "install:checked:cli"];
    // A lockfile with a malicious-package match (test/osv-fake.ts): one count for the request, not one per package.
    const blocked = await moved(keys, async () => {
      const { res, body } = await exposure(
        [
          { ecosystem: "pypi", name: "litellm", version: "1.107.0" },
          { ecosystem: "npm", name: "lodash", version: "4.17.20" },
          { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
        ],
        { "User-Agent": CLI },
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({ matched: 2 }); // the answer itself is unchanged
    });
    expect(blocked).toEqual({ "install:checked:cli-exposure": 1, "install:blocked:cli-exposure": 1, "install:advisory:cli-exposure": 0, "install:checked:cli": 0 });

    const advisory = await moved(keys, async () => {
      expect((await exposure([{ ecosystem: "npm", name: "lodash", version: "4.17.20" }], { "User-Agent": CLI })).res.status).toBe(200);
    });
    expect(advisory).toEqual({ "install:checked:cli-exposure": 1, "install:blocked:cli-exposure": 0, "install:advisory:cli-exposure": 1, "install:checked:cli": 0 });
  });

  it("POST /api/v1/exposure: our tagged calls go under install:ours:*; other callers and invalid requests add no install row", async () => {
    const keys = ["install:checked:cli-exposure", "install:ours:checked:cli-exposure"];
    const ours = await moved(keys, async () => {
      expect((await exposure([{ ecosystem: "npm", name: "left-pad", version: "1.3.0" }], { "User-Agent": `${CLI} theagentforge-internal/ci`, "X-Forge-Internal": "ci" })).res.status).toBe(200);
    });
    expect(ours).toEqual({ "install:checked:cli-exposure": 1, "install:ours:checked:cli-exposure": 1 });

    const none = await moved(keys, async () => {
      expect((await exposure([{ ecosystem: "npm", name: "left-pad", version: "1.3.0" }], { "User-Agent": "curl/8.0" })).res.status).toBe(200);
      expect((await exposure([{ ecosystem: "cargo", name: "x", version: "1" }], { "User-Agent": CLI })).res.status).toBe(400);
      expect((await exposure([], { "User-Agent": CLI })).res.status).toBe(400);
    });
    expect(none).toEqual({ "install:checked:cli-exposure": 0, "install:ours:checked:cli-exposure": 0 });
  });

  it("POST /api/v1/install-outcome (skill-scan Action): one run count", async () => {
    const d = await moved(["install:checked:skill-scan", "install:blocked:skill-scan"], async () => {
      const { res } = await call("/api/v1/install-outcome", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "theagentforge-skill-scan/1" }, body: JSON.stringify({ client: "skill-scan", outcome: "blocked" }) });
      expect(res.status).toBe(202);
    });
    expect(d).toEqual({ "install:checked:skill-scan": 1, "install:blocked:skill-scan": 1 });
  });

  it("Dinike, 16 Nov: no public page or public JSON carries an install-check figure; /admin/kpis and the data room do", async () => {
    // Well past every public minimum, with numbers that can't occur by chance on these pages.
    for (const [k, v] of [["install:checked:cli", 4321], ["install:blocked:cli", 1234], ["install:advisory:cli", 2345], ["install:checked:cli-exposure", 3456]] as const)
      await env.DB.prepare("INSERT INTO usage_daily (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = excluded.n").bind(today(), k, v).run();
    const figures = /4,?321|1,?234|2,?345|3,?456|7,?777/;
    const pub = ["/", "/?format=json", "/stats", "/stats?format=json", "/stats.json", "/stats/rules", "/stats/rules?format=json", "/api/v1/stats", "/agents/live.json", "/about", "/dataset", "/llms.txt"];
    for (const p of pub) {
      const { res, body } = await call(`${p}${p.includes("?") ? "&" : "?"}__adr0155=1`, { headers: { Accept: p.includes("json") || p.startsWith("/api") ? "application/json" : "text/html" } });
      expect(res.status, p).toBeLessThan(400);
      expect(body, p).not.toMatch(figures);
      // (The House's nightly install *test* rows, data-k="install_test_*", are a different thing and stay public.)
      const hit = /install_checks_total|"install":\s*\{|install_(checked|blocked|advisory)_(7d|all)|Install checks by AI tools|install checks<|cli-exposure/.exec(body);
      expect(hit && body.slice(Math.max(0, hit.index - 60), hit.index + 120), p).toBeNull();
    }
    const sum = Number((await env.DB.prepare("SELECT sum(n) AS n FROM usage_daily WHERE key LIKE 'install:checked:%'").first<{ n: number }>())!.n);
    expect(sum).toBeGreaterThan(7000); // the gross total exists, it just isn't published
    // Founder-only: the data room's stats (allRows) still carry the install rows.
    const room = await statsData(env, { allRows: true });
    expect(room.install?.items.find((i) => i.key === "install_checked_all")?.value).toBe(sum);
  });

  it("the helpers: only the CLI's User-Agent is a lockfile client, and the outcome follows forge exposure's exit rule", () => {
    expect(exposureClient(CLI)).toBe("cli-exposure");
    for (const ua of [PLUGIN, ACTION, `${CLI} (hook codex)`, "curl/8.0", undefined]) expect(exposureClient(ua), String(ua)).toBeNull();
    expect(exposureOutcome({ matches: [{ status: "caution" }, { status: "flagged" }] })).toBe("blocked");
    expect(exposureOutcome({ matches: [{ status: "caution" }] })).toBe("advisory");
    expect(exposureOutcome({ matches: [] })).toBeNull();
    // The paths not measured before their fix are listed, so earlier zeros there read "not measured".
    expect(INSTALL_NOT_MEASURED.map((g) => g.path)).toEqual(["POST /api/v1/exposure (CLI forge exposure)", "GET /api/v1/check, fresh answers (every check client)"]);
  });
});
