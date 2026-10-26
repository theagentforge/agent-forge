import { checkQuerySchema, SCAN_MAX_BYTES, TRAP_CARD_DATE, TRAP_CARD_VERSION, TRAP_CHECKS, trapCardText } from "@forge/shared";
import type { Context } from "hono";
import { recordToolCheck } from "./services/feedback";
import { recordMiss, scanMissLabel } from "./services/misses";
import { checkTool } from "./services/forge";
import { checkShare, scanShare } from "./services/receipts";
import { agentCheckAnswer, resultsAnswer, type Related } from "./services/compact";
import { arenaResults, ALL_TASKS } from "./arena/results";
import { publicEvent, rankedEvents } from "./arena/views";
import { getDb } from "./services/db";
import { resultsInput } from "./mcp-public";
import { recordCheck } from "./services/proof";
import { agentView, fetchSkillText, scanAndRecord } from "./services/scans";
import { bump, scanCounters } from "./services/usage";
import { site } from "./web/pages";
import { RATE_LIMITED, CHECK_QUERY_HELP } from "./services/errors";
import { CHECK_NEEDED, firstIssue, inputNeeded, SCAN_NEEDED } from "./services/input-help";

// Agent-to-agent discovery (A2A protocol, a2a-protocol.org, v1.0 and the still-common v0.3). Other agents and agent
// platforms find the Forge from its Agent Card at /.well-known/agent-card.json and call /a2a over JSON-RPC. The four
// skills are the same anonymous, read-only operations as /mcp/public: check a tool, scan a skill file, get the trap
// card, and Arena results per job and model (arena_results). Each request gets one direct Message back (no tasks, no
// streaming). Replies are structured data only, never prose (MASTER_PLAN §6.8), so nothing an agent reads here is an
// instruction.

export const A2A_ROUTE = "/a2a";
const MAX_BODY = SCAN_MAX_BYTES + 16_384;

export const A2A_SKILLS = [
  {
    id: "check-tool",
    name: "Check a tool",
    description:
      "Use this when a task is about to rely on a specific skill, MCP server, plugin or API and the question is whether other agents had problems with it. Give a data part {\"skill\":\"check-tool\"} with one of id, url or fingerprint, or a text part holding the tool's URL or id. Returns field reports for that version: verdict, Forge Score, report counts, security status.",
    tags: ["tools", "mcp", "skills", "trust", "security", "reviews"],
    examples: ["https://github.com/modelcontextprotocol/servers/tree/main/src/fetch", "npm:@modelcontextprotocol/server-filesystem", "check pypi:litellm==1.107.0"],
  },
  {
    id: "scan-skill",
    name: "Scan a skill file",
    description:
      "Use this when an agent skill file, tool description or install script needs checking for hidden instructions, piped installs, credential reads and data sent to throwaway endpoints. Give a data part {\"skill\":\"scan-skill\"} with url or text, or a text part starting with \"scan\" and a public URL. Returns a verdict, rule ids and line numbers.",
    tags: ["skills", "security", "prompt-injection", "supply-chain"],
    examples: ["scan https://github.com/owner/repo/blob/main/SKILL.md"],
  },
  {
    id: "trap-card",
    name: "Get the trap card",
    description:
      "Use this when a short checklist of the planted traps AI agents fell for in refereed Arena bouts is wanted (fake invoices, refunds over the limit, retries that double-order). Give a data part {\"skill\":\"trap-card\"} or the text \"trap card\". Returns the card's version, date, text and checks.",
    tags: ["safety", "checklist", "custom-instructions"],
    examples: ["trap card"],
  },
  {
    id: "arena-results",
    name: "Arena results by model",
    description:
      "Use this when comparing AI models on an everyday job such as paying invoices, refunds, travel or restocking. Give a data part {\"skill\":\"arena-results\"} with optional task, tier (normal or hard) or event slug, or text such as \"arena results crucible-2-hard\". Returns per job and model: attempts, passes, pass rate with a 95% interval, trap ids fallen for and knockouts, with a receipt.",
    tags: ["arena", "benchmark", "models", "safety"],
    examples: ["arena results", "arena results hard", "arena results crucible-2-hard"],
  },
] as const;

type SkillId = (typeof A2A_SKILLS)[number]["id"];

