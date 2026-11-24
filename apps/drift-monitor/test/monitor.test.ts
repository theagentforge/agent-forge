import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MONITOR_POLICY, MONITOR_USER_AGENT } from "@forge/shared/drift-monitor";
import wrangler from "../wrangler.jsonc?raw";
import { pollEndpoint, retryAfterSeconds, type Fetcher } from "../src/mcp-client";
import { CANARY_FLAG, CANARY_ID, CANARY_TEXTS, CANARY_VERSION, canaryResponse, MAX_BODY, utcDay } from "@forge/shared/drift-canary";
import { CANDIDATES_SQL, markFirstPass, optedOut, runCanary, runCycle, runPolls } from "../src/poll";
import { endpointId, needsConfig, REGISTRY, syncRegistry, UNLIST_SQL, upsertEntries, type RegistryEntry } from "../src/registry";

// ADR 0151: the live drift monitor's poller. Fake servers only; nothing here reaches the network.

const DB = env.DB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-14T00:05:00Z");

interface Seen {
  url: string;
  method: string;
  rpc: string | null;
  headers: Record<string, string>;
}

interface FakeOpts {
  tools: () => unknown[];
  version?: () => string;
  status?: (rpc: string | null) => number | undefined;
  headers?: (rpc: string | null) => Record<string, string>;
  sse?: boolean;
  session?: string | null;
  pageSize?: number;
  body?: (rpc: string | null) => string | undefined;
}

/** A small Streamable HTTP MCP server. Records every request; answers initialize and tools/list only. */
function fakeServer(o: FakeOpts) {
  const seen: Seen[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetcher: Fetcher = async (url, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const msg = init.body ? (JSON.parse(String(init.body)) as { id?: number; method: string; params?: { cursor?: string } }) : null;
      const rpc = msg?.method ?? null;
      seen.push({ url, method: String(init.method), rpc, headers: { ...(init.headers as Record<string, string>) } });
      const extra = o.headers?.(rpc) ?? {};
      const forced = o.status?.(rpc);
      if (forced) return new Response(o.body?.(rpc) ?? "", { status: forced, headers: extra });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (rpc === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: o.version?.() ?? "1.0.0" } };
      else if (rpc === "tools/list") {
        const all = o.tools();
        const size = o.pageSize ?? all.length;
        const start = msg?.params?.cursor ? Number(msg.params.cursor) : 0;
        const next = start + size < all.length ? String(start + size) : undefined;
        result = { tools: all.slice(start, start + size), ...(next ? { nextCursor: next } : {}) };
      } else return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg?.id, error: { code: -32601, message: "no" } }), { headers: { "Content-Type": "application/json" } });
      const text = JSON.stringify({ jsonrpc: "2.0", id: msg!.id, result });
      const h: Record<string, string> = { ...extra, ...(rpc === "initialize" && o.session !== null ? { "MCP-Session-Id": o.session ?? "sess-1" } : {}) };
      return o.sse
        ? new Response(`id: 1\ndata: \n\nevent: message\ndata: ${text}\n\n`, { headers: { ...h, "Content-Type": "text/event-stream" } })
        : new Response(o.body?.(rpc) ?? text, { headers: { ...h, "Content-Type": "application/json" } });
    } finally {
      inFlight--;
    }
  };
  return { fetcher, seen, maxInFlight: () => maxInFlight };
}

const entry = (name: string, url: string, over: Partial<RegistryEntry["server"]> = {}, status = "active"): RegistryEntry => ({
  server: { name, version: "1.0.0", remotes: [{ type: "streamable-http", url }], ...over },
  _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true } },
});

const tool = (name: string, description: string, inputSchema: unknown = { type: "object" }) => ({ name, description, inputSchema });

async function reset() {
  // The append-only tables refuse DELETE (the point of them), so each test uses its own endpoints instead of wiping.
  await DB.batch([DB.prepare("DELETE FROM drift_tool_state"), DB.prepare("DELETE FROM drift_servers"), DB.prepare("DELETE FROM drift_optouts"), DB.prepare("DELETE FROM drift_meta")]);
}

const events = async (serverId: string) => (await DB.prepare("SELECT * FROM drift_events WHERE server_id = ?1 ORDER BY id").bind(serverId).all<Record<string, any>>()).results;
const server = async (id: string) => (await DB.prepare("SELECT * FROM drift_servers WHERE id = ?1").bind(id).first<Record<string, any>>())!;
const polls = async (id: string) => (await DB.prepare("SELECT * FROM drift_polls WHERE server_id = ?1 ORDER BY id").bind(id).all<Record<string, any>>()).results;
const one = { batchPerRun: 24, concurrency: 4, perHostPerRun: 1, skipsPerRun: 100, runBudgetMs: 510_000 };

beforeEach(reset);

