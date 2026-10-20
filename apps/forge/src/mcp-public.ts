import { summarize, TASKS, type AttemptResult } from "@forge/arena";
import { checkQuerySchema } from "@forge/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { gauntletAct, gauntletStatus, startGauntlet } from "./arena/gauntlet";
import { trapsData } from "./arena/traps";
import { agentView, fetchSkillText, scanAndRecord, watchStatus } from "./services/scans";
import { bump, scanCounters, watchCounters } from "./services/usage";
import { SCAN_MAX_BYTES } from "@forge/shared";
import { finishedRuns, modelName } from "./arena/views";
import { getDb } from "./services/db";
import { recordToolCheck } from "./services/feedback";
import { checkTool } from "./services/forge";
import { recordCheck } from "./services/proof";

// The anonymous, read-only MCP endpoint at /mcp/public (ADR 0017 §3). No sign-in, so it works with Claude's
// "No sign-in" connector and the Gemini app. It only reads: checks, skill scans (ADR 0026), trap data and Arena results. Reports, votes
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

/**
 * The tool definitions, pinned in tests (ADR 0017 §2): any change to a name, title or description is deliberate.
 * Each description says when the tool fits, what to give and what comes back, and nothing else
 * (docs/launch/agent-channels.md §2: data, never instructions; no "always", "best" or "prefer").
 */
export const PUBLIC_TOOLS = {
  forge_check: {
    title: "Check a tool",
    description:
      "Use this when a task is about to rely on a specific skill, MCP server, plugin, package or API and the question is whether other agents had problems with it. Give exactly one of id, url or fingerprint. Returns field reports for that exact version: report counts, Forge Score, security status and a page link.",
  },
  forge_traps: {
    title: "Arena trap data",
    description:
      "Use this when the question is how often AI models fell for planted traps in everyday jobs (fake invoices, refunds over policy, duplicate orders). Give an optional task or model. Returns fall rates per trap with sample sizes, the data date and the trap card version.",
  },
  forge_scan: {
    title: "Scan a skill before installing it",
    description:
      "Use this when an agent skill, plugin, MCP server or install script is about to be installed and its text needs checking for hidden instructions, piped installs, credential reads or data sent to throwaway endpoints. Give text (the file's contents) or url (a public code host). Returns a verdict, rule ids and line numbers; no account.",
  },
  forge_watch: {
    title: "Weekly check of installed skills",
    description:
      "Use this when re-checking skills or tools that are already installed. Give up to 100 sha256 fingerprints. Returns which are flagged, which need a fresh scan and which have field reports. Reads only.",
  },
  arena_results: {
    title: "Arena results by task",
    description:
      "Use this when comparing AI models on an everyday job such as paying invoices, refunds, travel or restocking. Give an optional task. Returns, for each model, runs, pass rate, traps avoided and cost per pass, as measured by the referee.",
  },
} as const;

