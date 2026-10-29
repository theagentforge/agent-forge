import { SCAN_MAX_BYTES } from "@forge/shared";
import { clawhubSlugSourceUrl, githubSourceUrl, ingestBatch, type BulkSource } from "./bulk-scan";
import { isLean } from "./ops-mode";
import { SEED_PATH } from "./skill-seed";
import { TarReader } from "./tar";

// B3-11, every public skill scanned, run by the Worker's own hourly cron (ADR 0112, amending ADR 0107). Until 29 Oct
// it ran in the public mirror's GitHub Actions; GitHub's Actions terms forbid work "unrelated to the software project",
// and enforcement can reach the whole organisation, so Dinike moved it here ("Run it on Cloudflare").
//
// Each hourly run does a small slice (at most MAX_FILES_PER_RUN files, at most RUN_WALL_MS of wall time), one request
// at a time with a gap between requests, and saves its place in KV. A full pass (ClawHub's catalogue, then the GitHub
// skill repositories) takes about a week; the next pass starts a week after the last one began.
//
// The files are untrusted text. They are read as bytes, capped, scanned with the same rules as /scan (regular
// expressions over text) by ingestBatch, and stored as fingerprints and findings, never as text. Nothing here writes a
// file, runs, imports or evaluates anything. Matched files stay unlisted (ingestBatch), no notice is sent, and nothing is
// ever called malicious.

export const STATE_KEY = "bulk-scan:state:v1";
/** "on" or "off" overrides the default: on in production, off elsewhere (staging would double the load on sources). */
export const SWITCH_KEY = "bulk-scan:switch";
const PATHS_KEY = (repo: string) => `bulk-scan:paths:v1:${repo.toLowerCase()}`;

export const UA = "theagentforge-bulk-scan/2 (+https://theagentforge.io/skill-watch#bulk-scan; hello@theagentforge.io)";
export const MAX_BYTES = SCAN_MAX_BYTES;
export const MAX_FILES_PER_RUN = 600;
export const RUN_WALL_MS = 7 * 60_000;
/** About 2.5 requests a second at most: under 5% of ClawHub's published 3,000 reads a minute per IP. */
export const GAP_MS = 400;
export const PASS_EVERY_MS = 7 * 86_400_000;
/** A repository whose tarball holds at most this many SKILL.md files (and bytes) is scanned from the tarball at once. */
export const INLINE_MAX_FILES = 100;
export const INLINE_MAX_BYTES = 4 * 1024 * 1024;
/** Caps on one tarball: compressed bytes downloaded, bytes after gunzip, and SKILL.md paths kept. */
export const TARBALL_MAX_GZ = 1024 ** 3;
export const TARBALL_MAX_RAW = 4 * 1024 ** 3;
export const MAX_PATHS = 200_000;
/** A repository whose tarball fails this many times in a pass is left for the next pass. */
export const MAX_ATTEMPTS = 3;
const BATCH = 20;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** Public GitHub skill repositories read in full besides the launch-scan list (ADR 0107 lists their licences). */
export const EXTRA_REPOS = ["anthropics/skills", "openclaw/skills"];

export interface BulkState {
  v: 1;
  /** Pass number (0: never started), when it began and when it finished. */
  pass: number;
  pass_started: number | null;
  pass_done: number | null;
  phase: "clawhub" | "github" | "done";
  clawhub: { cursor: string | null; pages: number; queue: string[]; listed: boolean; error: string | null };
  github: {
    index: number;
    total: number | null;
    /** A repository too large to read from its tarball at once: its SKILL.md paths are in KV, read `next` onwards. */
    current: { repo: string; commit: string; etag: string | null; n: number; next: number } | null;
    /** Commit (and ETag) read last for each repository: an unchanged repository costs one small conditional request. */
    marks: Record<string, { commit: string; etag: string | null }>;
    attempts: Record<string, number>;
    skipped: string[];
  };
  /** ISO week (UTC) and what was read in it: files read, new fingerprints stored, files that couldn't be read. */
  week: string;
  week_read: number;
  week_added: number;
  week_failed: number;
  /** Host → time (ms) before which we send it nothing (its Retry-After). */
  paused: Record<string, number>;
  last_run: { at: number; read: number; added: number; ms: number; stop: string } | null;
}

