import type { Context } from "hono";
import { z } from "zod";
import { CANARY_PATH, canaryResponse } from "@forge/shared/drift-canary";
import { publicApi } from "./api";
import { isLikelyBot } from "./services/bots";
import { RATE_LIMITED } from "./services/errors";
import { holdCheck, LIVE_DRIFT_CONTRACT, liveDriftReleased, liveDriftTextReleased, pinsSchema, parseServerParam, serverDrift, snapshot, type DriftView } from "./services/live-drift";
import { bump } from "./services/usage";
import { isFounder } from "./web/dataset-drift";
import { asPreview } from "./web/validity-release";

// ADR 0151 §8: the gateway API of the live drift monitor. Structured data only; every answer carries answered_at,
// observed_at and a signed receipt. Behind LIVE_DRIFT_PUBLIC (unset = off: 404 for everyone but a signed-in founder,
// who gets an uncached preview). Limited per address with CHECK_LIMITER (its own "drift:" key, so drift reads never
// use up an agent's checks).
//   GET  /api/drift/tool?server=<Registry name or https URL>   current per-tool digests and recent change events
//   POST /api/drift/hold  {server, pins: {tool: digest | {digest, match}}, match?: "normalised" | "raw" | "contract"}
//   GET  /api/drift/snapshot/<sha256 hex>                       a stored tools/list snapshot (digests; text if allowed)
// Third-party tool text (event before/after text, snapshot bodies) only with LIVE_DRIFT_TEXT_PUBLIC on, or to a founder
// (uncached). Otherwise digests and change classes only.

type Ctx = Context<{ Bindings: Env }>;
const CORS = { "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "X-Forge-Contract": LIVE_DRIFT_CONTRACT };
const NO_STORE = { "Cache-Control": "no-store", ...CORS };

export const holdInput = z.object({
  server: z.string().min(1).max(2048),
  pins: pinsSchema,
  match: z.enum(["normalised", "raw", "contract"]).optional(),
});

/** null when the call may go ahead; otherwise the response to send (not released, or rate limited). */
async function gate(c: Ctx): Promise<{ stop: Response } | { preview: boolean; view: DriftView }> {
  let preview = false;
  const textOpen = liveDriftTextReleased(c.env);
  if (!liveDriftReleased(c.env)) {
    if (!(await isFounder(c))) return { stop: c.json({ error: "not_found", contract: LIVE_DRIFT_CONTRACT }, 404, NO_STORE) };
    preview = true;
  } else if (!textOpen && (await isFounder(c))) {
    // Released, text not: a founder still sees the text, as an uncached preview.
    preview = true;
  }
  const view: DriftView = { text: textOpen || preview };
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.CHECK_LIMITER.limit({ key: `drift:${ip}` })).success) return { stop: c.json(RATE_LIMITED, 429, { "Retry-After": String(RATE_LIMITED.retry_after_s), ...NO_STORE }) };
  if (!isLikelyBot(c.req.raw, "api")) c.executionCtx.waitUntil(bump(c.env, ["drift:api"]).catch(() => {}));
  return { preview, view };
}

const out = (res: Response, preview: boolean) => (preview ? asPreview(res) : res);

publicApi.get("/api/drift/tool", async (c) => {
  const g = await gate(c);
  if ("stop" in g) return g.stop;
  const q = parseServerParam(c.req.query("server"));
  if (!q.ok) return c.json({ ...q.error, contract: LIVE_DRIFT_CONTRACT }, 400, NO_STORE);
  return out(c.json(await serverDrift(c.env, q, g.view), 200, NO_STORE), g.preview);
});

publicApi.post("/api/drift/hold", async (c) => {
  const g = await gate(c);
  if ("stop" in g) return g.stop;
  const raw = await c.req.json().catch(() => null);
  const p = holdInput.safeParse(raw);
  if (!p.success) return c.json({ error: "invalid_input", contract: LIVE_DRIFT_CONTRACT, needed: "server (Registry name or https URL) and pins ({tool name: sha256 digest, or {digest, match}}); match normalised (default), raw or contract", detail: p.error.issues[0]?.message ?? null }, 400, NO_STORE);
  const q = parseServerParam(p.data.server);
  if (!q.ok) return c.json({ ...q.error, contract: LIVE_DRIFT_CONTRACT }, 400, NO_STORE);
  return out(c.json(await holdCheck(c.env, q, p.data.pins, p.data.match ?? "normalised"), 200, NO_STORE), g.preview);
});

publicApi.get("/api/drift/snapshot/:sha", async (c) => {
  const g = await gate(c);
  if ("stop" in g) return g.stop;
  const s = await snapshot(c.env, c.req.param("sha").replace(/^sha256:/, "").toLowerCase(), g.view);
  if (!s) return c.json({ error: "not_found", contract: LIVE_DRIFT_CONTRACT }, 404, NO_STORE);
  // A snapshot never changes (content-addressed).
  return out(c.json(s, 200, { ...CORS, "Cache-Control": g.preview ? "no-store" : "public, max-age=86400, immutable" }), g.preview);
});

// ADR 0151 amendment 2: the drift canary, a fixture we control (packages/shared/src/drift-canary.ts). One tool whose
// description alternates between two fixed texts by UTC day under a fixed server version; the drift monitor polls it
// once a day. Stateless, no database, nothing to sign in to; the tool can't be called.
publicApi.on(["GET", "POST", "DELETE"], CANARY_PATH, (c) => canaryResponse(c.req.raw));
