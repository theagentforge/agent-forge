import { SCAN_RULES, type ScanFinding, type ScanSeverity } from "@forge/shared";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { isLean } from "./ops-mode";
import heldFile from "../seed/skill-scan-held.json";

// The launch scan (ADR 0026): every SKILL.md in 277 public GitHub repositories, scanned on 19 Oct 2026 with the same
// rules the site runs, published as a dataset at /data/skill-scan-2026-10-19.json and loaded into skill_scans a slice
// at a time by the hourly cron, so each result gets its page and badge. No model, no GitHub calls from the Worker.

export const SEED_PATH = "/data/skill-scan-2026-10-19.json";
// v2: the held rows moved out of the public file on 19 Oct, so the order changed; reloading what's there is a no-op.
const CURSOR_KEY = "seed:skill-scan-2026-10-19:v2";
export const SEEDED_AT = Date.UTC(2026, 9, 19, 12);
/**
 * Disclosure (report v1.1, 19 Oct): flagged and caution results stay unlisted until maintainers have heard from us,
 * except the four vendors' official installers, which the report names. They go public on NOTICE_ENDS. Until then
 * their rows aren't in the public dataset either: they're bundled from src/seed/skill-scan-held.json (an empty stub
 * in the public mirror).
 */
export const NAMED_AT_LAUNCH = new Set(["google/skills", "NVIDIA/skills", "anthropics/claude-agent-sdk-python", "trailofbits/skills"]);
export const NOTICE_ENDS = Date.UTC(2026, 10, 2);
const SEV: Record<string, ScanSeverity> = { h: "high", m: "medium", l: "low" };
const PER_STATEMENT = 8; // 12 columns × 8 rows stays under D1's 100 bound parameters

export interface SeedFile {
  meta: { rules_version: string; files: number };
  repos: [string, string][];
  rows: [number, string, string, number, number, ([string, string, number, number, string] | [string, string, number, number, string, number])[]?][];
}

export function seedRow(file: SeedFile, row: SeedFile["rows"][number]) {
  const [repoIdx, path, hex, bytes, , raw = []] = row;
  const [repo, commit] = file.repos[repoIdx]!;
  const findings: ScanFinding[] = raw.map((f) => {
    const rule = SCAN_RULES.find((x) => x.id === f[0]);
    return { rule: f[0], family: rule?.family ?? "exec", severity: SEV[f[1]] ?? "low", title: rule?.title ?? f[0], why: rule?.why ?? "", line: f[2], column: f[3], evidence: f[4], ...(f[5] ? { context: "warning" as const } : {}) };
  });
  const counts = { high: 0, medium: 0, low: 0 } as Record<ScanSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  return {
    fingerprint: `sha256:${hex}`,
    name: `${repo}/${path}`.slice(0, 80),
    sourceUrl: `https://raw.githubusercontent.com/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
    verdict: (counts.high ? "flagged" : counts.medium ? "caution" : "clear") as "flagged" | "caution" | "clear",
    findings,
    counts,
    rulesVersion: file.meta.rules_version,
    bytes,
    public: counts.high + counts.medium === 0 || NAMED_AT_LAUNCH.has(repo),
    scans: 1,
    firstSeen: SEEDED_AT,
    lastSeen: SEEDED_AT,
  };
}

/** Loads the next `limit` rows of the launch scan. Returns how far it got; does nothing once done or in lean mode. */
export async function importSkillSeed(env: Env, limit = 1500) {
  if (await isLean(env)) return { skipped: "lean" };
  const at = Number((await env.KV.get(CURSOR_KEY)) ?? 0);
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${SEED_PATH}`));
  if (!res.ok) return { error: `seed file ${res.status}` };
  const file = (await res.json()) as SeedFile;
  const held = heldFile as unknown as SeedFile;
  const all = [...file.rows.map((r) => [file, r] as const), ...held.rows.map((r) => [held, r] as const)];
  if (at >= all.length) return { done: true, total: all.length };
  const slice = all.slice(at, at + limit).map(([f, r]) => seedRow(f, r));
  const db = getDb(env);
  const statements = [];
  for (let i = 0; i < slice.length; i += PER_STATEMENT) statements.push(db.insert(t.skillScans).values(slice.slice(i, i + PER_STATEMENT)).onConflictDoNothing());
  if (statements.length) await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
  const next = at + slice.length;
  await env.KV.put(CURSOR_KEY, String(next));
  return { loaded: slice.length, next, total: all.length };
}

