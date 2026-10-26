import { LONGITUDINAL, longitudinalPanel } from "@forge/arena";
import { desc, eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { ALL_MODELS } from "../arena/lineup";
import { PANEL_MAX_PER_MONTH, queuePanel } from "../arena/panel";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";

// /admin/arena-panel (ADR 0058, D7): an admin queues the longitudinal panel for a lineup model with one button. The
// normal runner plays the bouts under the usual caps. Admins only, never cached, never indexed.

const page = { title: "Longitudinal panel", description: "Queue the frozen panel for a model version.", path: "/admin/arena-panel", noindex: true };

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

const RESULT: Record<string, string> = {
  queued: "Queued. The runner starts it on its next 5-minute tick.",
  already_queued: "Not queued: this exact model version has already run the panel.",
  monthly_limit: `Not queued: ${PANEL_MAX_PER_MONTH} panel runs have already started this month.`,
  unknown_model: "Not queued: that model isn't in the lineup.",
  retired_model: "Not queued: that model is retired.",
  no_panel: "Not queued: no held-out panel is defined in this build.",
  over_cap: "Not queued: the panel is larger than its bout cap.",
};

site.get("/admin/arena-panel", async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const done = await getDb(c.env).select().from(t.arenaPanel).orderBy(desc(t.arenaPanel.createdAt)).limit(50);
  const ran = new Set(done.map((d) => `${d.modelId}|${d.pinnedModel}`));
  const models = ALL_MODELS.filter((m) => !m.retired);
  const r = c.req.query("r");
  return send(
    c,
    {
      ...page,
      body: html`<h1 class="page-title">Longitudinal panel</h1>
${r && RESULT[r] ? html`<p class="notice">${RESULT[r]}</p>` : ""}
<p>Runs the same ${longitudinalPanel().length} private Normal job versions (${LONGITUDINAL.attempts} attempt each, at most ${LONGITUDINAL.maxBoutsPerModel} bouts) on one model. Use it once for each new model version after it's added to the lineup. Each run costs a few cents to about $2 on OpenRouter and counts toward the monthly cap. At most ${PANEL_MAX_PER_MONTH} a month. Results: <a href="/arena/history">/arena/history</a>.</p>
<table><thead><tr><th>Model</th><th>Pinned</th><th></th></tr></thead><tbody>${models.map((m) => {
        const pinned = m.route.model;
        return html`<tr><td>${m.name}${m.embargoed ? " (embargoed: results stay hidden)" : ""}</td><td><code>${pinned}</code></td><td>${ran.has(`${m.id}|${pinned}`)
          ? html`<span class="muted">already run</span>`
          : html`<form method="post" action="/admin/arena-panel"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="model" value="${m.id}"><button class="btn chamfer" type="submit">Run panel</button></form>`}</td></tr>`;
      })}</tbody></table>
<h2>Queued so far</h2>
${done.length ? html`<ul>${done.map((d) => html`<li>${new Date(d.createdAt).toISOString().slice(0, 10)} · ${d.modelId} · <code>${d.pinnedModel}</code> via ${d.provider} · ${d.bouts} bouts · ${d.queuedBy}</li>`)}</ul>` : html`<p>None yet.</p>`}`,
    },
    { cache: false },
  );
});

site.post("/admin/arena-panel", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const model = String(g.form.get("model") ?? "").slice(0, 64);
  const out = await queuePanel(c.env, model, `admin:${g.session.h}`);
  console.log("arena_panel_queue", JSON.stringify(out));
  return c.redirect(`/admin/arena-panel?r=${out.ok ? "queued" : out.reason}`);
});
