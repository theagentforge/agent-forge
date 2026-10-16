import {
  condensedSeconds,
  DIVISIONS,
  formatWeights,
  frames,
  moments,
  OFFICIAL_WEIGHTS,
  paretoFrontier,
  parseWeights,
  PRESETS,
  PUBLIC_NAME,
  rankModels,
  SEASON,
  summaryLines,
  TAGLINE,
  taskById,
  TASKS,
  titleHolder,
  VERDICT_RUNS,
  type AttemptResult,
  type Stats,
} from "@forge/arena";
import { testedModels } from "../arena/lineup";
import type { Context } from "hono";
import { html } from "hono/html";
import { getDb } from "../services/db";
import { signReport } from "../services/signing";
import { divisionRankings, eventCard, finishedRuns, modelName, playlist, runWithLog, taskBoard, type ModelRow } from "../arena/views";
import { channelDuels } from "../arena/featured";
import { duelPlayer } from "./duel";
import { send, site } from "./pages";

// The Forge Arena pages (ADR 0013–0014): Now Playing, bout cards, full replays, the Task Guide and the dataset.
// Every number comes from the referee's results; every visual from its log.

type Ctx = Context<{ Bindings: Env }>;
const json = (c: Ctx) => c.req.query("format") === "json" || (c.req.header("Accept") ?? "").startsWith("application/json");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => (!Number.isFinite(x) ? "never passes" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const NOT_AFFILIATED = html`<p class="muted small-print">Lab and model names identify what was tested. ${PUBLIC_NAME} is not affiliated with any lab. Every result is checked by a referee from the sandbox's end state, never from what the AI says. <a href="/arena/rules">Rules</a> · <a href="/arena/dataset.json">Dataset</a></p>`;

const statusTag = (s: Stats) =>
  s.status === "verdict" ? html`<span class="label">Verdict · n=${s.runs}</span>` : html`<span class="label" title="Fewer than ${VERDICT_RUNS} runs: treat as a first look">Early read · n=${s.runs}</span>`;

function scoreTable(rows: { name: string; href?: string; stats: Stats; extra?: unknown }[]) {
  return html`<table class="table stack">
<thead><tr><th scope="col">Model</th><th scope="col" class="num">Pass</th><th scope="col" class="num">Quality</th><th scope="col" class="num">Traps avoided</th><th scope="col" class="num">pass^3</th><th scope="col" class="num">Cost per pass</th><th scope="col" class="num">Model time</th><th scope="col" class="num">Honest</th></tr></thead>
<tbody>${rows.map(
    (r) => html`<tr><td class="wide">${r.href ? html`<a href="${r.href}">${r.name}</a>` : r.name} ${r.extra ?? ""}</td><td class="num" data-label="Pass">${pct(r.stats.passRate)} <span class="muted">(${pct(r.stats.passCI[0])}–${pct(r.stats.passCI[1])})</span></td><td class="num" data-label="Quality">${pct(r.stats.quality)}</td><td class="num" data-label="Traps avoided">${pct(r.stats.trapResistance)}</td><td class="num" data-label="pass^3">${pct(r.stats.reliability)}</td><td class="num" data-label="Cost per pass">${usd(r.stats.costOfPass)}</td><td class="num" data-label="Model time">${secs(r.stats.modelMs)}</td><td class="num" data-label="Honest">${pct(r.stats.honesty)}</td></tr>`,
  )}</tbody></table>`;
}

site.get("/arena", async (c) => {
  const db = getDb(c.env);
  const [list, practice, headline, ranks, duels] = await Promise.all([
    playlist(db),
    finishedRuns(db, { kinds: ["practice"], limit: 2000 }),
    finishedRuns(db, { kinds: ["card", "guest"], limit: 1 }),
    divisionRankings(db),
    channelDuels(c.env, db).catch(() => []),
  ]);
  const events = [...new Map(practice.map((r) => [r.summary.event, r.summary.eventName])).entries()];
  if (json(c)) return c.json({ name: PUBLIC_NAME, season: SEASON, tasks: TASKS.map((t) => ({ id: t.id, title: t.title, guide: `/best/${t.id}` })), now_playing: list, channel: duels, practice_events: events.map(([slug]) => `/arena/event/${slug}`) });
  return send(c, {
    title: PUBLIC_NAME,
    description: TAGLINE,
    path: "/arena",
    nav: "arena",
    body: html`<section class="hero-arena">
<p class="eyebrow">${SEASON.name} · ${SEASON.event}</p>
<h1 class="page-title">${PUBLIC_NAME}</h1>
<p class="lead">${TAGLINE}</p>
</section>
${duels.length
  ? html`<section class="now-playing" aria-labelledby="np-title"><div class="section-head"><h2 id="np-title">Now Playing</h2><a class="more" href="/arena/run/${duels[0]!.a.id}">Full bout</a></div>${duelPlayer(duels[0]!, { mode: "channel", channel: duels })}</section>`
  : html`<section class="now-playing panel" data-playlist="${JSON.stringify(list)}" aria-live="polite">
<div class="section-head"><h2>Now Playing</h2><span class="np-label label" data-np-label>${list.length ? "Replay" : "Off air"}</span></div>
${list.length
  ? html`<p class="np-title" data-np-title><a href="/arena/run/${list[0]!.id}">${list[0]!.model} · ${list[0]!.task}</a></p><progress class="np-bar" data-np-bar max="1" value="0"></progress><p class="muted" data-np-next></p>`
  : html`<p class="empty">Nothing on air yet. The first bouts air when ${SEASON.event} is fought.</p>`}
</section>`}
<p class="presets"><a class="btn primary chamfer" href="/arena/call-it">Call today's bout</a><a class="btn chamfer" href="/arena/vote">Vote: what's tested next</a></p>
<section>
<div class="section-head"><h2>Which AI for which job?</h2><a class="more" href="/best">All task guides</a></div>
<ul class="task-grid">${TASKS.map((t) => html`<li><a href="/best/${t.id}"><b>${t.title}</b><span>${t.summary}</span></a></li>`)}</ul>
</section>
<section aria-labelledby="h-models">
<h2 id="h-models">Which models we test</h2>
${(() => {
  const ms = testedModels();
  const item = (m: (typeof ms)[number]) => html`<li><b>${m.name}</b> <span class="muted">${m.lab.replace(/ \(open weights\)$/, "")}</span></li>`;
  const main = ms.filter((m) => m.division !== "practice");
  const practice = ms.filter((m) => m.division === "practice");
  return html`${main.length ? html`<h3>Main lineup</h3><p class="muted">Each lab's everyday model, ranked in ${SEASON.event} and every event after.</p><ul class="model-list">${main.map(item)}</ul>` : ""}
<h3>Practice</h3><p class="muted">Open models from the US, China and Europe on the same jobs and traps. Labelled practice and never ranked. Want one added? <a href="/arena/vote">Vote</a>, or enter it in the <a href="/arena/proving-ground">Proving Ground</a>.</p>
<ul class="model-list">${practice.map(item)}</ul>`;
})()}
</section>
<section>
<h2>Rankings</h2>
${Object.entries(DIVISIONS).map(([key, d]) => {
  const rows = ranks[key] ?? [];
  return html`<h3>${d.name}</h3><p class="muted">${d.note} Belt: ${rows[0] && headline.length ? html`<b>${rows[0].name}</b>` : html`<b>vacant</b>`}${headline.length ? "" : ` · first crowned at ${SEASON.event}`}.</p>
${rows.length ? html`<ol class="ranking">${rows.map((r, i) => html`<li><b>${i + 1}. ${r.name}</b> <span class="muted">${r.rating} (±${2 * r.rd})</span></li>`)}</ol>` : ""}`;
})}
</section>
${events.length
  ? html`<section><h2>Practice (dry runs, not ranked)</h2><p class="muted">Low-cost open models on the same harness, run to measure real cost per bout before any headline spend. Published because every run is.</p><ul>${events.map(([slug, name]) => html`<li><a href="/arena/event/${slug}">${name}</a></li>`)}</ul></section>`
  : ""}
${NOT_AFFILIATED}`,
  });
});

site.get("/arena/event/:slug", async (c) => {
  const card = await eventCard(getDb(c.env), c.req.param("slug"));
  if (!card) return c.notFound();
  if (json(c)) return c.json({ event: { slug: card.event.slug, name: card.event.name, kind: card.event.kind, twist: card.event.twist }, bouts: card.bouts.map((b) => ({ task: b.task.id, outcome: b.outcome, models: b.rows })), runs: card.runs });
  return send(c, {
    title: card.event.name,
    description: `${card.event.name}: every model, every task, checked by the referee.`,
    path: `/arena/event/${card.event.slug}`,
    body: html`<p class="eyebrow">${card.event.kind === "practice" ? "Practice · not ranked" : SEASON.name}</p>
<h1 class="page-title">${card.event.name}</h1>
${card.bouts.map(
  (b) => html`<section><div class="section-head"><h2>${b.task.title}</h2><a class="more" href="/best/${b.task.id}">Task guide</a></div>
<p class="muted">${b.task.summary} Traps: ${b.task.traps.map((t) => t.label.toLowerCase()).join("; ")}.</p>
${b.outcome?.winner ? html`<p><b>${modelName(b.outcome.winner)}</b> ${b.outcome.method === "tiebreak" ? "won on tiebreak (statistical tie; lower cost per pass, then speed)" : "won on the scorecard"}.</p>` : b.rows.length > 1 ? html`<p>Draw.</p>` : ""}
${scoreTable(b.rows.map((r) => ({ name: r.name, stats: r.stats, extra: statusTag(r.stats) })))}
<details><summary>All attempts</summary><ul class="runs">${card.runs
    .filter((r) => r.task === b.task.id)
    .map((r) => html`<li><a href="/arena/run/${r.id}">${modelName(r.model)} · variant ${r.seed} · attempt ${r.attempt}</a> ${r.passed ? html`<span class="outcome o-worked">✓ pass</span>` : html`<span class="outcome o-failed">✕ fail</span>`}</li>`)}</ul></details>
</section>`,
)}
${NOT_AFFILIATED}`,
  });
});

/** Verified replay: the stored signature matches a fresh signature over the stored log. */
async function verified(env: Env, id: string, log: unknown, signature: string | null) {
  if (!signature) return false;
  return (await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(log) })) === signature;
}

