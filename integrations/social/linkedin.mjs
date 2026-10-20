// LinkedIn through Buffer (docs/launch/social-strategy.md §9.7). An issue labelled "linkedin" holds one or more
// ```linkedin blocks; when an admin comments approve, each block is scheduled in Buffer for its time. LinkedIn posts
// speak as Dinike, so they never auto-publish: approve is the only path (ADR 0010 amendment, 20 Oct 2026).
//   node linkedin.mjs approve      the approve job: schedule this issue's LinkedIn blocks in Buffer
//
// Block header: ```linkedin [profile|page] [2026-10-23 | 2026-10-23T14:00Z]
//   profile / page: which Buffer channel (repository variables BUFFER_LINKEDIN_PROFILE / BUFFER_LINKEDIN_PAGE hold the
//   channel ids); with neither, every LinkedIn channel in Buffer gets it. No time: Buffer's next free queue slot.
// Lines inside a block: the text, plus optional `image: /og/....png` (a theagentforge.io share card).
// Off (says so once on the issue) until Dinike adds BUFFER_API_KEY as a secret.

import { createHash } from "node:crypto";
import { DEFAULT_SLOT_UTC, imageUrl } from "./post-to-x.mjs";

export const BUFFER_API = "https://api.buffer.com";
/** LinkedIn's post limit. */
export const MAX_CHARS = 3000;
export const MAX_BLOCKS = 7;
const IMAGE_LINE = /^[ \t]*image:[ \t]*(\S*)[ \t]*$/i;
const QUEUED_MARK = /<!-- forge-linkedin ([0-9a-f]{16}) -->/;
const OFF_MARK = "<!-- forge-linkedin-off -->";
const BOT = "github-actions[bot]";
/** Buffer won't schedule into the past; anything due sooner goes out this many minutes from now. */
const LEAD_MS = 10 * 60_000;

/** Every ```linkedin block, numbered from 1. */
export function parseLinkedIn(body) {
  const out = [];
  const re = /^```linkedin((?:[ \t]+\S+)*)[ \t\r]*\n([\s\S]*?)\r?\n```[ \t\r]*$/gm;
  let m;
  while ((m = re.exec(body ?? ""))) {
    const n = out.length + 1;
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    const target = words.find((w) => w === "profile" || w === "page") ?? null;
    const times = words.filter((w) => w !== "profile" && w !== "page");
    if (times.length > 1) throw new Error(`LinkedIn post ${n} has more than one time ("${times.join(" ")}").`);
    let at = null;
    if (times[0]) {
      const spec = /^\d{4}-\d{2}-\d{2}$/.test(times[0]) ? `${times[0]}T${DEFAULT_SLOT_UTC}Z` : times[0];
      at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(spec) ? Date.parse(spec) : NaN;
      if (Number.isNaN(at)) throw new Error(`LinkedIn post ${n} has a time I can't read ("${times[0]}"). Use 2026-10-23 or 2026-10-23T14:00Z.`);
    }
    const lines = m[2].replace(/\r\n/g, "\n").split("\n");
    const images = lines.filter((l) => IMAGE_LINE.test(l)).map((l) => IMAGE_LINE.exec(l)[1]);
    if (images.length > 1) throw new Error(`LinkedIn post ${n} has more than one image line.`);
    const text = tagLinks(lines.filter((l) => !IMAGE_LINE.test(l)).join("\n").trim());
    out.push({ n, at, target, text, ...(images.length ? { image: imageUrl(images[0], n) } : {}) });
  }
  return out;
}

