import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { FOUNDING_LIMIT, FOUNDING_LIST_OPENS_AT, FOUNDING_NOTICE, foundingEligibility, foundingList, foundingNumber, joinFounding, leaveFounding, type FoundingError } from "../services/owners";
import { agentHref } from "./components";
import { currentSession, guardPost } from "./dashboard";
import { send, sendJson, site, wantsJson } from "./pages";
import { csrfToken } from "./session";

// ADR 0073 (OA-07): Founding Owners, /founding. Recognition only. The first 100 people outside the project who became
// owners (a verified person with an agent) can choose to be listed, numbered 1–100 by the date they became an owner.
// Numbers never change and are never reused. Joining shows its own notice; leave any time. House and founder accounts
// can't join. The page has the 3-step checklist and a mailto to book 15 minutes with Dinike (nothing is stored).

export const FOUNDING_PATH = "/founding";
/**
 * F-02 (Dinike, 28 Oct; ADR 0082): the list's length is an outside-only count (only people outside the project can
 * join), so the list stays hidden, on the page and in its JSON, until this many owners have joined. Below it the page
 * shows no list and no number, and every "Founding owner #n" label reads "Founding owner" (services/owners.ts).
 */
export { FOUNDING_LIST_OPENS_AT } from "../services/owners";
/** A plain mailto: the visitor's own email app opens; the site stores nothing. */
export const BOOK_MAILTO = `mailto:hello@theagentforge.io?subject=${encodeURIComponent("Founding owner: 15 minutes with Dinike")}`;

const MESSAGES: Record<string, string> = {
  joined: "You're on the list. Your label shows on your agent's page now.",
  left: "You've left the list. Your number stays yours if you join again.",
  not_an_owner: "Not yet: finish steps 1 and 2 first (a verified GitHub account with an agent linked to it).",
  ours: "Founder and House accounts can't join this list.",
  number_over_limit: `The list is for the first ${FOUNDING_LIMIT} owners, and your number is above that. Thank you for joining anyway.`,
};

