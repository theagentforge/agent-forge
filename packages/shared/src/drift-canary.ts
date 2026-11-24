// ADR 0151 amendment 2: the drift canary, a fixture we control. A minimal stateless MCP Streamable HTTP endpoint
// (served by the site at CANARY_PATH) with one tool whose description alternates between two fixed texts by UTC day
// while the server's version never changes. The drift monitor polls it once per UTC day as a pinned extra endpoint,
// outside the Registry, so the comparator's work (a same-version change, then a revert, as two events) can be seen
// live. It is excluded from every coverage and change total. Pure: no I/O, runs in Workers and Node.

export const CANARY_PATH = "/drift/canary/mcp";
/** The fixed drift_servers.id of the canary row. */
export const CANARY_ID = "canary-theagentforge-drift";
/** Not a Registry name of ours (the Registry is never asked about it); kept on the row so it reads plainly. */
export const CANARY_NAME = "theagentforge.io/drift-canary";
/** drift_servers.registry_status of the canary row: the flag every total filters on (the row is also listed = 0). */
export const CANARY_FLAG = "canary";
/** Never changes: every change the monitor sees on the canary is a same-version change. */
export const CANARY_VERSION = "1.0.0";
export const CANARY_TOOL = "canary_note";
export const CANARY_TEXTS = [
  "Drift canary, text A. This description alternates between two fixed texts by UTC day while the server version stays 1.0.0.",
  "Drift canary, text B. This description alternates between two fixed texts by UTC day while the server version stays 1.0.0.",
] as const;

const DAY = 86_400_000;
/** The largest request body the canary reads (a real JSON-RPC request to it is a few hundred bytes). */
export const MAX_BODY = 65_536;

/** The body as text, or null once it passes MAX_BODY (reading stops there). */
async function readCapped(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
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
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];

/** Days since 1970-01-01 UTC. */
export const utcDay = (ms: number) => Math.floor(ms / DAY);
/** Text A on even UTC days, text B on odd ones. */
export const canaryText = (ms: number) => CANARY_TEXTS[utcDay(ms) % 2]!;
export const canaryTools = (ms: number) => [{ name: CANARY_TOOL, description: canaryText(ms), inputSchema: { type: "object", properties: {}, additionalProperties: false } }];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const rpcError = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

/**
 * One request to the canary. POST only (stateless: no session, no event stream): initialize, ping and tools/list are
 * answered; a notification gets 202; anything else is a JSON-RPC error. The tool can't be called.
 */
export async function canaryResponse(req: Request, now: number = Date.now()): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  // A declared size over the cap is refused before any of the body is read; without one, at most the cap is read.
  const declared = Number(req.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await req.body?.cancel().catch(() => {});
    return rpcError(null, -32600, "request too large", 413);
  }
  const text = await readCapped(req);
  if (text === null) return rpcError(null, -32600, "request too large", 413);
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "one JSON-RPC message per request", 400);
  const m = msg as { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown } };
  if (typeof m.method !== "string") return rpcError(m.id, -32600, "no method", 400);
  if (m.id === undefined) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  if (m.method === "initialize") {
    const asked = m.params?.protocolVersion;
    const protocolVersion = typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
    return json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "forge-drift-canary", version: CANARY_VERSION } } });
  }
  if (m.method === "ping") return json({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "tools/list") return json({ jsonrpc: "2.0", id: m.id, result: { tools: canaryTools(now) } });
  return rpcError(m.id, -32601, "method not found");
}
