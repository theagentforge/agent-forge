// The daily reply kit (social strategy §0.9; Dinike, 21 Oct 2026: "build the reply kit"). Once a day it searches X for
// the biggest recent conversations about AI agent security, picks up to 5, and opens a GitHub issue that lists each
// one with a suggested reply built from a published, dated fact, plus a one-tap link that opens X's own reply box
// with the text filled in. Dinike reads, rewrites and posts by hand. This script never posts, replies or mentions
// anyone (X automation rules), and it reads nothing private.
//   node reply-kit.mjs        daily, from .github/workflows/reply-kit.yml
// Its X reads have their own cap (REPLY_KIT_CAP_USD), apart from the $10 posting cap in post-to-x.mjs.
import { oauthHeader } from "./post-to-x.mjs";

export const KIT_TITLE = "Reply kit";
export const KIT_LABEL = "reply-kit";
export const MAX_PICKS = 5;
/** X pay-per-use: $0.005 per post read. We count each author returned too, to stay on the safe side. */
export const COST_PER_READ = 0.005;
export const REPLY_KIT_CAP_USD = 8;
const KIT_COST_MARK = /<!-- forge-kit-cost (\d+(?:\.\d+)?) -->/;
const BOT = "github-actions[bot]";
const OUR_HANDLES = new Set(["theagentforge", "theagentforgeio"]);

/** Two searches a day, 10 posts each (X's minimum), last 24 hours, original posts in English only. */
export const QUERIES = [
  { key: "security", q: '("prompt injection" OR "MCP server" OR "MCP servers" OR "agent skills" OR "SKILL.md" OR "tool poisoning") (agent OR agents OR security OR safe OR malicious) -is:retweet -is:reply lang:en' },
  { key: "tricked", q: '("AI agent" OR "AI agents" OR "coding agent") (scam OR "fake invoice" OR refund OR tricked OR "fell for" OR hijacked OR guardrails) -is:retweet -is:reply lang:en' },
];

/**
 * Published, dated facts a reply can stand on, each with the page that backs it. Matched to a post by keywords.
 * Replies give one fact and one link, in plain words; they never tell the reader or their AI what to do.
 */
export const FACTS = [
  {
    id: "skill-scan",
    match: /\b(skill|skills|skill\.md|clawhub|skills\.sh|plugin|plugins)\b/i,
    text: "We scanned 9,930 public agent skills for instructions a virus scanner can't see. No malware by our rules, but 14 pipe a download straight into a shell and 8 read the agent's whole key file.",
    link: "https://theagentforge.io/reports/skill-scan-2026-10?from=x-reply",
  },
  {
    id: "mcp",
    match: /\b(mcp|model context protocol|tool poisoning|server|servers)\b/i,
    text: "We counted every server in the official MCP Registry: 36,863. 54.6% are remote-only, so there's no code to read before you connect, and 29.4% link no source repository at all.",
    link: "https://theagentforge.io/reports/mcp-registry-census-2026-10?from=x-reply",
  },
  {
    id: "trap-frontier",
    match: /\b(gpt|claude|gemini|mistral|frontier|sonnet|opus|o\d)\b/i,
    text: "We tested a short safety checklist on frontier models doing everyday jobs with planted traps. It made no measurable difference: 26 vs 31 fell for the trap in 105 bouts each. Pre-registered, published anyway.",
    link: "https://theagentforge.io/lab/4/results?from=x-reply",
  },
  {
    id: "trap-small",
    match: /\b(prompt injection|injection|jailbreak|guardrail|guardrails|system prompt|instructions)\b/i,
    text: "We planted traps in everyday agent jobs (fake invoices, policy-breaking refunds). Small open models given a short checklist in their instructions fell for 54% fewer of them, pre-registered, 18 Oct.",
    link: "https://theagentforge.io/lab/3/results?from=x-reply",
  },
  {
    id: "arena",
    match: /\b(scam|invoice|refund|tricked|fell for|hijack\w*|agent|agents)\b/i,
    text: "We referee AI agents on six everyday jobs with planted traps, like a lookalike invoice or a refund that breaks policy. Each bout is replayable step by step.",
    link: "https://theagentforge.io/arena?from=x-reply",
  },
];

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const roundCost = (x) => Math.round(x * 1000) / 1000;