export const emptyState = (): BulkState => ({
  v: 1,
  pass: 0,
  pass_started: null,
  pass_done: null,
  phase: "done",
  clawhub: { cursor: null, pages: 0, queue: [], listed: false, error: null },
  github: { index: 0, total: null, current: null, marks: {}, attempts: {}, skipped: [] },
  week: "",
  week_read: 0,
  week_added: 0,
  week_failed: 0,
  paused: {},
  last_run: null,
});

/** ISO week of a time, "2026-W44" (UTC). */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 4)) / (7 * 86_400_000) + ((new Date(Date.UTC(year, 0, 4)).getUTCDay() + 6) % 7) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export async function loadState(env: Env): Promise<BulkState> {
  try {
    const s = (await env.KV.get(STATE_KEY, "json")) as BulkState | null;
    if (s?.v === 1) return { ...emptyState(), ...s, clawhub: { ...emptyState().clawhub, ...s.clawhub }, github: { ...emptyState().github, ...s.github } };
  } catch {
    /* start again: ingestBatch de-duplicates, so nothing is double-counted */
  }
  return emptyState();
}

export async function bulkScanEnabled(env: Env): Promise<boolean> {
  const sw = await env.KV.get(SWITCH_KEY).catch(() => null);
  if (sw === "on") return true;
  if (sw === "off") return false;
  return env.ENVIRONMENT === "production";
}

/** A file in a GitHub tarball that we scan: named SKILL.md (any case), in a normal path. */
export function isSkillPath(path: string): boolean {
  const parts = path.split("/");
  return parts.at(-1)!.toLowerCase() === "skill.md" && !parts.some((p) => p === ".." || p === "." || p === "") && !path.includes("\\") && !path.includes("\0");
}

/** GitHub tarballs put everything under one top folder (owner-repo-sha/); the in-repository path is the rest. */
export const repoPath = (tarPath: string) => tarPath.split("/").slice(1).join("/");

/** The GitHub repository set: our extra list plus the launch dataset's repositories, once each (case-insensitive). */
export function githubRepos(launch: { repos?: unknown[] } | null): string[] {
  const seen = new Map<string, string>();
  for (const r of [...EXTRA_REPOS, ...(launch?.repos ?? []).map((x) => (Array.isArray(x) ? x[0] : null))]) {
    if (typeof r !== "string" || !REPO.test(r)) continue;
    if (!seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r);
  }
  return [...seen.values()];
}

// --- Network: one request at a time, gaps between them, Retry-After honoured -----------------------------------------