/** The replay, key moments and scorecard sections, shared by House bouts and Proving Ground attempts. */
export function replaySections(fs: ReturnType<typeof frames>, ms: ReturnType<typeof moments>, result: AttemptResult, score: number) {
  return html`<section class="panel replay" data-replay data-seconds="${condensedSeconds(fs)}">
<div class="section-head"><h2>Replay</h2><button class="btn chamfer" type="button" data-play hidden>▶ Condensed replay</button></div>
<div class="bars"><label>Progress (verified) <progress data-bar-progress max="1" value="${fs.at(-1)?.progress ?? 0}"></progress></label><label>Stamina (turns) <progress data-bar-stamina max="1" value="${fs.at(-1)?.stamina.turns ?? 0}"></progress></label></div>
<ol class="frames">${fs.map(
      (f, i) => html`<li class="fr fr-${f.kind}${f.card ? ` card-${f.card}` : ""}" id="f${i}" data-progress="${f.progress}" data-stamina="${f.stamina.turns}"><span class="fr-label">${f.label}</span>${f.detail ? html`<span class="fr-detail">${f.detail}</span>` : ""}</li>`,
    )}</ol>
</section>
<section><h2>Key moments</h2><ul class="moments">${ms.map((m) => html`<li><a href="#f${m.frame}">${m.label}</a></li>`)}</ul></section>
<section><h2>Scorecard</h2>
<table class="table"><tbody>
${result.checkpoints.map((cp) => html`<tr><td>${cp.passed ? "✓" : "✕"} ${cp.label}${cp.critical ? "" : html` <span class="muted">(bonus)</span>`}</td></tr>`)}
${result.traps.map((t) => html`<tr><td>${t.triggered ? "⚠ Fell for" : "✓ Avoided"}: ${t.label}</td></tr>`)}
</tbody></table>
<p class="muted">Official score ${Math.round(score * 100)}/100 (weights: pass ${OFFICIAL_WEIGHTS.pass}, quality ${OFFICIAL_WEIGHTS.quality}, traps ${OFFICIAL_WEIGHTS.traps}, honesty ${OFFICIAL_WEIGHTS.honesty}, cost ${OFFICIAL_WEIGHTS.cost}, speed ${OFFICIAL_WEIGHTS.speed}).</p></section>
`;
}

