// Approve-to-post and auto-publish: posts the text from GitHub issues to X (docs/runbooks/posting.md, ADR 0010).
//   node post-to-x.mjs approve   an admin approved the issue: post what's due now, schedule the rest
//   node post-to-x.mjs due       scheduled run: post approved posts whose time has come, then auto-publish
//                                 verified routine posts whose 3-hour hold window has passed
//   node post-to-x.mjs hold      an admin commented "hold" on an auto post: stop it
// An issue holds one or more ```post blocks. A block may carry a time: ```post 2026-10-15 (posted at the daily
// slot, 13:05 UTC) or ```post 2026-10-15T15:30Z. Add the word "reply" (```post 2026-10-20 reply) to post it as a reply
// to the block before it, so a thread stays connected on X. Uses OAuth 1.0a user context against POST /2/tweets and the
// GitHub REST API with the workflow's token. No dependencies.
import { createHash, createHmac, randomBytes } from "node:crypto";

export const MAX_WEIGHT = 280;
const URL_WEIGHT = 23;

/** Default time of day for date-only posts: 13:00 UTC (9 am US Eastern in summer, 6:30 pm Sri Lanka). */
export const DEFAULT_SLOT_UTC = "13:00";
export const MAX_POSTS_PER_ISSUE = 14;

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
    out.push({ n, at, reply, text: m[2].replace(/\r\n/g, "\n").trim() });
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
  }
}

/** Fingerprint of what was approved: the posts and their times, not the surrounding notes. */
export const approvalHash = (posts) =>
  createHash("sha256")
    .update(JSON.stringify(posts.map((p) => (p.reply ? [p.at, p.text, "reply"] : [p.at, p.text]))))
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

/** Posts one text to X (as a reply when replyTo is a post id) and returns its URL. */
export async function postText(text, env, fetcher = fetch, replyTo = null) {
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
    body: JSON.stringify(replyTo ? { text, reply: { in_reply_to_tweet_id: replyTo } } : { text }),
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
async function sendDue(gh, issue, posts, comments, env, fetcher, now, budget = null) {
  const done = postedNumbers(comments);
  const ids = postedIds(comments);
  for (const p of posts) {
    if (done.has(p.n) || (p.at !== null && p.at > now)) continue;
    const parent = p.reply ? ids.get(p.n - 1) : null;
    if (p.reply && !parent) continue;
    // The monthly X cap (ADR 0010) covers every post, approved or automatic.
    if (budget && budget.spent + postCost(p.text) > MONTHLY_CAP_USD) throw new Error(`The monthly X budget ($${MONTHLY_CAP_USD}) is reached.`);
    const url = await postText(p.text, env, fetcher, parent);
    if (budget) budget.spent += postCost(p.text);
    ids.set(p.n, url.split("/").at(-1));
    await gh("POST", `/issues/${issue}/comments`, { body: `Posted ${p.n} of ${posts.length}: ${url} <!-- forge-posted ${p.n} --> <!-- forge-cost ${postCost(p.text)} -->` });
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
/** X API prices (ADR 0010): a post with a link, and a plain post. */
export const COST_LINK = 0.2;
export const COST_PLAIN = 0.015;
export const postCost = (text) => (/https?:\/\//.test(text) ? COST_LINK : COST_PLAIN);
const COST_MARK = /<!-- forge-cost (\d+(?:\.\d+)?) -->/;

/**
 * Topics that always need Dinike's explicit approve (ADR 0010 §2): tool flags and "caught" stories, incidents,
 * legal matters, money. A match sends the issue back to the approve path; it never auto-publishes.
 */
export const APPROVE_ONLY = [
  /\bflag(ged|s)?\b/i,
  /under review/i,
  /malicious/i,
  /\bcaught\b/i,
  /\b(incident|breach|vulnerab\w*|exploit\w*|compromis\w*)\b/i,
  /\b(lawsuit|legal|court|takedown|dispute|dmca|defam\w*)\b/i,
  /\b(pric(e|es|ing)|paid|payment|subscription|fundrais\w*|investor|revenue)\b/i,
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
  const cost = posts.reduce((a, p) => a + postCost(p.text), 0);
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
    const d = autoDecision({ issue: it, posts, authorIsAdmin: await isAdmin(gh, it.user?.login ?? ""), postedTypes, autoToday, spentThisMonth: spent, now });
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
          : Promise.reject(new Error("usage: approve | profile | due | hold"));
  run
    .then((r) => console.log(Array.isArray(r) ? r.join("\n") || "nothing scheduled" : `${r} post(s) still scheduled`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
