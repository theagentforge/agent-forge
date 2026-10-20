// The weekly learning report (docs/launch/social-strategy.md §9.9 and §11), added to Monday's Ops Digest.
// Per post type: posts, median impressions, engagement rate, link clicks and click-ins (?from=x-<type>), from the
// "X post metrics" comments and the type labels. It applies the kill-or-change rule, and moves one slot next week from
// the weakest type to the strongest (never the bout cycle). The move is written as a forge-mix marker that the social
// drafter reads (integrations/social/draft.mjs). Counts only; no model is involved.

import { parsePosts } from "../social/post-to-x.mjs";

const BOT = "github-actions[bot]";
const DAY = 86_400_000;
const POSTED_ID = /status\/(\d+) <!-- forge-posted (\d+) -->/g;
/** The same lists as the Worker's SWAP_FROM / SWAP_TO (apps/forge/src/social/drafts.ts). */
export const SWAP_FROM = ["trap-of-the-day", "catch-card", "clip", "board-change", "skill-watch", "trap-card-tip"];
export const SWAP_TO = ["trap-of-the-day", "catch-card", "clip", "trap-card-tip"];
/** A type needs this many measured posts in the last 14 days before the report moves a slot for or against it. */
export const MIN_POSTS = 2;

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const num = (v) => (v === "–" || v === undefined ? null : Number(String(v).replace(/,/g, "")));

/** The latest reading of each post, from the bot's metrics tables (comments oldest first). */
export function readings(comments) {
  const out = new Map();
  for (const c of comments) {
    if (c.user?.login !== BOT || !c.body.includes("forge-metrics")) continue;
    for (const line of c.body.split("\n")) {
      const m = /^\| \[(\d+)\]\([^)]*\) \| (\d{4}-\d{2}-\d{2}) \| (.+) \|$/.exec(line.trim());
      if (!m || m[3].startsWith("not found")) continue;
      const [impressions, likes, reposts, replies, quotes, bookmarks, clicks] = m[3].split(" | ").map(num);
      out.set(m[1], { id: m[1], date: m[2], impressions, engagements: [likes, reposts, replies, quotes, bookmarks].reduce((a, b) => a + (b ?? 0), 0), clicks });
    }
  }
  return out;
}

/** Each main post (not link replies) sent from a post issue, with its type: the type:<slug> label, or "hand-written". */
export function sentPosts(issues, comments) {
  const byNumber = new Map(issues.filter((i) => !i.pull_request).map((i) => [i.number, i]));
  const out = [];
  for (const c of comments) {
    if (c.user?.login !== BOT) continue;
    const issue = byNumber.get(Number(String(c.issue_url ?? "").split("/").at(-1)));
    if (!issue) continue;
    let posts = [];
    try {
      posts = parsePosts(issue.body ?? "");
    } catch {}
    const type = issue.labels?.map((l) => l.name).find((n) => n.startsWith("type:"))?.slice(5) ?? "hand-written";
    for (const m of c.body.matchAll(POSTED_ID)) {
      if (posts.find((p) => p.n === Number(m[2]))?.reply) continue;
      out.push({ id: m[1], type, at: Date.parse(c.created_at) });
    }
  }
  return out;
}

/** Monday 00:00 UTC of the week holding `ms`. */
const weekStart = (ms) => {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
};

/**
 * The report. `posts` from sentPosts, `metrics` from readings, `tags` from the growth endpoint's arrivals_by_tag_7d,
 * `now` the digest's time (a Monday). Returns { rows, kill, swap, week }.
 */
