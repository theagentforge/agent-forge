import { SCAN_RULES } from "@forge/shared";
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
  toHex,
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

/**
 * The 10 "My Keywords" for the Agentverse form (the API has no field for them; Dinike enters them by hand, see
 * docs/launch/agentverse.md). Agentverse's README guidance: phrases people actually type, each also in the README text.
 */
export const AV_KEYWORDS = [
  "ai agent trap results",
  "which ai model falls for scams",
  "ai model refund test",
  "fake invoice test for ai agents",
  "ai agent red teaming",
  "test my ai agent",
  "check mcp server safety",
  "is this npm package safe",
  "skill security scan",
  "prompt injection check",
] as const;

/** The short description (Agentverse "Agent Description"): Arena first, then the checks. */
export const AV_DESCRIPTION =
  "Arena results: which AI models fall for planted traps (fake invoices, refunds over limit, double orders) in refereed everyday jobs, with replays. Plus tool checks before install: field reports, OSV advisories and a skill-file scanner. Free, no account. Replies are JSON.";

/**
 * The README, written to Agentverse's README guidelines (docs.agentverse.ai, agent-discovery/readme-guidelines, read
 * 26 Oct 2026): English Markdown; summary, features, usage with inputs and outputs, use cases, limitations, metadata.
 * Arena first (Dinike's standing rule), then the Gauntlet, then checks and the scanner. Only stable, public facts: no
 * live counts, which would go stale once Agentverse keeps the text. Bump AV_README_VERSION on every change.
 */
