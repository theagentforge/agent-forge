// Approve-to-post and auto-publish: posts the text from GitHub issues to X (docs/runbooks/posting.md, ADR 0010).
//   node post-to-x.mjs approve   an admin approved the issue: post what's due now, schedule the rest
//   node post-to-x.mjs due       scheduled run: post approved posts whose time has come, then auto-publish
//                                 verified routine posts whose 3-hour hold window has passed
//   node post-to-x.mjs hold      an admin commented "hold" on an auto post: stop it
//   node post-to-x.mjs metrics   daily: read recent posts' numbers from X and comment a table on "X post metrics"
// An issue holds one or more ```post blocks. A block may carry a time: ```post 2026-10-15 (posted at the daily
// slot, 13:05 UTC) or ```post 2026-10-15T15:30Z. Add the word "reply" (```post 2026-10-20 reply) to post it as a reply
// to the block before it, so a thread stays connected on X. A line `image: /og/....png` inside a block attaches that
// image from theagentforge.io (the line itself is not posted). Uses OAuth 1.0a user context against POST /2/tweets and the
// GitHub REST API with the workflow's token. No dependencies.
import { createHash, createHmac, randomBytes } from "node:crypto";

export const MAX_WEIGHT = 280;
const URL_WEIGHT = 23;

/** Default time of day for date-only posts: 13:00 UTC (9 am US Eastern in summer, 6:30 pm Sri Lanka). */
export const DEFAULT_SLOT_UTC = "13:00";
export const MAX_POSTS_PER_ISSUE = 14;

/** A line inside a post block that names its image, e.g. `image: https://theagentforge.io/og/arena/run/abc.png`. */
const IMAGE_LINE = /^[ \t]*image:[ \t]*(\S*)[ \t]*$/i;
/** Alt text for the post's image (social strategy §9.6), e.g. `alt: Two pixel robots ...`. Not posted; up to 1,000 characters. */
const ALT_LINE = /^[ \t]*alt:[ \t]*(.*?)[ \t]*$/i;
export const MAX_ALT = 1000;
/** A Gauntlet clip from the public clips release, uploaded natively (§9.4): `video: gx-<a8>-<b8>.mp4`. */
const VIDEO_LINE = /^[ \t]*video:[ \t]*(\S*)[ \t]*$/i;
export const VIDEO_ORIGIN = "https://github.com/theagentforge/agent-forge/releases/download/clips";
export const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
/** A native X poll (§9.5): `poll: Option A | Option B | Option C (2100 min)`. No media on polls. */
const POLL_LINE = /^[ \t]*poll:[ \t]*(.+?)[ \t]*\((\d+) min\)[ \t]*$/i;
export const POLL_LIMITS = { options: [2, 4], chars: 25, minutes: [5, 10080] };

/** The clip's URL on the clips release; anything else is refused. */
export function videoUrl(spec, n = "?") {
  if (!/^gx-[A-Za-z0-9_-]{1,40}\.mp4$/.test(spec ?? "")) throw new Error(`Post ${n} has a video I won't fetch ("${spec}"). Use gx-<a8>-<b8>.mp4 from the clips release.`);
  return `${VIDEO_ORIGIN}/${spec}`;
}
export const IMAGE_ORIGIN = "https://theagentforge.io";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The full URL of a post's image. Only PNG share cards under /og/ on theagentforge.io are allowed, so the pipeline
 * never fetches an arbitrary address. Throws for anything else.
 */
export function imageUrl(spec, n = "?") {
  const m = /^(?:https:\/\/theagentforge\.io)?(\/og(?:\/[A-Za-z0-9_-]+)+\.png)$/.exec(spec ?? "");
  if (!m) throw new Error(`Post ${n} has an image I won't fetch ("${spec}"). Use https://theagentforge.io/og/....png or /og/....png.`);
  return `${IMAGE_ORIGIN}${m[1]}`;
}

/**
 * Every ```post block in the issue body, numbered from 1, with its time (ms) or null for "as soon as approved", and
 * whether it replies to the block before it.
 */
export function parsePosts(body) {
  const out = [];
  const re = /^```post((?:[ \t]+\S+)*)[ \t\r]*\n([\s\S]*?)\r?\n```[ \t\r]*$/gm;
  let m;
  while ((m = re.exec(body ?? ""))) {
    const n = out.length + 1;
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    const reply = words.includes("reply");
    const times = words.filter((w) => w !== "reply");
    if (times.length > 1) throw new Error(`Post ${n} has more than one time ("${times.join(" ")}").`);
    if (reply && n === 1) throw new Error("Post 1 can't be a reply: there's no post before it.");
    let at = null;
    if (times[0]) {
      const spec = /^\d{4}-\d{2}-\d{2}$/.test(times[0]) ? `${times[0]}T${DEFAULT_SLOT_UTC}Z` : times[0];
      at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(spec) ? Date.parse(spec) : NaN;
      if (Number.isNaN(at)) throw new Error(`Post ${n} has a time I can't read ("${times[0]}"). Use 2026-10-15 or 2026-10-15T15:30Z.`);
    }
    const lines = m[2].replace(/\r\n/g, "\n").split("\n");
    const images = lines.filter((l) => IMAGE_LINE.test(l)).map((l) => IMAGE_LINE.exec(l)[1]);
    if (images.length > 1) throw new Error(`Post ${n} has more than one image line; X posts here take one image.`);
    const alts = lines.filter((l) => ALT_LINE.test(l)).map((l) => ALT_LINE.exec(l)[1]);
    const videos = lines.filter((l) => VIDEO_LINE.test(l)).map((l) => VIDEO_LINE.exec(l)[1]);
    const polls = lines.filter((l) => POLL_LINE.test(l)).map((l) => POLL_LINE.exec(l));
    if (videos.length > 1 || polls.length > 1) throw new Error(`Post ${n} has more than one video or poll line.`);
    if (alts.length > 1) throw new Error(`Post ${n} has more than one alt line.`);
    if (alts.length && !images.length) throw new Error(`Post ${n} has alt text but no image line.`);
    const text = lines.filter((l) => !IMAGE_LINE.test(l) && !ALT_LINE.test(l) && !VIDEO_LINE.test(l) && !POLL_LINE.test(l)).join("\n").trim();
    const poll = polls.length ? { options: polls[0][1].split("|").map((o) => o.trim()).filter(Boolean), duration_minutes: Number(polls[0][2]) } : null;
    out.push({
      n,
      at,
      reply,
      text,
      ...(images.length ? { image: images[0] } : {}),
      ...(alts.length ? { alt: alts[0] } : {}),
      ...(videos.length ? { video: videos[0] } : {}),
      ...(poll ? { poll } : {}),
    });
  }
  return out;
}

