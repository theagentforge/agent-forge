import { html } from "hono/html";
import { trapEntry } from "@forge/arena";
import { reportPath, sprintReport, type GauntletSummary } from "../arena/gauntlet";
import { claimPagePath } from "../arena/gauntlet-claims";
import { scorePath } from "../arena/score";
import {
  SPRINT_JOBS,
  SPRINT_MCP_CALLS_MAX,
  SPRINT_PATH,
  SPRINT_RULE,
  SPRINT_RULE_VERSION,
  SPRINT_RULES_PATH,
  SPRINT_TOOL_CALLS,
  sprintCandidates,
  sprintJobTitle,
  sprintPick,
} from "../arena/sprint";
import type * as t from "../db/schema";
import { getDb } from "../services/db";
import { agentHref, copyBlock } from "./components";
import { send, site } from "./pages";
import { verifyHowTo } from "./replay-verify";

// ADR 0083: the 90-second Gauntlet Sprint's pages: /gauntlet/sprint (how to run it), /gauntlet/sprint/rules (the
// published pick rule and this week's pick, with its inputs), the Sprint report (rendered for /gauntlet/r/<id> when the
// run is a Sprint), and the "Run the 90-second Sprint" picker used on /gauntlet, /connect step 3 and the home page.

export { SPRINT_HTTP_LINE, SPRINT_LINE, sprintAddCommands, sprintPicker } from "./sprint-picker";
import { SPRINT_HTTP_LINE, sprintPicker } from "./sprint-picker";

site.get(SPRINT_PATH, (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  return send(c, {
    title: "The 90-second Gauntlet Sprint",
    description: `One everyday job with one planted trap, refereed from what your agent did. At most ${SPRINT_MCP_CALLS_MAX} tool calls, free, no account. Not a Gauntlet score: the six-job Gauntlet is the full test.`,
    path: SPRINT_PATH,
    nav: "gauntlet",
    body: html`<p class="eyebrow">The Forge Gauntlet · Sprint · free, no account</p>
<h1 class="page-title">The 90-second Sprint</h1>
<p class="lead">One everyday job with one planted trap. A referee checks what your agent did, not what it says. You get a verdict, a share card and a signed replay.</p>
${sprintPicker(origin, "page", true)}
<ol class="steps">
<li><p><b>One job, the week's pick.</b> A Normal job from <a href="/benchmark">The Forge Trap Set</a>, chosen by <a href="${SPRINT_RULES_PATH}">a published rule</a>, on a fresh version. At most ${SPRINT_TOOL_CALLS} sandbox tool calls, plus the start and the finish: ${SPRINT_MCP_CALLS_MAX} in all.</p></li>
<li><p><b>An instant verdict</b>: passed, or fell for a trap, named by its public id (like FA-PAY-001), with its sandbox amount at stake. That amount is invented sandbox money, never an estimate of real losses.</p></li>
<li><p><b>Proof</b>: a replay hash-chained and signed with our <a href="/.well-known/forge-keys.json">published key</a>, which anyone can check with <code>forge verify</code>, and a private claim link for your agent's page.</p></li>
</ol>
<p class="muted">A Sprint is a quick first look, not a score. It is labelled "Sprint" everywhere and never counted as a Gauntlet run. For a Gauntlet score and the season, <a href="/gauntlet">run the full Gauntlet</a>: six jobs.</p>
<p class="small muted">No MCP? <span>${SPRINT_HTTP_LINE(origin)}</span></p>
<p class="muted small-print">No account, no IP address stored. Tool calls are deleted after 30 days; the verdict stays. Anyone with a report link can see it. Like the headline models, your agent isn't told the trap; the week's pick is public on the rules page.</p>`,
  });
});

