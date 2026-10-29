import { CANARY, CANARY_GUID } from "@forge/arena";
import { and, eq, gt, ne } from "drizzle-orm";
import { datasetRow, finishedRuns } from "../arena/views";
import * as t from "../db/schema";
import { getDb } from "./db";
import { DATASET_LICENCE, datasetWithProvenance, LICENCE_ID, LICENCE_PATH, provenance } from "./provenance";
import { heldScan } from "./skill-seed";

// AQ-03 (acquisition audit, 28 Oct; ADR 0095): the pseudonymised bulk export a buyer takes delivery of. JSONL and CSV
// of the public Arena runs, readable field reports and public skill scans, with a SHA-256 per file, a manifest and a
// Croissant description. Only in the private data room, never public.
// - People are pseudonymised: owner, agent and report ids become salted hashes (HMAC keyed with EXPORT_PSEUDONYM_KEY, or SESSION_SECRET until it is set; ADR 0098), no GitHub login,
//   handle or email is exported, emails are removed from free text, and members' GitHub logins are removed from what
//   members write (report notes and issues). Tool ids and scan source links stay: they name public tools and repositories, not members.
// - Never in it: embargoed models, private job families, held-out seeds, lab arms, held events (all left out by the
//   same filter as /arena/dataset.json), held scans (the launch-scan hold), held or rejected reports.
// - Stored in Workers KV (already bound, no new cost; R2 isn't bound and enabling it is a billing decision): written
//   once a week by the hourly cron and on demand from /admin/data-room. Files expire after EXPORT_TTL_DAYS.

export const EXPORT_FORMAT = "forge-bulk-export/1";
export const EXPORT_KV_PREFIX = "dataroom:export:";
export const EXPORT_INDEX_KEY = `${EXPORT_KV_PREFIX}index`;
export const EXPORT_TTL_DAYS = 40;
/** Rows per file, at most. */
export const ROWS_PER_FILE = 5000;
/**
 * Bytes per file, at most: a file closes early when the next row would pass this, so every KV value stays far under
 * KV's 25 MiB limit whatever the rows hold (scan findings and run results vary in size).
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Runs are read in pages of this size (past /arena/dataset.json's newest-5,000 cap: the export has every public run). */
const RUN_PAGE = 2000;
/** Past this many rows in one table the export refuses (a Worker holds it in memory); move it to R2 first (AQ-04). */
export const MAX_TABLE_ROWS = 100_000;
const KEEP = 6;

export interface ExportFile {
  name: string;
  table: "runs" | "reports" | "scans" | "metadata";
  format: "jsonl" | "csv" | "json";
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  export_id: string;
  /** ISO week the export belongs to (the weekly export writes one per week). */
  week: string;
  created_at: string;
  trigger: "weekly" | "on_demand";
  exports_pseudonymised: true;
  pseudonymisation: string;
  /** Which secret keys the pseudonyms: the dedicated EXPORT_PSEUDONYM_KEY, or SESSION_SECRET until that is set. */
  pseudonym_key: "dedicated" | "session_secret";
  licence_id: string;
  licence: string;
  licence_url: string;
  canary: string;
  canary_guid: string;
  excluded: string[];
  counts: { runs: number; reports: number; scans: number };
  files: ExportFile[];
  storage: string;
  expires_at: string;
}

export interface ExportIndexEntry {
  export_id: string;
  week: string;
  created_at: string;
  trigger: ExportManifest["trigger"];
  files: number;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (text: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));

/** ISO-8601 week, e.g. 2026-W44. */
export function isoWeek(ms: number) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 4)) / 604_800_000 + ((new Date(Date.UTC(year, 0, 4)).getUTCDay() + 6) % 7) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The key for pseudonyms: a dedicated secret (EXPORT_PSEUDONYM_KEY) when set, so rotating the session secret after an
 * incident doesn't change every pseudonym and a leaked session secret doesn't unmask the exports; SESSION_SECRET until then.
 */
export const pseudonymKey = (env: Env) => (env.EXPORT_PSEUDONYM_KEY ? { secret: env.EXPORT_PSEUDONYM_KEY, kind: "dedicated" as const } : { secret: env.SESSION_SECRET, kind: "session_secret" as const });

export const exportId = (now: number) => `${isoWeek(now)}-${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}`;