/** The first post's text (kept for single-post issues). */
export function extractPost(body) {
  return parsePosts(body)[0]?.text ?? null;
}

/** Checks every post before anything is sent, so a bad post never leaves the others half-done. */
export function validatePosts(posts) {
  if (!posts.length) throw new Error("No ```post block found in the issue body.");
  if (posts.length > MAX_POSTS_PER_ISSUE) throw new Error(`Too many posts in one issue (${posts.length}); the limit is ${MAX_POSTS_PER_ISSUE}.`);
  for (const p of posts) {
    if (!p.text) throw new Error(`Post ${p.n} is empty.`);
    const w = weightedLength(p.text);
    if (w > MAX_WEIGHT) throw new Error(`Post ${p.n} is ${w} characters as X counts them; the limit is ${MAX_WEIGHT} (${w - MAX_WEIGHT} too many).`);
    if (p.image !== undefined) imageUrl(p.image, p.n);
    if (p.alt !== undefined && (!p.alt || p.alt.length > MAX_ALT)) throw new Error(`Post ${p.n}'s alt text must be 1–${MAX_ALT} characters.`);
    if (p.video !== undefined) videoUrl(p.video, p.n);
    if (p.poll) {
      const [lo, hi] = POLL_LIMITS.options;
      const [mlo, mhi] = POLL_LIMITS.minutes;
      if (p.poll.options.length < lo || p.poll.options.length > hi) throw new Error(`Post ${p.n}'s poll needs ${lo}–${hi} options.`);
      if (p.poll.options.some((o) => o.length > POLL_LIMITS.chars)) throw new Error(`Post ${p.n}'s poll options must be ${POLL_LIMITS.chars} characters or fewer.`);
      if (!(p.poll.duration_minutes >= mlo && p.poll.duration_minutes <= mhi)) throw new Error(`Post ${p.n}'s poll must run ${mlo}–${mhi} minutes.`);
      if (p.image !== undefined || p.video !== undefined) throw new Error(`Post ${p.n} has a poll and media; X polls take no media.`);
    }
  }
}

/**
 * Fingerprint of what was approved: the posts, their times and images, not the surrounding notes. Posts without an
 * image hash exactly as before images existed, so schedules approved earlier still match.
 */
export const approvalHash = (posts) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        posts.map((p) => [p.at, p.text, ...(p.reply ? ["reply"] : []), ...(p.image !== undefined ? [`image:${p.image}`] : []), ...(p.alt !== undefined ? [`alt:${p.alt}`] : []), ...(p.video !== undefined ? [`video:${p.video}`] : []), ...(p.poll ? [`poll:${JSON.stringify(p.poll)}`] : [])]),
      ),
    )
    .digest("hex")
    .slice(0, 16);

const fmt = (ms) => {
  const d = new Date(ms);
  const utc = d.toISOString().slice(0, 16).replace("T", " ");
  const lk = new Date(ms + 5.5 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  return `${utc} UTC (${lk} Sri Lanka)`;
};

/** X counts every link as 23 characters and most other characters as 1 (CJK and emoji count 2). */
export function weightedLength(text) {
  let n = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    n += URL_WEIGHT;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0);
    n += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return n;
}

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * OAuth 1.0a Authorization header (HMAC-SHA1). A JSON body is not part of the signature; query and form-encoded body
 * parameters are, so pass them as `extra`.
 */
export function oauthHeader({ method, url, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp, extra = {} }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const all = { ...extra, ...oauth };
  const paramString = Object.keys(all)
    .map((k) => [enc(k), enc(all[k])])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join("&");
  const signature = createHmac("sha1", `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest("base64");
  return (
    "OAuth " +
    Object.entries({ ...oauth, oauth_signature: signature })
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(", ")
  );
}

function xCreds(env) {
  for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) {
    if (!env[k]) throw new Error(`Missing the ${k} secret in the repository's "social" environment.`);
  }
}

const signed = (env, method, url, extra) =>
  oauthHeader({ method, url, consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET, extra });

