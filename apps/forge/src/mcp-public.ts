import { summarize, TASKS, type AttemptResult } from "@forge/arena";
import { checkQuerySchema } from "@forge/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { gauntletAct, gauntletStatus, startGauntlet } from "./arena/gauntlet";
import { trapsData } from "./arena/traps";
import { finishedRuns, modelName } from "./arena/views";
import { getDb } from "./services/db";
import { recordToolCheck } from "./services/feedback";
import { checkTool } from "./services/forge";
import { recordCheck } from "./services/proof";

// The anonymous, read-only MCP endpoint at /mcp/public (ADR 0017 §3). No sign-in, so it works with Claude's
// "No sign-in" connector and the Gemini app. It only reads: checks, trap data and Arena results. Reports, votes
// and the ranked ladder stay on the signed-in /mcp. Every call is rate-limited per IP like the public web check.
// The Gauntlet (ADR 0024) has its own anonymous endpoint, /mcp/gauntlet, so this one stays read-only as submitted
// to the Claude directory.

export const PUBLIC_MCP_ROUTE = "/mcp/public";
export const GAUNTLET_MCP_ROUTE = "/mcp/gauntlet";

const json = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
  isError,
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const taskEnum = z.enum(TASKS.map((t) => t.id) as [string, ...string[]]);

export const checkInput = z.object({
  id: z.string().max(512).optional().describe("Tool id, e.g. npm:@scope/name or github.com/owner/repo/path"),
  url: z.string().max(512).optional().describe("A web URL for the tool, e.g. its GitHub or npm page"),
  fingerprint: z.string().max(80).optional().describe("sha256:<64 hex> of the exact version"),
});

/** The tool definitions, pinned in tests (ADR 0017 §2): any change to a name, title or description is deliberate. */
export const PUBLIC_TOOLS = {
  forge_check: {
    title: "Check a tool",
    description:
      "Before installing or using a skill, MCP server, plugin or API, check what verified agents reported about it. Give exactly one of id, url or fingerprint.",
  },
  forge_traps: {
    title: "Arena trap data",
    description:
      "How often AI models fell for each planted trap in The Forge Arena's everyday jobs: trap names, fall rates with sample sizes, data date and the trap card version. Optionally for one task or one model.",
  },
  arena_results: {
    title: "Arena results by task",
    description: "Per-task results from The Forge Arena: for each model, runs, pass rate, traps avoided and cost per pass, as measured by the referee.",
  },
} as const;

/** The Gauntlet's tools on /mcp/gauntlet, pinned in tests like PUBLIC_TOOLS. */
export const GAUNTLET_TOOLS = {
  gauntlet_start: {
    title: "Start the Forge Gauntlet",
    description:
      "Start the Forge Gauntlet: six everyday jobs in invented sandboxes with planted traps, refereed from the end state. No account. Returns a gauntlet_id, the first job's brief and its tools. Give card_from (an earlier gauntlet_id) for a measured re-run with that run's trap card.",
  },
  gauntlet_act: {
    title: "Act in the Forge Gauntlet",
    description: "Call one sandbox tool in the current Gauntlet job. When a job ends, the response carries its verdict and the next job; after the sixth, the report card.",
  },
  gauntlet_status: {
    title: "Gauntlet status",
    description: "The current job of a Gauntlet run (brief, tools, calls left), or its report card once finished.",
  },
} as const;

const GAUNTLET = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const gauntletId = z.string().regex(/^g[0-9a-f]{32}$/).describe("The gauntlet_id from gauntlet_start");

export async function arenaResults(db: ReturnType<typeof getDb>, task?: string) {
  const headline = await finishedRuns(db, { kinds: ["card", "guest"], task });
  const runs = headline.length ? headline : await finishedRuns(db, { kinds: ["practice"], task });
  return {
    data_kind: !runs.length ? "none" : headline.length ? "headline" : "practice",
    tasks: TASKS.filter((t) => !task || t.id === task).map((t) => {
      const by = new Map<string, AttemptResult[]>();
      for (const r of runs.filter((x) => x.summary.task === t.id)) by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r.result]);
      return {
        task: t.id,
        title: t.title,
        guide_url: `/best/${t.id}`,
        models: [...by.entries()]
          .map(([id, results]) => {
            const s = summarize(results);
            return { model: id, name: modelName(id), runs: s.runs, pass_rate: s.passRate, traps_avoided: s.trapResistance, cost_per_pass_usd: Number.isFinite(s.costOfPass) ? s.costOfPass : null, status: s.status };
          })
          .sort((a, b) => b.pass_rate - a.pass_rate || a.name.localeCompare(b.name)),
      };
    }),
  };
}

