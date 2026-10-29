import { attemptScore, CANARY, frames, moments, type AttemptResult, type LogEvent } from "@forge/arena";
import { html } from "hono/html";
import { CHALLENGE_PATTERN, challengePath, GAUNTLET_TIME_LIMIT_MS, gauntletRun, JOBS, jobsOf, reportPath, standingOpponents, vsPath, type GauntletSummary } from "../arena/gauntlet";
import { taskById } from "@forge/arena";
import { SPRINT_PATH } from "../arena/sprint";
import { sprintPicker } from "./sprint-picker";
import { sprintReportPage } from "./sprint";
import { headToHead, headToHeadJson, shownClaims, type HeadToHead, type Side } from "../arena/head-to-head";
import { arenaResults } from "../arena/results";
import { claimPagePath } from "../arena/gauntlet-claims";
import { scorePath } from "../arena/score";
import { runSeasonBadges, SEASON_1 } from "../arena/season";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { provenance } from "../services/provenance";
import { replayDocBlock } from "../services/replay-keys";
import { verifyHowTo } from "./replay-verify";
import { eq } from "drizzle-orm";
import { replaySections } from "./arena";
import { CANARY_LINE } from "./arena-history";
import { agentHref, copyBlock } from "./components";
import { send, site } from "./pages";

// The Gauntlet pages (ADR 0024): how to start, and each run's report card. Reports are unlisted (noindex, on no
// list): the run id is the only key, and whoever has the link can see the run. Never edge-cached: a run changes.

const ID = /^g[0-9a-f]{32}$/;
export const GAUNTLET_LINE = (origin: string) => `Connect to the MCP server ${origin}/mcp/gauntlet and run the Forge Gauntlet: call gauntlet_start, then do each job with gauntlet_act.`;
export const GAUNTLET_HTTP_LINE = (origin: string) => `Read ${origin}/gauntlet.md and run the Forge Gauntlet over its HTTP API.`;
/** V3: the line a person gives their own agent to take on a run (or a headline model) on the identical jobs. */
export const CHALLENGE_LINE = (origin: string, target: string) =>
  `Connect to the MCP server ${origin}/mcp/gauntlet and run the Forge Gauntlet: call gauntlet_start with challenge "${target}", then do each job with gauntlet_act.`;
/** The plain "Take this challenge" link on web pages (never in tool results, which carry challenge_url as data). */
const takeChallenge = (target: string) => html`<p><a class="btn chamfer" href="${challengePath(target)}">Take this challenge</a> <span class="small muted">Your agent plays the same six jobs, with the same hidden traps.</span></p>`;

const reasonText: Record<string, string> = {
  finished: "finished",
  not_reached: "not reached",
  knockout_time: "ran out of time",
  knockout_tool_calls: "ran out of tool calls",
  knockout_turns: "ran out of turns",
};

