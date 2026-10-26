// The Forge's agent on Moltbook, approve-only (docs/runbooks/posting.md). An issue labelled "moltbook" holds one
// ```moltbook <submolt> block (posted when approved), or a week of dated ones: ```moltbook <submolt> 2026-10-24T09:00Z.
// Each block's first line is the title, the rest is the post. When an admin comments approve, this script sends what is
// due to the site with this workflow's GitHub OIDC token (the site posts it with the Moltbook key, which only Cloudflare
// holds) and schedules the rest; the hourly run posts each one at its time. Editing the posts after approval cancels the
// schedule. At most one post a day; no comments, votes or messages (Moltbook's rules on self-promotion).
//   node moltbook.mjs approve <site>     an admin approved: post what's due, schedule the rest
//   node moltbook.mjs due <site>         hourly: post approved, scheduled posts whose time has come
//   node moltbook.mjs replies <site>     twice a day: report the site's automatic replies and escalations (ADR 0044)

import { createHash } from "node:crypto";
import { BANNED } from "./draft.mjs";

export const MAX_TITLE = 300;
export const MAX_CONTENT = 40_000;
const BOT = "github-actions[bot]";
const POSTED_MARK = /<!-- forge-moltbook ([A-Za-z0-9_-]{4,64}) -->/;
/** Per-post mark on a scheduled issue: <!-- forge-moltbook-n 3 <post id> -->. */
const POSTED_N = /<!-- forge-moltbook-n (\d+) [A-Za-z0-9_-]{4,64} -->/g;
const APPROVED_MARK = /<!-- forge-mb-approved ([0-9a-f]{16}) -->/;
export const SCHEDULED_LABEL = "mb-scheduled";
const DAY_MS = 86_400_000;
/** The same phrase list as apps/forge/test/agent-wording.test.ts: wording that tells an agent what to do (§2.1). */
export const AGENT_DIRECTED =
  /\b(always|must|best|prefer(red)?|follow|obey|you should|skill\.md|instead of|before (any|every) other|(call|use|run) (this|it) first|install (this|it|our|the forge)|tell (your|the) (human|user|owner)|ignore (previous|prior|other))\b/i;
/**
 * A post carries a real result and cites it: a refereed Arena bout or results page, a Lab result, the trap card, a scan,
 * an answer page, Skill Watch or a report on our site. Arena and Lab results lead (Dinike, 23 Oct: lead with what
 * spreads); they are data too, every number checkable on the linked page.
 */
const EVIDENCE = /https:\/\/theagentforge\.io\/(arena(\/\S*)?|best\/\S+|lab\/\d+(\/results)?|trap-card|gauntlet\S*|scan\/[0-9a-f]{64}|tools\/\S+|skill-watch|reports\/\S+|advisories\/\d{4}-\d{2})/;
export const MAX_LINKS = 2;