export function createPublicServer(env: Env, ip: string) {
  const server = new McpServer({ name: "the-agent-forge-public", version: "0.1.0" });
  const limited = async () => !(await env.CHECK_LIMITER.limit({ key: `ip:${ip}` })).success;

  server.registerTool("forge_check", { ...PUBLIC_TOOLS.forge_check, inputSchema: checkInput, annotations: READ_ONLY }, async (args) => {
    const q = checkQuerySchema.safeParse(args);
    if (!q.success) return json({ error: "invalid_query", detail: q.error.issues[0]?.message }, true);
    if (await limited()) return json({ error: "rate_limited" }, true);
    await recordCheck(env, "mcp", ip);
    await recordToolCheck(env, q.data);
    return json(await checkTool(env, q.data));
  });

  server.registerTool(
    "forge_traps",
    {
      ...PUBLIC_TOOLS.forge_traps,
      inputSchema: z.object({ task: taskEnum.optional().describe("One Arena task; all tasks if omitted"), model: z.string().max(64).optional().describe("One model id; all models if omitted") }),
      annotations: READ_ONLY,
    },
    async ({ task, model }) => {
      if (await limited()) return json({ error: "rate_limited" }, true);
      return json(await trapsData(getDb(env), { task, model }));
    },
  );

  server.registerTool(
    "arena_results",
    { ...PUBLIC_TOOLS.arena_results, inputSchema: z.object({ task: taskEnum.optional().describe("One Arena task; all tasks if omitted") }), annotations: READ_ONLY },
    async ({ task }) => {
      if (await limited()) return json({ error: "rate_limited" }, true);
      return json(await arenaResults(getDb(env), task));
    },
  );

  return server;
}

export function createGauntletServer(env: Env, ip: string) {
  const server = new McpServer({ name: "the-agent-forge-gauntlet", version: "0.1.0" });
  const limited = async () => !(await env.CHECK_LIMITER.limit({ key: `ip:${ip}` })).success;

  server.registerTool(
    "gauntlet_start",
    { ...GAUNTLET_TOOLS.gauntlet_start, inputSchema: z.object({ card_from: gauntletId.optional() }), annotations: GAUNTLET },
    async ({ card_from }) => {
      const r = await startGauntlet(env, ip, { cardFrom: card_from });
      return json(r, "error" in r);
    },
  );

  server.registerTool(
    "gauntlet_act",
    {
      ...GAUNTLET_TOOLS.gauntlet_act,
      inputSchema: z.object({ gauntlet_id: gauntletId, tool: z.string().max(64), args: z.record(z.string(), z.unknown()).default({}) }),
      annotations: GAUNTLET,
    },
    async ({ gauntlet_id, tool, args }) => {
      const r = await gauntletAct(env, gauntlet_id, tool, args);
      return json(r, "error" in r);
    },
  );

  server.registerTool(
    "gauntlet_status",
    { ...GAUNTLET_TOOLS.gauntlet_status, inputSchema: z.object({ gauntlet_id: gauntletId }), annotations: READ_ONLY },
    async ({ gauntlet_id }) => {
      if (await limited()) return json({ error: "rate_limited" }, true);
      const r = await gauntletStatus(env, gauntlet_id);
      return json(r, "error" in r);
    },
  );

  return server;
}

export function gauntletMcpHandler(env: Env, ip: string) {
  const host = new URL(env.PUBLIC_ORIGIN).hostname;
  return createMcpHandler(() => createGauntletServer(env, ip), { route: GAUNTLET_MCP_ROUTE, allowedHostnames: [host], allowedOriginHostnames: [host] });
}

export function publicMcpHandler(env: Env, ip: string) {
  const host = new URL(env.PUBLIC_ORIGIN).hostname;
  return createMcpHandler(() => createPublicServer(env, ip), {
    route: PUBLIC_MCP_ROUTE,
    allowedHostnames: [host],
    allowedOriginHostnames: [host],
  });
}
