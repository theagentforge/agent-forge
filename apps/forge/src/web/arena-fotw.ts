import { PUBLIC_NAME } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { failOfTheWeek, fotwJson, fotwPath, latestFailOfTheWeek, slotForDate, type FailOfTheWeek } from "../arena/fail-of-the-week";
import { formatSlot, nextHeadlineSlot } from "../arena/headline-slot";
import { send, site, wantsJson } from "./pages";

// V4: /arena/fail-of-the-week (the latest pick) and /arena/fail-of-the-week/<Thursday> (each week's, permanent). Neutral
// wording: the referee's facts, the replay, the trap's real-world source. JSON twins (?format=json) are data only.

type Ctx = Context<{ Bindings: Env }>;
const JSON_HEADERS = { "Cache-Control": "public, max-age=300", Vary: "Accept", "X-Content-Type-Options": "nosniff" };

function body(f: FailOfTheWeek, latest: boolean) {
  const replay = `/arena/run/${f.run.id}`;
  return html`<p class="eyebrow"><a href="/arena">${PUBLIC_NAME}</a> · Fail of the Week</p>
<h1 class="page-title">Fail of the Week: ${f.date}</h1>
<p class="lead">${f.card.sentence}, in the weekly headline bout (${f.task.title}, ${f.local}).</p>
<p class="small muted">The referee's verdict was FAIL: a planted trap was sprung. It's one attempt on one seed, picked by the rules below, not a rating of the model.</p>
<dl class="facts">
<dt>Model</dt><dd>${f.run.name}${f.run.lab ? html` <span class="muted">(${f.run.lab})</span>` : ""}</dd>
<dt>Job</dt><dd>${f.task.title} <span class="muted small">variant ${f.run.seed}</span></dd>
<dt>Trap</dt><dd>${f.trap.public_id ? html`<a href="/arena/failures/${f.trap.public_id}"><code>${f.trap.public_id}</code></a> ` : ""}${f.trap.description ?? f.trap.label}${f.more_traps ? html` <span class="muted small">(and ${f.more_traps} more in this attempt)</span>` : ""}</dd>
<dt>Real-world pattern</dt><dd>${f.trap.pattern ?? html`<span class="muted">Not catalogued.</span>`}${f.trap.source ? html`. Source: <a href="${f.trap.source.url}" rel="noopener">${f.trap.source.title}</a>` : html` <span class="muted">No single public source.</span>`}</dd>
<dt>Replay</dt><dd><a href="${replay}">Every call, refereed</a> · Verified replay${f.clip_url ? html` · <a href="${f.clip_url}" rel="noopener">20-second clip</a>` : html` · <a href="${replay}/clip">Clip view</a>`}</dd>
</dl>
<p><a class="btn primary chamfer" href="${replay}">Watch the replay</a></p>
<h2>The whole bout</h2>
<div class="table-wrap"><table class="table stack"><thead><tr><th scope="col">Model</th><th scope="col" class="num">Attempts</th><th scope="col" class="num">Trap sprung</th><th scope="col" class="num">Passed</th></tr></thead>
<tbody>${f.bout.map((b) => html`<tr><td class="wide">${b.name}</td><td class="num" data-label="Attempts">${b.attempts}</td><td class="num" data-label="Trap sprung">${b.fell}</td><td class="num" data-label="Passed">${b.passed}</td></tr>`)}</tbody></table></div>
<p><a href="/arena/event/${f.event.slug}">All attempts in this event</a></p>
<h2 id="rules">How it's picked</h2>
<ul class="small">
<li>From the weekly headline bout, once every attempt is refereed. Only failed attempts where a planted trap was sprung; running out of time or moves never counts.</li>
<li>Frontier models first, then traps with a public real-world source, then better-known models, then money traps, then the earliest attempt.</li>
<li>Only attempts whose replay verifies against its signature. Models under embargo and events held for review are never picked.</li>
<li>Once picked, the week's choice doesn't change.</li>
</ul>
<p class="muted small-print">${latest ? html`This page always shows the latest week; <a href="${fotwPath(f.date)}">this week's permanent link</a>. ` : ""}Next headline bout: ${formatSlot(nextHeadlineSlot(Date.now()))}. Lab and model names identify what was tested; ${PUBLIC_NAME} is not affiliated with any lab. <a href="${fotwPath(f.date)}?format=json">JSON</a></p>`;
}

async function render(c: Ctx, f: FailOfTheWeek | null, latest: boolean, date?: string) {
  const path = latest ? "/arena/fail-of-the-week" : fotwPath(date!);
  if (wantsJson(c)) return f ? c.json(fotwJson(f, c.env.PUBLIC_ORIGIN), 200, JSON_HEADERS) : c.json({ error: "not_found", date: date ?? null, next_bout_at: new Date(nextHeadlineSlot(Date.now())).toISOString() }, 404, JSON_HEADERS);
  if (!f)
    return send(c, {
      title: "Fail of the Week",
      description: "The most notable refereed fail from each weekly headline bout, with its replay and the trap's real-world source.",
      path,
      nav: "arena",
      noindex: true,
      status: 404,
      body: html`<p class="eyebrow"><a href="/arena">${PUBLIC_NAME}</a> · Fail of the Week</p>
<h1 class="page-title">Fail of the Week</h1>
<p class="empty">${date ? `No Fail of the Week for ${date}: the bout isn't fully refereed yet, or no attempt sprang a trap.` : "None yet. It's picked once each weekly headline bout is refereed."}</p>
<p>Next headline bout: ${formatSlot(nextHeadlineSlot(Date.now()))}. <a href="/arena/headline.ics">Add it to your calendar</a>.</p>`,
    });
  return send(c, {
    title: `Fail of the Week, ${f.date}: ${f.card.sentence}`,
    description: `${f.card.sentence} in the weekly headline bout (${f.task.title}). Refereed, with a verified replay and the trap's real-world source.`,
    path,
    nav: "arena",
    image: `/og/arena/run/${f.run.id}.png`,
    jsonAlternate: `${path}?format=json`,
    body: body(f, latest),
  });
}

site.get("/arena/fail-of-the-week", async (c) => render(c, await latestFailOfTheWeek(c.env), true));

site.get("/arena/fail-of-the-week/:date{\\d{4}-\\d{2}-\\d{2}}", async (c) => {
  const date = c.req.param("date");
  const slot = slotForDate(date);
  return render(c, slot === null ? null : await failOfTheWeek(c.env, slot), false, date);
});