export interface Deps {
  fetcher: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

type Got = { res: Response } | { paused_until: number } | { error: string };

/** Retry-After as milliseconds from now (seconds or an HTTP date), or null. */
export function retryAfterMs(v: string | null, now: number): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * fetch with up to 3 tries. A 429 (or a 5xx with Retry-After) waits out a short Retry-After inside the run's budget;
 * a longer one pauses that host until then (the next run checks). Other 5xx answers back off and try again.
 */
export async function politeFetch(url: string, init: RequestInit & { timeoutMs?: number }, d: Deps, budgetEnd: number): Promise<Got> {
  for (let i = 0; i < 3; i++) {
    let res: Response;
    try {
      res = await d.fetcher(url, { ...init, headers: { "User-Agent": UA, ...((init.headers as Record<string, string>) ?? {}) }, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
    } catch (e) {
      if (i === 2) return { error: String((e as Error)?.message ?? e).slice(0, 80) };
      await d.sleep(1000 * 2 ** i);
      continue;
    }
    if (res.status !== 429 && res.status < 500) return { res };
    const ra = retryAfterMs(res.headers.get("retry-after"), d.now());
    await res.body?.cancel().catch(() => {});
    if (res.status === 429 || ra !== null) {
      const wait = Math.min(ra ?? 60_000, 86_400_000);
      if (wait <= 15_000 && d.now() + wait < budgetEnd) {
        await d.sleep(wait);
        continue;
      }
      return { paused_until: d.now() + Math.max(wait, 1000) };
    }
    if (i < 2) await d.sleep(2000 * 2 ** i);
  }
  return { error: "server_error" };
}

/** A response body as bytes, never more than `max + 1` of them in memory (a larger file is counted as too large). */
export async function readCapped(res: Response, max = MAX_BYTES): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    return new Uint8Array(max + 1);
  }
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(Math.min(n, max + 1));
  let off = 0;
  for (const p of parts) {
    const k = Math.min(p.length, buf.length - off);
    buf.set(p.subarray(0, k), off);
    off += k;
    if (off >= buf.length) break;
  }
  return buf;
}

const textType = (res: Response) => !/^(image|audio|video|application\/(zip|gzip|x-gzip|octet-stream|pdf))/.test(res.headers.get("content-type") ?? "");

export type RepoRead =
  | { ok: true; unchanged: true; commit: string; etag: string | null }
  | { ok: true; unchanged: false; commit: string; etag: string | null; files: [string, Uint8Array][] | null; paths: string[]; too_large: number }
  | { ok: false; paused_until?: number; error: string };

/**
 * One repository's tarball at HEAD, streamed. A 304 (stored ETag) or the stored commit in the archive's first header
 * means unchanged, and the download stops there. Otherwise every regular file named SKILL.md is listed; while there are
 * few and small enough, their bytes are kept too (`files`), so a small repository costs one request.
 */
export async function readRepo(repo: string, mark: { commit: string; etag: string | null } | undefined, d: Deps, deadline: number): Promise<RepoRead> {
  const got = await politeFetch(`https://codeload.github.com/${repo}/tar.gz/HEAD`, { headers: mark?.etag ? { "If-None-Match": mark.etag } : {}, timeoutMs: Math.max(5_000, deadline - d.now()) }, d, deadline);
  if ("paused_until" in got) return { ok: false, paused_until: got.paused_until, error: "paused" };
  if ("error" in got) return { ok: false, error: got.error };
  const res = got.res;
  const etag = res.headers.get("etag");
  if (res.status === 304 && mark) return { ok: true, unchanged: true, commit: mark.commit, etag: mark.etag };
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: `http_${res.status}` };
  }
  // Typed by assertion: they are set inside the reader's callbacks, which TypeScript's narrowing can't see.
  let commit = null as string | null;
  let files = [] as [string, Uint8Array][] | null;
  let bytes = 0;
  const paths: string[] = [];
  let tooLarge = 0;
  let early = null as "unchanged" | "no_commit" | "too_many" | null;
  const tar = new TarReader({
    maxTotal: TARBALL_MAX_RAW,
    onGlobal: (pax) => {
      if (commit === null && COMMIT.test(pax.comment ?? "")) commit = pax.comment!;
      if (commit && mark?.commit === commit) early = "unchanged";
    },
    want: (p, size) => {
      if (!isSkillPath(repoPath(p))) return false;
      if (!commit) {
        early = "no_commit";
        return false;
      }
      if (size > MAX_BYTES) {
        tooLarge++;
        return false;
      }
      if (paths.length >= MAX_PATHS) {
        early = "too_many";
        return false;
      }
      paths.push(repoPath(p));
      // Few and small: keep the bytes too. Otherwise drop them and read the files one by one in later runs.
      if (files && (paths.length > INLINE_MAX_FILES || bytes + size > INLINE_MAX_BYTES)) files = null;
      if (files) bytes += size;
      return files !== null;
    },
    onFile: (p, b) => files?.push([repoPath(p), b]),
  });
  let gz = 0;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        gz += chunk.byteLength;
        if (gz > TARBALL_MAX_GZ) c.error(new Error("tarball over the download cap"));
        else c.enqueue(chunk);
      },
    }),
  );
  const reader = counted.pipeThrough(new DecompressionStream("gzip")).getReader();
  try {
    for (;;) {
      if (d.now() > deadline) throw new Error("deadline");
      const { done, value } = await reader.read();
      if (done) break;
      tar.write(value);
      if (early || tar.done) break;
    }
    if (!early && !tar.done) tar.end();
  } catch (e) {
    await reader.cancel().catch(() => {});
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 80) };
  }
  await reader.cancel().catch(() => {});
  if (early === "unchanged") return { ok: true, unchanged: true, commit: commit!, etag };
  if (early === "no_commit" || !commit) return { ok: false, error: "no_commit" };
  if (early === "too_many") return { ok: false, error: "too_many_files" };
  return { ok: true, unchanged: false, commit, etag, files, paths, too_large: tooLarge };
}

