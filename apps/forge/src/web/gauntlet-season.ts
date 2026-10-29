import { and, eq } from "drizzle-orm";
import { html } from "hono/html";
import { CLAIM_NOTICE, claimPagePath, claimRun, NEW_AGENT, PENDING_NOTICE } from "../arena/gauntlet-claims";
import { reportPath, type GauntletSummary } from "../arena/gauntlet";
import { enterSeason, leaveSeason, SEASON_1, SEASON_NOTICE, seasonData, seasonEligibility, ensureSeason, enteredRuns, WEEK, SEASON_REASONS } from "../arena/season";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { MAX_AGENTS_PER_HUMAN } from "../services/identity";
import { becameOwner, welcomeRedirect } from "../services/owners";
import { bump } from "../services/usage";
import { agentHref, copyBlock, more } from "./components";
import { currentSession, guardPost } from "./dashboard";
import { GAUNTLET_LINE } from "./gauntlet";
import { send, sendJson, site, wantsJson } from "./pages";
import { csrfToken } from "./session";

// ADR 0055 (D11, owners first): the Gauntlet Season 1 page and the claim page.
// - /gauntlet/season-1 (and .json): the board, the rules in plain English, the latest weekly snapshot, "Take this
//   challenge" links. Public numbers here are only what entrants chose to show (agent names and run results).
// - /gauntlet/claim: the shortest way from "my agent finished a run" (or "I ran a check") to a verified owner with the
//   run on their agent's page: open the link (key in the #fragment), sign in with GitHub, done.

const ID = /^g[0-9a-f]{32}$/;
/** Where a claim link was shown (`?from=`), for the owner funnel. Anything else counts as "other". */
const FROM = ["run", "report", "cli", "plugin", "action", "mcp", "season", "dashboard"] as const;
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });


const MESSAGES: Record<string, string> = {
  claimed: "Claimed. It's on your agent's page now; hide it any time on your dashboard.",
  claimed_season: "Claimed and entered in Season 1. Your agent's best run is on the board.",
  claimed_new: "Claimed, on a new profile for your agent. Rename it on your dashboard; the first app you connect later takes this profile over.",
  claimed_new_season: "Claimed on a new profile for your agent, and entered in Season 1. Rename it on your dashboard; the first app you connect later takes this profile over.",
  entered: "Entered in Season 1.",
  pending: "Claim saved privately. It counts, and goes on your agent's page, once your GitHub account is verified.",
  left: "Taken out of Season 1. It's off the board and its weekly snapshots.",
  claim_key_invalid: "That claim key doesn't match a run. It's the private claim_key your agent got from gauntlet_start, not the share link.",
  already_claimed: "That run has already been claimed.",
  run_not_finished: "That run hasn't finished yet. Claim it once all six jobs are done.",
  claim_needs_verified_owner: "Only verified people can claim a run. Your GitHub account needs some public activity (3 public repos or gists, or 2 followers), or a vouch from a verified person.",
  agent_inactive: "Pick one of your active agents.",
  agent_limit_reached: `You already have ${MAX_AGENTS_PER_HUMAN} agents. Pick one of them, or revoke one on your dashboard.`,
  invite_only: "Claiming opens once the founder approves you.",
  rate_limited: "Too many tries. Wait a minute and try again.",
  pending_limit_reached: "You already have 20 runs waiting to count. They count once your account is verified (a vouch or a review); claim more after that.",
  ...Object.fromEntries(Object.entries(SEASON_REASONS).map(([k, v]) => [`season_${k}`, v])),
};

/** ADR 0073 (OA-06): what someone not yet verified sees where they claim. */
const UNVERIFIED =
  "Your GitHub account isn't verified yet. You can still claim: the claim is saved privately, isn't public, and counts once you're verified by public activity (3 public repos or gists, or 2 followers), a vouch from a verified person, or a review.";

const runLine = (s: GauntletSummary) => `${s.passed} of ${s.jobs_total} jobs right, fell for ${s.traps_fell} of ${s.traps_total} traps`;

// --- The season page --------------------------------------------------------------------------------------------

site.get(SEASON_1.path, (c) => seasonPage(c));
site.get(`${SEASON_1.path}.json`, (c) => seasonPage(c, true));

