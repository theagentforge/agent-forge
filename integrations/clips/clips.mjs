#!/usr/bin/env node
// Vertical clips (ADR 0023 §1, amendment 1; docs/runbooks/clips.md). Run by .github/workflows/clips.yml.
//
//   node clips.mjs plan   <site> <assets.json> <old-index.json> <out plan.json>   which bouts to record (env RUN_ID: one bout)
//   node clips.mjs record <site> <plan.json> <out dir>                            record each clip page and encode an MP4
//   node clips.mjs index  <assets.json> <old-index.json> <out index.json>         the index the site reads (env REMOVE_ID, RESTORE_ID)
//
// Only built-in modules, plus Playwright from $PLAYWRIGHT_DIR (installed by the workflow). The site's data is checked
// as untrusted input: run ids must match RUN_ID before they reach a URL or a file name.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WIDTH = 1080;
const HEIGHT = 1920;
/** Seconds the clip holds on the verdict after the page's ~20 s of playback. */
const HOLD = 3;
const CAP = 10;

const readJson = (path, fallback) => {
  if (!path || path === "-" || !existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};
/** Run ids from `gh release view --json assets` (asset names "<run id>.mp4"). */
export const clipIdsFromAssets = (assets) =>
  (assets?.assets ?? []).map((a) => a?.name).filter((n) => typeof n === "string" && n.endsWith(".mp4")).map((n) => n.slice(0, -4)).filter((id) => RUN_ID.test(id));
const removedIds = (index) => (Array.isArray(index?.removed) ? index.removed.filter((id) => typeof id === "string" && RUN_ID.test(id)) : []);

/**
 * The new index.json: clips that exist as assets, minus takedowns. The takedown list is carried over, so a removed
 * bout is never offered again; re-recording one by hand (restoreId) lifts its takedown.
 */
export function buildIndex(assets, oldIndex, removeId, restoreId = null, now = new Date()) {
  const removed = new Set(removedIds(oldIndex));
  if (restoreId) removed.delete(restoreId);
  if (removeId) removed.add(removeId);
  const clips = [...new Set(clipIdsFromAssets(assets))].filter((id) => !removed.has(id)).sort();
  return { version: 1, updated_at: now.toISOString(), clips, removed: [...removed].sort() };
}

async function plan(site, assetsPath, indexPath, out) {
  const one = (process.env.RUN_ID ?? "").trim();
  let ids;
  if (one) {
    // By hand: (re-)record this one bout, even if it already has a clip.
    if (!RUN_ID.test(one)) throw new Error("RUN_ID is not a run id");
    ids = [one];
  } else {
    const res = await fetch(`${site}/arena/clips/pending.json`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`pending.json: HTTP ${res.status}`);
    const data = await res.json();
    const have = new Set([...clipIdsFromAssets(readJson(assetsPath, {})), ...removedIds(readJson(indexPath, {}))]);
    ids = (Array.isArray(data?.pending) ? data.pending : []).map((p) => p?.id).filter((id) => typeof id === "string" && RUN_ID.test(id) && !have.has(id)).slice(0, CAP);
  }
  writeFileSync(out, JSON.stringify({ ids }));
  console.log(`plan: ${ids.length} clip(s)${ids.length ? `: ${ids.join(", ")}` : ""}`);
}

function ffprobe(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt:format=duration", "-of", "json", file]).toString();
  return JSON.parse(out);
}

/**
 * The browser's recording → the published file: H.264 (High, yuv420p) at 1080×1920 and 30 fps, a silent AAC track
 * (some platforms reject video with no audio), faststart for streaming. Checked with ffprobe; returns the duration.
 */
export function encodeClip(input, output, offsetSeconds, seconds) {
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", offsetSeconds.toFixed(2), "-i", input,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", String(seconds),
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `fps=30,scale=${WIDTH}:${HEIGHT}:flags=lanczos,setsar=1,format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "high", "-level", "4.2", "-preset", "slow", "-crf", "18",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
  const probe = ffprobe(output);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  if (!v || v.codec_name !== "h264" || v.width !== WIDTH || v.height !== HEIGHT || v.pix_fmt !== "yuv420p" || a?.codec_name !== "aac" || !(duration >= 15 && duration <= 30))
    throw new Error(`unexpected output: ${JSON.stringify({ v, a, duration })}`);
  return duration;
}

async function record(site, planPath, outDir) {
  const { ids = [] } = readJson(planPath, {});
  mkdirSync(outDir, { recursive: true });
  if (!ids.length) return console.log("record: nothing to do");
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) throw new Error("set PLAYWRIGHT_DIR to the folder where playwright is installed");
  const { chromium } = await import(pathToFileURL(createRequire(join(dir, "noop.js")).resolve("playwright")).href);
  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const id of ids) {
      if (!RUN_ID.test(id)) continue;
      const raw = join(outDir, `raw-${id}`);
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, reducedMotion: "no-preference", recordVideo: { dir: raw, size: { width: WIDTH, height: HEIGHT } } });
      const t0 = Date.now();
      const page = await context.newPage();
      try {
        const res = await page.goto(`${site}/arena/run/${id}/clip`, { waitUntil: "load", timeout: 30_000 });
        if (!res || !res.ok()) throw new Error(`HTTP ${res?.status()}`);
        await page.waitForSelector("html[data-clip-started]", { timeout: 20_000 });
        const started = Number(await page.getAttribute("html", "data-clip-started"));
        const seconds = Number(await page.getAttribute("body", "data-clip-seconds")) || 20;
        await page.waitForTimeout((seconds + HOLD) * 1000 + 500);
        await context.close();
        const webm = await page.video().path();
        // Skip the blank page load: the video starts when the page opens, the playback when the fonts are ready.
        const offset = Math.max(0, (started - t0) / 1000);
        // Encoded inside raw-<id>/ and moved only once it checks out, so a failed clip never reaches out/*.mp4.
        const tmp = join(raw, "encoded.mp4");
        const duration = encodeClip(webm, tmp, offset, seconds + HOLD);
        renameSync(tmp, join(outDir, `${id}.mp4`));
        console.log(`recorded ${id}.mp4 (${duration.toFixed(1)} s)`);
      } catch (e) {
        failed++;
        console.error(`clip ${id} failed: ${e?.message ?? e}`);
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }
  if (failed === ids.length) throw new Error("every clip failed");
}

function index(assetsPath, oldIndexPath, out) {
  const removeId = (process.env.REMOVE_ID ?? "").trim();
  const restoreId = (process.env.RESTORE_ID ?? "").trim();
  for (const [k, v] of [["REMOVE_ID", removeId], ["RESTORE_ID", restoreId]]) if (v && !RUN_ID.test(v)) throw new Error(`${k} is not a run id`);
  const idx = buildIndex(readJson(assetsPath, {}), readJson(oldIndexPath, {}), removeId || null, restoreId || null);
  writeFileSync(out, `${JSON.stringify(idx, null, 2)}\n`);
  console.log(`index: ${idx.clips.length} clip(s), ${idx.removed.length} taken down`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...args] = process.argv.slice(2);
  const site = (args[0] ?? "").replace(/\/$/, "");
  if (cmd === "plan") await plan(site, args[1], args[2], args[3]);
  else if (cmd === "record") await record(site, args[1], args[2]);
  else if (cmd === "index") index(args[0], args[1], args[2]);
  else throw new Error("usage: clips.mjs plan|record|index ...");
}
