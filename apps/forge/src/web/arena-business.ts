import { PUBLIC_NAME, VERDICT_RUNS } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { CURRENT_RULES_PATH } from "../arena/rules-label";
import { rulesLine } from "./arena-failures";
import { BUSINESS_RULES, businessBoard, cellJson, MIN_CELL_ATTEMPTS, toCsv, type BizCell, type BusinessBoard } from "../arena/business";
import { parseFailTier, type FailTier } from "../arena/failures";
import { getDb } from "../services/db";
import { send, sendJson, site, wantsJson } from "./pages";

// /arena/business (K3): Business Agent reliability, the Arena's ranked results grouped by business task, with n, 95%
// intervals and replays; a JSON twin (structured data only, AGENTS.md rule 7), a CSV download, and the one-page living
// report at /reports/business-agents-2026-10, computed live from the same function.

type Ctx = Context<{ Bindings: Env }>;
export const BUSINESS_PATH = "/arena/business";
export const BUSINESS_REPORT_PATH = "/reports/business-agents-2026-10";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const tierQuery = (t: FailTier) => (t === "all" ? "" : `?tier=${t}`);
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const REPORT_TITLE = "How often do frontier AI agents break business policy?";
const TIER_NAME: Record<FailTier, string> = { all: "All tiers", normal: "Normal", hard: "Hard" };

/** The structured twin: ids, numbers, codes, links and our own group names. */
export function businessData(b: BusinessBoard) {
  return {
    name: `${PUBLIC_NAME} business agent reliability`,
    tier: b.tier,
    since: b.since,
    as_of: b.asOf,
    attempts: b.attempts,
    knockouts: b.knockouts,
    rules: BUSINESS_RULES,
    /** F-01 (ADR 0082): the referee rules versions that scored the counted attempts (every version is pooled here). */
    rules_versions: Object.fromEntries(b.rulesVersions.map((v) => [v.version, v.attempts])),
    rules_pooled: b.rules === null,
    current_rules_results: CURRENT_RULES_PATH,
    models: b.models,
    events: b.events.map((e) => ({ slug: e.slug, url: `/arena/event/${e.slug}` })),
    overall: cellJson(b.overall),
    groups: b.groups.map((g) => ({
      id: g.group.id,
      name: g.group.name,
      tasks: g.group.tasks,
      traps: g.group.traps,
      overall: cellJson(g.overall),
      models: g.models.map((m) => ({ id: m.id, name: m.name, ...cellJson(m.cell) })),
    })),
    csv: `${BUSINESS_PATH}.csv${tierQuery(b.tier)}`,
    report: BUSINESS_REPORT_PATH,
  };
}

const rateText = (c: BizCell) => (c.shown ? html`<b>${pct(c.rate!)}</b> <span class="muted">${c.breaks} of ${c.n}</span>` : c.n ? html`<span class="muted" title="Fewer than ${MIN_CELL_ATTEMPTS} attempts">Too few (n=${c.n})</span>` : html`<span class="muted">–</span>`);
const ciText = (c: BizCell) => (c.shown ? html`${pct(c.ci![0])}–${pct(c.ci![1])}${c.early ? html` <span class="label" title="Fewer than ${VERDICT_RUNS} attempts: a first look, not a verdict">Early read</span>` : ""}` : html`<span class="muted">–</span>`);
const trapText = (c: BizCell) => (c.topTrap ? html`<a href="/arena/failures/${c.topTrap.id}"><code>${c.topTrap.id}</code></a> <span class="muted small">×${c.topTrap.falls}</span>` : html`<span class="muted">–</span>`);
const replayText = (c: BizCell) =>
  c.replays.length
    ? html`${c.replays.map((r, i) => html`${i ? " · " : ""}<a href="/arena/run/${r.id}" title="${r.broke ? "An attempt that broke policy" : "An attempt that kept to policy"}">${r.broke ? "✕ broke" : "✓ kept"}</a>`)}`
    : html`<span class="muted">–</span>`;

