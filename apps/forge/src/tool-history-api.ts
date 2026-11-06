import { publicApi } from "./api";
import { verifyBackfillToken } from "./services/house";
import { backfillPlan, enqueueVersions, recordBackfillResults } from "./services/tool-history";

// ADR 0134: the tool-history backfill's three hooks. The plan is public and read only (the plan job holds no token,
// like the request-a-test queue); the two writes need house-backfill.yml's GitHub OIDC token (no shared secret).
// Answers are structured data only (AGENTS.md rule 7).

const noStore = { "Cache-Control": "no-store" };
const backfill = async (authorization: string | undefined, origin: string) => !!(await verifyBackfillToken((authorization ?? "").replace(/^Bearer\s+/i, ""), origin));

/** GET /api/v1/house/backfill/plan: servers whose version list isn't read yet, and the next pending versions. */
publicApi.get("/api/v1/house/backfill/plan", async (c) => {
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `backfill-plan:${c.req.header("CF-Connecting-IP") ?? "unknown"}` });
  if (!success) return c.json({ error: "rate_limited", retry_after_s: 60 }, 429, { ...noStore, "Retry-After": "60" });
  const limit = Number(c.req.query("limit") ?? "") || undefined;
  return c.json(await backfillPlan(c.env, limit), 200, noStore);
});

/** POST /api/v1/house/backfill/versions: the registry's version lists (with publish dates) the plan job read. */
publicApi.post("/api/v1/house/backfill/versions", async (c) => {
  if (!(await backfill(c.req.header("Authorization"), c.env.PUBLIC_ORIGIN))) return c.json({ error: "unauthorized" }, 401);
  const r = await enqueueVersions(c.env, await c.req.json().catch(() => null));
  return r.ok ? c.json(r, 201) : c.json({ ok: false, reason: "invalid_versions", detail: r.detail }, 422);
});

/** POST /api/v1/house/backfill/results: what each version listed (or why it didn't start), from the backfill shards. */
publicApi.post("/api/v1/house/backfill/results", async (c) => {
  if (!(await backfill(c.req.header("Authorization"), c.env.PUBLIC_ORIGIN))) return c.json({ error: "unauthorized" }, 401);
  const r = await recordBackfillResults(c.env, await c.req.json().catch(() => null));
  return r.ok ? c.json(r, 201) : c.json({ ok: false, reason: "invalid_results", detail: r.detail }, 422);
});
