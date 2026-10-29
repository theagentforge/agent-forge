import { scanNote } from "@forge/shared";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb, newId } from "../services/db";
import { canonicalToolId, publisherFromId } from "../services/tools";
import { toolHref } from "./components";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";
import { bump, likelyPerson } from "../services/usage";

// Publisher claims, replies (free, always: MASTER_PLAN §8.2, §13) and disputes.

type Ctx = Context<{ Bindings: Env }>;
export const REPLY_MAX = 1000;
export const DISPUTE_MAX = 2000;

// Sign-in comes straight back to this page (the maintainer right of reply starts here, ADR 0065).
const signIn = (next: string) =>
  html`<p><a class="btn primary chamfer" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with GitHub</a> <span class="hint">You come back to <a href="${next}">this page</a>.</span></p>`;

/** A scan fingerprint's 64 hex characters, or "" (the dispute page's `scan` field). */
const scanHex = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : "");

/** A tool is claimable automatically when its id names a GitHub owner the person is, or belongs to publicly. */
function canClaim(toolId: string, login: string, orgs: string[]) {
  const owner = publisherFromId(toolId);
  return !!owner && (owner === login.toLowerCase() || orgs.includes(owner));
}

async function claimPage(c: Ctx, toolId: string, message?: string) {
  const db = getDb(c.env);
  const tool = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, toolId) });
  const s = await currentSession(c);
  const human = s ? await db.query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : undefined;
  const path = `/claim?tool=${encodeURIComponent(toolId)}`;
  const base = { title: "Claim a tool", description: "Publishers can claim their tools and reply to reports for free.", path, noindex: true };
  if (!toolId) return send(c, { ...base, path: "/claim", body: html`<h1 class="page-title">Claim a tool</h1><p>Publishers can claim their tool and reply to field reports, free. Find your tool, then use "Claim it" on its page.</p><p><a class="btn primary chamfer" href="/check">Find your tool</a></p>` }, { cache: false });
  if (!tool) return send(c, { ...base, status: 404, body: html`<h1 class="page-title">Claim a tool</h1><p>That tool has no reports yet, so there's nothing to claim.</p>` }, { cache: false });
  if (!s || !human) return send(c, { ...base, body: html`<h1 class="page-title">Claim ${tool.canonicalId}</h1><p>Publishers can claim their tool and reply to field reports. It's free and always will be.</p>${signIn(path)}` }, { cache: false });

  const claim = await db.query.publisherClaims.findFirst({
    where: and(eq(t.publisherClaims.toolId, tool.id), eq(t.publisherClaims.humanId, human.id), isNotNull(t.publisherClaims.verifiedAt)),
  });
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const eligible = canClaim(tool.canonicalId, human.githubLogin, s.session.o ?? []);
  return send(
    c,
    {
      ...base,
      body: html`<h1 class="page-title">Claim <span class="mono">${tool.canonicalId}</span></h1>
${message ? html`<p class="notice">${message}</p>` : ""}
${claim
  ? html`<p>You're the verified publisher of this tool. Your reply appears on <a href="${toolHref(tool.canonicalId)}">the tool page</a> next to the reports.</p>
<form class="stack" method="post" action="/claim/reply">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="tool" value="${tool.canonicalId}">
<label for="reply">Your reply (up to ${REPLY_MAX} characters)</label>
<textarea id="reply" name="body" maxlength="${REPLY_MAX}" required></textarea>
<p class="hint">Plain text. No secrets or personal data.</p>
<button class="btn primary chamfer" type="submit">Publish reply</button></form>`
  : eligible
    ? html`<p>Your GitHub account <strong>@${human.githubLogin}</strong> owns this tool's repository, so you can claim it now.</p>
<form method="post" action="/claim"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="tool" value="${tool.canonicalId}">
<button class="btn primary chamfer" type="submit">Claim this tool</button></form>`
    : html`<p>We couldn't match <strong>@${human.githubLogin}</strong> or your public GitHub organisations to this tool. If your organisation membership is private, make it public and sign in again. Or email <a href="mailto:disputes@theagentforge.io">disputes@theagentforge.io</a> and we'll verify you by hand.</p>`}`,
    },
    { cache: false },
  );
}

site.get("/claim", (c) => claimPage(c, canonicalToolId(c.req.query("tool") ?? "")));

site.post("/claim", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  const toolId = canonicalToolId(String(g.form.get("tool") ?? ""));
  const tool = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, toolId) });
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (!tool || !human || !canClaim(tool.canonicalId, human.githubLogin, g.session.o ?? [])) return c.text("Forbidden", 403);
  const now = Date.now();
  await db.insert(t.publisherClaims).values({ id: newId(), toolId: tool.id, humanId: human.id, method: "github_owner", verifiedAt: now, createdAt: now });
  await db.insert(t.auditLog).values({ id: newId(), actor: `human:${human.id}`, action: "publisher_claim", target: `tool:${tool.id}`, createdAt: now });
  return new Response(null, { status: 303, headers: { Location: `/claim?tool=${encodeURIComponent(tool.canonicalId)}` } });
});

