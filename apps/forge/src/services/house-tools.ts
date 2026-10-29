import { scanSkill, type ScanSeverity, type ScanVerdict } from "@forge/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import * as t from "../db/schema";
import { getDb, newId } from "./db";
import { findTool } from "./forge";
import { canonicalToolId } from "./tools";

// Live tool descriptions (B3-12, ADR 0108). The House tester sends each working server's tools/list (names,
// descriptions and input schemas, capped) after its handshake. The site scans them with the skill scanner's rules
// (tool poisoning, hidden instructions, invisible characters, exfiltration endpoints) and keeps the result on the tool's
// page as a "house-tools" public signal.
//
// Honesty rules: a finding says "matches pattern X in tool Y". It is never called malicious, it never changes a tool's
// security status, and it never sends a notice: notices stay a person's call under the existing OPS-4 gate (at most 3 a
// week). Write volume: a server's row is written only when its descriptions, version or the scanner's rules change.

export const HOUSE_TOOLS_SOURCE = "house-tools";
/** The same caps as integrations/house/file.mjs TOOL_CAPS, enforced again here. */
export const TOOL_CAPS = { servers: 25, tools: 100, name: 128, description: 2_000, schema: 4_000, total: 65_536 } as const;

const toolSchema = z.strictObject({
  name: z.string().min(1).max(TOOL_CAPS.name),
  description: z.string().max(TOOL_CAPS.description),
  schema: z.string().max(TOOL_CAPS.schema).nullable(),
});
const serverSchema = z.strictObject({
  id: z.string().regex(/^(npm|pypi):(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/).max(230),
  version: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9.+_!-]*$/),
  tools: z
    .array(toolSchema)
    .min(1)
    .max(TOOL_CAPS.tools)
    // The per-server total (64 KB of names, descriptions and schemas), counted as file.mjs and probe.mjs count it.
    .refine((tools) => tools.reduce((n, x) => n + x.name.length + x.description.length + (x.schema?.length ?? 0), 0) <= TOOL_CAPS.total, {
      message: `tools over ${TOOL_CAPS.total} characters in total`,
    }),
});
export const toolsBatchSchema = z.strictObject({ servers: z.array(serverSchema).min(1).max(TOOL_CAPS.servers) });
export type HouseToolList = z.infer<typeof serverSchema>;

export interface HouseToolFinding {
  rule: string;
  family: string;
  severity: ScanSeverity;
  title: string;
  /** The tool whose name, description or schema matched. */
  tool: string;
  /** The matched text, invisible characters shown as <U+…>, at most 160 characters. For people, never sent to agents. */
  evidence: string;
  context?: "warning";
}

export interface HouseToolsPayload {
  kind: "house_tool_descriptions";
  registry: "npm" | "pypi";
  version: string;
  tested_at: string;
  fingerprint: string;
  rules_version: string;
  verdict: ScanVerdict;
  counts: Record<ScanSeverity, number>;
  tools_count: number;
  findings: HouseToolFinding[];
  /** What the server listed, as received (capped). Stored for rescans under later rules; shown to people only as text. */
  tools: { name: string; description: string; schema: string | null }[];
}

/** The text the scanner reads: one block per tool, so a finding's line number tells which tool it is in. */
export function toolsText(tools: HouseToolList["tools"]) {
  const lines: string[] = [];
  const owner: string[] = [];
  for (const tool of tools) {
    const block = [`tool: ${tool.name}`, ...tool.description.replace(/\r\n?/g, "\n").split("\n"), ...(tool.schema ? [tool.schema] : []), ""];
    for (const l of block) {
      lines.push(l);
      owner.push(tool.name);
    }
  }
  return { text: lines.join("\n"), toolAtLine: (line: number) => owner[line - 1] ?? owner.at(-1) ?? "" };
}

/** Scans one server's tool list. Pure: the same tools give the same answer. */
export async function scanToolList(s: HouseToolList, now = Date.now()): Promise<HouseToolsPayload> {
  const { text, toolAtLine } = toolsText(s.tools);
  const r = await scanSkill(text);
  return {
    kind: "house_tool_descriptions",
    registry: s.id.startsWith("pypi:") ? "pypi" : "npm",
    version: s.version,
    tested_at: new Date(now).toISOString(),
    fingerprint: r.fingerprint,
    rules_version: r.rules_version,
    verdict: r.verdict,
    counts: r.counts,
    tools_count: s.tools.length,
    findings: r.findings.slice(0, 50).map((f) => ({ rule: f.rule, family: f.family, severity: f.severity, title: f.title, tool: toolAtLine(f.line), evidence: f.evidence, ...(f.context ? { context: f.context } : {}) })),
    tools: s.tools,
  };
}

/**
 * Stores a batch from the House tester. A server with no tool page yet is skipped (its House report creates one; the
 * next run picks it up). Unchanged servers cost one read and no write.
 */
