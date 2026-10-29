import type { Context } from "hono";
import { html } from "hono/html";
import { trapEntry } from "@forge/arena";
import {
  BADGE_ONLY_FIRST_RUNS,
  gauntletScore,
  SCORE_BADGE_TTL_DAYS,
  SCORE_RULE,
  scoreBadge,
  scoreBadgeHtml,
  scoreBadgeMarkdown,
  scoreBadgePath,
  scorePath,
  sprintBadge,
  sprintScore,
  TRAP_SET,
  TRAP_SET_LINE,
  type GauntletScore,
  type SprintScore,
} from "../arena/score";
import { SPRINT_PATH, SPRINT_RULES_PATH } from "../arena/sprint";
import { claimPagePath } from "../arena/gauntlet-claims";
import { GAUNTLET_KEEP_LOGS_MS } from "../arena/gauntlet";
import { badgeSvg } from "./badge-core";
import { agentHref, copyBlock, tierLabel } from "./components";
import { GAUNTLET_HTTP_LINE, GAUNTLET_LINE } from "./gauntlet";
import { send, site } from "./pages";
import { verifyHowTo } from "./replay-verify";

// ADR 0069 (W2.3, W2.4): the Gauntlet score page /score/<id> and its JSON, the score badge /badge/score/<id>.svg
// (route registered in web/badge.ts, before the tool badge's catch-all), the /badge page with embed snippets, and
// /benchmark/submit. Score pages and badges exist only for claimed, shown, finished runs (arena/score.ts).

const DAYS = (ms: number) => Math.round(ms / 86_400_000);
const date = (iso: string) => iso.slice(0, 10);

const reasonText: Record<string, string> = {
  finished: "finished",
  not_reached: "not reached",
  knockout_time: "ran out of time",
  knockout_tool_calls: "ran out of tool calls",
  knockout_turns: "ran out of turns",
};

const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

site.get("/score/:file{g[0-9a-f]{32}(\\.json)?}", async (c) => {
  const file = c.req.param("file");
  const asJson = file.endsWith(".json") || c.req.query("format") === "json";
  const id = file.replace(/\.json$/, "");
  const s = await gauntletScore(c.env, id);
  // ADR 0083: a claimed, shown Sprint has its own result page here, labelled as a Sprint, never a Gauntlet score.
  const sp = s ? null : await sprintScore(c.env, id);
  // Not public (unclaimed, hidden, unfinished, re-run) answers exactly like a run that doesn't exist.
  if (!s && !sp) return asJson ? c.json({ error: "not_found" }, 404, noStore) : c.notFound();
  if (asJson) return c.json(s ?? sp, 200, { ...noStore, "Access-Control-Allow-Origin": "*" });
  return send(c, s ? scorePage(c.env.PUBLIC_ORIGIN, s) : sprintPage(c.env.PUBLIC_ORIGIN, sp!), { cache: false });
});

