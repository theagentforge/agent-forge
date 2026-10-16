import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { API_VERSION } from "@forge/shared";
import { Hono } from "hono";
import { protectedApi, publicApi } from "./api";
import { auth } from "./auth";
import { PUBLIC_MCP_ROUTE, publicMcpHandler } from "./mcp-public";
import { type McpEndpoint, recordMcp } from "./services/usage";
import { seedRun } from "./seed/mcp-registry";
import { refreshCatalog } from "./arena/catalog";
import { arenaTick } from "./arena/runner";
import { sweepPendingNotes } from "./services/moderation-sweep";
import { writeSnapshot } from "./services/proof";
import { notFound, site } from "./web/pages";
import "./web/static-pages";
import "./web/about";
import "./web/legal";
import "./web/publications";
import "./web/arena";
import "./web/arena-fans";
import "./web/arena-proving";
import "./web/badge";
import "./web/registry";
import "./web/house-report";
import "./web/trap-card";
import "./web/connect";
import "./web/dashboard";
import "./web/publishers";
import "./web/og";

// One Worker: OAuth authorization server, MCP server, REST API (MASTER_PLAN §10.2).

const app = new Hono<{ Bindings: Env }>();

// Health check: confirms the Worker is running and can reach its database.
app.get(`/api/${API_VERSION}/health`, async (c) => {
  let db: "ok" | "error" = "ok";
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch {
    db = "error";
  }
  const ok = db === "ok";
  return c.json(
    { status: ok ? "ok" : "degraded", service: "forge", environment: c.env.ENVIRONMENT, db },
    ok ? 200 : 503,
  );
});

app.route("/", publicApi);
app.route("/", auth);
app.route("/", site);
app.notFound((c) =>
  c.req.path.startsWith("/api/") ? c.json({ error: "not_found" }, 404) : notFound(c, "Page not found", "That page doesn't exist."),
);

export const PROTECTED_ROUTES = [
  "/mcp",
  `/api/${API_VERSION}/report`,
  `/api/${API_VERSION}/me`,
];

export function providerOptions(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: PROTECTED_ROUTES,
    apiHandler: protectedApi,
    defaultHandler: app,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register", // DCR, the fallback for clients without CIMD
    clientIdMetadataDocumentEnabled: true,
    // One resource covers /mcp and the REST routes, so one token works for both.
    resourceMetadata: { resource: origin, authorization_servers: [origin] },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86_400,
  };
}

// The provider's options depend on this environment's public origin, so it is built once per origin.
const providers = new Map<string, OAuthProvider<Env>>();

export default {
  /** Hourly: seed from the official MCP Registry; in the first run after midnight UTC, write the proof snapshot. */
  async scheduled(controller, env, ctx) {
    if (controller.cron === "*/5 * * * *") {
      // Awaited, not waitUntil: work left to waitUntil after the handler returns gets about 30 seconds, which cut each
      // tick to ~3 bouts. A Cron Trigger itself may run for 15 minutes; arenaTick stops after 10, and its lock prevents
      // overlap with the next tick.
      try {
        console.log("arena_tick", JSON.stringify(await arenaTick(env)));
      } catch (e) {
        console.error("arena_tick_failed", String(e));
      }
      return;
    }
    ctx.waitUntil(
      refreshCatalog(env).then(
        (n) => console.log("arena_catalog", n),
        (e) => console.error("arena_catalog_failed", String(e)),
      ),
    );
    if (new Date(controller.scheduledTime).getUTCHours() === 0) {
      ctx.waitUntil(
        writeSnapshot(env, controller.scheduledTime).then(
          (r) => console.log("proof_snapshot", JSON.stringify(r)),
          (e) => console.error("proof_snapshot_failed", String(e)),
        ),
      );
    }
    ctx.waitUntil(
      seedRun(env).then(
        (r) => console.log("seed_run", JSON.stringify(r)),
        (e) => console.error("seed_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      sweepPendingNotes(env).then(
        (r) => console.log("note_sweep", JSON.stringify(r)),
        (e) => console.error("note_sweep_failed", String(e)),
      ),
    );
  },
  fetch(request, env, ctx) {
    // The anonymous, read-only MCP endpoint (ADR 0017 §3) is answered before the OAuth provider, which would
    // otherwise treat it as part of the protected /mcp route.
    const path = new URL(request.url).pathname;
    // Usage counts (services/usage.ts): read from a copy of the body, counted only when the endpoint accepted it.
    const counted = (endpoint: McpEndpoint, res: Response | Promise<Response>, copy: Request | null) =>
      Promise.resolve(res).then((r) => {
        if (copy && r.status < 400) ctx.waitUntil(recordMcp(env, endpoint, copy));
        return r;
      });
    const copyIfPost = () => (request.method === "POST" ? request.clone() : null);
    if (path === PUBLIC_MCP_ROUTE || path.startsWith(`${PUBLIC_MCP_ROUTE}/`)) {
      const copy = copyIfPost();
      return counted("public", publicMcpHandler(env, request.headers.get("CF-Connecting-IP") ?? "unknown")(request, env, ctx), copy);
    }
    let provider = providers.get(env.PUBLIC_ORIGIN);
    if (!provider) {
      provider = new OAuthProvider<Env>(providerOptions(env.PUBLIC_ORIGIN));
      providers.set(env.PUBLIC_ORIGIN, provider);
    }
    if (path === "/mcp") {
      const copy = copyIfPost();
      return counted("signed_in", provider.fetch(request, env, ctx), copy);
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
