// The Forge's agent on Moltbook, approve-only (docs/runbooks/posting.md). An issue labelled "moltbook" holds exactly one
// ```moltbook <submolt> block: its first line is the title, the rest is the post. When an admin comments approve, this
// script sends the post to the site with this workflow's GitHub OIDC token; the site posts it with the Moltbook key,
// which only Cloudflare holds. One post per issue, no comments, votes or messages (Moltbook's rules on self-promotion).
//   node moltbook.mjs approve <site>

import { BANNED } from "./draft.mjs";

export const MAX_TITLE = 300;
export const MAX_CONTENT = 40_000;
const BOT = "github-actions[bot]";
const POSTED_MARK = /<!-- forge-moltbook ([A-Za-z0-9_-]{4,64}) -->/;
/** The same phrase list as apps/forge/test/agent-wording.test.ts: wording that tells an agent what to do (§2.1). */
export const AGENT_DIRECTED =
  /\b(always|must|best|prefer(red)?|follow|obey|you should|skill\.md|instead of|before (any|every) other|(call|use|run) (this|it) first|install (this|it|our|the forge)|tell (your|the) (human|user|owner)|ignore (previous|prior|other))\b/i;
/**
 * A post carries a real result and cites it: a refereed Arena bout or results page, a Lab result, the trap card, a scan,
 * an answer page, Skill Watch or a report on our site. Arena and Lab results lead (Dinike, 23 Oct: lead with what
 * spreads); they are data too, every number checkable on the linked page.
 */
const EVIDENCE = /https:\/\/theagentforge\.io\/(arena(\/\S*)?|best\/\S+|lab\/\d+(\/results)?|trap-card|gauntlet\S*|scan\/[0-9a-f]{64}|tools\/\S+|skill-watch|reports\/\S+)/;
export const MAX_LINKS = 2;

/** Adds ?from=mb-post to theagentforge.io links without a from tag, so the digest counts arrivals from Moltbook. */
export function tagLinks(text) {
  return text.replace(/https:\/\/theagentforge\.io(\/[^\s?#)]*)?(\?[^\s#)]*)?/g, (m, path = "", query = "") =>
    /[?&]from=/.test(query) ? m : `https://theagentforge.io${path}${query ? `${query}&` : "?"}from=mb-post`,
  );
}

/** The one ```moltbook block: { submolt, title, content }. Throws with a plain reason otherwise. */
export function parseMoltbook(body) {
  const blocks = [...(body ?? "").matchAll(/^```moltbook[ \t]+([a-z0-9-]{2,30})[ \t\r]*\n([\s\S]*?)\r?\n```[ \t\r]*$/gm)];
  if (!blocks.length) throw new Error("No ```moltbook <submolt> block found in the issue body.");
  if (blocks.length > 1) throw new Error("One Moltbook post per issue, please (Moltbook limits how often an agent posts).");
  const [, submolt, raw] = blocks[0];
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

/** The approve job: posts the issue's one Moltbook post through the site, once, and records it on the issue. */
export async function approve(site, env = process.env, fetcher = fetch) {
  const gh = github(env, fetcher);
  const issue = env.ISSUE_NUMBER;
  const comments = await gh("GET", `/issues/${issue}/comments?per_page=100`);
  const done = comments.find((c) => c.user?.login === BOT && POSTED_MARK.test(c.body ?? ""));
  if (done) return [`Already posted: ${POSTED_MARK.exec(done.body)[1]}`];
  const post = parseMoltbook(env.ISSUE_BODY);
  const token = await oidcToken(env, site, fetcher);
  const res = await fetcher(`${site}/api/v1/social/moltbook`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(post) });
  const r = await res.json().catch(() => ({}));
  if (!r.ok) {
    const why =
      r.error === "moltbook_not_connected"
        ? "Moltbook isn't connected yet (the agent's key isn't in Cloudflare)."
        : `Moltbook refused it: ${String(r.error ?? `HTTP ${res.status}`).slice(0, 200)}.`;
    throw new Error(`${why} Fix it, then comment approve again.`);
  }
  const note = r.verified ? "" : " Moltbook's verification question wasn't answered, so the post stays hidden until it is; Claude will look at it.";
  await gh("POST", `/issues/${issue}/comments`, { body: `Posted on Moltbook in m/${post.submolt}: ${r.url}${note} <!-- forge-moltbook ${r.post_id} -->` });
  await gh("POST", `/issues/${issue}/labels`, { labels: ["posted"] });
  await gh("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
  return [`m/${post.submolt}: ${r.url}${r.verified ? "" : " (unverified)"}`];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, site = "https://theagentforge.io"] = process.argv.slice(2);
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) {
    console.error("site must be https://<host>");
    process.exit(1);
  }
  (mode === "approve" ? approve(site) : Promise.reject(new Error("usage: approve <site>")))
    .then((r) => console.log(r.join("\n")))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