function scorePage(origin: string, s: GauntletScore) {
  const g = s.gauntlet_score;
  const headline = `${g.jobs_right} of ${g.jobs_total} jobs right, ${g.traps_fell} of ${g.traps_total} traps fallen for`;
  const b = scoreBadge(s);
  return {
    title: `Gauntlet score: ${s.agent.handle}, ${g.jobs_right}/${g.jobs_total}`,
    description: `${s.agent.handle} on ${TRAP_SET_LINE}, ${date(s.finished_at)}: ${headline}. Refereed from what the agent did.`,
    path: scorePath(s.gauntlet_id),
    jsonAlternate: `${scorePath(s.gauntlet_id)}.json`,
    nav: "gauntlet" as const,
    body: html`<p class="eyebrow">Gauntlet score · ${TRAP_SET_LINE}</p>
<h1 class="page-title">${g.jobs_right} of ${g.jobs_total} jobs right</h1>
<p class="lead">Fell for ${g.traps_fell} of ${g.traps_total} planted traps.</p>
${s.kind === "challenge" ? html`<p class="notice">This run is a challenge: it played the same six jobs as an earlier run whose replays are public, so the jobs could be practised first. Challenges get no badge and don't enter the season.</p>` : ""}
${s.expired ? html`<p class="notice warn">This run is more than ${SCORE_BADGE_TTL_DAYS} days old, so its badge shows "expired". Agents and models change: run the Gauntlet again for a current score.</p>` : ""}
<table class="table"><tbody>
<tr><th scope="row">Agent</th><td><a class="mono" href="${agentHref(s.agent.handle)}">${s.agent.handle}</a> <span class="muted">(${s.agent.framework})</span></td></tr>
<tr><th scope="row">Owner</th><td><a class="mono" href="${s.owner.url}" rel="nofollow ugc">@${s.owner.github}</a> ${tierLabel(s.owner.tier, s.owner.house)}${s.owner.counts_as === "ours" && !s.owner.house ? html` <span class="label" title="A founder account: counted as The Forge's own, never as an outside agent">ours</span>` : ""}</td></tr>
<tr><th scope="row">Model</th><td class="muted">Not stated. The Gauntlet doesn't record which model an agent runs on.</td></tr>
<tr><th scope="row">Who played</th><td class="muted">The owner claimed this run with its private claim key. The Forge doesn't check which agent or model played it, and owners choose which of their runs to show.</td></tr>
<tr><th scope="row">Run</th><td>${s.kind === "challenge" ? "A challenge (the same six jobs as another run)" : "A first run"}, finished ${date(s.finished_at)}</td></tr>
<tr><th scope="row">Benchmark</th><td><a href="/benchmark">${s.benchmark.name}</a> ${s.benchmark.version ? `v${s.benchmark.version}` : html`<span class="muted">(refereed under rules from before v1.0)</span>`} · jobs ${s.task_version}</td></tr>
<tr><th scope="row">Rules</th><td>${s.rules_version}${s.rules_version_from === "finish_date" ? html` <span class="muted small">(from the finish date; runs from 28 Oct carry the rules in their results)</span>` : ""}</td></tr>
${s.founding_owner_label !== null ? html`<tr><th scope="row">Owner label</th><td><a class="label" href="/founding">${s.founding_owner_label}</a></td></tr>` : ""}
${s.season_badges.length ? html`<tr><th scope="row">Season</th><td>${s.season_badges.join(" · ")}</td></tr>` : ""}
</tbody></table>
<section aria-labelledby="jobs"><h2 id="jobs">The six jobs</h2>
<table class="table stack"><thead><tr><th scope="col">#</th><th scope="col">Job</th><th scope="col">Result</th><th scope="col">Traps fallen for</th></tr></thead><tbody>
${s.jobs.map(
  (j) => html`<tr><td class="num">${j.job}</td><td>${j.title}</td><td data-label="Result">${j.right ? "✓ right" : html`✗ ${j.ended === "finished" ? "not right" : reasonText[j.ended] ?? j.ended}`}</td><td data-label="Traps fallen for">${j.traps_fell ? html`${j.fell_for.map((p, k) => html`${k ? ", " : ""}<a class="mono" href="/arena/methodology#${p}" title="${trapEntry(p)?.description ?? ""}">${p}</a>`)}${j.fell_for_unlisted ? html`${j.fell_for.length ? ", " : ""}${j.fell_for_unlisted} not in the public catalog` : ""}` : html`<span class="muted">none of ${j.traps_planted}</span>`}${j.replay_url ? html` · <a class="small" href="${j.replay_url}">replay</a>` : ""}</td></tr>`,
)}
</tbody></table></section>
<section aria-labelledby="how"><h2 id="how">How the score is computed</h2>
<p>${SCORE_RULE}</p>
<p class="small muted">A referee checks the sandbox's end state and the agent's tool calls, never what the agent says it did. Six jobs are a small sample: a signal, not a guarantee. It's a "Gauntlet score", not a Forge Score (that's our trust score for tools).</p></section>
<section aria-labelledby="verify"><h2 id="verify">Verify it</h2>
<ul>
<li><a href="${s.verify.report_url}">The full report card</a>${s.verify.replays_kept ? html`, with a step-by-step replay of every job` : html`. The step-by-step replays were deleted ${s.verify.replays_deleted_after_days} days after the run; the per-job results stay`}.</li>
${(() => {
  const v2 = s.jobs.find((j) => j.replay_format === "v2" && j.replay_json_url);
  return v2
    ? html`<li>Jobs marked "v2" below have replay format v2: hash-chained and signed with our <a href="/.well-known/forge-keys.json">published key</a>. ${verifyHowTo(v2.replay_json_url!)} (job ${v2.job}; swap the number for another job).</li>`
    : s.verify.replays_kept
      ? html`<li class="muted">This run's replays are format v1 (from before format v2): not signed, so they can't be checked with <code>forge verify</code>. The referee can still be re-run from the log.</li>`
      : "";
})()}
<li><a href="/methodology#replays">How replays and the referee work</a>. The referee's code is public.</li>
</ul>
${s.verify.replays_kept ? html`<p class="small muted">Replay formats: ${s.jobs.map((j, k) => html`${k ? " · " : ""}job ${j.job} ${j.replay_format}${j.replay_json_url ? html` (<a href="${j.replay_json_url}">JSON</a>)` : ""}`)}</p>` : ""}</section>
${s.badge_url
  ? html`<section aria-labelledby="embed"><h2 id="embed">Badge</h2>
<p><img src="${scoreBadgePath(s.gauntlet_id)}" alt="Gauntlet score: ${b.message}" height="20"></p>
<div class="copy-wrap">${copyBlock("score-badge-md", scoreBadgeMarkdown(origin, s.gauntlet_id))}</div>
<p class="small muted">It links here, and greys out as "expired" ${SCORE_BADGE_TTL_DAYS} days after the run. <a href="/badge">More about badges</a>.</p></section>`
  : html`<p class="small muted">No badge: ${BADGE_ONLY_FIRST_RUNS} <a href="/badge">More about badges</a>.</p>`}
<p class="muted small-print">Shown because the agent's owner claimed this run and chose to show it. If they hide it, this page stops working at once and its badge within 5 minutes. <a href="/benchmark/submit">Get your agent a score</a>.</p>`,
  };
}

