import { checkQuerySchema } from "@forge/shared";
import { provenance } from "./services/provenance";
import type { Context } from "hono";
import { Hono } from "hono";
import { CHALLENGE_PATTERN, gauntletAct, gauntletStatus, startGauntlet } from "./arena/gauntlet";
import { arenaStatus } from "./arena/status";
import { isClaudeByok, opsCallAllowed } from "./arena/credit";
import { modelById } from "./arena/lineup";
import { agentView, fetchSkillText, scanAndRecord, scanByFingerprint, scanPath, watchStatus } from "./services/scans";
import { SCAN_MAX_BYTES } from "@forge/shared";
import { growthStats, publicGrowth } from "./services/growth";
import { mcpHandler } from "./mcp";
import { checkTool, describeMe, publicStats, submitReport } from "./services/forge";
import { checkShare, scanShare } from "./services/receipts";
import { exposureAnswer, restCheckAnswer, scanRelated, watchAnswer } from "./services/compact";
import { houseAgentProps, houseAlreadyReported, privateWorkflow, verifyActionsToken, verifyHouseToken } from "./services/house";
import { postToMoltbook, validatePost } from "./social/moltbook";
import { takeReport } from "./social/moltbook-replies";
import { DAILY_CAP_USD, PROMPTS, runSelection, SELECTION_MODELS } from "./ops/tool-selection";
import { CITATION_MODELS, CITATION_QUESTIONS, runCitations } from "./ops/citations";
import { recordToolCheck } from "./services/feedback";
import { recordMiss, scanMissLabel } from "./services/misses";
import { scoutSignals } from "./services/scout-signals";
import { connectTestSeen } from "./services/connect-test";
import { storeRun, storeSweep } from "./services/house-report";
import { storeToolLists } from "./services/house-tools";
import { checkKind, recordCheck } from "./services/proof";
import { INSTALL_ID_HEADER, recordInstallId } from "./services/install-ids";
import { installClient, installCounters, isSkillScanOutcome, parseAnswer, recordInstallCheck, SKILL_SCAN_OUTCOMES } from "./services/install-metrics";
import { internalCaller, internalKey, internalOf } from "./services/internal";
import type { AgentProps } from "./services/props";
import { eq } from "drizzle-orm";
import * as t from "./db/schema";
import { getDb } from "./services/db";
import { countsAsHouse } from "./services/identity";
import { recordMcp, bump, scanCounters, watchCounters } from "./services/usage";
import { RATE_LIMITED, CHECK_QUERY_HELP } from "./services/errors";
import { anonymousLimited, keyGate } from "./services/api-keys";
import { EXPOSURE_MAX_TEXT, exposureCounters, exposureRequest } from "./services/exposure";

// Public routes (no token) and protected routes (a valid OAuth access token; one token = one agent).

const CHECK_CACHE_SECONDS = 60;
const CHECK_KEYS = new Set(["id", "url", "fingerprint", "version"]);

export const publicApi = new Hono<{ Bindings: Env }>();