function cellRow(name: string, c: BizCell, strong = false) {
  return html`<tr><td class="wide">${strong ? html`<b>${name}</b>` : name}</td><td class="num" data-label="Attempts">${c.n}</td><td data-label="Broke policy">${rateText(c)}</td><td data-label="95% interval">${ciText(c)}</td><td data-label="Most common trap">${trapText(c)}</td><td class="num" data-label="Ran out">${c.knockouts}</td><td data-label="Replays">${replayText(c)}</td></tr>`;
}

const TABLE_HEAD = html`<thead><tr><th scope="col">Model</th><th scope="col" class="num">Attempts</th><th scope="col">Broke policy</th><th scope="col">95% interval</th><th scope="col">Most common trap</th><th scope="col" class="num">Ran out</th><th scope="col">Replays</th></tr></thead>`;

export const METHOD_NOTE = html`<p>Every number comes from the Arena's referee, never from what an AI said. Only ranked bouts count (headline and guest events), not practice runs, prompt experiments, models whose results aren't published yet or events still being checked. An attempt counts in a group when one of the group's planted traps was in its job, and it <b>broke policy</b> when the referee found one of those traps sprung in the sandbox's end state or its log of tool calls. An attempt that ran out of time, tokens, turns or tool calls is shown as <b>ran out</b>: it's left out of the attempts and the break rate and never counted as a break (those still show on <a href="/arena/failures">the failure board</a>). Each rate has a 95% Wilson interval, which treats attempts as independent; a model gets 3 attempts at the same version of a job, so the real uncertainty is a little wider. Cells with fewer than ${MIN_CELL_ATTEMPTS} attempts say "too few", and under ${VERDICT_RUNS} they're marked Early read.</p>`;

/** F-01: which rules versions scored these attempts (pooled here), and where the current rules are kept apart. */
const bizRulesLine = (b: BusinessBoard) => rulesLine(b.rulesVersions.map((v) => ({ version: v.version, n: v.attempts })).reverse());

function tierLinks(tier: FailTier) {
  const link = (t: FailTier) => html`<a class="btn chamfer${t === tier ? " primary" : ""}" href="${BUSINESS_PATH}${tierQuery(t)}"${t === tier ? html` aria-current="page"` : ""}>${TIER_NAME[t]}</a>`;
  return html`<nav class="presets tier-switch" aria-label="Tier">${link("all")}${link("normal")}${link("hard")}</nav>`;
}

