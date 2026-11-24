import { MONITOR_POLICY, MONITOR_PROTOCOL_VERSION, MONITOR_USER_AGENT, type ErrorClass } from "@forge/shared/drift-monitor";

// ADR 0151 §4: the only thing the monitor ever does to a remote MCP server. Unauthenticated Streamable HTTP:
// initialize, notifications/initialized, tools/list (its pages), then DELETE of the session if one was given.
// Never tools/call, resources, prompts or anything else; no credentials, no cookies; redirects are not followed.

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** What was sent, in order (method names, plus "DELETE"), so tests and the poll log can show nothing else was. */
export type Sent = string[];

export type PollOutcome =
  | { status: "ok"; tools: unknown[]; reportedVersion: string | null; protocolVersion: string | null; httpStatus: number; sent: Sent }
  | { status: "auth_required"; httpStatus: number; sent: Sent }
  | { status: "rate_limited"; httpStatus: number; retryAfterS: number | null; sent: Sent }
  | { status: "error"; errorClass: ErrorClass; httpStatus: number | null; retryAfterS: number | null; detail: string; sent: Sent };

type Failure = Exclude<PollOutcome, { status: "ok" }>;
type WithoutSent<T> = T extends unknown ? Omit<T, "sent"> : never;

class Stop extends Error {
  constructor(readonly outcome: WithoutSent<Failure>) {
    super("stop");
  }
}

/** Retry-After as seconds: a number of seconds or an HTTP date. */
export function retryAfterSeconds(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  const s = h.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 1000)) : null;
}

/** Reads at most `max` bytes of a body; more ends the poll (too_large). */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new Stop({ status: "error", errorClass: "too_large", httpStatus: res.status, retryAfterS: null, detail: `body over ${max} bytes` });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The JSON-RPC messages in a body: one JSON value (object or batch) or an SSE stream of `data:` events. */
export function messagesOf(text: string, contentType: string): unknown[] {
  if (contentType.includes("text/event-stream")) {
    const out: unknown[] = [];
    for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data.trim()) continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        // A non-JSON event (a keep-alive, a comment) is not a message.
      }
    }
    return out;
  }
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

const SESSION_ID = /^[\x21-\x7e]{1,512}$/;
const PROTOCOL = /^\d{4}-\d{2}-\d{2}$/;