// --- One hourly slice ------------------------------------------------------------------------------------------------

export interface TickResult {
  ran: boolean;
  stop: string;
  read: number;
  added: number;
  failed: number;
  pass?: number;
  phase?: BulkState["phase"];
}

const realDeps = (): Deps => ({ fetcher: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });

const hostOf = (u: string) => new URL(u).hostname;

/**
 * The hourly slice: carries on from the saved place until MAX_FILES_PER_RUN files or RUN_WALL_MS, then saves. One
 * KV write per run for the place (plus one per large repository for its path list).
 */
export async function bulkScanTick(
  env: Env,
  o: { deps?: Partial<Deps>; maxFiles?: number; wallMs?: number; gapMs?: number; repos?: string[]; force?: boolean } = {},
): Promise<TickResult> {
  const d: Deps = { ...realDeps(), ...o.deps };
  const start = d.now();
  const res: TickResult = { ran: false, stop: "", read: 0, added: 0, failed: 0 };
  if (!o.force && !(await bulkScanEnabled(env))) return { ...res, stop: "off" };
  if (await isLean(env)) return { ...res, stop: "lean" };
  const maxFiles = o.maxFiles ?? MAX_FILES_PER_RUN;
  const end = start + (o.wallMs ?? RUN_WALL_MS);
  const gap = o.gapMs ?? GAP_MS;
  const s = await loadState(env);
  const week = isoWeek(start);
  if (s.week !== week) Object.assign(s, { week, week_read: 0, week_added: 0, week_failed: 0 });
  if (s.pass === 0 || (s.phase === "done" && start >= (s.pass_started ?? 0) + PASS_EVERY_MS)) {
    Object.assign(s, { pass: s.pass + 1, pass_started: start, pass_done: null, phase: "clawhub" });
    s.clawhub = { cursor: null, pages: 0, queue: [], listed: false, error: null };
    s.github = { ...s.github, index: 0, current: null, attempts: {}, skipped: [] };
  }
  if (s.phase === "done") return { ...res, stop: "pass_complete_waiting", pass: s.pass, phase: s.phase };
  res.ran = true;

  // Files go to ingestBatch (the same scan and storage as the old batch route) 20 at a time, per source.
  const queues: Record<BulkSource, { text: string; source_url: string; name: string }[]> = { clawhub: [], github: [] };
  let stopped = false;
  const flush = async (source: BulkSource) => {
    const items = queues[source].splice(0);
    if (!items.length) return true;
    const r = await ingestBatch(env, { source, items }, d.now());
    if (!r.ok) return false;
    res.added += r.added;
    return true;
  };
  const add = async (source: BulkSource, bytes: Uint8Array, url: string, name: string) => {
    res.read++;
    if (bytes.length > MAX_BYTES) return true; // counted as read; too large to scan, like a link scan
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) return true;
    queues[source].push({ text, source_url: url, name });
    return queues[source].length >= BATCH ? flush(source) : true;
  };
  const paused = (host: string) => (s.paused[host] ?? 0) > d.now();
  const stop = (why: string) => {
    res.stop = why;
    stopped = true;
  };
  let repos: string[] | null = o.repos ?? null;
  let paths: { commit: string; paths: string[] } | null = null;

  while (!stopped) {
    if (res.read >= maxFiles) {
      stop("file_budget");
      break;
    }
    if (d.now() >= end) {
      stop("time_budget");
      break;
    }
    if (s.phase === "clawhub") {
      if (paused("clawhub.ai")) {
        stop("clawhub_retry_after");
        break;
      }
      if (!s.clawhub.queue.length) {
        if (s.clawhub.listed) {
          s.phase = "github";
          continue;
        }
        const u = new URL("https://clawhub.ai/api/v1/skills");
        u.searchParams.set("limit", "200");
        u.searchParams.set("sort", "updated");
        if (s.clawhub.cursor) u.searchParams.set("cursor", s.clawhub.cursor);
        const got = await politeFetch(u.toString(), { headers: { Accept: "application/json" } }, d, end);
        await d.sleep(gap);
        if ("paused_until" in got) {
          s.paused["clawhub.ai"] = got.paused_until;
          continue;
        }
        if ("error" in got || !got.res.ok) {
          // The catalogue can't be read now: move on to GitHub, and try ClawHub again next pass.
          if ("res" in got) await got.res.body?.cancel().catch(() => {});
          s.clawhub.error = "error" in got ? got.error : `http_${got.res.status}`;
          s.clawhub.listed = true;
          continue;
        }
        const body = (await got.res.json().catch(() => null)) as { items?: unknown[]; nextCursor?: unknown } | null;
        const seen = new Set(s.clawhub.queue);
        for (const it of (body?.items ?? []) as { slug?: unknown; latestVersion?: unknown }[]) {
          // Only skills with a public version. The owner isn't kept: the file API doesn't say whose file it returns.
          if (typeof it?.slug !== "string" || !NAME.test(it.slug) || !it.latestVersion || seen.has(it.slug)) continue;
          seen.add(it.slug);
          s.clawhub.queue.push(it.slug);
        }
        s.clawhub.pages++;
        s.clawhub.cursor = typeof body?.nextCursor === "string" && body.nextCursor ? body.nextCursor.slice(0, 500) : null;
        if (!s.clawhub.cursor) s.clawhub.listed = true;
        continue;
      }
      const slug = s.clawhub.queue[0]!;
      const url = clawhubSlugSourceUrl(slug);
      const got = await politeFetch(url, { headers: { Accept: "text/plain, text/markdown, */*" } }, d, end);
      await d.sleep(gap);
      if ("paused_until" in got) {
        s.paused["clawhub.ai"] = got.paused_until;
        continue;
      }
      s.clawhub.queue.shift();
      if ("error" in got || !got.res.ok || !textType(got.res)) {
        if ("res" in got) await got.res.body?.cancel().catch(() => {});
        res.failed++;
        continue;
      }
      // Labelled by slug only: ClawHub slugs are not unique across publishers (review ADR 0111).
      if (!(await add("clawhub", await readCapped(got.res), url, slug))) stop("ingest_refused");
      continue;
    }

    // GitHub
    if (s.github.current) {
      const cur = s.github.current;
      if (cur.next >= cur.n) {
        s.github.marks[cur.repo.toLowerCase()] = { commit: cur.commit, etag: cur.etag };
        await env.KV.delete(PATHS_KEY(cur.repo)).catch(() => {});
        s.github.current = null;
        s.github.index++;
        paths = null;
        continue;
      }
      if (paused("raw.githubusercontent.com")) {
        stop("github_retry_after");
        break;
      }
      if (!paths) {
        paths = (await env.KV.get(PATHS_KEY(cur.repo), "json").catch(() => null)) as { commit: string; paths: string[] } | null;
        if (!paths || paths.commit !== cur.commit) {
          // The list is gone: read the repository again.
          s.github.current = null;
          paths = null;
          continue;
        }
      }
      const path = paths.paths[cur.next]!;
      const url = githubSourceUrl(cur.repo, cur.commit, path);
      const got = await politeFetch(url, { headers: { Accept: "text/plain, */*" } }, d, end);
      await d.sleep(gap);
      if ("paused_until" in got) {
        s.paused["raw.githubusercontent.com"] = got.paused_until;
        continue;
      }
      cur.next++;
      if ("error" in got || !got.res.ok || !textType(got.res)) {
        if ("res" in got) await got.res.body?.cancel().catch(() => {});
        res.failed++;
        continue;
      }
      if (!(await add("github", await readCapped(got.res), url, `${cur.repo}/${path}`))) stop("ingest_refused");
      continue;
    }
    if (!repos) {
      const r = await env.ASSETS.fetch(new Request(`https://assets.local${SEED_PATH}`)).catch(() => null);
      repos = githubRepos(r?.ok ? ((await r.json().catch(() => null)) as { repos?: unknown[] } | null) : null);
    }
    s.github.total = repos.length;
    if (s.github.index >= repos.length) {
      s.phase = "done";
      s.pass_done = d.now();
      stop("pass_complete");
      break;
    }
    const repo = repos[s.github.index]!;
    const key = repo.toLowerCase();
    if ((s.github.attempts[key] ?? 0) >= MAX_ATTEMPTS) {
      if (!s.github.skipped.includes(repo)) s.github.skipped.push(repo);
      s.github.index++;
      continue;
    }
    if (paused("codeload.github.com")) {
      stop("github_retry_after");
      break;
    }
    // A tarball is only started with a few minutes left, so a large one isn't cut off half-read.
    if (end - d.now() < 3 * 60_000) {
      stop("time_budget");
      break;
    }
    const r = await readRepo(repo, s.github.marks[key], d, end);
    await d.sleep(gap);
    if (!r.ok) {
      if (r.paused_until) s.paused["codeload.github.com"] = r.paused_until;
      else s.github.attempts[key] = (s.github.attempts[key] ?? 0) + 1;
      continue;
    }
    if (r.unchanged) {
      s.github.marks[key] = { commit: r.commit, etag: r.etag };
      s.github.index++;
      continue;
    }
    if (r.files) {
      if (!(await flush("github"))) {
        stop("ingest_refused");
        break;
      }
      for (const [p, b] of r.files) if (!(await add("github", b, githubSourceUrl(repo, r.commit, p), `${repo}/${p}`))) stop("ingest_refused");
      res.read += r.too_large;
      if (stopped || !(await flush("github"))) {
        stop("ingest_refused");
        break;
      }
      s.github.marks[key] = { commit: r.commit, etag: r.etag };
      s.github.index++;
      continue;
    }
    res.read += r.too_large;
    await env.KV.put(PATHS_KEY(repo), JSON.stringify({ commit: r.commit, paths: r.paths }), { expirationTtl: 30 * 86_400 });
    paths = { commit: r.commit, paths: r.paths };
    s.github.current = { repo, commit: r.commit, etag: r.etag, n: r.paths.length, next: 0 };
  }
  if (!(await flush("clawhub")) || !(await flush("github"))) res.stop = "ingest_refused";
  s.week_read += res.read;
  s.week_added += res.added;
  s.week_failed += res.failed;
  for (const [h, until] of Object.entries(s.paused)) if (until <= d.now()) delete s.paused[h];
  s.last_run = { at: start, read: res.read, added: res.added, ms: d.now() - start, stop: res.stop };
  await env.KV.put(STATE_KEY, JSON.stringify(s));
  return { ...res, pass: s.pass, phase: s.phase };
}

