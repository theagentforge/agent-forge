import { PUBLIC_NAME, trapEntry } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { answerPagePath, answerSentences, arenaAnswer, arenaQuestion, ANSWERS_PATH, ARENA_QUESTIONS, jobTitle, type AnswerSection, type ArenaAnswer, type ArenaQuestion } from "../arena/answers";
import { DATASET_LICENCE } from "../arena/views";
import { LICENCE_PATH } from "../services/provenance";
import { getDb } from "../services/db";
import { markdownResponse } from "./markdown";
import { send, sendJson, site, wantsJson } from "./pages";

// /answers/<question> (citations issue #234): the Arena's everyday jobs, each answered as the question a person asks an
// AI assistant. The answer comes first with its date and sample size, then one table per tier, the method and limits in
// two lines, and links to replays, the event files and the methodology. Numbers are read live from refereed ranked runs
// (embargoed models and held events never count: arena/answers.ts) and edge-cached like every page (web/pages.ts).
// `/answers/<question>.md` is the Markdown twin; `?format=json` the structured one (AGENTS.md rule 7).

type Ctx = Context<{ Bindings: Env }>;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const day = (iso: string) => iso.slice(0, 10);
const forgeOrg = (origin: string) => ({ "@type": "Organization", name: "The Agent Forge", url: `${origin}/about` });

export const METHOD_LINE = "Method: each attempt is one refereed run of an invented everyday job with planted traps; the referee checks the sandbox's end state and call log, never the AI's own words. Intervals are 95% Wilson intervals on passes out of attempts.";
export const LIMITS_LINE = "Limits: a few versions of each job, 3 attempts each, one harness and these model versions only; a knockout (out of time, tokens, turns or tool calls) is counted apart and is not a fall.";

const trapLinks = (ids: { id: string; n: number }[]) =>
  ids.length ? ids.map((x, i) => html`${i ? ", " : ""}<a class="mono" href="/arena/failures/${x.id}" title="${trapEntry(x.id)?.description ?? x.id}">${x.id}</a>${x.n > 1 ? html` <span class="muted">×${x.n}</span>` : ""}`) : html`<span class="muted">none</span>`;

function sectionHtml(q: ArenaQuestion, s: AnswerSection) {
  const kos = s.models.filter((m) => m.knockouts);
  return html`<section aria-labelledby="t-${s.task}"><div class="section-head"><h2 id="t-${s.task}">${s.title}</h2><a class="more" href="/best/${s.task}">Task guide</a></div>
<p class="small muted">${s.tier === "hard" ? `Hard tier (${s.version})` : "Normal tier"} · ${s.attempts} ranked attempts, ${s.since === s.as_of ? s.as_of : `${s.since} to ${s.as_of}`} · events: ${s.events.map((e, i) => html`${i ? ", " : ""}<a href="/arena/event/${e.slug}">${e.name}</a>`)}</p>
<table class="table stack"><thead><tr><th scope="col">Model</th><th scope="col" class="num">Passed</th><th scope="col" class="num">95% interval</th><th scope="col" class="num">${q.column}</th><th scope="col">Traps fallen for</th><th scope="col" class="num">Knockouts</th><th scope="col">Replays</th></tr></thead>
<tbody>${s.models.map(
    (m) => html`<tr><td class="wide">${m.name}</td><td class="num" data-label="Passed">${m.passes} of ${m.attempts}</td><td class="num" data-label="95% interval">${pct(m.ci_95[0])}–${pct(m.ci_95[1])}</td><td class="num" data-label="${q.column}">${m.did} of ${m.attempts}</td><td data-label="Traps fallen for">${trapLinks(m.traps_fell)}</td><td class="num" data-label="Knockouts">${m.knockouts}</td><td data-label="Replays">${m.replays.map((u, i) => html`${i ? " · " : ""}<a href="${u.replace(/^https?:\/\/[^/]+/, "")}">replay ${i + 1}</a>`)}</td></tr>`,
  )}</tbody></table>
<p class="small muted">${q.focus ? html`${q.column}: ${q.did}, as recorded by the referee (${q.focus.map((id, i) => html`${i ? ", " : ""}<a class="mono" href="/arena/failures/${id}">${id}</a>`)}). ` : ""}Knockouts, listed apart from traps: ${kos.length ? kos.map((m, i) => html`${i ? ", " : ""}${m.name} ${m.knockouts}`) : "none"}.</p>
</section>`;
}