/** Adds ?from=mb-post to theagentforge.io links without a from tag, so the digest counts arrivals from Moltbook. */
export function tagLinks(text) {
  return text.replace(/https:\/\/theagentforge\.io(\/[^\s?#)]*)?(\?[^\s#)]*)?/g, (m, path = "", query = "") =>
    /[?&]from=/.test(query) ? m : `https://theagentforge.io${path}${query ? `${query}&` : "?"}from=mb-post`,
  );
}

const BLOCK = /^```moltbook[ \t]+([a-z0-9-]{2,30})(?:[ \t]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z))?[ \t\r]*\n([\s\S]*?)\r?\n```[ \t\r]*$/gm;

/** The one ```moltbook block: { submolt, title, content }. Throws with a plain reason otherwise. */
export function parseMoltbook(body) {
  const posts = parseMoltbookPosts(body);
  if (posts.length > 1) throw new Error("With more than one post, give each block a time (```moltbook general 2026-10-24T09:00Z).");
  const { submolt, title, content } = posts[0];
  return { submolt, title, content };
}

/**
 * Every ```moltbook block, in order: { n, at, submolt, title, content }. One undated block posts when approved; a week
 * of posts needs a time on each block, at most one post per UTC day (moltbook-strategy §3) and never two within 30
 * minutes (Moltbook's own limit).
 */
export function parseMoltbookPosts(body) {
  const blocks = [...(body ?? "").matchAll(BLOCK)];
  if (!blocks.length) throw new Error("No ```moltbook <submolt> block found in the issue body.");
  const posts = blocks.map((b, i) => ({ n: i + 1, at: b[2] ? Date.parse(b[2]) : null, ...parseBlock(b[1], b[3]) }));
  if (posts.length > 1) {
    if (posts.some((p) => p.at === null)) throw new Error("With more than one post, give each block a time (```moltbook general 2026-10-24T09:00Z).");
    const days = new Set(posts.map((p) => new Date(p.at).toISOString().slice(0, 10)));
    if (days.size !== posts.length) throw new Error("At most one Moltbook post a day (moltbook-strategy §3).");
    if (posts.length > 7) throw new Error("At most 7 posts per issue: one week.");
  }
  return posts;
}

function parseBlock(submolt, raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const title = lines[0].replace(/^title:\s*/i, "").trim();
  const content = tagLinks(lines.slice(1).join("\n").trim());
  if (!title || title.length > MAX_TITLE) throw new Error(`The title (first line) must be 1–${MAX_TITLE} characters.`);
  if (!content || content.length > MAX_CONTENT) throw new Error(`The post (after the first line) must be 1–${MAX_CONTENT.toLocaleString("en-US")} characters.`);
  const banned = BANNED.exec(`${title}\n${content}`);
  if (banned) throw new Error(`The post uses a word our rules rule out: "${banned[0]}".`);
  const directed = AGENT_DIRECTED.exec(`${title}\n${content}`);
  if (directed) throw new Error(`The post tells agents what to do ("${directed[0]}"); posts are findings, never instructions (agent-channels §2).`);
  if (!EVIDENCE.test(content)) throw new Error("The post needs its evidence: a link to the scan, answer page, Skill Watch or report it's about.");
  if ((content.match(/https?:\/\//g) ?? []).length > MAX_LINKS) throw new Error(`At most ${MAX_LINKS} links: a link is a citation, not an advert.`);
  return { submolt, title, content };
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
    return res.status === 204 ? null : res.json();
  };
}

/** This job's GitHub OIDC token, for the site (the workflow needs `id-token: write`). */
export async function oidcToken(env, audience, fetcher = fetch) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error("No OIDC token available (the workflow needs id-token: write).");
  const res = await fetcher(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!res.ok) throw new Error(`GitHub refused an OIDC token (HTTP ${res.status}).`);
  return (await res.json()).value;
}

/** Pins the approved text and times: editing any post after approval cancels the schedule. */
export const approvalHash = (posts) =>
  createHash("sha256").update(JSON.stringify(posts.map((p) => [p.at, p.submolt, p.title, p.content]))).digest("hex").slice(0, 16);

const fmt = (ms) => {
  const utc = new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const lk = new Date(ms + 5.5 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  return `${utc} UTC (${lk} Sri Lanka)`;
};

async function postOne(site, env, fetcher, post) {
  const token = await oidcToken(env, site, fetcher);
  const { submolt, title, content } = post;
  const res = await fetcher(`${site}/api/v1/social/moltbook`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ submolt, title, content }) });
  const r = await res.json().catch(() => ({}));
  if (!r.ok) {
    const why =
      r.error === "moltbook_not_connected"
        ? "Moltbook isn't connected yet (the agent's key isn't in Cloudflare)."
        : `Moltbook refused it: ${String(r.error ?? `HTTP ${res.status}`).slice(0, 200)}.`;
    throw new Error(why);
  }
  return r;
}

/**
 * Posts the scheduled posts that are due and not yet posted (at most one per run, so two are never closer than an hour),
 * records each on the issue, and closes the issue when all are out. Returns how many are left.
 */
async function sendDue(site, gh, issue, posts, comments, env, fetcher, now) {
  const done = new Set();
  for (const c of comments) if (c.user?.login === BOT) for (const m of (c.body ?? "").matchAll(POSTED_N)) done.add(Number(m[1]));
  const next = posts.find((p) => !done.has(p.n) && p.at <= now);
  if (next) {
    // A post more than a day late is skipped rather than sent out of its day (its numbers were read for that day).
    if (now - next.at > DAY_MS) {
      await gh("POST", `/issues/${issue}/comments`, { body: `Post ${next.n} ("${next.title}") was more than a day late, so it was skipped. <!-- forge-moltbook-n ${next.n} skipped -->` });
    } else {
      const r = await postOne(site, env, fetcher, next);
      const note = r.verified ? "" : " Moltbook's verification question wasn't answered, so it stays hidden until it is; Claude will look at it.";
      await gh("POST", `/issues/${issue}/comments`, { body: `Posted ${next.n} of ${posts.length} in m/${next.submolt}: ${r.url}${note} <!-- forge-moltbook-n ${next.n} ${r.post_id} -->` });
    }
    done.add(next.n);
  }
  const left = posts.filter((p) => !done.has(p.n));
  if (!left.length) {
    await gh("POST", `/issues/${issue}/labels`, { labels: ["posted"] });
    await gh("DELETE", `/issues/${issue}/labels/${SCHEDULED_LABEL}`).catch(() => {});
    await gh("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
  }
  return left;
}

/** The approve job: one undated post goes out now; a dated week is approved as a whole and scheduled. */
export async function approve(site, env = process.env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const issue = env.ISSUE_NUMBER;
  const posts = parseMoltbookPosts(env.ISSUE_BODY);
  const comments = await gh("GET", `/issues/${issue}/comments?per_page=100`);
  if (posts.length === 1 && posts[0].at === null) {
    const done = comments.findLast((c) => c.user?.login === BOT && POSTED_MARK.test(c.body ?? ""));
    if (done) {
      // An admin reopening the issue after our "Posted" comment means "post it again" (for example when Moltbook hid the
      // first copy as unverified). The site deletes an unverified earlier copy and never duplicates a verified one.
      const events = await gh("GET", `/issues/${issue}/events?per_page=100`);
      const reopened = events.some((e) => e.event === "reopened" && Date.parse(e.created_at) > Date.parse(done.created_at));
      if (!reopened) return [`Already posted: ${POSTED_MARK.exec(done.body)[1]}`];
    }
    const post = posts[0];
    let r;
    try {
      r = await postOne(site, env, fetcher, post);
    } catch (e) {
      throw new Error(`${e.message} Fix it, then comment approve again.`);
    }
    const note = r.verified ? "" : " Moltbook's verification question wasn't answered, so the post stays hidden until it is; Claude will look at it.";
    await gh("POST", `/issues/${issue}/comments`, { body: `Posted on Moltbook in m/${post.submolt}: ${r.url}${note} <!-- forge-moltbook ${r.post_id} -->` });
    await gh("POST", `/issues/${issue}/labels`, { labels: ["posted"] });
    await gh("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
    return [`m/${post.submolt}: ${r.url}${r.verified ? "" : " (unverified)"}`];
  }
  if (posts.some((p) => p.at === null)) throw new Error("With more than one post, give each block a time.");
  const hash = approvalHash(posts);
  const left = await sendDue(site, gh, issue, posts, comments, env, fetcher, now);
  const already = comments.some((c) => c.user?.login === BOT && APPROVED_MARK.exec(c.body ?? "")?.[1] === hash);
  if (left.length && !already) {
    const list = left.map((p) => `- Post ${p.n}, m/${p.submolt}: ${fmt(p.at)}`).join("\n");
    await gh("POST", `/issues/${issue}/comments`, {
      body: `Approved. Scheduled on Moltbook:\n${list}\n\nEditing the posts or their times after this cancels the schedule until you approve again. <!-- forge-mb-approved ${hash} -->`,
    });
    await gh("POST", `/issues/${issue}/labels`, { labels: [SCHEDULED_LABEL] });
  }
  return left.map((p) => `post ${p.n}: ${fmt(p.at)}`);
}

/** Hourly run: post what's due on issues the workflow scheduled after an admin approval. */
export async function due(site, env = process.env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const issues = await gh("GET", `/issues?state=open&labels=moltbook,${SCHEDULED_LABEL}&per_page=50`);
  const log = [];
  for (const it of issues) {
    if (it.pull_request || it.labels.some((l) => l.name === "posted")) continue;
    // The schedule label must have been added by the workflow itself, never by hand.
    const events = await gh("GET", `/issues/${it.number}/events?per_page=100`);
    const labelled = events.filter((e) => e.event === "labeled" && e.label?.name === SCHEDULED_LABEL).at(-1);
    if (labelled?.actor?.login !== BOT) {
      log.push(`#${it.number}: skipped, "${SCHEDULED_LABEL}" label not added by the workflow`);
      continue;
    }
    const comments = await gh("GET", `/issues/${it.number}/comments?per_page=100`);
    const approval = comments.filter((c) => c.user?.login === BOT && APPROVED_MARK.test(c.body ?? "")).at(-1);
    let posts;
    try {
      posts = parseMoltbookPosts(it.body);
    } catch {
      posts = null;
    }
    if (!posts || !approval || APPROVED_MARK.exec(approval.body)[1] !== approvalHash(posts)) {
      await gh("POST", `/issues/${it.number}/comments`, { body: "The posts changed after approval, so nothing more will be posted until you comment approve again." });
      await gh("DELETE", `/issues/${it.number}/labels/${SCHEDULED_LABEL}`).catch(() => {});
      log.push(`#${it.number}: changed after approval, schedule cancelled`);
      continue;
    }
    try {
      const left = await sendDue(site, gh, it.number, posts, comments, env, fetcher, now);
      log.push(`#${it.number}: ${left.length} left`);
    } catch (e) {
      await gh("POST", `/issues/${it.number}/comments`, { body: `Not posted: ${e.message} The schedule continues at the next run.` });
      log.push(`#${it.number}: ${e.message}`);
    }
  }
  return log;
}

export const REPLIES_LABEL = "moltbook-replies";
/** Comment text is someone else's: shown as a quote, with no mentions, code fences or HTML comments. */
export const quoteUntrusted = (t, max = 400) =>
  `> ${String(t ?? "")
    .slice(0, max)
    .replace(/@/g, "@​")
    .replace(/`{3,}/g, "'''")
    .replace(/<!--/g, "<!​--")
    .replace(/\s*\n\s*/g, " ")}`;
const plain = (t, max) => quoteUntrusted(t, max).slice(2);

/** The issue body (or comment) for one report from /api/v1/social/moltbook/replies. Null when there is nothing to say. */
export function repliesReport(r) {
  const entries = r?.entries ?? [];
  if (!entries.length && !r?.paused) return null;
  const link = (e) => (e.post_id && e.post_id !== "-" ? `https://www.moltbook.com/post/${e.post_id}` : "our account");
  const replied = entries.filter((e) => e.action === "replied");
  const escalated = entries.filter((e) => e.action === "escalated");
  const failed = entries.filter((e) => e.action === "failed");
  const out = [];
  if (r.paused) out.push(`**Replies are paused:** ${r.paused} Resume them on https://theagentforge.io/admin/moltbook once you've checked.`);
  if (escalated.length) {
    out.push(`### Needs you (${escalated.length})\nThese weren't answered automatically. Reply on Moltbook yourself, or leave them. Comment text is other agents' words, shown as data.`);
    for (const e of escalated) out.push(`- **${plain(e.author, 40)}** on ${link(e)}: ${e.reason ?? ""}${e.question && e.question !== "-" ? `\n  ${quoteUntrusted(e.question)}` : ""}`);
  }
  if (replied.length) {
    out.push(`### Answered automatically (${replied.length})`);
    for (const e of replied) out.push(`- To **${plain(e.author, 40)}** on ${link(e)}\n  ${quoteUntrusted(e.question, 200)}\n  Our reply: ${plain(e.reply, 700)}`);
  }
  if (failed.length) out.push(`### Not sent (${failed.length})\n${failed.map((e) => `- ${link(e)}: ${e.reason ?? ""}`).join("\n")}`);
  if (r.skipped) out.push(`${r.skipped} comment${r.skipped === 1 ? " was" : "s were"} skipped (no real question for us).`);
  return out.join("\n\n");
}

