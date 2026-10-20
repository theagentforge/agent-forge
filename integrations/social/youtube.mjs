// YouTube Shorts (docs/launch/social-strategy.md §9.7): uploads each new Gauntlet clip as a Short.
//   node youtube.mjs <site>    list the site's ready clips (/api/v1/social/shorts), upload the ones not yet on YouTube
// The title and description come from the site's fixed templates (no model writes them); the MP4 comes from the
// public clips release. What's been uploaded is recorded as bot comments on the "YouTube Shorts" issue, so a clip is
// never uploaded twice. Off (does nothing) until Dinike adds YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and
// YOUTUBE_REFRESH_TOKEN as secrets (docs/runbooks/posting.md).

import { fetchVideo } from "./post-to-x.mjs";

export const STATE_TITLE = "YouTube Shorts";
export const STATE_LABEL = "youtube";
/** A few uploads a run stays well inside the default daily YouTube quota (check it in the Google Cloud console). */
export const MAX_PER_RUN = 3;
const SHORT_MARK = /<!-- forge-short (gx-[A-Za-z0-9_-]+) ([A-Za-z0-9_-]+) -->/g;
const BOT = "github-actions[bot]";
/** YouTube rejects < and > in titles and descriptions. */
const clean = (s, max) => s.replace(/[<>]/g, "").slice(0, max);

export const connected = (env) => Boolean(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN);

/** A short-lived access token from the stored refresh token. */
export async function accessToken(env, fetcher = fetch) {
  const res = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID, client_secret: env.YOUTUBE_CLIENT_SECRET, refresh_token: env.YOUTUBE_REFRESH_TOKEN, grant_type: "refresh_token" }).toString(),
  });
  if (!res.ok) throw new Error(`Google refused the refresh token (HTTP ${res.status}). Re-authorise the upload app (docs/runbooks/posting.md).`);
  return (await res.json()).access_token;
}

/** The metadata YouTube stores for the Short. */
export const metadata = (short, privacy = "public") => ({
  snippet: { title: clean(short.title, 100), description: clean(short.description, 5000), categoryId: "28" },
  status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
});

/** Resumable upload: open a session with the metadata, then send the bytes. Returns the YouTube video id. */
export async function uploadShort(short, bytes, token, fetcher = fetch, privacy = "public") {
  const open = await fetcher("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(bytes.length),
    },
    body: JSON.stringify(metadata(short, privacy)),
  });
  const session = open.headers.get("location");
  if (!open.ok || !session) throw new Error(`YouTube didn't open an upload for ${short.clip} (HTTP ${open.status}).`);
  const put = await fetcher(session, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes });
  if (!put.ok) throw new Error(`YouTube refused ${short.clip} (HTTP ${put.status}).`);
  const video = await put.json();
  if (!video.id) throw new Error(`YouTube took ${short.clip} but returned no video id.`);
  return video.id;
}

/** Clips already uploaded, from the bot's own comments on the state issue. */
export function uploaded(comments) {
  const out = new Map();
  for (const c of comments) if (c.user?.login === BOT) for (const m of c.body.matchAll(SHORT_MARK)) out.set(m[1], m[2]);
  return out;
}

function github(env, fetcher) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  return async (method, path, body) => {
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${res.status}).`);
    return res.json();
  };
}

export async function run(site, env = process.env, fetcher = fetch) {
  if (!connected(env)) return ["YouTube isn't connected yet (no YOUTUBE_* secrets): nothing to do."];
  const gh = github(env, fetcher);
  const found = await gh("GET", `/issues?state=all&labels=${STATE_LABEL}&per_page=10`);
  const state = found.find((i) => i.title === STATE_TITLE && !i.pull_request) ?? (await gh("POST", "/issues", { title: STATE_TITLE, labels: [STATE_LABEL], body: "Each Gauntlet clip uploaded as a YouTube Short, recorded by the YouTube workflow. Don't edit; close it if you like (it still works)." }));
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh("GET", `/issues/${state.number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const done = uploaded(comments);
  const res = await fetcher(`${site}/api/v1/social/shorts`);
  if (!res.ok) throw new Error(`The site's Shorts list failed (HTTP ${res.status}).`);
  const todo = (await res.json()).shorts.filter((s) => !done.has(s.clip)).slice(0, MAX_PER_RUN);
  if (!todo.length) return ["No new clips."];
  const token = await accessToken(env, fetcher);
  const log = [];
  for (const s of todo) {
    const bytes = await fetchVideo(s.video, fetcher);
    const id = await uploadShort(s, bytes, token, fetcher, env.YOUTUBE_PRIVACY || "public");
    await gh("POST", `/issues/${state.number}/comments`, { body: `Uploaded **${s.title}**: https://youtube.com/shorts/${id} <!-- forge-short ${s.clip} ${id} -->` });
    log.push(`${s.clip}: https://youtube.com/shorts/${id}`);
  }
  return log;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = process.argv[2] ?? "https://theagentforge.io";
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) {
    console.error("site must be https://<host>");
    process.exit(1);
  }
  run(site)
    .then((r) => console.log(r.join("\n")))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