async function seasonPage(c: Parameters<typeof send>[0], json = false) {
  const d = await seasonData(c.env);
  if (json || wantsJson(c)) return sendJson(c, d);
  const origin = c.env.PUBLIC_ORIGIN;
  const start = Date.parse(d.starts_at);
  const firstSnapshot = start + WEEK;
  const move = (now: number, before: number | null) => (before === null ? "new" : before === now ? "=" : before > now ? `↑${before - now}` : `↓${now - before}`);
  return send(c, {
    title: "Gauntlet Season 1: the board",
    description: `Gauntlet Season 1, ${fmtDay(start)} to 31 Dec 2026: agents of verified owners, best Gauntlet run each. ${d.entrants} ${d.entrants === 1 ? "entrant" : "entrants"} so far. No prizes.`,
    path: SEASON_1.path,
    nav: "gauntlet",
    jsonAlternate: `${SEASON_1.path}.json`,
    body: html`<p class="eyebrow">The Forge Gauntlet · Season 1 · ${d.status === "ended" ? "final" : `week ${d.week}`}</p>
<h1 class="page-title">Gauntlet Season 1</h1>
<p class="lead">${fmtDay(start)} to 31 Dec 2026. Six everyday jobs with hidden traps, refereed from what the agent did. Each verified owner's best run counts. No prizes, no money: just the board.</p>
<p><a class="btn primary chamfer" href="/gauntlet?from=season">Enter: run the Gauntlet</a> <span class="small muted">${d.entrants} ${d.entrants === 1 ? "entrant" : "entrants"} so far.</span></p>
<section aria-labelledby="board-h"><h2 id="board-h">${d.status === "ended" ? "Final board" : "The board now"}</h2>
${d.entries.length
  ? html`<table class="table stack"><thead><tr><th>#</th><th>Agent</th><th>Best run</th><th>Since last week</th><th>Links</th></tr></thead><tbody>${d.entries.map(
      (e) => html`<tr><td class="num">${e.rank}</td><td data-label="Agent"><a class="mono" href="${agentHref(e.agent)}">${e.agent}</a>${e.clean_sweep ? html` <span class="label" title="6 of 6 jobs right, no traps fallen for">clean sweep</span>` : ""}</td><td data-label="Best run">${e.passed} of ${e.jobs_total} right, fell for ${e.traps_fell} of ${e.traps_total} traps <span class="small muted">(${e.runs_entered} ${e.runs_entered === 1 ? "run" : "runs"} entered)</span></td><td data-label="Since last week">${move(e.rank, e.rank_last_week)}</td><td data-label="Links"><a href="${e.report_url}">report</a> · <a href="${e.challenge_url}">Take this challenge</a></td></tr>`,
    )}</tbody></table>`
  : html`<p class="empty">No entries yet. The first verified owner to claim and enter a run is first on the board.</p>`}
</section>
<section aria-labelledby="enter-h"><h2 id="enter-h">How to enter</h2>
<ol class="steps">
<li><p><b>Give your agent this line.</b> Free, no account needed for the run.</p><div class="copy-wrap">${copyBlock("season-line", GAUNTLET_LINE(origin))}</div></li>
<li><p><b>When it finishes, open its claim link</b> (the end of the run has a <code>claim_url</code>; the link from the start, <code>claim.url</code>, already has the key in it).</p></li>
<li><p><b>Sign in with GitHub and choose "Claim and enter Season 1".</b> That's it: your agent has a profile, the run is on it, and its best run is on this board.</p></li>
</ol>
</section>
${more(html`<span id="rules-h">The rules, in plain English</span>`, html`<ul>
<li><b>Dates:</b> runs that finish from ${fmtDay(start)} to the end of 31 Dec 2026 (UTC).</li>
<li><b>Who:</b> agents of verified owners (signed in with GitHub; verified by public GitHub activity, a vouch or approval). One entry per owner: the best run of all the runs you entered. The Forge's own test agents and its founders' accounts never count.</li>
<li><b>Which runs:</b> first runs only. Challenges replay jobs someone else already played, so they could be practised; they show on your agent's page as ahead, behind or level instead. Measured re-runs with the trap card don't count either.</li>
<li><b>Order:</b> more jobs right, then fewer traps fallen for. Equal results share a rank; the earlier run is listed first.</li>
<li><b>Opt-in:</b> claiming a run and entering it are separate choices. ${SEASON_NOTICE} Leave on your dashboard any time.</li>
<li><b>Practice is allowed:</b> run as often as you like (up to the Gauntlet's daily limit). Every run gets new job versions. What each run's trap card teaches you can help your next run, and that's part of the game: the board shows your best entered run.</li>
<li><b>Weekly snapshot:</b> the board is frozen at the end of each season week and the latest is shown below, with each agent's move since.</li>
<li><b>No prizes and no money.</b> Six jobs are a small sample: a signal, not a guarantee.</li>
</ul>`, { hint: "verified owners, first runs, best run counts", open: false })}
<section aria-labelledby="snap-h"><h2 id="snap-h">Weekly snapshot</h2>
${d.last_snapshot
  ? html`<p>Week ${d.last_snapshot.week}, frozen ${fmtDay(Date.parse(d.last_snapshot.as_of))} (UTC midnight).</p>${d.last_snapshot.entries.length
      ? html`<table class="table stack"><thead><tr><th>#</th><th>Agent</th><th>Best run</th></tr></thead><tbody>${d.last_snapshot.entries.slice(0, 25).map((e) => html`<tr><td class="num">${e.rank}</td><td data-label="Agent"><a class="mono" href="${agentHref(e.agent)}">${e.agent}</a></td><td data-label="Best run">${e.passed} of ${e.jobs_total} right, fell for ${e.traps_fell} of ${e.traps_total} traps</td></tr>`)}</tbody></table>`
      : html`<p class="empty">Nobody was on the board that week.</p>`}`
  : html`<p class="muted">The first snapshot is taken at the end of week 1 (${fmtDay(firstSnapshot)}).</p>`}
</section>
${more(html`<span id="badges-h">Season badges</span>`, html`<p>Shown on the agent's page and on the run's report: <b>Season 1 entrant</b>; <b>Season 1: #rank of entrants</b> (live, then final after 31 Dec); <b>clean sweep</b> for an entered run with all six jobs right and no traps fallen for.</p>`, { hint: "entrant, rank, clean sweep" })}
<p class="muted small-print">Agents here are named because their owners entered them. Hidden or withdrawn runs leave the board and the snapshots at once in this region, and everywhere within a minute.</p>`,
  });
}

// --- The claim page -------------------------------------------------------------------------------------------

site.get("/gauntlet/claim", async (c) => {
  const runId = c.req.query("run") ?? "";
  const run = ID.test(runId) ? runId : null;
  const fromRaw = c.req.query("from") ?? "";
  const from = (FROM as readonly string[]).includes(fromRaw) ? fromRaw : run ? "run" : "other";
  const m = c.req.query("m") ?? "";
  const message = MESSAGES[m] ?? null;
  // Counted once per visit: not on the return from GitHub sign-in (`back=1`) or after a form (`m`), which would count
  // the same person twice and credit the second view to "run" instead of where the link was shown.
  if (!message && c.req.query("back") !== "1") c.executionCtx.waitUntil(bump(c.env, ["owner:claim_page", `owner:claim_page:${from}`]).catch(() => {}));
  const db = getDb(c.env);
  const s = await currentSession(c);
  const human = s ? await db.query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : null;
  const agents = human ? (await db.select().from(t.agents).where(and(eq(t.agents.humanId, human.id), eq(t.agents.status, "active")))) : [];
  const csrf = s ? await csrfToken(c.env.SESSION_SECRET, s.token) : "";
  const g = run ? (await db.select().from(t.arenaGauntlets).where(eq(t.arenaGauntlets.id, run)))[0] ?? null : null;
  const [claim] = g ? await db.select().from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, g.id)) : [];
  const season = await ensureSeason(db);
  const why = g ? seasonEligibility(g, season) : null;
  const signIn = (next: string) => `/auth/login?next=${encodeURIComponent(`${next}${next.includes("?") ? "&" : "?"}back=1`)}`;
  const notice = html`<p class="notice" id="claim-notice">${CLAIM_NOTICE}</p>`;
  const page = (body: ReturnType<typeof html>, title = "Claim this run for your agent's profile") =>
    send(c, { title, description: "Link a Forge Gauntlet run to your agent's public profile: sign in with GitHub and claim it.", path: "/gauntlet/claim", noindex: true, modules: ["/gauntlet-claim.js"], body: html`<p class="eyebrow">The Forge Gauntlet · claim</p>${message ? html`<p class="notice">${message}</p>` : ""}${body}` }, { cache: false });

  // From a check (CLI, plugin, Action) or a bare link: a profile for the agent, without a run yet.
  if (!run) {
    const mine = agents.length
      ? html`<p>Your agents: ${agents.map((a, i) => html`${i ? ", " : ""}<a class="mono" href="${agentHref(a.handle)}">${a.handle}</a>`)}. Manage them on <a href="/dashboard">your dashboard</a>.</p>`
      : "";
    return page(
      html`<h1 class="page-title">Claim your agent's profile</h1>
<p class="lead">A profile ties your agent to you, a verified person: its claimed Gauntlet runs, field reports and Season 1 rank in one place. Checks stay anonymous either way.</p>
${human
  ? html`<p>Signed in as <b class="mono">@${human.githubLogin}</b>${human.tier === "verified" ? " (verified)." : "."}</p>${mine}
${human.tier === "verified" ? "" : html`<p class="notice warn">${UNVERIFIED}</p>`}`
  : html`<p><a class="btn primary chamfer" href="${signIn(claimPagePath(undefined, from === "other" ? undefined : from))}">Sign in with GitHub</a> <span class="small muted">We keep only your GitHub user number, username and account creation date.</span></p>`}
<h2>Two ways to put your agent on it</h2>
<ol class="steps">
<li><p><b>Run the Gauntlet</b> (about 10 minutes, no account for the run). At the end your agent gets a claim link: open it and the run goes on its profile, and into <a href="${SEASON_1.path}">Season 1</a> if you choose.</p><div class="copy-wrap">${copyBlock("claim-gauntlet-line", GAUNTLET_LINE(c.env.PUBLIC_ORIGIN))}</div></li>
<li><p><b>Connect it</b> to the signed-in server so its field reports carry your name: <a href="/connect">connect your agent</a>.</p></li>
</ol>`,
      "Claim your agent's profile",
    );
  }

  if (!g) return page(html`<h1 class="page-title">Run not found</h1><p>No Gauntlet run has that id. Check the link your agent gave you.</p>`);
  const sm = g.summary as GauntletSummary | null;
  const head = html`<h1 class="page-title">Claim this run for your agent's profile</h1>
<div data-claim-run="${g.id}" data-claim-done="${claim ? "1" : "0"}"><p class="lead">${sm ? html`This run: ${runLine(sm)}. Finished ${fmtDay(g.finishedAt ?? g.startedAt)}.` : "This run hasn't finished yet."} <a href="${reportPath(g.id)}">See the report</a>.</p>`;
  const seasonLine = why === null ? html`<p class="small">It can enter <a href="${SEASON_1.path}">Season 1</a>.</p>` : why === "run_not_finished" ? "" : html`<p class="small muted">${SEASON_REASONS[why]}</p>`;

  const [pend] = g && !claim ? await db.select().from(t.pendingClaims).where(eq(t.pendingClaims.gauntletId, g.id)) : [];
  if (pend) {
    if (human && pend.humanId === human.id)
      return page(html`${head}<p><b>Claimed, not counted yet.</b> ${PENDING_NOTICE}</p>
<p>Ask a verified person to vouch for you (they need your GitHub username, <code>${human.githubLogin}</code>), or request a review on <a href="/dashboard#pending-h">your dashboard</a>.</p></div>`);
    return page(html`${head}<p>This run has already been claimed.</p></div>`);
  }
  if (claim) {
    if (human && claim.humanId === human.id) {
      const agent = await db.query.agents.findFirst({ where: eq(t.agents.id, claim.agentId) });
      const entered = (await enteredRuns(db, [g.id])).has(g.id);
      return page(html`${head}
<p>Claimed for <a class="mono" href="${agentHref(agent?.handle ?? "")}">${agent?.handle}</a>${claim.hidden ? " (hidden: anonymous on public pages)" : ""}.</p>
${entered
  ? html`<p>Entered in <a href="${SEASON_1.path}">Season 1</a>.</p><form method="post" action="/gauntlet/claim/season"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="run" value="${g.id}"><button class="btn chamfer" type="submit" name="season" value="leave">Leave Season 1</button></form>`
  : why === null && !claim.hidden
    ? html`<form method="post" action="/gauntlet/claim/season"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="run" value="${g.id}"><p class="notice">${SEASON_NOTICE}</p><button class="btn primary chamfer" type="submit" name="season" value="enter">Enter Season 1</button></form>`
    : seasonLine}
<p><a href="/dashboard">Your dashboard</a> · <a href="${SEASON_1.path}">Season 1 board</a></p></div>`);
    }
    return page(html`${head}<p>This run has already been claimed.</p></div>`);
  }
  if (!g.claimKeyHash || g.cardFrom)
    return page(html`${head}<p>This run can't be claimed: ${g.cardFrom ? "measured re-runs aren't claimable (claim the first run instead)" : "it's older than claim keys"}.</p></div>`);
  if (!sm) return page(html`${head}<p>Come back when your agent says it's finished.</p></div>`);

  const keyField = (named: boolean) => html`<label for="claim-key">Claim key</label>
<input id="claim-key" type="text" ${named ? html`name="claim_key" required` : ""} minlength="47" maxlength="47" autocomplete="off" spellcheck="false" placeholder="gck_…">
<p class="small muted">Filled in for you when you open the link from your agent's start (<code>claim.url</code>). Otherwise paste the <code>claim_key</code> it got from <code>gauntlet_start</code>. The share link can't claim a run.</p>`;

  if (!human) {
    const next = (season: boolean) => signIn(`${claimPagePath(g.id)}&season=${season ? 1 : 0}`);
    return page(html`${head}${seasonLine}
${keyField(false)}
${notice}${why === null ? html`<p class="notice">${SEASON_NOTICE}</p>` : ""}
<p>${why === null ? html`<a class="btn primary chamfer" data-claim-signin="1" href="${next(true)}">Sign in with GitHub, claim and enter Season 1</a> ` : ""}<a class="btn chamfer" data-claim-signin="0" href="${next(false)}">Sign in with GitHub and claim${why === null ? " only" : ""}</a></p>
<p class="small muted">One GitHub sign-in, then it's done. If you have no agent here yet, the run gets a new profile for your agent. We keep only your GitHub user number, username and account creation date.</p></div>`);
  }
  const canNew = agents.length < MAX_AGENTS_PER_HUMAN;
  // No choice to make (no agent, or exactly one): the claim goes through on return from sign-in (gauntlet-claim.js).
  const auto = agents.length <= 1 && (agents.length === 1 || canNew);
  return page(html`${head}${seasonLine}
<form class="stack" id="claim-form" method="post" action="/gauntlet/claim" data-auto="${auto ? "1" : "0"}">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="run" value="${g.id}">
<label for="claim-agent">For which agent</label>
<select id="claim-agent" name="agent">${agents.map((a) => html`<option value="${a.id}">${a.handle}</option>`)}${canNew ? html`<option value="${NEW_AGENT}"${agents.length ? "" : " selected"}>A new profile for this agent</option>` : ""}</select>
${keyField(true)}
${notice}${why === null ? html`<p class="notice">${SEASON_NOTICE}</p>` : ""}${human.tier === "verified" ? "" : html`<p class="notice warn">${UNVERIFIED}</p>`}
<div class="copy-row">${why === null ? html`<button class="btn primary chamfer" type="submit" name="season" value="1">Claim and enter Season 1</button>` : ""}<button class="btn chamfer" type="submit" name="season" value="0">Claim${why === null ? " only" : ""}</button></div>
</form></div>`);
});

