// Plain JSON answers on the anonymous MCP endpoints (ADR 0123). The Streamable HTTP transport lets a server answer a
// POST with one JSON body instead of an event stream, but the SDK's stateless handler refuses (406) any client that
// doesn't also accept text/event-stream. Uptime checkers and simple clients send `Accept: application/json` alone
// (Glama showed 74% uptime for /mcp/public on 4 Nov). For those, the request is passed on accepting both, and the
// event stream that comes back (one request in, so one stream of a few events) is read into the JSON-RPC response it
// carries. Clients that accept event streams are answered exactly as before.

/** True when a POST's Accept takes JSON but not event streams: the client wants one plain JSON reply. */
export function wantsJsonOnly(accept: string | null): boolean {
  const a = (accept ?? "").toLowerCase();
  if (a.includes("text/event-stream")) return false;
  return /(^|[\s,])application\/(json|\*)(\s*(;|,|$))/.test(a);
}

/** The request as the MCP handler expects it: accepting both JSON and event streams. */
export function acceptingBoth<R extends Request>(request: R): R {
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json, text/event-stream");
  return new Request(request, { headers }) as R;
}

/** The JSON-RPC messages in an event stream's `data:` fields (multi-line data joined, comments and other fields skipped). */
export function sseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // Not JSON: nothing a JSON-RPC client could read, so it is left out.
    }
  }
  return out;
}

const isResponse = (m: unknown) => !!m && typeof m === "object" && "id" in m && ("result" in m || "error" in m);

/**
 * The reply for a JSON-only client: an event stream is read into the JSON-RPC response(s) it carries (one object, or an
 * array for a batch); notifications sent along the way are left out, as in the transport's own JSON mode. Anything that
 * isn't an event stream (a 202, an error, a JSON body) is returned as it came.
 */
export async function asPlainJson(res: Response): Promise<Response> {
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
  const responses = sseMessages(await res.text()).filter(isResponse);
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Type");
  if (!responses.length) return new Response(null, { status: 202, headers });
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(responses.length === 1 ? responses[0] : responses), { status: res.status, headers });
}