/** GET /api/v1/check — public, rate-limited per IP, edge-cached for 60 seconds. */
publicApi.get("/api/v1/check", async (c) => {
  // Only the four query keys count: link tags such as ?from= or utm_* are ignored rather than refused (24 Oct check:
  // 37 refusals a day), and they don't split the cache.
  const url = new URL(c.req.url);
  for (const k of [...url.searchParams.keys()]) if (!CHECK_KEYS.has(k)) url.searchParams.delete(k);
  const parsed = checkQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return c.json({ error: "invalid_query", detail: parsed.error.issues[0]?.message, ...CHECK_QUERY_HELP }, 400);

  // ADR 0110: a call with an API key is metered per key (minute limit and monthly quota) before anything else, cached
  // answers included; an unknown or revoked key is refused. Calls without a key take exactly the old path below.
  const gate = await keyGate(c.env, c.req.raw.headers, c.executionCtx);
  if (gate.kind === "refused") return c.json(gate.body, gate.status, gate.headers);
  const keyed = gate.kind === "keyed" ? gate.headers : null;

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  // Counted before the cache, so cached answers still count toward "checks from distinct sources" (§7.5). Our own
  // probes (services/internal.ts) are counted apart; the tag changes nothing else (same limits, same answer).
  const internal = internalCaller(c.req.raw.headers);
  c.executionCtx.waitUntil(recordCheck(c.env, checkKind(c.req.header("User-Agent")), ip, { internal }));
  c.executionCtx.waitUntil(recordToolCheck(c.env, parsed.data, Date.now(), { userAgent: c.req.header("User-Agent"), internal, channel: "api" }));

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  // B2-06 (ADR 0086): install-time clients (plugin, CLI and hooks, Action) are counted with what our answer means at
  // the install (blocked, advisory or neither), cached answers included.
  const ua = c.req.header("User-Agent");
  if (hit) {
    if (!installClient(ua)) return keyed ? withKeyHeaders(hit, keyed) : hit;
    // Read once and answered from the copy, so counting never waits on the client reading the body.
    const text = await hit.text();
    // A cached answer skips the check limit, so its install count has a per-address limit of its own (the same 60 a
    // minute): repeating one cached URL can't raise the counters faster than fresh checks could. The answer is
    // served either way.
    const counted = await c.env.CHECK_LIMITER.limit({ key: `install-count:${ip}` }).then((r) => r.success, () => false);
    if (counted) {
      c.executionCtx.waitUntil(recordInstallCheck(c.env, ua, internal, parseAnswer(text)));
      c.executionCtx.waitUntil(recordInstallId(c.env, c.req.header(INSTALL_ID_HEADER), ua, internal));
    }
    return keyed ? withKeyHeaders(new Response(text, hit), keyed) : new Response(text, hit);
  }

  if (!keyed) {
    const { success } = await c.env.CHECK_LIMITER.limit({ key: `ip:${ip}` });
    if (!success) return c.json(anonymousLimited(c.env), 429, { "Retry-After": "60" });
  }

  const checked = await checkTool(c.env, parsed.data);
  const share = await checkShare(c.env, checked, parsed.data.id ?? parsed.data.url ?? parsed.data.fingerprint ?? "");
  // The full shape the plugin, CLI and Action read, with `summary` first and `related` added (ADR 0056).
  const answer = restCheckAnswer({ ...checked, share }, parsed.data);
  const res = c.json(answer, 200, {
    "Cache-Control": `public, max-age=${CHECK_CACHE_SECONDS}`,
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  c.executionCtx.waitUntil(recordInstallCheck(c.env, ua, internal, answer));
  // B3-09 (ADR 0103): the anonymous install ID, when an install-time client sent one (first and last day only).
  c.executionCtx.waitUntil(recordInstallId(c.env, c.req.header(INSTALL_ID_HEADER), ua, internal));
  return keyed ? withKeyHeaders(res, keyed) : res;
});

/** A keyed answer: the plan and quota headers, and never stored by a shared cache (the quota differs per key). */
function withKeyHeaders(res: Response, headers: Record<string, string>) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  out.headers.set("Cache-Control", "private, no-store");
  return out;
}

/** ADR 0110: the key gate for the scan, watch and exposure routes. Null: no key, so the caller applies its IP limit. */
async function gateOrIp(c: Context<{ Bindings: Env }>, bucket: string) {
  const gate = await keyGate(c.env, c.req.raw.headers, c.executionCtx);
  if (gate.kind === "refused") return { res: c.json(gate.body, gate.status, gate.headers), headers: null };
  if (gate.kind === "keyed") return { res: null, headers: gate.headers };
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `${bucket}:${ip}` });
  return success ? { res: null, headers: null } : { res: c.json(anonymousLimited(c.env), 429, { "Retry-After": "60" }), headers: null };
}
const keyedJson = (res: Response, headers: Record<string, string> | null) => (headers ? withKeyHeaders(res, headers) : res);

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

/** POST /api/v1/house/sweep — one day of the weekly sweep of every no-setup server (ADR 0108). Same OIDC check. */
publicApi.post("/api/v1/house/sweep", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHouseToken(token, c.env.PUBLIC_ORIGIN))) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const r = await storeSweep(c.env, body);
  return r.ok ? c.json(r, 201) : c.json({ ok: false, reason: "invalid_sweep", detail: r.detail }, 422);
});