export function learning({ posts, metrics, tags = [], now }) {
  const measured = posts.map((p) => ({ ...p, m: metrics.get(p.id) })).filter((p) => p.m && typeof p.m.impressions === "number" && now - p.at <= 28 * DAY);
  const types = [...new Set(measured.map((p) => p.type))];
  const clickIns = new Map(tags.map((t) => [t.name, t.n]));
  const rows = types
    .map((type) => {
      const xs = measured.filter((p) => p.type === type);
      const imps = xs.reduce((a, p) => a + p.m.impressions, 0);
      return {
        type,
        posts: xs.length,
        median: median(xs.map((p) => p.m.impressions)),
        rate: imps ? xs.reduce((a, p) => a + p.m.engagements, 0) / imps : null,
        clicks: xs.some((p) => typeof p.m.clicks === "number") ? xs.reduce((a, p) => a + (p.m.clicks ?? 0), 0) : null,
        clickIns: clickIns.get(`x-${type}`) ?? 0,
      };
    })
    .sort((a, b) => b.median - a.median);

  // Kill or change (§11): under half the account median in each of the last 3 full weeks.
  const thisWeek = weekStart(now);
  const weeks = [1, 2, 3].map((k) => thisWeek - k * 7 * DAY);
  const kill = types.filter((type) =>
    weeks.every((w) => {
      const inWeek = measured.filter((p) => p.at >= w && p.at < w + 7 * DAY);
      const all = median(inWeek.map((p) => p.m.impressions));
      const mine = median(inWeek.filter((p) => p.type === type).map((p) => p.m.impressions));
      return all !== null && mine !== null && mine < all / 2;
    }),
  );

  // Next week's mix: one slot from the weakest movable type to the strongest that can take it (last 14 days).
  const recent = measured.filter((p) => now - p.at <= 14 * DAY);
  const score = (type) => {
    const xs = recent.filter((p) => p.type === type);
    return xs.length >= MIN_POSTS ? median(xs.map((p) => p.m.impressions)) : null;
  };
  const best = SWAP_TO.map((t) => ({ t, s: score(t) })).filter((x) => x.s !== null).sort((a, b) => b.s - a.s)[0];
  const worst = SWAP_FROM.map((t) => ({ t, s: score(t) })).filter((x) => x.s !== null).sort((a, b) => a.s - b.s)[0];
  const swap = best && worst && best.t !== worst.t && best.s > worst.s ? { from: worst.t, to: best.t } : null;
  return { rows, kill, swap, week: new Date(thisWeek).toISOString().slice(0, 10) };
}

const n = (v) => (typeof v === "number" ? Math.round(v).toLocaleString("en-US") : "–");

/** The digest section, with the forge-mix marker the drafter reads. */
export function learningSection(r) {
  if (!r.rows.length) return "**Weekly learning report (X):** no measured posts yet.";
  const table = [
    "| Post type | Posts | Median impressions | Engagement | Link clicks | Click-ins (7 days) |",
    "|---|--:|--:|--:|--:|--:|",
    ...r.rows.map((x) => `| ${x.type} | ${x.posts} | ${n(x.median)} | ${x.rate === null ? "–" : `${(x.rate * 100).toFixed(1)}%`} | ${n(x.clicks)} | ${x.clickIns} |`),
  ];
  const kill = r.kill.length ? `**Replace or change:** ${r.kill.join(", ")} (under half the account's median impressions for 3 weeks running).` : "No type is under half the account's median for 3 weeks running.";
  const mix = r.swap
    ? `**Next week's mix:** one ${r.swap.from} slot becomes ${r.swap.to}, the stronger type per impression. The bout cycle (poll, teaser, result, recap) stays as it is.`
    : "**Next week's mix:** unchanged (not enough measured posts to compare, or nothing to move).";
  return [
    `**Weekly learning report (X, posts from the last 28 days):** X doesn't say which post brought a follow, so follows are in the account totals only.`,
    "",
    ...table,
    "",
    kill,
    mix,
    ...(r.swap ? [`<!-- forge-mix ${JSON.stringify({ week: r.week, from: r.swap.from, to: r.swap.to })} -->`] : []),
  ].join("\n");
}

/** Reads what the report needs from GitHub: post issues and bot comments from 35 days, and the metrics issue. */
export async function gatherSocial(gh, now) {
  const since = new Date(now - 35 * DAY).toISOString();
  const paged = async (path) => {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await gh("GET", `${path}&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };
  const issues = await paged(`/issues?state=all&labels=post&since=${since}&per_page=100`);
  const comments = await paged(`/issues/comments?since=${since}&per_page=100`);
  const tracking = (await gh("GET", "/issues?state=all&labels=metrics&per_page=100")).find((i) => i.title === "X post metrics" && !i.pull_request);
  const metricComments = tracking ? await paged(`/issues/${tracking.number}/comments?since=${since}&per_page=100`) : [];
  return { posts: sentPosts(issues, comments), metrics: readings(metricComments) };
}
