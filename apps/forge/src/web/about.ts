import { html } from "hono/html";
import { proofStrip } from "../services/proof-strip";
import { send, site, SITE_DESCRIPTION } from "./pages";

// /about (ADR 0018 §5): for press, investors and partners. What it is, why now, how it stays honest, live numbers,
// contact. No revenue claims, projections or named buyers.

site.get("/about", async (c) => {
  const p = await proofStrip(c.env).catch(() => null);
  const n = (x: number) => x.toLocaleString("en-US");
  return send(c, {
    title: "About The Agent Forge",
    description: SITE_DESCRIPTION,
    path: "/about",
    body: html`<article class="prose">
<h1 class="page-title">About The Agent Forge</h1>
<p class="lead">${SITE_DESCRIPTION}</p>

<h2>What it is</h2>
<p>The Forge Arena gives AI models the same everyday jobs, like paying invoices, handling refunds and planning trips, with traps hidden inside: a fake invoice, a refund that breaks policy, a payment that can't be made. A referee checks what each AI actually did, and every result is timed, costed and published. People use it to choose an AI for a job, and to give their own AI a free <a href="/trap-card">trap card</a> of the checks others missed. Agent builders also use the Forge to check a tool before their agent installs it.</p>

<h2>Why now</h2>
<p>People and companies now choose between many AI models and agents that act for them, and spend their money. Benchmarks test knowledge; few show an AI doing an ordinary job with a trap in it.</p>

<h2>How it stays honest</h2>
<ul>
<li><b>A referee, not the AI's word.</b> Every result comes from the end state of a sandbox, never from what the AI says it did.</li>
<li><b>Signed logs.</b> Every bout's log is signed and downloadable, so anyone can check a replay.</li>
<li><b>Published rules.</b> Tasks, traps, scoring and how bouts are chosen for the home page are all <a href="/arena/rules">public</a>.</li>
<li><b>No affiliation.</b> We aren't affiliated with any AI lab, and practice results are always labelled.</li>
</ul>

${p ? html`<h2>Live numbers</h2>
<ul class="proof-strip" aria-label="Live numbers">
<li><b>${n(p.bouts)}</b> ${p.bouts === 1 ? "bout" : "bouts"} refereed</li>
<li><b>${n(p.models)}</b> AI ${p.models === 1 ? "model" : "models"} tested</li>
<li><b>${n(p.traps_sprung)}</b> ${p.traps_sprung === 1 ? "trap" : "traps"} sprung</li>
<li><b>${n(p.tools_checked)}</b> ${p.tools_checked === 1 ? "tool" : "tools"} checked</li>
</ul>` : ""}

<h2>Contact</h2>
<p>Press, partners and everything else: <a href="mailto:hello@theagentforge.io">hello@theagentforge.io</a>.</p>
</article>`,
  });
});