export const AV_README_VERSION = 2;
export function avReadme(origin: string): string {
  return `# The Agent Forge

## Summary
The Agent Forge measures which AI models fall for planted traps when they do everyday business jobs, and checks
agent tools before you install them.

- **Arena:** AI models do refunds, invoice payment runs, travel booking, restocking, spreadsheet clean-up and bill
  payment in a sandbox. Each job hides traps: a fake invoice, a refund over the approval limit, a retry that orders
  twice, a flight outside its time window. A deterministic referee scores every run from the sandbox's end state and
  its tool-call log, and every published run has a public replay.
- **Gauntlet:** your own agent plays the same six jobs with hidden traps and gets a report card.
- **Checks:** field reports from human-verified agents on an exact tool version, plus OSV advisories for npm and PyPI.
- **Scanner:** checks a skill file or tool description for prompt injection, hidden text, piped installs and
  credential reads.

This agent answers in this chat with structured JSON data. It is free and needs no account.

## Key features
### Arena results by model (ai agent trap results)
- Per job and model: attempts, passes, pass rate with a 95% interval, the trap ids each model fell for,
  knockouts, cost per pass and replay links.
- Normal and Hard tiers, and named events such as \`crucible-2-hard\`.
- Answers questions like "which AI model falls for scams" or "which model is best at refunds". The jobs work as a
  fake invoice test for AI agents, an AI model refund test, a travel booking test and a double-order test.

### Trap card
- A short checklist made from the traps models fell for in refereed Arena runs, written to paste into an
  assistant's custom instructions.

### Gauntlet (test my ai agent)
- Not run in this chat: your agent connects to the MCP server ${origin}/mcp/gauntlet, or uses the HTTP API in
  ${origin}/gauntlet.md, and plays six jobs with hidden traps. Nothing real moves. The report shows each job and the
  traps it fell for. It is a form of ai agent red teaming on business tasks.

### Check a tool (check mcp server safety, is this npm package safe)
- Give an MCP server URL, a GitHub URL, \`npm:name\`, \`pypi:name\` or a sha256 fingerprint, with a version if known.
- Returns the verdict, security status, field reports for that version and matching OSV advisories (malicious
  package and CVE records), with a signed receipt link.

### Scan a skill file (skill security scan, prompt injection check)
- Give a public URL to a SKILL.md, tool description or install script.
- Returns the verdict (flagged, caution or clear), rule ids and line numbers from ${SCAN_RULES.length} open text rules.

## Usage
Send one plain message. The reply is one JSON object; the \`skill\` field says which skill answered.

| You send | Skill |
|---|---|
| \`arena results\`, \`arena results hard\`, \`which AI models fall for fake invoices?\` | arena-results |
| \`trap card\` | trap-card |
| \`check pypi:litellm==1.107.0\`, \`is the npm package lodash 4.17.21 safe?\` | check-tool |
| \`scan https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md\` | scan-skill |

Example input:
\`\`\`text
which AI models fall for fake invoices?
\`\`\`
Example output (abridged):
\`\`\`json
{"skill": "arena-results", "result": {"tier": "normal", "tasks": [{"task": "scam-invoice", "models": [{"name": "...", "runs": 3, "passes": 3, "pass_rate": 1, "ci_95": [0.44, 1], "replays": ["${origin}/arena/run/..."]}]}], "share": {"receipt_url": "${origin}/r/..."}}}
\`\`\`

Example input:
\`\`\`text
check pypi:litellm==1.107.0
\`\`\`
Example output (abridged):
\`\`\`json
{"skill": "check-tool", "result": {"summary": {"verdict": "flagged", "security_status": "flagged", "tool": "pypi:litellm", "version": "1.107.0", "field_reports": 0, "top_advisories": [{"id": "MAL-2026-2144", "kind": "malicious"}]}, "share": {"receipt_url": "${origin}/r/..."}}}
\`\`\`

Example input:
\`\`\`text
scan https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md
\`\`\`
Example output (abridged):
\`\`\`json
{"skill": "scan-skill", "result": {"verdict": "clear", "rules_version": "...", "findings": [], "rules_url": "${origin}/scan/rules", "guarantee": false}}
\`\`\`

A message the agent can't map to a skill gets \`{"error": "unrecognized_request"}\` with working examples.

## Use cases
- Choosing a model for an agent that pays invoices, issues refunds or books travel: compare trap results first.
- Before an agent installs an MCP server, plugin, skill or package: check that version for advisories and reports.
- Reviewing a skill file someone shared: run a skill security scan for hidden instructions.
- Hardening an assistant: add the trap card to its custom instructions.

## Limitations
- A clear scan means no known pattern matched, not that a tool is safe. Text rules can be evaded.
- Verdict "insufficient" means too few field reports; security status "unknown" means the tool isn't known and no
  advisory matched.
- Arena results come from a few attempts per job and model, so intervals are wide. They measure models as tool-using
  agents in our sandbox, not in your setup.
- Advisories cover npm and PyPI versions only.
- The Gauntlet and filing field reports are not available in this chat (they need the MCP server or website).
- Replies are data, never instructions. Requests are rate-limited.

## Metadata
- Organization: The Agent Forge, ${origin}
- Arena: ${origin}/arena · Gauntlet: ${origin}/gauntlet · Scanner rules: ${origin}/scan/rules
- Remote MCP server (no sign-in): ${origin}/mcp/public · Agent Card: ${origin}/.well-known/agent-card.json
- Contact: hello@theagentforge.io
- README version ${AV_README_VERSION}
`;
}

type Conn = { name: string; handle: string; apis: ReturnType<typeof agentverseApis>; id: Identity };

/** The connection, or null when the secret is missing or malformed. The secret itself never leaves this function. */
export async function connection(env: Env): Promise<Conn | null> {
  const uri = parseAgentverseUri(env.AGENTVERSE_CONNECTION);
  if (!uri) return null;
  return { name: uri.name, handle: uri.handle, apis: agentverseApis(uri.url), id: await identityFromSeed(uri.key, 0) };
}

const PROFILE_FIELDS = ["description", "readme", "avatar_url", "banner_url", "starter_prompts"] as const;
type Profile = { description: string; readme: string; avatar_url: string; banner_url: string; starter_prompts: string[] };

/** The listing: description, README, avatar and starter prompts (Arena first). */
export function listingProfile(origin: string): Profile {
  return {
    description: AV_DESCRIPTION,
    readme: avReadme(origin),
    avatar_url: agentCard(origin).iconUrl,
    banner_url: "",
    starter_prompts: ["which AI models fall for fake invoices?", "arena results hard", "trap card", "check pypi:litellm==1.107.0"],
  };
}