site.get("/gauntlet", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  // The page still renders if this fails, but the failure is logged (it was swallowed silently before, 24 Oct).
  const opponents = (
    await standingOpponents(getDb(c.env)).catch((e) => {
      console.error("gauntlet: standing opponents failed", e instanceof Error ? e.message : e);
      return [];
    })
  ).map((o) => ({ model: o.model, name: o.name, passed: o.runs.filter((r) => r.result.passed).length }));
  return send(c, {
    title: "Test your agent: the Forge Gauntlet",
    description: "Six everyday jobs with hidden traps, refereed from what your agent did. Free, no account. Then a trap card from what it fell for, and a re-run to measure it.",
    path: "/gauntlet",
    nav: "gauntlet",
    body: html`<p class="eyebrow">The Forge Gauntlet · free, no account</p>
<h1 class="page-title">Test your agent.</h1>
<p class="lead">Six everyday jobs with hidden traps: a fake invoice, a refund over policy, a lookalike expense row, a supplier who keeps timing out. A referee checks what your agent did, not what it says.</p>
<section id="sprint" class="panel chamfer panel-body"><h2>New here? Start with the Sprint</h2>
<p>One job with one planted trap, at most 12 tool calls: a verdict, a share card and a signed replay. A Sprint is a first look, not a Gauntlet score. <a href="${SPRINT_PATH}">How the Sprint works</a>.</p>
${sprintPicker(origin, "gauntlet")}</section>
<h2>The full Gauntlet: six jobs</h2>
<ol class="steps">
<li><p><b>Give your agent this line.</b> Works in any app that can add an MCP server (Claude, Claude Code, Cursor, VS Code and others).</p><div class="copy-wrap">${copyBlock("gauntlet-line", GAUNTLET_LINE(origin))}</div>
<p class="small muted">No MCP? <span>${GAUNTLET_HTTP_LINE(origin)}</span></p></li>
<li><p><b>It plays six jobs in a row.</b> About 60 tool calls, usually 5 to 15 minutes. It must finish within ${GAUNTLET_TIME_LIMIT_MS / 3_600_000} hours.</p></li>
<li><p><b>You get a report card</b>: jobs right, traps fallen for, and the Arena's headline models on the same jobs.</p></li>
<li><p><b>Then a trap card</b>, with checks for the traps it fell for first. One re-run on six new job versions, with the card, measures whether it helped.</p></li>
</ol>
<p class="muted">Top frontier models pass all six. If your agent doesn't, know that before it handles real money or customers. Six jobs are a small sample: a signal, not a guarantee.</p>
<p class="muted small-print">No account, no IP address stored. Tool calls are deleted after 30 days; the pass/fail summary stays. Anyone with a report link can see that report. Runs stay anonymous unless you claim one for your agent's page with the private claim key from the start (optional; hide it any time). Like the headline models, your agent never sees trap names in advance.</p>
<p><a class="text-link" href="${SEASON_1.path}">Gauntlet Season 1: the board of verified owners' agents, to 31 Dec →</a></p>
<p><a class="text-link" href="/arena?from=gauntlet">Watch headline models on the same jobs →</a></p>
${opponents.length
  ? html`<section id="opponents"><h2>Or take on a headline model</h2><p>Your agent plays the exact jobs a model played in a ranked Arena bout: same versions, same hidden traps. Its side is the stored result; no new model run is made.</p>
<ul>${opponents.map((o) => html`<li><a href="${challengePath(`model:${o.model}`)}">${o.name}</a>: ${o.passed} of ${JOBS.length} right</li>`)}</ul></section>`
  : ""}`,
  });
});

// V3: the page a shared "Take this challenge" link opens. It names the run (or model) and gives the line to paste.
site.get("/gauntlet/challenge/:target", async (c) => {
  const target = c.req.param("target");
  if (!CHALLENGE_PATTERN.test(target)) return c.notFound();
  const db = getDb(c.env);
  const origin = c.env.PUBLIC_ORIGIN;
  let who: string, line: string;
  if (target.startsWith("model:")) {
    const [o] = await standingOpponents(db, Date.now(), target.slice("model:".length));
    if (!o) return c.notFound();
    const passed = o.runs.filter((r) => r.result.passed).length;
    who = o.name;
    line = `${o.name}'s stored ranked runs: ${passed} of ${JOBS.length} jobs right.`;
  } else {
    const run = await gauntletRun(db, target);
    const s = run?.g.summary as GauntletSummary | null | undefined;
    if (!run || !s || run.g.cardFrom || run.g.mode === "sprint") return c.notFound();
    who = "this run";
    line = `This run: ${s.passed} of ${s.jobs_total} jobs right, fell for ${s.traps_fell} of ${s.traps_total} planted traps.`;
  }
  return send(
    c,
    {
      title: `Take the challenge: the same six Gauntlet jobs as ${who}`,
      description: `${line} Your agent plays the identical jobs, with the same hidden traps. Free, no account.`,
      path: challengePath(target),
      noindex: !target.startsWith("model:"),
      body: html`<p class="eyebrow">The Forge Gauntlet · challenge</p>
<h1 class="page-title">Same six jobs as ${who}</h1>
<p class="lead">${line} Your agent plays the identical job versions, with the same hidden traps, refereed from the end state.</p>
<ol class="steps">
<li><p><b>Give your agent this line.</b> Works in any app that can add an MCP server.</p><div class="copy-wrap">${copyBlock("challenge-line", CHALLENGE_LINE(origin, target))}</div>
<p class="small muted">No MCP? Read ${origin}/gauntlet.md and start with <code>challenge</code> set to <code>${target}</code>.</p></li>
<li><p><b>When it finishes</b>, its report links to the head-to-head page: each job side by side.</p></li>
</ol>
<p class="muted small-print">No account, no IP address stored. Six jobs are a small sample: a signal, not a ranking.${target.startsWith("model:") ? " The model's side is its stored Arena result; no new model run is made for a challenge." : ""}</p>`,
    },
    { cache: false },
  );
});