site.get(`${BUSINESS_PATH}.csv`, async (c) => {
  const b = await businessBoard(getDb(c.env), parseFailTier(c.req.query("tier")));
  return c.body(toCsv(b), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="forge-business-agents-${b.tier}-${b.asOf ?? "empty"}.csv"`,
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
});

site.get(BUSINESS_PATH, async (c) => {
  const tier = parseFailTier(c.req.query("tier"));
  const b = await businessBoard(getDb(c.env), tier);
  if (wantsJson(c)) return sendJson(c, businessData(b));
  const csv = `${BUSINESS_PATH}.csv${tierQuery(tier)}`;
  return send(c, {
    title: `${PUBLIC_NAME}: business agent reliability`,
    description: "How often AI agents break business policy on refunds, payments, bookings, stock, records and permissions: refereed attempts, 95% intervals and replays.",
    path: `${BUSINESS_PATH}${tierQuery(tier)}`,
    nav: "arena",
    jsonAlternate: `${BUSINESS_PATH}?${tierQuery(tier) ? `${tierQuery(tier).slice(1)}&` : ""}format=json`,
    body: html`<p class="eyebrow"><a href="/arena">${PUBLIC_NAME}</a> · Business agents</p>
<h1 class="page-title">How often do AI agents break business policy?</h1>
<p class="lead">The Arena's refereed results, grouped by the kind of business task: how many attempts, the share that broke a business rule by falling for a planted trap, and replays you can watch.${b.asOf ? ` Ranked results to ${fmtDay(b.asOf)}.` : ""}</p>
${b.attempts && b.overall.shown ? html`<p><b>All models, all groups: ${pct(b.overall.rate!)}</b> of ${b.attempts} attempts broke policy (95% ${pct(b.overall.ci![0])}–${pct(b.overall.ci![1])}); ${b.knockouts} more ran out.</p>` : ""}
${bizRulesLine(b)}
${tierLinks(tier)}
<h2 id="method">How it's counted</h2>
${METHOD_NOTE}
${b.attempts ? "" : html`<p class="empty">No ranked bouts in this tier yet. The groups fill in as events are fought.</p>`}
<h2 id="groups">By business task</h2>
<div class="table-wrap"><table class="table stack">
<thead><tr><th scope="col">Group</th><th scope="col" class="num">Attempts</th><th scope="col">Broke policy</th><th scope="col">95% interval</th><th scope="col">Most common trap</th><th scope="col" class="num">Ran out</th><th scope="col">Replays</th></tr></thead>
<tbody>${b.groups.map((g) => cellRow(g.group.name, g.overall, true))}</tbody></table></div>
${b.groups.map(
  (g) => html`<section id="${g.group.id}">
<h2>${g.group.name}</h2>
<p class="muted">${g.group.summary}. Traps: ${g.group.traps.map((id, i) => html`${i ? ", " : ""}<a href="/arena/failures/${id}${tierQuery(tier)}"><code>${id}</code></a>`)}.</p>
${g.models.length
  ? html`<div class="table-wrap"><table class="table stack">${TABLE_HEAD}<tbody>${cellRow("All models", g.overall, true)}${g.models.map((m) => cellRow(m.name, m.cell))}</tbody></table></div>`
  : html`<p class="empty">No ranked attempt with these traps in this tier yet.</p>`}
</section>`,
)}
<p>Download: <a href="${csv}" download>CSV</a> · <a href="${BUSINESS_PATH}?${tierQuery(tier) ? `${tierQuery(tier).slice(1)}&` : ""}format=json">JSON</a> · the one-page report: <a href="${BUSINESS_REPORT_PATH}">${REPORT_TITLE}</a></p>
<p class="muted small-print">Trap ids, descriptions and real-world sources are in the <a href="/arena/methodology#catalog">trap catalogue</a>; every run is in <a href="/arena/dataset.json">the dataset</a>. Every job is an invented sandbox: no real companies, people or money. Lab and model names identify what was tested; ${PUBLIC_NAME} is not affiliated with any lab.</p>`,
  });
});

site.get(BUSINESS_REPORT_PATH, async (c) => {
  const b = await businessBoard(getDb(c.env), "all");
  if (wantsJson(c)) return sendJson(c, businessData(b));
  const shownGroups = b.groups.filter((g) => g.overall.shown).sort((x, y) => y.overall.rate! - x.overall.rate! || y.overall.n - x.overall.n);
  const tooFew = b.groups.filter((g) => !g.overall.shown);
  const cellsShown = b.groups.flatMap((g) => g.models.filter((m) => m.cell.shown)).length;
  const cellsHidden = b.groups.flatMap((g) => g.models.filter((m) => !m.cell.shown)).length;
  const smallest = shownGroups.length ? Math.min(...shownGroups.map((g) => g.overall.n)) : 0;
  return send(c, {
    title: REPORT_TITLE,
    description: "A living report from the Forge Arena: how often refereed AI agents broke a business rule on refunds, payments, bookings, stock, records and permissions, with n, 95% intervals and replays.",
    path: BUSINESS_REPORT_PATH,
    nav: "arena",
    jsonAlternate: `${BUSINESS_PATH}?format=json`,
    body: html`<article class="prose">
<p class="eyebrow">Report · <span class="label">Living page</span> · ${b.asOf ? html`data to <time datetime="${b.asOf}">${fmtDay(b.asOf)}</time>` : "no data yet"}</p>
<h1 class="page-title">${REPORT_TITLE}</h1>
<p class="lead">This page is computed live from the Arena's referee results each time it loads, so the numbers change as new ranked events are published. Cite it with the data date above.</p>

<h2 id="headline">Headline numbers</h2>
${bizRulesLine(b)}
${b.attempts && b.overall.shown
  ? html`<ul>
<li><b>${pct(b.overall.rate!)}</b> of ${b.attempts} refereed attempts broke a business rule (95% interval ${pct(b.overall.ci![0])}–${pct(b.overall.ci![1])}), across ${b.models.length} ${b.models.length === 1 ? "model" : "models"}. ${b.knockouts} further ${b.knockouts === 1 ? "attempt" : "attempts"} ran out of time or moves and ${b.knockouts === 1 ? "is" : "are"} counted apart.</li>
${shownGroups.map((g) => html`<li>${g.group.name}: <b>${pct(g.overall.rate!)}</b> of ${g.overall.n} attempts (95% ${pct(g.overall.ci![0])}–${pct(g.overall.ci![1])})${g.overall.topTrap ? html`; most common trap <a href="/arena/failures/${g.overall.topTrap.id}"><code>${g.overall.topTrap.id}</code></a>` : ""}.</li>`)}
${tooFew.length ? html`<li>Too few attempts to show yet: ${tooFew.map((g, i) => html`${i ? ", " : ""}${g.group.name.toLowerCase()} (n=${g.overall.n})`)}.</li>` : ""}
</ul>
<p>Per model, with replays: <a href="${BUSINESS_PATH}">${PUBLIC_NAME}: business agent reliability</a>.</p>`
  : html`<p class="empty">No ranked results yet. The numbers appear here once ranked events are published.</p>`}

<h2 id="method">Method</h2>
<p>The Arena gives each AI model the same everyday business jobs in an invented sandbox (a refund queue, a fortnight of supplier invoices, a trip to book, a restock, a customer sheet to clean, a week of payments) with traps modelled on real fraud and failure patterns. When the model stops, a referee checks the sandbox's end state and the log of every tool call. Jobs and traps are grouped into seven business tasks; the mapping is fixed in code and every job and trap is in exactly one group.</p>
${METHOD_NOTE}

<h2 id="limits">Limits</h2>
<ul>
<li><b>Sample sizes.</b> ${b.attempts} attempts in all${shownGroups.length ? `; the smallest group shown has ${smallest}` : ""}. ${cellsShown} model-and-group ${cellsShown === 1 ? "cell is" : "cells are"} shown and ${cellsHidden} ${cellsHidden === 1 ? "has" : "have"} too few attempts. Most cells are under ${VERDICT_RUNS} attempts, so read them as first looks.</li>
<li><b>Models tested.</b> ${b.models.length ? b.models.map((m, i) => html`${i ? ", " : ""}${m.name}`) : "none yet"}. Each model is tested through one provider with its settings pinned; results describe that model on these jobs, not every way it can be deployed.</li>
<li><b>Dates.</b> ${b.since && b.asOf ? html`Ranked results from ${fmtDay(b.since)} to ${fmtDay(b.asOf)}, across ${b.events.length} ${b.events.length === 1 ? "event" : "events"}.` : "No results yet."} Normal and Hard tiers are pooled here; <a href="${BUSINESS_PATH}?tier=hard">the Hard view</a> shows them apart.</li>
<li><b>What counts.</b> Only the planted traps count as policy breaks. Other mistakes (a wrong total, a missed item) lower a bout's score but aren't counted here, and a model that runs out of time is reported apart rather than as safe or unsafe.</li>
<li><b>Sandbox, not production.</b> The jobs, companies, people and money are invented. A real deployment has its own tools, prompts and checks.</li>
</ul>

<h2 id="data">Data</h2>
<p><a href="${BUSINESS_PATH}.csv" download>CSV</a> · <a href="${BUSINESS_PATH}?format=json">JSON</a> · <a href="/arena/dataset.json">every run, with signed logs</a> · <a href="/arena/methodology">methodology</a> · <a href="/arena/failures">failure board</a></p>
<p class="muted small-print">Lab and model names identify what was tested; ${PUBLIC_NAME} is not affiliated with any lab.</p>
</article>`,
  });
});
