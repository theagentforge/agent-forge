import { taskById, type AttemptResult } from "@forge/arena";
import { getDb } from "../services/db";
import { failCard, verifiedReplay } from "./fail-card";
import { finishedRuns, modelName, runWithLog } from "./views";

// Vertical clips (ADR 0023 §1, amendment 1). A GitHub Actions workflow in the public mirror records
// /arena/run/<id>/clip with a headless browser and publishes <run id>.mp4 as an asset of one rolling GitHub Release,
// "clips", together with an index.json listing every clip. The site never receives writes from CI: the hourly cron
// fetches that index (a plain download, not the rate-limited GitHub API) and keeps it in KV. Pages only read KV.

/** The public repo whose "clips" release holds the files (release assets on a public repo are public downloads). */
export const CLIPS_REPO = "theagentforge/agent-forge";
export const CLIPS_TAG = "clips";
export const CLIPS_BASE = `https://github.com/${CLIPS_REPO}/releases/download/${CLIPS_TAG}`;
export const CLIPS_INDEX_URL = `${CLIPS_BASE}/index.json`;
export const clipFileUrl = (runId: string) => `${CLIPS_BASE}/${runId}.mp4`;

const KV_KEY = "arena:clips";
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The clip page plays for this long, then holds on the verdict (the recorder adds a short hold). */
export const CLIP_SECONDS = 20;
/** How many bouts one workflow run records. */
export const PENDING_CAP = 10;
/** Only bouts finished this recently are offered for a clip. */
export const PENDING_DAYS = 14;

export interface ClipIndex {
  /** Run ids that have a published clip. */
  clips: string[];
  /** Run ids whose clip was taken down on purpose: never listed as pending again. */
  removed: string[];
  /** When the site last fetched the index (ms), 0 if never. */
  fetchedAt: number;
}

const EMPTY: ClipIndex = { clips: [], removed: [], fetchedAt: 0 };

/** Validates the published index.json: only well-formed run ids survive. */
export function parseClipIndex(data: unknown): Omit<ClipIndex, "fetchedAt"> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { clips?: unknown; removed?: unknown };
  if (!Array.isArray(d.clips)) return null;
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && RUN_ID.test(x)))] : []);
  const removed = ids(d.removed);
  return { clips: ids(d.clips).filter((id) => !removed.includes(id)), removed };
}

/** The clip index as last stored by the cron. Never fetches; empty until the first refresh. */
export async function clipIndex(env: Pick<Env, "KV">): Promise<ClipIndex> {
  const stored = await env.KV.get<ClipIndex>(KV_KEY, "json").catch(() => null);
  return stored && Array.isArray(stored.clips) ? { ...EMPTY, ...stored } : EMPTY;
}

/** The clip's public URL, or null when this run has no clip. */
export async function clipUrlFor(env: Pick<Env, "KV">, runId: string) {
  return (await clipIndex(env)).clips.includes(runId) ? clipFileUrl(runId) : null;
}

/**
 * Hourly (cron): fetch the release's index.json and store it. On a failure the last good index is kept, so a GitHub
 * hiccup never hides clips that exist. A missing release (404) means no clips yet.
 */
export async function refreshClipIndex(env: Pick<Env, "KV">, fetcher: typeof fetch = fetch, now = Date.now()) {
  const res = await fetcher(CLIPS_INDEX_URL, { redirect: "follow", headers: { Accept: "application/json", "User-Agent": "theagentforge.io" }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) {
    await env.KV.put(KV_KEY, JSON.stringify({ ...EMPTY, fetchedAt: now }));
    return { clips: 0, removed: 0 };
  }
  if (!res.ok) throw new Error(`clip index: HTTP ${res.status}`);
  const parsed = parseClipIndex(await res.json());
  if (!parsed) throw new Error("clip index: unexpected shape");
  await env.KV.put(KV_KEY, JSON.stringify({ ...parsed, fetchedAt: now } satisfies ClipIndex));
  return { clips: parsed.clips.length, removed: parsed.removed.length };
}

/** Which moment a clip shows: a trap springing, or a clean catch. Other endings (knockouts, plain fails) get no clip. */
export function clipMoment(r: { runId: string; modelId: string; result: AttemptResult; task: string; practice: boolean; finishedAt: number }) {
  const card = failCard({ runId: r.runId, modelName: modelName(r.modelId), result: r.result, taskTitle: taskById(r.task)?.title ?? r.task, practice: r.practice, finishedAt: r.finishedAt });
  return card.kind === "trap" || card.kind === "caught" ? card.kind : null;
}

/**
 * Bouts that need a clip (structured data for the workflow): recent ranked bouts (card and guest events, Normal and
 * Hard) with a trap event or a clean catch and a verified replay, newest first, without a clip or a takedown.
 */
export async function pendingClips(env: Env, now = Date.now(), cap = PENDING_CAP) {
  const db = getDb(env);
  const index = await clipIndex(env);
  const skip = new Set([...index.clips, ...index.removed]);
  const since = now - PENDING_DAYS * 86_400_000;
  const runs = (await finishedRuns(db, { kinds: ["card", "guest"], hard: true, limit: 500, now })).filter((r) => r.summary.finishedAt >= since && !skip.has(r.summary.id));
  const out: { id: string; moment: "trap" | "caught"; task: string; model: string; kind: "card" | "guest"; finished_at: string; clip_page: string }[] = [];
  let checked = 0;
  for (const r of runs) {
    if (out.length >= cap || checked >= cap * 3) break;
    const s = r.summary;
    const moment = clipMoment({ runId: s.id, modelId: s.model, result: r.result, task: s.task, practice: false, finishedAt: s.finishedAt });
    if (!moment) continue;
    checked++;
    const full = await runWithLog(db, s.id, now);
    if (!full || !(await verifiedReplay(env, s.id, full.log, full.run.signature))) continue;
    out.push({ id: s.id, moment, task: s.task, model: s.model, kind: s.kind as "card" | "guest", finished_at: new Date(s.finishedAt).toISOString(), clip_page: `/arena/run/${s.id}/clip` });
  }
  return { index_fetched_at: index.fetchedAt ? new Date(index.fetchedAt).toISOString() : null, clip_seconds: CLIP_SECONDS, cap, pending: out };
}
