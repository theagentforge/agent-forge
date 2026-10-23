import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import { pgBoutCount, scorecardHref } from "../arena/agent-scorecard";
import * as t from "../db/schema";
import { agentFunnel, agentFunnelDaily, FUNNEL_STAGES } from "../services/agent-funnel";
import { isContributor, reportAlerts } from "../services/contribute";
import { getDb } from "../services/db";
import { shownInChecks } from "../services/feedback";
import { toolPageUrl } from "../services/tools";
import { fetchGithubIdentity, githubAuthorizeUrl, s256, WEB_STATE_PREFIX } from "../services/github";
import { canParticipate, isClosed } from "../services/access";
import { approveLogin, isAdmin, MAX_AGENTS_PER_HUMAN, upsertHuman, vouch, vouchesRemaining } from "../services/identity";
import { agentHref, ago, tierLabel } from "./components";
import { send, site } from "./pages";
import {
  checkCsrf,
  cookie,
  csrfToken,
  LOGIN_COOKIE,
  newSession,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sign,
  verify,
  type Session,
} from "./session";

// The human dashboard: sign in with GitHub on the website, then rename or revoke agents and vouch for people.

type Ctx = Context<{ Bindings: Env }>;

const MESSAGES = {
  renamed: "Agent renamed.",
  revoked: "Agent revoked. Its access stopped immediately.",
  vouched: "Vouch recorded. They are verified now, or the moment they sign in.",
  handle_taken: "That name is already taken.",
  handle_invalid: "Names are 3–32 characters: lowercase letters, numbers and dashes.",
  not_verified: "Only verified people can vouch.",
  vouch_self: "You can't vouch for yourself.",
  vouch_again: "You already vouched for that person.",
  vouch_limit: "You've used all your vouches.",
  login_invalid: "That isn't a valid GitHub username.",
  signed_out: "Signed out.",
  approved: "Approved. They can now help flag tools and vouch for others.",
  house_on: "Marked as House: labelled everywhere and left out of proof numbers.",
  house_off: "No longer House.",
  not_found: "Nobody with that GitHub username has signed in yet.",
  not_admin: "Only the founder can approve people.",
  scorecard_on: "Score page is public. Anyone with the link can see it, and the badge works in READMEs.",
  scorecard_off: "Score page is private again. Its page, JSON and badge now show \"not found\".",
  scorecard_no_bouts: "Nothing to publish: that agent has no refereed Ranked Ladder bouts yet.",
} as const;
type MessageKey = keyof typeof MESSAGES;

const back = (msg: MessageKey) => new Response(null, { status: 303, headers: { Location: `/dashboard?m=${msg}` } });

export async function currentSession(c: Ctx) {
  const token = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  const session = await verify<Session>(c.env.SESSION_SECRET, token);
  return session && token ? { session, token } : null;
}

/** Blocks cross-site form posts: the Origin must be ours and the CSRF token must match the session. */
export async function guardPost(c: Ctx) {
  const origin = c.req.header("Origin");
  if (origin && origin !== c.env.PUBLIC_ORIGIN) return null;
  const s = await currentSession(c);
  if (!s) return null;
  const form = await c.req.formData();
  if (!(await checkCsrf(c.env.SESSION_SECRET, s.token, String(form.get("csrf") ?? "")))) return null;
  return { ...s, form };
}

/** Where to go after sign-in: a path on this site only (ADR 0038: back to the /report draft). */
export const safeNext = (next: string | undefined) => (next && /^\/(?![/\\])[\x21-\x7e]{0,1023}$/.test(next) ? next : "/dashboard");

site.get("/auth/login", async (c) => {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const state = `${WEB_STATE_PREFIX}${crypto.randomUUID()}`;
  const next = safeNext(c.req.query("next"));
  const login = await sign(c.env.SESSION_SECRET, { state, verifier, next, exp: Math.floor(Date.now() / 1000) + 600 });
  return new Response(null, {
    status: 302,
    headers: {
      Location: githubAuthorizeUrl(c.env, state, await s256(verifier), "web"),
      "Set-Cookie": cookie(LOGIN_COOKIE, login, 600),
      "Cache-Control": "no-store",
    },
  });
});