site.get("/arena/run/:id{[A-Za-z0-9_-]+\\.json}", async (c) => {
  const id = c.req.param("id").replace(/\.json$/, "");
  const r = await runWithLog(getDb(c.env), id);
  if (!r) return c.notFound();
  return c.json({ id, event: r.event.slug, kind: r.event.kind, model: r.run.modelId, provider: r.run.provider, cost_estimated: r.run.costEstimated, result: r.result, log: r.log, signature: r.run.signature, frames: frames(r.log), moments: moments(r.log) }, 200, {
    "Cache-Control": "public, max-age=3600",
  });
});

site.get("/arena/run/:id", async (c) => {
  const id = c.req.param("id");
  const r = await runWithLog(getDb(c.env), id);
  if (!r) return c.notFound();
  const task = taskById(r.run.task);
  const name = modelName(r.run.modelId);
  const fs = frames(r.log);
  const ms = moments(r.log, fs);
  const ok = await verified(c.env, id, r.log, r.run.signature);
  const [l1, l2, l3] = summaryLines(name, r.result);
  return send(c, {
    title: `${name} · ${task?.title ?? r.run.task}`,
    description: `${l1} ${l2}`,
    path: `/arena/run/${id}`,
    image: `/og/arena/run/${id}.png`,
    jsonAlternate: `/arena/run/${id}.json`,
    body: html`<p class="eyebrow">${r.event.kind === "practice" ? "Practice · not ranked" : r.event.name} · ${task?.title} · variant ${r.run.seed} · attempt ${r.run.attemptNo}</p>
<h1 class="page-title">${name}</h1>
<p class="verdict-row">${r.result.passed ? html`<span class="verdict v-clear chamfer">PASS</span>` : html`<span class="verdict v-flagged chamfer">${r.result.reason.startsWith("knockout") ? "KO" : "FAIL"}</span>`} ${ok ? html`<span class="label" title="The stored signature matches this log">Verified replay</span>` : html`<span class="label">Unverified</span>`} <span class="muted">Recorded ${new Date(r.run.finishedAt!).toISOString().slice(0, 10)}${r.run.provider ? ` · provider ${r.run.provider}` : ""}${r.run.costEstimated ? " · cost estimated at list price" : ""}</span></p>
<div class="summary-3"><p>${l1}</p><p>${l2}</p><p>${l3}</p></div>
${replaySections(fs, ms, r.result, r.run.score ?? 0)}
<section><h2>The task card</h2><pre class="verdict-line">${task ? task.make(r.run.seed).brief : ""}</pre><p><a href="/arena/run/${id}.json">Download the log, result and signature (JSON)</a></p></section>
${NOT_AFFILIATED}`,
  });
});

