import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { INDEXNOW_FIRST, indexNowKey, pingIndexNow } from "../src/services/indexnow";
import { humanCounters, humanPageKind } from "../src/services/usage";
import { fetchWorker } from "./helpers";
import "../src/index";

// 23 Oct conversion work: scan boxes where report readers are, the answer guide, an honest internal people count, and
// IndexNow so search engines hear about new pages.

const origin = env.PUBLIC_ORIGIN;
const today = () => new Date().toISOString().slice(0, 10);
const count = async (key: string) =>
  Number((await getDb(env).select().from(t.usageDaily).where(and(eq(t.usageDaily.day, today()), eq(t.usageDaily.key, key))))[0]?.n ?? 0);
const page = async (path: string) => (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();

describe("scan boxes on the launch report and the guide", () => {
  it("puts a tagged scan box near the top of the report and after what we found", async () => {
    const body = await page("/reports/skill-scan-2026-10");
    const top = body.indexOf('name="from" value="report-top"');
    const found = body.indexOf('name="from" value="report-found"');
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(body.indexOf("<h2>Why we looked</h2>"));
    expect(found).toBeLessThan(body.indexOf("<h2>The flagged ordinary skills</h2>"));
    expect(found).toBeGreaterThan(body.indexOf("<h2>What we found</h2>"));
  });

  it("serves the guide with the answer first, our data and a scan box, and lists it in the sitemap", async () => {
    const body = await page("/guides/check-before-install");
    expect(body).toContain("How to check an MCP server or agent skill before you install it");
    expect(body.indexOf("Short answer")).toBeLessThan(body.indexOf("<h2>1. Who publishes it</h2>"));
    expect(body).toContain("9,930 public agent skills");
    expect(body).toContain('value="guide-top"');
    const sitemap = await (await fetchWorker("/sitemap.xml")).text();
    expect(sitemap).toContain(`${origin}/guides/check-before-install`);
  });

  it("counts which box a scan came from", async () => {
    const before = await count("scan:from:report-top");
    const form = new FormData();
    form.set("text", "# Notes\nNothing to see here.");
    form.set("from", "report-top");
    const res = await fetchWorker("/scan", { method: "POST", body: form, headers: { "CF-Connecting-IP": "203.0.113.91" } });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect(await count("scan:from:report-top")).toBe(before + 1));
    const bad = new FormData();
    bad.set("text", "x");
    bad.set("from", "../../evil");
    await fetchWorker("/scan", { method: "POST", body: bad, headers: { "CF-Connecting-IP": "203.0.113.92" } });
    expect(await count("scan:from:../../evil")).toBe(0);
  });
});

describe("real people, counted internally", () => {
  const req = (h: Record<string, string>, method = "POST") => ({ method, headers: new Headers(h) });
  it("counts a same-site beacon from a browser, by kind of page, and never a bot or another site", () => {
    expect(humanCounters(req({ "user-agent": "Mozilla/5.0 Chrome/140", "sec-fetch-site": "same-origin", referer: `${origin}/reports/skill-scan-2026-10` }), origin)).toEqual(["visit:human", "visit:human:report"]);
    expect(humanCounters(req({ "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.4)", "sec-fetch-site": "same-origin" }), origin)).toEqual([]);
    expect(humanCounters(req({ "user-agent": "Mozilla/5.0 Chrome/140", "sec-fetch-site": "cross-site", referer: "https://evil.example/" }), origin)).toEqual([]);
    expect(humanCounters(req({ "user-agent": "Mozilla/5.0 Chrome/140", origin: "https://evil.example" }), origin)).toEqual([]);
    expect(humanCounters(req({ "user-agent": "Mozilla/5.0 Chrome/140", "sec-fetch-site": "same-origin" }, "GET"), origin)).toEqual([]);
    expect(["/", "/connect", "/scan", "/arena/run/x", "/t/npm:x", "/about"].map(humanPageKind)).toEqual(["home", "connect", "scan", "arena", "tool", "other"]);
  });

  it("answers the beacon with an empty 204 and counts it, without touching the public page views", async () => {
    const before = await count("visit:human:home");
    const all = await count("visit:all");
    const res = await fetchWorker("/v", { method: "POST", headers: { "User-Agent": "Mozilla/5.0 Chrome/140", "Sec-Fetch-Site": "same-origin", Referer: `${origin}/` } });
    expect(res.status).toBe(204);
    await vi.waitFor(async () => expect(await count("visit:human:home")).toBe(before + 1));
    expect(await count("visit:all")).toBe(all);
  });
});