site.get("/callback/web", async (c) => {
  const pending = await verify<{ state: string; verifier: string; next?: string }>(
    c.env.SESSION_SECRET,
    readCookie(c.req.header("Cookie"), LOGIN_COOKIE),
  );
  const code = c.req.query("code");
  if (!pending || !code || c.req.query("state") !== pending.state) {
    return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
  }
  let identity;
  try {
    identity = await fetchGithubIdentity(c.env, code, pending.verifier, "web");
  } catch {
    return new Response("GitHub sign-in failed. Please try again.", { status: 502 });
  }
  const human = await upsertHuman(getDb(c.env), identity.profile, Date.now());
  const headers = new Headers({ Location: safeNext(pending.next), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, await newSession(c.env.SESSION_SECRET, human.id, identity.orgs), SESSION_TTL_SECONDS));
  headers.append("Set-Cookie", cookie(LOGIN_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
});

site.post("/auth/logout", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  return new Response(null, {
    status: 303,
    headers: { Location: "/dashboard?m=signed_out", "Set-Cookie": cookie(SESSION_COOKIE, "", 0) },
  });
});

site.get("/dashboard", async (c) => {
  const s = await currentSession(c);
  const m = c.req.query("m") as MessageKey | undefined;
  const message = m && m in MESSAGES ? MESSAGES[m] : null;
  const base = { title: "Your agents", description: "Manage your agents on The Agent Forge.", path: "/dashboard", nav: "dashboard" as const, noindex: true };
  if (!s) {
    return send(
      c,
      {
        ...base,
        body: html`<h1 class="page-title">Your agents</h1>${message ? html`<p class="notice">${message}</p>` : ""}
<p>Sign in to rename or revoke your agents and vouch for people. We keep only your GitHub user number, username and account creation date.</p>
<p><a class="btn primary chamfer" href="/auth/login">Sign in with GitHub</a></p>`,
      },
      { cache: false },
    );
  }
  const db = getDb(c.env);
  const human = await db.query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  if (!human) return new Response(null, { status: 303, headers: { Location: "/dashboard", "Set-Cookie": cookie(SESSION_COOKIE, "", 0) } });
  const agents = await db.select().from(t.agents).where(eq(t.agents.humanId, human.id)).orderBy(desc(t.agents.createdAt));
  const bouts = new Map(await Promise.all(agents.map(async (a) => [a.id, await pgBoutCount(db, a.id)] as const)));
  const vouches = await db
    .select({ login: t.trustGrants.githubLogin, createdAt: t.trustGrants.createdAt })
    .from(t.trustGrants)
    .where(eq(t.trustGrants.grantedByHumanId, human.id));
  const remaining = human.tier === "verified" ? await vouchesRemaining(db, human.id) : 0;
  const admin = isAdmin(c.env, human.githubId);
  const waiting = admin
    ? await db
        .select({ login: t.humans.githubLogin, tier: t.humans.tier, via: t.humans.verifiedVia, createdAt: t.humans.createdAt })
        .from(t.humans)
        .where(and(ne(t.humans.id, human.id), or(isNull(t.humans.verifiedVia), eq(t.humans.verifiedVia, "activity"))))
        .orderBy(desc(t.humans.createdAt))
        .limit(50)
    : [];
  const house = admin
    ? await db.select({ login: t.humans.githubLogin }).from(t.humans).where(eq(t.humans.isHouse, true)).limit(50)
    : [];
  const funnel = admin ? await agentFunnel(c.env).catch(() => null) : null;
  const funnelDays = admin ? await agentFunnelDaily(c.env).catch(() => []) : [];
  const waitingForAccess = isClosed(c.env) && !canParticipate(c.env, human);
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const now = Date.now();
  const active = agents.filter((a) => a.status === "active").length;
  const yours = await yourReports(c.env, db, human.id, now);

  return send(
    c,
    {
      ...base,
      body: html`<h1 class="page-title">Your agents</h1>
${message ? html`<p class="notice">${message}</p>` : ""}
<p>Signed in as <strong class="mono">@${human.githubLogin}</strong> ${tierLabel(human.tier)} ${
        human.verifiedVia ? html`<span class="muted small">(via ${human.verifiedVia})</span>` : ""
      }</p>
${waitingForAccess ? html`<p class="notice warn"><strong>You're on the list.</strong> The Forge is invite-only until launch. Connecting agents and filing reports open once the founder approves you; checking tools works now.</p>` : ""}
${human.tier === "sandbox" && !waitingForAccess ? html`<p class="notice warn">You're in the sandbox: your agents' reports are shown and counted, but weigh less in scores. Ask a verified person to vouch for you, or see the <a href="/methodology">methodology</a>.</p>` : ""}

${yours}
<section aria-labelledby="agents-h"><h2 id="agents-h">Agents (${active} of ${MAX_AGENTS_PER_HUMAN})</h2>
${agents.length === 0 ? html`<p class="empty">No agents yet. <a href="/connect">Connect one</a>.</p>` : ""}
${agents.map(
  (a) => html`<div class="panel chamfer panel-body spaced">
<h3 class="mono"><a href="${agentHref(a.handle)}">${a.handle}</a> <span class="muted small">${a.framework} · connected ${ago(a.createdAt, now)}${a.status === "revoked" ? " · revoked" : ""}</span></h3>
${a.status === "active" ? html`<form class="stack" method="post" action="/dashboard/agents/${a.id}/rename">
<input type="hidden" name="csrf" value="${csrf}">
<label for="h-${a.id}">Public name</label>
<input id="h-${a.id}" type="text" name="handle" value="${a.handle}" pattern="[a-z0-9-]{3,32}" required>
<button class="btn chamfer" type="submit">Rename</button>
</form>
<form class="actions top-gap" method="post" action="/dashboard/agents/${a.id}/revoke">
<input type="hidden" name="csrf" value="${csrf}">
<button class="btn danger chamfer" type="submit">Revoke this agent</button>
<span class="hint">Its access stops immediately. Its past reports stay.</span>
</form>` : ""}
${scorecardPanel(a, bouts.get(a.id) ?? 0, csrf)}
</div>`,
)}
</section>

<section aria-labelledby="vouch-h"><h2 id="vouch-h">Vouch for someone</h2>
${human.tier === "verified"
        ? html`<p>Vouching makes someone verified. Vouch only for people you know are real and honest. <strong>${remaining}</strong> vouches left.</p>
<form class="stack" method="post" action="/dashboard/vouch">
<input type="hidden" name="csrf" value="${csrf}">
<label for="vouch-login">Their GitHub username</label>
<input id="vouch-login" type="text" name="github_login" pattern="@?[A-Za-z0-9-]{1,39}" required autocomplete="off">
<button class="btn primary chamfer" type="submit"${remaining === 0 ? " disabled" : ""}>Vouch</button>
</form>`
        : html`<p class="muted">Only verified people can vouch.</p>`}
${vouches.length ? html`<ul>${vouches.map((v) => html`<li class="mono">@${v.login} <span class="muted">${ago(v.createdAt, now)}</span></li>`)}</ul>` : ""}
</section>

${admin && funnel ? agentFunnelPanel(funnel, funnelDays) : ""}

${admin
        ? html`<section aria-labelledby="approve-h"><h2 id="approve-h">Approve people (founder only)</h2>
<p>Approved people count fully, can help flag a tool, and can vouch for 5 others. Approve people you've talked to, such as design partners.</p>
<form class="stack" method="post" action="/dashboard/approve">
<input type="hidden" name="csrf" value="${csrf}">
<label for="approve-login">GitHub username (sign-in not needed yet)</label>
<input id="approve-login" type="text" name="github_login" pattern="@?[A-Za-z0-9-]{1,39}" required autocomplete="off">
<button class="btn primary chamfer" type="submit">Approve</button>
</form>
${waiting.length
            ? html`<h3 class="top-gap">Signed in, not yet approved or vouched</h3><ul class="feed">${waiting.map(
                (w) => html`<li><div class="fi-title"><a href="https://github.com/${w.login}" rel="noopener">@${w.login}</a> ${tierLabel(w.tier)}</div><div class="fi-time">${ago(w.createdAt, now)}</div>
<div class="fi-meta">${w.via ? "GitHub activity" : ""}<form class="inline-form" method="post" action="/dashboard/approve"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="github_login" value="${w.login}"><button class="btn chamfer" type="submit">Approve</button></form></div></li>`,
              )}</ul>`
            : html`<p class="muted">Nobody is waiting.</p>`}
<h3 class="top-gap">House accounts</h3>
<p class="small muted">Our own test agents' owners. Their reports show a "house" label and are left out of every proof number on /stats.</p>
<form class="stack" method="post" action="/dashboard/house">
<input type="hidden" name="csrf" value="${csrf}">
<label for="house-login">GitHub username (must have signed in)</label>
<input id="house-login" type="text" name="github_login" pattern="@?[A-Za-z0-9-]{1,39}" required autocomplete="off">
<div class="copy-row"><button class="btn chamfer" type="submit" name="house" value="on">Mark as House</button><button class="btn chamfer" type="submit" name="house" value="off">Remove House</button></div>
</form>
${house.length ? html`<ul>${house.map((h) => html`<li class="mono">@${h.login}</li>`)}</ul>` : html`<p class="muted small">No House accounts yet.</p>`}
</section>`
        : ""}

<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Sign out</button></form>`,
    },
    { cache: false },
  );
});

/** ADR 0023 §6: the owner's switch for the agent's Proving Ground score page. Private by default. */
function scorecardPanel(a: typeof t.agents.$inferSelect, bouts: number, csrf: string) {
  if (bouts === 0)
    return html`<p class="hint top-gap">Score page: none yet. It opens after this agent's first <a href="/arena/proving-ground">Ranked Ladder</a> bout through the Forge MCP.</p>`;
  const href = scorecardHref(a.handle);
  return html`<form class="actions top-gap" method="post" action="/dashboard/agents/${a.id}/scorecard">
<input type="hidden" name="csrf" value="${csrf}">
${a.scorecardPublic
    ? html`<span>Score page: <strong>public</strong> at <a href="${href}">${href}</a></span><button class="btn chamfer" type="submit" name="public" value="off">Make private</button>`
    : html`<span>Score page: <strong>private</strong></span><button class="btn chamfer" type="submit" name="public" value="on">Make public</button>`}
<span class="hint">Making it public shows, to anyone: this agent's name, your GitHub username, your verified status, its ${bouts} refereed Ranked Ladder ${bouts === 1 ? "bout" : "bouts"} with links to each replay, the traps it caught and fell for, and a signed summary and README badge. Turn it off any time.</span>
</form>`;
}

async function ownAgent(c: Ctx, humanId: string) {
  return getDb(c.env).query.agents.findFirst({
    where: and(eq(t.agents.id, c.req.param("id") ?? ""), eq(t.agents.humanId, humanId)),
  });
}

site.post("/dashboard/agents/:id/rename", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const agent = await ownAgent(c, g.session.h);
  if (!agent || agent.status !== "active") return c.text("Not found", 404);
  const handle = String(g.form.get("handle") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{3,32}$/.test(handle) || /^-|-$/.test(handle)) return back("handle_invalid");
  if (handle === agent.handle) return back("renamed");
  const taken = await getDb(c.env).query.agents.findFirst({ where: eq(t.agents.handle, handle) });
  if (taken) return back("handle_taken");
  await getDb(c.env).update(t.agents).set({ handle }).where(eq(t.agents.id, agent.id));
  return back("renamed");
});

site.post("/dashboard/agents/:id/revoke", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const agent = await ownAgent(c, g.session.h);
  if (!agent) return c.text("Not found", 404);
  const db = getDb(c.env);
  await db.update(t.agents).set({ status: "revoked" }).where(eq(t.agents.id, agent.id));
  // Also drop its OAuth grant, so its access and refresh tokens stop working, not just its writes.
  try {
    const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(g.session.h);
    await Promise.all(items.filter((x) => x.clientId === agent.oauthClientId).map((x) => c.env.OAUTH_PROVIDER.revokeGrant(x.id, g.session.h)));
  } catch {
    // The agent row is already revoked, which blocks every tool; a leftover grant can do nothing.
  }
  await db.insert(t.auditLog).values({
    id: crypto.randomUUID(),
    actor: `human:${g.session.h}`,
    action: "agent_revoked",
    target: `agent:${agent.id}`,
    createdAt: Date.now(),
  });
  return back("revoked");
});

site.post("/dashboard/agents/:id/scorecard", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const agent = await ownAgent(c, g.session.h);
  if (!agent) return c.text("Not found", 404);
  const db = getDb(c.env);
  const on = g.form.get("public") === "on";
  if (on && (await pgBoutCount(db, agent.id)) === 0) return back("scorecard_no_bouts");
  const now = Date.now();
  await db.update(t.agents).set({ scorecardPublic: on, scorecardSince: on ? now : null }).where(eq(t.agents.id, agent.id));
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${g.session.h}`, action: on ? "scorecard_public" : "scorecard_private", target: `agent:${agent.id}`, createdAt: now });
  // The badge is edge-cached for a few minutes; drop this data centre's copy so "private" shows at once here.
  if (!on) await caches.default.delete(new Request(`${c.env.PUBLIC_ORIGIN}${scorecardHref(agent.handle)}/badge.svg`)).catch(() => false);
  return back(on ? "scorecard_on" : "scorecard_off");
});

site.post("/dashboard/approve", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  const me = await db.query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (!me || !isAdmin(c.env, me.githubId)) return back("not_admin");
  const login = String(g.form.get("github_login") ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return back("login_invalid");
  const now = Date.now();
  await approveLogin(db, login, now);
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${me.id}`, action: "approve", target: `github:${login.toLowerCase()}`, createdAt: now });
  return back("approved");
});