// --- The hold on scans of held files (26 Oct) ------------------------------------------------------------------------
// Anyone can scan a held file themselves, by link or by pasting it. They get the verdict (they have the file anyway),
// but until NOTICE_ENDS the stored result stays unlisted: no page, sitemap entry, receipt link, "Same repository" line,
// dataset row or MCP output beyond that answer. A scan matches a held entry by fingerprint, or by its GitHub source
// (same repository and path at any ref, raw or jsDelivr link: githubFile), so an edited copy stays held too.
// After NOTICE_ENDS the hold ends by itself: new scans are public as usual, and releaseHeldScans (hourly cron) lists the
// rows scans created during the hold. Seed rows (first_seen = SEEDED_AT) are left to the 2 Nov publication task, which
// checks for maintainer requests first. That task removes this block with the held file and the held import: the
// checklist is docs/runbooks/disclosure-window-end.md.

type HeldIndex = { fps: Set<string>; paths: Map<string, Set<string>> };
let heldIndex: HeldIndex | null = null;
let heldSource: SeedFile = heldFile as unknown as SeedFile;

function buildHeldIndex(file: SeedFile): HeldIndex {
  const fps = new Set<string>();
  const paths = new Map<string, Set<string>>();
  for (const [repoIdx, path, hex] of file.rows) {
    fps.add(`sha256:${hex}`);
    const repo = file.repos[repoIdx]?.[0]?.toLowerCase();
    if (!repo) continue;
    if (!paths.has(repo)) paths.set(repo, new Set());
    paths.get(repo)!.add(path);
  }
  return { fps, paths };
}

/** Tests only: swap the held list (null restores the bundled file). */
export function useHeldFile(file: SeedFile | null) {
  heldSource = file ?? (heldFile as unknown as SeedFile);
  heldIndex = null;
}

/**
 * A GitHub file link the scanner fetches, as its repository ("owner/repo", lower case) and path segments, with the
 * indexes where the in-repository path may start (after the ref). raw.githubusercontent.com/owner/repo/<ref>/path
 * (github.com blob, raw and tree links arrive in this form), with refs/heads|tags/<name> or a ref that itself has
 * slashes (feature/x); and cdn.jsdelivr.net/gh/owner/repo[@ref]/path, which serves the same files.
 */
