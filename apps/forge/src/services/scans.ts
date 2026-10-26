import { SCAN_MAX_BYTES, SCAN_RULES_VERSION, scanSkill, type ScanFinding, type ScanResult } from "@forge/shared";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb, type Db } from "./db";
import { isLean } from "./ops-mode";
import { heldScan } from "./skill-seed";

// Skill scans (ADR 0026). Scanning is free (no model, no paid API): rules over text. Fetching by URL is limited to
// public code hosts, so the Worker can't be used as a general fetch proxy. Results are stored by fingerprint, never
// the text; a repeat of the same fingerprint only bumps its count, at most once an hour, to keep writes low (ADR 0027).

/** Public code hosts the scanner will fetch from. Anything else: paste the text instead. */
export const SCAN_HOSTS = ["raw.githubusercontent.com", "gist.githubusercontent.com", "gitlab.com", "bitbucket.org", "unpkg.com", "cdn.jsdelivr.net", "codeberg.org"];
const FETCH_TIMEOUT_MS = 5_000;
const BUMP_EVERY_MS = 3_600_000;

/** github.com/owner/repo/blob/ref/path and tree-less shorthand become raw URLs; other hosts are used as given. */
export function rawUrl(input: string): URL | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    const path = u.pathname.replace(/\/+$/, "");
    // A file (blob or raw link), a skill folder (tree link: its SKILL.md), or a repository (its root SKILL.md).
    const file = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/.exec(path);
    if (file) return new URL(`https://raw.githubusercontent.com/${file[1]}/${file[2]}/${file[3]}/${file[4]}`);
    const dir = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (dir) return new URL(`https://raw.githubusercontent.com/${dir[1]}/${dir[2]}/${dir[3]}/${dir[4] ? `${dir[4]}/` : ""}SKILL.md`);
    const repo = /^\/([^/]+)\/([^/.][^/]*)$/.exec(path);
    if (repo) return new URL(`https://raw.githubusercontent.com/${repo[1]}/${repo[2]!.replace(/\.git$/, "")}/HEAD/SKILL.md`);
    return null;
  }
  if (u.hostname === "clawhub.ai" || u.hostname === "www.clawhub.ai") return clawhubFileUrl(u);
  if (u.hostname === "gist.github.com") return null;
  return SCAN_HOSTS.includes(u.hostname) ? u : null;
}

// ClawHub (OpenClaw's skill registry). Its public read API invites third-party use ("Public catalog reuse" in
// github.com/openclaw/clawhub docs/api.md): no token, rate-limited, link back to the canonical skill page, no implied
// endorsement. Skills there are MIT-0. A skill page link becomes one fetch of its SKILL.md as text.
const CLAWHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** clawhub.ai/<owner>/skills/<slug> (or the file API URL itself) → the API URL for that skill's SKILL.md as text. */
function clawhubFileUrl(u: URL): URL | null {
  let owner: string | undefined;
  let slug: string | undefined;
  const page = /^\/([^/]+)\/skills\/([^/]+)(?:\/.*)?$/.exec(u.pathname.replace(/\/+$/, ""));
  const api = /^\/api\/v1\/skills\/([^/]+)\/file$/.exec(u.pathname);
  if (api) [slug, owner] = [api[1], u.searchParams.get("ownerHandle") ?? undefined];
  else if (page) [owner, slug] = [page[1], page[2]];
  if (!owner || !slug) return null;
  owner = decodeURIComponent(owner).replace(/^@/, "");
  slug = decodeURIComponent(slug);
  if (!CLAWHUB_NAME.test(owner) || !CLAWHUB_NAME.test(slug)) return null;
  return new URL(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}/file?path=SKILL.md&ownerHandle=${encodeURIComponent(owner)}&preview=1`);
}

/** For a ClawHub file API URL, the skill's own page and its ClawHub security audit; null for other sources. */
export function clawhubPage(sourceUrl: string | null): { page: string; audit: string; owner: string; slug: string } | null {
  if (!sourceUrl?.startsWith("https://clawhub.ai/api/v1/skills/")) return null;
  const u = new URL(sourceUrl);
  const slug = decodeURIComponent(/^\/api\/v1\/skills\/([^/]+)\/file$/.exec(u.pathname)?.[1] ?? "");
  const owner = u.searchParams.get("ownerHandle") ?? "";
  if (!slug || !owner) return null;
  const page = `https://clawhub.ai/${encodeURIComponent(owner)}/skills/${encodeURIComponent(slug)}`;
  return { page, audit: `${page}/security-audit`, owner, slug };
}

export type FetchedText = { ok: true; text: string; url: string } | { ok: false; error: "unsupported_url" | "not_found" | "fetch_failed" | "too_large" | "not_text" };

