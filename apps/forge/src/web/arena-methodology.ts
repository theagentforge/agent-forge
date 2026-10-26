import { ATTEMPTS, CANARY, CANARY_GUID, CHANGELOG, FIRST_STAMPED_RULES, LONGITUDINAL, citation, PUBLIC_NAME, RULES_HISTORY, RULES_VERSION, TASK_VERSIONS, TRAP_CATALOG, TRAP_FAMILIES, type TrapFamily } from "@forge/arena";
import { html } from "hono/html";
import { copyBlock } from "./components";
import { send, site } from "./pages";
import { CROISSANT_PATH } from "./croissant";
import { DATASET_LICENCE, LICENCE_ID, LICENCE_PATH } from "../services/provenance";

// The citable Arena methodology (ADR 0023 §5): how a bout is refereed, the trap catalog with stable public IDs and
// provenance, the versions every result runs under, how to cite it, and a dated changelog. JSON twin: data only.

const fmtDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The structured twin (AGENTS.md rule 7): catalog, versions and citation, no prose. */
export function methodologyData(origin: string) {
  const firstStamped = RULES_HISTORY.findIndex((x) => x.version === FIRST_STAMPED_RULES);
  return {
    name: `${PUBLIC_NAME} methodology`,
    rules_version: RULES_VERSION,
    // version_read_from: how a result's rules version is known. "result_stamp" (rules 0.6 on): the scoring code writes it
    // into the result, so effective_from is the production release, not a cut-off; "finish_time": older versions.
    rules_history: RULES_HISTORY.map((r, i) => ({
      version: r.version,
      date: r.date,
      effective_from: r.from ?? `${r.date}T00:00:00Z`,
      version_read_from: firstStamped !== -1 && i >= firstStamped ? "result_stamp" : "finish_time",
    })),
    task_versions: TASK_VERSIONS.map((v) => ({ version: v.version, date: v.date, effective_from: v.from ?? `${v.date}T00:00:00Z`, tasks: v.tasks })),
    families: Object.fromEntries(Object.entries(TRAP_FAMILIES).map(([k, f]) => [k, { name: f.name, reserved: !TRAP_CATALOG.some((e) => e.family === k) }])),
    catalog: TRAP_CATALOG.map((e) => ({
      id: e.id,
      family: e.family,
      description: e.description,
      provenance: { pattern: e.provenance.pattern, source_title: e.provenance.source?.title ?? null, source_url: e.provenance.source?.url ?? null },
      since: e.since,
      traps: e.traps,
    })),
    citation: citation(origin),
    licence: { id: LICENCE_ID, text: DATASET_LICENCE, url: `${origin}${LICENCE_PATH}`, croissant: `${origin}${CROISSANT_PATH}`, results_policy: `${origin}/results-policy` },
    contamination: {
      canary: CANARY,
      canary_guid: CANARY_GUID,
      canary_in: ["/arena/dataset.json", "/arena/run/:id.json", "/arena/events/:slug.json", "/arena/events/:slug.csv", "/arena/event/:slug?format=json", "/arena/event/:slug/falls?format=json", "/arena/history?format=json", "/arena/run/:id", "/arena/event/:slug", "/arena/history", "/gauntlet/r/:id/:job", "/arena/proving-ground/:id"],
      held_out_seeds_published: false,
      held_out_reported_as: "public_vs_held_out_pass_rate_gap_per_model_per_event",
      longitudinal_panel: { version: LONGITUDINAL.version, tier: "normal", attempts: LONGITUDINAL.attempts, max_bouts_per_model_version: LONGITUDINAL.maxBoutsPerModel, held_out: true },
      history_url: `${origin}/arena/history`,
    },
  };
}