function jsonLd(q: ArenaQuestion, a: ArenaAnswer, answer: string, origin: string) {
  const url = `${origin}${answerPagePath(q)}`;
  const events = [...new Map(a.sections.flatMap((s) => s.events).map((e) => [e.slug, e])).values()];
  const times = a.sections.flatMap((s) => [s.since, s.as_of]).filter((x): x is string => !!x).sort();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        url,
        name: q.question,
        ...(a.date_modified ? { dateModified: a.date_modified } : {}),
        publisher: forgeOrg(origin),
        mainEntity: [
          { "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: answer, url: `${url}#answer` } },
          { "@type": "Question", name: `How was "${q.question}" measured?`, acceptedAnswer: { "@type": "Answer", text: `${METHOD_LINE} ${LIMITS_LINE}`, url: `${url}#method` } },
        ],
      },
      {
        "@type": "Dataset",
        "@id": `${url}#data`,
        name: `${q.question} Refereed Arena attempts on ${jobTitle(q)}`,
        description: `Per model: passes out of attempts with a 95% Wilson interval, public trap ids fallen for and knockouts, on ${a.sections.map((s) => s.title).join(", ") || jobTitle(q)} (${a.attempts} ranked attempts).`,
        url,
        ...(a.date_modified ? { dateModified: a.date_modified } : {}),
        ...(times.length ? { temporalCoverage: `${times[0]}/${times.at(-1)}` } : {}),
        isAccessibleForFree: true,
        creator: forgeOrg(origin),
        license: { "@type": "CreativeWork", name: DATASET_LICENCE, url: `${origin}${LICENCE_PATH}` },
        measurementTechnique: METHOD_LINE,
        distribution: [
          { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${url}?format=json` },
          ...events.flatMap((e) => [
            { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: e.json },
            { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: e.csv },
          ]),
        ],
      },
    ],
  };
}

async function answerPage(c: Ctx, q: ArenaQuestion, markdown: boolean) {
  const origin = c.env.PUBLIC_ORIGIN;
  const a = await arenaAnswer(getDb(c.env), q, origin);
  if (wantsJson(c) && !markdown) return sendJson(c, a);
  const answer = answerSentences(q, a);
  const path = answerPagePath(q);
  const events = [...new Map(a.sections.flatMap((s) => s.events).map((e) => [e.slug, e])).values()];
  const traps = q.focus ?? [...new Set(a.sections.flatMap((s) => s.models.flatMap((m) => m.traps_fell.map((x) => x.id))))].sort();
  const res = await send(c, {
    title: q.question,
    description: answer.slice(0, 300),
    path,
    nav: "arena",
    // Nothing published yet: nothing to say, so keep it out of search until there is (ADR 0011).
    noindex: !a.sections.length,
    jsonAlternate: `${path}?format=json`,
    markdownAlternate: `${path}.md`,
    jsonLd: jsonLd(q, a, answer, origin),
    body: html`<p class="eyebrow">Answer from Arena data${a.date_modified ? html` · updated <time datetime="${a.date_modified}">${day(a.date_modified)}</time>` : ""}</p>
<h1 class="page-title">${q.question}</h1>
<p class="lead" id="answer">${answer}</p>
${a.sections.map((s) => sectionHtml(q, s))}
<section aria-labelledby="method"><h2 id="method">Method and limits</h2>
<p class="small">${METHOD_LINE}</p>
<p class="small">${LIMITS_LINE}</p>
</section>
<section aria-labelledby="sources"><h2 id="sources">Sources and data</h2>
<ul class="small">
${events.map((e) => html`<li>${e.name}: <a href="/arena/event/${e.slug}">every model and job</a> · attempts as <a href="/arena/events/${e.slug}.json">JSON</a> and <a href="/arena/events/${e.slug}.csv">CSV</a></li>`)}
<li>This answer as data: <a href="${path}?format=json">JSON</a> · <a href="${path}.md">Markdown</a></li>
<li><a href="/arena/methodology">Arena methodology</a>: refereeing, every trap's public id and real-world source, versions and how to cite</li>
${traps.length ? html`<li>Traps on this page: ${traps.map((id, i) => html`${i ? ", " : ""}<a class="mono" href="/arena/failures/${id}">${id}</a>`)}</li>` : ""}
<li>The same results by kind of business task: <a href="/arena/business">business agent reliability</a></li>
</ul>
<p class="small muted">${DATASET_LICENCE} Lab and model names identify what was tested; ${PUBLIC_NAME} is not affiliated with any lab. <a href="${ANSWERS_PATH}">More questions answered from Arena data</a>.</p>
</section>`,
  });
  return markdown ? markdownResponse(res, `${origin}${path}.md`) : res;
}

site.get(ANSWERS_PATH, async (c) => {
  if (wantsJson(c)) return sendJson(c, { questions: ARENA_QUESTIONS.map((q) => ({ slug: q.slug, question: q.question, job: q.job, focus_traps: q.focus, url: `${c.env.PUBLIC_ORIGIN}${answerPagePath(q)}`, markdown: `${c.env.PUBLIC_ORIGIN}${answerPagePath(q)}.md` })) });
  return send(c, {
    title: "Questions answered from Arena data",
    description: "Everyday questions about AI agents at work, each answered from refereed Arena runs with sample sizes, intervals and replays.",
    path: ANSWERS_PATH,
    nav: "arena",
    jsonAlternate: `${ANSWERS_PATH}?format=json`,
    body: html`<p class="eyebrow">Answers from Arena data</p>
<h1 class="page-title">Questions answered from Arena data</h1>
<p class="lead">Each page answers one question from refereed Arena runs: passes out of attempts per model, 95% intervals, the planted traps fallen for and replays.</p>
<ul>${ARENA_QUESTIONS.map((q) => html`<li><a href="${answerPagePath(q)}">${q.question}</a> <span class="small muted">${jobTitle(q)} · <a href="${answerPagePath(q)}.md">Markdown</a></span></li>`)}</ul>
<p class="small muted"><a href="/best">Which AI for which job?</a> · <a href="/arena/methodology">Methodology</a></p>`,
  });
});

site.get(`${ANSWERS_PATH}/:file{[a-z0-9-]+(?:\\.md)?}`, async (c) => {
  const file = c.req.param("file");
  const markdown = file.endsWith(".md");
  const q = arenaQuestion(markdown ? file.slice(0, -3) : file);
  if (!q) return c.notFound();
  return answerPage(c, q, markdown);
});