site.post("/dashboard/house", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const db = getDb(c.env);
  const me = await db.query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (!me || !isAdmin(c.env, me.githubId)) return back("not_admin");
  const login = String(g.form.get("github_login") ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9-]{1,39}$/.test(login)) return back("login_invalid");
  const on = g.form.get("house") === "on";
  const target = await db.query.humans.findFirst({ where: sql`lower(${t.humans.githubLogin}) = ${login}` });
  if (!target) return back("not_found");
  await db.update(t.humans).set({ isHouse: on }).where(eq(t.humans.id, target.id));
  await db.insert(t.auditLog).values({ id: crypto.randomUUID(), actor: `human:${me.id}`, action: on ? "house_on" : "house_off", target: `github:${login}`, createdAt: Date.now() });
  return back(on ? "house_on" : "house_off");
});

site.post("/dashboard/vouch", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const login = String(g.form.get("github_login") ?? "").trim();
  if (!/^@?[A-Za-z0-9-]{1,39}$/.test(login)) return back("login_invalid");
  const r = await vouch(getDb(c.env), g.session.h, login, Date.now());
  if (r.ok) return back("vouched");
  const map = {
    voucher_not_verified: "not_verified",
    cannot_vouch_for_self: "vouch_self",
    already_vouched: "vouch_again",
    vouch_limit_reached: "vouch_limit",
  } as const;
  return back(map[r.reason]);
});

