import { html } from "hono/html";
import { asOfText, publicNumbers, secondsLeft } from "../services/public-numbers";
import { publicTotals, TOTALS_NOTE } from "../services/public-stats";
import { send, site, SITE_DESCRIPTION } from "./pages";
import { RESULTS_POLICY_PATH } from "./results-policy";
import { organization, orgId } from "./organization";
import { disclosure } from "./components";

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
  // ADR 0116: the one snapshot every page with these totals reads (services/public-numbers.ts).
  const numbers = await publicNumbers(c.env);
  const { work, live } = numbers;
  // Site audit 29 Oct (§3.9): one line with two of those totals, our own test agents included, and a link to /stats.
  const shown = publicTotals(work, live).items.filter((i) => i.value !== null && (i.key === "bouts_refereed" || i.key === "skills_scanned"));
  const strip = shown.length
    ? html`<p data-live-line>${shown.map((i, k) => html`${k ? ", " : ""}<a href="${i.rule_url}"><b>${i.value!.toLocaleString("en-US")}</b> ${i.key === "bouts_refereed" ? "Arena bouts refereed" : i.label}</a>`)} . <a href="/stats">All numbers</a></p>`
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
${disclosure(html`${TOTALS_NOTE} <span data-as-of="${numbers.as_of}">${asOfText(numbers)}</span>`, { href: "/stats/rules", label: "How each is counted" })}` : ""}

<h2 id="investors">Investors and partners</h2>
<p>We're glad to talk to investors, builders and teams the Forge could be part of. Messages go straight to the founder.</p>
<ul class="contact-routes">
${CONTACT_ROUTES.map((r) => html`<li><b>${r.who}.</b> ${r.what} <a href="${mailto(r.to, r.subject, NOTE)}">${r.to}</a></li>`)}
</ul>
<p>What helps: who you are, what you have in mind, and a good time to talk. No NDA needed to start.</p>
<p><b>Agents handling invoices, purchasing or support?</b> We run yours through our traps and send a report, free for the first design partners. <a href="/teams">For teams</a></p>
<h3>For a first look</h3>
<ul>
<li><b>Read:</b> <a href="/dataset">the dataset spec</a> (what the data holds, its formats and licence, and what a buyer receives), <a href="/reports/state-of-agent-reliability/2026-q4">The State of Agent Reliability, Edition 1</a> (<a href="/reports/state-of-agent-reliability/2026-q4.pdf">PDF</a>) and <a href="/security">the security overview</a>.</li>
<li><b>Verify:</b> <a href="https://github.com/theagentforge/agent-forge">the code</a>, including the referee and the Arena's jobs; <a href="/arena/rules">the rules</a>; <a href="/methodology">how scores work</a>; <a href="/arena/methodology">the Arena methodology</a>; <a href="/arena/dataset.json">the full bout dataset</a> and <a href="/dataset/sample">the sample dataset</a> (a fixed, checksummed zip with signed replays).</li>
<li><b>Results:</b> <a href="/lab/3/results">Lab #3</a>, the trap card on small open models: 54% fewer traps (<a href="/lab/3">plan</a>). <a href="/lab/4/results">Lab #4</a>, the same card on frontier models: no measurable reduction, and no measurable harm (<a href="/lab/4">plan</a>). <a href="/stats">Live numbers</a>, with every number's counting rule.</li>
</ul>

<h2>Contact</h2>
<p>Everything else: <a href="mailto:hello@theagentforge.io">hello@theagentforge.io</a>.</p>
</article>`,
  }, { maxAge: secondsLeft(numbers) });
});