/** One poll of one endpoint. Never throws: every failure is an outcome. */
export async function pollEndpoint(url: string, fetcher: Fetcher, policy: Record<"requestTimeoutMs" | "pollBudgetMs" | "maxBodyBytes" | "maxToolPages", number> = MONITOR_POLICY): Promise<PollOutcome> {
  const sent: Sent = [];
  const deadline = Date.now() + policy.pollBudgetMs;
  let session: string | null = null;
  let protocol: string | null = null;
  let lastStatus = 0;

  const request = async (method: "POST" | "DELETE", label: string, body?: unknown) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Stop({ status: "error", errorClass: "timeout", httpStatus: null, retryAfterS: null, detail: "poll budget spent" });
    const headers: Record<string, string> = { "User-Agent": MONITOR_USER_AGENT, Accept: "application/json, text/event-stream" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (session) headers["MCP-Session-Id"] = session;
    if (protocol) headers["MCP-Protocol-Version"] = protocol;
    sent.push(label);
    let res: Response;
    try {
      res = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(Math.min(policy.requestTimeoutMs, left)) });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new Stop({ status: "error", errorClass: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", httpStatus: null, retryAfterS: null, detail: String(e).slice(0, 200) });
    }
    lastStatus = res.status;
    return res;
  };

  const check = (res: Response) => {
    if (res.status === 401 || res.status === 403) throw new Stop({ status: "auth_required", httpStatus: res.status });
    if (res.status === 429) throw new Stop({ status: "rate_limited", httpStatus: 429, retryAfterS: retryAfterSeconds(res.headers.get("Retry-After")) });
    if (res.status >= 300 && res.status < 400) throw new Stop({ status: "error", errorClass: "redirect", httpStatus: res.status, retryAfterS: null, detail: "redirects are not followed" });
    if (res.status >= 400)
      throw new Stop({ status: "error", errorClass: res.status >= 500 ? "http_5xx" : "http_4xx", httpStatus: res.status, retryAfterS: res.status === 503 ? retryAfterSeconds(res.headers.get("Retry-After")) : null, detail: `HTTP ${res.status}` });
  };

  const rpc = async (id: number, method: string, params: Record<string, unknown>) => {
    const res = await request("POST", method, { jsonrpc: "2.0", id, method, params });
    check(res);
    const text = await readCapped(res, policy.maxBodyBytes);
    const msg = messagesOf(text, res.headers.get("Content-Type") ?? "").find((m) => !!m && typeof m === "object" && (m as { id?: unknown }).id === id) as
      | { result?: unknown; error?: { code?: unknown; message?: unknown } }
      | undefined;
    if (!msg) throw new Stop({ status: "error", errorClass: "not_mcp", httpStatus: res.status, retryAfterS: null, detail: `no JSON-RPC answer to ${method}` });
    if (msg.error) throw new Stop({ status: "error", errorClass: "protocol_error", httpStatus: res.status, retryAfterS: null, detail: `${method}: ${String(msg.error.code ?? "")} ${String(msg.error.message ?? "").slice(0, 160)}` });
    if (!msg.result || typeof msg.result !== "object") throw new Stop({ status: "error", errorClass: "not_mcp", httpStatus: res.status, retryAfterS: null, detail: `${method}: no result object` });
    return { res, result: msg.result as Record<string, unknown> };
  };

  try {
    if (!/^https:\/\//i.test(url)) throw new Stop({ status: "error", errorClass: "http_4xx", httpStatus: null, retryAfterS: null, detail: "not an https URL" });
    const init = await rpc(1, "initialize", { protocolVersion: MONITOR_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "TheAgentForge-DriftMonitor", version: "1.0" } });
    const sid = init.res.headers.get("MCP-Session-Id");
    session = sid && SESSION_ID.test(sid) ? sid : null;
    protocol = typeof init.result.protocolVersion === "string" && PROTOCOL.test(init.result.protocolVersion) ? init.result.protocolVersion : MONITOR_PROTOCOL_VERSION;
    const info = init.result.serverInfo as { version?: unknown } | undefined;
    const reportedVersion = typeof info?.version === "string" ? info.version.slice(0, 64) : null;

    // The notification has no answer to read; a server that refuses it (other than for auth or rate) still gets asked.
    const note = await request("POST", "notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" });
    if (note.status === 401 || note.status === 403 || note.status === 429) check(note);
    await note.body?.cancel().catch(() => {});

    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < policy.maxToolPages; page++) {
      const r = await rpc(2 + page, "tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(r.result.tools)) throw new Stop({ status: "error", errorClass: "not_mcp", httpStatus: r.res.status, retryAfterS: null, detail: "tools/list: no tools array" });
      tools.push(...r.result.tools);
      cursor = typeof r.result.nextCursor === "string" && r.result.nextCursor ? r.result.nextCursor : undefined;
      if (!cursor) break;
    }
    return { status: "ok", tools, reportedVersion, protocolVersion: protocol, httpStatus: lastStatus, sent };
  } catch (e) {
    if (e instanceof Stop) return { ...e.outcome, sent } as PollOutcome;
    return { status: "error", errorClass: "network", httpStatus: null, retryAfterS: null, detail: String(e).slice(0, 200), sent };
  } finally {
    // The specification asks clients to end sessions they no longer need. Best effort, never retried, never counted.
    if (session) {
      try {
        const d = await request("DELETE", "DELETE");
        await d.body?.cancel().catch(() => {});
      } catch {
        // ignored
      }
    }
  }
}
