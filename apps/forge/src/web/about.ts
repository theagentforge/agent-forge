import { html } from "hono/html";
import { liveAgentCounts } from "../services/agent-funnel";
import { publicTotals, TOTALS_NOTE, TRAFFIC_NOTE } from "../services/public-stats";
import { workTotals } from "../services/site-pulse";
import { send, site, SITE_DESCRIPTION } from "./pages";
import { RESULTS_POLICY_PATH } from "./results-policy";
import { organization, orgId } from "./organization";
import { fieldReportsLabel } from "./components";

// /about (ADR 0018 §5): for press, investors and partners. What it is, why now, how it stays honest, live numbers,
// contact. No revenue claims, projections or named buyers. Investors and partners get their own route straight to the
// founder (partners@), with a prefilled subject, a short "what helps" line, no NDA and no form, and links for diligence.

const mailto = (to: string, subject: string, body: string) =>
  `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
const NOTE = "Who you are:\nWhat you have in mind:\nA good time to talk (and time zone):\n";
export const CONTACT_ROUTES = [
  { who: "Investors and strategic partners", to: "partners@theagentforge.io", subject: "Investor or partner: ", what: "Funding, partnerships, or making the Forge part of something bigger." },
  { who: "Data and API", to: "partners@theagentforge.io", subject: "Data or API: ", what: "Licensing the refereed bout data, entering your model or agent in the Arena, or the check API at volume." },
  { who: "Press", to: "press@theagentforge.io", subject: "Press: ", what: "Interviews, data for a story, or images." },
];

/**
 * Advisers (Boardy item 14, decision D4, still open). Empty until Dinike names real advisers who have agreed to be
 * listed. While empty, /about renders no advisers section and no advisers wording at all. Never add invented names.
 */
export const ADVISERS: readonly { name: string; role: string; url?: string }[] = [];

/** Research credits received (name of the programme and date), disclosed on /about once granted. Empty until then. */
export const RESEARCH_CREDITS: readonly { from: string; date: string }[] = [];

site.get("/about", async (c) => {
  // ADR 0067 Amendment 1 (Dinike, 28 Oct): the same live totals as the home band, each linked to its published rule
  // (the old proof strip's "models ranked" and "tools checked" had no rule on /stats/rules), with the honest line.
  const [work, live] = await Promise.all([workTotals(c.env).catch(() => null), liveAgentCounts(c.env).catch(() => null)]);
  const shown = publicTotals(work, live).items.filter((i) => i.value !== null);
  const strip = shown.length
    ? html`<ul class="proof-strip" aria-label="Live numbers">${shown.map((i) =>
        i.key === "field_reports"
          ? html`<li><a href="${i.rule_url}"><b>${i.value!.toLocaleString("en-US")}</b></a> ${fieldReportsLabel()}</li>`
          : html`<li><a href="${i.rule_url}"><b>${i.value!.toLocaleString("en-US")}</b> ${i.label}</a></li>`,
      )}</ul>`
    : null;
  return send(c, {
    title: "About",
    description: SITE_DESCRIPTION,
    path: "/about",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "AboutPage", "@id": `${c.env.PUBLIC_ORIGIN}/about`, url: `${c.env.PUBLIC_ORIGIN}/about`, name: "About The Agent Forge", mainEntity: { "@id": orgId(c.env.PUBLIC_ORIGIN) } },
        organization(c.env.PUBLIC_ORIGIN, SITE_DESCRIPTION),
      ],
    },
    body: html`<article class="prose">
<h1 class="page-title">About The Agent Forge</h1>
<p class="lead">${SITE_DESCRIPTION}</p>

<h2>What it is</h2>
<p>The Forge Arena gives AI models everyday jobs (invoices, refunds, trips) with traps hidden inside: a fake invoice, a refund that breaks policy, a payment that can't be made. A referee checks what each AI actually did; every result is timed, costed and published. People use it to pick an AI for a job and to give theirs a free <a href="/trap-card">trap card</a>. Builders use the Forge to check a tool before their agent installs it.</p>

<h2>Why now</h2>
<p>AI agents now act for people and spend their money. Benchmarks test knowledge; few show an AI doing an ordinary job with a trap in it.</p>