/** Adds ?from=li-post to theagentforge.io links that don't carry a from tag (§9.8), so the digest counts them. */
export function tagLinks(text) {
  return text.replace(/https:\/\/theagentforge\.io(\/[^\s?#]*)?(\?[^\s#]*)?/g, (m, path = "", query = "") =>
    /[?&]from=/.test(query) ? m : `https://theagentforge.io${path}${query ? `${query}&` : "?"}from=li-post`,
  );
}

export function validateLinkedIn(posts) {
  if (!posts.length) throw new Error("No ```linkedin block found in the issue body.");
  if (posts.length > MAX_BLOCKS) throw new Error(`Too many LinkedIn posts in one issue (${posts.length}); the limit is ${MAX_BLOCKS}.`);
  for (const p of posts) {
    if (!p.text) throw new Error(`LinkedIn post ${p.n} is empty.`);
    if (p.text.length > MAX_CHARS) throw new Error(`LinkedIn post ${p.n} is ${p.text.length} characters; the limit is ${MAX_CHARS}.`);
  }
}

export const linkedInHash = (posts) => createHash("sha256").update(JSON.stringify(posts.map((p) => [p.at, p.target, p.text, p.image ?? null]))).digest("hex").slice(0, 16);

/** One GraphQL call. Buffer answers HTTP 200 even for errors, so both the status and `errors` are checked. */
export async function buffer(env, fetcher, query, variables = {}) {
  const res = await fetcher(BUFFER_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.BUFFER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Buffer refused the request (HTTP ${res.status}).`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(`Buffer: ${data.errors.map((e) => e.message).join("; ").slice(0, 200)}`);
  return data.data;
}

/** The LinkedIn channels each target goes to. */
export async function channels(env, fetcher) {
  const orgs = (await buffer(env, fetcher, "query { account { organizations { id } } }")).account.organizations;
  const all = [];
  for (const o of orgs) {
    const d = await buffer(env, fetcher, "query Channels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name service } }", { organizationId: o.id });
    all.push(...d.channels.filter((c) => c.service === "linkedin"));
  }
  if (!all.length) throw new Error("No LinkedIn channel is connected in Buffer.");
  const pick = (id, kind) => {
    if (!id) throw new Error(`Set the repository variable BUFFER_LINKEDIN_${kind.toUpperCase()} to the Buffer channel id of the LinkedIn ${kind}, or leave "${kind}" off the block.`);
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`BUFFER_LINKEDIN_${kind.toUpperCase()} isn't one of the LinkedIn channels in Buffer.`);
    return [c];
  };
  return { all, profile: () => pick(env.BUFFER_LINKEDIN_PROFILE, "profile"), page: () => pick(env.BUFFER_LINKEDIN_PAGE, "page") };
}

const CREATE = `mutation Create($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id dueAt } }
    ... on MutationError { message }
  }
}`;

/** Schedules one block on one channel. Returns { id, dueAt }. */
export async function schedule(env, fetcher, post, channelId, now = Date.now()) {
  const input = {
    text: post.text,
    channelId,
    schedulingType: "automatic",
    ...(post.at === null ? { mode: "addToQueue" } : { mode: "customScheduled", dueAt: new Date(Math.max(post.at, now + LEAD_MS)).toISOString() }),
    ...(post.image ? { assets: [{ image: { url: post.image } }] } : {}),
  };
  const r = (await buffer(env, fetcher, CREATE, { input })).createPost;
  if (!r?.post) throw new Error(`Buffer didn't schedule LinkedIn post ${post.n}: ${r?.message ?? "no reason given"}.`);
  return r.post;
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

/** The approve job: schedules this issue's blocks in Buffer, once per approved version of them. */
export async function approve(env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const issue = env.ISSUE_NUMBER;
  const posts = parseLinkedIn(env.ISSUE_BODY);
  validateLinkedIn(posts);
  const comments = await gh("GET", `/issues/${issue}/comments?per_page=100`);
  const mine = comments.filter((c) => c.user?.login === BOT);
  if (!env.BUFFER_API_KEY) {
    if (!mine.some((c) => c.body.includes(OFF_MARK)))
      await gh("POST", `/issues/${issue}/comments`, { body: `LinkedIn isn't connected yet, so nothing was scheduled. Once BUFFER_API_KEY is added (docs/runbooks/posting.md), comment approve again. ${OFF_MARK}` });
    return ["LinkedIn isn't connected (no BUFFER_API_KEY)."];
  }
  const hash = linkedInHash(posts);
  if (mine.some((c) => QUEUED_MARK.exec(c.body)?.[1] === hash)) return ["Already scheduled in Buffer."];
  const ch = await channels(env, fetcher);
  const lines = [];
  for (const p of posts) {
    const targets = p.target === "profile" ? ch.profile() : p.target === "page" ? ch.page() : ch.all;
    for (const c of targets) {
      const s = await schedule(env, fetcher, p, c.id, now);
      lines.push(`- LinkedIn post ${p.n} → ${c.name}: ${s.dueAt ? new Date(s.dueAt).toUTCString().replace(/:00 GMT$/, " UTC") : "next queue slot"}`);
    }
  }
  await gh("POST", `/issues/${issue}/comments`, {
    body: `Scheduled in Buffer:\n${lines.join("\n")}\n\nTo stop one, delete it in Buffer (publish.buffer.com). Editing this issue doesn't change what's scheduled. <!-- forge-linkedin ${hash} -->`,
  });
  await gh("POST", `/issues/${issue}/labels`, { labels: ["scheduled"] });
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = process.argv[2] === "approve" ? approve(process.env) : Promise.reject(new Error("usage: approve"));
  run
    .then((r) => console.log(r.join("\n")))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