function githubFile(sourceUrl: string): { repo: string; parts: string[]; starts: number[]; exact: number[] } | null {
  let u: URL;
  let parts: string[];
  try {
    u = new URL(sourceUrl);
    parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (u.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    // Every split after the ref is a candidate: a ref can contain slashes, and GitHub serves those links.
    const starts = Array.from({ length: parts.length - 3 }, (_, k) => 3 + k);
    const exact = parts[2] === "refs" && (parts[3] === "heads" || parts[3] === "tags") ? [5] : [3];
    return { repo: `${parts[0]}/${parts[1]}`.toLowerCase(), parts, starts, exact };
  }
  if (u.hostname === "cdn.jsdelivr.net" && parts[0] === "gh" && parts.length >= 4) {
    return { repo: `${parts[1]}/${parts[2]!.split("@")[0]}`.toLowerCase(), parts, starts: [3], exact: [3] };
  }
  return null;
}

/** Whether a scan's fingerprint or source URL matches a held entry (regardless of date). */
export function matchesHeld(fingerprint: string, sourceUrl: string | null | undefined) {
  heldIndex ??= buildHeldIndex(heldSource);
  if (heldIndex.fps.has(fingerprint)) return true;
  const f = sourceUrl ? githubFile(sourceUrl) : null;
  const held = f && heldIndex.paths.get(f.repo);
  if (!f || !held) return false;
  // The plain split (owner/repo/<ref>/path, or after refs/heads|tags/<name>) always counts. Any other split (a ref with
  // slashes) counts only for a held path with a folder, so a held root SKILL.md doesn't hold every SKILL.md in the repo.
  return f.starts.some((i) => {
    const path = f.parts.slice(i).join("/");
    return held.has(path) && (f.exact.includes(i) || path.includes("/"));
  });
}

/** True while the hold is on and the scan matches a held entry: its stored result must stay unlisted. */
export const heldScan = (fingerprint: string, sourceUrl: string | null | undefined, now = Date.now()) => now < NOTICE_ENDS && matchesHeld(fingerprint, sourceUrl);

const RELEASED_KEY = "seed:skill-scan-held:released";
const UNLISTED_KEY = "seed:skill-scan-held:unlisted";

/**
 * Before NOTICE_ENDS (hourly cron, once after this code is deployed): unlists the rows that scans made public before
 * the hold existed (19 to 26 Oct, when any link scan was public), so a held file isn't on the site until a new scan of
 * it happens to come along. Every row matching a held fingerprint, and every public link-scan row (not a seed row)
 * whose GitHub source matches a held repository path. Later scans are held by scanAndRecord itself.
 */
async function unlistHeldScans(env: Env, now: number) {
  if (await env.KV.get(UNLISTED_KEY)) return { skipped: "held", unlisted_done: true };
  heldIndex ??= buildHeldIndex(heldSource);
  const db = getDb(env);
  const fps = new Set<string>();
  const held = [...heldIndex.fps];
  for (let i = 0; i < held.length; i += 90) {
    const rows = await db.select({ fp: t.skillScans.fingerprint }).from(t.skillScans).where(and(eq(t.skillScans.public, true), inArray(t.skillScans.fingerprint, held.slice(i, i + 90))));
    for (const r of rows) fps.add(r.fp);
  }
  // Public link scans made by people (seed rows are the launch scan's own, and a held one matches by fingerprint above).
  const linked = await db
    .select({ fp: t.skillScans.fingerprint, src: t.skillScans.sourceUrl })
    .from(t.skillScans)
    .where(and(eq(t.skillScans.public, true), ne(t.skillScans.firstSeen, SEEDED_AT), isNotNull(t.skillScans.sourceUrl)));
  for (const r of linked) if (matchesHeld(r.fp, r.src)) fps.add(r.fp);
  const list = [...fps];
  for (let i = 0; i < list.length; i += 90) await db.update(t.skillScans).set({ public: false }).where(inArray(t.skillScans.fingerprint, list.slice(i, i + 90)));
  await env.KV.put(UNLISTED_KEY, String(now));
  return { skipped: "held", unlisted: list.length };
}

/**
 * After NOTICE_ENDS (hourly cron, once): lists the rows that scans created while the hold was on. They are the rows
 * that match a held entry, aren't seed rows, and are unlisted; URL scans and held files are public after the hold.
 * Before NOTICE_ENDS it runs unlistHeldScans (once) instead.
 */
export async function releaseHeldScans(env: Env, now = Date.now()) {
  if (now < NOTICE_ENDS) return unlistHeldScans(env, now);
  if (await env.KV.get(RELEASED_KEY)) return { done: true };
  heldIndex ??= buildHeldIndex(heldSource);
  const db = getDb(env);
  const fps = new Set<string>();
  // A bulk-scan row (ADR 0107) that matched a pattern stays unlisted after the hold too: only a person lists those.
  const notSeed = and(eq(t.skillScans.public, false), ne(t.skillScans.firstSeen, SEEDED_AT), or(isNull(t.skillScans.origin), eq(t.skillScans.verdict, "clear")));
  const held = [...heldIndex.fps];
  for (let i = 0; i < held.length; i += 90) {
    const rows = await db.select({ fp: t.skillScans.fingerprint }).from(t.skillScans).where(and(notSeed, inArray(t.skillScans.fingerprint, held.slice(i, i + 90))));
    for (const r of rows) fps.add(r.fp);
  }
  // Only held scans leave a URL-sourced row unlisted, so this set is small.
  const linked = await db.select({ fp: t.skillScans.fingerprint, src: t.skillScans.sourceUrl }).from(t.skillScans).where(and(notSeed, isNotNull(t.skillScans.sourceUrl)));
  for (const r of linked) if (matchesHeld(r.fp, r.src)) fps.add(r.fp);
  const list = [...fps];
  for (let i = 0; i < list.length; i += 90) await db.update(t.skillScans).set({ public: true }).where(inArray(t.skillScans.fingerprint, list.slice(i, i + 90)));
  await env.KV.put(RELEASED_KEY, String(now));
  return { released: list.length };
}