/** One recent search, signed with the posting account's keys (OAuth 1.0a user context, read only). */
export async function search(query, env, fetcher = fetch, now = Date.now()) {
  for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) if (!env[k]) throw new Error(`Missing the ${k} secret.`);
  const base = "https://api.x.com/2/tweets/search/recent";
  const params = {
    query,
    max_results: "10",
    sort_order: "relevancy",
    start_time: new Date(now - 24 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    "tweet.fields": "public_metrics,created_at,author_id,lang",
    expansions: "author_id",
    "user.fields": "public_metrics,username,name",
  };
  const auth = oauthHeader({ method: "GET", url: base, consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET, extra: params });
  const res = await fetcher(`${base}?${Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&")}`, { headers: { Authorization: auth } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X refused the search (HTTP ${res.status}${data?.title ? `: ${data.title}` : ""}).`);
  const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u]));
  const posts = (data.data ?? []).map((t) => ({ ...t, author: users.get(t.author_id) ?? null }));
  return { posts, reads: posts.length + users.size };
}

/**
 * How much a conversation is worth joining: engagement first, then the author's reach on a log scale, so a huge
 * account's quiet post doesn't outrank a lively thread (10k followers add 20, 1M add 30).
 */
export const score = (p) => {
  const m = p.public_metrics ?? {};
  const followers = p.author?.public_metrics?.followers_count ?? 0;
  return (m.like_count ?? 0) + 2 * (m.reply_count ?? 0) + 3 * (m.retweet_count ?? 0) + 2 * (m.quote_count ?? 0) + 5 * Math.log10(1 + followers);
};

/** Big enough to be worth a reply: 1,000+ followers or 20+ likes. Never our own posts. One post per author. */
export function pick(posts, max = MAX_PICKS) {
  const seen = new Set();
  return posts
    .filter((p) => !OUR_HANDLES.has(String(p.author?.username ?? "").toLowerCase()))
    .filter((p) => (p.author?.public_metrics?.followers_count ?? 0) >= 1000 || (p.public_metrics?.like_count ?? 0) >= 20)
    .sort((a, b) => score(b) - score(a))
    .filter((p) => {
      const id = p.author_id ?? p.author?.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, max);
}

/** The fact that fits a post best: the first whose keywords it mentions (the list is ordered most specific first). */
export const factFor = (text) => FACTS.find((f) => f.match.test(text ?? "")) ?? FACTS.at(-1);

/** A starting point for Dinike's reply: one fact and its link, under X's 280 (a link counts as 23). */
export function suggestedReply(post) {
  const f = factFor(post.text);
  const room = 280 - 23 - 1;
  const text = f.text.length > room ? `${f.text.slice(0, room - 1).trimEnd()}…` : f.text;
  return { fact: f.id, text: `${text} ${f.link}` };
}

/** X's own reply box, with the suggested text filled in: Dinike edits and posts it by hand. */
export const replyIntent = (postId, text) => `https://x.com/intent/post?in_reply_to=${encodeURIComponent(postId)}&text=${encodeURIComponent(text)}`;

const n = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : "0");

/** The issue body: up to 5 conversations, each with who, what, the numbers, the suggested reply and the one-tap link. */
export function kitBody(day, picks, cost) {
  const items = picks.map((p, i) => {
    const r = suggestedReply(p);
    const m = p.public_metrics ?? {};
    const who = p.author ? `**${p.author.name}** (@${p.author.username}, ${n(p.author.public_metrics?.followers_count)} followers)` : "an account";
    const quote = String(p.text ?? "").replace(/\s+/g, " ").slice(0, 280);
    return [
      `### ${i + 1}. ${who}`,
      `> ${quote}`,
      "",
      `${n(m.like_count)} likes · ${n(m.reply_count)} replies · ${n(m.retweet_count)} reposts · [open the post](https://x.com/i/web/status/${p.id})`,
      "",
      `**Suggested reply** (fact: \`${r.fact}\`; rewrite it in your own voice, and add a picture if one fits):`,
      "",
      "```",
      r.text,
      "```",
      "",
      `[**Reply on X with this text →**](${replyIntent(p.id, r.text)})`,
    ].join("\n");
  });
  return [
    `Today's biggest conversations about AI agent safety on X (last 24 hours). Reply **by hand**, only where you have something useful to add. Reply early: the first hour matters most. Skip any that don't fit.`,
    "",
    items.length ? items.join("\n\n---\n\n") : "_Nothing big enough today (1,000+ followers or 20+ likes)._",
    "",
    "---",
    `Read ${picks.length ? "" : "0 picks from "}X for about $${cost} (reply-kit cap $${REPLY_KIT_CAP_USD} a month, apart from the posting cap). This kit never posts or replies by itself. <!-- forge-kit ${day} --> <!-- forge-kit-cost ${cost} -->`,
  ].join("\n");
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

/** Dollars the kit spent on X reads this month, from the cost marks on its own issues. */
export function kitSpent(issues, now) {
  const d = new Date(now);
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return issues
    .filter((i) => i.user?.login === BOT && String(i.created_at ?? "").startsWith(month))
    .reduce((s, i) => s + Number(KIT_COST_MARK.exec(i.body ?? "")?.[1] ?? 0), 0);
}

/** Daily: search, pick, open today's kit issue and close yesterday's. Returns a short log. */
export async function run(env, fetcher = fetch, now = Date.now()) {
  const gh = github(env, fetcher);
  const day = new Date(now).toISOString().slice(0, 10);
  const issues = await gh("GET", `/issues?state=all&labels=${KIT_LABEL}&per_page=100`);
  if (issues.some((i) => i.title === `${KIT_TITLE} (${day})`)) return [`${day}: already done`];
  const worstCase = roundCost(QUERIES.length * 20 * COST_PER_READ);
  if (kitSpent(issues, now) + worstCase > REPLY_KIT_CAP_USD) return [`${day}: skipped, the reply kit's monthly cap ($${REPLY_KIT_CAP_USD}) is reached`];
  let reads = 0;
  const all = [];
  for (const { q } of QUERIES) {
    const r = await search(q, env, fetcher, now);
    reads += r.reads;
    all.push(...r.posts);
  }
  const picks = pick(all);
  const cost = roundCost(reads * COST_PER_READ);
  for (const old of issues.filter((i) => i.state === "open")) await gh("PATCH", `/issues/${old.number}`, { state: "closed", state_reason: "completed" });
  const made = await gh("POST", `/issues`, { title: `${KIT_TITLE} (${day})`, labels: [KIT_LABEL], body: kitBody(day, picks, cost) });
  return [`${day}: ${picks.length} conversation(s) in #${made.number}, ${reads} reads for $${cost}`];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.env)
    .then((log) => console.log(log.join("\n")))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