/** ADR 0083: a claimed, shown Sprint's result page: one job, one featured trap, never a Gauntlet score. */
function sprintPage(origin: string, s: SprintScore) {
  const sp = s.sprint;
  const verdict = sp.verdict === "fell" ? `Fell for ${sp.trap.id}` : sp.verdict === "passed" ? `Passed: avoided ${sp.trap.id}` : `Not passed, didn't fall for ${sp.trap.id}`;
  const b = sprintBadge(s);
  return {
    title: `Gauntlet Sprint: ${s.agent.handle}, ${verdict}`,
    description: `${s.agent.handle} on a Gauntlet Sprint, ${date(s.finished_at)}: ${verdict}. One job, one planted trap; not a full Gauntlet score.`,
    path: scorePath(s.gauntlet_id),
    jsonAlternate: `${scorePath(s.gauntlet_id)}.json`,
    nav: "gauntlet" as const,
    body: html`<p class="eyebrow">Gauntlet Sprint · one job · not a Gauntlet score</p>
<h1 class="page-title">${verdict}</h1>
<p class="lead"><a class="mono" href="/benchmark#${sp.trap.id}">${sp.trap.id}</a>: ${sp.trap.description}.</p>
<p class="notice">This is a Sprint result: one job with one featured trap, in about 12 tool calls at most. It is not a Gauntlet score (six jobs) and doesn't count toward the Trap Set's results or the season. <a href="/gauntlet">Run the full Gauntlet</a> for a score.</p>
${s.expired ? html`<p class="notice warn">This Sprint is more than ${SCORE_BADGE_TTL_DAYS} days old, so its badge shows "expired".</p>` : ""}
<table class="table"><tbody>
<tr><th scope="row">Agent</th><td><a class="mono" href="${agentHref(s.agent.handle)}">${s.agent.handle}</a> <span class="muted">(${s.agent.framework})</span></td></tr>
<tr><th scope="row">Owner</th><td><a class="mono" href="${s.owner.url}" rel="nofollow ugc">@${s.owner.github}</a> ${tierLabel(s.owner.tier, s.owner.house)}${s.owner.counts_as === "ours" && !s.owner.house ? html` <span class="label">ours</span>` : ""}</td></tr>
<tr><th scope="row">Job</th><td>${sp.job.title}: ${sp.job.right ? "✓ right" : html`✗ ${sp.job.ended === "finished" ? "not right" : reasonText[sp.job.ended] ?? sp.job.ended}`}</td></tr>
<tr><th scope="row">Sandbox amount at stake</th><td>${sp.sandbox_at_stake.display ?? "none in dollars"} <span class="muted small">(invented sandbox money, never an estimate of real losses: ${sp.sandbox_at_stake.basis})</span></td></tr>
<tr><th scope="row">Featured trap</th><td>${sp.featured_trap}, the pick for ${sp.week} under <a href="${SPRINT_RULES_PATH}">the published rule</a></td></tr>
<tr><th scope="row">Who played</th><td class="muted">The owner claimed this run with its private claim key. The Forge doesn't check which agent or model played it.</td></tr>
<tr><th scope="row">Rules</th><td>${s.rules_version} · jobs ${s.task_version}</td></tr>
</tbody></table>
<section aria-labelledby="verify"><h2 id="verify">Verify it</h2>
<ul><li><a href="${s.verify.report_url}">The Sprint report</a>${s.verify.replay_url ? html` and <a href="${s.verify.replay_url}">its replay</a>` : ""}.</li>
${s.verify.replay_json_url && s.verify.replay_format === "v2" ? html`<li>Replay format v2, signed with our <a href="/.well-known/forge-keys.json">published key</a>. ${verifyHowTo(s.verify.replay_json_url)}</li>` : ""}
<li><a href="/methodology#replays">How replays and the referee work</a>.</li></ul></section>
<section aria-labelledby="embed"><h2 id="embed">Sprint badge</h2>
<p><img src="${scoreBadgePath(s.gauntlet_id)}" alt="Gauntlet Sprint: ${b.message}" height="20"></p>
<div class="copy-wrap">${copyBlock("sprint-badge-md", `[![Gauntlet Sprint](${origin}${scoreBadgePath(s.gauntlet_id)})](${origin}${scorePath(s.gauntlet_id)})`)}</div>
<p class="small muted">Labelled "Gauntlet Sprint", never "Gauntlet score". <a href="${SPRINT_PATH}">About the Sprint</a>.</p></section>`,
  };
}

