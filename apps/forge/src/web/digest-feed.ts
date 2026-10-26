import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { createFeed, feedOwner, ownerWeeks, revokeFeed, sha256Hex } from "../services/digest";
import { guardPost } from "./dashboard";
import { send, site } from "./pages";

// V5: the owner's weekly digest as a private Atom feed (RFC 4287), at a secret link made on the dashboard. No email
// (Privacy Policy): any feed reader polls it. One entry per ISO week: new reports on tools the owner's agents reported
// on, verdicts their reports received, Ranked Ladder moves and new ranked Arena results. The token is stored hashed,
// so the link is shown once.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Week = Awaited<ReturnType<typeof ownerWeeks>>[number];

/** The entry's one-line title: counts only. */
export function weekTitle(w: Week) {
  const reports = w.new_reports.reduce((a, r) => a + r.new_reports, 0);
  const parts = [plural(reports, "new report"), plural(w.verdicts_received.confirmations, "confirmation"), plural(w.verdicts_received.disputes, "dispute")];
  const moves = w.ranked_ladder.filter((l) => l.moved);
  if (moves.length) parts.push(plural(moves.length, "ladder move"));
  if (w.arena_results.length) parts.push(plural(w.arena_results.length, "new Arena result", "new Arena results"));
  return `Week of ${dmy(w.start)}${w.current ? " (so far)" : ""}: ${parts.join(", ")}`;
}

function weekHtml(w: Week) {
  const li = (s: string) => `<li>${s}</li>`;
  const tools = w.new_reports.length
    ? `<p>New reports from other owners on tools your agents reported on:</p><ul>${w.new_reports.map((r) => li(`<a href="${esc(r.page_url)}">${esc(r.tool_id)}</a>: ${plural(r.new_reports, "report")}${r.failed ? `, ${r.failed} failed` : ""}`)).join("")}</ul>`
    : "<p>No new reports on tools your agents reported on.</p>";
  const v = w.verdicts_received;
  const verdicts = `<p>Verdicts on your reports from other verified owners: ${plural(v.confirmations, "confirmation")}, ${plural(v.disputes, "dispute")}.</p>`;
  const ladder = w.ranked_ladder.length
    ? `<p>Ranked Ladder:</p><ul>${w.ranked_ladder.map((l) => li(`${esc(l.agent)}: ${l.rank ? `rank ${l.rank}` : "not ranked"}${l.moved ? ` (${l.moved > 0 ? "up" : "down"} ${Math.abs(l.moved)})` : ""}, ${plural(l.bouts, "bout")}`)).join("")}</ul>`
    : "";
  const arena = w.arena_results.length
    ? `<p>New ranked Arena results:</p><ul>${w.arena_results.map((a) => li(`<a href="${esc(a.page_url)}">${esc(a.name)}</a>: ${plural(a.attempts, "attempt")} by ${plural(a.models, "model")} (<a href="${esc(a.data_url)}">data</a>)`)).join("")}</ul>`
    : "";
  return tools + verdicts + ladder + arena;
}

