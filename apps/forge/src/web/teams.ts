import { html } from "hono/html";
import { pricingMode } from "../services/api-keys";
import { send, site } from "./pages";

// /teams (ADR 0023 §7, "Now"): the design-partner offer for teams whose agents sit near invoices, purchasing and
// support queues. Free for the first 3 design partners; paid pilots have published prices (ADR 0096, approved by Dinike).
// The intake form stores nothing: the Privacy Policy says we never store email addresses, so it never posts to our
// server. A few lines in /site.js turn the answers into a prefilled email to partners@; without JavaScript the form's
// own action is that mailto: address (this page's CSP allows it). `?print=1` and a print stylesheet give a one-pager.

export const TEAMS_PATH = "/teams";
export const TEAMS_EMAIL = "partners@theagentforge.io";
export const TEAMS_SUBJECT = "Design partner: trap report for our agent";
export const TEAMS_OFFER = "We run your agent through our trap set and send you a report: what it fell for, by failure mode, with replays.";
export const DESIGN_PARTNER_SLOTS = 3;
export const NOTHING_STORED = "This opens your email app; nothing is sent to or stored by us until you press send.";

export const FRAMEWORKS = ["Claude Code", "Claude Agent SDK", "OpenAI Agents SDK", "LangGraph", "CrewAI", "Custom", "Other"] as const;
export const MCP_ANSWERS = [
  ["yes", "Yes"],
  ["no", "No"],
  ["not_sure", "Not sure"],
] as const;
/** The failure modes a report is grouped by (the Arena's trap types, ADR 0023 §4). */
export const FAILURE_MODES = [
  ["fake_invoice", "Fake or changed-payee invoices"],
  ["prompt_injection", "Hidden instructions (prompt injection)"],
  ["policy_breach", "Policy breaches, such as a refund the rules don't allow"],
  ["double_action", "Doing something twice when a tool is flaky"],
  ["false_success", "Saying a job is done when it isn't"],
] as const;
const WHAT_MAX = 500;

/**
 * B2-13 (build plan 28 Oct; decision 12, ADR 0092; prices ADR 0096). Dinike approved paid pilots on 28 Oct and, at
 * 21:18 that day, publishing their prices. The tiers, the credit-toward-contract line and how to pay all live in this
 * one config: with `tiers` empty, no price, amount, credit or payment text renders anywhere (Money rule). The reasoning
 * and the private MOU are in docs/strategy/pilot-offer-2026-q4.md. Nothing here takes a payment: the invoice is sent by
 * email after the scope is signed.
 */