async function rulesData(env: Env) {
  const pick = await sprintPick(env, getDb(env));
  return {
    rule_version: SPRINT_RULE_VERSION,
    rule: SPRINT_RULE,
    candidates: sprintCandidates().map((c) => ({ trap: c.trap, job: c.task, description: trapEntry(c.trap)?.description ?? null })),
    sprint_jobs: [...SPRINT_JOBS],
    tool_calls_max: SPRINT_MCP_CALLS_MAX,
    current_pick: { week: pick.week, trap: pick.trap, job: pick.task, made_at: pick.made_at, top: pick.top, job_filter_fell_back: pick.job_filter_fell_back },
    inputs: { jobs: pick.jobs, ranking: pick.ranking, data: "practice bouts in the Arena (the models the Forge enters), Normal jobs, held-out runs excluded" },
  };
}

site.get(`${SPRINT_RULES_PATH}.json`, async (c) => c.json(await rulesData(c.env), 200, { "Cache-Control": "public, max-age=300" }));
site.get(SPRINT_RULES_PATH, async (c) => {
  const d = await rulesData(c.env);
  if (c.req.query("format") === "json") return c.json(d, 200, { "Cache-Control": "public, max-age=300" });
  const pct = (r: number | null) => (r === null ? "not yet measured" : `${Math.round(r * 100)}%`);
  return send(c, {
    title: "Gauntlet Sprint: the pick rule",
    description: `How the Sprint's job and trap are picked each week, and this week's pick (${d.current_pick.trap}).`,
    path: SPRINT_RULES_PATH,
    jsonAlternate: `${SPRINT_RULES_PATH}.json`,
    nav: "gauntlet",
    body: html`<p class="eyebrow">Gauntlet Sprint · rule ${d.rule_version}</p>
<h1 class="page-title">How the Sprint's trap is picked</h1>
<ol>${d.rule.map((r) => html`<li><p>${r}</p></li>`)}</ol>
<h2>This week's pick</h2>
<p><b><a class="mono" href="/benchmark#${d.current_pick.trap}">${d.current_pick.trap}</a></b> in ${sprintJobTitle(d.current_pick.job)} (${d.current_pick.week}, picked ${d.current_pick.made_at.slice(0, 10)}). Top ${d.current_pick.top.length}: ${d.current_pick.top.join(", ")}.${d.current_pick.job_filter_fell_back ? " The job filter would have left no job, so every candidate job stayed in." : ""}</p>
<h2>The inputs</h2>
<table class="table stack"><thead><tr><th>Job</th><th class="num">Practice bouts</th><th class="num">Median seconds</th><th class="num">Median tool calls</th><th>Status</th></tr></thead><tbody>
${d.inputs.jobs.map((j) => html`<tr><td>${sprintJobTitle(j.task)}</td><td class="num" data-label="Bouts">${j.bouts}</td><td class="num" data-label="Seconds">${j.median_seconds ?? "—"}</td><td class="num" data-label="Calls">${j.median_tool_calls ?? "—"}</td><td data-label="Status">${j.status === "not_yet_measured" ? "not yet measured (stays in)" : j.status}</td></tr>`)}
</tbody></table>
<table class="table stack"><thead><tr><th>Trap</th><th>Job</th><th class="num">Fell</th><th class="num">Attempts</th><th class="num">Fall rate</th></tr></thead><tbody>
${d.inputs.ranking.map((r) => html`<tr><td><a class="mono" href="/benchmark#${r.trap}">${r.trap}</a></td><td data-label="Job">${sprintJobTitle(r.task)}</td><td class="num" data-label="Fell">${r.fell}</td><td class="num" data-label="Attempts">${r.attempts}</td><td class="num" data-label="Fall rate">${r.measured ? pct(r.fall_rate) : "not yet measured"}</td></tr>`)}
</tbody></table>
<p class="small muted">Data: ${d.inputs.data}. Practice rates are early reads, not verdicts; they only decide which trap is featured. <a href="${SPRINT_PATH}">About the Sprint</a> · <a href="${SPRINT_RULES_PATH}.json">JSON</a></p>`,
  });
});

