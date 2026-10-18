import { checkQuerySchema } from "@forge/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { gauntletAct, gauntletStatus, startGauntlet } from "./arena/gauntlet";
import { arenaStatus } from "./arena/status";
import { growthStats } from "./services/growth";
import { mcpHandler } from "./mcp";
import { checkTool, describeMe, publicStats, submitReport } from "./services/forge";
import { houseAgentProps, houseAlreadyReported, verifyHouseToken } from "./services/house";
import { recordToolCheck } from "./services/feedback";
import { connectTestSeen } from "./services/connect-test";
import { storeRun } from "./services/house-report";
import { checkKind, recordCheck } from "./services/proof";
import type { AgentProps } from "./services/props";
import { eq } from "drizzle-orm";
import * as t from "./db/schema";
import { getDb } from "./services/db";
import { countsAsHouse } from "./services/identity";
import { recordMcp } from "./services/usage";

// Public routes (no token) and protected routes (a valid OAuth access token; one token = one agent).

const CHECK_CACHE_SECONDS = 60;

export const publicApi = new Hono<{ Bindings: Env }>();

/** GET /api/v1/check — public, rate-limited per IP, edge-cached for 60 seconds. */
publicApi.get("/api/v1/check", async (c) => {
  const url = new URL(c.req.url);
  const parsed = checkQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return c.json({ error: "invalid_query", detail: parsed.error.issues[0]?.message }, 400);

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  // Counted before the cache, so cached answers still count toward "checks from distinct sources" (§7.5).
  c.executionCtx.waitUntil(recordCheck(c.env, checkKind(c.req.header("User-Agent")), ip));
  c.executionCtx.waitUntil(recordToolCheck(c.env, parsed.data));

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const { success } = await c.env.CHECK_LIMITER.limit({ key: `ip:${ip}` });
  if (!success) return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });

  const res = c.json(await checkTool(c.env, parsed.data), 200, {
    "Cache-Control": `public, max-age=${CHECK_CACHE_SECONDS}`,
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

/**
 * POST /api/v1/house/report — the House tester workflow (GitHub Actions OIDC, no shared secret). Same validation,
 * moderation and rate limits as any report; the owner is a House account, so the report is labelled and kept out of
 * proof numbers.
 */
publicApi.post("/api/v1/house/report", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHouseToken(token, c.env.PUBLIC_ORIGIN))) return c.json({ error: "unauthorized" }, 401);
  const props = await houseAgentProps(c.env);
  if (!props) return c.json({ error: "house_account_not_set_up" }, 409);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, reason: "invalid_report" }, 400);
  }
  if (await houseAlreadyReported(c.env, props.agentId, body)) return c.json({ ok: true, duplicate: true }, 200);
  const result = await submitReport(c.env, props, body);
  if (result.ok) return c.json(result, 201);
  return c.json(result, result.reason === "rate_limited" ? 429 : 422);
});

/** POST /api/v1/house/run — the House tester's whole night, for the public House Report (ADR 0011 b). Same OIDC check. */
publicApi.post("/api/v1/house/run", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHouseToken(token, c.env.PUBLIC_ORIGIN))) return c.json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, reason: "invalid_run" }, 400);
  }
  const r = await storeRun(c.env, body);
  return r.ok ? c.json(r, 201) : c.json({ ok: false, reason: "invalid_run", detail: r.detail }, 422);
});

/** GET /api/v1/connect-test/:code — has a check for npm:forge-test-<code> arrived? (the /connect "Test it" tick) */
publicApi.get("/api/v1/connect-test/:code", async (c) =>
  c.json({ seen: await connectTestSeen(c.env, c.req.param("code")) }, 200, { "Cache-Control": "no-store" }),
);

