import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { PLANS } from "@forge/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import worker from "../src/index";
import { PUBLIC_OUTPUTS, rateLimitedOutput } from "../src/mcp-output";
import { anonymousLimited, createKey, effectivePlan, flushApiUsage, generateKey, pricingMode, resetApiKeyState } from "../src/services/api-keys";
import { getDb } from "../src/services/db";
import { RATE_LIMITED } from "../src/services/errors";
import { upsertHuman } from "../src/services/identity";
import { PRICING_WORDS } from "../src/web/pricing";
import { csrfToken, newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, profile } from "./helpers";

// ADR 0110: optional API keys (PRICING_MODE keys in wrangler.jsonc, so these tests run in keys mode unless they pass
// their own env). Anonymous use must not change.

beforeEach(() => resetApiKeyState());
afterEach(() => vi.restoreAllMocks());

const randFp = () => `sha256:${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
let ipN = 0;
const freshIp = () => `198.51.100.${(ipN++ % 200) + 20}`;

async function owner(tier: "verified" | "sandbox" = "verified") {
  const db = getDb(env);
  const h = await upsertHuman(db, profile(), Date.now());
  if (tier === "sandbox") await db.update(t.humans).set({ tier: "sandbox", verifiedVia: null }).where(eq(t.humans.id, h.id));
  const token = await newSession(env.SESSION_SECRET, h.id);
  return { human: h, cookie: `${SESSION_COOKIE}=${token}`, csrf: await csrfToken(env.SESSION_SECRET, token) };
}

async function csrfOf(cookie: string, path = "/dashboard/keys") {
  const body = await (await fetchWorker(path, { headers: { Cookie: cookie } })).text();
  return /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? "";
}

const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetchWorker(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });

const check = (key?: string, f = randFp(), ip = freshIp()) =>
  fetchWorker(`/api/v1/check?fingerprint=${f}`, { headers: { "CF-Connecting-IP": ip, ...(key ? { Authorization: `Bearer ${key}` } : {}) } });

/** Counts are written in the background after a response; wait until the row shows what was served. */
async function usageRow(keyId: string, want: (r: { n: number; n429: number }) => boolean) {
  for (let i = 0; i < 40; i++) {
    await flushApiUsage(env);
    const rows = await getDb(env).select().from(t.apiUsageDaily).where(eq(t.apiUsageDaily.keyId, keyId));
    if (rows.length === 1 && want(rows[0]!)) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getDb(env).select().from(t.apiUsageDaily).where(eq(t.apiUsageDaily.keyId, keyId));
}

async function withEnv(e: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, init) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("API keys: lifecycle", () => {
  it("a verified owner creates a key, sees it once, it is stored only as a hash, and revoking it refuses calls", async () => {
    const { human, cookie } = await owner();
    const csrf = await csrfOf(cookie);
    const created = await post("/dashboard/keys", cookie, { csrf, name: "CI runner" });
    expect(created.status).toBe(200);
    const page = await created.text();
    const key = /forge_sk_[0-9A-Za-z]{32}/.exec(page)?.[0];
    expect(key).toBeTruthy();
    expect(page).toContain("shown only once");

    const rows = await getDb(env).select().from(t.apiKeys).where(eq(t.apiKeys.humanId, human.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prefix).toBe(key!.slice(0, 12));
    expect(JSON.stringify(rows)).not.toContain(key!);
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);

    // Shown once: the keys page afterwards lists the prefix, never the key.
    const again = await (await fetchWorker("/dashboard/keys", { headers: { Cookie: cookie } })).text();
    expect(again).not.toContain(key!);
    expect(again).toContain(`${key!.slice(0, 12)}…`);

    const ok = await check(key);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("X-Forge-Plan")).toBe("free");
    expect(ok.headers.get("X-Forge-Quota-Limit")).toBe(String(PLANS.free.perMonth));
    expect(Number(ok.headers.get("X-Forge-Quota-Reset"))).toBeGreaterThan(Date.now() / 1000);
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");

    const revoke = await post("/dashboard/keys/revoke", cookie, { csrf, id: rows[0]!.id });
    expect(revoke.status).toBe(303);
    const refused = await check(key);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "invalid_api_key", docs_url: `${env.PUBLIC_ORIGIN}/pricing` });
  });

  it("creating and revoking need the session's CSRF token and our own Origin; nobody can revoke another owner's key", async () => {
    const a = await owner();
    const b = await owner();
    const form = (cookie: string, fields: Record<string, string>, origin?: string) =>
      fetchWorker("/dashboard/keys", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}) }, body: new URLSearchParams(fields), redirect: "manual" });
    expect((await form(a.cookie, { name: "no token" })).status).toBe(403);
    expect((await form(a.cookie, { csrf: b.csrf, name: "their token" })).status).toBe(403);
    expect((await form(a.cookie, { csrf: a.csrf, name: "cross-site" }, "https://evil.example")).status).toBe(403);
    expect(await getDb(env).select().from(t.apiKeys).where(eq(t.apiKeys.humanId, a.human.id))).toHaveLength(0);
    // The page that shows the key once is never stored by a cache.
    const made = await form(a.cookie, { csrf: a.csrf, name: "real" });
    expect(made.status).toBe(200);
    expect(made.headers.get("Cache-Control")).toBe("no-store");
    const key = /forge_sk_[0-9A-Za-z]{32}/.exec(await made.text())![0];
    const [row] = await getDb(env).select().from(t.apiKeys).where(eq(t.apiKeys.humanId, a.human.id));
    expect((await post("/dashboard/keys/revoke", a.cookie, { id: row!.id })).status).toBe(403);
    // B's own valid token can't revoke A's key: the revoke is scoped to the signed-in owner.
    await post("/dashboard/keys/revoke", b.cookie, { csrf: b.csrf, id: row!.id });
    expect((await getDb(env).select().from(t.apiKeys).where(eq(t.apiKeys.id, row!.id)))[0]!.revokedAt).toBeNull();
    expect((await check(key)).status).toBe(200);
  });

  it("people in the sandbox can't create keys, and see why in /connect's words", async () => {
    const { human, cookie, csrf } = await owner("sandbox");
    expect(await createKey(env, human.id, "x")).toEqual({ ok: false, reason: "not_verified" });
    const page = await (await fetchWorker("/dashboard/keys", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("starts in the sandbox until someone vouches for you");
    const res = await post("/dashboard/keys", cookie, { csrf, name: "nope" });
    expect(res.headers.get("Location")).toBe("/dashboard/keys?m=not_verified");
    expect(await getDb(env).select().from(t.apiKeys).where(eq(t.apiKeys.humanId, human.id))).toHaveLength(0);
  });

  it("the free plan allows two active keys, and a key needs a short name", async () => {
    const { human } = await owner();
    expect((await createKey(env, human.id, "")).ok).toBe(false);
    expect((await createKey(env, human.id, "x".repeat(41))).ok).toBe(false);
    expect((await createKey(env, human.id, "one")).ok).toBe(true);
    expect((await createKey(env, human.id, "two")).ok).toBe(true);
    expect(await createKey(env, human.id, "three")).toEqual({ ok: false, reason: "key_limit" });
  });

  it("keys are forge_sk_ and 32 base62 characters, and a made-up key is refused, never served anonymously", async () => {
    const keys = new Set(Array.from({ length: 50 }, generateKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^forge_sk_[0-9A-Za-z]{32}$/);
    const res = await check(generateKey());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_api_key" });
  });
});

describe("API keys: anonymous use is unchanged", () => {
  it("no key: no plan headers; another kind of Bearer token keeps the anonymous path", async () => {
    const res = await check();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Forge-Plan")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const oauth = await check("gho_not_a_forge_key");
    expect(oauth.status).toBe(200);
    expect(oauth.headers.get("X-Forge-Plan")).toBeNull();
  });

  it("the per-IP 429 keeps error and retry_after_s and adds the upgrade object as data", async () => {
    vi.spyOn(env.CHECK_LIMITER, "limit").mockResolvedValue({ success: false });
    const res = await check();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const b = (await res.json()) as any;
    expect(b).toMatchObject({ error: "rate_limited", retry_after_s: 60, reason: "per_ip_minute", limit: { plan: "anonymous", per_minute: 60 } });
    expect(b.limit.used_this_month).toBeUndefined();
    expect(b.upgrade).toEqual({ url: `${env.PUBLIC_ORIGIN}/pricing`, keys_url: `${env.PUBLIC_ORIGIN}/dashboard/keys`, plans: ["team", "volume"], paid_plans: "coming_soon", free_key: { per_minute: 120, per_month: 20000 } });
    expect(JSON.stringify(b)).not.toMatch(/\b(tell|ask|you should|please)\b/i);
    for (const path of ["/api/v1/watch", "/api/v1/exposure"]) {
      const r = await fetchWorker(path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp() }, body: "{}" });
      expect(r.status, path).toBe(429);
      expect(await r.json(), path).toMatchObject({ reason: "per_ip_minute" });
    }
  });

  it("no environment is set to paid in wrangler.jsonc: checkout needs a deliberate change (Dinike's needs-dinike approval)", async () => {
    const cfg = (await import("../wrangler.jsonc?raw" as string)).default as string;
    const modes = [...cfg.matchAll(/"PRICING_MODE":\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(modes.length).toBeGreaterThanOrEqual(2);
    for (const m of modes) expect(["off", "keys"]).toContain(m);
    // An unknown or misspelt value is "off", never "paid".
    expect(pricingMode({ PRICING_MODE: "Paid" } as never)).toBe("off");
    expect(pricingMode({ PRICING_MODE: "paid " } as never)).toBe("off");
    expect(pricingMode({} as never)).toBe("off");
  });

  it("PRICING_MODE off: no pages, keys ignored, the old 429 body exactly", async () => {
    const off = { ...env, PRICING_MODE: "off" } as unknown as Env;
    expect((await withEnv(off, "/pricing")).status).toBe(404);
    expect((await withEnv(off, "/dashboard/keys")).status).toBe(404);
    const keyed = await withEnv(off, `/api/v1/check?fingerprint=${randFp()}`, { headers: { Authorization: `Bearer ${generateKey()}`, "CF-Connecting-IP": freshIp() } });
    expect(keyed.status).toBe(200);
    expect(keyed.headers.get("X-Forge-Plan")).toBeNull();
    expect(anonymousLimited(off)).toEqual(RATE_LIMITED);
    // (Query strings keep these off-mode pages out of the page cache the other tests read.)
    expect(await (await withEnv(off, "/teams?mode=off")).text()).not.toContain('href="/pricing"');
    expect(await (await withEnv(off, "/connect?mode=off")).text()).not.toContain('href="/pricing"');
  });
});

describe("API keys: metering", () => {
  it("cached answers count; counts reach D1 in one batched row per key and day", async () => {
    const { human } = await owner();
    const k = await createKey(env, human.id, "meter");
    if (!k.ok) throw new Error(k.reason);
    const f = randFp();
    const first = await check(k.key, f);
    const second = await check(k.key, f); // same URL: a cache hit
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Forge-Quota-Remaining")).toBe(String(PLANS.free.perMonth! - 2));
    // The cached copy stays anonymous: no key headers leak to callers without a key.
    const anon = await check(undefined, f);
    expect(anon.headers.get("X-Forge-Plan")).toBeNull();
    const rows = await usageRow(k.id, (r) => r.n === 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ humanId: human.id, n: 2, n429: 0, day: new Date().toISOString().slice(0, 10) });
    const key = await getDb(env).query.apiKeys.findFirst({ where: eq(t.apiKeys.id, k.id) });
    expect(key?.lastUsedAt).toBeGreaterThan(0);
  });

  it("the monthly quota stops calls with a 429 that says why, when it resets and what is used", async () => {
    const { human } = await owner();
    const k = await createKey(env, human.id, "quota");
    if (!k.ok) throw new Error(k.reason);
    await getDb(env).insert(t.apiUsageDaily).values({ keyId: k.id, humanId: human.id, day: new Date().toISOString().slice(0, 10), n: PLANS.free.perMonth!, n429: 0 });
    const res = await check(k.key);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-Forge-Quota-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const b = (await res.json()) as any;
    expect(b).toMatchObject({ error: "rate_limited", reason: "monthly_quota", limit: { plan: "free", per_minute: 120, per_month: 20000, used_this_month: 20000 } });
    expect(new Date(b.limit.resets_at).getUTCDate()).toBe(1);
    expect(b.upgrade).toMatchObject({ plans: ["team", "volume"], paid_plans: "coming_soon" });
    expect(rateLimitedOutput.safeParse(b).success).toBe(true);
    const [row] = await usageRow(k.id, (r) => r.n429 === 1);
    expect(row?.n429).toBe(1);
  });

  it("the per-key minute limit uses the plan's own limiter, keyed by key id, never the IP", async () => {
    const { human } = await owner();
    const k = await createKey(env, human.id, "minute");
    if (!k.ok) throw new Error(k.reason);
    const ip = vi.spyOn(env.CHECK_LIMITER, "limit");
    const spy = vi.spyOn(env.KEY_FREE_LIMITER, "limit").mockResolvedValue({ success: false });
    const res = await check(k.key);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ reason: "per_key_minute", limit: { plan: "free" } });
    expect(spy).toHaveBeenCalledWith({ key: `key:${k.id}` });
    expect(ip.mock.calls.some(([a]) => (a as { key: string }).key.startsWith("ip:"))).toBe(false);
  });

  it("the public MCP tools are metered per key and return the same 429 data as an error result", async () => {
    const { human } = await owner();
    const k = await createKey(env, human.id, "mcp");
    if (!k.ok) throw new Error(k.reason);
    const rpc = (args: unknown, key: string) =>
      fetchWorker("/mcp/public", {
        method: "POST",
        headers: { Host: new URL(env.PUBLIC_ORIGIN).host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Authorization: `Bearer ${key}`, "CF-Connecting-IP": freshIp() },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forge_check", arguments: args } }),
      });
    const parse = async (r: Response) => {
      const text = await r.text();
      if (!text.includes('"result"')) throw new Error(`${r.status} ${text.slice(0, 300)}`);
      return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)).result;
    };
    const ok = await parse(await rpc({ fingerprint: randFp() }, k.key));
    expect(ok.isError).toBe(false);
    await getDb(env).insert(t.apiUsageDaily).values({ keyId: k.id, humanId: human.id, day: new Date().toISOString().slice(0, 10), n: PLANS.free.perMonth!, n429: 0 }).onConflictDoUpdate({ target: [t.apiUsageDaily.keyId, t.apiUsageDaily.day], set: { n: PLANS.free.perMonth! } });
    resetApiKeyState();
    const limited = await parse(await rpc({ fingerprint: randFp() }, k.key));
    expect(limited.isError).toBe(true);
    expect(limited.structuredContent).toMatchObject({ error: "rate_limited", reason: "monthly_quota", upgrade: { url: `${env.PUBLIC_ORIGIN}/pricing` } });
    expect(PUBLIC_OUTPUTS.forge_check.safeParse(limited.structuredContent).success).toBe(true);
    const bad = await rpc({ fingerprint: randFp() }, generateKey());
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "invalid_api_key" });
  });
});

describe("plans in effect", () => {
  const now = Date.UTC(2026, 10, 15);
  const day = 86_400_000;
  it("active until the period end plus 3 days; canceled until the paid period ends; revoked never", () => {
    expect(effectivePlan([], now)).toBe("free");
    expect(effectivePlan([{ plan: "team", status: "active", currentPeriodEnd: now + day, endedAt: null }], now)).toBe("team");
    expect(effectivePlan([{ plan: "team", status: "active", currentPeriodEnd: now - 2 * day, endedAt: null }], now)).toBe("team");
    expect(effectivePlan([{ plan: "team", status: "active", currentPeriodEnd: now - 4 * day, endedAt: null }], now)).toBe("free");
    expect(effectivePlan([{ plan: "volume", status: "canceled", currentPeriodEnd: now + day, endedAt: null }], now)).toBe("volume");
    expect(effectivePlan([{ plan: "volume", status: "canceled", currentPeriodEnd: now - 1, endedAt: null }], now)).toBe("free");
    expect(effectivePlan([{ plan: "volume", status: "revoked", currentPeriodEnd: now + day, endedAt: now - 1 }], now)).toBe("free");
    expect(effectivePlan([{ plan: "team", status: "active", currentPeriodEnd: null, endedAt: null }, { plan: "volume", status: "active", currentPeriodEnd: now + day, endedAt: null }], now)).toBe("volume");
  });
});

describe("/pricing", () => {
  it("reads plans.ts, says what is free word for word, and shows no checkout outside paid mode", async () => {
    const res = await fetchWorker("/pricing");
    expect(res.status).toBe(200);
    const page = await res.text();
    for (const w of [PRICING_WORDS.heading, PRICING_WORDS.free, PRICING_WORDS.sameAnswers, PRICING_WORDS.notSafe, PRICING_WORDS.noSla, PRICING_WORDS.comingSoon]) expect(page).toContain(w.replace(/'/g, "&#39;"));
    expect(page).toContain("US$29 a month or US$290 a year");
    expect(page).toContain("US$199 a month or US$1,990 a year");
    expect(page).toContain("250,000");
    expect(page).toContain("3,000,000");
    expect(page).toMatch(/<meta name="robots" content="noindex/);
    expect(page).not.toContain("/billing/checkout");
    expect(page).not.toMatch(/\bBuy\b/);
    expect(page).not.toMatch(/card number|cvc|<input[^>]+name="card/i);
    const j = (await (await fetchWorker("/pricing?format=json")).json()) as any;
    expect(j.plans.map((p: any) => [p.id, p.per_month, p.price_month_usd])).toEqual(Object.values(PLANS).map((p) => [p.id, p.perMonth, p.priceMonthUsd]));
    expect(j.plans.find((p: any) => p.id === "team").available).toBe(false);
    expect(j.anonymous).toMatchObject({ key_required: false, per_minute_per_ip: 60 });
  });

  it("/teams, /connect and llms.txt link to it", async () => {
    expect(await (await fetchWorker("/teams")).text()).toContain('href="/pricing"');
    expect(await (await fetchWorker("/connect")).text()).toContain('href="/pricing"');
    expect(await (await fetchWorker("/llms.txt")).text()).toContain("(/pricing)");
  });

  it("paid mode: the keys page offers Polar checkout and the checkout passes our owner id to Polar", async () => {
    const paid = { ...env, PRICING_MODE: "paid", POLAR_ACCESS_TOKEN: "polar_oat_test_fake", POLAR_PRODUCTS: JSON.stringify({ team_month: "prod_team_m", team_year: "prod_team_y", volume_month: "prod_vol_m", volume_year: "prod_vol_y" }) } as unknown as Env;
    const { human, cookie } = await owner();
    const page = await (await withEnv(paid, "/dashboard/keys", { headers: { Cookie: cookie } })).text();
    expect(page).toContain('action="/billing/checkout"');
    expect(page).not.toMatch(/card number|cvc/i);
    expect((await (await withEnv(paid, "/pricing?mode=paid")).text())).not.toMatch(/<meta name="robots" content="noindex/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    let sent: any = null;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.polar.sh/v1/checkouts/") {
        sent = { body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("Authorization") };
        return Response.json({ url: "https://buy.polar.sh/checkout/test" });
      }
      return realFetch(input, init);
    });
    const res = await withEnv(paid, "/billing/checkout", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, plan: "volume", interval: "year" }), redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://buy.polar.sh/checkout/test");
    expect(sent.body).toMatchObject({ products: ["prod_vol_y"], external_customer_id: human.id });
    expect(sent.auth).toBe("Bearer polar_oat_test_fake");
    // Outside paid mode the route doesn't exist.
    expect((await post("/billing/checkout", cookie, { csrf, plan: "team" })).status).toBe(404);
  });
});