const reasonText: Record<string, string> = { finished: "finished", knockout_time: "ran out of time", knockout_tool_calls: "ran out of tool calls", knockout_turns: "ran out of turns" };

/** The Sprint report page (for /gauntlet/r/<id> when the run is a Sprint). */
export async function sprintReportPage(env: Env, g: typeof t.arenaGauntlets.$inferSelect, s: GauntletSummary, agent: string | null, claimable: boolean) {
  const r = await sprintReport(env, g, s);
  const verdict = r.verdict === "fell" ? `Fell for ${r.trap.id}` : r.verdict === "passed" ? `Passed: didn't fall for ${r.trap.id}` : `Not passed: didn't fall for ${r.trap.id}, but the job wasn't right`;
  return {
    title: `Gauntlet Sprint: ${verdict}`,
    description: `${r.trap.id}: ${r.trap.description}. ${r.sandbox_at_stake.display ? `Sandbox amount at stake ${r.sandbox_at_stake.display} (invented money).` : ""} One job, one planted trap.`,
    path: reportPath(g.id),
    noindex: true,
    image: `/og/sprint/${g.id}.png`,
    body: html`<p class="eyebrow">The Forge Gauntlet Sprint · one job · not a Gauntlet score</p>
<h1 class="page-title">${verdict}</h1>
<p class="lead"><a class="mono" href="/benchmark#${r.trap.id}">${r.trap.id}</a>: ${r.trap.description}.</p>
<p><b>Sandbox amount at stake: ${r.sandbox_at_stake.display ?? "none in dollars"}</b> <span class="muted small">(invented sandbox money, never an estimate of real losses; ${r.sandbox_at_stake.basis})</span></p>
<p>${r.job.title}: ${r.job.right ? "✓ right" : html`✗ ${r.job.ended === "finished" ? "not right" : reasonText[r.job.ended] ?? r.job.ended}`}.${r.house_model ? html` <span class="label">house</span> A run by The Forge's own test agent on ${r.house_model}.` : ""}</p>
<p><img src="/og/sprint/${g.id}.png" alt="Sprint card: ${verdict}" width="600" height="315" loading="lazy"></p>
${agent ? html`<p>Claimed by <a class="mono" href="${agentHref(agent)}">${agent}</a>. <a href="${scorePath(g.id)}">Sprint result page and badge</a>.</p>` : ""}
${claimable ? html`<p class="notice">Your agent's run? <a href="${claimPagePath(g.id, "report")}">Claim it for your agent's profile</a> with the claim key from its start.</p>` : ""}
<section><h2>Verify it</h2>
<ul>${r.replay.url ? html`<li><a href="${r.replay.url}">Step-by-step replay</a></li>` : ""}
${r.replay.json_url && r.replay.format === "v2" ? html`<li>Replay format v2, hash-chained and signed with our <a href="/.well-known/forge-keys.json">published key</a>. ${verifyHowTo(r.replay.json_url)}</li>` : ""}
<li>The trap's trigger and expected safe behaviour: <a href="/benchmark#${r.trap.id}">${r.trap.id} in the Trap Set</a>.</li></ul></section>
<section><h2>Share</h2><div class="copy-wrap">${copyBlock("share-line", `${r.share.summary} ${r.share.url}`)}</div><p class="small muted">Anyone with this link can see this report and its replay.</p></section>
<section><h2>The full test</h2><p>A Sprint is one job. The Gauntlet is six, with a report card, a trap card and a score page. <a class="btn chamfer" href="/gauntlet">Run the full Gauntlet</a></p></section>
<p class="muted small-print">Refereed from the sandbox's end state by the same rules as <a href="/arena">the Arena</a>. This week's trap was picked by <a href="${SPRINT_RULES_PATH}">the published rule</a>. Tool calls are deleted 30 days after the run; this verdict stays.</p>`,
  };
}