export async function storeToolLists(env: Env, input: unknown, now = Date.now()) {
  const parsed = toolsBatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, detail: parsed.error.issues[0]?.message };
  const db = getDb(env);
  let scanned = 0;
  let unchanged = 0;
  let unknown = 0;
  const flagged: string[] = [];
  for (const s of parsed.data.servers) {
    const tool = await findTool(db, canonicalToolId(s.id));
    if (!tool) {
      unknown++;
      continue;
    }
    const payload = await scanToolList(s, now);
    const [prev] = await db
      .select({ payload: t.publicSignals.payload })
      .from(t.publicSignals)
      .where(and(eq(t.publicSignals.toolId, tool.id), eq(t.publicSignals.source, HOUSE_TOOLS_SOURCE)))
      .limit(1);
    const p = prev?.payload as Partial<HouseToolsPayload> | undefined;
    if (p && p.fingerprint === payload.fingerprint && p.rules_version === payload.rules_version && p.version === payload.version) {
      unchanged++;
      continue;
    }
    await db.batch([
      db.delete(t.publicSignals).where(and(eq(t.publicSignals.toolId, tool.id), eq(t.publicSignals.source, HOUSE_TOOLS_SOURCE))),
      db.insert(t.publicSignals).values({ id: newId(), toolId: tool.id, source: HOUSE_TOOLS_SOURCE, payload, fetchedAt: now }),
    ]);
    scanned++;
    if (payload.verdict !== "clear") flagged.push(tool.canonicalId);
  }
  if (scanned) await caches.default.delete(cacheKey(env)).catch(() => false);
  return { ok: true as const, scanned, unchanged, unknown, pattern_matches: flagged.length };
}

const cacheKey = (env: Env) => new Request(`${env.PUBLIC_ORIGIN}/__internal/house-tools-summary`);

/**
 * The summary and the list of pattern matches, cached for 10 minutes (both read every House-tools row; the House Report
 * is a public page). A stored change clears the cache.
 */
export async function cachedToolScans(env: Env) {
  const key = cacheKey(env);
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) return (await hit.json()) as { summary: Awaited<ReturnType<typeof toolScanSummary>>; matches: Awaited<ReturnType<typeof toolScanMatches>> };
  const value = { summary: await toolScanSummary(env), matches: await toolScanMatches(env, 200) };
  await caches.default.put(key, Response.json(value, { headers: { "Cache-Control": "max-age=600" } })).catch(() => {});
  return value;
}

/**
 * "Tool descriptions scanned": every server whose tools/list the House tester has scanned, with how many tools and the
 * verdict counts. One query over public_signals; nothing is stored for it.
 */
export async function toolScanSummary(env: Env) {
  const db = getDb(env);
  const [row] = await db
    .select({
      servers: sql<number>`count(*)`,
      // "Tool descriptions scanned" counts tools that had a description (review ADR 0115): a tool listed with an empty
      // description had only its name and schema scanned, so it isn't a description.
      tools: sql<number>`coalesce(sum((SELECT count(*) FROM json_each(${t.publicSignals.payload}, '$.tools') j WHERE length(json_extract(j.value, '$.description')) > 0)), 0)`,
      listed: sql<number>`coalesce(sum(json_extract(${t.publicSignals.payload}, '$.tools_count')), 0)`,
      flagged: sql<number>`coalesce(sum(json_extract(${t.publicSignals.payload}, '$.verdict') = 'flagged'), 0)`,
      caution: sql<number>`coalesce(sum(json_extract(${t.publicSignals.payload}, '$.verdict') = 'caution'), 0)`,
      first: sql<number | null>`min(${t.publicSignals.fetchedAt})`,
      last: sql<number | null>`max(${t.publicSignals.fetchedAt})`,
    })
    .from(t.publicSignals)
    .where(eq(t.publicSignals.source, HOUSE_TOOLS_SOURCE));
  const servers = Number(row?.servers ?? 0);
  const flagged = Number(row?.flagged ?? 0);
  const caution = Number(row?.caution ?? 0);
  return {
    servers,
    tools: Number(row?.tools ?? 0),
    tools_listed: Number(row?.listed ?? 0),
    verdicts: { flagged, caution, clear: servers - flagged - caution },
    since: row?.first ? new Date(Number(row.first)).toISOString().slice(0, 10) : null,
    last: row?.last ? new Date(Number(row.last)).toISOString().slice(0, 10) : null,
  };
}

/** Servers whose descriptions matched a high or medium pattern, most matches first (for the House Report page). */
export async function toolScanMatches(env: Env, limit = 100) {
  const rows = await getDb(env)
    .select({ canonicalId: t.tools.canonicalId, payload: t.publicSignals.payload })
    .from(t.publicSignals)
    .innerJoin(t.tools, eq(t.tools.id, t.publicSignals.toolId))
    .where(and(eq(t.publicSignals.source, HOUSE_TOOLS_SOURCE), inArray(sql`json_extract(${t.publicSignals.payload}, '$.verdict')`, ["flagged", "caution"])))
    .orderBy(sql`json_extract(${t.publicSignals.payload}, '$.counts.high') DESC`, sql`json_extract(${t.publicSignals.payload}, '$.counts.medium') DESC`, t.tools.canonicalId)
    .limit(limit);
  return rows.map((r) => {
    const p = r.payload as HouseToolsPayload;
    return { tool: r.canonicalId, version: p.version, verdict: p.verdict, counts: p.counts, rules: [...new Set(p.findings.map((f) => f.rule))], tested_at: p.tested_at };
  });
}
