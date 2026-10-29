import { html } from "hono/html";
import { entryToolId, history, latestRun, newlyBroken, OUTCOMES, pct, runForDay, sweepHistory, toCsv, weekOfTests, type HouseOutcome } from "../services/house-report";
import { cachedToolScans } from "../services/house-tools";
import { toolHref } from "./components";
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
  return send(c, {
    title: "The Forge House Report",
    description: `Every night we start the ${n(total)} most-downloaded no-setup MCP servers from the official registry. Last night ${pct(k.worked, total)}% started and listed their tools; ${pct(startFailed, total)}% didn't work.`,
    path: HOUSE_REPORT_PATH,
    jsonAlternate: `${HOUSE_REPORT_PATH}.json`,
    body: html`<article class="prose">
<p class="eyebrow">Nightly · last run ${day(run.probedAt)}</p>
<h1 class="page-title">The Forge House Report</h1>
<p>Every night our House tester starts the <strong>${n(total)} most-downloaded MCP servers</strong> that the official MCP Registry lists as needing no keys or settings. Each runs with <code>npx</code> in an empty folder and gets the MCP handshake: <code>initialize</code>, then <code>tools/list</code>. No credentials, no arguments, a 75-second limit.</p>
</article>
<div class="stats spaced">
<div class="stat"><b>${pct(k.worked, total)}%</b><span>started and listed tools (${n(k.worked)})</span></div>
<div class="stat"><b>${pct(k.needs_config, total)}%</b><span>asked for a key anyway (${n(k.needs_config)})</span></div>
<div class="stat"><b>${pct(k.no_answer + k.partial, total)}%</b><span>started but never finished the handshake (${n(k.no_answer + k.partial)})</span></div>
<div class="stat"><b>${pct(k.failed + k.not_on_npm, total)}%</b><span>could not be installed (${n(k.failed + k.not_on_npm)})</span></div>
</div>
<article class="prose">
<h2 id="week">Every no-setup server, every week</h2>
<p>Besides the nightly top 500, a weekly sweep starts <strong>every</strong> server the registry lists as needing no keys or settings: npm packages with <code>npx</code>, Python packages with <code>uvx</code>. Each day takes a fixed seventh, so every server is tested once a week.</p>
</article>
<div class="stats spaced">
<div class="stat"><b>${n(week.servers)}</b><span>MCP servers live-tested in the last 7 days (${n(week.npm)} npm, ${n(week.pypi)} PyPI)</span></div>
<div class="stat"><b>${pct(wk.worked, week.servers)}%</b><span>started and listed tools (${n(wk.worked)})</span></div>
<div class="stat"><b>${pct(wk.needs_config, week.servers)}%</b><span>asked for a key anyway (${n(wk.needs_config)})</span></div>
<div class="stat"><b>${pct(wk.failed + wk.not_on_npm + wk.not_on_pypi + wk.no_command, week.servers)}%</b><span>could not be installed or started by name (${n(wk.failed + wk.not_on_npm + wk.not_on_pypi + wk.no_command)})</span></div>
</div>
${week.sweep_days < 7 ? html`<p class="muted small">The sweep has run on ${week.sweep_days} of the last 7 days, so this covers ${week.sweep_days ? "part of" : "none of"} the rotation yet.</p>` : ""}
<article class="prose">
<h2 id="tool-descriptions">Tool descriptions scanned</h2>
<p>When a server lists its tools, we keep what it said about each one (name, description and input schema, capped in size) and scan it with the same rules as <a href="/scan">the skill scanner</a>: hidden instructions, invisible characters, prompt-injection phrases, downloads piped into a shell, credential reads, throwaway collection endpoints. This is the text an agent reads before it decides which tool to call.</p>
</article>
<div class="stats spaced">
<div class="stat"><b>${n(scans.servers)}</b><span>servers' tool lists scanned${scans.since ? ` since ${day(scans.since)}` : ""}</span></div>
<div class="stat"><b>${n(scans.tools)}</b><span>tool descriptions scanned</span></div>
<div class="stat"><b>${n(scans.verdicts.flagged)}</b><span>matched a high-risk pattern</span></div>
<div class="stat"><b>${n(scans.verdicts.caution)}</b><span>matched a pattern worth a look</span></div>
</div>
<article class="prose">
${matches.length ? html`<p>Servers whose descriptions matched a pattern. A match means a person should read that text; it is not a finding that the server is malicious, and it doesn't change the tool's status. Each tool page shows the matched text.</p>
<ul>${matches.map((m) => html`<li><a href="${toolHref(m.tool)}#signals">${m.tool}</a>@${m.version}: ${m.counts.high} high, ${m.counts.medium} medium (${m.rules.join(", ")})</li>`)}</ul>` : html`<p>No scanned tool list has matched a high or medium pattern${scans.servers ? "" : " (none scanned yet)"}.</p>`}
<h2>Broke this week</h2>
${broken.length ? html`<p>Worked a week ago, not last night:</p><ul>${broken.map((e) => html`<li><a href="${toolHref(entryToolId(e))}">${e.pkg}</a>${e.version ? html`@${e.version}` : ""}: ${OUTCOME_TEXT[e.outcome]}</li>`)}</ul>` : html`<p>Nothing that worked a week ago has stopped working${hist.length < 8 ? " (or there isn't a week of history yet)" : ""}.</p>`}
<h2>Every server, last night</h2>
<p>Download the dataset: <a href="${HOUSE_REPORT_PATH}.csv">CSV</a> · <a href="${HOUSE_REPORT_PATH}.json">JSON</a>. Ranked by last week's npm downloads.</p>
</article>
<div class="scroll-x spaced"><table class="table">
<thead><tr><th>#</th><th>Package</th><th>Result</th><th>Tools</th><th>Time</th><th>Downloads / week</th></tr></thead>
<tbody>${run.entries.map(
      (e) => html`<tr><td>${e.rank ?? ""}</td><td><a href="${toolHref(entryToolId(e))}">${e.pkg}</a>${e.version ? html`<span class="ver">@${e.version}</span>` : ""}</td><td>${OUTCOME_TEXT[e.outcome]}${e.slow ? " (slow)" : ""}</td><td>${e.tools ?? ""}</td><td>${e.ms !== null && e.outcome !== "needs_config" ? `${(e.ms / 1000).toFixed(1)} s` : ""}</td><td>${e.downloads !== null ? n(e.downloads) : ""}</td></tr>`,
    )}</tbody></table></div>
<article class="prose">
<h2>How to read this</h2>
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