/**
 * POST /api/v1/house/tools — working servers' tools/list (capped), scanned here with the skill scanner's rules and kept
 * on each tool's page (ADR 0108). Same OIDC check. Up to 25 servers a call.
 */
publicApi.post("/api/v1/house/tools", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHouseToken(token, c.env.PUBLIC_ORIGIN))) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const r = await storeToolLists(c.env, body);
  return r.ok ? c.json(r, 201) : c.json({ ok: false, reason: "invalid_tools", detail: r.detail }, 422);
});

/**
 * POST /api/v1/social/moltbook — one approved Moltbook post from the moltbook.yml workflow in the private repo (GitHub
 * Actions OIDC, no shared secret). The workflow only calls this after an admin's approve; the Moltbook key never
 * leaves Cloudflare.
 */
publicApi.post("/api/v1/social/moltbook", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyActionsToken(token, c.env.PUBLIC_ORIGIN, privateWorkflow("moltbook.yml")))) return c.json({ error: "unauthorized" }, 401);
  const post = validatePost(await c.req.json().catch(() => null));
  if (typeof post === "string") return c.json({ ok: false, error: post }, 422);
  const r = await postToMoltbook(c.env, post);
  return c.json(r, r.ok ? 201 : r.error === "moltbook_not_connected" ? 409 : r.error.startsWith("too_soon") ? 429 : 502);
});

/**
 * GET /api/v1/social/moltbook/replies — what the automatic Moltbook replies did since the last call (ADR 0044), for
 * moltbook.yml to report on a `moltbook-replies` issue. GitHub OIDC from moltbook.yml on main; marks the entries reported.
 */
publicApi.get("/api/v1/social/moltbook/replies", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyActionsToken(token, c.env.PUBLIC_ORIGIN, privateWorkflow("moltbook.yml")))) return c.json({ error: "unauthorized" }, 401);
  return c.json(await takeReport(c.env), 200, { "Cache-Control": "no-store" });
});

/** GET /api/v1/ops/scout-signals — our own daily signals for Forge Scout, from scout-collect.yml (GitHub OIDC, ADR 0031). */
publicApi.get("/api/v1/ops/scout-signals", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyActionsToken(token, c.env.PUBLIC_ORIGIN, privateWorkflow("scout-collect.yml")))) return c.json({ error: "unauthorized" }, 401);
  return c.json(await scoutSignals(c.env), 200, { "Cache-Control": "no-store" });
});

/**
 * POST /api/v1/ops/tool-selection — one slice of the tool-selection test (agent-channels §4.1), from the
 * tool-selection.yml workflow in the private repo (GitHub OIDC). Body: { model, from, to }, at most 10 prompts a call.
 * Spend is capped per day in KV, apart from the Arena's budget.
 */
publicApi.post("/api/v1/ops/tool-selection", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyActionsToken(token, c.env.PUBLIC_ORIGIN, privateWorkflow("tool-selection.yml")))) return c.json({ error: "unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as { model?: unknown; from?: unknown; to?: unknown } | null;
  const from = Number(b?.from), to = Number(b?.to);
  if (!SELECTION_MODELS.includes(b?.model as never) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > PROMPTS.length || to - from < 1 || to - from > 10)
    return c.json({ error: "give model (one of SELECTION_MODELS) and from/to, at most 10 prompts" }, 422);
  const key = opsSpendKey();
  const spent = Number((await c.env.KV.get(key)) ?? 0);
  if (spent >= DAILY_CAP_USD) return c.json({ error: "daily_cap_reached", spent }, 429);
  // ADR 0064: below the OpenRouter credit reserve, only the Claude (BYOK) half runs.
  const selModel = modelById(String(b!.model));
  const allowed = await opsCallAllowed(c.env, !!selModel && isClaudeByok(selModel));
  if (!allowed.ok) return c.json({ error: "paused_credit", remaining: allowed.remaining, reserve: allowed.reserve }, 429);
  const r = await runSelection(c.env, b!.model as string, from, to);
  await c.env.KV.put(key, String(spent + r.cost), { expirationTtl: 3 * 86_400 });
  return c.json(r, 200);
});

