import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { INSTALL_CLIENT_NAMES, INSTALL_CLIENTS, INSTALL_COUNTING_BEGAN, installClient, installIdsSeen, type InstallClient } from "../src/services/install-metrics";
import { OPS_MODE_KEY, resetOpsModeCache } from "../src/services/ops-mode";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import cliHook from "../../../packages/cli/src/hook.ts?raw";
import cliRun from "../../../packages/cli/src/run.ts?raw";
import pluginHook from "../../../integrations/claude-code-plugin/src/hooks/pre-install.ts?raw";
import actionRun from "../../../integrations/github-action/src/run.ts?raw";
import skillScanRun from "../../../integrations/skill-scan-action/src/run.ts?raw";
import { fetchWorker, profile } from "./helpers";
import "../src/index";

// Build plan 5 Nov, item 3: /admin/kpis showed 0 · 0 · 0 for every install-time client. This drives each client's
// check through the real route with the User-Agent read from that client's own source, then reads the admin table, so
// a client whose label drifts from the Worker's (or a counter that stops being written) can't show 0 while it checks.

/** The User-Agent each install-time client sends, read from its source (not copied by hand). */
function clientAgents(): Record<InstallClient, string> {
  const one = (src: string, re: RegExp, what: string) => {
    const m = re.exec(src);
    if (!m) throw new Error(`no User-Agent found in ${what}`);
    return m[1]!;
  };
  const version = one(cliRun, /export const VERSION = "([^"]+)"/, "packages/cli/src/run.ts");
  const ua = one(cliRun, /const UA = `([^`]+)`/, "packages/cli/src/run.ts").replace("${VERSION}", version);
  // `forge hook <client>` adds " (hook <client>)" (run.ts: `${UA} (hook ${client})`).
  expect(cliRun).toContain("userAgent: `${UA} (hook ${client})`");
  // The hook clients `forge hook <client>` knows (packages/cli/src/hook.ts CLIENTS): exactly the three the Worker counts.
  const block = cliHook.slice(cliHook.indexOf("export const CLIENTS = {"));
  const hooks = [...block.matchAll(/^  ([a-z]+): \{$/gm)].map((m) => m[1]!);
  expect(hooks.sort()).toEqual(["codex", "copilot", "gemini"]);
  return {
    plugin: one(pluginHook, /"User-Agent": "([^"]+)"/, "the plugin's pre-install hook"),
    cli: ua,
    "hook-codex": `${ua} (hook codex)`,
    "hook-gemini": `${ua} (hook gemini)`,
    "hook-copilot": `${ua} (hook copilot)`,
    action: one(actionRun, /: \{ Accept: "application\/json", "User-Agent": "([^"]+)" \}/, "the forge-check Action"),
    "skill-scan": one(skillScanRun, /: "(theagentforge-skill-scan\/[^"]+)"/, "the skill-scan Action"),
  };
}

let ipN = 0;
const ip = () => `203.0.113.${(++ipN % 200) + 20}`;

async function adminCookie() {
  const founder = await upsertHuman(getDb(env), profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
  return `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
}

/** The install table on /admin/kpis: per client, the checked count in the last 7 days and all time. */
async function adminTable(cookie: string) {
  const page = await (await fetchWorker("/admin/kpis", { headers: { Cookie: cookie, Accept: "text/html" } })).text();
  const rows = Object.fromEntries(
    [...page.matchAll(/<tr data-client="([a-z-]+)"[^>]*><td>[^<]*<\/td><td>([\d,]+) · [\d,]+ · [\d,]+<\/td><td>([\d,]+) · [\d,]+ · [\d,]+<\/td>/g)].map((m) => [m[1]!, { week: Number(m[2]!.replace(/,/g, "")), all: Number(m[3]!.replace(/,/g, "")) }]),
  ) as Record<string, { week: number; all: number }>;
  return { page, rows };
}

/** Counters are written after the answer (waitUntil): poll the admin table until `done`. */
async function settle(cookie: string, done: (rows: Record<string, { week: number; all: number }>) => boolean) {
  let v = await adminTable(cookie);
  for (let i = 0; i < 100 && !done(v.rows); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await adminTable(cookie);
  }
  return v;
}

