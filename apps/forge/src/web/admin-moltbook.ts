import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { CLAIM_KV, ERROR_KV, moltbookStatus, registerMoltbook } from "../social/moltbook";
import { LOG_KV, MAX_PER_DAY, PAUSE_KV, type LogEntry } from "../social/moltbook-replies";
import { csrfToken } from "./session";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";

// /admin/moltbook: the founder registers The Forge's Moltbook agent with one button (Dinike, 23 Oct: maximum agent
// exposure, as autonomously as possible). The Worker calls Moltbook's register endpoint and keeps the key in KV; the
// page shows only the claim link and code, for Dinike to verify his email and post the code on X. Admins only.

const page = { title: "Moltbook agent", description: "Connect The Forge's agent on Moltbook.", path: "/admin/moltbook", noindex: true };

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

site.get("/admin/moltbook", async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const status = await moltbookStatus(c.env);
  const claim = await c.env.KV.get<{ name?: string; claim_url: string; verification_code: string | null }>(CLAIM_KV, "json");
  const error = await c.env.KV.get(ERROR_KV);
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const paused = await c.env.KV.get(PAUSE_KV);
  const recent = ((await c.env.KV.get<LogEntry[]>(LOG_KV, "json")) ?? []).slice(-15).reverse();
  return send(c, {
    ...page,
    body: html`<h1 class="page-title">Moltbook agent</h1>
<p>Status: <b>${status}</b>${claim?.name ? html` · agent name <b>${claim.name}</b>` : ""}</p>
${error && status === "not_registered" ? html`<p class="notice warn">Last try failed: ${error}</p>` : ""}
${status === "not_registered"
  ? html`<p>Registers The Forge's agent on Moltbook ("TheAgentForge", or the next free name if that one is taken). The key stays on the server; you'll get a claim link.</p>
<form method="post" action="/admin/moltbook/register"><input type="hidden" name="csrf" value="${csrf}"><button class="btn primary chamfer" type="submit">Register on Moltbook</button></form>`
  : claim && status !== "claimed"
    ? html`<p>Finish the claim: open the link, verify your email, then post the code on X.</p>
<p><a class="btn primary chamfer" href="${claim.claim_url}" rel="noopener" target="_blank">Open the claim page</a></p>
<p>Verification code: <code>${claim.verification_code ?? "shown on the claim page"}</code></p>`
    : html`<p>Connected. Posts go out when you approve a <code>moltbook</code> issue.</p>`}
<h2>Automatic replies</h2>
<p>Every hour the site answers questions on our own posts from our published data (at most ${MAX_PER_DAY} a day). Anything it can't answer comes to you as a <code>moltbook-replies</code> issue.</p>
<p>Status: <b>${paused ? "paused" : "on"}</b>${paused ? html` · ${paused}` : ""}</p>
<form method="post" action="/admin/moltbook/replies"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="to" value="${paused ? "on" : "off"}"><button class="btn chamfer" type="submit">${paused ? "Resume replies" : "Pause replies"}</button></form>
${recent.length
  ? html`<table><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Note</th></tr></thead><tbody>${recent.map(
      (e) => html`<tr><td>${e.at.slice(5, 16).replace("T", " ")}</td><td>${e.author}</td><td>${e.action}</td><td>${e.reply ?? e.reason ?? ""}</td></tr>`,
    )}</tbody></table>`
  : html`<p>No replies yet.</p>`}`,
  }, { cache: false });
});

site.post("/admin/moltbook/register", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const r = await registerMoltbook(c.env);
  console.log("moltbook_register", r.ok ? "ok" : r.error);
  return c.redirect("/admin/moltbook");
});

site.post("/admin/moltbook/replies", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const off = g.form.get("to") === "off";
  if (off) await c.env.KV.put(PAUSE_KV, "paused by an admin on /admin/moltbook");
  else await c.env.KV.delete(PAUSE_KV);
  console.log("moltbook_replies_switch", off ? "off" : "on");
  return c.redirect("/admin/moltbook");
});