/**
 * POST /api/v1/ops/citations — one slice of the weekly "cited in AI search" check (agent-channels §4.5), from the
 * ai-citations.yml workflow in the private repo (GitHub OIDC). Body: { model, from, to }. Shares the ops daily cap.
 */
publicApi.post("/api/v1/ops/citations", async (c) => {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyActionsToken(token, c.env.PUBLIC_ORIGIN, privateWorkflow("ai-citations.yml")))) return c.json({ error: "unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as { model?: unknown; from?: unknown; to?: unknown } | null;
  const from = Number(b?.from), to = Number(b?.to);
  if (!CITATION_MODELS.some((m) => m.key === b?.model) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > CITATION_QUESTIONS.length || to - from < 1 || to - from > 5)
    return c.json({ error: "give model (claude, gpt or perplexity) and from/to, at most 5 questions" }, 422);
  const key = opsSpendKey();
  const spent = Number((await c.env.KV.get(key)) ?? 0);
  if (spent >= DAILY_CAP_USD) return c.json({ error: "daily_cap_reached", spent }, 429);
  // Every citation call spends credit: the Claude one runs on our key, but its web-search plugin is billed to credit.
  const allowed = await opsCallAllowed(c.env, false);
  if (!allowed.ok) return c.json({ error: "paused_credit", remaining: allowed.remaining, reserve: allowed.reserve }, 429);
  const r = await runCitations(c.env, b!.model as string, from, to);
  await c.env.KV.put(key, String(spent + r.cost), { expirationTtl: 3 * 86_400 });
  return c.json(r, 200);
});

/** One daily spend total for the ops checks that call models (tool selection, citations). */
const opsSpendKey = () => `ops:llm-spend:${new Date().toISOString().slice(0, 10)}`;

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

/** GET /api/v1/growth — ADR 0011 leading indicators, gross ones only (F-02: outside-only fields are null, internal). */
publicApi.get("/api/v1/growth", async (c) => c.json(publicGrowth(await growthStats(c.env)), 200, { "Cache-Control": "public, max-age=300" }));

/** GET /api/v1/arena/status — Arena spend against the budget and the run queue (public, for transparency). */
const bodyOf = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

// Skill scans (ADR 0026): free, no account, rate-limited per IP. Text in the body, or a URL on a public code host.
const FP = /^(sha256:)?[0-9a-f]{64}$/;
async function scanRequest(c: Context<{ Bindings: Env }>, input: { text?: unknown; url?: unknown; name?: unknown }) {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const g = await gateOrIp(c, "scan");
  if (g.res) return g.res;
  let text: string, sourceUrl: string | null = null;
  if (typeof input.text === "string" && input.text.length) {
    if (input.text.length > SCAN_MAX_BYTES) return c.json({ error: "too_large", max_bytes: SCAN_MAX_BYTES }, 413);
    text = input.text;
  } else if (typeof input.url === "string" && input.url.length <= 2048) {
    const got = await fetchSkillText(input.url);
    if (!got.ok) c.executionCtx.waitUntil(recordMiss(c.env, "scan", scanMissLabel(input.url, got.error), { userAgent: c.req.header("User-Agent") }));
    if (!got.ok) return c.json({ error: got.error, hosts: "clawhub.ai (skill pages), raw.githubusercontent.com, github.com (file, folder or repository links), gist.githubusercontent.com, gitlab.com, bitbucket.org, codeberg.org, unpkg.com, cdn.jsdelivr.net" }, got.error === "too_large" ? 413 : got.error === "not_found" ? 404 : 400);
    text = got.text;
    sourceUrl = got.url;
  } else return c.json({ error: "give text or url" }, 400);
  const { result, isPublic } = await scanAndRecord(c.env, text, { name: input.name, sourceUrl });
  const internal = internalCaller(c.req.raw.headers);
  c.executionCtx.waitUntil(bump(c.env, internal ? [internalKey(internal, "scans")] : scanCounters("api", result.verdict)).catch(() => {}));
  return keyedJson(c.json({ ...agentView(result, { isPublic, origin: c.env.PUBLIC_ORIGIN, sourceUrl }), related: scanRelated(result.fingerprint), share: await scanShare(c.env, result, { isPublic, sourceUrl }) }, 200, { "Cache-Control": "no-store" }), g.headers);
}

