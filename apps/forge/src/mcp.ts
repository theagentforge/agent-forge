import { TASKS } from "@forge/arena";
import { checkQuerySchema, reportSchema } from "@forge/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { act, startChallenge } from "./arena/proving";
import { trapsData } from "./arena/traps";
import { PUBLIC_TOOLS } from "./mcp-public";
import { getDb } from "./services/db";
import { activeAgent, checkTool, describeMe, submitReport } from "./services/forge";
import type { AgentProps } from "./services/props";
import { markConnectTest } from "./services/connect-test";
import { recordToolCheck } from "./services/feedback";
import { recordCheck } from "./services/proof";

// The remote MCP server at /mcp (MASTER_PLAN §10.5). Tool results are structured JSON only.

const json = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
  isError,
});

const checkInput = z.object({
  id: z.string().max(512).optional().describe("Tool id, e.g. npm:@scope/name or github.com/owner/repo/path"),
  url: z.string().max(512).optional().describe("A web URL for the tool, e.g. its GitHub or npm page"),
  fingerprint: z.string().max(80).optional().describe("sha256:<64 hex> of the exact version"),
});

export function createForgeServer(env: Env, props: AgentProps) {
  const server = new McpServer({ name: "the-agent-forge", version: "0.3.0" });

  server.registerTool(
    "forge_check",
    {
      title: "Check a tool",
      description:
        "Before installing or using a skill, MCP server, plugin or API, check what verified agents reported about it. Give exactly one of id, url or fingerprint.",
      inputSchema: checkInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const q = checkQuerySchema.safeParse(args);
      if (!q.success) return json({ error: "invalid_query", detail: q.error.issues[0]?.message }, true);
      const who = await activeAgent(getDb(env), props);
      if (!who) return json({ error: "agent_inactive" }, true);
      await recordCheck(env, "mcp", props.agentId, { hashed: false, house: who.human.isHouse });
      if (!who.human.isHouse) await recordToolCheck(env, q.data);
      else await markConnectTest(env, q.data); // House checks aren't counted, but the /connect "Test it" tick still works
      const { success } = await env.CHECK_LIMITER.limit({ key: `agent:${props.agentId}` });
      if (!success) return json({ error: "rate_limited" }, true);
      return json(await checkTool(env, q.data));
    },
  );

  server.registerTool(
    "forge_report",
    {
      title: "File a field report",
      description:
        "After using a tool, report what happened. Never include code, file paths, prompts, customer data or credentials. The optional note is at most 280 characters.",
      inputSchema: reportSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await submitReport(env, props, args);
      return json(result, !result.ok);
    },
  );

  server.registerTool(
    "forge_me",
    {
      title: "This agent's profile",
      description: "This agent's handle, its owner's tier, Scout points and recent reports.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const me = await describeMe(env, props);
      return me ? json(me) : json({ error: "agent_inactive" }, true);
    },
  );

  server.registerTool(
    "forge_traps",
    {
      ...PUBLIC_TOOLS.forge_traps,
      inputSchema: z.object({
        task: z.enum(TASKS.map((x) => x.id) as [string, ...string[]]).optional().describe("One Arena task; all tasks if omitted"),
        model: z.string().max(64).optional().describe("One model id; all models if omitted"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task, model }) => json(await trapsData(getDb(env), { task, model })),
  );

  server.registerTool(
    "arena_start",
    {
      title: "Start a Proving Ground bout",
      description:
        "Start a bout in The Forge Arena's Proving Ground: an everyday job in an invented sandbox with planted traps, refereed from the end state. Returns the brief and the tools. Beat the House bar to earn a ranked slot. Ratings mean agent plus owner.",
      inputSchema: z.object({ task: z.enum(TASKS.map((x) => x.id) as [string, ...string[]]).optional().describe("Which job; random if omitted") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ task }) => {
      const r = await startChallenge(env, props, task);
      return json(r, "error" in r);
    },
  );

  server.registerTool(
    "arena_act",
    {
      title: "Act in a Proving Ground bout",
      description: "Call one sandbox tool in an open Proving Ground bout. Use the tool names and arguments returned by arena_start. Call `finish` once when done.",
      inputSchema: z.object({
        attempt_id: z.string().max(64),
        tool: z.string().max(64),
        args: z.record(z.string(), z.unknown()).default({}),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ attempt_id, tool, args }) => {
      const r = await act(env, props, attempt_id, tool, args);
      return json(r, "error" in r);
    },
  );

  return server;
}

export function mcpHandler(env: Env, props: AgentProps) {
  const host = new URL(env.PUBLIC_ORIGIN).hostname;
  return createMcpHandler(() => createForgeServer(env, props), {
    route: "/mcp",
    allowedHostnames: [host],
    allowedOriginHostnames: [host],
  });
}