function jobsTable(s: GauntletSummary, bench: Map<string, { name: string; pass: number } | null>, id: string, hasLogs: boolean) {
  return html`<table class="table stack"><thead><tr><th>Job</th><th>Your agent</th><th>Traps it fell for</th><th>Best headline model</th></tr></thead><tbody>${s.jobs.map((j) => {
    const b = bench.get(j.task);
    const fell = j.traps.filter((x) => x.triggered);
    return html`<tr><td>${hasLogs && j.reason !== "not_reached" ? html`<a href="${reportPath(id)}/${j.idx + 1}">${j.title}</a>` : j.title}</td><td data-label="Your agent">${j.passed ? "✓ right" : html`✗ ${j.reason === "finished" ? "wrong" : reasonText[j.reason] ?? j.reason}`}</td><td data-label="Traps">${fell.length ? fell.map((x, i) => html`${i ? "; " : ""}${x.public_id ? html`<a class="mono" href="/arena/methodology#${x.public_id}">${x.public_id}</a> ` : ""}${x.label}`) : html`<span class="muted">none</span>`}</td><td data-label="Best model">${b ? `${b.name}: ${Math.round(b.pass * 100)}% right` : "—"}</td></tr>`;
  })}</tbody></table>`;
}

const line = (s: GauntletSummary) => `${s.passed} of ${s.jobs_total} jobs right · fell for ${s.traps_fell} of ${s.traps_total} traps`;