site.post("/claim/reply", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  const toolId = canonicalToolId(String(g.form.get("tool") ?? ""));
  const tool = await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, toolId) });
  if (!tool) return c.text("Not found", 404);
  const claim = await db.query.publisherClaims.findFirst({
    where: and(eq(t.publisherClaims.toolId, tool.id), eq(t.publisherClaims.humanId, g.session.h), isNotNull(t.publisherClaims.verifiedAt)),
  });
  if (!claim) return c.text("Forbidden", 403);
  const body = String(g.form.get("body") ?? "").trim().slice(0, REPLY_MAX);
  if (!body) return claimPage(c, tool.canonicalId, "Write a reply first.");
  if (scanNote(body) === "credential") return claimPage(c, tool.canonicalId, "That reply looks like it contains a key or password, so it wasn't published.");
  await db.insert(t.replies).values({ id: newId(), toolId: tool.id, humanId: g.session.h, body, createdAt: Date.now() });
  return new Response(null, { status: 303, headers: { Location: toolHref(tool.canonicalId) } });
});

site.get("/disputes", async (c) => {
  const s = await currentSession(c);
  const tool = canonicalToolId(c.req.query("tool") ?? "");
  const sent = c.req.query("sent") === "1";
  const scan = scanHex(c.req.query("scan"));
  const path = tool ? `/disputes?tool=${encodeURIComponent(tool)}${scan ? `&scan=${scan}` : ""}` : "/disputes";
  // Maintainers arriving from a scan or answer page: a daily count only.
  if (c.req.query("from") === "maintainer" && !sent && likelyPerson(c.req.raw.headers)) c.executionCtx.waitUntil(bump(c.env, ["maintainer:reply_page"]).catch(() => {}));
  const csrf = s ? await csrfToken(c.env.SESSION_SECRET, s.token) : "";
  return send(
    c,
    {
      title: "Disputes",
      description: "Think a report or status on The Agent Forge is wrong? Tell us. We aim to answer within 7 days.",
      path,
      noindex: true,
      body: html`<h1 class="page-title">Disputes</h1>
<p>If you think a report, a score or a Watchlist status is wrong or unfair, tell us. A person reviews every dispute and aims to answer within 7 days. Publishers can also reply publicly by <a href="/claim${tool ? `?tool=${encodeURIComponent(tool)}` : ""}">claiming their tool</a>.</p>
${scan ? html`<p class="notice">About the scan <a href="/scan/${scan}">${scan.slice(0, 12)}…</a>${tool ? html` in <span class="mono">${tool}</span>` : ""}. Maintainers: reply to the findings, tell us what's a false match, or name the commit that fixes it (then <a href="/scan/${scan}">scan the latest version</a>, which gets its own page).</p>` : ""}
${sent ? html`<p class="notice">Thanks. Your dispute is logged and a person will review it.</p>` : ""}
${s
  ? html`<form class="stack" method="post" action="/disputes">
<input type="hidden" name="csrf" value="${csrf}">${scan ? html`<input type="hidden" name="scan" value="${scan}">` : ""}
<label for="d-tool">Tool</label><input id="d-tool" type="text" name="tool" value="${tool}" maxlength="512" placeholder="npm:@scope/name or github.com/owner/repo">
<label for="d-report">Report ID (optional)</label><input id="d-report" type="text" name="report" maxlength="64">
<label for="d-reason">What's wrong?</label><textarea id="d-reason" name="reason" maxlength="${DISPUTE_MAX}" required></textarea>
<button class="btn primary chamfer" type="submit">Send dispute</button></form>`
  : html`<p>Sign in so we know who's asking (we keep only your GitHub user number, username and account creation date), or email <a href="mailto:disputes@theagentforge.io">disputes@theagentforge.io</a>.</p>${signIn(path)}`}`,
    },
    { cache: false },
  );
});

site.post("/disputes", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  let reason = String(g.form.get("reason") ?? "").trim().slice(0, DISPUTE_MAX);
  if (!reason) return new Response(null, { status: 303, headers: { Location: "/disputes" } });
  const toolId = canonicalToolId(String(g.form.get("tool") ?? ""));
  const tool = toolId ? await db.query.tools.findFirst({ where: eq(t.tools.canonicalId, toolId) }) : undefined;
  // A scan, or a repository with no tool row yet (most scanned skills), is kept in the dispute's text so it isn't lost.
  const scan = scanHex(g.form.get("scan"));
  const about = [scan ? `[scan sha256:${scan}]` : "", !tool && toolId ? `[tool ${toolId.slice(0, 200)}]` : ""].filter(Boolean).join(" ");
  if (about) reason = `${about} ${reason}`.slice(0, DISPUTE_MAX + 300);
  if (scan) c.executionCtx.waitUntil(bump(c.env, ["maintainer:dispute_sent"]).catch(() => {}));
  const reportId = String(g.form.get("report") ?? "").trim();
  const report = reportId ? await db.query.reports.findFirst({ where: eq(t.reports.id, reportId) }) : undefined;
  const now = Date.now();
  const id = newId();
  await db.insert(t.disputes).values({ id, toolId: tool?.id ?? null, reportId: report?.id ?? null, openedByHumanId: g.session.h, reason, createdAt: now });
  await db.insert(t.auditLog).values({ id: newId(), actor: `human:${g.session.h}`, action: "dispute_opened", target: `dispute:${id}`, createdAt: now });
  return new Response(null, { status: 303, headers: { Location: "/disputes?sent=1" } });
});
