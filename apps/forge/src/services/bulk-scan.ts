import { SCAN_MAX_BYTES, scanSkill, type ScanFamily, type ScanFinding } from "@forge/shared";
import { and, inArray, isNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { internalKey } from "./internal";
import { isLean } from "./ops-mode";
import { heldScan } from "./skill-seed";
import { bump } from "./usage";

// B3-11, every skill scanned (ADR 0107; since ADR 0112 run by the Worker's own hourly cron, services/bulk-scan-cron.ts,
// not GitHub Actions). Every public SKILL.md we can lawfully reach (ClawHub's public read API and public GitHub skill
// repositories) is read as text, never run, and scanned here with the same rules as /scan.
//
// What gets a page: only files with no matched pattern (and not held). A file that matched a pattern is counted in the
// totals and in the rates, but stays unlisted: no page, no Skill Watch entry, no OSV record, no notice. A person
// decides what happens next, through the existing notice process (at most 3 new maintainer notices a week). Nothing
// here ever says "malicious", and nothing is marked Confirmed malicious (Dinike only).

export const BULK_SOURCES = ["clawhub", "github"] as const;
export type BulkSource = (typeof BULK_SOURCES)[number];
export const bulkOrigin = (s: BulkSource) => `bulk:${s}` as const;

/** Per call: few enough files that the CPU time per batch stays small. */
export const BULK_MAX_ITEMS = 20;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The ClawHub file-API link the bulk scan reads, by slug only (ADR 0112). ClawHub's file endpoint doesn't say which
 * publisher's file it returned, and slugs are not unique across publishers (review ADR 0111), so a bulk ClawHub file
 * names no publisher. It is a different link from the owner-qualified one link scans use, so it never changes a
 * publisher's badge or page. No `preview=1`: the raw file, as an agent would install it (capped at the scan limit).
 */
export const clawhubSlugSourceUrl = (slug: string) => `https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}/file?path=SKILL.md`;

/** A raw GitHub link pinned to a commit, encoded like the launch scan's (services/skill-seed.ts seedRow). */
export const githubSourceUrl = (repo: string, commit: string, path: string) =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The source link, rebuilt from its parts so only the exact shapes above pass: a ClawHub skill's SKILL.md, or a file
 * named SKILL.md in a public GitHub repository at a full commit. Returns the canonical link, or null.
 */
export function canonicalSource(source: BulkSource, url: unknown): string | null {
  if (typeof url !== "string" || url.length > 600) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (source === "clawhub") {
    const m = /^\/api\/v1\/skills\/([^/]+)\/file$/.exec(u.pathname);
    let slug = "";
    try {
      slug = m ? decodeURIComponent(m[1]!) : "";
    } catch {
      return null;
    }
    if (u.origin !== "https://clawhub.ai" || !NAME.test(slug)) return null;
    const canon = clawhubSlugSourceUrl(slug);
    return canon === url ? canon : null;
  }
  if (u.origin !== "https://raw.githubusercontent.com" || u.search || u.hash) return null;
  let parts: string[];
  try {
    parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [owner, repo, commit, ...path] = parts;
  if (!owner || !repo || !commit || !NAME.test(owner) || !NAME.test(repo) || !COMMIT.test(commit) || !path.length) return null;
  if (path.some((p) => !p || p === "." || p === ".." || /[\0\\]/.test(p)) || path.at(-1)!.toLowerCase() !== "skill.md") return null;
  const canon = githubSourceUrl(`${owner}/${repo}`, commit, path.join("/"));
  return canon === url ? canon : null;
}

const cleanName = (s: unknown) => (typeof s === "string" ? s.replace(/[^\p{L}\p{N} ._@/:-]/gu, "").trim().slice(0, 80) || null : null);

export type BatchResult =
  | { ok: true; received: number; added: number; already_known: number; rejected: number }
  | { ok: false; reason: "invalid_batch" | "lean"; detail?: string };

/**
 * One batch from the bulk-scan cron: { source, items: [{ text, source_url, name? }] }. Each file is scanned here,
 * stored by fingerprint (never the text), and tagged with its origin. A fingerprint already stored keeps its row; only
 * a missing origin is filled in. The answer is counts only.
 */
export async function ingestBatch(env: Env, body: unknown, now = Date.now()): Promise<BatchResult> {
  const b = body as { source?: unknown; items?: unknown } | null;
  const source = BULK_SOURCES.find((s) => s === b?.source);
  if (!source) return { ok: false, reason: "invalid_batch", detail: "source" };
  if (!Array.isArray(b?.items) || !b.items.length || b.items.length > BULK_MAX_ITEMS) return { ok: false, reason: "invalid_batch", detail: "items" };
  if (await isLean(env)) return { ok: false, reason: "lean" };
  const origin = bulkOrigin(source);
  let rejected = 0;
  const rows = new Map<string, typeof t.skillScans.$inferInsert>();
  for (const it of b.items as { text?: unknown; source_url?: unknown; name?: unknown }[]) {
    const url = canonicalSource(source, it?.source_url);
    const text = it?.text;
    if (!url || typeof text !== "string" || !text.trim() || new TextEncoder().encode(text).length > SCAN_MAX_BYTES) {
      rejected++;
      continue;
    }
    // Rules over text: the file is read, never run.
    const r = await scanSkill(text);
    if (rows.has(r.fingerprint)) continue;
    const held = heldScan(r.fingerprint, url, now);
    rows.set(r.fingerprint, {
      fingerprint: r.fingerprint,
      name: cleanName(it.name),
      sourceUrl: url,
      verdict: r.verdict,
      findings: r.findings,
      counts: r.counts,
      rulesVersion: r.rules_version,
      bytes: r.bytes,
      public: !held && r.verdict === "clear",
      scans: 1,
      firstSeen: now,
      lastSeen: now,
      origin,
    });
  }
  const db = getDb(env);
  const fps = [...rows.keys()];
  const known = fps.length ? await db.select({ fp: t.skillScans.fingerprint, origin: t.skillScans.origin }).from(t.skillScans).where(inArray(t.skillScans.fingerprint, fps)) : [];
  const knownSet = new Set(known.map((k) => k.fp));
  const fresh = fps.filter((fp) => !knownSet.has(fp)).map((fp) => rows.get(fp)!);
  const statements = [];
  // 14 columns × 7 rows stays under D1's 100 bound parameters; one batch is one round trip.
  for (let i = 0; i < fresh.length; i += 7) statements.push(db.insert(t.skillScans).values(fresh.slice(i, i + 7)).onConflictDoNothing());
  const unlabelled = known.filter((k) => k.origin === null).map((k) => k.fp);
  if (unlabelled.length) statements.push(db.update(t.skillScans).set({ origin }).where(and(inArray(t.skillScans.fingerprint, unlabelled), isNull(t.skillScans.origin))));
  if (statements.length) await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  // Our own scans, counted apart from outside use (ADR 0067): one upsert per batch.
  if (rows.size) await bump(env, Array(rows.size).fill(internalKey("bulk", "scans")), now);
  return { ok: true, received: (b.items as unknown[]).length, added: fresh.length, already_known: known.length, rejected };
}

// --- Aggregate rates (the public numbers) ----------------------------------------------------------------------------

/** Rates appear once the bulk scan has at least this many files; per source, the same minimum per source. */
export const BULK_RATE_MINIMUM = 100;
const SUMMARY_KEY = "bulk-scan:summary:v1";
const SUMMARY_TTL_S = 3600;

export const FAMILY_WORDS: Record<ScanFamily, string> = {
  exec: "Runs downloaded code",
  secrets: "Reads keys or credentials",
  exfil: "Sends data out",
  hidden: "Hidden text",
  injection: "Instructions that override the agent's",
  persistence: "Changes the agent's standing files",
  remote: "Fetches remote instructions",
  money: "Moves money",
  destructive: "Deletes or overwrites",
  obfuscation: "Obfuscated commands",
  permissions: "Turns off permission prompts",
  impersonation: "Publisher look-alike name",
};

export const SOURCE_WORDS: Record<BulkSource, string> = { clawhub: "ClawHub (public read API; by skill name, publisher not named)", github: "Public GitHub skill repositories" };

export interface BulkSummary {
  as_of: string;
  files: number;
  high_pattern: number;
  medium_pattern_only: number;
  no_pattern: number;
  high_rate: number;
  medium_rate: number;
  sources: { source: BulkSource; label: string; files: number; high_pattern: number; medium_pattern_only: number; high_rate: number; medium_rate: number }[];
  families: { family: ScanFamily; label: string; files_high: number; files_medium: number; high_rate: number }[];
  minimum: number;
}

const rate = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : 0);

/** The rates from skill_scans rows with a bulk origin. Pure SQL counts: reproducible from the counting rule. */
export async function computeBulkSummary(env: Env, now = Date.now()): Promise<BulkSummary | null> {
  const db = getDb(env);
  const byVerdict = await db
    .select({ origin: t.skillScans.origin, verdict: t.skillScans.verdict, n: sql<number>`count(*)` })
    .from(t.skillScans)
    .where(sql`${t.skillScans.origin} like 'bulk:%'`)
    .groupBy(t.skillScans.origin, t.skillScans.verdict);
  const files = byVerdict.reduce((a, r) => a + Number(r.n), 0);
  if (files < BULK_RATE_MINIMUM) return null;
  const fam = await db.all<{ fam: string; sev: string; n: number }>(
    sql`select json_extract(f.value, '$.family') as fam, json_extract(f.value, '$.severity') as sev, count(distinct s.fingerprint) as n from skill_scans s, json_each(s.findings) f where s.origin like 'bulk:%' and s.verdict != 'clear' and json_extract(f.value, '$.severity') in ('high', 'medium') group by fam, sev`,
  );
  const count = (o: string | null, v: string) => Number(byVerdict.find((r) => r.origin === o && r.verdict === v)?.n ?? 0);
  const sum = (v: string) => BULK_SOURCES.reduce((a, s) => a + count(bulkOrigin(s), v), 0);
  const high = sum("flagged");
  const medium = sum("caution");
  const sources = BULK_SOURCES.map((s) => {
    const o = bulkOrigin(s);
    const n = count(o, "flagged") + count(o, "caution") + count(o, "clear");
    return { source: s, label: SOURCE_WORDS[s], files: n, high_pattern: count(o, "flagged"), medium_pattern_only: count(o, "caution"), high_rate: rate(count(o, "flagged"), n), medium_rate: rate(count(o, "caution"), n) };
  }).filter((s) => s.files >= BULK_RATE_MINIMUM);
  const families = (Object.keys(FAMILY_WORDS) as ScanFamily[])
    .map((f) => {
      const h = Number(fam.find((r) => r.fam === f && r.sev === "high")?.n ?? 0);
      const m = Number(fam.find((r) => r.fam === f && r.sev === "medium")?.n ?? 0);
      return { family: f, label: FAMILY_WORDS[f], files_high: h, files_medium: m, high_rate: rate(h, files) };
    })
    .filter((f) => f.files_high + f.files_medium > 0)
    .sort((a, b) => b.files_high - a.files_high || b.files_medium - a.files_medium);
  return {
    as_of: new Date(now).toISOString(),
    files,
    high_pattern: high,
    medium_pattern_only: medium,
    no_pattern: sum("clear"),
    high_rate: rate(high, files),
    medium_rate: rate(medium, files),
    sources,
    families,
    minimum: BULK_RATE_MINIMUM,
  };
}

/** The summary, cached for an hour in KV (one write an hour at most). Null until the minimum is reached. */
export async function bulkSummary(env: Env, now = Date.now()): Promise<BulkSummary | null> {
  try {
    const hit = await env.KV.get(SUMMARY_KEY);
    if (hit) return (JSON.parse(hit) as { s: BulkSummary | null }).s;
  } catch {
    /* recompute */
  }
  const s = await computeBulkSummary(env, now).catch(() => null);
  await env.KV.put(SUMMARY_KEY, JSON.stringify({ s }), { expirationTtl: SUMMARY_TTL_S }).catch(() => {});
  return s;
}

/** Percent with one decimal, for pages. */
export const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

/** Families present in a row's findings at high or medium severity (tests and counting checks). */
export const familiesOf = (findings: ScanFinding[]) => [...new Set(findings.filter((f) => f.severity !== "low").map((f) => f.family))];