export interface PilotTier {
  id: "check" | "retest" | "guard";
  name: string;
  /** Whole US dollars. */
  priceUsd: number;
  weeks: number;
  /** Re-runs after the customer's fixes. */
  reRuns: number;
  /** Months of the Forge CI check on one repository. */
  ciMonths: number;
  summary: string;
}
export interface PilotConfig {
  open: boolean;
  /** Published tiers. Empty: no price text anywhere. */
  tiers: readonly PilotTier[];
  /** The credit-toward-contract line; shown only with tiers. */
  credit: string | null;
  /** How to pay; shown only with tiers. */
  payment: string | null;
}
export const PILOT_TIERS: readonly PilotTier[] = [
  { id: "check", name: "Check", priceUsd: 1000, weeks: 2, reRuns: 0, ciMonths: 0, summary: "One run of your agent through the Gauntlet and Hard jobs on fresh private seeds, a written trap report and signed replays." },
  { id: "retest", name: "Fix and re-test", priceUsd: 2500, weeks: 4, reRuns: 2, ciMonths: 0, summary: "Everything in Check, two re-runs on new seeds after your fixes, a before-and-after comparison per trap and one 45-minute results call." },
  { id: "guard", name: "Fix, re-test and guard", priceUsd: 5000, weeks: 8, reRuns: 2, ciMonths: 1, summary: "Everything in Fix and re-test, plus one month of the Forge CI check on one of your repositories and a summary of what it flagged." },
];
export const PILOT_CREDIT = { percent: 100, withinDays: 90 } as const;
export const PILOT_CREDIT_LINE = `${PILOT_CREDIT.percent}% of the pilot fee is credited toward an annual contract signed within ${PILOT_CREDIT.withinDays} days of the final report.`;
export const PILOT_PAYMENT_LINE = "Invoiced in US dollars once the scope is signed; pay by international bank transfer, or by PayPal on request. Work starts once it is paid. No card payments are taken on this site.";
export const PILOT: PilotConfig = { open: true, tiers: PILOT_TIERS, credit: PILOT_CREDIT_LINE, payment: PILOT_PAYMENT_LINE };
export const PILOT_EMAIL = "hello@theagentforge.io";
export const PILOT_SUBJECT = "Paid pilot: trap report for our agent";
export const PILOTS_OPEN_LINE = "Paid pilots are open.";
export const usd = (n: number) => `US$${n.toLocaleString("en-US")}`;
export const pilotTierSubject = (t: PilotTier) => `Paid pilot (${t.name}, ${usd(t.priceUsd)}): trap report for our agent`;
export const pilotMailto = (subject = PILOT_SUBJECT) => `mailto:${PILOT_EMAIL}?subject=${encodeURIComponent(subject)}`;
/** Scope, deliverables, timeline and success criteria: what every pilot has, whatever its size. No money terms. */
export const PILOT_TERMS = {
  scope: "One agent (one endpoint, one configuration), run through the Gauntlet's six jobs and the Hard jobs on fresh private seeds, in our sandbox. Larger pilots add re-runs after your fixes.",
  deliverables: "A written trap report: which traps your agent fell for, where in the run, the sandbox amount at stake (invented money) and what a safe agent did instead, with a signed replay of every run.",
  timeline: "2 to 8 weeks depending on scope, starting once your agent is connected (allow 1 to 2 weeks after signing).",
  success: "Two or three measurable criteria agreed in writing at the start, for example: every job completes and is refereed; each fall is shown in a replay you can verify yourself; the report arrives by an agreed day.",
} as const;

/** The paid-pilot block: nothing when pilots are closed; the prices, credit and payment lines only when tiers are set. */
export function pilotBlock(cfg: PilotConfig, print: boolean) {
  if (!cfg.open) return html``;
  const priced = cfg.tiers.length > 0;
  return html`<h2 id="pilots">Paid pilots</h2>
<p><strong>${PILOTS_OPEN_LINE}</strong> Beyond the free design-partner runs, a pilot is a fixed piece of work with a written scope.${print ? "" : html` <a href="${pilotMailto()}">Ask about a pilot</a> (email ${PILOT_EMAIL}).`}</p>
<ul class="pilot-terms">
<li><b>Scope.</b> ${PILOT_TERMS.scope}</li>
<li><b>Deliverables.</b> ${PILOT_TERMS.deliverables}</li>
<li><b>Timeline.</b> ${PILOT_TERMS.timeline}</li>
<li><b>Success criteria.</b> ${PILOT_TERMS.success}</li>
</ul>
${priced
    ? html`<h3 id="pilot-prices">Prices</h3>
<ul class="pilot-tiers">
${cfg.tiers.map((t) => html`<li data-tier="${t.id}"><b>${t.name}: ${usd(t.priceUsd)}</b>, ${t.weeks} weeks. ${t.summary}${print ? "" : html` <a href="${pilotMailto(pilotTierSubject(t))}">Ask for ${t.name}</a>`}</li>`)}
</ul>
${cfg.credit ? html`<p><b>Credit.</b> ${cfg.credit}</p>` : ""}
${cfg.payment ? html`<p><b>How to pay.</b> ${cfg.payment}</p>` : ""}`
    : ""}
<p class="small muted">A pass is not a certificate that your agent is safe: it means it didn't fall for these traps on these seeds. Your agent runs against our sandbox, never your production systems, and results stay private unless you choose to publish them.${print ? ` Ask: ${PILOT_EMAIL}, subject "${PILOT_SUBJECT}" (name the pilot you want).` : ""}</p>`;
}

