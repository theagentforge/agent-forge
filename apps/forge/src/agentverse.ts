import type { Context } from "hono";
import { agentCard, readRequest, runSkill } from "./a2a";
import {
  ackBody,
  agentverseApis,
  attestation,
  CHAT_ACK_DIGEST,
  CHAT_MESSAGE_DIGEST,
  CHAT_PROTOCOL_DIGEST,
  chatText,
  decodePayload,
  type Envelope,
  type Identity,
  identityFromSeed,
  makeEnvelope,
  messageBody,
  parseAgentverseUri,
  readChat,
  readEnvelope,
  statusUpdate,
  verifyEnvelope,
} from "./services/uagents";
import { bump } from "./services/usage";
import { site } from "./web/pages";

// The Forge as an external A2A agent on Fetch.ai Agentverse, so ASI:One and Agentverse search can find it (ADR 0061).
// It does in TypeScript what agentverse-sdk 0.2.1's A2A integration does in Python: register the listing with an
// identity derived from the AGENTVERSE_CONNECTION secret, and answer Agent Chat Protocol envelopes at /av/chat with
// the same skills as /a2a. Without the secret, nothing here runs and /av/chat is a 404.

export const AV_CHAT_PATHS = ["/av/chat", "/a2a/av/chat"] as const;
/** The SDK registers {first HTTP interface url}/av/chat; our interface is /a2a. Both paths answer. */
const chatUrl = (origin: string) => `${origin}/a2a/av/chat`;
const AUTH_VALIDITY_S = 120; // AGENT_AUTH_TOKEN_VALIDITY
const TIMEOUT_MS = 10_000; // DEFAULT_HTTP_REQUESTS_TIMEOUT
const MAX_BODY = 96 * 1024;

export const AV_KEYWORDS = ["mcp security", "skill scanner", "prompt injection", "package advisories", "agent safety"] as const;
export const AV_README_LEAD =
  "Free remote MCP server and A2A agent: scans agent skill files and tool descriptions for prompt injection and risky install steps; checks MCP servers and npm/PyPI packages against OSV advisories and field reports from human-verified agents; publishes per-model results on which AI agents fall for planted traps in refereed everyday jobs.";

type Conn = { name: string; handle: string; apis: ReturnType<typeof agentverseApis>; id: Identity };

/** The connection, or null when the secret is missing or malformed. The secret itself never leaves this function. */
export async function connection(env: Env): Promise<Conn | null> {
  const uri = parseAgentverseUri(env.AGENTVERSE_CONNECTION);
  if (!uri) return null;
  return { name: uri.name, handle: uri.handle, apis: agentverseApis(uri.url), id: await identityFromSeed(uri.key, 0) };
}

const PROFILE_FIELDS = ["description", "readme", "avatar_url", "banner_url", "starter_prompts"] as const;
type Profile = { description: string; readme: string; avatar_url: string; banner_url: string; starter_prompts: string[] };

/** The listing text: the README lead, the keywords, then one section per skill with working examples. */
export function listingProfile(origin: string): Profile {
  const card = agentCard(origin);
  const skills = card.skills.map((s) => `### ${s.name}\n${s.description}\n\nExamples\n${s.examples.map((e) => `- \`${e}\``).join("\n")}`).join("\n\n");
  const readme = `# ${card.name}\n${AV_README_LEAD}\n\nKeywords: ${AV_KEYWORDS.join(", ")}\n\n## What this agent can do (Skills)\n\n${skills}\n\n## About\nAgent Card: ${origin}/.well-known/agent-card.json\nA2A endpoint: ${origin}/a2a\nRemote MCP server (no sign-in): ${origin}/mcp/public\nReplies are structured JSON data.\n`;
  return {
    description: card.description.slice(0, 300),
    readme,
    avatar_url: card.iconUrl,
    banner_url: "",
    starter_prompts: ["check pypi:litellm==1.107.0", "trap card", "scan https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"],
  };
}

const timed = (f: typeof fetch, url: string, init: RequestInit) => f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

/**
 * One registration, as agentverse_sdk does at start-up: read the stored listing, then POST the RegistrationRequest
 * leaving out every listing field already set on Agentverse (so edits made on agentverse.ai win), then mark the agent
 * active in the Almanac. Production only, and only with the secret set.
 */