publicApi.post("/api/v1/scan", async (c) => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > SCAN_MAX_BYTES * 2) return c.json({ error: "too_large", max_bytes: SCAN_MAX_BYTES }, 413);
  return scanRequest(c, await bodyOf(c));
});
publicApi.get("/api/v1/scan", async (c) => scanRequest(c, { url: c.req.query("url"), name: c.req.query("name") }));
publicApi.get("/api/v1/scan/:fp", async (c) => {
  const fp = c.req.param("fp");
  if (!FP.test(fp)) return c.json({ error: "not_found" }, 404);
  const row = await scanByFingerprint(getDb(c.env), fp.startsWith("sha256:") ? fp : `sha256:${fp}`);
  if (!row || !row.public) return c.json({ error: "not_found" }, 404);
  return c.json({ verdict: row.verdict, fingerprint: row.fingerprint, rules_version: row.rulesVersion, counts: row.counts, findings: (row.findings as { rule: string; family: string; severity: string; line: number; column: number }[]).map((f) => ({ rule: f.rule, family: f.family, severity: f.severity, line: f.line, column: f.column })), source_url: row.sourceUrl, page_url: `${c.env.PUBLIC_ORIGIN}${scanPath(row.fingerprint)}`, first_seen: new Date(row.firstSeen).toISOString(), scans: row.scans, guarantee: false, provenance: provenance("scan", row.lastSeen) }, 200, { "Cache-Control": "public, max-age=300" });
});

/** The weekly watch (ADR 0026): fingerprints in, status out. Reads only. */
// POST-only endpoints answer a GET with how to call them, not a bare 404 (24 Oct check).
const POST_ONLY: Record<string, unknown> = {
  "/api/v1/watch": { body: { fingerprints: ["sha256:<64 hex>"] } },
  "/api/v1/exposure": { body: { packages: [{ ecosystem: "npm", name: "<package>", version: "<version>" }] }, or_body: { pip_freeze: "<output of pip freeze>" } },
};
for (const [path, usage] of Object.entries(POST_ONLY))
  publicApi.get(path, (c) => c.json({ error: "method_not_allowed", method: "POST", content_type: "application/json", ...(usage as object), docs: `${c.env.PUBLIC_ORIGIN}/openapi.json` }, 405, { Allow: "POST" }));

/**
 * B2-06 (ADR 0086): the skill-scan GitHub Action's one anonymous count per run. It scans on the runner and never sends
 * a file, so this is its only call: {"outcome":"blocked"|"findings"|"clear"}. Nothing else is read or stored (a daily
 * counter row). Rate-limited per IP like a check; any other field is ignored.
 */
publicApi.post("/api/v1/install-outcome", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `install:${ip}` });
  if (!success) return c.json(RATE_LIMITED, 429, { "Retry-After": "60" });
  const body = await bodyOf(c);
  if (body.client !== "skill-scan" || !isSkillScanOutcome(body.outcome)) return c.json({ error: "invalid_body", client: ["skill-scan"], outcome: Object.keys(SKILL_SCAN_OUTCOMES) }, 400);
  c.executionCtx.waitUntil(bump(c.env, installCounters("skill-scan", SKILL_SCAN_OUTCOMES[body.outcome], internalCaller(c.req.raw.headers))).catch(() => {}));
  return c.json({ counted: true }, 202, { "Cache-Control": "no-store" });
});