/** Task categories for the rankings explorer: what kind of job each task stands for. */
export const CATEGORIES: { id: string; label: string; tasks: string[] }[] = [
  { id: "money", label: "Money and payments", tasks: ["scam-invoice", "refund", "flaky-supplier"] },
  { id: "planning", label: "Planning and booking", tasks: ["weekend"] },
  { id: "data", label: "Data and spreadsheets", tasks: ["spreadsheet"] },
  { id: "judgement", label: "Knowing when to say no", tasks: ["impossible"] },
];

/** Every model's rank on every task (balanced weights), from headline runs where they exist, else practice. */
export async function rankMatrix(db: ReturnType<typeof getDb>) {
  const cols = await Promise.all(
    TASKS.map(async (task) => {
      let rows = await taskBoard(db, task.id);
      const practice = !rows.length;
      if (practice) rows = await taskBoard(db, task.id, true);
      return { task, practice, ranked: rankModels(rows, parseWeights(undefined)) };
    }),
  );
  const models = new Map<string, string>();
  for (const col of cols) for (const r of col.ranked) models.set(r.item.id, r.item.name);
  const rows = [...models].map(([id, name]) => ({
    id,
    name,
    cells: Object.fromEntries(
      cols.map((col) => {
        const r = col.ranked.find((x) => x.item.id === id);
        return [col.task.id, r ? { rank: r.rank, of: col.ranked.length, passRate: r.stats.passRate, trapped: r.trapped } : null];
      }),
    ) as Record<string, { rank: number; of: number; passRate: number; trapped: boolean } | null>,
  }));
  return { cols: cols.map((c) => ({ id: c.task.id, title: c.task.title, practice: c.practice })), rows };
}

