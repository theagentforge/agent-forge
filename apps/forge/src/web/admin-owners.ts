import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { approveLogin, isAdmin } from "../services/identity";
import { decideReview, reviewQueue, syncOwners } from "../services/owners";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";

// ADR 0073 (OA-06): the founder's weekly review queue. Only people who pressed "Request a review" on their dashboard
// are listed, with their GitHub username and account age, nothing else. Approve verifies them (approval is the
// founder's decision, MASTER_PLAN §11.3), and their pending claims then count; Skip closes the request.

async function founder(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

const MESSAGES: Record<string, string> = {
  approved: "Approved. They're verified now, and any pending claims of theirs count.",
  skipped: "Skipped. They can ask again later.",
  gone: "That request was already decided.",
};

site.get("/admin/owners", async (c) => {
  const s = await currentSession(c);
  if (!s || !(await founder(c, s.session.h))) return c.redirect("/dashboard");
  const db = getDb(c.env);
  const queue = await reviewQueue(db);
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const m = MESSAGES[c.req.query("m") ?? ""];
  return send(
    c,
    {
      title: "Review requests",
      description: "Internal: people waiting for a review.",
      path: "/admin/owners",
      noindex: true,
      body: html`<h1 class="page-title">Review requests (${queue.length})</h1>
${m ? html`<p class="notice">${m}</p>` : ""}
<p>People who aren't verified yet and asked for a review. Once a week is enough. Approve people you're happy to count as real owners; Skip the rest. Their GitHub page is one click away if you want to look first.</p>
${queue.length
  ? html`<table class="table stack"><thead><tr><th>GitHub username</th><th class="num">Account age</th><th>Asked</th><th>Decision</th></tr></thead><tbody>${queue.map(
      (q) => html`<tr><td><a class="mono" href="https://github.com/${q.github_login}" rel="noopener nofollow">@${q.github_login}</a></td><td class="num" data-label="Account age">${q.account_age_days} days</td><td data-label="Asked">${q.requested_at}</td><td data-label="Decision"><form class="inline-form" method="post" action="/admin/owners/decide"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="human" value="${q.human_id}"><button class="btn primary chamfer" type="submit" name="decision" value="approve">Approve</button> <button class="btn chamfer" type="submit" name="decision" value="skip">Skip</button></form></td></tr>`,
    )}</tbody></table>`
  : html`<p class="empty">Nobody is waiting.</p>`}`,
    },
    { cache: false },
  );
});

site.post("/admin/owners/decide", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const me = await founder(c, g.session.h);
  if (!me) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  const humanId = String(g.form.get("human") ?? "");
  const target = await db.query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  const approve = g.form.get("decision") === "approve";
  const now = Date.now();
  if (!target || !(await decideReview(db, humanId, approve ? "approved" : "skipped", now))) return c.redirect("/admin/owners?m=gone", 303);
  if (approve) await approveLogin(db, target.githubLogin, now);
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${me.id}`, action: approve ? "review_approved" : "review_skipped", target: `github:${target.githubLogin.toLowerCase()}`, createdAt: now });
  if (approve) await syncOwners(c.env, now).catch((e) => console.error("sync_owners_failed", String(e)));
  return c.redirect(`/admin/owners?m=${approve ? "approved" : "skipped"}`, 303);
});