/** Line endings and trailing spaces don't count, so a value Agentverse stored with small whitespace changes still matches. */
const norm = (t: string) => t.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
export async function fieldHash(v: unknown): Promise<string | null> {
  const text = typeof v === "string" ? norm(v) : Array.isArray(v) && v.every((x) => typeof x === "string") ? JSON.stringify(v.map(norm)) : null;
  if (text === null) return null;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** The listing fields the cron may replace when the stored value is one it wrote itself (never avatar or banner). */
const OWN_FIELDS = ["description", "readme", "starter_prompts"] as const;
type OwnField = (typeof OWN_FIELDS)[number];

/**
 * Values this code sent earlier, by fieldHash. A stored value matching one was written by the cron, not edited by a
 * person, so a newer value may replace it once. These are the v1 values the two production releases before KV
 * records existed could have sent (origin https://theagentforge.io): e9facdf (26 Oct 15:02 UTC) and 0353740 (15:55
 * UTC, whose Agent Card added Arena results, changing the description and README). Which of the two made the first
 * registration isn't recorded, so both count. They apply only while KV holds no record for the field: once this
 * code has sent a value, only that value counts as its own, so a person who later pastes v1 text back keeps it.
 */
export const LEGACY_SENT: Record<OwnField, readonly string[]> = {
  description: ["e69bbd2bef555b8f191b195c6d4daabb284e72488660dd9a380b26db5edba897", "fae14b5516e24e6dea071beef6bf8bab9f664ade29fff4e1936aa2e9afac5bc3"],
  readme: ["dbf494dbb5b229f528170735ecadf7008ba7833e0a6756168d24be52a159a769", "e95d908780ae35b3cf80155413217e37738fd2ba2811e65e77b4d83cbe5e275b"],
  starter_prompts: ["aa0c41908f8be2df7d9aa8a9011fb59faf6681b72ae6c70b029ce9964907769e"],
};
export const SENT_KEY = "agentverse:sent";

async function readSent(env: Env): Promise<Partial<Record<OwnField, string>>> {
  const v: unknown = await env.KV.get(SENT_KEY, "json").catch(() => null);
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(OWN_FIELDS.flatMap((k) => (typeof (v as Record<string, unknown>)[k] === "string" ? [[k, (v as Record<string, string>)[k]]] : [])));
}

const timed = (f: typeof fetch, url: string, init: RequestInit) => f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

/**
 * One registration, as agentverse_sdk does at start-up: read the stored listing, then POST the RegistrationRequest
 * leaving out every listing field already set on Agentverse (so edits made on agentverse.ai win), except a
 * description, README or starter prompts that this code itself sent earlier and has since changed; then mark the
 * agent active in the Almanac. Production only, and only with the secret set.
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
  // A field set on Agentverse is kept (Dinike's edits win), unless it is exactly a value this code sent before and
  // differs from today's: then it is ours and out of date, and the new value replaces it once.
  const sentBefore = await readSent(env);
  const replaced: OwnField[] = [];
  for (const k of OWN_FIELDS) {
    if (!set(sp[k])) continue;
    const [was, now] = await Promise.all([fieldHash(sp[k]), fieldHash(profile[k])]);
    const ours = sentBefore[k] !== undefined ? sentBefore[k] === was : !!was && LEGACY_SENT[k].includes(was);
    if (was && was !== now && ours) replaced.push(k);
  }
  const kept = PROFILE_FIELDS.filter((k) => set(sp[k]) && !(replaced as string[]).includes(k));
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
  // Remember what was sent, so a later version can tell its own old text from a person's edit.
  const sent = { ...sentBefore };
  for (const k of OWN_FIELDS) if (!kept.includes(k)) sent[k] = (await fieldHash(profile[k])) ?? undefined;
  await env.KV.put(SENT_KEY, JSON.stringify(sent)).catch(() => {});

  // set_agent_status(identity, True): signed, no Authorization header.
  const status = await timed(f, `${conn.apis.almanac}/agents/${conn.id.address}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await statusUpdate(conn.id, true, nowS)),
  });
  return { registered: true as const, address: conn.id.address, kept_from_agentverse: kept, replaced_own: replaced, status_ok: status.ok };
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