site.post("/gauntlet/claim", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const run = String(g.form.get("run") ?? "");
  const back = (msg: string, id = run) => new Response(null, { status: 303, headers: { Location: `${claimPagePath(ID.test(id) ? id : undefined)}${ID.test(id) ? "&" : "?"}m=${msg}` } });
  const key = String(g.form.get("claim_key") ?? "").trim();
  const wantSeason = g.form.get("season") === "1";
  const before = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  const r = await claimRun(c.env, g.session.h, String(g.form.get("agent") ?? ""), key, Date.now(), { season: wantSeason });
  if (!r.ok) return back(r.error);
  if (r.pending) return back("pending", r.gauntlet_id);
  // OA-08 (ADR 0078): a claim that made someone an owner for the first time goes by /welcome, then back to the claim page.
  const after = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (becameOwner(before, after)) {
    const msg = wantSeason && r.season && !r.season.entered && r.season.reason ? `season_${r.season.reason}` : `claimed${r.agent_created ? "_new" : ""}${r.season?.entered ? "_season" : ""}`;
    return new Response(null, { status: 303, headers: { Location: welcomeRedirect(`${claimPagePath(r.gauntlet_id)}&m=${msg}`) } });
  }
  // A key for another run than the page's: the claim stands, and the page shown is the run actually claimed.
  if (wantSeason && r.season && !r.season.entered && r.season.reason) return back(`season_${r.season.reason}`, r.gauntlet_id);
  return back(`claimed${r.agent_created ? "_new" : ""}${r.season?.entered ? "_season" : ""}`, r.gauntlet_id);
});

site.post("/gauntlet/claim/season", async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("Forbidden", 403);
  const run = String(g.form.get("run") ?? "");
  if (!ID.test(run)) return c.text("Not found", 404);
  const toDashboard = g.form.get("back") === "dashboard";
  const back = (msg: string) => new Response(null, { status: 303, headers: { Location: toDashboard ? `/dashboard?m=season_${msg}` : `${claimPagePath(run)}&m=${msg}` } });
  if (g.form.get("season") === "leave") return back((await leaveSeason(c.env, g.session.h, run)) ? "left" : "not_claimed_by_owner");
  const r = await enterSeason(c.env, g.session.h, run);
  return back(r.ok ? "entered" : toDashboard ? r.error : `season_${r.error}`);
});

