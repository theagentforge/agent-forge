import { html } from "hono/html";
import { entryToolId, history, latestRun, newlyBroken, OUTCOMES, pct, runForDay, sweepHistory, toCsv, weekOfTests, type HouseEntry, type HouseOutcome } from "../services/house-report";
import { cachedToolScans } from "../services/house-tools";
import { disclosure, more, statStrip, toolHref } from "./components";
import { send, site } from "./pages";

// The Forge House Report (ADR 0011 b): the nightly handshake test of the most-downloaded no-setup MCP servers,
// as a page plus the full dataset (JSON and CSV).

export const HOUSE_REPORT_PATH = "/reports/house";

export const OUTCOME_TEXT: Record<HouseOutcome, string> = {
  worked: "started and listed its tools",
  partial: "started, but listing tools failed",
  failed: "npm could not install it",
  needs_config: "asked for a key or setting",
  no_answer: "never answered the handshake",
  not_on_npm: "published version not on npm",
  not_on_pypi: "published version not on PyPI",
  no_command: "has no command named after the package",
  error: "test error (not counted against it)",
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const n = (v: number) => v.toLocaleString("en-US");

/** Rows shown before "Show all" (site audit 29 Oct §3.16). */
export const TOP_ROWS = 25;

function serverTable(entries: HouseEntry[]) {
  return html`<div class="scroll-x spaced"><table class="table">
<thead><tr><th>#</th><th>Package</th><th>Result</th><th>Tools</th><th>Time</th><th>Downloads / week</th></tr></thead>
<tbody>${entries.map(
    (e) => html`<tr><td>${e.rank ?? ""}</td><td><a href="${toolHref(entryToolId(e))}">${e.pkg}</a>${e.version ? html`<span class="ver">@${e.version}</span>` : ""}</td><td>${OUTCOME_TEXT[e.outcome]}${e.slow ? " (slow)" : ""}</td><td>${e.tools ?? ""}</td><td>${e.ms !== null && e.outcome !== "needs_config" ? `${(e.ms / 1000).toFixed(1)} s` : ""}</td><td>${e.downloads !== null ? n(e.downloads) : ""}</td></tr>`,
  )}</tbody></table></div>`;
}

site.get(HOUSE_REPORT_PATH, async (c) => {
  const run = await latestRun(c.env);
  if (!run) return c.notFound();
  const k = run.counts;
  // Test errors are ours, not the server's, so they're left out of the percentages.
  const total = run.entries.length - k.error;
  const weekAgo = new Date(Date.parse(run.probedAt) - 7 * 86_400_000).toISOString().slice(0, 10);
  const broken = newlyBroken(run, await runForDay(c.env, weekAgo));
  const hist = (await history(c.env)).slice(-14);
  const startFailed = k.failed + k.no_answer + k.partial;
  const [week, cached] = await Promise.all([weekOfTests(c.env), cachedToolScans(c.env)]);
  const scans = cached.summary;
  const matches = cached.matches.slice(0, 50);
  const wk = week.counts;
  // Ranks skip where a ranked server is also on the always-test list (integrations/house withPriority: it runs
  // first, with no rank, and sorts last here). Said once, and only when unranked rows are there to explain the gaps.
  const ranks = run.entries.map((e) => e.rank).filter((r): r is number => r !== null);
  const gaps = ranks.some((r, i) => r !== i + 1) && ranks.length < run.entries.length;
  return send(c, {
    title: "The Forge House Report",
    description: `Every night we start the ${n(total)} most-downloaded no-setup MCP servers from the official registry. Last night ${pct(k.worked, total)}% started and listed their tools; ${pct(startFailed, total)}% didn't work.`,
    path: HOUSE_REPORT_PATH,
    jsonAlternate: `${HOUSE_REPORT_PATH}.json`,
    body: html`<article class="prose">
<p class="eyebrow">Nightly · last run ${day(run.probedAt)}</p>
<h1 class="page-title">The Forge House Report</h1>
<p class="lead">Every night we start the ${n(total)} most-downloaded MCP servers that the official registry says need no keys or settings. Here is what happened.</p>
</article>
${statStrip({
  label: "Last night's results",
  main: [
    { value: `${pct(k.worked, total)}%`, label: `started and listed tools (${n(k.worked)})` },
    { value: `${pct(k.needs_config, total)}%`, label: `asked for a key anyway (${n(k.needs_config)})` },
    { value: `${pct(k.no_answer + k.partial, total)}%`, label: `started, never finished the handshake (${n(k.no_answer + k.partial)})` },
    { value: `${pct(k.failed + k.not_on_npm, total)}%`, label: `could not be installed (${n(k.failed + k.not_on_npm)})` },
  ],
  caption: disclosure(html`Each ran with <code>npx</code> in an empty folder: <code>initialize</code>, then <code>tools/list</code>, no credentials, a 75-second limit. Test errors are ours and left out (${n(k.error)}).`, { href: "#how", label: "How to read this" }),
})}
<article class="prose">
${week.sweep_days > 0
      ? html`<h2 id="week">Every no-setup server, every week</h2>
<p>A weekly sweep also starts <strong>every</strong> no-setup server in the registry (npm with <code>npx</code>, PyPI with <code>uvx</code>), a seventh each day.${week.sweep_days < 7 ? html` <span class="muted">The sweep has run on ${week.sweep_days} of the last 7 days, so this covers part of the rotation.</span>` : ""}</p>
</article>
${statStrip({
  label: "The last 7 days",
  main: [
    { value: n(week.servers), label: `MCP servers live-tested in the last 7 days (${n(week.npm)} npm, ${n(week.pypi)} PyPI)` },
    { value: `${pct(wk.worked, week.servers)}%`, label: `started and listed tools (${n(wk.worked)})` },
    { value: `${pct(wk.needs_config, week.servers)}%`, label: `asked for a key anyway (${n(wk.needs_config)})` },
    { value: `${pct(wk.failed + wk.not_on_npm + wk.not_on_pypi + wk.no_command, week.servers)}%`, label: `could not be installed or started by name (${n(wk.failed + wk.not_on_npm + wk.not_on_pypi + wk.no_command)})` },
  ],
})}
<article class="prose">`
      : ""}
${scans.servers > 0
      ? html`<h2 id="tool-descriptions">Tool descriptions scanned</h2>
<p>${n(scans.servers)} servers' tool lists${scans.since ? ` since ${day(scans.since)}` : ""}, ${n(scans.tools)} tool descriptions, scanned with the rules of <a href="/scan">the skill scanner</a>: ${n(scans.verdicts.flagged)} matched a high-risk pattern and ${n(scans.verdicts.caution)} a pattern worth a look. This is the text an agent reads before it picks a tool.</p>
${matches.length
  ? more(
      `Servers whose descriptions matched (${matches.length})`,
      html`<p>A match means a person should read that text. It isn't a finding against the server and doesn't change the tool's status. Each tool page shows the matched text.</p>
<ul>${matches.map((m) => html`<li><a href="${toolHref(m.tool)}#signals">${m.tool}</a>@${m.version}: ${m.counts.high} high, ${m.counts.medium} medium (${m.rules.join(", ")})</li>`)}</ul>`,
    )
  : ""}`
      : ""}
<h2>Broke this week</h2>
${broken.length ? html`<p>Worked a week ago, not last night:</p><ul>${broken.map((e) => html`<li><a href="${toolHref(entryToolId(e))}">${e.pkg}</a>${e.version ? html`@${e.version}` : ""}: ${OUTCOME_TEXT[e.outcome]}</li>`)}</ul>` : html`<p>Nothing that worked a week ago has stopped working${hist.length < 8 ? " (or there isn't a week of history yet)" : ""}.</p>`}
<h2 id="servers">Every server, last night</h2>
<p>Ranked by last week's npm downloads. ${run.entries.length > TOP_ROWS ? `The top ${TOP_ROWS} are below; ` : ""}the full list: <a href="${HOUSE_REPORT_PATH}.csv">CSV</a> · <a href="${HOUSE_REPORT_PATH}.json">JSON</a>.${gaps ? " Gaps in # are servers on our always-test list, shown at the end without a rank." : ""}</p>
</article>
${serverTable(run.entries.slice(0, TOP_ROWS))}
${run.entries.length > TOP_ROWS ? more(`Show all ${n(run.entries.length)} servers`, serverTable(run.entries.slice(TOP_ROWS)), { id: "all-servers" }) : ""}
<article class="prose">
<h2 id="how">How to read this</h2>
<ul>
<li>"Started and listed tools" is a real handshake, not a guess. It's filed as a House field report for that exact version, labelled House and kept out of every proof number.</li>
<li>"Asked for a key": the registry entry says it needs nothing, but it asked for configuration. No report is filed, because it may work once set up.</li>
<li>Only servers that run over stdio: npm (nightly and weekly) and PyPI (weekly, with <code>uvx</code>). Remote and Docker servers aren't tested yet.</li>
<li>Tool-description scans are pattern matches, recorded per server and version. Nobody is notified automatically; notices to maintainers are written and sent by a person, at most three a week.</li>
<li>Method and code: <a href="https://github.com/theagentforge/agent-forge/tree/main/integrations/house">integrations/house</a>.</li>
</ul>
</article>`,
  });
});

site.get(`${HOUSE_REPORT_PATH}.json`, async (c) => {
  const run = await latestRun(c.env);
  if (!run) return c.json({ error: "no_run_yet" }, 404);
  const [hist, week, sweeps, { summary: scans, matches }] = await Promise.all([history(c.env), weekOfTests(c.env), sweepHistory(c.env), cachedToolScans(c.env)]);
  return c.json(
    {
      name: "The Forge House Report",
      outcomes: OUTCOMES,
      ...run,
      history: hist,
      // ADR 0108: the weekly sweep of every no-setup npm and PyPI server, and the tool-description scans.
      week: { ...week, counting_rule: "One row per server (its latest result) across the last 7 daily sweeps and the latest nightly run; test errors left out." },
      sweep_history: sweeps,
      tool_descriptions: { ...scans, pattern_matches: matches, wording: "A pattern match is for a person to read; it is never a finding of malice." },
    },
    200,
    { "Cache-Control": "public, max-age=600", "Access-Control-Allow-Origin": "*" },
  );
});

site.get(`${HOUSE_REPORT_PATH}.csv`, async (c) => {
  const run = await latestRun(c.env);
  if (!run) return c.text("No run yet.", 404);
  return c.body(toCsv(run), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="forge-house-report-${run.probedAt.slice(0, 10)}.csv"`,
    "Cache-Control": "public, max-age=600",
  });
});
