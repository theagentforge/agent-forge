import { publicApi } from "./api";
import { verifyHouseToken } from "./services/house";
import { completeRequests, createRequest, getRequest, queueForSweep, requestView } from "./services/test-requests";

// ADR 0131: the JSON API for "Request a test", and the House tester's two hooks (GitHub Actions OIDC, no shared
// secret). Answers are structured data only (AGENTS.md rule 7). Anonymous API requests never count as an owner's.

const noStore = { "Cache-Control": "no-store" };
const ipOf = (h: Headers) => h.get("CF-Connecting-IP") ?? "unknown";

/** POST /api/v1/test-requests {registry, package, version} or {id: "npm:name@1.2.3"}: queue a test (or the existing one). */
publicApi.post("/api/v1/test-requests", async (c) => {
  const body = await c.req.json().catch(() => null);
  const r = await createRequest(c.env, body, { channel: "api", ip: ipOf(c.req.raw.headers) });
  if (!r.ok) return c.json(r.error, r.status as 400, { ...noStore, ...("retry_after_s" in r.error ? { "Retry-After": String(r.error.retry_after_s) } : {}) });
  return c.json(r.view, r.created ? 201 : 200, noStore);
});

/** GET /api/v1/test-requests/:id: where a request stands, and its result once tested. */
publicApi.get("/api/v1/test-requests/:id", async (c) => {
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `request-status:${ipOf(c.req.raw.headers)}` });
  if (!success) return c.json({ error: "rate_limited", retry_after_s: 60 }, 429, { ...noStore, "Retry-After": "60" });
  const row = await getRequest(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404, noStore);
  return c.json(await requestView(c.env, row), 200, noStore);
});

const house = async (authorization: string | undefined, origin: string) => !!(await verifyHouseToken((authorization ?? "").replace(/^Bearer\s+/i, ""), origin));

/**
 * GET /api/v1/house/requests/queue: the next requested servers for the weekly sweep, read only (names and versions,
 * which are on their public result pages anyway). Public, because the House plan job holds no token by design.
 */
publicApi.get("/api/v1/house/requests/queue", async (c) => {
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `request-queue:${ipOf(c.req.raw.headers)}` });
  if (!success) return c.json({ error: "rate_limited", retry_after_s: 60 }, 429, { ...noStore, "Retry-After": "60" });
  return c.json({ data_kind: "test_request_queue", requests: await queueForSweep(c.env) }, 200, noStore);
});

/** POST /api/v1/house/requests: the file job's results for requested servers (kept apart from the sweep's own family). */
publicApi.post("/api/v1/house/requests", async (c) => {
  if (!(await house(c.req.header("Authorization"), c.env.PUBLIC_ORIGIN))) return c.json({ error: "unauthorized" }, 401);
  const r = await completeRequests(c.env, await c.req.json().catch(() => null));
  return r.ok ? c.json(r, 201) : c.json({ ok: false, reason: "invalid_requests", detail: r.detail }, 422);
});
