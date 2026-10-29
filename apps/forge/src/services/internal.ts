// Our own automated callers (K7, acquisition-strategy §6: "our own probes are excluded everywhere except the public
// page views counter"). The Scout collector, CI install tests, the House tester, the screens workflow and the
// forge-check Action in our own repos tag their requests in one of three ways:
//   - the header `X-Forge-Internal: <component>`;
//   - a User-Agent containing `theagentforge-internal/<component>`;
//   - an MCP client name `theagentforge-internal-<component>` (clientInfo, or `_meta` clientInfo).
// A tag is spoofable, so it only ever leaves traffic OUT of the counts (check sources, agent-days, MCP client names,
// the agent funnel). It never grants anything: rate limits, access and answers are exactly the same. Tagged traffic is
// counted apart, as `internal:<component>:<what>`, so we can still see it.

export const INTERNAL_HEADER = "X-Forge-Internal";
/** Components we run. Any other tag counts as "other", so a stranger can't fill the counters with made-up names. */
export const INTERNAL_COMPONENTS = ["scout", "house", "screens", "ci-cline", "ci", "action", "bulk"] as const;
export type InternalComponent = (typeof INTERNAL_COMPONENTS)[number] | "other";

const UA_TAG = /\btheagentforge-internal\/([a-z0-9-]{1,32})/i;
const CLIENT_TAG = /^theagentforge-internal[-/]([a-z0-9-]{1,32})$/i;

const component = (raw: string): InternalComponent => {
  const s = raw.trim().toLowerCase();
  return (INTERNAL_COMPONENTS as readonly string[]).includes(s) ? (s as InternalComponent) : "other";
};

/** The internal component a request's headers name (header first, then User-Agent), or null for everyone else. */
export function internalCaller(headers: Pick<Headers, "get">): InternalComponent | null {
  const h = headers.get(INTERNAL_HEADER);
  if (h !== null && h.trim()) return component(h.slice(0, 40));
  const ua = UA_TAG.exec(headers.get("user-agent") ?? "");
  return ua ? component(ua[1]!) : null;
}

/**
 * Client names our own callers used before they were tagged (issue #171: the Scout collector's probe said
 * "forge-scout"). An older copy of a script still sending one is counted apart like a tagged call.
 */
const LEGACY_CLIENTS: Record<string, InternalComponent> = { "forge-scout": "scout" };

/** The internal component an MCP client name names (`theagentforge-internal-scout`, or an older name), or null. */
export function internalClient(name: unknown): InternalComponent | null {
  if (typeof name !== "string") return null;
  const legacy = LEGACY_CLIENTS[name.trim().toLowerCase()];
  if (legacy) return legacy;
  const m = CLIENT_TAG.exec(name.trim());
  return m ? component(m[1]!) : null;
}

/** True when an MCP client name is one of ours. */
export const isInternalClient = (name: unknown) => internalClient(name) !== null;

/** The internal component named by any MCP message's clientInfo (initialize, or a 2026 `_meta` clientInfo). */
export function internalFromMcpBody(body: unknown): InternalComponent | null {
  const msgs = (Array.isArray(body) ? body : [body]).slice(0, 10) as { params?: { clientInfo?: { name?: unknown }; _meta?: unknown } }[];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const direct = internalClient(m.params?.clientInfo?.name);
    if (direct) return direct;
    const meta = m.params?._meta;
    if (meta && typeof meta === "object")
      for (const [k, v] of Object.entries(meta).slice(0, 20))
        if (/clientinfo$/i.test(k) && v && typeof v === "object") {
          const c = internalClient((v as { name?: unknown }).name);
          if (c) return c;
        }
  }
  return null;
}

/** Headers first, then (for a small POST) the MCP client name in the body. Reads a copy; never throws. */
export async function internalOf(request: Request): Promise<InternalComponent | null> {
  const byHeader = internalCaller(request.headers);
  if (byHeader || request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > 65_536) return byHeader;
  try {
    return internalFromMcpBody(JSON.parse(await request.clone().text()));
  } catch {
    return null;
  }
}

/** The counter key for one piece of internal traffic: checks, sessions, calls, scans, watch, fetches. */
export const internalKey = (c: InternalComponent, what: "checks" | "sessions" | "calls" | "scans" | "watch" | "fetches") => `internal:${c}:${what}`;