describe("install checks on /admin/kpis (build plan 5 Nov, item 3)", () => {
  it("every client's real User-Agent is one the Worker counts, under its own row", () => {
    const agents = clientAgents();
    for (const c of INSTALL_CLIENTS.filter((x) => x !== "skill-scan")) expect(installClient(agents[c]), `${c}: ${agents[c]}`).toBe(c);
    // The skill-scan Action never calls a check; it is counted by its run-count endpoint, which takes the client by name.
    expect(skillScanRun).toContain('JSON.stringify({ client: "skill-scan", outcome })');
  });

  it("says what all time covers: counted from the first counted day, the start of counting and the days lost", async () => {
    const cookie = await adminCookie();
    const { page } = await adminTable(cookie);
    expect(page).toContain('data-k="install_counted_from"');
    expect(page).toContain("No install check has been counted yet.");
    expect(page).toContain(`Install counting began ${INSTALL_COUNTING_BEGAN}`);
    expect(page).toContain("2026-11-01 to 2026-11-04 not counted");
    expect(page).toContain("Nothing is backfilled.");
  });

  it("flags a client whose install IDs were seen this week while none of its checks was counted", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await getDb(env).insert(t.installIds).values({ idHash: "item3-mismatch-copilot-0000000000", client: "hook-copilot", firstDay: day, lastDay: day, ours: false });
    const cookie = await adminCookie();
    const { page } = await adminTable(cookie);
    expect(page).toContain('data-k="install_mismatch"');
    expect(page).toContain(INSTALL_CLIENT_NAMES["hook-copilot"]);
    expect(page).toMatch(/<tr data-client="hook-copilot" class="kpi-off">/);
    await getDb(env).delete(t.installIds);
  });

  it("doesn't flag a fault for install IDs last seen on days whose checks weren't counted (1-4 Nov)", async () => {
    const db = getDb(env);
    await db.insert(t.installIds).values([
      { idHash: "item3-gap-copilot-00000000000000", client: "hook-copilot", firstDay: "2026-11-02", lastDay: "2026-11-03", ours: false },
      { idHash: "item3-after-gap-cli-000000000000", client: "cli", firstDay: "2026-11-02", lastDay: "2026-11-05", ours: false },
    ]);
    const seen = await installIdsSeen(env, Date.parse("2026-11-06T12:00:00Z"));
    expect(seen["hook-copilot"]).toBeUndefined(); // last seen inside the gap: its checks were never counted
    expect(seen.cli).toBe(1); // seen again after the gap: a real fault if no check was counted
    await db.delete(t.installIds);
  });

  it("a client that sends checks never shows 0: each client's check, through the real route, shows on its row", async () => {
    const agents = clientAgents();
    const cookie = await adminCookie();
    const before = (await adminTable(cookie)).rows;
    expect(Object.keys(before).sort()).toEqual([...INSTALL_CLIENTS].sort());
    for (const c of INSTALL_CLIENTS) {
      const headers = { "User-Agent": agents[c], "CF-Connecting-IP": ip(), "forge-install-id": crypto.randomUUID() };
      const res =
        c === "skill-scan"
          ? await fetchWorker("/api/v1/install-outcome", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ client: "skill-scan", outcome: "clear" }) })
          : await fetchWorker(`/api/v1/check?id=npm:item3-${c}&version=1.0.0`, { headers });
      expect(res.status, c).toBeLessThan(300);
    }
    const after = await settle(cookie, (rows) => INSTALL_CLIENTS.every((c) => (rows[c]?.week ?? 0) > (before[c]?.week ?? 0)));
    for (const c of INSTALL_CLIENTS) {
      expect(after.rows[c]!.week - before[c]!.week, `${c} (last 7 days)`).toBe(1);
      expect(after.rows[c]!.all - before[c]!.all, `${c} (all time)`).toBe(1);
    }
    // Install IDs and checks agree, and the page now says when counting holds numbers from.
    expect(after.page).not.toContain('data-k="install_mismatch"');
    expect(after.page).toContain(`Counted from ${new Date().toISOString().slice(0, 10)}`);
  });

  it("lean mode (the cause of the 1 to 4 Nov gap) no longer stops the install counters", async () => {
    const agents = clientAgents();
    const cookie = await adminCookie();
    await env.KV.put(OPS_MODE_KEY, "lean");
    resetOpsModeCache();
    try {
      const before = (await adminTable(cookie)).rows;
      expect((await fetchWorker("/api/v1/check?id=npm:item3-lean&version=1.0.0", { headers: { "User-Agent": agents.cli, "CF-Connecting-IP": ip() } })).status).toBe(200);
      const after = await settle(cookie, (rows) => rows.cli!.week > before.cli!.week);
      expect(after.rows.cli!.week - before.cli!.week).toBe(1);
    } finally {
      await env.KV.delete(OPS_MODE_KEY);
      resetOpsModeCache();
    }
  });

  it("the outside split stays admin-only", async () => {
    expect((await fetchWorker("/admin/kpis", { headers: { Accept: "text/html" }, redirect: "manual" })).status).not.toBe(200);
    expect((await fetchWorker("/admin/stats/third-party.json")).status).toBe(403);
    const stats = (await (await fetchWorker(`/stats.json?u=item3`)).json()) as Record<string, unknown>;
    expect(JSON.stringify(stats.install ?? null)).not.toMatch(/ours|outside|by_client|ids_7d|mismatched|plugin|hook-/);
  });
});