/** A salted, stable pseudonym (the same person gets the same one every week while the key is unchanged). */
async function pseudonymiser(secret: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(`forge-export-v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const cache = new Map<string, string>();
  return async (kind: "owner" | "agent" | "report", id: string) => {
    const k = `${kind}:${id}`;
    if (!cache.has(k)) cache.set(k, `${kind}_${hex(await crypto.subtle.sign("HMAC", key, enc.encode(k))).slice(0, 20)}`);
    return cache.get(k)!;
  };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes emails, and the given GitHub logins (whole words), from every string inside a value. */
export function scrubber(logins: string[]) {
  const named = logins.filter((l) => l.length >= 2);
  const re = named.length ? new RegExp(`(?<![A-Za-z0-9-])@?(?:${named.map(escapeRe).join("|")})(?![A-Za-z0-9-])`, "gi") : null;
  const text = (s: string) => {
    let out = s.replace(EMAIL, "[email removed]");
    if (re) out = out.replace(re, "[member removed]");
    return out;
  };
  const deep = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };
  return { text, deep };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows: Record<string, unknown>[]) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

/** The rows, pseudonymised and filtered. Exported for tests. */
export async function exportRows(env: Env, now = Date.now(), runPage = RUN_PAGE) {
  const db = getDb(env);
  const pseud = await pseudonymiser(pseudonymKey(env).secret);
  const logins = (await db.select({ login: t.humans.githubLogin }).from(t.humans)).map((h) => h.login);
  const handles = (await db.select({ handle: t.agents.handle }).from(t.agents)).map((a) => a.handle);
  // Members' logins and agent handles are removed where members write (report notes and issues); emails everywhere.
  const scrub = scrubber([...logins, ...handles]);
  const noEmail = scrubber([]);

  // Runs: exactly the /arena/dataset.json rows (same filter, same mapping, same provenance), nothing about people, but
  // every public run (the page reads only the newest 5,000), read in pages.
  const rawRuns: ReturnType<typeof datasetRow>[] = [];
  for (let offset = 0; ; offset += runPage) {
    const page = await finishedRuns(db, { hard: true, now, limit: runPage, offset });
    rawRuns.push(...page.map(datasetRow));
    if (rawRuns.length > MAX_TABLE_ROWS) throw new Error(`bulk export: more than ${MAX_TABLE_ROWS} runs; move the export to R2 (AQ-04)`);
    if (page.length < runPage) break;
  }
  const runs = datasetWithProvenance({ runs: rawRuns }, env.PUBLIC_ORIGIN).runs as unknown as Record<string, unknown>[];

  // Reports: readable ones (not held, not rejected), as on /stats. Owner, agent and the report's own id (public pages
  // show it next to the agent's handle) become pseudonyms. A note goes out only once moderation approved it, the same
  // rule as every public page (web/queries.ts); pending or unmoderated notes are never shown, so never exported.
  const rep = await db
    .select({ r: t.reports, isHouse: t.humans.isHouse, tool: t.tools.canonicalId, kind: t.tools.kind, version: t.toolVersions.version, fingerprint: t.toolVersions.fingerprint })
    .from(t.reports)
    .innerJoin(t.humans, eq(t.humans.id, t.reports.humanId))
    .innerJoin(t.toolVersions, eq(t.toolVersions.id, t.reports.toolVersionId))
    .innerJoin(t.tools, eq(t.tools.id, t.toolVersions.toolId))
    .where(and(eq(t.reports.held, false), ne(t.reports.moderationState, "rejected")))
    .orderBy(t.reports.createdAt);
  const reports: Record<string, unknown>[] = [];
  for (const { r, isHouse, tool, kind, version, fingerprint } of rep)
    reports.push({
      id: await pseud("report", r.id),
      created_at: new Date(r.createdAt).toISOString(),
      owner: await pseud("owner", r.humanId),
      agent: await pseud("agent", r.agentId),
      house: isHouse,
      tool,
      tool_kind: kind,
      tool_version: version,
      fingerprint,
      task_category: r.taskCategory,
      framework: r.framework,
      outcome: r.outcome,
      issues: scrub.deep(r.issues),
      note: r.note === null || r.moderationState !== "approved" ? null : scrub.text(r.note),
      moderation_state: r.moderationState,
      strain_source: r.strainSource,
      strain_attempts: r.strainAttempts,
      strain_tool_errors: r.strainToolErrors,
      strain_retries: r.strainRetries,
      strain_loop_detected: r.strainLoopDetected,
      strain_context_reset: r.strainContextReset,
      strain_outcome_after_reset: r.strainOutcomeAfterReset,
      strain_escalated: r.strainEscalated,
      provenance: provenance("field_report", r.createdAt),
    });

  // Scans: public rows only, and never a held one (the launch-scan hold), read in pages.
  const scans: Record<string, unknown>[] = [];
  let after = "";
  for (;;) {
    const page = await db.select().from(t.skillScans).where(and(eq(t.skillScans.public, true), gt(t.skillScans.fingerprint, after))).orderBy(t.skillScans.fingerprint).limit(1000);
    for (const s of page) {
      if (heldScan(s.fingerprint, s.sourceUrl, now)) continue;
      scans.push({
        fingerprint: s.fingerprint,
        name: s.name === null ? null : noEmail.text(s.name),
        source_url: s.sourceUrl,
        verdict: s.verdict,
        findings: noEmail.deep(s.findings),
        counts: s.counts,
        rules_version: s.rulesVersion,
        bytes: s.bytes,
        scans: s.scans,
        first_seen: new Date(s.firstSeen).toISOString(),
        last_seen: new Date(s.lastSeen).toISOString(),
        provenance: provenance("scan", s.firstSeen),
      });
    }
    if (scans.length > MAX_TABLE_ROWS) throw new Error(`bulk export: more than ${MAX_TABLE_ROWS} scans; move the export to R2 (AQ-04)`);
    if (page.length < 1000) break;
    after = page[page.length - 1]!.fingerprint;
  }
  if (reports.length > MAX_TABLE_ROWS) throw new Error(`bulk export: more than ${MAX_TABLE_ROWS} reports; move the export to R2 (AQ-04)`);
  return { runs, reports, scans };
}

export const EXCLUDED = [
  "GitHub logins, agent handles and emails (people and report ids are salted pseudonyms; emails, members' logins and agent handles removed from free text)",
  "Report notes not approved by moderation (pending or unmoderated notes are never public, so never exported)",
  "Runs of embargoed models, private job families, held-out seeds, lab arms and held events (the /arena/dataset.json filter)",
  "Held scans (the launch-scan disclosure hold) and unlisted scans",
  "Held and rejected field reports",
  "Run logs (each run row links its public signed log)",
];

/**
 * Splits rows into files of at most `maxRows` rows and `maxBytes` bytes (in both the JSONL and the CSV form, the CSV
 * measured with a margin for its header). One row bigger than the limit on its own fails the export rather than writing
 * a value KV would refuse. Exported for tests.
 */
export function chunkRows(rows: Record<string, unknown>[], maxRows = ROWS_PER_FILE, maxBytes = MAX_FILE_BYTES) {
  const chunks: Record<string, unknown>[][] = [];
  let cur: Record<string, unknown>[] = [];
  let size = 0;
  for (const r of rows) {
    // A CSV row is at most about twice its JSON (quotes doubled); budget for that, with room for the header line.
    const n = 2 * enc.encode(JSON.stringify(r)).length + 1;
    const budget = maxBytes - 65_536;
    if (n > budget) throw new Error(`bulk export: one row is ${n} bytes, over the per-file limit`);
    if (cur.length && (cur.length >= maxRows || size + n > budget)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  chunks.push(cur);
  return chunks;
}

/** Builds every file and the manifest. `sink` receives each file as it is made (writeExport stores it at once). */
export async function buildExport(env: Env, now = Date.now(), trigger: ExportManifest["trigger"] = "on_demand", sink?: (name: string, body: string) => Promise<void>) {
  const { runs, reports, scans } = await exportRows(env, now);
  const week = isoWeek(now);
  const export_id = exportId(now);
  const files = new Map<string, string>();
  const meta: ExportFile[] = [];
  const add = async (name: string, table: ExportFile["table"], format: ExportFile["format"], rows: number, body: string) => {
    const bytes = enc.encode(body).length;
    if (bytes > MAX_FILE_BYTES) throw new Error(`bulk export: ${name} is ${bytes} bytes, over the per-file limit`);
    if (sink) await sink(name, body);
    else files.set(name, body);
    meta.push({ name, table, format, rows, bytes, sha256: await sha256Hex(body) });
  };
  for (const [table, rows] of [["runs", runs], ["reports", reports], ["scans", scans]] as const) {
    const parts = chunkRows(rows);
    for (let i = 0; i < parts.length; i++) {
      const slice = parts[i]!;
      const base = `${table}-${String(i + 1).padStart(4, "0")}`;
      await add(`${base}.jsonl`, table, "jsonl", slice.length, slice.map((r) => JSON.stringify(r)).join("\n") + (slice.length ? "\n" : ""));
      await add(`${base}.csv`, table, "csv", slice.length, slice.length ? toCsv(slice) : "\n");
    }
  }
  // Croissant 1.0 description of the JSONL files, with their checksums (MLCommons; the same format as /arena/croissant.json).
  const croissant = {
    "@context": { "@vocab": "https://schema.org/", cr: "http://mlcommons.org/croissant/", sc: "https://schema.org/" },
    "@type": "sc:Dataset",
    conformsTo: "http://mlcommons.org/croissant/1.0",
    name: `The Agent Forge bulk export ${export_id}`,
    description: `Pseudonymised bulk export (${EXPORT_FORMAT}). ${CANARY}`,
    license: `${env.PUBLIC_ORIGIN}${LICENCE_PATH}`,
    url: `${env.PUBLIC_ORIGIN}/arena/dataset.json`,
    datePublished: new Date(now).toISOString().slice(0, 10),
    distribution: meta.filter((f) => f.format === "jsonl").map((f) => ({ "@type": "cr:FileObject", "@id": f.name, name: f.name, contentUrl: f.name, encodingFormat: "application/jsonlines", sha256: f.sha256 })),
  };
  await add("croissant.json", "metadata", "json", 0, JSON.stringify(croissant, null, 2));
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    export_id,
    week,
    created_at: new Date(now).toISOString(),
    trigger,
    exports_pseudonymised: true,
    pseudonymisation:
      "owner_*, agent_* and report_* are HMAC-SHA256 pseudonyms keyed with a server secret (stable across exports while the key is unchanged); no GitHub login, handle or email is exported. Pseudonymised, not anonymised: field reports are also public on the site with their agent's handle, so a row can be matched to its public page by tool, version and time. Treat the export as personal data under the NDA.",
    pseudonym_key: pseudonymKey(env).kind,
    licence_id: LICENCE_ID,
    licence: DATASET_LICENCE,
    licence_url: `${env.PUBLIC_ORIGIN}${LICENCE_PATH}`,
    canary: CANARY,
    canary_guid: CANARY_GUID,
    excluded: EXCLUDED,
    counts: { runs: runs.length, reports: reports.length, scans: scans.length },
    files: meta,
    storage: "Workers KV (private; R2 is not bound)",
    expires_at: new Date(now + EXPORT_TTL_DAYS * 86_400_000).toISOString(),
  };
  return { manifest, files };
}

const fileKey = (id: string, name: string) => `${EXPORT_KV_PREFIX}${id}:${name}`;
export const SAFE_EXPORT_ID = /^\d{4}-W\d{2}-\d{8}T\d{6}$/;
export const SAFE_FILE = /^(?:(?:runs|reports|scans)-\d{4}\.(?:jsonl|csv)|croissant\.json|manifest\.json)$/;

/** Builds and stores an export in KV, and adds it to the index (newest first, the last KEEP kept). */
export async function writeExport(env: Env, now = Date.now(), trigger: ExportManifest["trigger"] = "on_demand") {
  const opts = { expirationTtl: EXPORT_TTL_DAYS * 86_400 };
  // Each file goes to KV as soon as it is made (not all held at once). The manifest and the index entry are written
  // last, so a failed export leaves no listed or downloadable part (readExportFile needs the manifest).
  const export_id = exportId(now);
  const { manifest } = await buildExport(env, now, trigger, (name, body) => env.KV.put(fileKey(export_id, name), body, opts));
  await env.KV.put(fileKey(manifest.export_id, "manifest.json"), JSON.stringify(manifest, null, 2), opts);
  const index = await exportIndex(env);
  const entry: ExportIndexEntry = { export_id: manifest.export_id, week: manifest.week, created_at: manifest.created_at, trigger, files: manifest.files.length };
  await env.KV.put(EXPORT_INDEX_KEY, JSON.stringify([entry, ...index.filter((x) => x.export_id !== entry.export_id)].slice(0, KEEP)));
  return manifest;
}

export async function exportIndex(env: Env): Promise<ExportIndexEntry[]> {
  return ((await env.KV.get<ExportIndexEntry[]>(EXPORT_INDEX_KEY, "json")) ?? []).filter((x) => Date.parse(x.created_at) > Date.now() - EXPORT_TTL_DAYS * 86_400_000);
}

export async function readManifest(env: Env, id: string): Promise<ExportManifest | null> {
  if (!SAFE_EXPORT_ID.test(id)) return null;
  return env.KV.get<ExportManifest>(fileKey(id, "manifest.json"), "json");
}

/** One stored file, only if the manifest lists it (or it is the manifest). */
export async function readExportFile(env: Env, id: string, name: string) {
  if (!SAFE_EXPORT_ID.test(id) || !SAFE_FILE.test(name)) return null;
  const manifest = await readManifest(env, id);
  if (!manifest) return null;
  if (name !== "manifest.json" && !manifest.files.some((f) => f.name === name)) return null;
  const body = await env.KV.get(fileKey(id, name));
  if (body === null) return null;
  const type = name.endsWith(".csv") ? "text/csv; charset=utf-8" : name.endsWith(".jsonl") ? "application/jsonlines; charset=utf-8" : "application/json; charset=utf-8";
  return { body, type, sha256: manifest.files.find((f) => f.name === name)?.sha256 ?? null };
}

/** Hourly cron: the first run of each ISO week writes that week's export. */
export async function weeklyExport(env: Env, now = Date.now()) {
  const week = isoWeek(now);
  if ((await exportIndex(env)).some((x) => x.week === week && x.trigger === "weekly")) return { written: false, week };
  const m = await writeExport(env, now, "weekly");
  return { written: true, week, export_id: m.export_id, counts: m.counts };
}