export async function registerAgentverse(env: Env, now = Date.now(), f: typeof fetch = fetch) {
  if (env.ENVIRONMENT !== "production") return { skipped: "not_production" as const };
  const conn = await connection(env);
  if (!conn) return { skipped: env.AGENTVERSE_CONNECTION ? ("malformed_secret" as const) : ("no_secret" as const) };
  if (conn.name.length > 32 || conn.handle.length > 40) return { skipped: "name_too_long" as const };
  const nowS = Math.floor(now / 1000);
  const headers = { Authorization: `Agent ${await attestation(conn.id, nowS, AUTH_VALIDITY_S)}`, "Content-Type": "application/json" };

  // _get_stored_listing_sync. A listing not created yet (404) has nothing to preserve.
  const got = await timed(f, `${conn.apis.agents}/${conn.id.address}`, { method: "GET", headers });
  let stored: { name?: unknown; handle?: unknown; profile?: Record<string, unknown> } = {};
  if (got.ok) {
    // An unreadable listing is an error, as in the SDK: treating it as empty would overwrite Dinike's edits.
    const v: unknown = await got.json().catch(() => null);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("agentverse_get_unreadable");
    stored = v as typeof stored;
  } else if (got.status !== 404) throw new Error(`agentverse_get_${got.status}`);
  const set = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

  const profile = listingProfile(env.PUBLIC_ORIGIN);
  const sp = stored.profile && typeof stored.profile === "object" ? stored.profile : {};
  const kept = PROFILE_FIELDS.filter((k) => set(sp[k]));
  const request: Record<string, unknown> = {
    address: conn.id.address,
    ...(set(stored.name) ? {} : { name: conn.name }),
    ...(set(stored.handle) ? {} : { handle: conn.handle }),
    url: chatUrl(env.PUBLIC_ORIGIN),
    agent_type: "a2a",
    profile: Object.fromEntries(PROFILE_FIELDS.filter((k) => !kept.includes(k)).map((k) => [k, profile[k]])),
    // track_interactions (the SDK default): senders reach us through the Agentverse proxy, which forwards to `url`.
    endpoints: [{ url: conn.apis.proxy, weight: 1 }],
    protocols: [CHAT_PROTOCOL_DIGEST],
    metadata: null,
  };
  const posted = await timed(f, conn.apis.agents, { method: "POST", headers, body: JSON.stringify(request) });
  if (!posted.ok) throw new Error(`agentverse_register_${posted.status}`);

  // set_agent_status(identity, True): signed, no Authorization header.
  const status = await timed(f, `${conn.apis.almanac}/agents/${conn.id.address}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await statusUpdate(conn.id, true, nowS)),
  });
  return { registered: true as const, address: conn.id.address, kept_from_agentverse: kept, status_ok: status.ok };
}

/**
 * Where a reply may go. The Almanac entry is written by whoever owns the sender's key, so it is attacker-controlled:
 * https only, a DNS name (no IP literals, no single-label or .local/.internal/.localhost names), no credentials in the
 * URL, and never the Forge's own domain or its subdomains (staging included).
 */
export function replyUrlAllowed(raw: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || raw.length > 2048) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^[0-9.]+$/.test(host) || /^(0x[0-9a-f]+|\d+)$/i.test(host)) return false;
  if (/(^|\.)(localhost|local|internal|localdomain|home|lan|arpa)$/.test(host)) return false;
  const own = new URL(origin).hostname.toLowerCase().split(".").slice(-2).join(".");
  return host !== own && !host.endsWith(`.${own}`);
}

/** AlmanacResolver: the destination's endpoints from the Almanac, one picked by weight, among allowed URLs only. */
async function resolveEndpoint(conn: Conn, destination: string, origin: string, f: typeof fetch): Promise<string | null> {
  const r = await timed(f, `${conn.apis.almanac}/agents/${encodeURIComponent(destination)}`, { method: "GET", headers: { "Content-Type": "application/json" } });
  if (!r.ok) return null;
  const body = (await r.json().catch(() => null)) as { endpoints?: { url?: unknown; weight?: unknown }[] } | null;
  const eps = (Array.isArray(body?.endpoints) ? body.endpoints.slice(0, 16) : []).flatMap((e) => {
    if (typeof e?.url !== "string" || !replyUrlAllowed(e.url, origin)) return [];
    return [{ url: e.url, weight: typeof e.weight === "number" && Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1 }];
  });
  if (!eps.length) return null;
  let pick = Math.random() * eps.reduce((n, e) => n + e.weight, 0);
  for (const e of eps) if ((pick -= e.weight) <= 0) return e.url;
  return eps[eps.length - 1]!.url;
}

/**
 * send_message_to_agent, to an endpoint already resolved: a signed envelope in the same session. Redirects are not
 * followed (a redirect could lead past replyUrlAllowed) and the response body is never read.
 */
async function send(conn: Conn, endpoint: string, to: string, session: string, digest: string, body: unknown, f: typeof fetch) {
  const envelope = await makeEnvelope(conn.id, to, digest, body, session);
  const r = await timed(f, endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope), redirect: "manual" });
  await r.body?.cancel().catch(() => {});
  if (r.status < 200 || r.status > 299) throw new Error(`agentverse_send_${r.status}`);
}

/**
 * _process_chat_message_bg: acknowledge, then (unless the message only opens a session) run the text through the A2A
 * skills and reply with the skill's structured data as JSON text (AGENTS.md rule 7). The sender's endpoint is resolved
 * once, so a message causes at most one Almanac lookup and two POSTs (ack, reply) to one place. Skills are
 * rate-limited per sender address; the distinct-callers count records the IP, as /a2a does, because "user…" senders
 * are unsigned and can be any string.
 */
export async function processChat(env: Env, conn: Conn, e: Envelope, msgId: string, text: string, onlyStart: boolean, ip: string, f: typeof fetch = fetch) {
  const endpoint = await resolveEndpoint(conn, e.sender, env.PUBLIC_ORIGIN, f);
  if (!endpoint) throw new Error("agentverse_unresolved");
  await send(conn, endpoint, e.sender, e.session, CHAT_ACK_DIGEST, ackBody(msgId, Date.now()), f);
  if (onlyStart) return null;
  let data: Record<string, unknown>;
  try {
    data = await runSkill(env, `av:${e.sender}`, readRequest([{ text }]), ip);
  } catch {
    data = { error: "processing_failed" };
  }
  await bump(env, ["agentverse:messages"]).catch(() => {});
  await send(conn, endpoint, e.sender, e.session, CHAT_MESSAGE_DIGEST, messageBody(JSON.stringify(data), Date.now()), f);
  return data;
}

const detail = (c: Context<{ Bindings: Env }>, status: 400 | 404 | 413 | 429, d: string) => c.json({ detail: d }, status, { "Cache-Control": "no-store" });

/** POST /av/chat: parse_chat_message_from_request, then {} at once with the work done after the response. */
export async function avChat(c: Context<{ Bindings: Env }>, f: typeof fetch = fetch) {
  // Inert on staging even if the secret is set there: one Agentverse identity, one environment (ADR 0061).
  if (c.env.ENVIRONMENT !== "production") return detail(c, 404, "Not Found");
  const conn = await connection(c.env);
  if (!conn) return detail(c, 404, "Not Found");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.AGENTVERSE_LIMITER.limit({ key: `ip:${ip}` })).success) return detail(c, 429, "rate_limited");
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return detail(c, 413, "Request too large");
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return detail(c, 413, "Request too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return detail(c, 400, "Malformed envelope or chat message");
  }
  const e = readEnvelope(parsed);
  if (!e) return detail(c, 400, "Malformed envelope or chat message");
  if (!(await verifyEnvelope(e))) return detail(c, 400, "Invalid envelope");
  if (e.target !== conn.id.address) return detail(c, 400, "Wrong destination address");
  // The SDK ignores `expires`; uAgents agents refuse expired envelopes, and so do we (it is covered by the signature).
  if (e.expires !== null && e.expires * 1000 < Date.now()) return detail(c, 400, "Envelope expired");
  const json = decodePayload(e);
  const msg = json === null ? null : readChat(json);
  if (!msg) return detail(c, 400, "Malformed envelope or chat message");
  if (msg.kind === "ack") return c.json({});
  const onlyStart = msg.content.length === 1 && msg.content[0]!.type === "start-session";
  c.executionCtx.waitUntil(
    processChat(c.env, conn, e, msg.msg_id, chatText(msg).slice(0, 4096), onlyStart, ip, f).catch((err) => console.error("agentverse_chat_failed", String(err).slice(0, 120))),
  );
  return c.json({});
}

for (const p of AV_CHAT_PATHS) site.post(p, (c) => avChat(c));