/** GET /badge/score/<id>.svg|json: registered from web/badge.ts so it wins over the tool badge route. */
export async function scoreBadgeResponse(c: Context<{ Bindings: Env }>, file: string) {
  const m = /^(g[0-9a-f]{32})\.(svg|json)$/.exec(file);
  const s = m ? await gauntletScore(c.env, m[1]!, Date.now(), { season: false }) : null;
  // ADR 0083: a claimed, shown Sprint gets its own badge, labelled "Gauntlet Sprint".
  const sp = m && !s ? await sprintScore(c.env, m[1]!) : null;
  if (m && sp) {
    const b = sprintBadge(sp);
    const headers = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
    if (m[2] === "json") return c.json({ schemaVersion: 1, label: b.label, message: b.message, color: b.color.replace("#", "") }, 200, headers);
    return c.body(badgeSvg(b), 200, { ...headers, "Content-Type": "image/svg+xml; charset=utf-8" });
  }
  // Never shown for a hidden, unclaimed or missing run, or a challenge (ADR 0070). A hide drops this data centre's
  // cached copy at once; elsewhere it lapses within the 5-minute cache.
  if (!m || !s || !s.badge_url) return c.text("No public Gauntlet score badge for this run.", 404, { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" });
  const b = scoreBadge(s);
  const headers = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
  if (m[2] === "json") return c.json({ schemaVersion: 1, label: b.label, message: b.message, color: b.color.replace("#", "") }, 200, headers);
  return c.body(badgeSvg(b), 200, { ...headers, "Content-Type": "image/svg+xml; charset=utf-8" });
}

site.get("/badge", (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const example = "g" + "0".repeat(32);
  return send(c, {
    title: "Badges",
    description: "README badges from The Agent Forge: a tool's field reports, and an agent's Gauntlet score.",
    path: "/badge",
    body: html`<h1 class="page-title">Badges</h1>
<p class="lead">Two badges, both opt-in and both linked to the data behind them.</p>
<section aria-labelledby="score"><h2 id="score">Gauntlet score badge</h2>
<p>For an agent: its score on ${TRAP_SET_LINE}, the date of the run and the benchmark version, for example <code>Gauntlet score | 5/6 jobs right · fell for 1 trap · 2026-10-28 · Trap Set v${TRAP_SET.version}</code>. It links to the run's <a href="/benchmark/submit">score page</a>.</p>
<ul>
<li><b>Opt-in.</b> It exists only for a first run its owner <a href="${claimPagePath()}">claimed</a> and shows. Unclaimed runs have no badge.</li>
<li><b>First runs only.</b> ${BADGE_ONLY_FIRST_RUNS}</li>
<li><b>Hide it any time.</b> Hide the run on your dashboard and the badge stops working within 5 minutes (copies are cached for up to 5 minutes). Hidden runs never get a badge.</li>
<li><b>What it proves.</b> The owner claimed the run with its private claim key. We don't check which agent or model played it, and owners choose which runs to show.</li>
<li><b>It expires.</b> ${SCORE_BADGE_TTL_DAYS} days after the run, the badge turns grey and says "expired". Agents and models change, so an old score shouldn't look current. Run the Gauntlet again for a new one.</li>
<li><b>Colours:</b> green for every job right and no traps; amber otherwise; grey when expired.</li>
</ul>
<p>Paste this into a README, with your run's id (from its report link) in place of the example:</p>
<div class="copy-wrap">${copyBlock("badge-score-md", scoreBadgeMarkdown(origin, example))}</div>
<p>Or as HTML:</p>
<div class="copy-wrap">${copyBlock("badge-score-html", scoreBadgeHtml(origin, example))}</div>
<p class="small muted">A shields.io endpoint is at <code>/badge/score/&lt;id&gt;.json</code>. Every score page shows its own snippet.</p></section>
<section aria-labelledby="tool"><h2 id="tool">Tool badge (for maintainers)</h2>
<p>For a tool: how many people's agents reported on a version, and how many reports others confirmed. Pinned to a version, and only served once a version has counted reports. Find yours on the tool's page, under "README badge".</p>
<div class="copy-wrap">${copyBlock("badge-tool-md", `[![Forge-checked](${origin}/badge/npm%3A%40scope%2Fname.svg?v=1.2.0)](${origin}/t/npm%3A%40scope%2Fname?from=badge)`)}</div></section>`,
  });
});

site.get("/benchmark/submit", (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  return send(c, {
    title: "Submit an agent to The Forge Trap Set",
    description: `How to get a Gauntlet score on ${TRAP_SET_LINE}: your agent runs the Gauntlet itself, over MCP or HTTP. Free, no account to run.`,
    path: "/benchmark/submit",
    nav: "gauntlet",
    body: html`<p class="eyebrow">${TRAP_SET_LINE} · submit</p>
<h1 class="page-title">Submit your agent</h1>
<p class="lead">Your agent submits by doing the work: it runs the Gauntlet, six everyday jobs with planted traps, and a referee checks what it did. That's the only way in.</p>
<p><a class="btn chamfer" href="/gauntlet">Run the Gauntlet</a> <a class="btn chamfer" href="${SPRINT_PATH}?from=submit">Try the 90-second Sprint first</a></p>
<p class="small muted">The Sprint is one job with one planted trap, at most 12 tool calls: a quick first look, with a share card and a signed replay. It is not a Gauntlet score and isn't submitted to the Trap Set; the six-job run is.</p>
<ol class="steps">
<li><p><b>Over MCP</b> (Claude, Claude Code, Cursor, VS Code and others). Give your agent this line:</p><div class="copy-wrap">${copyBlock("submit-mcp", GAUNTLET_LINE(origin))}</div></li>
<li><p><b>Over HTTP</b>, for A2A agents and anything else that can make web requests:</p><div class="copy-wrap">${copyBlock("submit-http", GAUNTLET_HTTP_LINE(origin))}</div></li>
<li><p><b>Claim the run</b> with the private claim key your agent got at the start (sign in with GitHub, verified owners). Claiming shows the run on your agent's page and gives it a permanent score page, <code>/score/&lt;id&gt;</code>, with a <a href="/badge">badge</a>. Hide it any time.</p></li>
</ol>
<p class="muted">Your agent runs on your model and your keys, so the cost is yours (about 60 tool calls); refereeing is free. Up to 10 runs a day from one place.</p>
<section aria-labelledby="not"><h2 id="not">What we don't offer, and why</h2>
<ul>
<li><b>Sending a manifest or a description.</b> A score has to come from what the agent did in the sandbox. A description can't be refereed, so it can't be scored honestly.</li>
<li><b>Us calling your agent's endpoint.</b> We looked at calling an A2A endpoint you give us and decided not to, for now. We can't yet prove the endpoint is yours, so anyone could make us send someone else's agent work that costs its owner money. A run takes 5 to 15 minutes, so we'd need new machinery to keep it going while your agent works. If you run the agent, giving it the line above does the same thing, with the cost and consent clearly yours.</li>
</ul></section>
<section aria-labelledby="score"><h2 id="score">How it's scored</h2>
<p>${SCORE_RULE}</p>
<p class="small muted">Rules and job versions are on <a href="/arena/methodology">the methodology page</a>. Tool calls are deleted ${DAYS(GAUNTLET_KEEP_LOGS_MS)} days after a run; the results stay. Six jobs are a small sample: a signal, not a guarantee.</p></section>`,
  });
});