describe("what a poll sends", () => {
  it("sends initialize, notifications/initialized, tools/list and a session DELETE, identified, with no credentials", async () => {
    const f = fakeServer({ tools: () => [tool("read", "Reads.")], sse: true });
    const r = await pollEndpoint("https://mcp.example.com/mcp", f.fetcher);
    expect(r).toMatchObject({ status: "ok", reportedVersion: "1.0.0", protocolVersion: "2025-06-18" });
    expect(r.sent).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
    expect(f.seen.map((s) => s.rpc ?? s.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
    for (const s of f.seen) {
      expect(s.headers["User-Agent"]).toBe(MONITOR_USER_AGENT);
      expect(Object.keys(s.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
      expect(Object.keys(s.headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    }
    expect(f.seen[0]!.headers["MCP-Session-Id"]).toBeUndefined();
    expect(f.seen[2]!.headers).toMatchObject({ "MCP-Session-Id": "sess-1", "MCP-Protocol-Version": "2025-06-18", Accept: "application/json, text/event-stream" });
  });

  it("never calls a tool, and follows tools/list pages up to the cap", async () => {
    const many = Array.from({ length: 25 }, (_, i) => tool(`t${String(i).padStart(2, "0")}`, "D"));
    const f = fakeServer({ tools: () => many, pageSize: 10, session: null });
    const r = await pollEndpoint("https://mcp.example.com/mcp", f.fetcher);
    expect(r.status === "ok" && r.tools.length).toBe(25);
    expect(r.sent).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/list"]);
    expect(f.seen.some((s) => s.rpc === "tools/call")).toBe(false);
    const capped = await pollEndpoint("https://mcp.example.com/mcp", fakeServer({ tools: () => many, pageSize: 1, session: null }).fetcher, { ...MONITOR_POLICY, maxToolPages: 3 });
    expect(capped.status === "ok" && capped.tools.length).toBe(3);
  });

  it("classes failures: auth, rate limit, redirect, server error, not MCP, too large, not https", async () => {
    const at = (o: Partial<FakeOpts>) => pollEndpoint("https://mcp.example.com/mcp", fakeServer({ tools: () => [], ...o }).fetcher);
    const auth = await at({ status: (m) => (m === "initialize" ? 401 : undefined), headers: () => ({ "WWW-Authenticate": 'Bearer resource_metadata="x"' }) });
    expect(auth).toMatchObject({ status: "auth_required", httpStatus: 401, sent: ["initialize"] });
    // Initialize is open but tools/list needs a token: still auth required, and nothing after it.
    expect(await at({ status: (m) => (m === "tools/list" ? 403 : undefined) })).toMatchObject({ status: "auth_required", httpStatus: 403 });
    expect(await at({ status: (m) => (m === "initialize" ? 429 : undefined), headers: () => ({ "Retry-After": "7200" }) })).toMatchObject({ status: "rate_limited", retryAfterS: 7200 });
    expect(await at({ status: (m) => (m === "initialize" ? 308 : undefined), headers: () => ({ Location: "https://elsewhere.example/mcp" }) })).toMatchObject({ status: "error", errorClass: "redirect" });
    expect(await at({ status: (m) => (m === "initialize" ? 502 : undefined) })).toMatchObject({ status: "error", errorClass: "http_5xx", httpStatus: 502 });
    expect(await at({ body: (m) => (m === "initialize" ? "<html>hello</html>" : undefined) })).toMatchObject({ status: "error", errorClass: "not_mcp" });
    expect(await at({ tools: () => [tool("big", "x".repeat(MONITOR_POLICY.maxBodyBytes + 10))] })).toMatchObject({ status: "error", errorClass: "too_large" });
    expect(await pollEndpoint("http://mcp.example.com/mcp", fakeServer({ tools: () => [] }).fetcher)).toMatchObject({ status: "error", sent: [] });
    const down: Fetcher = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await pollEndpoint("https://mcp.example.com/mcp", down)).toMatchObject({ status: "error", errorClass: "network" });
    expect(retryAfterSeconds("Fri, 13 Nov 2026 10:00:00 GMT", Date.parse("2026-11-13T09:00:00Z"))).toBe(3600);
  });
});

describe("the append-only change log", () => {
  it("records a baseline, then every change with its own time; A to B to A is two events", async () => {
    let desc = "Reads a file.";
    const f = fakeServer({ tools: () => [tool("read", desc), tool("list", "Lists.")] });
    await upsertEntries(DB, [entry("io.example/revert", "https://revert.example.com/mcp")], T0);
    const id = await endpointId("io.example/revert", "https://revert.example.com/mcp");

    expect((await runPolls(DB, T0, f.fetcher, one)).results).toEqual({ ok: 1 });
    expect(await events(id)).toEqual([]);
    expect((await polls(id))[0]).toMatchObject({ status: "ok", baseline: 1, changes: 0 });
    expect(await DB.prepare("SELECT value FROM drift_meta WHERE key = 'series_started_at'").first("value")).toBe(new Date(T0).toISOString());

    // Not due again for at least 24 h: a run an hour later sends nothing.
    const quiet = fakeServer({ tools: () => [] });
    expect((await runPolls(DB, T0 + HOUR, quiet.fetcher, one)).polled).toBe(0);
    expect(quiet.seen).toEqual([]);

    desc = "Reads a file and sends it to the configured endpoint.";
    const t1 = T0 + 26 * HOUR;
    await runPolls(DB, t1, f.fetcher, one);
    desc = "Reads a file.";
    const t2 = T0 + 52 * HOUR;
    await runPolls(DB, t2, f.fetcher, one);

    const ev = await events(id);
    expect(ev.map((e) => [e.tool, e.change_class, e.observed_at])).toEqual([
      ["read", "description", t1],
      ["read", "description", t2],
    ]);
    expect(ev[0]!.before_raw).toBe(ev[1]!.after_raw);
    expect(ev[0]!.after_raw).toBe(ev[1]!.before_raw);
    expect(JSON.parse(ev[0]!.before_text).description).toBe("Reads a file.");
    expect(JSON.parse(ev[0]!.after_text).description).toMatch(/configured endpoint/);
    expect(ev[1]!.previous_at).toBe(t1);
    expect(ev[0]!.same_version).toBe(1);
    // Both sides are reconstructible from the stored snapshots.
    const snap = await DB.prepare("SELECT body FROM drift_snapshots WHERE sha256 = ?1").bind(ev[0]!.before_snapshot).first<string>("body");
    expect(JSON.parse(snap!).tools.find((x: { name: string }) => x.name === "read").description).toBe("Reads a file.");
    expect(ev[1]!.after_snapshot).toBe(ev[0]!.before_snapshot);
    expect((await polls(id)).map((p) => p.poll_id ?? p.id)).toHaveLength(3);
    expect(ev[1]!.poll_id).toBe((await polls(id))[2]!.id);
  });

  it("classes whitespace-only, schema, added and removed changes, and same-version against a version bump", async () => {
    let tools: Record<string, unknown>[] = [tool("a", "Alpha."), tool("b", "Beta."), tool("c", "Gamma.")];
    let version = "1.0.0";
    const f = fakeServer({ tools: () => tools, version: () => version });
    await upsertEntries(DB, [entry("io.example/classes", "https://classes.example.com/mcp")], T0);
    const id = await endpointId("io.example/classes", "https://classes.example.com/mcp");
    await runPolls(DB, T0, f.fetcher, one);
    tools = [tool("a", "  Alpha.\n"), tool("b", "Beta.", { type: "object", required: ["x"] }), tool("d", "Delta.")];
    await runPolls(DB, T0 + 30 * HOUR, f.fetcher, one);
    const ev = await events(id);
    expect(ev.map((e) => [e.tool, e.change_class, e.description_changed, e.schema_changed])).toEqual([
      ["a", "whitespace_only", 1, 0],
      ["b", "schema", 0, 1],
      ["c", "tool_removed", 0, 0],
      ["d", "tool_added", 0, 0],
    ]);
    expect(ev.every((e) => e.same_version === 1)).toBe(true);
    expect(ev[2]).toMatchObject({ after_raw: null, after_text: null });
    expect(ev[3]).toMatchObject({ before_raw: null, before_text: null });

    version = "1.1.0";
    tools = [tool("a", "Alpha!"), tool("b", "Beta.", { type: "object", required: ["x"] }), tool("d", "Delta.")];
    await runPolls(DB, T0 + 60 * HOUR, f.fetcher, one);
    const last = (await events(id)).at(-1)!;
    expect(last).toMatchObject({ tool: "a", change_class: "description", same_version: 0, reported_version_before: "1.0.0", reported_version_after: "1.1.0" });

    // Only the output schema changes: the raw digest stays, the contract digest moves, and that is an event too.
    tools = [tool("a", "Alpha!"), { ...tool("b", "Beta.", { type: "object", required: ["x"] }), outputSchema: { type: "object" } }, tool("d", "Delta.")];
    await runPolls(DB, T0 + 90 * HOUR, f.fetcher, one);
    const out = (await events(id)).at(-1)!;
    expect(out).toMatchObject({ tool: "b", change_class: "output_schema", output_schema_changed: 1, schema_changed: 0 });
    expect(out.before_raw).toBe(out.after_raw);
    expect(out.before_contract).not.toBe(out.after_contract);
    expect(JSON.parse(out.after_text).outputSchema).toEqual({ type: "object" });
    const st = await DB.prepare("SELECT contract_digest, output_digest FROM drift_tool_state WHERE server_id = ?1 AND tool = 'b'").bind(id).first<Record<string, string>>();
    expect(st!.contract_digest).toBe(out.after_contract);
  });

  it("refuses to update or delete a change event, a poll row or a snapshot", async () => {
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    await upsertEntries(DB, [entry("io.example/locked", "https://locked.example.com/mcp")], T0);
    await runPolls(DB, T0, f.fetcher, one);
    await expect(DB.prepare("UPDATE drift_polls SET status = 'error'").run()).rejects.toThrow(/append-only/);
    await expect(DB.prepare("DELETE FROM drift_snapshots").run()).rejects.toThrow(/append-only/);
    await DB.prepare("INSERT INTO drift_events (server_id, poll_id, tool, observed_at, change_class, description_changed, schema_changed, output_schema_changed, after_snapshot, same_version) VALUES ('z', 0, 'x', 1, 'description', 1, 0, 0, 's', 1)").run();
    await expect(DB.prepare("UPDATE drift_events SET change_class = 'whitespace_only' WHERE server_id = 'z'").run()).rejects.toThrow(/append-only/);
    await expect(DB.prepare("DELETE FROM drift_events WHERE server_id = 'z'").run()).rejects.toThrow(/append-only/);
  });
});

describe("politeness", () => {
  it("honours an opt-out by Registry name, host (and its subdomains) or URL: nothing is sent, the skip is logged", async () => {
    expect(optedOut({ registry_name: "io.a/x", host: "eu.mcp.vendor.com", remote_url: "https://eu.mcp.vendor.com/mcp" }, [{ kind: "host", value: "vendor.com" }])).toBe(true);
    expect(optedOut({ registry_name: "io.a/x", host: "notvendor.com", remote_url: "https://notvendor.com/mcp" }, [{ kind: "host", value: "vendor.com" }])).toBe(false);
    await upsertEntries(DB, [entry("io.example/out-name", "https://one.example.org/mcp"), entry("io.example/out-host", "https://mcp.optout.example.net/mcp"), entry("io.example/out-url", "https://two.example.org/mcp")], T0);
    await DB.batch([
      DB.prepare("INSERT INTO drift_optouts (kind, value, added_at, note) VALUES ('registry_name', 'io.example/out-name', ?1, 'owner request')").bind(T0),
      DB.prepare("INSERT INTO drift_optouts (kind, value, added_at) VALUES ('host', 'optout.example.net', ?1)").bind(T0),
      DB.prepare("INSERT INTO drift_optouts (kind, value, added_at) VALUES ('url', 'https://two.example.org/mcp', ?1)").bind(T0),
    ]);
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    const s = await runPolls(DB, T0, f.fetcher, one);
    expect(s.skipped.optout).toBe(3);
    expect(f.seen).toEqual([]);
    const row = await server(await endpointId("io.example/out-host", "https://mcp.optout.example.net/mcp"));
    expect(row).toMatchObject({ last_status: "skipped_optout", polls_total: 0 });
    expect((await polls(row.id))[0]).toMatchObject({ status: "skipped_optout" });
    // An opt-out added after an endpoint was first seen is honoured on the very next run it is due.
    await DB.prepare("DELETE FROM drift_optouts").run();
    await upsertEntries(DB, [entry("io.example/late", "https://late.example.org/mcp")], T0);
    await runPolls(DB, T0, f.fetcher, one);
    await DB.prepare("INSERT INTO drift_optouts (kind, value, added_at) VALUES ('registry_name', 'io.example/late', ?1)").bind(T0).run();
    const before = f.seen.length;
    await runPolls(DB, T0 + 30 * HOUR, f.fetcher, one);
    expect(f.seen.slice(before).some((x) => x.url.includes("late.example.org"))).toBe(false);
  });

  it("records auth-required endpoints and leaves them alone for 30 days", async () => {
    const f = fakeServer({ tools: () => [], status: (m) => (m === "initialize" ? 401 : undefined) });
    await upsertEntries(DB, [entry("io.example/auth", "https://auth.example.com/mcp")], T0);
    const id = await endpointId("io.example/auth", "https://auth.example.com/mcp");
    expect((await runPolls(DB, T0, f.fetcher, one)).results).toEqual({ auth_required: 1 });
    expect(await server(id)).toMatchObject({ last_status: "auth_required", last_http_status: 401, next_poll_at: T0 + 30 * DAY, consecutive_errors: 0, polls_ok: 0 });
    expect(f.seen.map((s) => s.rpc)).toEqual(["initialize"]);
    await runPolls(DB, T0 + 29 * DAY, f.fetcher, one);
    expect(f.seen).toHaveLength(1);
  });

  it("backs off after errors (24 h, 48 h, ...), honours Retry-After on 429, and resets after a success", async () => {
    let fail: number | undefined = 500;
    const headers = () => (fail === 429 ? { "Retry-After": String(5 * 86_400) } : ({} as Record<string, string>));
    const f = fakeServer({ tools: () => [tool("x", "X")], status: (m) => (m === "initialize" ? fail : undefined), headers });
    await upsertEntries(DB, [entry("io.example/flaky", "https://flaky.example.com/mcp")], T0);
    const id = await endpointId("io.example/flaky", "https://flaky.example.com/mcp");
    await runPolls(DB, T0, f.fetcher, one);
    expect(await server(id)).toMatchObject({ last_status: "error", last_error_class: "http_5xx", consecutive_errors: 1, next_poll_at: T0 + 24 * HOUR });
    await runPolls(DB, T0 + 24 * HOUR, f.fetcher, one);
    expect(await server(id)).toMatchObject({ consecutive_errors: 2, next_poll_at: T0 + 24 * HOUR + 48 * HOUR });
    fail = 429;
    const t = T0 + 72 * HOUR;
    await runPolls(DB, t, f.fetcher, one);
    expect(await server(id)).toMatchObject({ last_status: "rate_limited", consecutive_errors: 3, next_poll_at: t + 5 * DAY });
    fail = undefined;
    await runPolls(DB, t + 5 * DAY, f.fetcher, one);
    const ok = await server(id);
    expect(ok).toMatchObject({ last_status: "ok", consecutive_errors: 0 });
    expect(ok.next_poll_at).toBeGreaterThanOrEqual(t + 6 * DAY);
    expect(ok.next_poll_at).toBeLessThan(t + 6 * DAY + HOUR);
  });

  it("polls at most one endpoint per host per run, at most the batch, with bounded concurrency", async () => {
    const names = Array.from({ length: 12 }, (_, i) => i);
    await upsertEntries(DB, [...names.map((i) => entry(`io.example/h${i}`, `https://h${i}.example.com/mcp`)), entry("io.example/same-a", "https://shared.example.com/a"), entry("io.example/same-b", "https://shared.example.com/b")], T0);
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    const s = await runPolls(DB, T0, f.fetcher, { ...one, batchPerRun: 10, concurrency: 3 });
    expect(s.polled).toBe(10);
    expect(f.maxInFlight()).toBeLessThanOrEqual(3);
    const hostsPolled = new Set(f.seen.map((x) => new URL(x.url).host));
    expect(hostsPolled.size).toBe(10);
    const shared = f.seen.filter((x) => x.url.includes("shared.example.com") && x.rpc === "initialize");
    expect(shared.length).toBeLessThanOrEqual(1);
  });

  it("the Worker's cron is the published one, and a run with the kill switch off does nothing", async () => {
    expect(wrangler).toContain(`"crons": ["${MONITOR_POLICY.cron}"]`);
    await upsertEntries(DB, [entry("io.example/off", "https://off.example.com/mcp")], T0);
    const f = fakeServer({ tools: () => [] });
    expect(await runCycle({ DB, POLL_ENABLED: "off" }, T0, f.fetcher)).toEqual({ enabled: false });
    expect(f.seen).toEqual([]);
  });
});

describe("the Registry", () => {
  it("reads remote endpoints page by page, never contacts ones that need configuration, and skips SSE in version 1", async () => {
    expect(needsConfig({ url: "https://x.example/{tenant}/mcp" })).toBe("variable:tenant");
    expect(needsConfig({ url: "https://x.example/mcp", headers: [{ name: "X-API-Key", isRequired: true }] })).toBe("header:X-API-Key");
    expect(needsConfig({ url: "https://x.example/mcp", headers: [{ name: "X-Region", isRequired: true, default: "us" }] })).toBeNull();
    expect(needsConfig({ url: "http://x.example/mcp" })).toBe("url:not_https");

    const pages: Record<string, unknown> = {
      first: {
        servers: [
          entry("io.example/open", "https://open.example.com/mcp"),
          entry("io.example/keyed", "https://keyed.example.com/mcp", { remotes: [{ type: "streamable-http", url: "https://keyed.example.com/mcp", headers: [{ name: "Authorization", isRequired: true }] }] }),
          { server: { name: "io.example/pkg-only", version: "1.0.0", packages: [] } },
        ],
        metadata: { nextCursor: "io.example/keyed:1.0.0" },
      },
      second: { servers: [entry("io.example/legacy", "https://legacy.example.com/sse", { remotes: [{ type: "sse", url: "https://legacy.example.com/sse" }] })], metadata: {} },
    };
    const asked: string[] = [];
    const mcp = fakeServer({ tools: () => [tool("x", "X")] });
    const fetcher: Fetcher = async (u, init) => {
      if (!u.startsWith(REGISTRY)) return mcp.fetcher(u, init);
      asked.push(u);
      expect((init.headers as Record<string, string>)["User-Agent"]).toBe(MONITOR_USER_AGENT);
      const url = new URL(u);
      return Response.json(url.searchParams.get("cursor") ? pages.second : url.searchParams.get("updated_since") ? { servers: [], metadata: {} } : pages.first);
    };
    const r = await runCycle({ DB, POLL_ENABLED: "on" }, T0, fetcher);
    expect(r).toMatchObject({ enabled: true, registry: { pages: 2, endpoints: 3 }, polls: { polled: 1, skipped: { needs_config: 1, sse: 1 } } });
    expect(asked[0]).toContain("version=latest");
    expect(mcp.seen.every((s) => s.url === "https://open.example.com/mcp")).toBe(true);
    expect(await server(await endpointId("io.example/keyed", "https://keyed.example.com/mcp"))).toMatchObject({ needs_config: "header:Authorization", last_status: "skipped_needs_config", polls_total: 0 });

    // The next hourly sync asks only for what changed since the pass began; runs between syncs don't read the Registry.
    await runCycle({ DB, POLL_ENABLED: "on" }, T0 + 20 * 60_000, fetcher);
    expect(asked).toHaveLength(2);
    await runCycle({ DB, POLL_ENABLED: "on" }, T0 + HOUR, fetcher);
    expect(asked).toHaveLength(3);
    expect(new URL(asked[2]!).searchParams.get("updated_since")).toBe(new Date(T0).toISOString());
  });

  it("keeps an endpoint the latest version no longer lists, unlisted, and a deleted server is never polled", async () => {
    await upsertEntries(DB, [entry("io.example/moved", "https://old.example.com/mcp"), entry("io.example/gone", "https://gone.example.com/mcp")], T0);
    await upsertEntries(DB, [entry("io.example/moved", "https://new.example.com/mcp", { version: "2.0.0" }), entry("io.example/gone", "https://gone.example.com/mcp", {}, "deleted")], T0 + HOUR);
    expect(await server(await endpointId("io.example/moved", "https://old.example.com/mcp"))).toMatchObject({ listed: 0 });
    expect(await server(await endpointId("io.example/moved", "https://new.example.com/mcp"))).toMatchObject({ listed: 1, registry_version: "2.0.0" });
    expect(await server(await endpointId("io.example/gone", "https://gone.example.com/mcp"))).toMatchObject({ listed: 0, registry_status: "deleted" });
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    await runPolls(DB, T0 + 2 * HOUR, f.fetcher, one);
    expect(new Set(f.seen.map((s) => s.url))).toEqual(new Set(["https://new.example.com/mcp"]));
  });
});

const meta = (key: string) => DB.prepare("SELECT value FROM drift_meta WHERE key = ?1").bind(key).first<string>("value");
const initializes = (f: ReturnType<typeof fakeServer>) => f.seen.filter((s) => s.rpc === "initialize").map((s) => s.url);

describe("scheduling (ADR 0151 amendment 2)", () => {
  it("re-polls baselined endpoints at their 24 h due time ahead of a backlog of first polls, which fill the rest", async () => {
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    const base = ["a", "b", "c"].map((k) => entry(`io.example/base-${k}`, `https://base-${k}.example.com/mcp`));
    await upsertEntries(DB, base, T0);
    expect(await runPolls(DB, T0, f.fetcher, { ...one, batchPerRun: 3 })).toMatchObject({ polled: 3, repolls: 0, first_polls: 3 });
    // A backlog listed an hour later: due long before the baselined endpoints are due again.
    await upsertEntries(DB, Array.from({ length: 10 }, (_, i) => entry(`io.example/new-${i}`, `https://new-${i}.example.com/mcp`)), T0 + HOUR);
    expect(await runPolls(DB, T0 + 2 * HOUR, f.fetcher, { ...one, batchPerRun: 3 })).toMatchObject({ polled: 3, repolls: 0, first_polls: 3 });
    // Once they are due (24 h plus at most an hour's spread), the three baselined endpoints go first.
    const sent = f.seen.length;
    const s = await runPolls(DB, T0 + 26 * HOUR, f.fetcher, { ...one, batchPerRun: 3 });
    expect(s).toMatchObject({ polled: 3, repolls: 3, first_polls: 0 });
    expect(new Set(initializes({ ...f, seen: f.seen.slice(sent) }))).toEqual(new Set(base.map((b) => b.server.remotes![0]!.url!)));
    for (const b of base) expect((await server(await endpointId(b.server.name!, b.server.remotes![0]!.url!))).polls_ok).toBe(2);
    // The next run, with nothing to re-poll, works through the backlog.
    expect(await runPolls(DB, T0 + 26 * HOUR + 10 * 60_000, f.fetcher, { ...one, batchPerRun: 5 })).toMatchObject({ polled: 5, repolls: 0, first_polls: 5 });
  });

  it("a host with many endpoints gets one per run, in turn, and never crowds other hosts out of the run", async () => {
    // Before amendment 2 the run read 4 x batch candidates in due order, so 30 same-host endpoints filled the window
    // and the run polled one endpoint.
    await upsertEntries(DB, Array.from({ length: 30 }, (_, i) => entry(`io.example/crowd-${String(i).padStart(2, "0")}`, `https://crowd.example.com/m${i}`)), T0);
    await upsertEntries(DB, Array.from({ length: 5 }, (_, i) => entry(`io.example/solo-${i}`, `https://solo-${i}.example.com/mcp`)), T0 + 60_000);
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    const s = await runPolls(DB, T0 + 2 * 60_000, f.fetcher, { ...one, batchPerRun: 6 });
    expect(s.polled).toBe(6);
    const hosts = initializes(f).map((u) => new URL(u).host);
    expect(hosts.filter((h) => h === "crowd.example.com")).toHaveLength(1);
    expect(new Set(hosts).size).toBe(6);
    const second = await runPolls(DB, T0 + 12 * 60_000, f.fetcher, { ...one, batchPerRun: 6 });
    expect(second.polled).toBe(1);
    const crowd = initializes(f).filter((u) => u.includes("crowd.example.com"));
    expect(crowd).toHaveLength(2);
    expect(crowd[0]).not.toBe(crowd[1]);
  });

  it("starts no poll once the run's time budget is spent; those endpoints stay due for the next run", async () => {
    await upsertEntries(DB, [entry("io.example/late-a", "https://late-a.example.com/mcp"), entry("io.example/late-b", "https://late-b.example.com/mcp")], T0);
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    const s = await runPolls(DB, T0, f.fetcher, { ...one, runBudgetMs: 1_000 }, Date.now() - 2_000);
    expect(s).toMatchObject({ polled: 0, deferred: 2 });
    expect(f.seen).toEqual([]);
    expect(await server(await endpointId("io.example/late-a", "https://late-a.example.com/mcp"))).toMatchObject({ next_poll_at: T0, polls_total: 0 });
    expect((await runPolls(DB, T0 + 10 * 60_000, f.fetcher, one)).polled).toBe(2);
  });

  it("reads only endpoints that may be contacted as candidates, and logs a bounded number of skips per run", async () => {
    const keyed = Array.from({ length: 5 }, (_, i) =>
      entry(`io.example/keyed-${i}`, `https://keyed-${i}.example.com/mcp`, { remotes: [{ type: "streamable-http", url: `https://keyed-${i}.example.com/mcp`, headers: [{ name: "X-API-Key", isRequired: true }] }] }),
    );
    await upsertEntries(DB, [...keyed, entry("io.example/open-1", "https://open-1.example.com/mcp")], T0);
    const cands = (await DB.prepare(CANDIDATES_SQL).bind(T0, 1, 50).all<{ registry_name: string }>()).results;
    expect(cands.map((c) => c.registry_name)).toEqual(["io.example/open-1"]);
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    const s = await runPolls(DB, T0, f.fetcher, { ...one, skipsPerRun: 3 });
    expect(s).toMatchObject({ polled: 1, skipped: { needs_config: 3 } });
    expect((await runPolls(DB, T0, f.fetcher, { ...one, skipsPerRun: 3 })).skipped.needs_config).toBe(2);
    expect(f.seen.some((x) => x.url.includes("keyed-"))).toBe(false);
  });
});

describe("the Registry pass (ADR 0151 amendment 2)", () => {
  it("unlists through the (registry_name, remote_url) index, never by reading every endpoint (the 14-16 Nov D1 overload)", async () => {
    const plan = (await DB.prepare(`EXPLAIN QUERY PLAN ${UNLIST_SQL}`).bind("io.example/x", "active", "[]").all<{ detail: string }>()).results.map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/drift_servers_name_url/);
    expect(plan).not.toMatch(/drift_servers_due/);
    expect(plan).not.toMatch(/SCAN drift_servers(?! USING)/);
  });

  it("advances page by page across hourly syncs, completes the pass, dates the first full read once, then reads only updates", async () => {
    const pages: Record<string, { servers: RegistryEntry[]; metadata: { nextCursor?: string } }> = {
      "": { servers: [entry("io.example/p1", "https://p1.example.com/mcp")], metadata: { nextCursor: "c2" } },
      c2: { servers: [entry("io.example/p2", "https://p2.example.com/mcp")], metadata: { nextCursor: "c3" } },
      c3: { servers: [entry("io.example/p3", "https://p3.example.com/mcp")], metadata: {} },
    };
    const asked: URL[] = [];
    const fetcher: Fetcher = async (u) => {
      const url = new URL(u);
      asked.push(url);
      return Response.json(url.searchParams.get("updated_since") ? { servers: [], metadata: {} } : pages[url.searchParams.get("cursor") ?? ""]);
    };
    expect(await syncRegistry(DB, T0, fetcher, 1)).toEqual({ pages: 1, endpoints: 1, done: false });
    expect(await meta("registry_cursor")).toBe("c2");
    expect(await syncRegistry(DB, T0 + HOUR, fetcher, 1)).toMatchObject({ done: false });
    expect(await meta("registry_cursor")).toBe("c3");
    expect(await meta("registry_first_pass_done_at")).toBeNull();
    expect(await syncRegistry(DB, T0 + 2 * HOUR, fetcher, 1)).toMatchObject({ done: true });
    expect(await meta("registry_cursor")).toBeNull();
    expect(await meta("registry_first_pass_done_at")).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(await meta("registry_since")).toBe(new Date(T0).toISOString());
    expect((await DB.prepare("SELECT count(*) AS n FROM drift_servers WHERE listed = 1").first<number>("n"))).toBe(3);
    // Later passes ask only for updates and never move the first full read's date.
    await syncRegistry(DB, T0 + 3 * HOUR, fetcher, 1);
    expect(asked.at(-1)!.searchParams.get("updated_since")).toBe(new Date(T0).toISOString());
    expect(await meta("registry_first_pass_done_at")).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(await meta("registry_pass_done_at")).toBe(new Date(T0 + 3 * HOUR).toISOString());
  });

  it("a failed sync records why and never stops the polls; the next good sync clears it", async () => {
    await upsertEntries(DB, [entry("io.example/known", "https://known.example.com/mcp")], T0);
    let down = true;
    const mcp = fakeServer({ tools: () => [tool("x", "X")] });
    const fetcher: Fetcher = async (u, init) => (u.startsWith(REGISTRY) ? (down ? new Response("busy", { status: 503 }) : Response.json({ servers: [], metadata: {} })) : mcp.fetcher(u, init));
    const r = await runCycle({ DB, POLL_ENABLED: "on" }, T0, fetcher, one);
    expect(r).toMatchObject({ enabled: true, registry: { error: "Error: registry 503" }, polls: { polled: 1 } });
    expect(await meta("registry_sync_error")).toBe(`${new Date(T0).toISOString()} Error: registry 503`);
    expect(await meta("registry_synced_at")).toBeNull();
    down = false;
    await runCycle({ DB, POLL_ENABLED: "on" }, T0 + HOUR, fetcher, one);
    expect(await meta("registry_sync_error")).toBeNull();
    expect(await meta("registry_synced_at")).toBe(new Date(T0 + HOUR).toISOString());
  });

  it("dates the first full polling pass once, after the Registry's first full read, when nothing we may contact is untried", async () => {
    await upsertEntries(DB, [entry("io.example/fp-a", "https://fp-a.example.com/mcp"), entry("io.example/fp-b", "https://fp-b.example.com/mcp")], T0);
    const f = fakeServer({ tools: () => [tool("x", "X")] });
    await runPolls(DB, T0, f.fetcher, { ...one, batchPerRun: 1 });
    expect(await meta("poll_first_pass_done_at")).toBeNull();
    await DB.prepare("INSERT INTO drift_meta (key, value, updated_at) VALUES ('registry_first_pass_done_at', ?1, ?2)").bind(new Date(T0).toISOString(), T0).run();
    expect(await markFirstPass(DB, T0)).toBe(false);
    await runPolls(DB, T0 + 10 * 60_000, f.fetcher, one);
    expect(await meta("poll_first_pass_done_at")).toBe(new Date(T0 + 10 * 60_000).toISOString());
    expect(await markFirstPass(DB, T0 + DAY)).toBe(false);
    expect(await meta("poll_first_pass_done_at")).toBe(new Date(T0 + 10 * 60_000).toISOString());
  });
});

describe("the canary (ADR 0151 amendment 2)", () => {
  const URL_C = "https://canary.forge.example/drift/canary/mcp";
  /** The first 00:30 UTC at or after T0 on an even UTC day: text A. */
  const C0 = (utcDay(T0) + (utcDay(T0) % 2 === 0 ? 0 : 1)) * DAY + 30 * 60_000;
  const served = (clock: () => number) => {
    const seen: string[] = [];
    const fetcher: Fetcher = async (u, init) => {
      seen.push(init.body ? (JSON.parse(String(init.body)) as { method: string }).method : String(init.method));
      return canaryResponse(new Request(u, init), clock());
    };
    return { fetcher, seen };
  };

  it("answers as a minimal MCP server: POST only, initialize and tools/list, a notification gets 202, nothing else", async () => {
    const post = (body: unknown) => canaryResponse(new Request(URL_C, { method: "POST", body: JSON.stringify(body) }), C0);
    expect((await canaryResponse(new Request(URL_C), C0)).status).toBe(405);
    expect(await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { version: CANARY_VERSION } } });
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(((await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any).result.tools[0].description).toBe(CANARY_TEXTS[0]);
    expect(((await (await canaryResponse(new Request(URL_C, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }), C0 + DAY)).json()) as any).result.tools[0].description).toBe(CANARY_TEXTS[1]);
    expect(await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "canary_note" } })).json()).toMatchObject({ error: { code: -32601 } });
  });

  it("refuses an oversized request with 413: a declared Content-Length over the cap before reading any of it, an undeclared one at the cap", async () => {
    let pulled = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(16_384));
        },
      }, { highWaterMark: 0 });
    const declared = { headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? String(10 * MAX_BODY) : null) }, method: "POST", body: endless() } as unknown as Request;
    const r1 = await canaryResponse(declared, C0);
    expect(r1.status).toBe(413);
    expect(pulled).toBe(0);
    pulled = 0;
    const r2 = await canaryResponse(new Request(URL_C, { method: "POST", body: endless(), duplex: "half" } as RequestInit), C0);
    expect(r2.status).toBe(413);
    // Reading stopped just past the cap (16 KiB chunks), never the whole stream.
    expect(pulled).toBeLessThanOrEqual(MAX_BODY / 16_384 + 2);
  });

  it("end to end through the real poll and store: A, then B under the same version is one event with both snapshots; back to A is a second", async () => {
    let now = C0;
    const c = served(() => now);
    expect(await runCanary(DB, now, c.fetcher, URL_C)).toEqual({ polled: true, status: "ok", changes: 0 });
    expect(c.seen).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    // Once per UTC day: a later run the same day sends nothing.
    expect(await runCanary(DB, now + 6 * HOUR, c.fetcher, URL_C)).toEqual({ polled: false });
    expect(c.seen).toHaveLength(3);

    now = C0 + DAY;
    expect(await runCanary(DB, now, c.fetcher, URL_C)).toEqual({ polled: true, status: "ok", changes: 1 });
    now = C0 + 2 * DAY;
    expect(await runCanary(DB, now, c.fetcher, URL_C)).toEqual({ polled: true, status: "ok", changes: 1 });

    const ev = await events(CANARY_ID);
    expect(ev.map((e) => [e.tool, e.change_class, e.observed_at, e.same_version, e.reported_version_before, e.reported_version_after])).toEqual([
      ["canary_note", "description", C0 + DAY, 1, CANARY_VERSION, CANARY_VERSION],
      ["canary_note", "description", C0 + 2 * DAY, 1, CANARY_VERSION, CANARY_VERSION],
    ]);
    const snap = async (sha: string) => JSON.parse((await DB.prepare("SELECT body FROM drift_snapshots WHERE sha256 = ?1").bind(sha).first<string>("body"))!).tools[0].description;
    expect(await snap(ev[0]!.before_snapshot)).toBe(CANARY_TEXTS[0]);
    expect(await snap(ev[0]!.after_snapshot)).toBe(CANARY_TEXTS[1]);
    expect(await snap(ev[1]!.before_snapshot)).toBe(CANARY_TEXTS[1]);
    expect(await snap(ev[1]!.after_snapshot)).toBe(CANARY_TEXTS[0]);
    // The revert is its own event, not collapsed into the first: it points back at the original snapshot.
    expect(ev[1]!.after_snapshot).toBe(ev[0]!.before_snapshot);
    expect(ev[1]!.previous_at).toBe(C0 + DAY);
    expect(JSON.parse(ev[0]!.before_text).description).toBe(CANARY_TEXTS[0]);
    expect(JSON.parse(ev[0]!.after_text).description).toBe(CANARY_TEXTS[1]);
    expect((await polls(CANARY_ID)).map((p) => [p.status, p.baseline, p.changes])).toEqual([
      ["ok", 1, 0],
      ["ok", 0, 1],
      ["ok", 0, 1],
    ]);
  });

  it("is never a Registry candidate, never starts the series, and runs from the cron once per UTC day", async () => {
    let now = C0;
    const c = served(() => now);
    const reg = fakeServer({ tools: () => [tool("x", "X")] });
    const fetcher: Fetcher = (u, init) => (u === URL_C ? c.fetcher(u, init) : reg.fetcher(u, init));
    const r = await runCycle({ DB, POLL_ENABLED: "on", CANARY_URL: URL_C }, now, fetcher, one);
    expect(r).toMatchObject({ enabled: true, registry: null, polls: { polled: 0 }, canary: { polled: true, status: "ok" } });
    expect(await server(CANARY_ID)).toMatchObject({ listed: 0, registry_status: CANARY_FLAG, polls_ok: 1 });
    expect(await meta("series_started_at")).toBeNull();
    expect((await DB.prepare(CANDIDATES_SQL).bind(now + 30 * DAY, 1, 50).all()).results).toEqual([]);
    await runCycle({ DB, POLL_ENABLED: "on", CANARY_URL: URL_C }, now + 10 * 60_000, fetcher, one);
    expect(c.seen.filter((m) => m === "initialize")).toHaveLength(1);
    now = C0 + DAY;
    expect(await runCycle({ DB, POLL_ENABLED: "on", CANARY_URL: URL_C }, now, fetcher, one)).toMatchObject({ canary: { polled: true, changes: 1 } });
    expect(reg.seen).toEqual([]);
    // The Worker's own configuration names the site's canary.
    expect(wrangler).toContain('"CANARY_URL": "https://theagentforge.io/drift/canary/mcp"');
  });
});