// --- The admin line (/admin/costs) -----------------------------------------------------------------------------------

export interface BulkProgress {
  enabled: boolean;
  pass: number;
  pass_started: string | null;
  pass_done: string | null;
  phase: BulkState["phase"];
  next_pass: string | null;
  clawhub: { pages_read: number; cursor_held: boolean; queued: number; listed: boolean; error: string | null };
  github: { repo_index: number; repos: number | null; current: { repo: string; next: number; files: number } | null; skipped: string[] };
  week: string;
  week_read: number;
  week_added: number;
  week_failed: number;
  paused: Record<string, string>;
  last_run: (Omit<NonNullable<BulkState["last_run"]>, "at"> & { at: string }) | null;
}

/** Where the bulk scan is, for admins: counts and repository names only, never a file's result. */
export async function bulkScanProgress(env: Env): Promise<BulkProgress> {
  const s = await loadState(env);
  const iso = (n: number | null) => (n ? new Date(n).toISOString() : null);
  return {
    enabled: await bulkScanEnabled(env),
    pass: s.pass,
    pass_started: iso(s.pass_started),
    pass_done: iso(s.pass_done),
    phase: s.phase,
    next_pass: s.pass_started ? iso(s.pass_started + PASS_EVERY_MS) : null,
    clawhub: { pages_read: s.clawhub.pages, cursor_held: !!s.clawhub.cursor, queued: s.clawhub.queue.length, listed: s.clawhub.listed, error: s.clawhub.error },
    github: { repo_index: s.github.index, repos: s.github.total, current: s.github.current ? { repo: s.github.current.repo, next: s.github.current.next, files: s.github.current.n } : null, skipped: s.github.skipped },
    week: s.week,
    week_read: s.week_read,
    week_added: s.week_added,
    week_failed: s.week_failed,
    paused: Object.fromEntries(Object.entries(s.paused).map(([h, t]) => [h, new Date(t).toISOString()])),
    last_run: s.last_run ? { ...s.last_run, at: new Date(s.last_run.at).toISOString() } : null,
  };
}
