import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BYOK_EXPIRES, BYOK_FROM, CREDIT_KV, OPENROUTER_CREDIT_PURCHASED_USD, type CreditSnapshot } from "../src/arena/credit";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { ANTHROPIC_ALLOWANCE_USD, arenaPause, monthlyCosts, noteOutOfCredit, OUT_OF_CREDIT_KV, READING_FRESH_MS } from "../src/services/costs";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, profile } from "./helpers";
import "../src/index";

// AQ-08 (ADR 0097): /admin/costs and the graceful pause. When OpenRouter credit runs out (a 402, or a reading of $0)
// or the Anthropic credit passes its expiry date, every public Arena page still answers 200, with an honest note.

const snap = (remaining: number, at = Date.now()): CreditSnapshot => ({ at, good_at: at, ok: true, remaining, key_limit_remaining: null, key_usage: OPENROUTER_CREDIT_PURCHASED_USD - remaining, byok_usage_monthly: null });
// /arena/fail-of-the-week is left out: with no bouts stored it is an honest 404, paused or not.
const ARENA_PAGES = ["/arena", "/arena/rules", "/arena/methodology", "/arena/history", "/arena/failures", "/arena/proving-ground", "/arena/vote", "/arena/call-it", "/arena/business"];
const BEFORE_EXPIRY = BYOK_EXPIRES - 3 * 86_400_000;

async function clear() {
  await env.KV.delete(CREDIT_KV);
  await env.KV.delete(OUT_OF_CREDIT_KV);
}
afterEach(async () => {
  vi.useRealTimers();
  await clear();
});

let pass = 0;
/** Every Arena page, each under a fresh cache key (pages are edge-cached for 60 seconds). */
async function arenaPages() {
  pass++;
  const out: { path: string; status: number; text: string }[] = [];
  for (const path of ARENA_PAGES) {
    const res = await fetchWorker(`${path}?pass=${pass}`, { headers: { Accept: "text/html" } });
    out.push({ path, status: res.status, text: await res.text() });
  }
  return out;
}

describe("Arena pause state", () => {
  it("none when credit is fine and before the expiry date", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(20)));
    expect(await arenaPause(env, BEFORE_EXPIRY)).toEqual({ openrouter: false, claude: false, notes: [] });
  });

  it("OpenRouter: a $0 reading or a recent 402 pauses; Anthropic: the expiry date pauses", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(0, BEFORE_EXPIRY - 60_000)));
    expect((await arenaPause(env, BEFORE_EXPIRY)).openrouter).toBe(true);
    await clear();
    await noteOutOfCredit(env, 402);
    const p = await arenaPause(env, BEFORE_EXPIRY);
    expect(p.openrouter).toBe(true);
    expect(p.claude).toBe(false);
    expect(p.notes.join(" ")).toContain("prepaid model credit has run out");
    expect(p.notes.join(" ")).toContain("unaffected");
    await clear();
    const e = await arenaPause(env, BYOK_EXPIRES);
    expect(e).toMatchObject({ openrouter: false, claude: true });
    expect(e.notes[0]).toContain(`expired on ${new Date(BYOK_EXPIRES).toISOString().slice(0, 10)}`);
  });

  it("a stale $0 reading (the runner stopped reading) doesn't pause; a missing one doesn't either", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(0, BEFORE_EXPIRY - READING_FRESH_MS - 1)));
    expect((await arenaPause(env, BEFORE_EXPIRY)).openrouter).toBe(false);
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(0, BEFORE_EXPIRY - READING_FRESH_MS)));
    expect((await arenaPause(env, BEFORE_EXPIRY)).openrouter).toBe(true);
    await clear();
    expect(await arenaPause(env, BEFORE_EXPIRY)).toEqual({ openrouter: false, claude: false, notes: [] });
  });

  it("lifts by itself once credit is back: a fresh reading with credit after the 402 supersedes it; an older one doesn't", async () => {
    const t402 = BEFORE_EXPIRY - 3_600_000;
    await noteOutOfCredit(env, 402, t402);
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(25, t402 - 60_000)));
    expect((await arenaPause(env, BEFORE_EXPIRY)).openrouter).toBe(true);
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(25, t402 + 60_000)));
    expect(await arenaPause(env, BEFORE_EXPIRY)).toEqual({ openrouter: false, claude: false, notes: [] });
    // A later reading that still shows nothing left keeps it paused.
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(0, t402 + 60_000)));
    expect((await arenaPause(env, BEFORE_EXPIRY)).openrouter).toBe(true);
  });

  it("a failed OpenRouter reading isn't read as out of credit (no pause it can't prove)", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify({ ...snap(0), ok: false, error: "OpenRouter key API 500" }));
    expect((await arenaPause(env, BEFORE_EXPIRY)).openrouter).toBe(false);
  });
});

describe("Arena pages while paused", () => {
  it("normal state: every Arena page is 200 with no pause note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_EXPIRY);
    for (const p of await arenaPages()) {
      expect(p.status, p.path).toBe(200);
      expect(p.text, p.path).not.toContain("arena-paused");
    }
  });

  it("out of OpenRouter credit (simulated 402): every Arena page is 200 with the paused note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_EXPIRY);
    await noteOutOfCredit(env, 402);
    for (const p of await arenaPages()) {
      expect(p.status, p.path).toBe(200);
      expect(p.text, p.path).toContain('class="notice warn arena-paused"');
      expect(p.text, p.path).toContain("prepaid model credit has run out");
    }
  });

  it("Anthropic credit expired: every Arena page is 200 with the paused note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BYOK_EXPIRES + 60_000);
    for (const p of await arenaPages()) {
      expect(p.status, p.path).toBe(200);
      expect(p.text, p.path).toContain("Claude bouts ran on Anthropic API credit that expired on");
    }
  });
});

