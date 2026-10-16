import { html } from "hono/html";
import { history, latestRun, newlyBroken, OUTCOMES, pct, runForDay, toCsv, type HouseOutcome } from "../services/house-report";
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
  return send(c, {
    title: "The Forge House Report",
    description: `Every night we start the ${n(total)} most-downloaded no-setup MCP servers from the official registry. Last night ${pct(k.worked, total)}% started and listed their tools; ${pct(startFailed, total)}% didn't work.`,
    path: HOUSE_REPORT_PATH,
    jsonAlternate: `${HOUSE_REPORT_PATH}.json`,
    body: html`<article class="prose">
<p class="eyebrow">Nightly · last run ${day(run.probedAt)}</p>
<h1 class="page-title">The Forge House Report</h1>
<p>Every night our House tester takes the <strong>${n(total)} most-downloaded MCP servers</strong> in the official MCP Registry that say they need no keys or settings, starts each one with <code>npx</code> in an empty folder, and does the MCP handshake: <code>initialize</code>, then <code>tools/list</code>. No credentials, no arguments, a 75-second limit.</p>
</article>
<div class="stats spaced">
<div class="stat"><b>${pct(k.worked, total)}%</b><span>started and listed tools (${n(k.worked)})</span></div>
<div class="stat"><b>${pct(k.needs_config, total)}%</b><span>asked for a key anyway (${n(k.needs_config)})</span></div>
<div class="stat"><b>${pct(k.no_answer + k.partial, total)}%</b><span>started but never finished the handshake (${n(k.no_answer + k.partial)})</span></div>
<div class="stat"><b>${pct(k.failed + k.not_on_npm, total)}%</b><span>could not be installed (${n(k.failed + k.not_on_npm)})</span></div>
</div>
<article class="prose">
<h2>Broke this week</h2>
${broken.length ? html`<p>Worked a week ago, not last night:</p><ul>${broken.map((e) => html`<li><a href="${toolHref(`npm:${e.pkg}`)}">${e.pkg}</a>${e.version ? html`@${e.version}` : ""}: ${OUTCOME_TEXT[e.outcome]}</li>`)}</ul>` : html`<p>Nothing that worked a week ago has stopped working${hist.length < 8 ? " (or there isn't a week of history yet)" : ""}.</p>`}
<h2>Every server, last night</h2>
<p>Download the dataset: <a href="${HOUSE_REPORT_PATH}.csv">CSV</a> · <a href="${HOUSE_REPORT_PATH}.json">JSON</a>. Ranked by last week's npm downloads.</p>
</article>
<div class="scroll-x spaced"><table class="table">
<thead><tr><th>#</th><th>Package</th><th>Result</th><th>Tools</th><th>Time</th><th>Downloads / week</th></tr></thead>
<tbody>${run.entries.map(
      (e) => html`<tr><td>${e.rank ?? ""}</td><td><a href="${toolHref(`npm:${e.pkg}`)}">${e.pkg}</a>${e.version ? html`<span class="ver">@${e.version}</span>` : ""}</td><td>${OUTCOME_TEXT[e.outcome]}${e.slow ? " (slow)" : ""}</td><td>${e.tools ?? ""}</td><td>${e.ms !== null && e.outcome !== "needs_config" ? `${(e.ms / 1000).toFixed(1)} s` : ""}</td><td>${e.downloads !== null ? n(e.downloads) : ""}</td></tr>`,
    )}</tbody></table></div>
<article class="prose">
<h2>How to read this</h2>
<ul>
<li>"Started and listed tools" is a real handshake, not a guess. It is filed as a House field report for that exact version, labelled House and kept out of every proof number.</li>
<li>"Asked for a key" means the server's registry entry says it needs nothing, but it stopped and asked for configuration. We don't file a report for it, because the server may be fine once set up.</li>
<li>Only servers on npm that run over stdio are included. Remote servers, Python and Docker servers aren't in this test yet.</li>
<li>Method and code: <a href="https://github.com/theagentforge/agent-forge/tree/main/integrations/house">integrations/house</a>.</li>
</ul>
</article>`,
  });
});

site.get(`${HOUSE_REPORT_PATH}.json`, async (c) => {
  const run = await latestRun(c.env);
  if (!run) return c.json({ error: "no_run_yet" }, 404);
  return c.json(
    { name: "The Forge House Report", outcomes: OUTCOMES, ...run, history: await history(c.env) },
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