describe("IndexNow", () => {
  it("makes one key, serves it at /<key>.txt, and 404s any other name", async () => {
    const key = await indexNowKey(env);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(await indexNowKey(env)).toBe(key);
    const res = await fetchWorker(`/${key}.txt`);
    expect(await res.text()).toBe(key);
    expect((await fetchWorker(`/${"0".repeat(32)}.txt`)).status).toBe(404);
  });

  it("sends the sitemap once a day on production only, and never throws", async () => {
    expect(await pingIndexNow({ ...env, ENVIRONMENT: "staging" } as Env)).toEqual({ skipped: "not_production" });
    const prod = { ...env, ENVIRONMENT: "production" } as Env;
    const sent: { url: string; body: { host: string; key: string; keyLocation: string; urlList: string[] } }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const now = Date.UTC(2026, 9, 24, 1);
    const r = await pingIndexNow(prod, now, fetcher);
    expect(r).toMatchObject({ status: 202 });
    expect(sent[0]!.url).toBe("https://api.indexnow.org/indexnow");
    expect(sent[0]!.body.urlList).toContain(`${origin}/guides/check-before-install`);
    expect(sent[0]!.body.keyLocation).toBe(`${origin}/${await indexNowKey(env)}.txt`);
    expect(await pingIndexNow(prod, now + 3_600_000, fetcher)).toEqual({ skipped: "too_soon" });
    // Nothing new since the last send: nothing is sent.
    expect(await pingIndexNow(prod, now + 86_400_000, fetcher)).toEqual({ sent: 0 });
    await env.KV.delete("indexnow:last");
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await pingIndexNow(prod, now + 2 * 86_400_000, broken)).toMatchObject({ error: expect.stringContaining("offline") });
    // A failed try waits a day too, instead of retrying every hour.
    expect(await pingIndexNow(prod, now + 2 * 86_400_000 + 3_600_000, fetcher)).toEqual({ skipped: "too_soon" });
    await env.KV.delete("indexnow:tried");
  });

  it("starts small, with the static pages and the newest pages first, and waits a day after a 429", async () => {
    const prod = { ...env, ENVIRONMENT: "production" } as Env;
    await env.KV.delete("indexnow:last");
    await env.KV.delete("indexnow:tried");
    const db = getDb(env);
    const base = Date.UTC(2026, 9, 1);
    for (let i = 0; i < INDEXNOW_FIRST + 30; i += 8)
      await db.insert(t.skillScans).values(
        Array.from({ length: 8 }, (_, j) => ({
          fingerprint: `sha256:${(i + j).toString(16).padStart(64, "a")}`,
          sourceUrl: `https://raw.githubusercontent.com/many/repo${i + j}/main/x/SKILL.md`,
          public: true,
          firstSeen: base,
          lastSeen: base + (i + j) * 60_000,
          verdict: "clear" as const,
          findings: [],
          counts: {},
          rulesVersion: "test",
          bytes: 10,
        })),
      );
    const lists: string[][] = [];
    const refuse = (async (_u: string, init: RequestInit) => {
      lists.push(JSON.parse(String(init.body)).urlList);
      return new Response(null, { status: 429 });
    }) as unknown as typeof fetch;
    const now = Date.UTC(2026, 9, 30, 1);
    expect(await pingIndexNow(prod, now, refuse)).toMatchObject({ sent: INDEXNOW_FIRST, status: 429 });
    expect(lists[0]![0]).toBe(`${origin}/`);
    expect(lists[0]).toContain(`${origin}/guides/check-before-install`);
    expect(lists[0]!.some((u) => u.endsWith("/many/repo135/x"))).toBe(true);
    expect(lists[0]!.some((u) => u.endsWith("/many/repo0/x"))).toBe(false);
    expect(await pingIndexNow(prod, now + 3_600_000, refuse)).toEqual({ skipped: "too_soon" });
    expect(lists).toHaveLength(1);
    await env.KV.delete("indexnow:tried");
  });
});
