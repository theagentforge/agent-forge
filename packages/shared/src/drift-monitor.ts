// ADR 0151: the live drift monitor of remote MCP servers listed in the official MCP Registry. Shared by the poller
// Worker (apps/drift-monitor), which records what it sees, and the site Worker (apps/forge), which publishes the
// policy, coverage and the gateway API. Pure functions and constants only: no I/O, no zod, runs in Workers and Node.

/** The exact User-Agent of every request the monitor makes. The page it names says what we request and how to opt out. */
export const MONITOR_PAGE_PATH = "/drift/monitor";
export const MONITOR_USER_AGENT = "TheAgentForge-DriftMonitor/1.0 (+https://theagentforge.io/drift/monitor)";
export const MONITOR_CONTACT = "hello@theagentforge.io";
/** The MCP protocol version offered in `initialize` (the server answers with the one it speaks; we use that after). */
export const MONITOR_PROTOCOL_VERSION = "2025-11-25";

/**
 * Politeness and budget, in one place so the public page can never say something the poller doesn't do. Cloudflare
 * limits these sit inside (developers.cloudflare.com/workers/platform/limits and d1/platform/limits, read again 16 Nov
 * 2026): Workers Paid allows 10,000 subrequests an invocation (D1 calls count), six connections waiting for headers at
 * once, 30 s CPU for a cron on an interval under an hour, 15 minutes wall time for a scheduled invocation, and 1,000
 * D1 queries an invocation (a batch counts as one). ADR 0151 amendment 2 has the arithmetic.
 */
export const MONITOR_POLICY = {
  /** The cron (UTC): one small batch every 10 minutes. */
  cron: "*/10 * * * *",
  /** Endpoints polled per cron run, at most (ADR 0151 amendment 2: 24 until 16 Nov 2026). */
  batchPerRun: 96,
  /** No new poll starts after this long into a run, so a run (at most this plus one poll) ends before the next one. */
  runBudgetMs: 510_000,
  /** Endpoints that are only logged as skipped (needs configuration, SSE only) per run, at most. Nothing is sent to them. */
  skipsPerRun: 100,
  /** Requests in flight at once, across all servers (Cloudflare queues beyond six waiting for headers anyway). */
  concurrency: 4,
  /** At most one endpoint per host in a run, so one host never sees more than one session per 10 minutes. */
  perHostPerRun: 1,
  /** At most one poll of an endpoint per this many hours (plus a fixed per-endpoint spread of up to an hour). */
  minIntervalHours: 24,
  /** Each HTTP request is abandoned after this long; a whole poll after `pollBudgetMs`. */
  requestTimeoutMs: 10_000,
  pollBudgetMs: 30_000,
  /** A response body larger than this ends the poll (class too_large). */
  maxBodyBytes: 2 * 1024 * 1024,
  /** A canonical tools/list snapshot over this many bytes isn't stored (class too_large): D1 rows stop at 2 MB. */
  maxSnapshotBytes: 1_800_000,
  /** tools/list pages followed (nextCursor), at most. */
  maxToolPages: 10,
  /** After errors: 24 h, 48 h, 96 h ... capped at 7 days; a Retry-After longer than that wins. */
  backoffCapHours: 168,
  /** An endpoint that answered 401 or 403 is recorded as needing auth and not contacted again for this long. */
  authRecheckDays: 30,
  /** Registry reads: one sync an hour (the Registry asks aggregators for "regular but infrequent" reads, e.g. hourly). */
  registryPagesPerSync: 20,
  /** An opt-out is honoured within this many hours of the email (it is checked before every poll once listed). */
  optOutHours: 24,
} as const;

/** Exactly what one poll sends, for the public page. Never tools/call, resources, prompts or anything else. */
export const MONITOR_REQUESTS = [
  "POST initialize (JSON-RPC, no credentials, no cookies)",
  "POST notifications/initialized",
  "POST tools/list (and its next pages, if the server pages it, up to 10)",
  "DELETE of the session, when the server gave one (the specification asks clients to end sessions they no longer need)",
] as const;

/** output_schema: only the output schema changed (the raw digest, over name, description and inputSchema, is the same). */
export const CHANGE_CLASSES = ["whitespace_only", "description", "schema", "output_schema", "tool_added", "tool_removed"] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

export const POLL_STATUSES = ["ok", "auth_required", "error", "rate_limited", "skipped_optout", "skipped_needs_config", "skipped_sse"] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];

/** redirect: the endpoint answered 3xx; redirects are never followed (a redirect could lead past the per-host rule or an opt-out). */
export const ERROR_CLASSES = ["timeout", "network", "redirect", "http_4xx", "http_5xx", "not_mcp", "protocol_error", "too_large"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** JSON with object keys sorted at every level, no insignificant whitespace; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // undefined (absent) and non-JSON values serialise as null, so an absent field and a null one hash the same.
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** Trim and collapse every run of whitespace (spaces, tabs, newlines, non-breaking and other Unicode spaces) to one space. */
export const collapseWhitespace = (s: string) => s.replace(/\s+/gu, " ").trim();

/** In the normalised form: every `description` string inside the input schema is collapsed too. */
function normaliseSchema(v: unknown, key: string | null = null): unknown {
  if (typeof v === "string") return key === "description" ? collapseWhitespace(v) : v;
  if (Array.isArray(v)) return v.map((x) => normaliseSchema(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normaliseSchema(x, k)]));
  return v;
}