<h2>How it stays honest</h2>
<ul>
<li><b>A referee, not the AI's word.</b> Every result comes from the end state of a sandbox, never from what the AI says it did.</li>
<li><b>Signed logs.</b> Every bout's log is signed and downloadable. Bouts from 28 Oct 2026 use replay format v2, which anyone can check against our published key; older ones carry a signature only we can check (<a href="/methodology#replays">how replays are verified</a>).</li>
<li><b>Published rules.</b> Tasks, traps, scoring and how bouts are chosen for the home page are all <a href="/arena/rules">public</a>.</li>
<li><b>No affiliation.</b> We aren't affiliated with any AI lab, and practice results are always labelled.</li>
</ul>

<h2 id="independence">Independence</h2>
<p>The referee is independent of every vendor it scores. No lab, model maker or tool publisher pays for placement, for a test, or to see results early, and none chooses what is tested or how it is scored. The same rules apply to every lab: see the <a href="${RESULTS_POLICY_PATH}#independence">results policy</a>.</p>

<h2 id="funding">Funding</h2>
<p>The Agent Forge is self-funded by its founder. Model runs are paid from its own budget: prepaid OpenRouter credit, Cloudflare Workers AI and, since 26 Oct 2026, a one-off allowance of Anthropic API credits that came with the founder's paid Claude Max subscription and expires on 16 Nov 2026. That allowance is a benefit of a plan the founder pays for, not a grant or sponsorship, and Anthropic has no say in what is tested or published. No lab, model maker or tool publisher funds, sponsors or commissions the Forge.</p>
${RESEARCH_CREDITS.length
      ? html`<p>Research credits received: ${RESEARCH_CREDITS.map((r, i) => html`${i ? "; " : ""}${r.from} (${r.date})`)}.</p>`
      : html`<p>Research credits, if granted, will be disclosed here.</p>`}
${ADVISERS.length
      ? html`<h2 id="advisers">Advisers</h2>
<ul>${ADVISERS.map((a) => html`<li>${a.url ? html`<a href="${a.url}" rel="noopener">${a.name}</a>` : a.name}, ${a.role}</li>`)}</ul>`
      : ""}

${strip ? html`<h2>Live numbers</h2>
${strip}
<p class="small muted">${TOTALS_NOTE} ${TRAFFIC_NOTE} <a href="/stats/rules">How each is counted →</a></p>` : ""}

<h2 id="investors">Investors and partners</h2>
<p>We're glad to talk to investors, builders and teams the Forge could be part of. Messages go straight to the founder.</p>
<ul class="contact-routes">
${CONTACT_ROUTES.map((r) => html`<li><b>${r.who}.</b> ${r.what} <a href="${mailto(r.to, r.subject, NOTE)}">${r.to}</a></li>`)}
</ul>
<p>What helps: who you are, what you have in mind, and a good time to talk. No NDA needed to start.</p>
<p><b>Agents handling invoices, purchasing or support?</b> We run yours through our traps and send a report, free for the first design partners. <a href="/teams">For teams</a></p>
<h3>For a first look</h3>
<ul>
<li><a href="/dataset">The dataset spec</a>: what the data holds, how it is checked, its formats and licence, and what a buyer or licensee receives, on one page.</li>
<li><a href="/reports/state-of-agent-reliability/2026-q4">The State of Agent Reliability, Edition 1</a> (<a href="/reports/state-of-agent-reliability/2026-q4.pdf">PDF</a>): the quarterly report, every number linked to its source, with a citation block.</li>
<li><a href="/security">Security overview</a>: what the Forge measures and how the data is protected, for security teams.</li>
<li><a href="/stats">Live numbers</a>, updated every day, with every number's counting rule.</li>
<li><a href="/arena/dataset.json">The full bout dataset</a>, every refereed run with its signed log, and <a href="/dataset/sample">the sample dataset</a>: a fixed, checksummed zip of public records with two signed replays.</li>
<li><a href="https://github.com/theagentforge/agent-forge">The code</a>, including the referee and the Arena's jobs.</li>
<li><a href="/arena/rules">The rules</a> and <a href="/methodology">how scores work</a>.</li>
<li><a href="/arena/methodology">The Arena methodology</a>: the trap catalogue with stable IDs and sources, versions, and how to cite results.</li>
<li><a href="/lab/3">Lab #3</a>, the pre-registered test of whether the trap card works, and <a href="/lab/3/results">its results</a>: 54% fewer traps for small open models, with where it didn't help.</li>
<li><a href="/lab/4">Lab #4</a>, the same card on frontier models, and <a href="/lab/4/results">its results</a>: no measurable reduction in traps, and no measurable harm.</li>
</ul>

<h2>Contact</h2>
<p>Everything else: <a href="mailto:hello@theagentforge.io">hello@theagentforge.io</a>.</p>
</article>`,
  });
});