/** Founder-only: the agent funnel with exact numbers (no minimums), the 14-day trend and where each stage comes from. */
function agentFunnelPanel(f: Awaited<ReturnType<typeof agentFunnel>>, daily: Awaited<ReturnType<typeof agentFunnelDaily>>) {
  const n = (v: number) => v.toLocaleString("en-US");
  const rate = (k: string) => {
    const r = (f.rates as Record<string, number | null>)[k];
    return r === undefined ? "" : r === null ? "–" : `${r}%`;
  };
  const d = f.detail;
  return html`<section aria-labelledby="funnel-h"><h2 id="funnel-h">AI agents using the Forge (founder only)</h2>
<p class="small muted">Exact numbers, last 7 days, no minimums; <a href="/stats#agents">/stats</a> shows each step from its minimum. House agents and directory health checks are left out.</p>
<div class="scroll-x"><table class="table">
<thead><tr><th scope="col">Step</th><th scope="col" class="num">7 days</th><th scope="col" class="num">Of the step before</th></tr></thead>
<tbody>${FUNNEL_STAGES.map(([k, short, long]) => html`<tr><td><strong>${short}</strong><br><span class="small muted">${long}</span></td><td class="num">${n(f.stages[k])}</td><td class="num">${rate(k)}</td></tr>`)}</tbody></table></div>
<p class="small">Signed-in agents of people outside the project, all time: <strong>${n(f.signed_in_agents_all_time)}</strong>.</p>
<details><summary>Where the numbers come from</summary><ul class="small">
<li>AI page fetches: ${n(d.ai_fetches)} · discovery files: ${n(d.discovery_file_fetches)} · skill files: ${n(d.skill_file_fetches)}</li>
<li>MCP sessions: ${n(d.mcp_sessions)} · A2A requests: ${n(d.a2a_requests)} · tool calls: ${n(d.tool_calls)} · API scans: ${n(d.api_scans)}</li>
<li>Left out: directory health checks ${n(d.directory_health_checks)} · House MCP sessions ${n(d.house_mcp_sessions)}</li>
</ul></details>
${daily.length
    ? html`<h3 class="top-gap">Last 14 days</h3><div class="scroll-x"><table class="table">
<thead><tr><th scope="col">Day (UTC)</th><th scope="col" class="num">Found us</th><th scope="col" class="num">Connected</th><th scope="col" class="num">Used a tool</th></tr></thead>
<tbody>${[...daily].reverse().map((x) => html`<tr><td class="mono">${x.day}</td><td class="num">${n(x.found)}</td><td class="num">${n(x.connected)}</td><td class="num">${n(x.used)}</td></tr>`)}</tbody></table></div>`
    : ""}
</section>`;
}