/** The fields the digests cover: name, description and input schema; the contract digest adds the output schema (ADR 0151 §3). */
export interface ToolCore {
  name: string;
  description: string | null;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export function toolCore(raw: unknown): ToolCore | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || !t.name) return null;
  return { name: t.name, description: typeof t.description === "string" ? t.description : null, inputSchema: t.inputSchema ?? null, outputSchema: t.outputSchema ?? null };
}

/** The raw canonical form: exactly what was listed, keys sorted. */
export const rawCanonical = (t: ToolCore) => canonicalJson({ name: t.name, description: t.description, inputSchema: t.inputSchema });
/** The normalised form: description whitespace collapsed (a missing description reads as ""), schema descriptions too. */
/**
 * The contract form (Kuadrant/mcp-gateway #1633's four fields): name, description, inputSchema and outputSchema, raw,
 * keys sorted; an absent output schema is null. Its digest changes when the output schema alone changes.
 */
export const contractCanonical = (t: ToolCore) => canonicalJson({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema ?? null });
export const normalisedCanonical = (t: ToolCore) => canonicalJson({ name: t.name, description: collapseWhitespace(t.description ?? ""), inputSchema: normaliseSchema(t.inputSchema) });

const enc = new TextEncoder();
export async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ToolDigest {
  name: string;
  /** sha256 of the raw canonical form, "sha256:<hex>". */
  raw: string;
  /** sha256 of the normalised form. Equal normalised digests with different raw ones: a whitespace-only change. */
  normalised: string;
  /** sha256 of the contract form (adds outputSchema). */
  contract: string;
  /** The contract canonical text (every field any digest covers), kept so a change can be shown exactly. */
  text: string;
  /** Separate digests of the description, the input schema and the output schema, so a change can say which part moved. */
  description: string;
  schema: string;
  output: string;
}

export async function toolDigest(t: ToolCore): Promise<ToolDigest> {
  const text = contractCanonical(t);
  return {
    name: t.name,
    raw: `sha256:${await sha256Hex(rawCanonical(t))}`,
    normalised: `sha256:${await sha256Hex(normalisedCanonical(t))}`,
    contract: `sha256:${await sha256Hex(text)}`,
    text,
    description: `sha256:${await sha256Hex(canonicalJson(t.description))}`,
    schema: `sha256:${await sha256Hex(canonicalJson(t.inputSchema))}`,
    output: `sha256:${await sha256Hex(canonicalJson(t.outputSchema ?? null))}`,
  };
}

export interface ToolSet {
  /** Digests by tool name, sorted by name. A repeated name keeps its first listing (the rest are counted). */
  tools: ToolDigest[];
  duplicates: number;
  /** Entries that weren't a tool object with a name (counted, never hashed). */
  invalid: number;
  /** The whole tools/list result as listed (every field of every tool, keys sorted), and its sha256. */
  snapshot: string;
  snapshotSha: string;
}

export async function toolSet(listed: unknown[]): Promise<ToolSet> {
  const seen = new Map<string, ToolDigest>();
  let duplicates = 0;
  let invalid = 0;
  for (const raw of listed) {
    const core = toolCore(raw);
    if (!core) {
      invalid++;
      continue;
    }
    if (seen.has(core.name)) {
      duplicates++;
      continue;
    }
    seen.set(core.name, await toolDigest(core));
  }
  const snapshot = canonicalJson({ tools: listed });
  return { tools: [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), duplicates, invalid, snapshot, snapshotSha: `sha256:${await sha256Hex(snapshot)}` };
}

/** What the monitor keeps per tool between polls (the previous observation). */
export interface ToolState {
  name: string;
  raw: string;
  normalised: string;
  contract: string;
  description: string;
  schema: string;
  output: string;
  text: string;
}

export interface ToolChange {
  tool: string;
  change_class: ChangeClass;
  description_changed: boolean;
  schema_changed: boolean;
  output_schema_changed: boolean;
  before: ToolState | null;
  after: ToolState | null;
}

/**
 * The class of one tool's change. Added and removed first; then whitespace-only (raw digests differ, normalised equal);
 * then schema (the input schema changed, whatever else did); then description; then output_schema (only the output
 * schema changed: raw digests equal, contract digests differ). Null when nothing any digest covers changed.
 */