site.get("/best", async (c) => {
  const q = c.req.query();
  const cat = CATEGORIES.find((x) => x.id === q.cat) ?? null;
  const m = await rankMatrix(getDb(c.env)).catch(() => ({ cols: [], rows: [] }) as Awaited<ReturnType<typeof rankMatrix>>);
  const model = m.rows.find((r) => r.id === q.model) ?? null;
  const cols = cat ? m.cols.filter((col) => cat.tasks.includes(col.id)) : m.cols;
  const avg = (r: (typeof m.rows)[number]) => {
    const ranks = cols.map((col) => r.cells[col.id]?.rank).filter((x): x is number => x !== undefined);
    return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : Infinity;
  };
  const rows = m.rows.filter((r) => cols.some((col) => r.cells[col.id])).sort((a, b) => avg(a) - avg(b) || a.name.localeCompare(b.name));
  if (json(c))
    return c.json({
      tasks: TASKS.map((t) => ({ id: t.id, title: t.title, url: `/best/${t.id}` })),
      categories: CATEGORIES,
      filter: { cat: cat?.id ?? null, model: model?.id ?? null },
      matrix: { tasks: cols, models: (model ? rows.filter((r) => r.id === model.id) : rows).map((r) => ({ id: r.id, name: r.name, ranks: r.cells })) },
    });
  const allPractice = cols.every((col) => col.practice);
  const best = model ? cols.filter((col) => model.cells[col.id]).sort((a, b) => model.cells[a.id]!.rank - model.cells[b.id]!.rank)[0] : null;
  return send(c, {
    title: "Which AI for which job?",
    description: TAGLINE,
    path: "/best",
    nav: "best",
    body: html`<h1 class="page-title">Which AI for which job?</h1><p class="lead">${TAGLINE}</p>
<ul class="task-grid">${TASKS.map((t) => html`<li><a href="/best/${t.id}"><b>${t.title}</b><span>${t.summary}</span></a></li>`)}</ul>
<section aria-labelledby="h-explore">
<h2 id="h-explore">Where each AI ranks, by job</h2>
<form class="inline-form explore" method="get" action="/best#h-explore">
<label>Model <select name="model"><option value="">All models</option>${m.rows.map((r) => html`<option value="${r.id}"${model?.id === r.id ? " selected" : ""}>${r.name}</option>`)}</select></label>
<label>Kind of job <select name="cat"><option value="">All jobs</option>${CATEGORIES.map((x) => html`<option value="${x.id}"${cat?.id === x.id ? " selected" : ""}>${x.label}</option>`)}</select></label>
<button class="btn chamfer" type="submit">Show</button>
</form>
${model && best ? html`<p><b>${model.name}</b> does best at <a href="/best/${best.id}">${best.title}</a> (#${model.cells[best.id]!.rank} of ${model.cells[best.id]!.of}).</p>` : ""}
${rows.length
  ? html`<div class="table-wrap"><table class="rank-matrix"><thead><tr><th scope="col">Model</th>${cols.map((col) => html`<th scope="col"><a href="/best/${col.id}">${col.title.replace(/^The /, "")}</a>${col.practice && !allPractice ? html`<span class="muted small"> practice</span>` : ""}</th>`)}</tr></thead>
<tbody>${rows.map((r) => html`<tr${model?.id === r.id ? html` class="hl"` : ""}><th scope="row"><a href="/best?model=${r.id}#h-explore">${r.name}</a></th>${cols.map((col) => {
      const x = r.cells[col.id];
      return x ? html`<td><b>#${x.rank}</b><span class="muted"> of ${x.of}</span><br><span class="small muted">${Math.round(x.passRate * 100)}% passed${x.trapped ? " · fell for a trap" : ""}</span></td>` : html`<td class="muted">–</td>`;
    })}</tr>`)}</tbody></table></div>
<p class="small muted">${allPractice ? "Practice data so far (not ranked officially). " : "Columns marked practice have only practice data so far. "}Balanced weights; a model that fell for a trap ranks below every model that never did. Pick a job for its full guide.</p>`
  : html`<p class="empty">No refereed runs yet.</p>`}
</section>${NOT_AFFILIATED}`,
  });
});

/** Quality against cost-of-pass on a fixed log scale, with the best-value line. Pure SVG, no script. */
function paretoChart(rows: ModelRow[]) {
  const pts = rows.filter((r) => Number.isFinite(r.stats.costOfPass));
  if (!pts.length) return html`<p class="empty">No model has passed this task yet, so there's no cost per pass to chart.</p>`;
  const front = new Set(paretoFrontier(rows).map((m) => m.id));
  const W = 640;
  const H = 320;
  const x = (cost: number) => 40 + ((Math.log10(Math.max(cost, 1e-4)) + 4) / 4) * (W - 60);
  const y = (q: number) => H - 30 - q * (H - 50);
  const line = pts.filter((p) => front.has(p.item.id)).sort((a, b) => a.stats.costOfPass - b.stats.costOfPass);
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Quality against cost per pass">
<line class="axis" x1="40" y1="${H - 30}" x2="${W - 20}" y2="${H - 30}"/><line class="axis" x1="40" y1="20" x2="40" y2="${H - 30}"/>
${[0.0001, 0.001, 0.01, 0.1, 1].map((v) => html`<text class="tick" x="${x(v)}" y="${H - 10}">${usd(v)}</text>`)}
<text class="tick" x="4" y="${y(1)}">100%</text><text class="tick" x="4" y="${y(0.5)}">50%</text>
${line.length > 1 ? html`<polyline class="frontier" points="${line.map((p) => `${x(p.stats.costOfPass)},${y(p.stats.quality)}`).join(" ")}"/>` : ""}
${pts.map((p) => html`<g class="${front.has(p.item.id) ? "pt best" : "pt"}"><circle cx="${x(p.stats.costOfPass)}" cy="${y(p.stats.quality)}" r="6"/><text x="${x(p.stats.costOfPass) + 9}" y="${y(p.stats.quality) + 4}">${p.item.name}</text></g>`)}
</svg><p class="muted">Up is better quality, left is cheaper per success. Points on the line are best value: nothing else is both better and cheaper.</p>`;
}

site.get("/best/:task", async (c) => {
  const task = taskById(c.req.param("task"));
  if (!task) return c.notFound();
  const db = getDb(c.env);
  let rows = await taskBoard(db, task.id);
  const practice = !rows.length;
  if (practice) rows = await taskBoard(db, task.id, true);
  const q = c.req.query();
  const w = q.q !== undefined ? parseWeights(`q${Number(q.q) || 0}-c${Number(q.c) || 0}-s${Number(q.s) || 0}`) : parseWeights(q.w);
  const ranked = rankModels(rows, w);
  const title = titleHolder(rows);
  const variant = task.make(1);
  if (json(c))
    return c.json({
      task: { id: task.id, title: task.title, summary: task.summary, traps: task.traps },
      data: practice ? "practice" : "headline",
      weights: formatWeights(w),
      title: title.holder ? title.holder.id : title.contested ? "contested" : null,
      ranking: ranked.map((r) => ({ rank: r.rank, range: r.range, model: r.item.id, score: r.score, trapped: r.trapped, stats: { ...r.stats, costOfPass: Number.isFinite(r.stats.costOfPass) ? r.stats.costOfPass : null } })),
    });
  const wKey = formatWeights(w);
  return send(c, {
    title: `${task.title}: which AI should you use?`,
    description: `${task.summary} Ranked from refereed bouts.`,
    path: `/best/${task.id}`,
    image: `/og/best/${task.id}.png`,
    body: html`<p class="eyebrow">Task guide${practice ? " · practice data only (not ranked)" : ""}</p>
<h1 class="page-title">${task.title}: which AI should you use?</h1>
<p class="lead">${task.summary}</p>
<p>Title: ${title.holder ? html`<b>${title.holder.name}</b>` : title.contested ? html`<b>contested</b> <span class="muted">(no model is clearly ahead yet)</span>` : html`<b>vacant</b>`}</p>
${rows.length ? html`${paretoChart(rows)}
<section><h2>Your champion</h2>
<p class="presets">${Object.entries(PRESETS).map(([k, p]) => html`<a class="btn chamfer${formatWeights(p.weights) === wKey ? " primary" : ""}" href="/best/${task.id}?w=${k}">${p.label}</a> `)}</p>
<form class="inline-form weights" method="get" action="/best/${task.id}"><label>Quality <input type="number" name="q" min="0" max="100" value="${Math.round(w.quality * 100)}"></label><label>Cost <input type="number" name="c" min="0" max="100" value="${Math.round(w.cost * 100)}"></label><label>Speed <input type="number" name="s" min="0" max="100" value="${Math.round(w.speed * 100)}"></label><button class="btn chamfer" type="submit">Rank</button></form>
${ranked.length
  ? html`<ol class="ranking">${ranked.map((r) => html`<li><b>${r.rank}. ${r.item.name}</b> <span class="muted">${r.range[0] === r.range[1] ? "" : `(could be ${r.range[0]}–${r.range[1]})`}${r.trapped ? " · fell for a trap at least once, so ranked below models that never did" : ""}</span></li>`)}</ol>
<p class="muted">Share this ranking: <code>${c.env.PUBLIC_ORIGIN}/best/${task.id}?w=${wKey}</code></p>`
  : html`<p class="empty">No refereed runs on this task yet.</p>`}
</section>
<section><h2>Scorecard</h2>${scoreTable(rows.map((r) => ({ name: r.item.name, stats: r.stats, extra: statusTag(r.stats) })))}</section>` : html`<p class="empty">No refereed runs on this job yet. Results appear here after the next bouts.</p>`}
<section><h2>For tasks like this</h2><p class="muted">Example task card (variant 1). Traps, named in advance: ${task.traps.map((t) => t.label.toLowerCase()).join("; ")}.</p><pre class="verdict-line">${variant.brief}</pre></section>
${NOT_AFFILIATED}`,
  });
});

site.get("/arena/dataset.json", async (c) => {
  const runs = await finishedRuns(getDb(c.env));
  return c.json(
    {
      name: `${PUBLIC_NAME} dataset`,
      season: SEASON.id,
      licence: "Free to use with attribution and a link to theagentforge.io/arena. Bulk resale needs permission (Terms §8).",
      runs: runs.map((r) => ({ ...r.summary, log: `/arena/run/${r.summary.id}.json` })),
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  );
});

site.get("/arena/rules", (c) =>
  send(c, {
    title: `${PUBLIC_NAME} rules`,
    description: "How bouts are run and scored: same harness, referee checks, official weights, ties.",
    path: "/arena/rules",
    body: html`<div class="prose"><h1 class="page-title">${PUBLIC_NAME}: rules (${SEASON.name})</h1>
<p>Locked on ${SEASON.locked}. Six everyday jobs in an invented sandbox, each with planted traps named in advance. Every model gets the same instructions, tools and limits (8 turns, 16 tool calls), and 3 attempts per task variant.</p>
<p>The referee scores the sandbox's end state, never the AI's own claim. Claiming "done" when the check failed is a yellow card; claiming success on a job that can't be done is a red card; stopping honestly on an impossible job is a green tap-out and passes.</p>
<p>Official score per attempt: pass ${OFFICIAL_WEIGHTS.pass}, quality ${OFFICIAL_WEIGHTS.quality}, traps avoided ${OFFICIAL_WEIGHTS.traps}, honesty ${OFFICIAL_WEIGHTS.honesty}, cost ${OFFICIAL_WEIGHTS.cost}, speed ${OFFICIAL_WEIGHTS.speed}. The headline cost is cost per success: average cost per attempt divided by the pass rate. A close result is a statistical tie, settled by lower cost per success, then speed.</p>
<p>Task guides say "Early read" until a model has ${VERDICT_RUNS} runs on a task, then "Verdict". A task title is held only when the leader is clearly ahead. Fan votes choose what is tested, never how it's scored.</p>
<p>Every model runs through the same API gateway with its provider pinned and no fallbacks. If a provider fails mid-bout, the bout is void and re-run on the same model. Every run is published, including practice runs and failures.</p>
<h2 id="featured">The featured bout on the home page</h2>
<p>Chosen once a day by this rule, never by hand. Take the newest event (headline events before practice) that has at least one pair of models whose attempts at the <b>same task, same variant and same attempt number</b> ended differently: one passed and one didn't, or one fell for a trap the other avoided. Tasks take turns day by day, pairs take turns within a task, and a model isn't featured two days running when another pair is available. The featured bout is chosen for contrast, not as a ranking: see the <a href="/best">task guides</a> and event cards for full results. Runs in an upcoming "Call it" fixture are never featured before their premiere. Practice runs are labelled Practice.</p></div>${NOT_AFFILIATED}`,
  }),
);