export async function fetchSkillText(input: string, fetcher: typeof fetch = fetch): Promise<FetchedText> {
  const u = rawUrl(input);
  if (!u) return { ok: false, error: "unsupported_url" };
  let res: Response;
  try {
    res = await fetcher(u.toString(), { headers: { "User-Agent": "theagentforge-scan/1 (+https://theagentforge.io/scan)", Accept: "text/plain, text/markdown, */*" }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
  } catch {
    return { ok: false, error: "fetch_failed" };
  }
  // ClawHub answers 404 for a missing file, 409 when a slug is ambiguous, 415 when the file isn't text.
  if (res.status === 404 || res.status === 409) return { ok: false, error: "not_found" };
  if (res.status === 415) return { ok: false, error: "not_text" };
  if (!res.ok) return { ok: false, error: "fetch_failed" };
  const type = res.headers.get("content-type") ?? "";
  if (/^(image|audio|video|application\/(zip|octet-stream|pdf))/.test(type)) return { ok: false, error: "not_text" };
  if (Number(res.headers.get("content-length") ?? 0) > SCAN_MAX_BYTES) return { ok: false, error: "too_large" };
  const buf = await res.arrayBuffer();
  if (buf.byteLength > SCAN_MAX_BYTES) return { ok: false, error: "too_large" };
  return { ok: true, text: new TextDecoder().decode(buf), url: u.toString() };
}

const cleanName = (s: unknown) => (typeof s === "string" ? s.replace(/[^\p{L}\p{N} ._@/:-]/gu, "").trim().slice(0, 80) || null : null);

/**
 * Scans and records. `sourceUrl` set means it came from a public URL, so its page is public, except a file held during
 * the launch-scan disclosure window (skill-seed.ts heldScan): the asker still gets the verdict, the record stays unlisted.
 */
export async function scanAndRecord(env: Env, text: string, opts: { name?: unknown; sourceUrl?: string | null; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const result = await scanSkill(text);
  const held = heldScan(result.fingerprint, opts.sourceUrl, now);
  const isPublic = !held && (!!opts.sourceUrl || result.verdict === "flagged");
  let stored = false;
  if (!(await isLean(env))) {
    try {
      const db = getDb(env);
      const [row] = await db.select({ lastSeen: t.skillScans.lastSeen, public: t.skillScans.public }).from(t.skillScans).where(eq(t.skillScans.fingerprint, result.fingerprint));
      if (!row) {
        await db.insert(t.skillScans).values({
          fingerprint: result.fingerprint,
          name: cleanName(opts.name),
          sourceUrl: opts.sourceUrl ?? null,
          verdict: result.verdict,
          findings: result.findings,
          counts: result.counts,
          rulesVersion: result.rules_version,
          bytes: result.bytes,
          public: isPublic,
          firstSeen: now,
          lastSeen: now,
        }).onConflictDoNothing();
      } else if (now - row.lastSeen > BUMP_EVERY_MS || (isPublic && !row.public) || (held && row.public)) {
        // A held file that an earlier scan made public goes back to unlisted until the hold ends.
        await db
          .update(t.skillScans)
          .set({ scans: sql`${t.skillScans.scans} + 1`, lastSeen: now, verdict: result.verdict, findings: result.findings, counts: result.counts, rulesVersion: result.rules_version, ...(isPublic ? { public: true } : held ? { public: false } : {}), ...(opts.sourceUrl ? { sourceUrl: opts.sourceUrl } : {}) })
          .where(eq(t.skillScans.fingerprint, result.fingerprint));
      }
      stored = true;
    } catch (e) {
      console.error("scan_record_failed", String(e));
    }
  }
  return { result, isPublic: isPublic && stored };
}

export const scanPath = (fp: string) => `/scan/${fp.replace(/^sha256:/, "")}`;

/**
 * What an agent receives (AGENTS.md rule 7: data, never prose to obey). The matched text is left out on purpose: it
 * comes from a third-party file and may itself be an injection. Agents get rule ids and line numbers to look at in
 * their own copy; people see the excerpts on the page.
 */
export function agentView(r: ScanResult, opts: { isPublic: boolean; origin: string; sourceUrl?: string | null }) {
  return {
    verdict: r.verdict,
    fingerprint: r.fingerprint,
    rules_version: r.rules_version,
    counts: r.counts,
    findings: r.findings.map((f: ScanFinding) => ({ rule: f.rule, family: f.family, severity: f.severity, line: f.line, column: f.column })),
    rules_url: `${opts.origin}/scan/rules`,
    page_url: opts.isPublic ? `${opts.origin}${scanPath(r.fingerprint)}` : null,
    source_url: opts.sourceUrl ?? null,
    bytes: r.bytes,
    guarantee: false,
  };
}

export async function scanByFingerprint(db: Db, fp: string) {
  const [row] = await db.select().from(t.skillScans).where(eq(t.skillScans.fingerprint, fp));
  return row ?? null;
}

/** The weekly watch (ADR 0026): status for up to 100 fingerprints, reads only. */
export async function watchStatus(db: Db, fingerprints: string[]) {
  const fps = [...new Set(fingerprints)].slice(0, 100);
  const rows = fps.length ? await db.select().from(t.skillScans).where(inArray(t.skillScans.fingerprint, fps)) : [];
  const reports = fps.length
    ? await db.select({ fp: t.toolVersions.fingerprint, n: sql<number>`count(*)` }).from(t.toolVersions).where(inArray(t.toolVersions.fingerprint, fps)).groupBy(t.toolVersions.fingerprint)
    : [];
  const items = fps.map((fp) => {
    const r = rows.find((x) => x.fingerprint === fp);
    return {
      fingerprint: fp,
      known: !!r,
      verdict: r?.verdict ?? null,
      counts: r?.counts ?? null,
      rules_version: r?.rulesVersion ?? null,
      rescan_needed: !r || r.rulesVersion !== SCAN_RULES_VERSION,
      scanned_at: r ? new Date(r.lastSeen).toISOString() : null,
      versions_with_reports: Number(reports.find((x) => x.fp === fp)?.n ?? 0),
    };
  });
  return {
    rules_version: SCAN_RULES_VERSION,
    checked: items.length,
    flagged: items.filter((i) => i.verdict === "flagged").length,
    caution: items.filter((i) => i.verdict === "caution").length,
    unknown: items.filter((i) => !i.known).length,
    rescan_needed: items.filter((i) => i.rescan_needed).length,
    items,
    // ADR 0056: a fresh scan of each public file whose scan is out of date, as a ready-to-send call (data only).
    ...(() => {
      const related = rows
        .filter((r) => r.public && r.sourceUrl && r.rulesVersion !== SCAN_RULES_VERSION)
        .slice(0, 5)
        .map((r) => ({ relation: "rescan" as const, tool: "forge_scan" as const, arguments: { url: r.sourceUrl! } }));
      return related.length ? { related } : {};
    })(),
  };
}

/** Skill Watch numbers (honest counts; ADR 0023 minimums apply on the page). */
export async function scanStats(db: Db, now = Date.now()) {
  const [all] = await db.select({ n: sql<number>`count(*)`, scans: sql<number>`coalesce(sum(${t.skillScans.scans}), 0)` }).from(t.skillScans);
  const by = await db.select({ v: t.skillScans.verdict, n: sql<number>`count(*)` }).from(t.skillScans).groupBy(t.skillScans.verdict);
  const week = await db.select({ n: sql<number>`count(*)` }).from(t.skillScans).where(gte(t.skillScans.firstSeen, now - 7 * 86_400_000));
  return {
    unique: Number(all?.n ?? 0),
    scans: Number(all?.scans ?? 0),
    flagged: Number(by.find((x) => x.v === "flagged")?.n ?? 0),
    caution: Number(by.find((x) => x.v === "caution")?.n ?? 0),
    clear: Number(by.find((x) => x.v === "clear")?.n ?? 0),
    new_this_week: Number(week[0]?.n ?? 0),
  };
}

export async function latestBySource(db: Db, url: string) {
  const [row] = await db.select().from(t.skillScans).where(and(eq(t.skillScans.sourceUrl, url), eq(t.skillScans.public, true))).orderBy(desc(t.skillScans.lastSeen)).limit(1);
  return row ?? null;
}

export async function recentPublic(db: Db, verdicts: ("flagged" | "caution")[], limit = 50) {
  return db
    .select()
    .from(t.skillScans)
    .where(and(eq(t.skillScans.public, true), inArray(t.skillScans.verdict, verdicts)))
    .orderBy(desc(t.skillScans.lastSeen))
    .limit(limit);
}

/** How often each rule fires across public flagged and caution scans (for the weekly report). */
export function ruleFrequency(rows: { findings: unknown }[]) {
  const counts = new Map<string, number>();
  for (const r of rows) for (const id of new Set((r.findings as ScanFinding[]).map((f) => f.rule))) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** A readable name for a scanned file: "libafl · trailofbits/skills" for a GitHub raw link, else the name or host. */
export function skillLabel(sourceUrl: string | null, name?: string | null): { title: string; where: string | null } {
  const claw = clawhubPage(sourceUrl);
  if (claw) return { title: claw.slug, where: `ClawHub · ${claw.owner}` };
  if (sourceUrl) {
    try {
      const u = new URL(sourceUrl);
      const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const gh = u.hostname === "raw.githubusercontent.com" && parts.length >= 4;
      const file = parts.at(-1) ?? "";
      const folder = /^skill\.md$/i.test(file) && parts.length > (gh ? 4 : 1) ? parts.at(-2)! : file;
      return { title: folder || u.hostname, where: gh ? `${parts[0]}/${parts[1]}` : u.hostname };
    } catch {
      /* fall through */
    }
  }
  return { title: name || "Pasted skill", where: null };
}