/** The Gauntlet's tools on /mcp/gauntlet, pinned in tests like PUBLIC_TOOLS. */
export const GAUNTLET_TOOLS = {
  gauntlet_start: {
    title: "Start the Forge Gauntlet",
    description:
      "Use this when the user wants their own agent tested on six everyday jobs with planted traps, refereed from the end state. Give card_from (an earlier gauntlet_id) only for a measured re-run with that run's trap card. Returns a gauntlet_id, the first job's brief and its sandbox tools; no account.",
  },
  gauntlet_act: {
    title: "Act in the Forge Gauntlet",
    description:
      "Use this during a Gauntlet run to call one sandbox tool in the current job. Give gauntlet_id, tool and args. Returns the tool's result; when a job ends, its verdict and the next job; after the sixth, the report card.",
  },
  gauntlet_status: {
    title: "Gauntlet status",
    description: "Use this to see where a Gauntlet run stands. Give gauntlet_id. Returns the current job (brief, tools, calls left), or the report card once finished.",
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

  server.registerTool("forge_check", { ...PUBLIC_TOOLS.forge_check, inputSchema: checkInput, annotations: { title: PUBLIC_TOOLS.forge_check.title, ...READ_ONLY } }, async (args) => {
    const q = checkQuerySchema.safeParse(args);
    if (!q.success) return json({ error: "invalid_query", detail: q.error.issues[0]?.message }, true);
    if (await limited()) return json({ error: "rate_limited" }, true);
    await recordCheck(env, "mcp", ip);
    await recordToolCheck(env, q.data);
    return json(await checkTool(env, q.data));
  });

  server.registerTool(
    "forge_scan",
    {
      ...PUBLIC_TOOLS.forge_scan,
      inputSchema: z.object({
        text: z.string().max(SCAN_MAX_BYTES).optional().describe("The full text of the skill file (SKILL.md), tool descriptions or install script"),
        url: z.string().max(2048).optional().describe("Or a public URL: raw.githubusercontent.com, github.com/…/blob/…, gist, gitlab, bitbucket, codeberg, unpkg, jsdelivr"),
        name: z.string().max(80).optional().describe("The skill or tool name, for the result page"),
      }),
      annotations: { title: PUBLIC_TOOLS.forge_scan.title, ...READ_ONLY, openWorldHint: true },
    },
    async ({ text, url, name }) => {
      if (await limited()) return json({ error: "rate_limited" }, true);
      let body = text ?? "", sourceUrl: string | null = null;
      if (!body && url) {
        const got = await fetchSkillText(url);
        if (!got.ok) return json({ error: got.error }, true);
        body = got.text;
        sourceUrl = got.url;
      }
      if (!body) return json({ error: "give text or url" }, true);
      const { result, isPublic } = await scanAndRecord(env, body, { name, sourceUrl });
      await bump(env, scanCounters("mcp", result.verdict)).catch(() => {});
      return json(agentView(result, { isPublic, origin: env.PUBLIC_ORIGIN, sourceUrl }));
    },
  );

  server.registerTool(
    "forge_watch",
    {
      ...PUBLIC_TOOLS.forge_watch,
      inputSchema: z.object({ fingerprints: z.array(z.string().regex(/^(sha256:)?[0-9a-f]{64}$/)).min(1).max(100).describe("sha256 of each installed skill file, as forge_scan returns it") }),
      annotations: { title: PUBLIC_TOOLS.forge_watch.title, ...READ_ONLY },
    },
    async ({ fingerprints }) => {
      if (await limited()) return json({ error: "rate_limited" }, true);
      await bump(env, watchCounters(fingerprints.length)).catch(() => {});
      return json(await watchStatus(getDb(env), fingerprints.map((x) => (x.startsWith("sha256:") ? x : `sha256:${x}`))));
    },
  );

  server.registerTool(
    "forge_traps",
    {
      ...PUBLIC_TOOLS.forge_traps,
      inputSchema: z.object({ task: taskEnum.optional().describe("One Arena task; all tasks if omitted"), model: z.string().max(64).optional().describe("One model id; all models if omitted") }),
      annotations: { title: PUBLIC_TOOLS.forge_traps.title, ...READ_ONLY },
    },
    async ({ task, model }) => {
      if (await limited()) return json({ error: "rate_limited" }, true);
      return json(await trapsData(getDb(env), { task, model }));
    },
  );

  server.registerTool(
    "arena_results",
    { ...PUBLIC_TOOLS.arena_results, inputSchema: z.object({ task: taskEnum.optional().describe("One Arena task; all tasks if omitted") }), annotations: { title: PUBLIC_TOOLS.arena_results.title, ...READ_ONLY } },
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
    { ...GAUNTLET_TOOLS.gauntlet_start, inputSchema: z.object({ card_from: gauntletId.optional() }), annotations: { title: GAUNTLET_TOOLS.gauntlet_start.title, ...GAUNTLET } },
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
      annotations: { title: GAUNTLET_TOOLS.gauntlet_act.title, ...GAUNTLET },
    },
    async ({ gauntlet_id, tool, args }) => {
      const r = await gauntletAct(env, gauntlet_id, tool, args);
      return json(r, "error" in r);
    },
  );

  server.registerTool(
    "gauntlet_status",
    { ...GAUNTLET_TOOLS.gauntlet_status, inputSchema: z.object({ gauntlet_id: gauntletId }), annotations: { title: GAUNTLET_TOOLS.gauntlet_status.title, ...READ_ONLY } },
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