site.get("/arena/methodology", async (c) => {
  const cite = citation(c.env.PUBLIC_ORIGIN);
  if (c.req.query("format") === "json" || (c.req.header("Accept") ?? "").startsWith("application/json"))
    return c.json(methodologyData(c.env.PUBLIC_ORIGIN), 200, { "Cache-Control": "public, max-age=300", Vary: "Accept" });
  const famName = (f: TrapFamily) => TRAP_FAMILIES[f].name;
  const reserved = (Object.keys(TRAP_FAMILIES) as TrapFamily[]).filter((f) => !TRAP_CATALOG.some((e) => e.family === f));
  return send(c, {
    title: `${PUBLIC_NAME} methodology`,
    description: "How Arena bouts are refereed, the trap catalogue with stable IDs and real-world sources, versions, and how to cite results.",
    path: "/arena/methodology",
    jsonAlternate: "/arena/methodology?format=json",
    body: html`<div class="prose"><h1 class="page-title">${PUBLIC_NAME}: methodology</h1>
<p class="lead">Current version: <b>${RULES_VERSION}</b>, tasks ${TASK_VERSIONS.map((v) => v.version).join(", ")}. Every result on the site says which versions it ran under.</p>

<h2 id="refereeing">How a bout is refereed</h2>
<ul>
<li><b>End state, not claims.</b> Each job runs in an invented sandbox (no real companies, people or money). When the model stops, the referee checks what the sandbox actually looks like and the log of every tool call. What the model says it did is only compared with that check, never scored on its own.</li>
<li><b>Traps named in advance.</b> Each job has planted traps, listed below, each modelled on a real fraud or failure pattern. A trap is "sprung" when the end state or the call log shows the model fell for it.</li>
<li><b>Seeds.</b> Each job builds its world from a seed, so the same seed always gives the same world and the same failures. Season events draw their seeds at random when the event is queued and publish them with the results.</li>
<li><b>Attempts.</b> Every model gets ${ATTEMPTS} attempts per variant, with the same prompt, tools and limits. Results say whether a model got the same variant right every time, not just once.</li>
<li><b>Signed logs.</b> Every bout's full log is signed when it finishes. A replay is marked "Verified" only when the stored signature matches a fresh signature over the stored log. Logs are public: <a href="/arena/dataset.json">the dataset</a> lists every run.</li>
</ul>
<p>The scoring weights, caps and tie rules are on the <a href="/arena/rules">rules page</a>.</p>

<h2 id="contamination">Keeping the test clean</h2>
<ul>
<li><b>Held-out seeds.</b> Besides the public job versions, a fixed set of private seeds for every job (Normal and Hard) is never published: no brief, log, replay or clip. When an event also runs them, we publish only each model's pass rate on public against held-out versions, with a 95% interval, on <a href="/arena/history#gap">Arena history</a>. This tests contamination only where the event's public versions were published before it (a model may have been trained on them); versions drawn fresh for the event are unseen too, so there the gap is a check that should be near zero, and each row says which.</li>
<li><b>Model versions over time.</b> Every new model version runs the same frozen, private set of Normal job versions (at most ${LONGITUDINAL.maxBoutsPerModel} bouts), with the exact model string pinned and the run date kept. Pass rates per version are on <a href="/arena/history">Arena history</a>.</li>
<li><b>Canary.</b> Every Arena data file (the dataset, run logs, event files) and every replay page carries this line, so anyone can search a training set for it and see whether our data leaked in: <code>${CANARY}</code></li>
<li>Ranked headline events keep public replays: their seeds are fresh random draws each event.</li>
</ul>

<h2 id="catalog">Trap catalogue</h2>
<p>Every trap has a stable public ID: <code>FA-</code>, a family code, and a number. IDs never change once published; a new trap gets the next number. ${TRAP_CATALOG.length} traps in ${new Set(TRAP_CATALOG.map((e) => e.family)).size} families.${reserved.length ? html` Reserved for traps in a later task version: ${reserved.map((f) => html`<b>${f}</b> (${TRAP_FAMILIES[f].name.toLowerCase()})`)}.` : ""} How often each model falls for each trap is on <a href="/arena/failures">the failure-mode board</a>; the same traps grouped by business task (refunds, payments, bookings, stock, records, truthful "done", permissions) are on <a href="/arena/business">business agent reliability</a>.</p>
<div class="table-wrap"><table class="table stack trap-catalog">
<thead><tr><th scope="col">ID</th><th scope="col">Family</th><th scope="col">Trap</th><th scope="col">Based on (real-world pattern)</th><th scope="col">Since</th></tr></thead>
<tbody>${TRAP_CATALOG.map(
      (e) => html`<tr id="${e.id}"><td data-label="ID"><a href="/arena/failures/${e.id}"><code>${e.id}</code></a></td><td data-label="Family">${famName(e.family)}</td><td data-label="Trap">${e.description}</td><td data-label="Models">${e.provenance.pattern}. ${e.provenance.source ? html`<a href="${e.provenance.source.url}" rel="noopener">${e.provenance.source.title}</a>` : html`<span class="muted">No single public source.</span>`}</td><td data-label="Since">${e.since}</td></tr>`,
    )}</tbody></table></div>

<h2 id="versions">Versions</h2>
<p>Two version numbers go with every result: the <b>rules</b> (the referee, harness, limits and scoring) and the <b>task version</b> of the job. A bout page shows them as, for example, "Rules 0.3 · Hard v3", and each row of <a href="/arena/dataset.json">the dataset</a> has <code>rules_version</code>, <code>task_version</code> and the public IDs of the traps it sprang.</p>
<ul>${TASK_VERSIONS.map((v) => html`<li><b>${v.version}</b> (${fmtDate(v.date)}): ${v.tasks.map((t) => html`<code>${t}</code>`).reduce((a, b) => html`${a}, ${b}`)}</li>`)}</ul>

<h2 id="cite">How to cite</h2>
<dl class="facts"><dt>Title</dt><dd>${cite.title}</dd><dt>Version</dt><dd>${cite.version}</dd><dt>Date</dt><dd>${fmtDate(cite.date)}</dd><dt>URL</dt><dd><a href="${cite.url}">${cite.url}</a></dd></dl>
<p>Plain citation:</p>
${copyBlock("cite-text", cite.text)}
<p>BibTeX:</p>
<pre class="verdict-line" id="cite-bibtex">${cite.bibtex}</pre>
<p class="muted">Cite a single trap by its ID and this page, for example "FA-PAY-002, ${cite.title} (${RULES_VERSION})". Data from <a href="/arena/dataset.json">the dataset</a> is free to use for evaluation, research and reporting, with attribution (<a href="#licence">licence</a>).</p>

<h2 id="licence">Data licence and provenance</h2>
<p>${DATASET_LICENCE}</p>
<ul>
<li><b>Allowed:</b> evaluating and comparing models and agents, research, journalism and reports, with a link to theagentforge.io/arena.</li>
<li><b>Not allowed:</b> training or fine-tuning AI models on the dataset, the event files or the run logs.</li>
<li><b>Model outputs:</b> the run logs contain what each model wrote. Those outputs stay subject to the terms of the company that made or served the model.</li>
</ul>
<p>Every row of <a href="/arena/dataset.json">the dataset</a>, every event file and every run log carries a <code>provenance</code> block: where the record came from (a bout we ran ourselves), the exact model id and the lab that makes it, the provider that served it, the run date, the Terms and Privacy versions in force on that date, and the licence id <code>${LICENCE_ID}</code>. A machine-readable description of the dataset (MLCommons Croissant 1.0 with its Responsible AI fields) is at <a href="${CROISSANT_PATH}">${CROISSANT_PATH}</a>. How we publish results that name a model or its maker: the <a href="/results-policy">results policy</a>.</p>

<h2 id="changelog">Changelog</h2>
<ul class="changelog">${[...CHANGELOG].reverse().map((x) => html`<li><time datetime="${x.date}">${fmtDate(x.date)}</time> · <b>${x.version}</b>: ${x.change}</li>`)}</ul>
</div>`,
  });
});