/** GET /api/v1/stats — public headline numbers, edge-cached for 60 seconds. */
publicApi.get("/api/v1/stats", async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/v1/stats", c.req.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = c.json(await publicStats(c.env), 200, { "Cache-Control": `public, max-age=${CHECK_CACHE_SECONDS}` });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

/** GET /api/v1/growth — ADR 0011 leading indicators (claims, sites showing a badge), public for transparency. */
publicApi.get("/api/v1/growth", async (c) => c.json(await growthStats(c.env), 200, { "Cache-Control": "public, max-age=300" }));

/** GET /api/v1/arena/status — Arena spend against the budget and the run queue (public, for transparency). */
// The Gauntlet over plain HTTP (ADR 0024), for agents that can fetch but don't speak MCP. Same calls as /mcp/public.
const GAUNTLET_ID = /^g[0-9a-f]{32}$/;
const bodyOf = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

publicApi.post("/api/v1/gauntlet", async (c) => {
  const body = await bodyOf(c);
  const cardFrom = typeof body.card_from === "string" && GAUNTLET_ID.test(body.card_from) ? body.card_from : undefined;
  if (body.card_from !== undefined && !cardFrom) return c.json({ error: "invalid_card_from" }, 400);
  const r = await startGauntlet(c.env, c.req.header("CF-Connecting-IP") ?? "unknown", { cardFrom });
  return c.json(r, "error" in r ? (r.error === "rate_limited" || r.error === "daily_limit" || r.error === "busy_today" ? 429 : 400) : 201);
});

publicApi.post("/api/v1/gauntlet/:id/act", async (c) => {
  const id = c.req.param("id");
  if (!GAUNTLET_ID.test(id)) return c.json({ error: "not_found" }, 404);
  const body = await bodyOf(c);
  if (typeof body.tool !== "string" || body.tool.length > 64) return c.json({ error: "invalid_tool" }, 400);
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
  const r = await gauntletAct(c.env, id, body.tool, args);
  return c.json(r, "error" in r ? (r.error === "not_found" ? 404 : r.error === "rate_limited" ? 429 : 409) : 200);
});

publicApi.get("/api/v1/gauntlet/:id", async (c) => {
  const id = c.req.param("id");
  if (!GAUNTLET_ID.test(id)) return c.json({ error: "not_found" }, 404);
  const r = await gauntletStatus(c.env, id);
  return c.json(r, "error" in r ? 404 : 200, { "Cache-Control": "no-store" });
});

publicApi.get("/api/v1/arena/status", async (c) => c.json(await arenaStatus(c.env), 200, { "Cache-Control": "no-store" }));

type ProtectedCtx = ExecutionContext & { props: AgentProps };
const propsOf = (c: Context<{ Bindings: Env }>) => (c.executionCtx as ProtectedCtx).props;

export const protectedApi = new Hono<{ Bindings: Env }>();

protectedApi.all("/mcp", async (c) => {
  const props = propsOf(c);
  // Usage counts (services/usage.ts) from a copy of the body, only when accepted; our own accounts count as "house".
  const copy = c.req.method === "POST" ? c.req.raw.clone() : null;
  const res = await mcpHandler(c.env, props)(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
  if (copy && res.status < 400)
    c.executionCtx.waitUntil(
      getDb(c.env)
        .query.humans.findFirst({ where: eq(t.humans.id, props.humanId), columns: { isHouse: true, githubId: true } })
        .then((h) => recordMcp(c.env, h && countsAsHouse(c.env, h) ? "house" : "signed_in", copy))
        .catch(() => {}),
    );
  return res;
});

protectedApi.post("/api/v1/report", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, counted: false, reason: "invalid_report", detail: "body must be JSON" }, 400);
  }
  const result = await submitReport(c.env, propsOf(c), body);
  if (result.ok) return c.json(result, 201);
  const status = result.reason === "rate_limited" ? 429 : result.reason === "agent_inactive" || result.reason === "invite_only" ? 403 : 422;
  return c.json(result, status);
});

protectedApi.get("/api/v1/me", async (c) => {
  const me = await describeMe(c.env, propsOf(c));
  return me ? c.json(me) : c.json({ error: "agent_inactive" }, 403);
});

protectedApi.notFound((c) => c.json({ error: "not_found" }, 404));