export function classify(before: ToolState | null, after: ToolState | null): Omit<ToolChange, "tool" | "before" | "after"> | null {
  if (!before && !after) return null;
  if (!before) return { change_class: "tool_added", description_changed: false, schema_changed: false, output_schema_changed: false };
  if (!after) return { change_class: "tool_removed", description_changed: false, schema_changed: false, output_schema_changed: false };
  if (before.raw === after.raw && before.contract === after.contract) return null;
  const description_changed = before.description !== after.description;
  const schema_changed = before.schema !== after.schema;
  const output_schema_changed = before.output !== after.output;
  const flags = { description_changed, schema_changed, output_schema_changed };
  if (before.raw === after.raw) return { change_class: "output_schema", ...flags };
  if (before.normalised === after.normalised) return { change_class: "whitespace_only", ...flags };
  return { change_class: schema_changed ? "schema" : "description", ...flags };
}

const stateOf = (d: ToolDigest): ToolState => ({ name: d.name, raw: d.raw, normalised: d.normalised, contract: d.contract, description: d.description, schema: d.schema, output: d.output, text: d.text });

/** Every tool whose digest differs from its previous observation, by tool name. */
export function diffTools(previous: ToolState[], next: ToolDigest[]): ToolChange[] {
  const prev = new Map(previous.map((p) => [p.name, p]));
  const now = new Map(next.map((n) => [n.name, stateOf(n)]));
  const names = [...new Set([...prev.keys(), ...now.keys()])].sort();
  const out: ToolChange[] = [];
  for (const tool of names) {
    const before = prev.get(tool) ?? null;
    const after = now.get(tool) ?? null;
    const c = classify(before, after);
    if (c) out.push({ tool, ...c, before, after });
  }
  return out;
}

/** Which digest a pin is: normalised (ignores whitespace-only changes), raw, or contract (adds outputSchema). */
export const PIN_MATCHES = ["normalised", "raw", "contract"] as const;
export type PinMatch = (typeof PIN_MATCHES)[number];
/** A pin: a digest (of the call's default kind), or a digest naming its own kind. */
export type Pin = string | { digest: string; match: PinMatch };
export interface PinResult {
  tool: string;
  /** unchanged: the pinned digest is today's; changed: it isn't; removed: no such tool listed now; not_pinned: listed now but not in the pins. */
  status: "unchanged" | "changed" | "removed" | "not_pinned";
  /** The kind of digest compared for this tool. */
  match: PinMatch;
  pinned: string | null;
  current: string | null;
}

const asDigest = (s: string) => (s.startsWith("sha256:") ? s : `sha256:${s}`).toLowerCase();

/**
 * Hold-on-change: compares a gateway's pinned digests with the current ones. With match "normalised" (the default),
 * a whitespace-only change is not a change, provided the pins are normalised digests too. A pin may name its own kind
 * ({digest, match}); otherwise the call's `match` applies.
 */
export function comparePins(pins: Record<string, Pin>, current: { name: string; raw: string; normalised: string; contract: string }[], match: PinMatch = "normalised"): { hold: boolean; tools: PinResult[] } {
  const cur = new Map(current.map((c) => [c.name, c]));
  const names = [...new Set([...Object.keys(pins), ...cur.keys()])].sort();
  const tools: PinResult[] = names.map((tool) => {
    const p = pins[tool];
    const kind: PinMatch = p !== undefined && typeof p === "object" ? p.match : match;
    const pinned = p === undefined ? null : asDigest(typeof p === "object" ? p.digest : p);
    const c = cur.get(tool);
    const now = c ? c[kind] : null;
    if (pinned === null) return { tool, status: "not_pinned", match: kind, pinned, current: now };
    if (now === null) return { tool, status: "removed", match: kind, pinned, current: null };
    return { tool, status: pinned === now ? "unchanged" : "changed", match: kind, pinned, current: now };
  });
  return { hold: tools.some((t) => t.status !== "unchanged"), tools };
}

export interface Optout {
  kind: string;
  value: string;
}

/** True when an opt-out names this endpoint: its Registry name, its host (or a parent domain of it), or its exact URL. */
export function optedOut(e: { registry_name: string; host: string; remote_url: string }, list: Optout[]) {
  const host = e.host.toLowerCase();
  return list.some((o) => {
    const v = o.value.trim().toLowerCase();
    if (!v) return false;
    if (o.kind === "registry_name") return e.registry_name.toLowerCase() === v;
    if (o.kind === "host") return host === v || host.endsWith(`.${v}`);
    if (o.kind === "url") return e.remote_url.toLowerCase() === v;
    return false;
  });
}

/** Backoff after `n` consecutive failures (n >= 1), in ms; a longer Retry-After (seconds) wins, capped at 30 days. */
export function backoffMs(n: number, retryAfterS: number | null = null) {
  const hour = 3_600_000;
  const base = Math.min(MONITOR_POLICY.minIntervalHours * 2 ** Math.max(0, n - 1), MONITOR_POLICY.backoffCapHours) * hour;
  const ra = retryAfterS && retryAfterS > 0 ? Math.min(retryAfterS * 1000, 30 * 24 * hour) : 0;
  return Math.max(base, ra);
}

/** A stable spread of up to an hour per endpoint, so polls don't bunch up after a batch. */
export function spreadMs(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3_600_000;
}