/**
 * ADR 0038: what contributing gives back. Alerts when a tool you reported on is flagged, each report's reach (checks
 * that showed it), and whether your agents have the contributor check limit. Shown only to the signed-in owner.
 */
async function yourReports(env: Env, db: ReturnType<typeof getDb>, humanId: string, now: number) {
  const rows = await db
    .select({ id: t.reports.id, toolRef: t.tools.id, tool: t.tools.canonicalId, version: t.toolVersions.version, outcome: t.reports.outcome, createdAt: t.reports.createdAt, held: t.reports.held })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.reports.toolVersionId, t.toolVersions.id))
    .innerJoin(t.tools, eq(t.toolVersions.toolId, t.tools.id))
    .where(eq(t.reports.humanId, humanId))
    .orderBy(desc(t.reports.createdAt))
    .limit(20);
  const [shown, alerts, contributor] = await Promise.all([
    shownInChecks(db, rows.map((r) => ({ id: r.id, toolId: r.toolRef, createdAt: r.createdAt }))),
    reportAlerts(db, env.PUBLIC_ORIGIN, humanId),
    isContributor(env, db, humanId, now),
  ]);
  const reach = [...shown.values()].reduce((a, n) => a + n, 0);
  return html`<section aria-labelledby="reports-h"><h2 id="reports-h">Your reports</h2>
${alerts.length ? html`<div class="notice warn"><strong>Alerts:</strong> ${alerts.length === 1 ? "a tool" : `${alerts.length} tools`} you reported on now ${alerts.length === 1 ? "has" : "have"} a flagged version.<ul>${alerts.map((a) => html`<li><a class="mono" href="${a.page_url}">${a.tool_id}</a> ${a.version}: ${a.security_status}</li>`)}</ul></div>` : ""}
${rows.length
  ? html`<p><b>${reach.toLocaleString("en-US")}</b> checks showed your reports.${contributor ? " Your agents get 5× the check limit as a contributor." : ""}</p>
<table class="table"><thead><tr><th scope="col">Tool</th><th scope="col">Outcome</th><th scope="col" class="num">Shown in checks</th><th scope="col">Filed</th></tr></thead><tbody>${rows.map(
      (r) => html`<tr><td class="mono"><a href="${toolPageUrl(env.PUBLIC_ORIGIN, r.tool)}">${r.tool}</a> ${r.version}</td><td>${r.outcome}${r.held ? html` <span class="muted small">held for review</span>` : ""}</td><td class="num">${(shown.get(r.id) ?? 0).toLocaleString("en-US")}</td><td>${ago(r.createdAt, now)}</td></tr>`,
    )}</tbody></table>`
  : html`<p class="empty">No reports yet. Every check result your agent gets has a <code>report_url</code>; open it after you use a tool to file in one tap. Contributors' agents get 5× the check limit, and alerts here if a tool they reported on is flagged.</p>`}
</section>`;
}
