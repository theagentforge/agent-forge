import { pingIndexNow } from "./services/indexnow";
import { refreshKev } from "./services/kev";
import { registerAgentverse } from "./agentverse";
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { API_VERSION } from "@forge/shared";
import { Hono } from "hono";
import { protectedApi, publicApi } from "./api";
import { auth } from "./auth";
import { GAUNTLET_MCP_ROUTE, gauntletMcpHandler, PUBLIC_MCP_ROUTE, publicMcpHandler } from "./mcp-public";
import { type McpEndpoint, recordMcp } from "./services/usage";
import { type InternalComponent, internalOf } from "./services/internal";
import { seedRun } from "./seed/mcp-registry";
import { seedReferenceServers } from "./seed/reference-servers";
import { seedAiStack } from "./seed/ai-stack";
import { refreshCatalog } from "./arena/catalog";
import { arenaTick } from "./arena/runner";
import { rescoreTick } from "./arena/rescore-job";
import { refreshClipIndex } from "./arena/clips";
import { sweepGauntletLogs } from "./arena/gauntlet";
import { writeSeasonSnapshot } from "./arena/season";
import { importSkillSeed, releaseHeldScans } from "./services/skill-seed";
import { sweepPendingNotes } from "./services/moderation-sweep";
import { writeSnapshot } from "./services/proof";
import { getDb } from "./services/db";
import { writeLadderSnapshot } from "./services/digest";
import { runMoltbookReplies } from "./social/moltbook-replies";
import { notFound, site } from "./web/pages";
import "./web/static-pages";
import "./web/about";
import "./web/teams";
import "./web/legal";
import "./web/publications";
import "./web/admin-moltbook";
import "./web/admin-kpis";
import "./web/admin-review";
import "./web/admin-arena-panel";
import "./web/admin-arena-rescore";
import "./web/arena";
import "./web/arena-fans";
import "./web/arena-proving";
import "./web/gauntlet";
import "./web/gauntlet-season";
import "./web/scan";
import "./web/arena-agent";
import "./web/arena-methodology";
import "./web/croissant";
import "./web/results-policy";
import "./web/arena-history";
import "./web/arena-clip";
import "./web/arena-failures";
import "./web/arena-fotw";
import "./web/arena-business";
import "./web/arena-answers";
import "./web/badge";
import "./web/registry";
import "./web/house-report";
import "./web/trap-card";
import "./web/connect";
import "./web/contribute";
import "./web/dashboard";
import "./web/digest-feed";
import "./web/publishers";
import "./web/og";
import "./a2a";
import "./agentverse";
import "./web/answers";
import "./web/skills-index";
import "./web/receipt";
import "./web/openapi";
import { CARD_PATHS } from "./web/discovery";

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
      // Re-scoring stored runs under the current referee, when a job is set in KV (arena/rescore-job.ts).
      try {
        const r = await rescoreTick(env);
        if (r) console.log("arena_rescore", JSON.stringify({ mode: r.mode, checked: r.checked, changed: r.changed.length, unfaithful: r.unfaithful.length, errors: r.errors.length, done: r.done }));
      } catch (e) {
        console.error("arena_rescore_failed", String(e));
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
      refreshKev(env, controller.scheduledTime).then(
        (r) => console.log("kev", JSON.stringify(r)),
        (e) => console.error("kev_failed", String(e)),
      ),
    );
    // ADR 0061: refresh the Agentverse listing (production, and only once the AGENTVERSE_CONNECTION secret is set).
    if (env.ENVIRONMENT === "production" && env.AGENTVERSE_CONNECTION)
      ctx.waitUntil(
        registerAgentverse(env, controller.scheduledTime).then(
          (r) => console.log("agentverse", JSON.stringify(r)),
          (e) => console.error("agentverse_failed", String(e).slice(0, 120)),
        ),
      );
    ctx.waitUntil(
      pingIndexNow(env, controller.scheduledTime).then(
        (r) => console.log("indexnow", JSON.stringify(r)),
        (e) => console.error("indexnow_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      seedReferenceServers(env).then(
        (n) => n && console.log("seed_reference", n),
        (e) => console.error("seed_reference_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      seedAiStack(env).then(
        (n) => n && console.log("seed_ai_stack", n),
        (e) => console.error("seed_ai_stack_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      seedRun(env).then(
        (r) => console.log("seed_run", JSON.stringify(r)),
        (e) => console.error("seed_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      refreshClipIndex(env).then(
        (r) => console.log("clip_index", JSON.stringify(r)),
        (e) => console.error("clip_index_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      importSkillSeed(env).then(
        (r) => console.log("skill_seed", JSON.stringify(r)),
        (e) => console.error("skill_seed_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      releaseHeldScans(env, controller.scheduledTime).then(
        (r) => console.log("skill_seed_release", JSON.stringify(r)),
        (e) => console.error("skill_seed_release_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      sweepGauntletLogs(env, controller.scheduledTime).then(
        (r) => console.log("gauntlet_sweep", JSON.stringify(r)),
        (e) => console.error("gauntlet_sweep_failed", String(e)),
      ),
    );
    // ADR 0055: Gauntlet Season 1's weekly snapshot, frozen once at the end of each season week.
    ctx.waitUntil(
      writeSeasonSnapshot(env, controller.scheduledTime).then(
        (r) => r.written && console.log("season_snapshot", JSON.stringify(r)),
        (e) => console.error("season_snapshot_failed", String(e)),
      ),
    );
    // V5: one Ranked Ladder snapshot a day (written once), so the weekly digest can show rank moves.
    ctx.waitUntil(
      writeLadderSnapshot(env, getDb(env), controller.scheduledTime).then(
        (r) => r.written && console.log("ladder_snapshot", JSON.stringify(r)),
        (e) => console.error("ladder_snapshot_failed", String(e)),
      ),
    );
    ctx.waitUntil(
      sweepPendingNotes(env).then(
        (r) => console.log("note_sweep", JSON.stringify(r)),
        (e) => console.error("note_sweep_failed", String(e)),
      ),
    );
    // Answers to questions on our own Moltbook posts (ADR 0044). Awaited, not waitUntil: replies are 25 s apart, longer
    // than waitUntil allows after the handler returns. Pages are read from this Worker itself, as JSON.
    const readPage = async (path: string) => {
      const sep = path.includes("?") ? "&" : "?";
      const r = await app.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}${sep}format=json`), env, ctx);
      return r.ok ? r.text() : null;
    };
    // Production only: staging shares no comments with it, and two Workers answering the same thread would double up.
    if (env.ENVIRONMENT === "production") console.log("moltbook_replies", JSON.stringify(await runMoltbookReplies(env, readPage)));
  },
  fetch(request, env, ctx) {
    // The anonymous, read-only MCP endpoint (ADR 0017 §3) is answered before the OAuth provider, which would
    // otherwise treat it as part of the protected /mcp route.
    const url = new URL(request.url);
    // Clients that append /mcp to every MCP address: /mcp/public/mcp is the same endpoint.
    if (url.pathname === `${PUBLIC_MCP_ROUTE}/mcp`) {
      url.pathname = PUBLIC_MCP_ROUTE;
      request = new Request(url, request);
    }
    // Clients that send no Accept, or */*, on an MCP POST were refused with 406 (24 Oct check); the answer is the same
    // JSON-RPC either way, so they get the pair the MCP handler expects.
    if (request.method === "POST" && (url.pathname === PUBLIC_MCP_ROUTE || url.pathname === GAUNTLET_MCP_ROUTE)) {
      const accept = request.headers.get("accept") ?? "";
      if (!accept.trim() || accept.trim() === "*/*") {
        const headers = new Headers(request.headers);
        headers.set("Accept", "application/json, text/event-stream");
        request = new Request(request, { headers });
      }
    }
    const path = url.pathname;
    // Usage counts (services/usage.ts): read from a copy of the body, counted only when the endpoint accepted it.
    const counted = (endpoint: McpEndpoint, res: Response | Promise<Response>, copy: Request | null, internal: InternalComponent | null = null) =>
      Promise.resolve(res).then((r) => {
        if (copy && r.status < 400) ctx.waitUntil(recordMcp(env, endpoint, copy, Date.now(), internal));
        // Refusals are logged with the JSON-RPC method and protocol version (no arguments), so they can be traced.
        else if (copy && r.status === 400)
          ctx.waitUntil(copy.json().then((b) => console.warn("mcp_400", endpoint, String((b as { method?: unknown })?.method ?? "").slice(0, 60), (request.headers.get("mcp-protocol-version") ?? "").slice(0, 20)), () => console.warn("mcp_400", endpoint, "unparsable")));
        return r;
      });
    const copyIfPost = () => (request.method === "POST" ? request.clone() : null);
    // MCP Server Cards (SEP-2127) live under each endpoint's path but are static pages, answered by the site.
    if (request.method === "GET" && CARD_PATHS.includes(path)) return app.fetch(request, env, ctx);
    // Wrong doors (Worker logs, 23 Oct: 117 GETs refused with 405 in a day). A plain GET of an MCP endpoint from a
    // browser goes to /connect, and from anything else gets the endpoint's server card; a GET asking for an event
    // stream is still the MCP handler's to answer.
    for (const route of [PUBLIC_MCP_ROUTE, GAUNTLET_MCP_ROUTE]) {
      if (path !== route || request.method !== "GET") continue;
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("text/event-stream")) break;
      if (accept.includes("text/html")) return Response.redirect(`${env.PUBLIC_ORIGIN}${route === PUBLIC_MCP_ROUTE ? "/connect" : "/gauntlet"}`, 302);
      return app.fetch(new Request(new URL(`${route}/server-card`, request.url), request), env, ctx);
    }
    // Our own probes (services/internal.ts), by header, User-Agent or MCP client name: counted apart, served the same.
    if (path === PUBLIC_MCP_ROUTE || path.startsWith(`${PUBLIC_MCP_ROUTE}/`)) {
      const copy = copyIfPost();
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      return internalOf(request).then((internal) => counted("public", publicMcpHandler(env, ip, internal)(request, env, ctx), copy, internal));
    }
    if (path === GAUNTLET_MCP_ROUTE || path.startsWith(`${GAUNTLET_MCP_ROUTE}/`)) {
      const copy = copyIfPost();
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      return internalOf(request).then((internal) => counted("gauntlet", gauntletMcpHandler(env, ip, internal)(request, env, ctx), copy, internal));
    }
    let provider = providers.get(env.PUBLIC_ORIGIN);
    if (!provider) {
      provider = new OAuthProvider<Env>(providerOptions(env.PUBLIC_ORIGIN));
      providers.set(env.PUBLIC_ORIGIN, provider);
    }
    // Signed-in /mcp is counted in api.ts, where the agent is known, so House sessions are kept apart (ADR 0023 §3).
    if (path !== "/mcp") return provider.fetch(request, env, ctx);
    // 433 refusals in a day from clients without a sign-in: the 401 also names the endpoint that needs none.
    return provider.fetch(request, env, ctx).then((res) => {
      if (res.status !== 401) return res;
      const headers = new Headers(res.headers);
      headers.append("Link", `<${env.PUBLIC_ORIGIN}${PUBLIC_MCP_ROUTE}>; rel="alternate"; title="no sign-in, read only"`);
      return res.text().then((text) => {
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(text);
          body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { error: "unauthorized" };
        } catch {
          body = { error: "unauthorized" };
        }
        headers.set("Content-Type", "application/json");
        headers.delete("Content-Length");
        // ADR 0056: and where a person connects an agent, the one step that filing reports needs (data, not a prompt).
        return new Response(JSON.stringify({ ...body, public_endpoint: `${env.PUBLIC_ORIGIN}${PUBLIC_MCP_ROUTE}`, connect_url: `${env.PUBLIC_ORIGIN}/connect` }), { status: 401, headers });
      });
    });
  },
} satisfies ExportedHandler<Env>;