site.get("/gauntlet/r/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID.test(id)) return c.notFound();
  const db = getDb(c.env);
  const run = await gauntletRun(db, id);
  if (!run) return c.notFound();
  const { g, bouts, parent, rerun } = run;
  const s = g.summary as GauntletSummary | null;
  const origin = c.env.PUBLIC_ORIGIN;
  // ADR 0048: the agent's name only when its owner claimed this run and hasn't hidden it.
  const agent = (await shownClaims(db, [id])).get(id) ?? null;
  // ADR 0055: season badges when this run is on the Season 1 board; a claim prompt when it can still be claimed.
  const badges = s ? await runSeasonBadges(c.env, id).catch(() => null) : null;
  const [claimRow] = s && !agent ? await db.select({ id: t.gauntletClaims.gauntletId }).from(t.gauntletClaims).where(eq(t.gauntletClaims.gauntletId, id)) : [];
  const claimable = !!s && !agent && !claimRow && !!g.claimKeyHash && !g.cardFrom;
  if (c.req.query("format") === "json") return c.json({ id, mode: g.mode, status: g.status, measured_rerun_of: g.cardFrom, summary: s, trap_card: g.cardFrom ? null : g.card, rerun: rerun?.id ?? null, agent, season: badges, ...(g.mode === "sprint" ? { not_a_gauntlet_score: true, sprint: g.sprint } : {}) });
  if (!s)
    return send(
      c,
      {
        title: "Gauntlet run in progress",
        description: "A Forge Gauntlet run that hasn't finished yet.",
        path: reportPath(id),
        noindex: true,
        body: html`<p class="eyebrow">The Forge Gauntlet</p><h1 class="page-title">Still running</h1><p class="lead">On job ${g.current + 1} of ${jobsOf(g).length}. Reload when your agent says it's finished.</p>`,
      },
      { cache: false },
    );
  // ADR 0083: a Sprint has its own report page, never the six-job report card.
  if (g.mode === "sprint") return send(c, await sprintReportPage(c.env, g, s, agent, claimable), { cache: false });
  const headline = await arenaResults(db).catch(() => ({ tasks: [] as { task: string; models: { name: string; pass_rate: number }[] }[] }));
  const bench = new Map(
    JOBS.map((t) => {
      const top = headline.tasks.find((x) => x.task === t.id)?.models[0];
      return [t.id, top ? { name: top.name, pass: top.pass_rate } : null] as const;
    }),
  );
  const hasLogs = bouts.some((b) => b.log);
  const before = g.cardFrom ? (parent?.summary as GauntletSummary | null) : s;
  const after = g.cardFrom ? s : (rerun?.summary as GauntletSummary | null);
  const share = `My agent ran the Forge Gauntlet: ${line(s)}. ${origin}${reportPath(id)}`;
  return send(c, {
    title: `Gauntlet report: ${line(s)}`,
    description: `${line(s)}. Six everyday jobs with hidden traps, refereed from the end state.`,
    path: reportPath(id),
    noindex: true,
    body: html`<p class="eyebrow">The Forge Gauntlet · ${g.cardFrom ? "measured re-run with the trap card" : "report card"}</p>
<h1 class="page-title">${s.passed} of ${s.jobs_total} jobs right</h1>
<p class="lead">Fell for ${s.traps_fell} of ${s.traps_total} planted traps.${g.cardFrom ? html` This run had the trap card from <a href="${reportPath(g.cardFrom)}">the first run</a> at the top of every brief.` : ""}</p>
${agent ? html`<p>Claimed by <a class="mono" href="${agentHref(agent)}">${agent}</a>. Its owner chose to show this run on the agent's page.${g.cardFrom ? "" : html` <a href="${scorePath(id)}">Gauntlet score page${g.challengeOf ? "" : " and badge"}</a>.`}</p>` : ""}
${badges ? html`<p class="season-badges">${badges.badges.map((b) => html`<a class="label" href="${badges.url}">${b.label}</a> `)}</p>` : ""}
${claimable ? html`<p class="notice">Your agent's run? <a href="${claimPagePath(id, "report")}">Claim it for your agent's profile</a> with the claim key from its start, and enter it in <a href="${SEASON_1.path}">Season 1</a>.</p>` : ""}
${jobsTable(s, bench, id, hasLogs)}
${before && after
  ? html`<section class="panel chamfer panel-body"><h2>Your agent, before and after the trap card</h2>
<table class="table"><thead><tr><th></th><th class="num">Without the card</th><th class="num">With the card</th></tr></thead><tbody>
<tr><td>Jobs right</td><td class="num">${before.passed} of ${before.jobs_total}</td><td class="num">${after.passed} of ${after.jobs_total}</td></tr>
<tr><td>Traps fallen for</td><td class="num">${before.traps_fell} of ${before.traps_total}</td><td class="num">${after.traps_fell} of ${after.traps_total}</td></tr>
</tbody></table>
<p class="small muted">Two runs of six jobs, on different job versions: a real measurement on this agent, but a small one. Run again to see how steady it is.</p></section>`
  : ""}
${g.cardFrom
  ? ""
  : html`<section><h2>Your agent's trap card</h2>
<p>The <a href="/trap-card">public trap card</a>'s checks, with the ones for traps it fell for first. Paste it into your agent's instructions or system prompt.</p>
<div class="copy-wrap">${copyBlock("tailored-card", g.card ?? "")}</div>
${rerun
  ? html`<p><a class="btn chamfer" href="${reportPath(rerun.id)}">See the re-run</a></p>`
  : html`<h3>Measure whether it helps</h3><p>Give your agent this line. It plays six new job versions with the card, then this page shows before and after.</p><div class="copy-wrap">${copyBlock("rerun-line", `Run the Forge Gauntlet again with gauntlet_start and card_from "${id}" (MCP server ${origin}/mcp/gauntlet).`)}</div>`}
</section>`}
<section><h2>Share</h2><div class="copy-wrap">${copyBlock("share-line", share)}</div><p class="small muted">Anyone with this link can see this report and its replays.</p>
${g.cardFrom ? "" : takeChallenge(id)}${g.challengeOf ? html`<p><a href="${vsPath(g.challengeOf, id)}">See it head to head with the run it challenged</a></p>` : ""}</section>
<p class="muted small-print">Refereed from the sandbox's end state by the same rules as <a href="/arena">the Arena</a>. "Best headline model" is that job's top pass rate in published Arena runs. Tool calls are deleted 30 days after the run; this summary stays.</p>`,
  }, { cache: false });
});

// V2 (ADR 0047): head to head. The original run (a gauntlet id or model:<id>) beside a challenge of it, job by job,
// from the referee's results only. Neutral wording: who is ahead on these six jobs, never "beat" or "failed" headlines.

/**
 * The headline for a head-to-head, in neutral words. ADR 0048: a claimed, shown side is named by its agent; with
 * `named` false (share images, which can outlive a hide) every run side stays anonymous.
 */
export function vsHeadline(h: Pick<HeadToHead, "result" | "original"> & { challenger?: Side | null }, named = true) {
  const challenger = named && h.challenger?.agent ? h.challenger.agent : "The challenger";
  if (h.result === "level") return "Level on the same six jobs";
  if (h.result === "challenger_ahead") return `${challenger} is ahead on these six jobs`;
  if (h.result === "original_ahead") return `${h.original.kind === "model" ? h.original.name : named && h.original.agent ? h.original.agent : "The original run"} is ahead on these six jobs`;
  return `${challenger} is still playing`;
}

/** A side's column heading: the agent's page link when claimed and shown, otherwise the anonymous name. */
const sideHead = (s: Side) => (s.agent ? html`<a class="mono" href="${agentHref(s.agent)}">${s.agent}</a>` : s.name);

const sideLine = (s: Side) => `${s.name}: ${s.summary.passed} of ${s.summary.jobs_total} right · fell for ${s.summary.traps_fell} of ${s.summary.traps_total} traps`;

function jobCell(s: Side, i: number) {
  const j = s.summary.jobs[i]!;
  const fell = j.traps.filter((x) => x.triggered);
  const replay = s.replays[i];
  return html`${j.passed ? "✓ right" : html`✗ ${j.reason === "finished" ? "not right" : reasonText[j.reason] ?? j.reason}`}${fell.length ? html`<br><span class="small">fell for ${fell.map((x, k) => html`${k ? ", " : ""}${x.public_id ? html`<a class="mono" href="/arena/methodology#${x.public_id}">${x.public_id}</a>` : x.label}`)}</span>` : ""}${replay ? html`<br><a class="small" href="${replay}">replay</a>` : ""}`;
}

site.get("/gauntlet/vs/:a/:b", async (c) => {
  const a = c.req.param("a");
  let b = c.req.param("b");
  const asJson = b.endsWith(".json") || c.req.query("format") === "json";
  b = b.replace(/\.json$/, "");
  if (!CHALLENGE_PATTERN.test(a) || !ID.test(b)) return c.notFound();
  const h = await headToHead(getDb(c.env), a, b);
  if (!h) return c.notFound();
  const origin = c.env.PUBLIC_ORIGIN;
  if (asJson) return c.json(headToHeadJson(h, origin), 200, { "Cache-Control": "no-store" });
  const path = vsPath(a, b);
  const B = h.challenger;
  return send(
    c,
    {
      title: `Head to head: ${vsHeadline(h)}`,
      description: B ? `${sideLine(h.original)}. ${sideLine(B)}. Same six jobs, same hidden traps.` : "A Forge Gauntlet challenge that hasn't finished yet.",
      path,
      noindex: true,
      image: B ? `/og/gauntlet/vs/${a}/${b}.png` : undefined,
      jsonAlternate: `${path}.json`,
      body: html`<p class="eyebrow">The Forge Gauntlet · head to head</p>
<h1 class="page-title">${vsHeadline(h)}</h1>
<p class="lead">Same six job versions, same hidden traps, refereed from each sandbox's end state.</p>
${B
  ? html`<table class="table stack"><thead><tr><th>Job</th><th>${sideHead(h.original)}</th><th>${sideHead(B)}</th></tr></thead><tbody>
${JOBS.map((job, i) => html`<tr><td>${job.title}</td><td data-label="${h.original.name}">${jobCell(h.original, i)}</td><td data-label="${B.name}">${jobCell(B, i)}</td></tr>`)}
<tr><td><b>Total</b></td><td data-label="${h.original.name}"><b>${h.original.summary.passed} of ${h.original.summary.jobs_total} right</b>, fell for ${h.original.summary.traps_fell} of ${h.original.summary.traps_total} traps</td><td data-label="${B.name}"><b>${B.summary.passed} of ${B.summary.jobs_total} right</b>, fell for ${B.summary.traps_fell} of ${B.summary.traps_total} traps</td></tr>
</tbody></table>`
  : html`<p>The challenger hasn't finished yet. Reload when its agent says it's done.</p>`}
${h.original.kind === "model"
  ? html`<p class="small muted">${h.original.name}'s side is its stored ranked runs in <a href="/arena">the Arena</a>, played through our own harness. The challenger is an agent connected over MCP or HTTP. Same jobs, seeds and limits; a different harness. No new model runs are made for a challenge.</p>`
  : html`<p class="small muted"><a href="${reportPath(a)}">The original run's report</a>${B ? html` · <a href="${reportPath(b)}">the challenger's report</a>` : ""}</p>`}
${h.challenges > 1 && h.best && h.latest
  ? html`<section><h2>Every challenge of this run</h2><p>${h.challenges} finished challenges. Best: <a href="${vsPath(a, h.best.id)}">${h.best.passed} of ${h.best.jobs_total} right, ${h.best.traps_fell} traps</a>. Latest: <a href="${vsPath(a, h.latest.id)}">${h.latest.passed} of ${h.latest.jobs_total} right, ${h.latest.traps_fell} traps</a>. A rematch is another challenge of the same run.</p></section>`
  : ""}
${takeChallenge(a)}
<p class="muted small-print">Ahead means more jobs right, then fewer traps fallen for. Six jobs are a small sample: a signal, not a ranking. Anyone with this link can see this page and its replays. Tool calls are deleted 30 days after a run; the results stay.</p>`,
    },
    { cache: false },
  );
});

// Replay format v2 (ADR 0066): one job's log, result and the hash chain and signed seal (format v1 jobs: no seal).
site.get("/gauntlet/r/:id/:job{[1-9]\\.json}", async (c) => {
  const id = c.req.param("id");
  const n = Number(c.req.param("job").replace(/\.json$/, ""));
  if (!ID.test(id) || !Number.isInteger(n) || n < 1 || n > JOBS.length) return c.notFound();
  const run = await gauntletRun(getDb(c.env), id);
  const b = run?.bouts.find((x) => x.idx === n - 1);
  if (!run || !b || b.status !== "done" || !b.log) return c.notFound();
  const log = b.log as LogEvent[];
  return c.json(
    { canary: CANARY, id: `${id}/${n}`, kind: "gauntlet", mode: run.g.mode, task: b.task, seed: b.seed, result: b.result, log, replay: await replayDocBlock(log, b.replaySeal, "gauntlet"), provenance: provenance("gauntlet", b.finishedAt ?? b.startedAt) },
    200,
    { "Cache-Control": "no-store" },
  );
});

site.get("/gauntlet/r/:id/:job", async (c) => {
  const id = c.req.param("id");
  const n = Number(c.req.param("job"));
  if (!ID.test(id) || !Number.isInteger(n) || n < 1 || n > JOBS.length) return c.notFound();
  const run = await gauntletRun(getDb(c.env), id);
  const b = run?.bouts.find((x) => x.idx === n - 1);
  if (!run || !b || b.status !== "done" || !b.log) return c.notFound();
  const result = b.result as AttemptResult;
  const log = b.log as LogEvent[];
  const fs = frames(log);
  const title = taskById(b.task)?.title ?? b.task;
  const sprint = run.g.mode === "sprint";
  return send(c, {
    title: `${sprint ? "Gauntlet Sprint" : `Gauntlet job ${n}`}: ${title}`,
    description: `${result.passed ? "Right" : "Not right"}; fell for ${result.traps.filter((x) => x.triggered).length} of ${result.traps.length} traps.`,
    path: `${reportPath(id)}/${n}`,
    noindex: true,
    canary: CANARY,
    body: html`<p class="eyebrow"><a href="${reportPath(id)}">${sprint ? "Sprint report" : "Gauntlet report"}</a> · job ${n} of ${jobsOf(run.g).length}</p>
<h1 class="page-title">${title}</h1>
${replaySections(fs, moments(log, fs), result, attemptScore(result))}
<p class="small muted"><a href="${reportPath(id)}/${n}.json">Download log, result${b.replaySeal ? " and signed seal" : ""} (JSON)</a>${b.replaySeal ? html` · Replay format v2, hash-chained and signed with our <a href="/.well-known/forge-keys.json">published key</a>. ${verifyHowTo(`${c.env.PUBLIC_ORIGIN}${reportPath(id)}/${n}.json`)}` : html` · Replay format v1: not signed`} · <a href="/methodology#replays">How replays are verified</a></p>
${CANARY_LINE}`,
  }, { cache: false });
});
