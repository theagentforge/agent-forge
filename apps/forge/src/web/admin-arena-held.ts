import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { fullPack, heldEvents, markPackSent, publishHeld } from "../arena/held-events";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site, wantsJson } from "./pages";
import { NOTICE_DAYS } from "./results-policy";
import { csrfToken } from "./session";

// /admin/arena-held (B2-02, ADR 0089): held events (status "planned") under the results policy. Per event: download
// the full pack, "Mark full pack sent" (starts the 7-day notice), and "Publish held event" (refused before the notice
// ends or if the runs changed since the pack). Founder admins only (ADMIN_GITHUB_IDS), CSRF-checked posts, never
// cached or indexed. Nothing on this page sends email: Dinike sends the pack himself.

const page = { title: "Held events", description: "Notice packs and publication of held Arena events.", path: "/admin/arena-held", noindex: true };
const PATH = "/admin/arena-held";

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

const RESULT: Record<string, string> = {
  pack_sent: "Recorded: the full pack was sent now. The 7-day notice starts from this moment.",
  published: "Published. The event's results now show on every public page, with their original dates and replays.",
  unknown_event: "No such event.",
  not_held: "Not done: the event isn't held (it's already published).",
  runs_unfinished: "Not done: some of its runs are still queued or running.",
  no_runs: "Not done: the event has no finished runs to put in a pack.",
  no_pack_sent: "Not published: the full pack hasn't been marked as sent.",
  notice_period: `Not published: the ${NOTICE_DAYS}-day notice after the full pack hasn't ended yet.`,
  pack_stale: "Not recorded: the runs changed since this page was loaded, so the pack you downloaded may not be the current one. Reload, download the pack again, send that one to every named lab, then mark it sent.",
  runs_changed: "Not published: the runs changed since the pack was sent. Send the new pack to every named lab and mark it sent again.",
};

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace(".000Z", "Z") : "—");

site.get(PATH, async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const list = await heldEvents(getDb(c.env));
  if (wantsJson(c))
    return c.json(
      list.map((x) => ({ slug: x.event.slug, name: x.event.name, kind: x.event.kind, status: x.event.status, runs: x.runs, pack_sent_at: x.notice?.packSentAt ?? null, pack_sent_by: x.notice?.packSentBy ?? null, pack_runs: x.notice?.packRuns ?? null, earliest_publication: x.earliest_publication, published_at: x.published_at, published_by: x.notice?.publishedBy ?? null, can_mark_pack_sent: x.can_mark_pack_sent, can_publish: x.can_publish })),
      200,
      { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
    );
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const r = c.req.query("r");
  const form = (action: string, slug: string, label: string, sha256 = "") =>
    html`<form method="post" action="${PATH}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="slug" value="${slug}">${sha256 ? html`<input type="hidden" name="sha256" value="${sha256}">` : ""}<button class="btn chamfer" type="submit">${label}</button></form>`;
  return send(
    c,
    {
      ...page,
      body: html`<h1 class="page-title">Held events</h1>
${r && RESULT[r] ? html`<p class="notice">${RESULT[r]}</p>` : ""}
<p>A held event has been played, refereed and signed, and is shown nowhere. Results policy: every named lab gets the same full pack at the same time, and the results are published no earlier than ${NOTICE_DAYS} days after it. Steps: 1. download the full pack and send it to every named lab yourself; 2. press "Mark full pack sent"; 3. after ${NOTICE_DAYS} days, press "Publish held event".</p>
${list.length
        ? html`<table><thead><tr><th>Event</th><th>Runs</th><th>Full pack</th><th>Publication</th><th></th></tr></thead><tbody>${list.map(
            (x) => html`<tr><td><b>${x.event.name}</b><br><code>${x.event.slug}</code> · ${x.event.kind} · ${x.event.status}</td>
<td>${x.runs.done} done, ${x.runs.queued + x.runs.running} unfinished, ${x.runs.void} void</td>
<td><a href="${PATH}/${x.event.slug}/pack.json">Download (JSON)</a> · <a href="${PATH}/${x.event.slug}/pack.json?replays=0">summary</a>${x.current ? html`<br><span class="small muted">runs fingerprint (the pack's runs.sha256) <code>${x.current.sha256.slice(0, 16)}</code>, ${x.current.runs} runs</span>` : ""}<br>${x.notice?.packSentAt ? html`sent ${when(x.notice.packSentAt)} by ${x.notice.packSentBy} (${x.notice.packRuns} runs)` : "not sent"}</td>
<td>${x.published_at ? html`published ${when(x.published_at)} by ${x.notice?.publishedBy}` : x.earliest_publication ? html`earliest ${when(x.earliest_publication)}` : "—"}</td>
<td>${x.held && x.can_mark_pack_sent ? form("pack-sent", x.event.slug, x.notice?.packSentAt ? "Mark a new full pack sent" : "Mark full pack sent", x.current?.sha256) : ""}${x.can_publish ? form("publish", x.event.slug, "Publish held event") : ""}</td></tr>`,
          )}</tbody></table>`
        : html`<p>No held events.</p>`}`,
    },
    { cache: false },
  );
});

site.get(`${PATH}/:slug{[a-z0-9][a-z0-9-]*}/pack.json`, async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const slug = c.req.param("slug");
  const pack = await fullPack(getDb(c.env), slug, c.env.PUBLIC_ORIGIN, { replays: c.req.query("replays") !== "0" });
  if (!pack) return c.notFound();
  return c.json(pack, 200, { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Content-Disposition": `attachment; filename="forge-notice-pack-${slug}.json"` });
});

site.post(PATH, async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const action = String(g.form.get("action") ?? "");
  const slug = String(g.form.get("slug") ?? "").slice(0, 120);
  const by = `admin:${g.session.h}`;
  const sha256 = String(g.form.get("sha256") ?? "").slice(0, 64);
  const out = action === "pack-sent" ? await markPackSent(c.env, slug, by, sha256) : action === "publish" ? await publishHeld(c.env, slug, by) : ({ ok: false, reason: "unknown_event" } as const);
  console.log("arena_held_action", JSON.stringify({ action, slug, by, ...out }));
  return c.redirect(`${PATH}?r=${out.ok ? (action === "publish" ? "published" : "pack_sent") : out.reason}`);
});
