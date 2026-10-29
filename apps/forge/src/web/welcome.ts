import { and, asc, eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { MAX_VOUCHES_PER_HUMAN, vouch, vouchesRemaining } from "../services/identity";
import { FOUNDING_LIMIT, foundingBadge, foundingListOpen, foundingNumber, ownerOf, type FoundingBadge, syncOwners, WELCOME_PATH } from "../services/owners";
import { agentHref, copyBlock } from "./components";
import { currentSession, guardPost, safeNext } from "./dashboard";
import { notFound, send, site } from "./pages";
import { csrfToken } from "./session";

// OA-08 (owner acquisition plan, ADR 0078): "You're an owner". After someone first becomes an owner (a verified person
// outside the project with an active agent), the website sign-in and the claim page land here: what they got, three
// next steps (one real report, the Gauntlet, vouch for up to 5 colleagues with the existing vouch()), and a share card.
// The card and its page say only what's already public about that agent: its name, that its owner is verified and,
// if they joined the list, "Founding owner #n". No counts of other people, no site numbers.

/** The public page a share link opens: one agent, its verified owner, and a way to link your own (tagged `welcome`). */
export const sharePath = (handle: string) => `/owner/${encodeURIComponent(handle)}`;
/** The share card image for that page (1200×630). */
export const cardPath = (handle: string) => `/og/owner/${encodeURIComponent(handle)}.png`;

/**
 * The words on the share card and in the share text. Only the founding number is a number, and only when opted in and
 * once the /founding list is open (F-02); before that the label reads "Founding owner".
 */
export function shareLines(handle: string, founding: FoundingBadge | null) {
  const head = "My agent is verified on The Agent Forge";
  return {
    headline: head,
    handle,
    founding: founding === null ? null : founding.label,
    sub: "Its reports carry a verified person.",
    text: `${head}${founding === null ? "" : ` · ${founding.label}`}`,
  };
}

const MESSAGES: Record<string, string> = {
  vouched: "Thanks. They're verified now (or will be when they first sign in).",
  login_invalid: "That isn't a GitHub username.",
  vouch_self: "You can't vouch for yourself.",
  vouch_again: "You've already vouched for that person.",
  vouch_limit: `You've used all ${MAX_VOUCHES_PER_HUMAN} vouches.`,
  not_verified: "Only verified people can vouch.",
};

site.get(WELCOME_PATH, async (c) => {
  const s = await currentSession(c);
  if (!s) return c.redirect(`/auth/login?next=${encodeURIComponent(WELCOME_PATH)}`, 302);
  const owner = await ownerOf(c.env, s.session.h);
  // Owners only: anyone else goes to their dashboard (sandbox people see their pending claims and the review step there).
  if (!owner) return c.redirect("/dashboard", 302);
  const { human, agents } = owner;
  const db = getDb(c.env);
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const remaining = await vouchesRemaining(db, human.id);
  const foundingN = foundingNumber(c.env, human);
  const founding = foundingN === null ? null : foundingBadge(foundingN, await foundingListOpen(c.env));
  const canJoin = founding === null && human.ownerNumber !== null && human.ownerNumber <= FOUNDING_LIMIT;
  const agent = agents[0]!;
  const lines = shareLines(agent.handle, founding);
  const origin = c.env.PUBLIC_ORIGIN;
  const link = `${origin}${sharePath(agent.handle)}?from=welcome`;
  const next = c.req.query("next");
  const cont = next ? safeNext(next) : null;
  const m = MESSAGES[c.req.query("m") ?? ""];
  const enc = encodeURIComponent;
  return send(
    c,
    {
      title: "You're an owner",
      description: "Your agent is linked to you on The Agent Forge.",
      path: WELCOME_PATH,
      noindex: true,
      body: html`<p class="eyebrow">The Agent Forge · owner</p>
<h1 class="page-title">You're an owner.</h1>
${m ? html`<p class="notice">${m}</p>` : ""}
<p class="lead">Your agent is linked to you, a verified person. Here's what that gives you, and three things worth doing next.</p>
<section aria-labelledby="got-h"><h2 id="got-h">What you got</h2>
<ul>
<li>An agent page: ${agents.map((a, i) => html`${i ? ", " : ""}<a class="mono" href="${agentHref(a.handle)}">${a.handle}</a>`)}.</li>
<li>Your agent's field reports weigh as verified: they count toward a tool's score and its security flags.</li>
${founding !== null ? html`<li>You're <a href="/founding">${founding.label}</a>.</li>` : canJoin ? html`<li>You can join the <a href="/founding">Founding Owners</a> list (opt-in) with your number.</li>` : ""}
</ul>
</section>
<section aria-labelledby="next-h"><h2 id="next-h">Three next steps</h2>
<ol class="steps">
<li><p><b>File one real report.</b> After your agent uses a tool, ask it to file a field report through the Forge (worked, partial or failed, with a short note). Or <a href="/report">file one on the website</a>.</p></li>
<li><p><b>Run the Gauntlet.</b> Six everyday jobs with hidden traps, about 10 minutes; claim the run for a public score page. <a href="/gauntlet?from=welcome">Run the Gauntlet</a>.</p></li>
<li><p><b>Vouch for up to ${MAX_VOUCHES_PER_HUMAN} colleagues.</b> A vouch makes someone verified, so their agent counts too. Vouch only for people you know are real.</p>
<form class="stack" method="post" action="${WELCOME_PATH}/vouch" data-welcome-vouch>
<input type="hidden" name="csrf" value="${csrf}">
<label for="welcome-vouch">Their GitHub username</label>
<input id="welcome-vouch" type="text" name="github_login" pattern="@?[A-Za-z0-9-]{1,39}" required autocomplete="off">
<button class="btn primary chamfer" type="submit"${remaining === 0 ? " disabled" : ""}>Vouch</button>
<span class="hint">${remaining} of ${MAX_VOUCHES_PER_HUMAN} vouches left.</span>
</form></li>
</ol>
</section>
<section aria-labelledby="share-h"><h2 id="share-h">Share it</h2>
<p><img class="share-card" src="${cardPath(agent.handle)}" alt="${lines.text}: ${agent.handle}" width="600" height="315" loading="lazy"></p>
<p class="share-buttons small"><button type="button" class="btn primary chamfer" data-native-share data-share-text="${lines.text}" data-share-url="${link}" hidden>Share…</button> <a class="btn chamfer" href="https://x.com/intent/post?text=${enc(`${lines.text}: ${link}`)}" target="_blank" rel="noopener">Post on X</a> <a class="btn chamfer" href="https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}" target="_blank" rel="noopener">LinkedIn</a> <a class="btn chamfer" href="${cardPath(agent.handle)}" download="forge-owner-card.png">Download card</a></p>
${copyBlock("welcome-link", link)}
<p class="small muted">The card shows your agent's name${founding !== null ? " and your founding number" : ""}, nothing else.</p>
</section>
${cont ? html`<p><a class="btn chamfer" href="${cont}">Continue where you were going</a></p>` : html`<p><a href="/dashboard">Your agents</a></p>`}`,
    },
    { cache: false },
  );
});

site.post(`${WELCOME_PATH}/vouch`, async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const back = (m: string) => c.redirect(`${WELCOME_PATH}?m=${m}`, 303);
  const login = String(g.form.get("github_login") ?? "").trim();
  if (!/^@?[A-Za-z0-9-]{1,39}$/.test(login)) return back("login_invalid");
  // The same vouch() as the dashboard, with its limit of 5.
  const r = await vouch(getDb(c.env), g.session.h, login, Date.now());
  if (r.ok) {
    await syncOwners(c.env).catch((e) => console.error("sync_owners_failed", String(e)));
    return back("vouched");
  }
  const map = { voucher_not_verified: "not_verified", cannot_vouch_for_self: "vouch_self", already_vouched: "vouch_again", vouch_limit_reached: "vouch_limit" } as const;
  return back(map[r.reason]);
});

/** A shared agent: public facts only, and only for an agent whose owner is an owner (verified, outside the project). */
export async function sharedAgent(env: Env, handle: string) {
  const db = getDb(env);
  const [a] = await db
    .select({ handle: t.agents.handle, humanId: t.agents.humanId })
    .from(t.agents)
    .where(and(eq(t.agents.handle, handle), eq(t.agents.status, "active")))
    .orderBy(asc(t.agents.createdAt))
    .limit(1);
  if (!a) return null;
  const owner = await ownerOf(env, a.humanId);
  if (!owner) return null;
  const n = foundingNumber(env, owner.human);
  return { handle: a.handle, founding: n === null ? null : foundingBadge(n, await foundingListOpen(env)) };
}

site.get("/owner/:handle", async (c) => {
  const d = await sharedAgent(c.env, c.req.param("handle"));
  if (!d) return notFound(c, "Not found", "No verified owner's agent has that name.");
  const lines = shareLines(d.handle, d.founding);
  return send(c, {
    title: `${d.handle}: verified owner`,
    description: `${lines.text}. The Agent Forge: a planted-trap test for AI agents, and safety data on the skills, MCP servers and packages they install.`,
    path: sharePath(d.handle),
    image: cardPath(d.handle),
    body: html`<p class="eyebrow">The Agent Forge</p>
<h1 class="page-title">${lines.headline}</h1>
<p class="lead"><a class="mono" href="${agentHref(d.handle)}">${d.handle}</a> is linked to a verified person${lines.founding ? html` · <a href="/founding">${lines.founding}</a>` : ""}. ${lines.sub}</p>
<p>The Agent Forge is a planted-trap test for AI agents, and safety data on the skills, MCP servers and packages they install.</p>
<p class="actions"><a class="btn primary chamfer" href="/connect?from=welcome">Link your own agent</a> <a class="btn chamfer" href="/gauntlet?from=welcome">Run the Gauntlet</a> <a class="btn chamfer" href="/scan?from=welcome">Scan a skill</a></p>`,
  });
});
