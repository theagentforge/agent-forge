import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adoptionClaims, jsonText, pageText } from "../src/services/adoption-wording";
import { INSTALL_RULES, installClient, installCounters, installOutcome, installTotals } from "../src/services/install-metrics";
import { upsertHuman } from "../src/services/identity";
import { getDb } from "../src/services/db";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, profile } from "./helpers";
import "../src/index";

// B2-06 (ADR 0086): install-time checks by client, gross, with what our answer meant at the install.

let ipN = 0;
const ip = () => `198.51.100.${(++ipN % 200) + 20}`;
const check = (q: string, ua: string, extra: Record<string, string> = {}) =>
  fetchWorker(`/api/v1/check?${q}&n=${++ipN}`, { headers: { "User-Agent": ua, "CF-Connecting-IP": ip(), ...extra } });

/** The counters are bumped after the answer (waitUntil), so poll until they move. */
async function settle<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 100 && !done(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await read();
  }
  return v;
}

/** ADR 0099: install rows appear on /stats once each passes 25; these tests top every row up to that (as a real client). */
async function fillInstallRows() {
  const day = new Date().toISOString().slice(0, 10);
  for (const o of ["checked", "blocked", "advisory"])
    await env.DB.prepare("INSERT INTO usage_daily (day, key, n) VALUES (?, ?, 25) ON CONFLICT(day, key) DO UPDATE SET n = max(n, 25)").bind(day, `install:${o}:action`).run();
}

