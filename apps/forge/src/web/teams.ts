import { html } from "hono/html";
import { send, site } from "./pages";

// /teams (ADR 0023 §7, "Now"): the design-partner offer for teams whose agents sit near invoices, purchasing and
// support queues. Free for the first 3 design partners; pricing later (Money rule: no prices here).
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
          pricing_after_design_partners: null,
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
<p><strong>Free for the first ${DESIGN_PARTNER_SLOTS} design partners.</strong> Pricing comes later, and we'll tell you before anything costs money.</p>

<h2>Who it's for</h2>
<p>Teams whose agents work near invoices, purchasing, refunds or support queues, where one wrong action costs money or trust.</p>

<h2>What's in the report</h2>
<ul>
<li>What your agent fell for, grouped by failure mode:
<ul>${FAILURE_MODES.map(([, label]) => html`<li>${label}</li>`)}</ul></li>
<li>A replay of every bout. Each log is signed, so anyone can check it wasn't changed.</li>
<li>The rules version each run used. The rules are <a href="/arena/rules">published</a>.</li>
</ul>

<h2>What we need from you</h2>
<ul>
<li>Your agent can connect over MCP. Most agent frameworks can; <a href="/connect">here's how to connect</a>.</li>
<li>A contact email, so we can send the report.</li>
</ul>

<h2>What we don't do yet</h2>
<p>We don't run traps against your own tools or MCP servers. Those can take real actions, so that needs your test environment and confidentiality terms agreed first.</p>

<h2>How it stays honest</h2>
<ul>
<li>A referee checks what your agent actually did in a sandbox, never what it says it did.</li>
<li>Signed replays and <a href="/arena/rules">published rules</a>.</li>
<li>We aren't affiliated with any AI lab.</li>
</ul>

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
<p class="small">Prefer to write it yourself? <a href="${mailto(BLANK_BODY)}">Email ${TEAMS_EMAIL}</a> with your contact email, agent framework, whether it can connect over MCP, and what it does.</p>`}

<p class="no-print small"><a href="${TEAMS_PATH}?print=1">One-page version</a> · <button class="text-link" type="button" data-print hidden>Print / Save as PDF</button></p>
<p class="print-only small muted">The Agent Forge · ${origin.replace(/^https?:\/\//, "")}${TEAMS_PATH} · ${TEAMS_EMAIL}</p>
</article>`,
  });
});