describe("/admin/costs", () => {
  it("is admins only, and shows each source with the Anthropic allowance and expiry", async () => {
    const db = getDb(env);
    const founder = profile({ id: Number(env.ADMIN_GITHUB_IDS.split(",")[0]), login: "founder-costs" });
    const h = (await db.query.humans.findFirst({ where: eq(t.humans.githubId, founder.id) })) ?? (await upsertHuman(db, founder, Date.now()));
    const other = await upsertHuman(db, profile({ id: 99_123_456, login: "not-admin-costs" }), Date.now());
    const cookie = async (id: string) => `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, id)}`;
    expect((await fetchWorker("/admin/costs", { redirect: "manual" })).status).toBe(302);
    expect((await fetchWorker("/admin/costs", { headers: { Cookie: await cookie(other.id) }, redirect: "manual" })).status).toBe(302);
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(12.5)));
    const res = await fetchWorker("/admin/costs", { headers: { Cookie: await cookie(h.id) } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const page = await res.text();
    for (const s of ["Cloudflare", "OpenRouter", "Anthropic", "Workers AI", "GitHub Actions", "$12.50", `of the $${ANTHROPIC_ALLOWANCE_USD} allowance`, new Date(BYOK_EXPIRES).toISOString().slice(0, 10), "https://github.com/organizations/theagentforge/settings/billing", "not yet measured", 'name="robots" content="noindex"'])
      expect(page).toContain(s);
    const j = (await (await fetchWorker("/admin/costs?format=json", { headers: { Cookie: await cookie(h.id) } })).json()) as Awaited<ReturnType<typeof monthlyCosts>>;
    expect(j.cloudflare.usage_usd).toBeNull();
    expect(j.openrouter.remaining_usd).toBe(12.5);
    expect(j.anthropic_byok.allowance_usd).toBe(100);
  });

  it("Anthropic spend counts BYOK cost since the credit started, against the allowance", async () => {
    const db = getDb(env);
    const event = { id: "ev-costs", slug: "costs-test", name: "Costs test", season: "test", kind: "practice", status: "running", createdAt: Date.now() };
    await db.insert(t.arenaEvents).values(event as never).onConflictDoNothing();
    const run = (id: string, finishedAt: number, byokCost: number) => ({ id, eventId: event.id, modelId: "claude-haiku-5.5", task: "x", seed: 1, attemptNo: 1, status: "done", cost: byokCost + 0.01, byokCost, tokens: 1, finishedAt });
    await db.insert(t.arenaRuns).values([run("costs-1", BYOK_FROM - 86_400_000, 5), run("costs-2", BYOK_FROM + 3_600_000, 7.25)] as never);
    const k = await monthlyCosts(env, BYOK_FROM + 86_400_000);
    expect(k.anthropic_byok.spent_since_start_usd).toBe(7.25);
    expect(k.anthropic_byok.left_usd).toBe(ANTHROPIC_ALLOWANCE_USD - 7.25);
    expect(k.anthropic_byok.expired).toBe(false);
    expect((await monthlyCosts(env, BYOK_EXPIRES)).anthropic_byok.expired).toBe(true);
  });
});

describe("the runner pauses for real (what the note says is true)", () => {
  const KEYED = { ...env, OPENROUTER_API_KEY: "test-key" } as typeof env & { OPENROUTER_API_KEY: string };
  async function queued(modelId: string) {
    const db = getDb(env);
    await db.delete(t.arenaRuns).where(eq(t.arenaRuns.status, "queued"));
    const eventId = crypto.randomUUID();
    await db.insert(t.arenaEvents).values({ id: eventId, slug: `costs-${eventId.slice(0, 8)}`, name: "costs", season: "s0", kind: "card", status: "running" });
    const id = crypto.randomUUID();
    await db.insert(t.arenaRuns).values({ id, eventId, modelId, task: "impossible", seed: 1, attemptNo: 1, status: "queued" });
    return id;
  }
  const status = async (id: string) => (await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.id, id)))[0]!.status;

  it("an OpenRouter 402 suspends the bout and marks the Arena out of credit", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(50)));
    await env.KV.delete("arena:lock");
    const id = await queued("gpt-6.1-sol");
    const f = (async (url: string) =>
      String(url).endsWith("/api/v1/key") ? Response.json({ data: { usage: 1 } }) : Response.json({ error: { message: "Insufficient credits" } }, { status: 402 })) as unknown as typeof fetch;
    const { processQueue } = await import("../src/arena/runner");
    await processQueue(KEYED, Date.now() + 30_000, () => Date.now(), f);
    expect(await status(id)).toBe("queued");
    expect(JSON.parse((await env.KV.get(OUT_OF_CREDIT_KV))!)).toMatchObject({ status: 402 });
    expect((await arenaPause(env, BEFORE_EXPIRY)).openrouter).toBe(true);
  }, 20_000);

  it("after the Anthropic credit's expiry no Claude bout starts", async () => {
    await env.KV.put(CREDIT_KV, JSON.stringify(snap(50)));
    await env.KV.delete("arena:lock");
    const id = await queued("claude-haiku-5.5");
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(String(url));
      return Response.json({ data: { usage: 1 } });
    }) as unknown as typeof fetch;
    const { processQueue } = await import("../src/arena/runner");
    await processQueue(KEYED, BYOK_EXPIRES + 30_000, () => BYOK_EXPIRES + 1, f);
    expect(await status(id)).toBe("queued");
    expect(urls.filter((u) => u.includes("/chat/completions"))).toEqual([]); // never a model call
  }, 20_000);
});