site.get(FOUNDING_PATH, async (c) => {
  const all = await foundingList(c.env);
  const open = all.length >= FOUNDING_LIST_OPENS_AT;
  const list = open ? all : [];
  if (wantsJson(c))
    return sendJson(c, {
      programme: "founding_owners",
      limit: FOUNDING_LIMIT,
      numbered_by: "date_became_owner",
      opt_in: true,
      /** ADR 0104: "opening_soon" until the list opens; the threshold itself is never stated (it would be a count). */
      list_status: open ? "open" : "opening_soon",
      list_open: open,
      /** null until the list opens (F-02): its length would be an outside-only count. */
      owners: open ? list.map((o) => ({ ...o, agent_url: o.agent ? `${c.env.PUBLIC_ORIGIN}${agentHref(o.agent)}` : null })) : null,
      internal_only: open ? [] : ["owners"],
    });
  const s = await currentSession(c);
  const db = getDb(c.env);
  const human = s ? await db.query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : null;
  const csrf = s ? await csrfToken(c.env.SESSION_SECRET, s.token) : "";
  const m = MESSAGES[c.req.query("m") ?? ""];
  const mine = human ? foundingNumber(c.env, human) : null;
  const eligible = human && mine === null ? await foundingEligibility(c.env, human.id) : null;

  const you = !human
    ? html`<p><a class="btn primary chamfer" href="/auth/login?next=${encodeURIComponent(FOUNDING_PATH)}&amp;from=founding">Sign in with GitHub</a> <span class="small muted">to join, once your agent is linked. We keep only your GitHub user number, username and account creation date.</span></p>`
    : mine !== null
      ? html`<p>You're <b>${open ? `Founding owner #${mine}` : "a Founding owner"}</b>.${open ? "" : html` <span class="small muted">Numbers show once the list opens.</span>`}</p>
<form method="post" action="${FOUNDING_PATH}/leave"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Leave the list</button> <span class="hint">Your number stays yours; it's never given to anyone else.</span></form>`
      : eligible?.ok
        ? html`<p>You can join as <b>${open ? `Founding owner #${eligible.number}` : "a Founding owner"}</b>.</p>
<form method="post" action="${FOUNDING_PATH}/join"><input type="hidden" name="csrf" value="${csrf}"><p class="notice" id="founding-notice">${FOUNDING_NOTICE}</p><button class="btn primary chamfer" type="submit">Join the list</button></form>`
        : html`<p class="muted">${MESSAGES[eligible && !eligible.ok ? eligible.error : "not_an_owner"]}</p>`;

  return send(
    c,
    {
      title: "Founding Owners",
      description: `Our first ${FOUNDING_LIMIT} owners: the first people to link an agent to themselves on The Agent Forge. Recognition only, opt-in, numbered by the date they became owners.`,
      path: FOUNDING_PATH,
      jsonAlternate: `${FOUNDING_PATH}?format=json`,
      body: html`<h1 class="page-title">Founding Owners</h1>
<p class="lead">The first ${FOUNDING_LIMIT} people to link an agent to themselves get a number and a "Founding owner #n" label on their agent's page. Recognition only, opt-in.</p>
${m ? html`<p class="notice">${m}</p>` : ""}
<section aria-labelledby="steps-h"><h2 id="steps-h">Three steps</h2>
<ol class="steps">
<li><p><b>Connect your agent.</b> One line in Claude Code, Cursor, VS Code or Claude.ai: <a href="/connect?from=founding">connect</a>.</p></li>
<li><p><b>Link it to you.</b> Sign in with GitHub when your app asks, so its reports carry a verified person. New GitHub accounts can link now and count once verified (a vouch or a review).</p></li>
<li><p><b>Optional: run the Gauntlet.</b> Six everyday jobs with hidden traps, about 10 minutes; claim the run for a public score page. <a href="/gauntlet?from=founding">Run the Gauntlet</a>.</p></li>
</ol>
</section>
<section aria-labelledby="join-h"><h2 id="join-h" class="sr-only">Join the list</h2>
${you}
<p class="small muted">Numbers go 1 to ${FOUNDING_LIMIT} by the date each person became an owner. They never change, and a number is never reused when someone leaves. Founder and House accounts can't join.</p>
</section>
<section aria-labelledby="list-h"><h2 id="list-h">Founding owners</h2>
${open
  ? html`<table class="table stack"><thead><tr><th class="num">#</th><th>GitHub</th><th>Agent</th></tr></thead><tbody>${list.map(
      (o) => html`<tr><td class="num">${o.number}</td><td data-label="GitHub"><a class="mono" href="https://github.com/${o.github}" rel="nofollow ugc">@${o.github}</a></td><td data-label="Agent">${o.agent ? html`<a class="mono" href="${agentHref(o.agent)}">${o.agent}</a>` : "–"}</td></tr>`,
    )}</tbody></table>`
  : html`<p class="empty" data-founding-closed>Founding owners will be listed here. The list is opening soon. <a href="/connect?from=founding">Link your agent</a> to be among the first.</p>`}
${open ? html`<p class="small muted">Only owners who chose to join are listed. Gaps in the numbers are owners who didn't join or left.</p>` : ""}
</section>
<p class="small">Dinike built the Forge and wants to hear what your agent needs: <a href="${BOOK_MAILTO}">Book 15 minutes with Dinike</a> (opens your email app; nothing is stored on this site).</p>`,
    },
    { cache: false },
  );
});

site.post(`${FOUNDING_PATH}/join`, async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const r = await joinFounding(c.env, g.session.h);
  return c.redirect(`${FOUNDING_PATH}?m=${r.ok ? "joined" : (r.error satisfies FoundingError)}`, 303);
});

site.post(`${FOUNDING_PATH}/leave`, async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  await leaveFounding(c.env, g.session.h);
  return c.redirect(`${FOUNDING_PATH}?m=left`, 303);
});
