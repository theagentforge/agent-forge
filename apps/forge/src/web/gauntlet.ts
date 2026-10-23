import { attemptScore, frames, moments, type AttemptResult, type LogEvent } from "@forge/arena";
import { html } from "hono/html";
import { GAUNTLET_TIME_LIMIT_MS, gauntletRun, JOBS, reportPath, type GauntletSummary } from "../arena/gauntlet";
import { arenaResults } from "../mcp-public";
import { getDb } from "../services/db";
import { replaySections } from "./arena";
import { copyBlock } from "./components";
import { send, site } from "./pages";

// The Gauntlet pages (ADR 0024): how to start, and each run's report card. Reports are unlisted (noindex, on no
// list): the run id is the only key, and whoever has the link can see the run. Never edge-cached: a run changes.

const ID = /^g[0-9a-f]{32}$/;
export const GAUNTLET_LINE = (origin: string) => `Connect to the MCP server ${origin}/mcp/gauntlet and run the Forge Gauntlet: call gauntlet_start, then do each job with gauntlet_act.`;
export const GAUNTLET_HTTP_LINE = (origin: string) => `Read ${origin}/gauntlet.md and run the Forge Gauntlet over its HTTP API.`;

const reasonText: Record<string, string> = {
  finished: "finished",
  not_reached: "not reached",
  knockout_time: "ran out of time",
  knockout_tool_calls: "ran out of tool calls",
  knockout_turns: "ran out of turns",
};

site.get("/gauntlet", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  return send(c, {
    title: "Test your agent: the Forge Gauntlet",
    description: "Six everyday jobs with hidden traps, refereed from what your agent did. Free, no account. Then a trap card from what it fell for, and a re-run to measure it.",
    path: "/gauntlet",
    nav: "gauntlet",
    body: html`<p class="eyebrow">The Forge Gauntlet · free, no account</p>
<h1 class="page-title">Test your agent.</h1>
<p class="lead">Six everyday jobs with hidden traps: a fake invoice, a refund over policy, a lookalike expense row, a supplier who keeps timing out. A referee checks what your agent did, not what it says.</p>
<ol class="steps">
<li><p><b>Give your agent this line.</b> Works in any app that can add an MCP server (Claude, Claude Code, Cursor, VS Code and others).</p><div class="copy-wrap">${copyBlock("gauntlet-line", GAUNTLET_LINE(origin))}</div>
<p class="small muted">No MCP? <span>${GAUNTLET_HTTP_LINE(origin)}</span></p></li>
<li><p><b>It plays six jobs in a row.</b> About 60 tool calls, usually 5 to 15 minutes. It must finish within ${GAUNTLET_TIME_LIMIT_MS / 3_600_000} hours.</p></li>
<li><p><b>You get a report card</b>: jobs right, traps fallen for, and the Arena's headline models on the same jobs.</p></li>
<li><p><b>Then a trap card</b>, with checks for the traps it fell for first. One re-run on six new job versions, with the card, measures whether it helped.</p></li>
</ol>
<p class="muted">Top frontier models pass all six. If your agent doesn't, know that before it handles real money or customers. Six jobs are a small sample: a signal, not a guarantee.</p>
<p class="muted small-print">No account, no IP address stored. Tool calls are deleted after 30 days; the pass/fail summary stays. Anyone with a report link can see that report. Like the headline models, your agent never sees trap names in advance.</p>
<p><a class="text-link" href="/arena?from=gauntlet">Watch headline models on the same jobs →</a></p>`,
  });
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
  if (c.req.query("format") === "json") return c.json({ id, status: g.status, measured_rerun_of: g.cardFrom, summary: s, trap_card: g.cardFrom ? null : g.card, rerun: rerun?.id ?? null });
  if (!s)
    return send(
      c,
      {
        title: "Gauntlet run in progress",
        description: "A Forge Gauntlet run that hasn't finished yet.",
        path: reportPath(id),
        noindex: true,
        body: html`<p class="eyebrow">The Forge Gauntlet</p><h1 class="page-title">Still running</h1><p class="lead">On job ${g.current + 1} of ${JOBS.length}. Reload when your agent says it's finished.</p>`,
      },
      { cache: false },
    );
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
<section><h2>Share</h2><div class="copy-wrap">${copyBlock("share-line", share)}</div><p class="small muted">Anyone with this link can see this report and its replays.</p></section>
<p class="muted small-print">Refereed from the sandbox's end state by the same rules as <a href="/arena">the Arena</a>. "Best headline model" is that job's top pass rate in published Arena runs. Tool calls are deleted 30 days after the run; this summary stays.</p>`,
  }, { cache: false });
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
  return send(c, {
    title: `Gauntlet job ${n}: ${JOBS[n - 1]!.title}`,
    description: `${result.passed ? "Right" : "Not right"}; fell for ${result.traps.filter((x) => x.triggered).length} of ${result.traps.length} traps.`,
    path: `${reportPath(id)}/${n}`,
    noindex: true,
    body: html`<p class="eyebrow"><a href="${reportPath(id)}">Gauntlet report</a> · job ${n} of ${JOBS.length}</p>
<h1 class="page-title">${JOBS[n - 1]!.title}</h1>
${replaySections(fs, moments(log, fs), result, attemptScore(result))}`,
  }, { cache: false });
});
