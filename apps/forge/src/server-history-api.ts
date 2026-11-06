import { publicApi } from "./api";
import { isLikelyBot } from "./services/bots";
import { RATE_LIMITED } from "./services/errors";
import { HISTORY_CACHE_SECONDS, HISTORY_CONTRACT, HISTORY_CONTRACT_VERSION, HISTORY_ROUTE, historyUrl, parseQuery, parseServer, serverHistory } from "./services/server-history";
import { bump } from "./services/usage";

// ADR 0141: GET /api/v1/history/{server}, one MCP server's dated record (contract forge.server-history/v1). No account
// or key. Per-address limit on every call (cached answers too), edge-cached for HISTORY_CACHE_SECONDS under the
// canonical URL (only the contract's own parameters), a strong ETag (sha256 of the body) with If-None-Match → 304.

const CONTRACT_HEADERS = { "X-Forge-Contract": HISTORY_CONTRACT, "X-Forge-Contract-Version": HISTORY_CONTRACT_VERSION };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "ETag, X-Forge-Contract, X-Forge-Contract-Version, X-Data-As-Of" };

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when an If-None-Match value names this ETag (a list, weak forms and * included; RFC 9110 §13.1.2). */
export function etagMatches(header: string | null | undefined, etag: string) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((v) => v.trim().replace(/^W\//, "") === etag);
}

const notModified = (etag: string, cacheControl: string, asOf: string | null) =>
  new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl, ...CONTRACT_HEADERS, ...CORS, ...(asOf ? { "X-Data-As-Of": asOf } : {}) } });

publicApi.get(`${HISTORY_ROUTE}/*`, async (c) => {
  const url = new URL(c.req.url);
  const raw = url.pathname.slice(HISTORY_ROUTE.length + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = "";
  }
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  // Every call is limited per address (a cached answer too), so the counter below can't run ahead of real use.
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `history:${ip}` });
  if (!success) return c.json(RATE_LIMITED, 429, { "Retry-After": String(RATE_LIMITED.retry_after_s), "Cache-Control": "no-store", ...CORS });
  const server = parseServer(decoded);
  if (!server.ok) return c.json({ ...server.error, contract: HISTORY_CONTRACT }, 400, { "Cache-Control": "no-store", ...CORS });
  const parsed = parseQuery({ section: url.searchParams.get("section") ?? undefined, offset: url.searchParams.get("offset") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
  if (!parsed.ok) return c.json({ ...parsed.error, contract: HISTORY_CONTRACT }, 400, { "Cache-Control": "no-store", ...CORS });
  if (!isLikelyBot(c.req.raw, "api")) c.executionCtx.waitUntil(bump(c.env, ["history:api"]).catch(() => {}));

  const key = new Request(historyUrl(c.env.PUBLIC_ORIGIN, server.id, parsed.query), { method: "GET" });
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) {
    const etag = hit.headers.get("ETag") ?? "";
    if (etag && etagMatches(c.req.header("If-None-Match"), etag)) return notModified(etag, hit.headers.get("Cache-Control") ?? "", hit.headers.get("X-Data-As-Of"));
    return hit;
  }
  const body = await serverHistory(c.env, server, parsed.query);
  const text = JSON.stringify(body);
  const etag = `"sha256-${await sha256Hex(text)}"`;
  const cacheControl = `public, max-age=${HISTORY_CACHE_SECONDS}`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    ...CONTRACT_HEADERS,
    ...CORS,
    ...(body.data_as_of ? { "X-Data-As-Of": body.data_as_of } : {}),
  };
  const res = new Response(text, { status: 200, headers });
  c.executionCtx.waitUntil(caches.default.put(key, res.clone()).catch(() => {}));
  if (etagMatches(c.req.header("If-None-Match"), etag)) return notModified(etag, cacheControl, body.data_as_of);
  return res;
});
