import { checkQuerySchema, SCAN_MAX_BYTES, TRAP_CARD_DATE, TRAP_CARD_VERSION, TRAP_CHECKS, trapCardText } from "@forge/shared";
import type { Context } from "hono";
import { recordToolCheck } from "./services/feedback";
import { checkTool } from "./services/forge";
import { recordCheck } from "./services/proof";
import { agentView, fetchSkillText, scanAndRecord } from "./services/scans";
import { bump, scanCounters } from "./services/usage";
import { site } from "./web/pages";

// Agent-to-agent discovery (A2A protocol, a2a-protocol.org, v1.0 and the still-common v0.3). Other agents and agent
// platforms find the Forge from its Agent Card at /.well-known/agent-card.json and call /a2a over JSON-RPC. The three
// skills are the same anonymous, read-only operations as /mcp/public: check a tool, scan a skill file, get the trap
// card. Each request gets one direct Message back (no tasks, no streaming). Replies are structured data only, never
// prose (MASTER_PLAN §6.8), so nothing an agent reads here is an instruction.

export const A2A_ROUTE = "/a2a";
const MAX_BODY = SCAN_MAX_BYTES + 16_384;

export const A2A_SKILLS = [
  {
    id: "check-tool",
    name: "Check a tool",
    description:
      "Use this when a task is about to rely on a specific skill, MCP server, plugin or API and the question is whether other agents had problems with it. Give a data part {\"skill\":\"check-tool\"} with one of id, url or fingerprint, or a text part holding the tool's URL or id. Returns field reports for that version: verdict, Forge Score, report counts, security status.",
    tags: ["tools", "mcp", "skills", "trust", "security", "reviews"],
    examples: ["https://github.com/modelcontextprotocol/servers/tree/main/src/fetch", "npm:@modelcontextprotocol/server-filesystem"],
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
] as const;

type SkillId = (typeof A2A_SKILLS)[number]["id"];

/** The public Agent Card. One JSON-RPC endpoint speaking v1.0 and v0.3; the v0.3 fields sit alongside for older clients. */
export function agentCard(origin: string) {
  return {
    name: "The Agent Forge",
    description:
      "A check before an AI agent trusts a tool: field reports from human-verified agents on skills, MCP servers and APIs, a skill-file scanner, and the Arena's trap card. Free, no account. Every response is structured data.",
    version: "1.0.0",
    provider: { organization: "The Agent Forge", url: origin },
    documentationUrl: `${origin}/skill.md`,
    iconUrl: `${origin}/brand/forge-mark.svg`,
    supportedInterfaces: [
      { url: `${origin}${A2A_ROUTE}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: `${origin}${A2A_ROUTE}`, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
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
  | { skill: "check-tool"; query: { id?: string; url?: string; fingerprint?: string } }
  | { skill: "scan-skill"; url?: string; text?: string; name?: string }
  | { skill: "trap-card" };

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

/** What the message asks for: a data part naming a skill wins; otherwise the text is read for a URL, id or fingerprint. */
export function readRequest(parts: unknown): A2ARequest | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts.slice(0, 8) as Part[]) {
    const d = p && typeof p === "object" && p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : null;
    if (!d) continue;
    if (d.skill === "trap-card") return { skill: "trap-card" };
    if (d.skill === "scan-skill") return { skill: "scan-skill", url: str(d.url, 2048), text: str(d.text, SCAN_MAX_BYTES), name: str(d.name, 80) };
    if (d.skill === "check-tool") return { skill: "check-tool", query: { id: str(d.id, 512), url: str(d.url, 512), fingerprint: str(d.fingerprint, 80) } };
  }
  const text = (parts as Part[])
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .join(" ")
    .trim()
    .slice(0, 4096);
  if (!text) return null;
  if (/\btrap[- ]?card\b/i.test(text)) return { skill: "trap-card" };
  const url = /https?:\/\/[^\s<>"')]+/.exec(text)?.[0];
  if (url && (/^\s*scan\b/i.test(text) || /\.(md|sh|ps1|txt)(\?|#|$)/i.test(url))) return { skill: "scan-skill", url };
  if (url) return { skill: "check-tool", query: { url } };
  const fingerprint = /\bsha256:[0-9a-f]{64}\b/.exec(text)?.[0];
  if (fingerprint) return { skill: "check-tool", query: { fingerprint } };
  const id = /\b(?:npm|mcp-registry):[^\s]+|\bgithub\.com\/[^\s]+/i.exec(text)?.[0];
  if (id) return { skill: "check-tool", query: { id } };
  return null;
}

/** Runs one request. Always structured data; errors are data too, so a calling agent can branch on them. */
export async function runSkill(env: Env, ip: string, req: A2ARequest | null): Promise<Record<string, unknown>> {
  if (!req) return { error: "unrecognized_request", skills: A2A_SKILLS.map((s) => ({ id: s.id, description: s.description })) };
  if (!(await env.CHECK_LIMITER.limit({ key: `ip:${ip}` })).success) return { skill: req.skill, error: "rate_limited" };
  await bump(env, ["a2a:requests", `a2a:skill:${req.skill}`]).catch(() => {});
  if (req.skill === "trap-card") {
    return { skill: "trap-card", version: TRAP_CARD_VERSION, date: TRAP_CARD_DATE, text: trapCardText(), checks: TRAP_CHECKS.map((c) => c.text), url: `${env.PUBLIC_ORIGIN}/trap-card` };
  }
  if (req.skill === "check-tool") {
    const q = checkQuerySchema.safeParse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== undefined)));
    if (!q.success) return { skill: "check-tool", error: "invalid_query", detail: q.error.issues[0]?.message ?? null };
    await recordCheck(env, "api", ip);
    await recordToolCheck(env, q.data);
    return { skill: "check-tool", result: await checkTool(env, q.data) };
  }
  let body = req.text ?? "";
  let sourceUrl: string | null = null;
  if (!body && req.url) {
    const got = await fetchSkillText(req.url);
    if (!got.ok) return { skill: "scan-skill", error: got.error };
    body = got.text;
    sourceUrl = got.url;
  }
  if (!body) return { skill: "scan-skill", error: "give text or url" };
  const { result, isPublic } = await scanAndRecord(env, body, { name: req.name, sourceUrl });
  await bump(env, scanCounters("a2a", result.verdict)).catch(() => {});
  return { skill: "scan-skill", result: agentView(result, { isPublic, origin: env.PUBLIC_ORIGIN, sourceUrl }) };
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
  const data = await runSkill(env, ip, readRequest(message.parts));
  const contextId = typeof message.contextId === "string" && message.contextId.length <= 128 ? message.contextId : crypto.randomUUID();
  const messageId = crypto.randomUUID();
  // v0.3 used a "kind" discriminator and lower-case roles; v1.0 wraps the reply as { message } and uses ROLE_AGENT.
  if (method === "message/send") return { jsonrpc: "2.0", id: id ?? null, result: { kind: "message", messageId, contextId, role: "agent", parts: [{ kind: "data", data }] } };
  return { jsonrpc: "2.0", id: id ?? null, result: { message: { messageId, contextId, role: "ROLE_AGENT", parts: [{ data, mediaType: "application/json" }] } } };
}

const CARD_HEADERS = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" };
const card = (c: Context<{ Bindings: Env }>) => c.json(agentCard(c.env.PUBLIC_ORIGIN), 200, CARD_HEADERS);
site.get("/.well-known/agent-card.json", card);
// The v0.2 path, still probed by some clients.
site.get("/.well-known/agent.json", card);

site.post(A2A_ROUTE, async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.json(rpcError(null, -32600, "Request too large"), 413);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return c.json(rpcError(null, -32600, "Request too large"), 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json(rpcError(null, -32700, "Invalid JSON payload"), 200);
  }
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  return c.json(await handleRpc(c.env, ip, body, c.req.header("A2A-Version")), 200, { "Cache-Control": "no-store" });
});

site.get(A2A_ROUTE, (c) => c.json({ error: "use POST with JSON-RPC 2.0; the agent card is at /.well-known/agent-card.json" }, 405, { Allow: "POST" }));