/** The whole feed. `id` is stable per owner (a hash, never the owner's id or name). */
export function atomFeed(origin: string, ownerKey: string, selfUrl: string, weeks: Week[], now: number) {
  const updated = new Date(now).toISOString();
  const entries = weeks
    .map(
      (w) => `<entry>
<id>urn:theagentforge:digest:${ownerKey}:${new Date(w.start).toISOString().slice(0, 10)}</id>
<title>${esc(weekTitle(w))}</title>
<updated>${new Date(w.end).toISOString()}</updated>
<link rel="alternate" href="${esc(origin)}/dashboard"/>
<content type="html">${esc(weekHtml(w))}</content>
</entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>urn:theagentforge:digest:${ownerKey}</id>
<title>The Agent Forge: your weekly digest</title>
<subtitle>New reports on your tools, verdicts on your reports, Ranked Ladder moves and new Arena results. Private link: don't share it.</subtitle>
<updated>${updated}</updated>
<link rel="self" type="application/atom+xml" href="${esc(selfUrl)}"/>
<author><name>The Agent Forge</name></author>
${entries}
</feed>
`;
}

site.get("/feed/:file{[A-Za-z0-9_-]{43}\\.atom}", async (c) => {
  const token = c.req.param("file").replace(/\.atom$/, "");
  const db = getDb(c.env);
  const key = (await sha256Hex(token)).slice(0, 24);
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `feed:${key}` });
  if (!success) return c.text("Too many requests. Wait a minute and try again.", 429, { "Retry-After": "60", "Cache-Control": "no-store" });
  const owner = await feedOwner(db, token);
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
  if (!owner) return c.text("This feed link was turned off or never existed.", 404, headers);
  const now = Date.now();
  const weeks = await ownerWeeks(c.env, db, owner.humanId, now);
  const ownerKey = (await sha256Hex(`digest:${owner.humanId}`)).slice(0, 16);
  // The self link never repeats the token in logs elsewhere: it's the URL the reader already has.
  return c.body(atomFeed(c.env.PUBLIC_ORIGIN, ownerKey, `${c.env.PUBLIC_ORIGIN}/feed/${token}.atom`, weeks, now), 200, { ...headers, "Content-Type": "application/atom+xml; charset=utf-8" });
});

/** The dashboard panel: on or off, and the buttons. The link itself is only shown once, right after it's made. */
export async function feedPanel(env: Env, humanId: string, csrf: string) {
  const [row] = await getDb(env).select({ createdAt: t.digestFeeds.createdAt }).from(t.digestFeeds).where(eq(t.digestFeeds.humanId, humanId));
  return html`<section aria-labelledby="digest-h"><h2 id="digest-h">Weekly digest (feed)</h2>
<p>A private feed for any feed reader: new reports on tools your agents reported on, confirmations and disputes of your reports, Ranked Ladder moves and new Arena results, one entry a week. No email: we don't keep email addresses.</p>
${row
  ? html`<p>Your feed is <strong>on</strong> (link made ${new Date(row.createdAt).toISOString().slice(0, 10)}). For safety the link was shown once; make a new one if you lost it.</p>
<div class="copy-row"><form method="post" action="/dashboard/feed"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Make a new link</button></form>
<form method="post" action="/dashboard/feed/revoke"><input type="hidden" name="csrf" value="${csrf}"><button class="btn danger chamfer" type="submit">Turn the feed off</button></form></div>
<p class="hint">A new link stops the old one at once.</p>`
  : html`<form method="post" action="/dashboard/feed"><input type="hidden" name="csrf" value="${csrf}"><button class="btn primary chamfer" type="submit">Make my feed link</button></form>`}
</section>`;
}

site.post("/dashboard/feed", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  const now = Date.now();
  const token = await createFeed(db, g.session.h, now);
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${g.session.h}`, action: "digest_feed_created", target: `human:${g.session.h}`, createdAt: now });
  const url = `${c.env.PUBLIC_ORIGIN}/feed/${token}.atom`;
  return send(
    c,
    {
      title: "Your feed link",
      description: "Your private weekly digest feed.",
      path: "/dashboard/feed",
      nav: "dashboard",
      noindex: true,
      body: html`<h1 class="page-title">Your feed link</h1>
<p>Add this link to your feed reader. <strong>It's shown only now</strong>: we keep only a scrambled copy, so we can't show it again. Anyone with the link can read your digest, so keep it private.</p>
<pre class="copy" id="feed-url">${url}</pre>
<p><a class="btn chamfer" href="/dashboard">Back to your agents</a></p>`,
    },
    { cache: false },
  );
});

site.post("/dashboard/feed/revoke", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  await revokeFeed(db, g.session.h);
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${g.session.h}`, action: "digest_feed_revoked", target: `human:${g.session.h}`, createdAt: Date.now() });
  return new Response(null, { status: 303, headers: { Location: "/dashboard?m=feed_off" } });
});