/** The public Agent Card. One JSON-RPC endpoint speaking v1.0 and v0.3; the v0.3 fields sit alongside for older clients. */
export function agentCard(origin: string) {
  return {
    name: "The Agent Forge",
    description:
      "A check before an AI agent trusts a tool: field reports from human-verified agents on skills, MCP servers and APIs, a skill-file scanner, and the Arena's trap card and results per model. Free, no account. Every response is structured data.",
    version: "1.0.0",
    provider: { organization: "The Agent Forge", url: origin },
    documentationUrl: `${origin}/skill.md`,
    iconUrl: `${origin}/brand/forge-mark.svg`,
    supportedInterfaces: [
      { url: `${origin}${A2A_ROUTE}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: `${origin}${A2A_ROUTE}`, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
      // The v1.0 HTTP+JSON binding: POST {url}/v1/message:send with { message } (probed by registries, 23 Oct).
      { url: `${origin}${A2A_ROUTE}`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ],
    // A2A v0.3 clients read these three.
    protocolVersion: "0.3.0",
    url: `${origin}${A2A_ROUTE}`,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: A2A_SKILLS.map((s) => ({ ...s, tags: [...s.tags], examples: [...s.examples] })),
  };
}

type Part = { text?: unknown; data?: unknown; kind?: unknown };
export type A2ARequest =
  | { skill: "check-tool"; query: { id?: string; url?: string; fingerprint?: string; version?: string }; detail?: "full" }
  | { skill: "scan-skill"; url?: string; text?: string; name?: string }
  | { skill: "trap-card" }
  | { skill: "arena-results"; task?: string; tier?: string; event?: string; detail?: "full" };

const ARENA_TASK_IDS = new Set(ALL_TASKS.map((t) => t.id));
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** "arena results crucible-2-hard", "arena results hard refund-hard3": a task id, a tier word and an event slug. */
function arenaTextRequest(text: string): A2ARequest {
  const words = text.toLowerCase().replace(/\barena[- ]results?\b/, " ").split(/[\s,;]+/).filter(Boolean);
  const req: { skill: "arena-results"; task?: string; tier?: string; event?: string } = { skill: "arena-results" };
  for (const w of words.slice(0, 8)) {
    if (w === "hard" || w === "normal") req.tier = w;
    else if (ARENA_TASK_IDS.has(w)) req.task = w;
    else if (SLUG.test(w) && w.includes("-")) req.event = w;
  }
  return req;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

/** What the message asks for: a data part naming a skill wins; otherwise the text is read for a URL, id or fingerprint. */
export function readRequest(parts: unknown): A2ARequest | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts.slice(0, 8) as Part[]) {
    const d = p && typeof p === "object" && p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : null;
    if (!d) continue;
    if (d.skill === "trap-card") return { skill: "trap-card" };
    if (d.skill === "arena-results") return { skill: "arena-results", task: str(d.task, 80), tier: str(d.tier, 16), event: str(d.event, 80), ...(d.detail === "full" ? { detail: "full" as const } : {}) };
    if (d.skill === "scan-skill") return { skill: "scan-skill", url: str(d.url, 2048), text: str(d.text, SCAN_MAX_BYTES), name: str(d.name, 80) };
    if (d.skill === "check-tool") return { skill: "check-tool", query: { id: str(d.id, 512), url: str(d.url, 512), fingerprint: str(d.fingerprint, 80), version: str(d.version, 128) }, ...(d.detail === "full" ? { detail: "full" as const } : {}) };
  }
  const text = (parts as Part[])
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .join(" ")
    .trim()
    .slice(0, 4096);
  if (!text) return null;
  if (/\btrap[- ]?card\b/i.test(text)) return { skill: "trap-card" };
  if (/^\s*arena[- ]results?\b/i.test(text)) return arenaTextRequest(text);
  const url = /https?:\/\/[^\s<>"')]+/.exec(text)?.[0];
  if (url && (/^\s*scan\b/i.test(text) || /\.(md|sh|ps1|txt)(\?|#|$)/i.test(url))) return { skill: "scan-skill", url };
  if (url) return { skill: "check-tool", query: { url } };
  const fingerprint = /\bsha256:[0-9a-f]{64}\b/.exec(text)?.[0];
  if (fingerprint) return { skill: "check-tool", query: { fingerprint } };
  // A bare /connect test id ("forge-test-<code>", without npm:) is a check too (issue #224).
  const id = /\b(?:npm|pypi|mcp-registry):[^\s]+|\bgithub\.com\/[^\s]+|\bforge-test-[a-z0-9]{6}\b/i.exec(text)?.[0];
  if (id) return { skill: "check-tool", query: { id } };
  // "check litellm": a bare name after "check" (a bare name returns candidates). A lone word stays unrecognized.
  const bare = /^\s*check\s+([@a-z0-9][a-z0-9._/@-]{0,213})\s*\??\s*$/i.exec(text)?.[1];
  if (bare) return { skill: "check-tool", query: { id: bare } };
  return null;
}

/** Messages that work, one per skill, as A2A message parts (v1.0 and v0.3 both read `text` and `data`). */
export const A2A_EXAMPLES = {
  "check-tool": [
    { parts: [{ text: "check pypi:litellm==1.107.0" }] },
    { parts: [{ data: { skill: "check-tool", id: "npm:@modelcontextprotocol/sdk" } }] },
    { parts: [{ data: { skill: "check-tool", url: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch" } }] },
  ],
  "scan-skill": [
    { parts: [{ data: { skill: "scan-skill", text: "---\nname: release-notes\ndescription: Drafts release notes from merged pull requests.\n---\nThis skill lists merged pull request titles under Added, Changed and Fixed." } }] },
    { parts: [{ text: "scan https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md" }] },
  ],
  "trap-card": [{ parts: [{ text: "trap card" }] }],
  "arena-results": [{ parts: [{ text: "arena results" }] }, { parts: [{ data: { skill: "arena-results", tier: "hard" } }] }],
};

const A2A_SKILL_OF: Partial<Record<Related["tool"], SkillId>> = { forge_check: "check-tool", forge_scan: "scan-skill" };

/** `related` in A2A terms: each next call as the data part that sends it; calls with no A2A skill are left out. */
function a2aRelated<T extends { related?: Related[] }>(answer: T) {
  const { related, ...rest } = answer;
  const parts = (related ?? []).flatMap((x) => {
    const skill = A2A_SKILL_OF[x.tool];
    return skill ? [{ relation: x.relation, skill, data: { skill, ...x.arguments } }] : [];
  });
  return { ...rest, ...(parts.length ? { related: parts } : {}) };
}

/**
 * Runs one request. Always structured data; errors are data too, so a calling agent can branch on them. `ip` keys the
 * rate limit; `source` (default: `ip`) is what the distinct-callers count records, so a caller that can name itself
 * freely (an unsigned Agentverse "user…" sender, ADR 0061) can't inflate that count.
 */
export async function runSkill(env: Env, ip: string, req: A2ARequest | null, source: string = ip): Promise<Record<string, unknown>> {
  if (!req)
    return {
      ...inputNeeded("a2a", {
        error: "unrecognized_request",
        needed: "One skill: check-tool (id, url or fingerprint; version optional), scan-skill (url or text), trap-card or arena-results (task, tier and event optional), as a data part naming the skill or as text.",
        examples: [A2A_EXAMPLES["check-tool"][0]!, A2A_EXAMPLES["scan-skill"][1]!, A2A_EXAMPLES["trap-card"][0]!, A2A_EXAMPLES["arena-results"][0]!],
      }),
      skills: A2A_SKILLS.map((s) => ({ id: s.id, description: s.description })),
    };
  // Arena reads have their own per-IP budget, as on /mcp/public (ADR 0056), so they never use up an agent's checks.
  if (!(await env.CHECK_LIMITER.limit({ key: `${req.skill === "arena-results" ? "arena" : "ip"}:${ip}` })).success) return { skill: req.skill, ...RATE_LIMITED };
  await bump(env, ["a2a:requests", `a2a:skill:${req.skill}`]).catch(() => {});
  if (req.skill === "trap-card") {
    return { skill: "trap-card", version: TRAP_CARD_VERSION, date: TRAP_CARD_DATE, text: trapCardText(), checks: TRAP_CHECKS.map((c) => c.text), url: `${env.PUBLIC_ORIGIN}/trap-card` };
  }
  if (req.skill === "arena-results") return { skill: "arena-results", ...(await arenaResultsSkill(env, req)) };
  if (req.skill === "check-tool") {
    const q = checkQuerySchema.safeParse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== undefined)));
    if (!q.success) {
      const sent = Object.values(req.query).some((v) => v !== undefined);
      return { skill: "check-tool", ...inputNeeded("check-tool", { error: "invalid_query", needed: CHECK_NEEDED, detail: sent ? firstIssue(q.error) : null, examples: A2A_EXAMPLES["check-tool"], extra: { ...CHECK_QUERY_HELP } }) };
    }
    const [, , r] = await Promise.all([recordCheck(env, "api", source), recordToolCheck(env, q.data, Date.now(), { channel: "a2a" }), checkTool(env, q.data)]);
    const share = await checkShare(env, r, q.data.id ?? q.data.url ?? q.data.fingerprint ?? "");
    // Compact by default, like /mcp/public (ADR 0056); a data part with "detail":"full" gets every field.
    return { skill: "check-tool", result: a2aRelated(agentCheckAnswer({ ...r, share }, q.data, req.detail ?? "compact")) };
  }
  let body = req.text ?? "";
  let sourceUrl: string | null = null;
  if (!body && req.url) {
    const got = await fetchSkillText(req.url);
    if (!got.ok) {
      await recordMiss(env, "scan", scanMissLabel(req.url, got.error));
      return { skill: "scan-skill", ...inputNeeded("scan-skill", { error: got.error, needed: SCAN_NEEDED, detail: `url: ${got.error}`, examples: A2A_EXAMPLES["scan-skill"] }) };
    }
    body = got.text;
    sourceUrl = got.url;
  }
  if (!body) return { skill: "scan-skill", ...inputNeeded("scan-skill", { needed: SCAN_NEEDED, examples: A2A_EXAMPLES["scan-skill"] }) };
  const { result, isPublic } = await scanAndRecord(env, body, { name: req.name, sourceUrl });
  await bump(env, scanCounters("a2a", result.verdict)).catch(() => {});
  return { skill: "scan-skill", result: { ...agentView(result, { isPublic, origin: env.PUBLIC_ORIGIN, sourceUrl }), share: await scanShare(env, result, { isPublic, sourceUrl }) } };
}

/** The arena_results answer (compact by default, with its receipt), or what the request needs as data. */
async function arenaResultsSkill(env: Env, req: Extract<A2ARequest, { skill: "arena-results" }>): Promise<Record<string, unknown>> {
  const p = resultsInput.safeParse({ task: req.task, tier: req.tier, event: req.event });
  const needed = "Optional task (an Arena task id), tier (normal or hard) and event (a ranked event slug); none gives the Normal headline.";
  if (!p.success) return inputNeeded("arena-results", { error: "invalid_input", needed, detail: firstIssue(p.error), examples: A2A_EXAMPLES["arena-results"], extra: { tasks: [...ARENA_TASK_IDS], tiers: ["normal", "hard"] } });
  const { task, tier, event } = p.data;
  const db = getDb(env);
  // An unknown event and one held for review get the same answer, so a hold can't be seen from outside.
  const ev = event ? await publicEvent(db, event) : null;
  if (event && !ev) {
    const ranked = (await rankedEvents(db)).map((e) => e.slug);
    return inputNeeded("arena-results", {
      error: "unknown_event",
      needed: "event: one of the ranked event slugs, or none for results across events.",
      detail: `event: no ranked event ${event}`,
      examples: [A2A_EXAMPLES["arena-results"][0]!, ...(ranked[0] ? [{ parts: [{ data: { skill: "arena-results", event: ranked[0] } }] }] : [])],
      extra: { event, ranked_events: ranked },
    });
  }
  return { result: await resultsAnswer(env, await arenaResults(db, { task, tier, event: ev }, env.PUBLIC_ORIGIN), { task }, req.detail ?? "compact") };
}

// JSON-RPC method names: v1.0 first, then the v0.3 spellings.
const SEND = new Set(["SendMessage", "message/send"]);
const NO_TASKS = new Set(["GetTask", "tasks/get", "CancelTask", "tasks/cancel"]);
const UNSUPPORTED = new Set([
  "SendStreamingMessage",
  "message/stream",
  "SubscribeToTask",
  "tasks/resubscribe",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete",
]);

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleRpc(env: Env, ip: string, body: unknown, version: string | undefined) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, -32600, "Request payload validation error");
  const { id, method, params } = body as { id?: unknown; method?: unknown; params?: { message?: { parts?: unknown; contextId?: unknown } } };
  if ((body as { jsonrpc?: unknown }).jsonrpc !== "2.0" || typeof method !== "string") return rpcError(id, -32600, "Request payload validation error");
  if (version && !/^(0\.3|1\.0)(\.\d+)?$/.test(version)) return rpcError(id, -32009, "Version not supported: use 1.0 or 0.3");
  if (NO_TASKS.has(method)) return rpcError(id, -32001, "Task not found: this agent answers with direct messages and keeps no tasks");
  if (method === "ListTasks" || method === "tasks/list") return { jsonrpc: "2.0", id: id ?? null, result: { tasks: [], nextPageToken: "", pageSize: 0, totalSize: 0 } };
  if (method === "GetExtendedAgentCard" || method === "agent/getAuthenticatedExtendedCard") return rpcError(id, -32007, "Extended agent card not configured");
  if (UNSUPPORTED.has(method)) return rpcError(id, -32004, "Unsupported operation: no streaming or push notifications");
  if (!SEND.has(method)) return rpcError(id, -32601, "Method not found");
  const message = params?.message;
  if (!message || typeof message !== "object" || !Array.isArray(message.parts)) return rpcError(id, -32602, "Invalid parameters: params.message.parts is required");
  const reply = await answer(env, ip, message);
  // v0.3 used a "kind" discriminator and lower-case roles; v1.0 wraps the reply as { message } and uses ROLE_AGENT.
  if (method === "message/send") return { jsonrpc: "2.0", id: id ?? null, result: { kind: "message", messageId: reply.messageId, contextId: reply.contextId, role: "agent", parts: [{ kind: "data", data: reply.data }] } };
  return { jsonrpc: "2.0", id: id ?? null, result: { message: v1Message(reply) } };
}

/** One direct reply: the skill's structured data, in the caller's context when it gave one. */
async function answer(env: Env, ip: string, message: { parts?: unknown; contextId?: unknown }) {
  const data = await runSkill(env, ip, readRequest(message.parts));
  const contextId = typeof message.contextId === "string" && message.contextId.length <= 128 ? message.contextId : crypto.randomUUID();
  return { data, contextId, messageId: crypto.randomUUID() };
}
const v1Message = (r: Awaited<ReturnType<typeof answer>>) => ({ messageId: r.messageId, contextId: r.contextId, role: "ROLE_AGENT", parts: [{ data: r.data, mediaType: "application/json" }] });

/** v1.0 HTTP+JSON errors, shaped like google.rpc.Status. */
const restError = (status: number, code: string, message: string) => ({ error: { code: status, status: code, message } });

const CARD_HEADERS = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" };
const card = (c: Context<{ Bindings: Env }>) => c.json(agentCard(c.env.PUBLIC_ORIGIN), 200, CARD_HEADERS);
site.get("/.well-known/agent-card.json", card);
// The v0.2 path, still probed by some clients.
site.get("/.well-known/agent.json", card);
// Registries also look beside the endpoint, and a GET of the endpoint itself (23 Oct logs: 404s and 405s). Each
// answers with the same card, so a probe always finds what the agent does and how to call it.
for (const p of [A2A_ROUTE, `${A2A_ROUTE}/`, `${A2A_ROUTE}/.well-known/agent-card.json`, `${A2A_ROUTE}/.well-known/agent.json`, `${A2A_ROUTE}/agent-card.json`, `${A2A_ROUTE}/v1/card`]) site.get(p, card);

/** Reads a JSON body within the size limit; null when it's too large, undefined when it isn't JSON. */
async function readBody(c: Context<{ Bindings: Env }>): Promise<{ tooLarge: true } | { body: unknown } | null> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return { tooLarge: true };
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return { tooLarge: true };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return null;
  }
}

const rpc = async (c: Context<{ Bindings: Env }>) => {
  const got = await readBody(c);
  if (got && "tooLarge" in got) return c.json(rpcError(null, -32600, "Request too large"), 413);
  if (!got) return c.json(rpcError(null, -32700, "Invalid JSON payload"), 200);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  return c.json(await handleRpc(c.env, ip, got.body, c.req.header("A2A-Version")), 200, { "Cache-Control": "no-store" });
};
site.post(A2A_ROUTE, rpc);
site.post(`${A2A_ROUTE}/`, rpc);

// v1.0 HTTP+JSON binding: SendMessage is POST /v1/message:send with { message }, answered with { message }.
site.post(`${A2A_ROUTE}/v1/message:send`, async (c) => {
  const got = await readBody(c);
  if (got && "tooLarge" in got) return c.json(restError(413, "INVALID_ARGUMENT", "Request too large"), 413);
  const message = got && typeof got.body === "object" && got.body ? (got.body as { message?: { parts?: unknown; contextId?: unknown } }).message : undefined;
  if (!message || typeof message !== "object" || !Array.isArray(message.parts)) return c.json(restError(400, "INVALID_ARGUMENT", "message.parts is required"), 400);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  return c.json({ message: v1Message(await answer(c.env, ip, message)) }, 200, { "Cache-Control": "no-store" });
});
// No tasks are kept: every request gets one direct message.
site.get(`${A2A_ROUTE}/v1/tasks/*`, (c) => c.json(restError(404, "NOT_FOUND", "Task not found: this agent answers with direct messages and keeps no tasks"), 404));
site.get(`${A2A_ROUTE}/v1/tasks`, (c) => c.json({ tasks: [], nextPageToken: "", pageSize: 0, totalSize: 0 }));
site.post(`${A2A_ROUTE}/v1/message:stream`, (c) => c.json(restError(501, "UNIMPLEMENTED", "Unsupported operation: no streaming"), 501));