/** Fetches an allowed share card (PNG or JPEG, at most 5 MB). Redirects are refused, so the host can't change. */
export async function fetchImage(spec, fetcher = fetch) {
  const url = imageUrl(spec);
  const res = await fetcher(url, { redirect: "error" });
  if (!res.ok) throw new Error(`the image returned HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "image/png" && type !== "image/jpeg") throw new Error(`the image is ${type || "of no type"}, not PNG or JPEG`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new Error("the image is over 5 MB");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("the image is over 5 MB");
  if (!bytes.length) throw new Error("the image is empty");
  return { bytes, type };
}

/**
 * Uploads one image with X API v2 simple upload (POST /2/media/upload, JSON body with the file base64-encoded in
 * `media`, `media_category: "tweet_image"`) and returns its media id. The endpoint accepts OAuth 1.0a user context
 * ("Supported authentication types are [OAuth 1.0a User Context, OAuth 2.0 User Context]"); a JSON body is not part
 * of the OAuth signature. See https://docs.x.com/x-api/media/upload-media
 */
export async function uploadImage({ bytes, type }, env, fetcher = fetch) {
  xCreds(env);
  const url = "https://api.x.com/2/media/upload";
  const res = await fetcher(url, {
    method: "POST",
    headers: { Authorization: signed(env, "POST", url), "Content-Type": "application/json" },
    body: JSON.stringify({ media: Buffer.from(bytes).toString("base64"), media_category: "tweet_image", media_type: type }),
  });
  const data = await res.json().catch(() => ({}));
  const id = data?.data?.id;
  if (!res.ok || !id) throw new Error(`X refused the image upload (HTTP ${res.status}${data?.title ? `: ${data.title}` : ""})`);
  return String(id);
}

/** Downloads a Gauntlet clip from the public clips release (MP4, at most 15 MB). */
export async function fetchVideo(spec, fetcher = fetch) {
  const res = await fetcher(videoUrl(spec), { redirect: "follow" });
  if (!res.ok) throw new Error(`the clip returned HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error("the clip is empty");
  if (bytes.length > MAX_VIDEO_BYTES) throw new Error("the clip is over 15 MB");
  return bytes;
}

const CHUNK = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chunked video upload with X API v2 (§9.4): initialize, append each chunk (JSON, base64; JSON bodies aren't part of
 * the OAuth 1.0a signature), finalize, then wait for processing. Returns the media id. See
 * https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 */
export async function uploadVideo(bytes, env, fetcher = fetch, wait = sleep) {
  xCreds(env);
  const base = "https://api.x.com/2/media/upload";
  const call = async (url, body, method = "POST", extra = {}) => {
    const res = await fetcher(url, {
      method,
      headers: { Authorization: signed(env, method, url.split("?")[0], extra), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`X refused the video (${url.split("/").slice(-1)[0].split("?")[0]}: HTTP ${res.status}${data?.title ? `, ${data.title}` : ""})`);
    return data;
  };
  const init = await call(`${base}/initialize`, { media_type: "video/mp4", total_bytes: bytes.length, media_category: "tweet_video" });
  const id = init?.data?.id;
  if (!id) throw new Error("X gave no media id for the video");
  for (let i = 0, seg = 0; i < bytes.length; i += CHUNK, seg++) {
    await call(`${base}/${id}/append`, { media: Buffer.from(bytes.subarray(i, i + CHUNK)).toString("base64"), segment_index: seg });
  }
  let info = (await call(`${base}/${id}/finalize`, null))?.data?.processing_info;
  for (let tries = 0; info && info.state !== "succeeded"; tries++) {
    if (info.state === "failed" || tries >= 30) throw new Error(`X couldn't process the video (${info.state})`);
    await wait(Math.min(10, Number(info.check_after_secs) || 2) * 1000);
    const q = { command: "STATUS", media_id: id };
    info = (await call(`${base}?command=STATUS&media_id=${id}`, null, "GET", q))?.data?.processing_info;
  }
  return String(id);
}

/** Sets an uploaded image's alt text (POST /2/media/metadata). A failure never stops the post. */
export async function setAltText(mediaId, alt, env, fetcher = fetch) {
  xCreds(env);
  const url = "https://api.x.com/2/media/metadata";
  const res = await fetcher(url, {
    method: "POST",
    headers: { Authorization: signed(env, "POST", url), "Content-Type": "application/json" },
    body: JSON.stringify({ id: mediaId, metadata: { alt_text: { text: alt.slice(0, MAX_ALT) } } }),
  });
  if (!res.ok) throw new Error(`X refused the alt text (HTTP ${res.status})`);
}

/** Posts one text to X (as a reply when replyTo is a post id, with images when mediaIds are given) and returns its URL. */
export async function postText(text, env, fetcher = fetch, replyTo = null, mediaIds = [], poll = null) {
  xCreds(env);
  const url = "https://api.x.com/2/tweets";
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: oauthHeader({
        method: "POST",
        url,
        consumerKey: env.X_API_KEY,
        consumerSecret: env.X_API_SECRET,
        token: env.X_ACCESS_TOKEN,
        tokenSecret: env.X_ACCESS_SECRET,
      }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}),
      ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
      ...(poll ? { poll: { options: poll.options, duration_minutes: poll.duration_minutes } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.data?.id) {
    // Only X's error title and status go to the log: never echo request headers.
    throw new Error(`X refused the post (HTTP ${res.status}${data?.title ? `: ${data.title}` : ""}).`);
  }
  return `https://x.com/i/web/status/${data.data.id}`;
}

/** Single-post helper kept for compatibility: posts the first block of ISSUE_BODY. */
export async function post(env, fetcher = fetch) {
  const posts = parsePosts(env.ISSUE_BODY);
  validatePosts(posts);
  return postText(posts[0].text, env, fetcher);
}

// --- GitHub side -------------------------------------------------------------------------------------------------

const BOT = "github-actions[bot]";
/** Facts left by the drafter workflow (draft.mjs). Only a workflow in this repo can write as github-actions[bot]. */
export const DRAFT_MARK = /<!-- forge-draft (\{[\s\S]*?\}) -->/;
/** Who may open an auto issue: an admin, or this repo's own drafter workflow (ADR 0010 amendment, 20 Oct 2026). */
export const trustedAuthor = async (gh, issue) => (issue.user?.login === BOT && DRAFT_MARK.test(issue.body ?? "")) || (await isAdmin(gh, issue.user?.login ?? ""));
const APPROVED_MARK = /<!-- forge-approved ([0-9a-f]{16}) -->/;
const POSTED_MARK = /<!-- forge-posted (\d+) -->/g;
const POSTED_ID = /status\/(\d+) <!-- forge-posted (\d+) -->/g;

function github(env, fetcher) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  return async (method, path, body) => {
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${res.status}).`);
    return res.status === 204 ? null : res.json();
  };
}

/** Post numbers already sent, from the bot's own comments (only the workflow can write as github-actions[bot]). */
function postedNumbers(comments) {
  const done = new Set();
  for (const c of comments) if (c.user?.login === BOT) for (const m of c.body.matchAll(POSTED_MARK)) done.add(Number(m[1]));
  return done;
}

/** X post ids of posts already sent, by post number, from the bot's own comments. */
function postedIds(comments) {
  const ids = new Map();
  for (const c of comments) if (c.user?.login === BOT) for (const m of c.body.matchAll(POSTED_ID)) ids.set(Number(m[2]), m[1]);
  return ids;
}

/**
 * Sends every post that is due and not yet sent; then labels and closes the issue, or keeps it scheduled. A reply
 * waits until the post before it has gone out, so a thread is never posted out of order.
 */
/**
 * Adds ?from=x-post to theagentforge.io links that carry no from tag (social-strategy §9.8), when the post is sent, so
 * the approval fingerprint is unchanged. The digest counts arrivals by tag; X counts every link as 23 characters.
 */
export const tagXLinks = (text) =>
  text.replace(/https:\/\/theagentforge\.io(\/[^\s?#]*)?(\?[^\s#]*)?/g, (m, path = "", query = "") =>
    /[?&]from=/.test(query) ? m : `https://theagentforge.io${path}${query ? `${query}&` : "?"}from=x-post`,
  );

async function sendDue(gh, issue, posts, comments, env, fetcher, now, budget = null) {
  const done = postedNumbers(comments);
  const ids = postedIds(comments);
  for (const p of posts) {
    if (done.has(p.n) || (p.at !== null && p.at > now)) continue;
    const parent = p.reply ? ids.get(p.n - 1) : null;
    if (p.reply && !parent) continue;
    // The monthly X cap (ADR 0010) covers every post, approved or automatic.
    if (budget && budget.spent + postCost(p.text, p.image !== undefined) > MONTHLY_CAP_USD) throw new Error(`The monthly X budget ($${MONTHLY_CAP_USD}) is reached.`);
    // An image that can't be fetched or uploaded never stops the post: it goes out as text and the comment says so.
    let mediaIds = [];
    let imageNote = "";
    if (p.video !== undefined) {
      try {
        mediaIds = [await uploadVideo(await fetchVideo(p.video, fetcher), env, fetcher)];
        imageNote = " With the clip.";
      } catch (e) {
        imageNote = ` The clip didn't upload (${e.message}), so the card went instead.`;
      }
    }
    if (!mediaIds.length && p.image !== undefined) {
      try {
        mediaIds = [await uploadImage(await fetchImage(p.image, fetcher), env, fetcher)];
        if (p.alt) await setAltText(mediaIds[0], p.alt, env, fetcher).catch((e) => (imageNote = ` No alt text: ${e.message}.`));
      } catch (e) {
        imageNote = ` Posted without the image: ${e.message}.`;
      }
    }
    let url;
    try {
      url = await postText(tagXLinks(p.text), env, fetcher, parent, mediaIds, p.poll ?? null);
    } catch (e) {
      if (!mediaIds.length) throw e;
      // X refused the post with the image attached: send it as text rather than lose it.
      mediaIds = [];
      imageNote = ` Posted without the image: ${e.message.replace(/\.$/, "")}.`;
      url = await postText(tagXLinks(p.text), env, fetcher, parent, [], p.poll ?? null);
    }
    // A video upload is at least three writes (initialize, append, finalize); an image is one.
    const videoSent = p.video !== undefined && imageNote === " With the clip.";
    const cost = roundCost(postCost(p.text) + (mediaIds.length ? (videoSent ? 3 : 1) * COST_MEDIA_UPLOAD : 0));
    if (budget) budget.spent += cost;
    ids.set(p.n, url.split("/").at(-1));
    await gh("POST", `/issues/${issue}/comments`, {
      body: `Posted ${p.n} of ${posts.length}: ${url} <!-- forge-posted ${p.n} --> <!-- forge-cost ${cost} -->${videoSent ? imageNote : mediaIds.length ? ` With image.${imageNote}` : imageNote}`,
    });
    done.add(p.n);
  }
  const left = posts.filter((p) => !done.has(p.n));
  if (!left.length) {
    await gh("POST", `/issues/${issue}/labels`, { labels: ["posted"] });
    await gh("DELETE", `/issues/${issue}/labels/scheduled`).catch(() => {});
    await gh("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
  }
  return left;
}

/** An admin approved the issue (the workflow checked that). Post what's due, schedule the rest. */
export async function approve(env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const issue = env.ISSUE_NUMBER;
  const posts = parsePosts(env.ISSUE_BODY);
  validatePosts(posts);
  xCreds(env);
  const comments = await gh("GET", `/issues/${issue}/comments?per_page=100`);
  const left = await sendDue(gh, issue, posts, comments, env, fetcher, now, { spent: await spentThisMonth(gh, now) });
  const hash = approvalHash(posts);
  const already = comments.some((c) => c.user?.login === BOT && APPROVED_MARK.exec(c.body)?.[1] === hash);
  if (left.length && !already) {
    const list = left.map((p) => `- Post ${p.n}: ${fmt(p.at)}`).join("\n");
    await gh("POST", `/issues/${issue}/comments`, {
      body: `Approved. Scheduled:\n${list}\n\nEditing the posts or their times after this cancels the schedule until you approve again. <!-- forge-approved ${hash} -->`,
    });
    await gh("POST", `/issues/${issue}/labels`, { labels: ["scheduled"] });
  }
  return left.length;
}

// --- Auto-publish (ADR 0010 §2) -------------------------------------------------------------------------------------

/** No auto post goes out sooner than this after its issue was opened. */
export const HOLD_WINDOW_MS = 3 * 3_600_000;
export const MONTHLY_CAP_USD = 10;
export const AUTO_ISSUES_PER_DAY = 2;
/**
 * X API pay-per-use prices (ADR 0010; X changelog, effective 20 Apr 2026, https://docs.x.com/changelog and
 * https://docs.x.com/x-api/getting-started/pricing): a post with a link $0.20, any other post (text or media) $0.015.
 * The rate card has no separate line for media upload; we count each upload as one more $0.015 write, to stay on the
 * safe side of the cap. Reading posts (GET /2/tweets) is $0.005 per post returned. The cheaper $0.001 "owned reads"
 * apply to /2/users/{id}/... endpoints, not to this lookup, so we count $0.005.
 */
export const COST_LINK = 0.2;
export const COST_PLAIN = 0.015;
export const COST_MEDIA_UPLOAD = 0.015;
export const COST_READ = 0.005;
const roundCost = (x) => Math.round(x * 1000) / 1000;
/** Cost of one post; with `image`, the upload too (the estimate used before sending; a failed upload isn't charged). */
export const postCost = (text, image = false) => roundCost((/https?:\/\//.test(text) ? COST_LINK : COST_PLAIN) + (image ? COST_MEDIA_UPLOAD : 0));
const COST_MARK = /<!-- forge-cost (\d+(?:\.\d+)?) -->/;

/**
 * Topics that always need Dinike's explicit approve (ADR 0010 §2): tool flags and "caught" stories, incidents,
 * legal matters, money. A match sends the issue back to the approve path; it never auto-publishes.
 */
export const APPROVE_ONLY = [
  /\bflag(ged|s)?\b/i,
  /under review/i,
  /malicious/i,
  // "Caught by agents" stories about a tool (ADR 0010 §2). An Arena bout's "caught the trap" is a referee fact, not one.
  /\bcaught by (agents|our agents|independent|verified)\b/i,
  /\b(incident|breach|vulnerab\w*|exploit\w*|compromis\w*)\b/i,
  /\b(lawsuit|legal|court|takedown|dispute|dmca|defam\w*)\b/i,
  // Our money: pricing, payments to us, fundraising. "Paid the fake invoice" in a bout is a referee fact, not money.
  /\b(pric(e|es|ing)|subscription|fundrais\w*|investor|revenue|payments? to us)\b/i,
  /[$€£]\s?\d/,
];
export const approveOnlyReason = (posts) => {
  for (const p of posts) for (const re of APPROVE_ONLY) if (re.test(p.text)) return `post ${p.n} matches ${re}`;
  return null;
};

/** The issue's post type, from a `type:<slug>` label. Each new type's first post needs approve. */
export const postType = (issue) => issue.labels?.map((l) => l.name).find((n) => n.startsWith("type:")) ?? null;

/**
 * Whether an open auto issue may publish now, and why not if it can't. Pure: the GitHub facts are passed in.
 * `postedTypes` holds the types of posts already published; `autoToday` counts auto issues posted today.
 */
export function autoDecision({ issue, posts, authorIsAdmin, postedTypes, autoToday, spentThisMonth, now }) {
  const labels = new Set(issue.labels?.map((l) => l.name));
  if (labels.has("held")) return { ok: false, why: "held" };
  if (!authorIsAdmin) return { ok: false, why: "not written by an admin", close: true };
  if (!labels.has("verified")) return { ok: false, why: "waiting for the verifier" };
  const sensitive = approveOnlyReason(posts);
  if (sensitive) return { ok: false, why: `needs approve (${sensitive})`, toApprove: true };
  const type = postType(issue);
  if (!type) return { ok: false, why: "needs a type: label", toApprove: true };
  if (!postedTypes.has(type)) return { ok: false, why: `first post of ${type} needs approve`, toApprove: true };
  const opens = Date.parse(issue.created_at) + HOLD_WINDOW_MS;
  if (now < opens) return { ok: false, why: `hold window until ${new Date(opens).toISOString()}` };
  if (autoToday >= AUTO_ISSUES_PER_DAY) return { ok: false, why: "two auto posts already today" };
  const cost = posts.reduce((a, p) => a + postCost(p.text, p.image !== undefined), 0);
  if (spentThisMonth + cost > MONTHLY_CAP_USD) return { ok: false, why: "monthly X budget reached", capped: true };
  return { ok: true };
}

/** Auto posts never go out before the hold window, whatever time the draft gives. */
export const withHold = (posts, createdAt) => posts.map((p) => ({ ...p, at: Math.max(p.at ?? 0, Date.parse(createdAt) + HOLD_WINDOW_MS) }));

async function isAdmin(gh, login) {
  const r = await gh("GET", `/collaborators/${encodeURIComponent(login)}/permission`).catch(() => null);
  return r?.permission === "admin";
}

/** Dollars spent on X this month, from the cost marks the workflow leaves on each post it sends. */
async function spentThisMonth(gh, now) {
  const d = new Date(now);
  const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const cs = await gh("GET", `/issues/comments?since=${since}&per_page=100&page=${page}`);
    for (const c of cs) if (c.user?.login === BOT) total += Number(COST_MARK.exec(c.body)?.[1] ?? 0);
    if (cs.length < 100) break;
  }
  return total;
}

/** Scheduled run, auto half: publishes verified routine posts after their hold window (ADR 0010). */
export async function autoPublish(env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const log = [];
  const open = await gh("GET", `/issues?state=open&labels=post,auto&per_page=50`);
  if (!open.length) return log;
  const done = await gh("GET", `/issues?state=closed&labels=posted&per_page=100`);
  const postedTypes = new Set(done.map(postType).filter(Boolean));
  const today = new Date(now).toISOString().slice(0, 10);
  let autoToday = done.filter((i) => i.labels.some((l) => l.name === "auto") && (i.closed_at ?? "").startsWith(today)).length;
  let spent = await spentThisMonth(gh, now);
  for (const it of open) {
    if (it.pull_request || it.labels.some((l) => l.name === "posted")) continue;
    let posts;
    try {
      posts = parsePosts(it.body);
      validatePosts(posts);
    } catch (e) {
      log.push(`#${it.number}: ${e.message}`);
      continue;
    }
    const d = autoDecision({ issue: it, posts, authorIsAdmin: await trustedAuthor(gh, it), postedTypes, autoToday, spentThisMonth: spent, now });
    if (!d.ok) {
      log.push(`#${it.number}: ${d.why}`);
      if (d.toApprove) {
        await gh("DELETE", `/issues/${it.number}/labels/auto`).catch(() => {});
        await gh("POST", `/issues/${it.number}/comments`, { body: `Not auto-publishing: ${d.why}. Comment approve to post it. (ADR 0010)` });
      }
      if (d.capped) {
        const existing = await gh("GET", `/issues?state=open&labels=needs-dinike&per_page=50`);
        if (!existing.some((i) => i.title.startsWith("X budget reached"))) {
          await gh("POST", `/issues`, { title: `X budget reached ($${MONTHLY_CAP_USD} this month)`, labels: ["needs-dinike"], body: `Auto-publishing paused: X spend this month is about $${spent.toFixed(2)}. Raise the cap or wait for next month. (ADR 0010)` });
        }
        break;
      }
      continue;
    }
    const timed = withHold(posts, it.created_at);
    const comments = await gh("GET", `/issues/${it.number}/comments?per_page=100`);
    const budget = { spent };
    const left = await sendDue(gh, it.number, timed, comments, env, fetcher, now, budget);
    spent = budget.spent;
    if (!left.length) autoToday++;
    log.push(`#${it.number}: auto-published, ${left.length} left`);
  }
  return log;
}

/** An admin commented "hold" on an auto post: stop it until they remove the label. */
export async function hold(env, fetcher = fetch) {
  const gh = github(env, fetcher);
  await gh("POST", `/issues/${env.ISSUE_NUMBER}/labels`, { labels: ["held"] });
  await gh("POST", `/issues/${env.ISSUE_NUMBER}/comments`, { body: "Held. Nothing on this issue will auto-publish. Remove the `held` label to release it, or comment approve to post it now." });
  return 0;
}

/** Scheduled run: post everything that's due on issues the bot scheduled after an admin approval. */
export async function due(env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const issues = await gh("GET", `/issues?state=open&labels=scheduled&per_page=50`);
  const log = [];
  const budget = issues.length ? { spent: await spentThisMonth(gh, now) } : null;
  for (const it of issues) {
    if (it.pull_request || it.labels.some((l) => l.name === "posted")) continue;
    // The "scheduled" label must have been added by the workflow itself, never by hand.
    const events = await gh("GET", `/issues/${it.number}/events?per_page=100`);
    const labelled = events.filter((e) => e.event === "labeled" && e.label?.name === "scheduled").at(-1);
    if (labelled?.actor?.login !== BOT) {
      log.push(`#${it.number}: skipped, "scheduled" label not added by the workflow`);
      continue;
    }
    const comments = await gh("GET", `/issues/${it.number}/comments?per_page=100`);
    const approval = comments.filter((c) => c.user?.login === BOT && APPROVED_MARK.test(c.body)).at(-1);
    const posts = parsePosts(it.body);
    if (!approval || APPROVED_MARK.exec(approval.body)[1] !== approvalHash(posts)) {
      await gh("POST", `/issues/${it.number}/comments`, { body: "The posts changed after approval, so nothing more will be posted until you comment approve again." });
      await gh("DELETE", `/issues/${it.number}/labels/scheduled`).catch(() => {});
      log.push(`#${it.number}: changed after approval, schedule cancelled`);
      continue;
    }
    try {
      validatePosts(posts);
      const left = await sendDue(gh, it.number, posts, comments, env, fetcher, now, budget);
      log.push(`#${it.number}: ${left.length} left`);
    } catch (e) {
      await gh("POST", `/issues/${it.number}/comments`, { body: `Not posted: ${e.message} The schedule continues at the next run.` });
      log.push(`#${it.number}: ${e.message}`);
    }
  }
  return log;
}

// --- Daily post metrics -------------------------------------------------------------------------------------------

export const METRICS_TITLE = "X post metrics";
/**
 * Each post is measured when it is this many whole days old, not every day: reading all 30 days of posts daily at
 * $0.005 a post would eat a large share of the $10 monthly cap. Six reads a post cost $0.03 in all.
 */
export const METRICS_AGES_DAYS = [1, 2, 3, 7, 14, 28];
const DAY_MS = 86_400_000;
const METRICS_MARK = /<!-- forge-metrics (\d{4}-\d{2}-\d{2}) -->/;

/** Every post the bot recorded as sent in the last 30 days, oldest first, from its "Posted n of N" comments. */
export function postedFromComments(comments, issueNumbers, now) {
  const seen = new Map();
  for (const c of comments) {
    if (c.user?.login !== BOT) continue;
    const at = Date.parse(c.created_at);
    if (!(now - at <= 30 * DAY_MS)) continue;
    const issue = Number(String(c.issue_url ?? "").split("/").at(-1));
    if (!issueNumbers.has(issue)) continue;
    for (const m of c.body.matchAll(POSTED_ID)) if (!seen.has(m[1])) seen.set(m[1], { id: m[1], at, issue });
  }
  return [...seen.values()].sort((a, b) => a.at - b.at);
}

/** The posts due a reading today: those whose age in whole days is one of METRICS_AGES_DAYS. */
export const metricsDue = (posts, now) => posts.filter((p) => METRICS_AGES_DAYS.includes(Math.floor((now - p.at) / DAY_MS)));

async function paged(gh, path, pages = 10) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await gh("GET", `${path}&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * Reads posts from X in batches of 100 (GET /2/tweets). Private metrics (impressions, link clicks) need user context
 * and only work for our own posts under 30 days old; if X refuses them, the batch is read again with public metrics
 * only. Returns the posts read and whether private metrics were available.
 */
export async function fetchMetrics(ids, env, fetcher = fetch) {
  xCreds(env);
  const base = "https://api.x.com/2/tweets";
  const tweets = [];
  let nonPublic = true;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const get = async (fields) => {
      const q = { ids: batch.join(","), "tweet.fields": fields };
      const res = await fetcher(`${base}?${Object.entries(q).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&")}`, {
        headers: { Authorization: signed(env, "GET", base, q) },
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    };
    let r = nonPublic ? await get("public_metrics,non_public_metrics,created_at") : null;
    // Refused outright, or answered with errors and no posts at all (how X reports fields we may not read).
    if (!r?.ok || (!Array.isArray(r.data?.data) && r.data?.errors)) {
      nonPublic = false;
      r = await get("public_metrics,created_at");
    }
    if (!r.ok) throw new Error(`X refused the metrics read (HTTP ${r.status}${r.data?.title ? `: ${r.data.title}` : ""}).`);
    tweets.push(...(r.data.data ?? []));
  }
  return { tweets, nonPublic };
}

const num = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : "–");

/** The day's Markdown comment: one row per post read. */
export function metricsComment(day, rows, cost, nonPublic) {
  const head = "| Post | Posted | Impressions | Likes | Reposts | Replies | Quotes | Bookmarks | Link clicks |\n|---|---|--:|--:|--:|--:|--:|--:|--:|";
  const lines = rows.map(({ id, at, tweet }) => {
    const pub = tweet?.public_metrics ?? {};
    const priv = tweet?.non_public_metrics ?? {};
    const date = (tweet?.created_at ?? new Date(at).toISOString()).slice(0, 10);
    const cells = [priv.impression_count ?? pub.impression_count, pub.like_count, pub.retweet_count, pub.reply_count, pub.quote_count, pub.bookmark_count, priv.url_link_clicks];
    return `| [${id}](https://x.com/i/web/status/${id}) | ${date} | ${tweet ? cells.map(num).join(" | ") : "not found on X | – | – | – | – | – | –"} |`;
  });
  const note = nonPublic ? "" : " X didn't return private metrics today, so link clicks (and maybe impressions) are blank.";
  return `X post metrics for ${day} (posts ${METRICS_AGES_DAYS.join(", ")} days old).\n\n${head}\n${lines.join("\n")}\n\nRead ${rows.length} post(s) from X for about $${cost}.${note} <!-- forge-metrics ${day} --> <!-- forge-cost ${cost} -->`;
}

/** Daily: reads the numbers of recent posts from X and comments one table on the "X post metrics" issue. */
export async function metrics(env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const day = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - 30 * DAY_MS).toISOString();
  const issues = await paged(gh, `/issues?state=all&labels=post&since=${since}&per_page=100`);
  const numbers = new Set(issues.filter((i) => !i.pull_request).map((i) => i.number));
  const comments = await paged(gh, `/issues/comments?since=${since}&per_page=100`);
  const due = metricsDue(postedFromComments(comments, numbers, now), now);
  if (!due.length) return [`${day}: no posts due a reading`];

  const tracking = (await gh("GET", `/issues?state=all&labels=metrics&per_page=100`)).find((i) => i.title === METRICS_TITLE && !i.pull_request);
  const issue =
    tracking?.number ??
    (await gh("POST", `/issues`, { title: METRICS_TITLE, labels: ["metrics"], body: "One comment a day with the numbers of recent X posts, written by `.github/workflows/post-to-x.yml` (docs/runbooks/posting.md). Don't label this issue `post`." })).number;
  const todays = await gh("GET", `/issues/${issue}/comments?since=${day}T00:00:00Z&per_page=100`);
  if (todays.some((c) => c.user?.login === BOT && METRICS_MARK.exec(c.body)?.[1] === day)) return [`${day}: already measured today`];

  // The monthly X cap (ADR 0010) covers reads too; the estimate assumes every post comes back.
  const spent = await spentThisMonth(gh, now);
  if (spent + roundCost(due.length * COST_READ) > MONTHLY_CAP_USD) return [`${day}: skipped, the monthly X budget ($${MONTHLY_CAP_USD}) is reached`];

  const { tweets, nonPublic } = await fetchMetrics(due.map((p) => p.id), env, fetcher);
  const byId = new Map(tweets.map((t) => [String(t.id), t]));
  const cost = roundCost(tweets.length * COST_READ);
  await gh("POST", `/issues/${issue}/comments`, { body: metricsComment(day, due.map((p) => ({ ...p, tweet: byId.get(p.id) })), cost, nonPublic) });
  return [`${day}: measured ${tweets.length} of ${due.length} post(s) for $${cost}`];
}

// --- Profile (bio, website, header image), approve-gated like posts ----------------------------------------------

export const PROFILE_LIMITS = { name: 50, bio: 160 };

/**
 * A profile issue (label "profile") holds ```name, ```bio, ```url and ```banner blocks; any can be left out. The
 * banner block names a PNG in this repository, under public/brand/social/.
 */
export function parseProfile(body) {
  const out = {};
  for (const m of (body ?? "").matchAll(/```(name|bio|url|banner)[^\S\n]*\n([\s\S]*?)\n```/g)) out[m[1]] = m[2].trim();
  if (!Object.keys(out).length) throw new Error("No ```name, ```bio, ```url or ```banner block found.");
  if (out.name !== undefined && (!out.name || [...out.name].length > PROFILE_LIMITS.name)) throw new Error(`The name must be 1–${PROFILE_LIMITS.name} characters.`);
  if (out.bio !== undefined && [...out.bio].length > PROFILE_LIMITS.bio) throw new Error(`The bio is ${[...out.bio].length} characters; X allows ${PROFILE_LIMITS.bio}.`);
  if (out.url !== undefined && !/^https:\/\/[a-z0-9.-]+(\/\S*)?$/i.test(out.url)) throw new Error("The website must be a plain https:// address.");
  if (out.banner !== undefined && !/^apps\/forge\/public\/brand\/social\/[a-z0-9-]+\.png$/.test(out.banner)) throw new Error("The banner must be a PNG under apps/forge/public/brand/social/.");
  return out;
}

async function signedForm(env, fetcher, url, form) {
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: oauthHeader({ method: "POST", url, consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET, extra: form }),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: Object.entries(form).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const why = data?.errors?.[0]?.message ?? data?.title ?? "";
    throw new Error(`X refused (HTTP ${res.status}${why ? `: ${why}` : ""}).`);
  }
}