const sqlFor = (key: string) => INSTALL_RULES.find((r) => r.key === key)!.reproduce.replace("<today - 6 days>", new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
const runSql = async (key: string) => Number(Object.values((await env.DB.prepare(sqlFor(key)).first<Record<string, number>>())!)[0]);

describe("B2-06: install checks by AI tools, gross", () => {
  it("tells install-time clients apart by User-Agent, and nothing else counts", () => {
    expect(installClient("theagentforge-claude-plugin")).toBe("plugin");
    expect(installClient("theagentforge-cli/0.5.1")).toBe("cli");
    expect(installClient("theagentforge-cli/0.5.1 (hook codex)")).toBe("hook-codex");
    expect(installClient("theagentforge-cli/0.5.1 (hook gemini)")).toBe("hook-gemini");
    expect(installClient("theagentforge-cli/0.5.1 (hook copilot)")).toBe("hook-copilot");
    expect(installClient("theagentforge-action/1")).toBe("action");
    expect(installClient("theagentforge-action/1 theagentforge-internal/action")).toBe("action");
    for (const ua of [undefined, "", "Mozilla/5.0", "Googlebot/2.1", "GPTBot/1.2", "curl/8.0", "theagentforge-house-tester"]) expect(installClient(ua), String(ua)).toBeNull();
    expect(installOutcome({ security_status: "flagged", forge_score: null })).toBe("blocked");
    expect(installOutcome({ security_status: "confirmed_malicious", forge_score: null })).toBe("blocked");
    expect(installOutcome({ security_status: "caution", forge_score: null, public_signals_summary: { advisories: [{ id: "GHSA-x", kind: "vulnerability" }] } })).toBe("advisory");
    expect(installOutcome({ security_status: "caution", forge_score: null })).toBeNull();
    expect(installOutcome({ security_status: "unknown", forge_score: null })).toBeNull();
    expect(installCounters("plugin", "blocked", "action")).toEqual(["install:checked:plugin", "install:blocked:plugin", "install:ours:checked:plugin", "install:ours:blocked:plugin"]);
  });

  it("a plugin check bumps checked; a flagged version also bumps blocked; an advisory bumps advisory; crawlers and page views bump neither", async () => {
    const before = await installTotals(env);
    expect((await check("id=npm:install-metrics-test-ok", "theagentforge-claude-plugin")).status).toBe(200);
    const one = await settle(() => installTotals(env), (v) => v.by_client.plugin.all_time.checked > before.by_client.plugin.all_time.checked);
    expect(one.by_client.plugin.all_time.checked - before.by_client.plugin.all_time.checked).toBe(1);
    expect(one.by_client.plugin.all_time.blocked).toBe(before.by_client.plugin.all_time.blocked);

    // litellm 1.107.0 has a malicious-package record (test/osv-fake.ts): the plugin denies it.
    expect((await check("id=pypi:litellm&version=1.107.0", "theagentforge-claude-plugin")).status).toBe(200);
    const two = await settle(() => installTotals(env), (v) => v.by_client.plugin.all_time.blocked > before.by_client.plugin.all_time.blocked);
    expect(two.by_client.plugin.all_time.blocked - before.by_client.plugin.all_time.blocked).toBe(1);
    expect(two.by_client.plugin.all_time.checked - before.by_client.plugin.all_time.checked).toBe(2);

    // A cached answer (same query again) still counts, with its outcome.
    expect((await fetchWorker("/api/v1/check?id=pypi:litellm&version=1.107.0", { headers: { "User-Agent": "theagentforge-cli/0.5.1 (hook codex)", "CF-Connecting-IP": ip() } })).status).toBe(200);
    expect((await fetchWorker("/api/v1/check?id=pypi:litellm&version=1.107.0", { headers: { "User-Agent": "theagentforge-cli/0.5.1 (hook codex)", "CF-Connecting-IP": ip() } })).status).toBe(200);
    const three = await settle(() => installTotals(env), (v) => v.by_client["hook-codex"].all_time.blocked >= before.by_client["hook-codex"].all_time.blocked + 2);
    expect(three.by_client["hook-codex"].all_time.blocked - before.by_client["hook-codex"].all_time.blocked).toBe(2);

    // lodash 4.17.20 has a CVE: caution with an advisory, not blocked.
    expect((await check("id=npm:lodash&version=4.17.20", "theagentforge-action/1")).status).toBe(200);
    const four = await settle(() => installTotals(env), (v) => v.by_client.action.all_time.advisory > before.by_client.action.all_time.advisory);
    expect(four.by_client.action.all_time.advisory - before.by_client.action.all_time.advisory).toBe(1);
    expect(four.by_client.action.all_time.blocked).toBe(before.by_client.action.all_time.blocked);

    // A crawler, a browser, a page view and an MCP session never count.
    const g = four.gross.all_time.checked;
    await check("id=npm:install-metrics-test-ok", "Googlebot/2.1");
    await check("id=pypi:litellm&version=1.107.0", "Mozilla/5.0");
    await fetchWorker("/", { headers: { "User-Agent": "GPTBot/1.2" } });
    await fetchWorker("/check?id=npm:install-metrics-test-ok", { headers: { "User-Agent": "theagentforge-claude-plugin" } });
    await new Promise((r) => setTimeout(r, 300));
    expect((await installTotals(env)).gross.all_time.checked).toBe(g);
  });

  it("our own tagged CI counts in the gross total, and apart as ours for the admin split", async () => {
    const before = await installTotals(env);
    await check("id=npm:install-metrics-ours", "theagentforge-action/1 theagentforge-internal/action", { "X-Forge-Internal": "action" });
    const after = await settle(() => installTotals(env), (v) => v.ours.all_time.checked > before.ours.all_time.checked);
    expect(after.gross.all_time.checked - before.gross.all_time.checked).toBe(1);
    expect(after.ours.all_time.checked - before.ours.all_time.checked).toBe(1);
  });

  it("the skill-scan Action's run count takes the outcome only, and refuses anything else", async () => {
    const before = await installTotals(env);
    const post = (body: unknown) => fetchWorker("/api/v1/install-outcome", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify(body) });
    expect((await post({ client: "skill-scan", outcome: "blocked", repo: "acme/x" })).status).toBe(202);
    expect((await post({ client: "skill-scan", outcome: "findings" })).status).toBe(202);
    expect((await post({ client: "skill-scan", outcome: "clear" })).status).toBe(202);
    expect((await post({ client: "plugin", outcome: "blocked" })).status).toBe(400);
    expect((await post({ client: "skill-scan", outcome: "maybe" })).status).toBe(400);
    const after = await settle(() => installTotals(env), (v) => v.by_client["skill-scan"].all_time.checked >= before.by_client["skill-scan"].all_time.checked + 3);
    const d = (o: "checked" | "blocked" | "advisory") => after.by_client["skill-scan"].all_time[o] - before.by_client["skill-scan"].all_time[o];
    expect([d("checked"), d("blocked"), d("advisory")]).toEqual([3, 1, 1]);
    // Only daily counter rows: nothing about the repository is stored anywhere.
    const rows = await env.DB.prepare("SELECT key FROM usage_daily WHERE key LIKE '%acme%'").all();
    expect(rows.results).toEqual([]);
  });

  it("/stats/rules says the skill-scan Action's run count is opt-in (off by default; ADR 0090 Amendment 1)", async () => {
    expect(INSTALL_RULES.find((r) => r.key.startsWith("install_checked"))!.counts).toMatch(/count-run: true; off by default/);
    expect(await (await fetchWorker("/stats/rules")).text()).toMatch(/off by default/);
    await fillInstallRows();
    expect(await (await fetchWorker("/stats")).text()).toContain("only where its user turned the run count on (it is off by default)");
  });

  it("/stats shows the three numbers gross with the own-agents line, /stats/rules gives each its SQL, and the SQL reproduces them", async () => {
    await fillInstallRows();
    await check("id=pypi:litellm&version=1.107.0", "theagentforge-cli/0.5.1");
    await settle(() => runSql("install_blocked_all"), (v) => v > 25);
    const totals = await installTotals(env);
    for (const o of ["checked", "blocked", "advisory"] as const) {
      expect(await runSql(`install_${o}_all`), o).toBe(totals.gross.all_time[o]);
      expect(await runSql(`install_${o}_7d`), o).toBe(totals.gross.last_7_days[o]);
    }
    const page = await (await fetchWorker(`/stats?u=${++ipN}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain('id="install"');
    for (const o of ["checked", "blocked", "advisory"]) for (const w of ["7d", "all"]) expect(page).toContain(`data-k="install_${o}_${w}"`);
    expect(page).toContain("Install checks run");
    expect(page).toContain("Installs our answer would block");
    expect(pageText(page.slice(page.indexOf('id="install"')))).toMatch(/Includes The Forge.s own test agents\./);
    const json = (await (await fetchWorker(`/stats.json?u=${++ipN}`)).json()) as { install: { includes_own_test_agents: boolean; caveat: string; items: { key: string; value: number | null }[] } };
    expect(json.install.includes_own_test_agents).toBe(true);
    expect(json.install.caveat).toBe("Includes The Forge's own test agents.");
    expect(json.install.items.find((i) => i.key === "install_checked_all")!.value).toBe(totals.gross.all_time.checked);
    const rules = await (await fetchWorker("/stats/rules")).text();
    for (const r of INSTALL_RULES) {
      expect(rules).toContain(`id="${r.key}"`);
      expect(r.label).toMatch(/included/);
      expect(r.label).not.toMatch(/outside|independent|third[- ]party|by other agents/i);
      expect(r.minimum).toBe(25); // ADR 0099
    }
    // The home band carries the gross all-time install checks.
    const live = (await (await fetchWorker(`/agents/live.json?u=${++ipN}`)).json()) as { install_checks_total: number | null };
    expect(live.install_checks_total).toBeGreaterThan(0);
    const home = await (await fetchWorker(`/?u=${++ipN}`, { headers: { Accept: "text/html" } })).text();
    expect(home).toContain('data-k="install_checks_total"');
    expect(home).toContain("install checks");
  });

  it("the outside split and per-client numbers are admin-only; no public page shows them or makes an adoption claim", async () => {
    // Our own checks on top of outside ones, so outside = gross - ours differs from the gross number.
    await check("id=npm:install-metrics-split", "theagentforge-claude-plugin");
    await check("id=npm:install-metrics-split2", "theagentforge-action/1 theagentforge-internal/action", { "X-Forge-Internal": "action" });
    const t = await settle(() => installTotals(env), (v) => v.ours.all_time.checked > 0);
    const outside = t.gross.all_time.checked - t.ours.all_time.checked;
    expect(outside).toBeGreaterThan(0);
    expect(outside).not.toBe(t.gross.all_time.checked);
    const founder = await upsertHuman(getDb(env), profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
    const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
    const admin = (await (await fetchWorker("/admin/stats/third-party.json", { headers: { Cookie: cookie } })).json()) as { install: { outside: { all_time: { checked: number } } } };
    expect(admin.install.outside.all_time.checked).toBeGreaterThanOrEqual(outside);
    const kpis = await (await fetchWorker("/admin/kpis", { headers: { Cookie: cookie, Accept: "text/html" } })).text();
    expect(kpis).toContain('data-k="install_outside"');
    expect((await fetchWorker("/admin/stats/third-party.json")).status).toBe(403);
    const stats = (await (await fetchWorker(`/stats.json?u=${++ipN}`)).json()) as Record<string, unknown>;
    expect(JSON.stringify(stats.install)).not.toMatch(/ours|outside|by_client|plugin|hook-/);
    for (const path of ["/stats", "/stats/rules", "/"]) {
      const text = pageText(await (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}u=${++ipN}`, { headers: { Accept: "text/html" } })).text());
      expect(adoptionClaims(text), path).toEqual([]);
      expect(text, path).not.toMatch(/outside install|install checks by outside|install checks from outside/i);
    }
    for (const path of ["/stats.json", "/stats/rules?format=json", "/agents/live.json"]) expect(adoptionClaims(jsonText(await (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}u=${++ipN}`)).json())), path).toEqual([]);
  });
});

describe("B2-06 review: counting edge cases", () => {
  const today = (back = 0) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  const put = (day: string, key: string, n: number) => env.DB.prepare("INSERT INTO usage_daily (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n").bind(day, key, n).run();

  it("the six /stats/rules SQL statements reproduce every number on real non-zero data, with the 7-day edge", async () => {
    const before = await installTotals(env);
    // Today, the 7th day back (inside the window) and the 8th day back (outside it), every outcome, ours on top, and
    // non-install keys that must never be picked up.
    await put(today(), "install:checked:plugin", 311);
    await put(today(), "install:blocked:plugin", 23);
    await put(today(), "install:advisory:hook-gemini", 17);
    await put(today(6), "install:checked:action", 409);
    await put(today(6), "install:advisory:action", 29);
    await put(today(7), "install:checked:cli", 503);
    await put(today(7), "install:blocked:skill-scan", 41);
    await put(today(), "install:ours:checked:action", 211);
    await put(today(), "internal:action:checks", 997);
    const t = await installTotals(env);
    const d = (w: "all_time" | "last_7_days", o: "checked" | "blocked" | "advisory") => t.gross[w][o] - before.gross[w][o];
    expect([d("all_time", "checked"), d("all_time", "blocked"), d("all_time", "advisory")]).toEqual([311 + 409 + 503, 23 + 41, 17 + 29]);
    expect([d("last_7_days", "checked"), d("last_7_days", "blocked"), d("last_7_days", "advisory")]).toEqual([311 + 409, 23, 17 + 29]);
    for (const o of ["checked", "blocked", "advisory"] as const) {
      expect(t.gross.all_time[o], o).toBeGreaterThan(0);
      expect(t.gross.last_7_days[o], o).toBeGreaterThan(0);
      expect(await runSql(`install_${o}_all`), o).toBe(t.gross.all_time[o]);
      expect(await runSql(`install_${o}_7d`), o).toBe(t.gross.last_7_days[o]);
    }
  });

  it("the outside and ours install numbers never appear on a public page or JSON, only the gross ones", async () => {
    // Distinctive values: gross = 8,123 + whatever came before; ours 2,347; outside = gross - ours.
    await put(today(), "install:checked:hook-copilot", 8_123);
    await put(today(), "install:ours:checked:hook-copilot", 2_347);
    const t = await installTotals(env);
    const outside = t.gross.all_time.checked - t.ours.all_time.checked;
    const outside7 = t.gross.last_7_days.checked - t.ours.last_7_days.checked;
    const forbidden = [...new Set([outside, outside7, t.ours.all_time.checked, t.ours.last_7_days.checked, t.by_client["hook-copilot"].all_time.checked])].filter((x) => x !== t.gross.all_time.checked && x !== t.gross.last_7_days.checked);
    for (const x of forbidden) expect(x).toBeGreaterThan(999);
    const nums = (v: unknown, out: number[] = []): number[] => {
      if (typeof v === "number") out.push(v);
      else if (Array.isArray(v)) v.forEach((x) => nums(x, out));
      else if (v && typeof v === "object") Object.values(v).forEach((x) => nums(x, out));
      return out;
    };
    const stats = (await (await fetchWorker(`/stats.json?u=${++ipN}`)).json()) as { install: { items: { key: string; value: number }[] } };
    expect(stats.install.items.find((i) => i.key === "install_checked_all")!.value).toBe(t.gross.all_time.checked);
    for (const path of ["/stats.json", "/agents/live.json", "/?format=json", "/stats/rules?format=json"]) {
      const n = nums(await (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}u=${++ipN}`)).json());
      for (const x of forbidden) expect(n, `${path} has ${x}`).not.toContain(x);
    }
    for (const path of ["/stats", "/", "/stats/rules"]) {
      const text = pageText(await (await fetchWorker(`${path}?u=${++ipN}`, { headers: { Accept: "text/html" } })).text());
      for (const x of forbidden) expect(text, `${path} has ${x}`).not.toContain(x.toLocaleString("en-US"));
    }
  });

  it("a cached answer can't be replayed past the per-address limit to inflate the counts", async () => {
    const addr = "203.0.113.77";
    const q = "/api/v1/check?id=npm:install-metrics-replay";
    const go = () => fetchWorker(q, { headers: { "User-Agent": "theagentforge-claude-plugin", "CF-Connecting-IP": addr } });
    expect((await go()).status).toBe(200);
    const start = await settle(() => installTotals(env), (v) => v.by_client.plugin.all_time.checked > 0);
    await new Promise((r) => setTimeout(r, 200));
    const base = (await installTotals(env)).by_client.plugin.all_time.checked;
    // 90 replays of the cached answer from one address within a minute: every one is answered, at most 60 are counted.
    for (let i = 0; i < 90; i++) expect((await go()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const counted = (await settle(() => installTotals(env), (v) => v.by_client.plugin.all_time.checked >= base + 60)).by_client.plugin.all_time.checked - base;
    expect(start).toBeTruthy();
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThanOrEqual(60);
  });
});