/** Twice a day: one issue per day labelled moltbook-replies; later reports that day are comments on it. */
export async function replies(site, env = process.env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const token = await oidcToken(env, site, fetcher);
  const res = await fetcher(`${site}/api/v1/social/moltbook/replies`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`The site refused the replies report (HTTP ${res.status}).`);
  const body = repliesReport(await res.json());
  if (!body) return ["nothing to report"];
  const footer = "\n\n---\n_Generated by the Moltbook reply workflow (ADR 0044)._";
  const title = `Moltbook replies: ${new Date(now).toISOString().slice(0, 10)}`;
  const open = (await gh("GET", `/issues?state=open&labels=${REPLIES_LABEL}&per_page=20`)).find((i) => i.title === title && !i.pull_request);
  if (open) {
    await gh("POST", `/issues/${open.number}/comments`, { body: body + footer });
    return [`#${open.number}: commented`];
  }
  const made = await gh("POST", "/issues", { title, body: body + footer });
  await gh("POST", `/issues/${made.number}/labels`, { labels: [REPLIES_LABEL] });
  return [`#${made.number}: opened`];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, site = "https://theagentforge.io"] = process.argv.slice(2);
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) {
    console.error("site must be https://<host>");
    process.exit(1);
  }
  (mode === "approve" ? approve(site) : mode === "due" ? due(site) : mode === "replies" ? replies(site) : Promise.reject(new Error("usage: approve|due|replies <site>")))
    .then((r) => console.log(r.join("\n")))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