/** An admin approved a profile issue: update the bio, website and name, then the header image. */
export async function approveProfile(env, fetcher = fetch, readFile = (p) => import("node:fs").then((fs) => fs.readFileSync(p))) {
  const gh = github(env, fetcher);
  const issue = env.ISSUE_NUMBER;
  const p = parseProfile(env.ISSUE_BODY);
  xCreds(env);
  const done = [];
  try {
    const form = {};
    if (p.name !== undefined) form.name = p.name;
    if (p.bio !== undefined) form.description = p.bio;
    if (p.url !== undefined) form.url = p.url;
    if (Object.keys(form).length) {
      await signedForm(env, fetcher, "https://api.x.com/1.1/account/update_profile.json", form);
      done.push(Object.keys(form).map((k) => (k === "description" ? "bio" : k)).join(", "));
    }
    if (p.banner !== undefined) {
      const png = await readFile(`${env.GITHUB_WORKSPACE ?? "."}/${p.banner}`);
      await signedForm(env, fetcher, "https://api.x.com/1.1/account/update_profile_banner.json", { banner: Buffer.from(png).toString("base64") });
      done.push("header image");
    }
  } catch (e) {
    await gh("POST", `/issues/${issue}/comments`, {
      body: `${done.length ? `Updated: ${done.join("; ")}. ` : ""}${e.message} Our X plan may not allow profile changes through the API. To do it by hand (2 minutes): on x.com open your profile → **Edit profile**, paste the bio and website from this issue, and upload the header image from the link in this issue.`,
    });
    throw e;
  }
  await gh("POST", `/issues/${issue}/comments`, { body: `Profile updated: ${done.join("; ")}.` });
  await gh("POST", `/issues/${issue}/labels`, { labels: ["posted"] });
  await gh("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const run =
    mode === "approve"
      ? approve(process.env)
      : mode === "profile"
        ? approveProfile(process.env)
      : mode === "due"
        ? due(process.env).then(async (a) => [...a, ...(await autoPublish(process.env))])
        : mode === "hold"
          ? hold(process.env)
          : mode === "metrics"
            ? metrics(process.env)
            : Promise.reject(new Error("usage: approve | profile | due | hold | metrics"));
  run
    .then((r) => console.log(Array.isArray(r) ? r.join("\n") || "nothing scheduled" : `${r} post(s) still scheduled`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