publicApi.post("/api/v1/watch", async (c) => {
  const g = await gateOrIp(c, "watch");
  if (g.res) return g.res;
  const body = await bodyOf(c);
  const raw = Array.isArray(body.fingerprints) ? body.fingerprints : [];
  if (!raw.length || raw.length > 100) return c.json({ error: "give 1 to 100 fingerprints" }, 400);
  const fps = raw.filter((x): x is string => typeof x === "string" && FP.test(x)).map((x) => (x.startsWith("sha256:") ? x : `sha256:${x}`));
  const internal = internalCaller(c.req.raw.headers);
  c.executionCtx.waitUntil(bump(c.env, internal ? [internalKey(internal, "watch")] : watchCounters(fps.length)).catch(() => {}));
  return keyedJson(c.json(await watchAnswer(c.env, await watchStatus(getDb(c.env), fps), fps), 200, { "Cache-Control": "no-store" }), g.headers);
});

/** "Was my agent stack hit?" (crisis-wave plan C4): names and versions in, advisory matches out. Counts only. */
publicApi.post("/api/v1/exposure", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const g = await gateOrIp(c, "ip");
  if (g.res) return g.res;
  if (Number(c.req.header("content-length") ?? 0) > EXPOSURE_MAX_TEXT * 2) return c.json({ error: "too_large", max_bytes: EXPOSURE_MAX_TEXT * 2 }, 413);
  c.executionCtx.waitUntil(recordCheck(c.env, checkKind(c.req.header("User-Agent")), ip, { internal: internalCaller(c.req.raw.headers) }));
  const r = await exposureRequest(c.env, await bodyOf(c));
  if ("error" in r) return c.json(r, 400);
  c.executionCtx.waitUntil(bump(c.env, exposureCounters(r)).catch(() => {}));
  const { asked, ...result } = r;
  return keyedJson(c.json(await exposureAnswer(c.env, result, asked ?? []), 200, { "Cache-Control": "no-store" }), g.headers);
});

// The Gauntlet over plain HTTP (ADR 0024), for agents that can fetch but don't speak MCP. Same calls as /mcp/public.
const GAUNTLET_ID = /^g[0-9a-f]{32}$/;

publicApi.post("/api/v1/gauntlet", async (c) => {
  const body = await bodyOf(c);
  const cardFrom = typeof body.card_from === "string" && GAUNTLET_ID.test(body.card_from) ? body.card_from : undefined;
  if (body.card_from !== undefined && !cardFrom) return c.json({ error: "invalid_card_from" }, 400);
  const challenge = typeof body.challenge === "string" && CHALLENGE_PATTERN.test(body.challenge) ? body.challenge : undefined;
  if (body.challenge !== undefined && !challenge) return c.json({ error: "invalid_challenge" }, 400);
  // ADR 0083: {"mode":"sprint"} starts the one-job Gauntlet Sprint; "full" (or nothing) the six-job run.
  const mode = body.mode === "sprint" || body.mode === "full" ? body.mode : undefined;
  if (body.mode !== undefined && !mode) return c.json({ error: "invalid_mode" }, 400);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const r = await startGauntlet(c.env, ip, { cardFrom, challenge, mode });
  if (!("error" in r)) c.executionCtx.waitUntil(recordCheck(c.env, "api", ip, { internal: internalCaller(c.req.raw.headers) }));
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
  // Our own tagged callers (services/internal.ts) are counted apart, here and in recordMcp.
  const internal = await internalOf(c.req.raw);
  const copy = c.req.method === "POST" ? c.req.raw.clone() : null;
  const res = await mcpHandler(c.env, props, internal)(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
  if (copy && res.status < 400)
    c.executionCtx.waitUntil(
      getDb(c.env)
        .query.humans.findFirst({ where: eq(t.humans.id, props.humanId), columns: { isHouse: true, githubId: true } })
        .then((h) => recordMcp(c.env, h && countsAsHouse(c.env, h) ? "house" : "signed_in", copy, Date.now(), internal))
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
  // V5: optional ?watch=<fingerprints>&gauntlet_ids=<ids> (comma-separated) for since_last_week.
  const me = await describeMe(c.env, propsOf(c), { watch: c.req.query("watch"), gauntlet_ids: c.req.query("gauntlet_ids") });
  return me ? c.json(me) : c.json({ error: "agent_inactive" }, 403);
});

protectedApi.notFound((c) => c.json({ error: "not_found" }, 404));