const mailto = (body: string) => `mailto:${TEAMS_EMAIL}?subject=${encodeURIComponent(TEAMS_SUBJECT)}&body=${encodeURIComponent(body)}`;
/** The same questions as the form, for the no-JavaScript link and the print version. */
const FIELD_LIST = ["Contact email", "Agent framework", "Can it connect over MCP? (yes / no / not sure)", "What does your agent do?"];
const BLANK_BODY = FIELD_LIST.map((f) => `${f}: `).join("\n") + "\n";

const wantsJson = (q: string | undefined, accept: string | undefined) =>
  q === "json" || (accept ?? "").split(",")[0]?.trim() === "application/json";

site.get(TEAMS_PATH, async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  if (wantsJson(c.req.query("format"), c.req.header("Accept")))
    return c.json(
      {
        offer: {
          service: "trap_set_run",
          deliverable: "report",
          report_contents: ["falls_by_failure_mode", "signed_replays", "rules_version"],
          failure_modes: FAILURE_MODES.map(([id]) => id),
          design_partner_slots: DESIGN_PARTNER_SLOTS,
          price_for_design_partners: 0,
          pricing_after_design_partners: PILOT.open && PILOT.tiers.length ? "paid_pilots" : null,
        },
        requirements: { agent_connects_over_mcp: true, connect_url: `${origin}/connect` },
        not_offered_yet: ["traps_against_your_own_tools"],
        contact: { email: TEAMS_EMAIL, subject: TEAMS_SUBJECT },
        intake: {
          method: "email",
          stored_by_forge: false,
          fields: [
            { name: "email", type: "email", required: true },
            { name: "framework", type: "select", options: FRAMEWORKS },
            { name: "mcp", type: "choice", options: MCP_ANSWERS.map(([v]) => v) },
            { name: "what", type: "text", max_length: WHAT_MAX },
          ],
        },
        rules_url: `${origin}/arena/rules`,
        replays_signed: true,
        affiliated_with_ai_lab: false,
        print_url: `${origin}${TEAMS_PATH}?print=1`,
        paid_pilots: PILOT.open
          ? {
              open: true,
              contact: { email: PILOT_EMAIL, subject: PILOT_SUBJECT },
              scope: PILOT_TERMS.scope,
              deliverables: PILOT_TERMS.deliverables,
              timeline: PILOT_TERMS.timeline,
              success_criteria: PILOT_TERMS.success,
              price_published: PILOT.tiers.length > 0,
              currency: PILOT.tiers.length ? "USD" : null,
              tiers: PILOT.tiers.map((t) => ({ id: t.id, name: t.name, price: t.priceUsd, weeks: t.weeks, re_runs: t.reRuns, ci_months: t.ciMonths, contact_subject: pilotTierSubject(t) })),
              credit_toward_contract: PILOT.tiers.length && PILOT.credit ? { percent: PILOT_CREDIT.percent, within_days_of_final_report: PILOT_CREDIT.withinDays } : null,
              payment: PILOT.tiers.length && PILOT.payment
                ? { invoice_currency: "USD", methods: ["bank_transfer", "paypal_on_request"], starts_after_payment: true, card_payments_on_site: false }
                : null,
            }
          : { open: false },
      },
      200,
      { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff", Vary: "Accept" },
    );
  const print = c.req.query("print") === "1";
  return send(c, {
    title: "For teams: put your agent through our traps",
    description: TEAMS_OFFER + ` Free for the first ${DESIGN_PARTNER_SLOTS} design partners.`,
    path: print ? `${TEAMS_PATH}?print=1` : TEAMS_PATH,
    noindex: print,
    jsonAlternate: `${TEAMS_PATH}?format=json`,
    // Only this page may hand a form to the email app (the no-JavaScript path); nothing posts to our server.
    formAction: ["mailto:"],
    body: html`<article class="prose teams${print ? " print-view" : ""}">
<p class="eyebrow">For teams · design partners</p>
<h1 class="page-title">Put your agent through our traps before it goes live</h1>
<p class="lead">${TEAMS_OFFER}</p>
<p><strong>Free for the first ${DESIGN_PARTNER_SLOTS} design partners.</strong> Paid pilots are agreed in writing before anything costs money.</p>

<h2>Who it's for</h2>
<p>Teams whose agents work near invoices, purchasing, refunds or support queues, where one wrong action costs money or trust.</p>

<h2>What's in the report</h2>
<ul>
<li>What your agent fell for, grouped by failure mode:
<ul>${FAILURE_MODES.map(([, label]) => html`<li>${label}</li>`)}</ul></li>
<li>A signed replay of every bout, so anyone can check it wasn't changed.</li>
<li>The rules version each run used (<a href="/arena/rules">published rules</a>).</li>
</ul>

<h2>What we need from you</h2>
<ul>
<li>Your agent connects over MCP. Most frameworks can: <a href="/connect">how to connect</a>.</li>
<li>A contact email for the report.</li>
</ul>

<h2>What we don't do yet</h2>
<p>We don't run traps against your own tools or MCP servers. They can take real actions, so that first needs your test environment and agreed confidentiality terms.</p>

<h2>How it stays honest</h2>
<ul>
<li>A referee checks what your agent did in a sandbox, never what it says it did.</li>
<li>Signed replays and <a href="/arena/rules">published rules</a>.</li>
<li>We aren't affiliated with any AI lab.</li>
</ul>

${pilotBlock(PILOT, print)}
${!print && pricingMode(c.env) !== "off" ? html`<p class="small">Running checks from CI or at high volume? The API stays free without a key; optional keys and plans with higher limits are on <a href="/pricing">/pricing</a>.</p>` : ""}

<h2 id="apply">Ask for a run</h2>
${print
      ? html`<p>Email <strong>${TEAMS_EMAIL}</strong> with:</p>
<ul>${FIELD_LIST.map((f) => html`<li>${f}</li>`)}</ul>
<p class="small muted">Online: ${origin}${TEAMS_PATH}</p>`
      : html`<form class="stack teams-form" data-teams-form data-mailto="${TEAMS_EMAIL}" data-subject="${TEAMS_SUBJECT}" action="mailto:${TEAMS_EMAIL}?subject=${encodeURIComponent(TEAMS_SUBJECT)}" method="post" enctype="text/plain">
<label for="teams-email">Contact email</label>
<input id="teams-email" type="email" name="email" required autocomplete="email" maxlength="200">
<label for="teams-framework">Agent framework</label>
<select id="teams-framework" name="framework">${FRAMEWORKS.map((f) => html`<option>${f}</option>`)}</select>
<fieldset class="teams-choice"><legend>Can it connect over MCP?</legend>
${MCP_ANSWERS.map(([v, label], i) => html`<label><input type="radio" name="mcp" value="${label}"${i === 2 ? " checked" : ""}> ${label}</label>`)}
</fieldset>
<label for="teams-what">What does your agent do?</label>
<textarea id="teams-what" name="what" maxlength="${WHAT_MAX}" placeholder="For example: pays supplier invoices from a shared inbox"></textarea>
<p class="hint"><strong>${NOTHING_STORED}</strong></p>
<button class="btn primary chamfer" type="submit">Open my email app</button>
<p class="small muted" data-teams-status aria-live="polite"></p>
</form>
<p class="small">Prefer to write it yourself? <a href="${mailto(BLANK_BODY)}">Email ${TEAMS_EMAIL}</a> with the same four answers.</p>`}

<p class="no-print small"><a href="${TEAMS_PATH}?print=1">One-page version</a> · <button class="text-link" type="button" data-print hidden>Print / Save as PDF</button></p>
<p class="print-only small muted">The Agent Forge · ${origin.replace(/^https?:\/\//, "")}${TEAMS_PATH} · ${TEAMS_EMAIL}</p>
</article>`,
  });
});
