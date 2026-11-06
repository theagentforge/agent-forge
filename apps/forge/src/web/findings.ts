import { buildFindings, SEVERITY_LABEL, type AttemptResult, type Finding, type FindingsResult, type LogEvent } from "@forge/arena";
import { html } from "hono/html";

// ADR 0137: findings (Q1) on public pages and in JSON twins. Always the public scope: private jobs and private traps
// are counted, never named. Findings are data built by code from the referee's record and the trace; the HTML shows
// the same fields.

/** Findings for one stored attempt, or none when it has no result. Never throws: a page shows nothing rather than fail. */
export function attemptFindings(a: { task: string; seed: number; log: unknown; result: unknown }): FindingsResult {
  const result = a.result as AttemptResult | null;
  if (!result?.traps) return { findings: [], withheld: 0 };
  try {
    return buildFindings({ task: a.task, seed: a.seed, log: (a.log as LogEvent[] | null) ?? null, result });
  } catch (e) {
    console.warn("findings_failed", a.task, a.seed, String(e));
    return { findings: [], withheld: result.traps.filter((t) => t.triggered).length };
  }
}

/** The JSON block for a twin or an MCP result (AGENTS.md rule 7: data only). */
export const findingsJson = (fx: FindingsResult) => ({ findings: fx.findings, findings_withheld: fx.withheld, findings_basis: "referee_record_and_trace_only_no_model_text_no_llm" as const });

const sevBadge = (f: Finding) => (f.trap.severity ? html`<span class="label sev sev-${f.trap.severity.severity}" title="${f.trap.severity.reason}">${SEVERITY_LABEL[f.trap.severity.severity]}</span> ` : "");

function findingCard(f: Finding) {
  const ev = f.evidence;
  const c = f.control.check;
  return html`<li class="finding" id="finding-${f.trap.id}"><p>${sevBadge(f)}<a class="mono" href="/arena/methodology#${f.trap.id}">${f.trap.id}</a>: ${f.trap.description}</p>
<dl class="facts">
<dt>What the agent did</dt><dd>${f.act ? html`Step ${f.act.step}: <code>${f.act.tool}</code> <code class="small">${JSON.stringify(f.act.args)}</code>${f.related_acts.map((x) => html`<br>after step ${x.step}: <code>${x.tool}</code> <code class="small">${JSON.stringify(x.args)}</code>`)}` : f.sprung_by === "end_state" ? "No single call: the end state lacked what the procedure required" : "Not determinable from the trace"}</dd>
<dt>How the trap works</dt><dd>${f.mechanism}.</dd>
${ev ? html`<dt>Evidence before the act</dt><dd>${ev.step !== null ? html`${ev.what}, naming <code>${ev.matched}</code>: step ${ev.step} (<code>${ev.tool}</code>)` : html`${ev.what}: ${ev.note ?? "not determinable from the trace"}`}</dd>` : ""}
<dt>Control the procedure called for</dt><dd>${f.control.procedure}. ${c.used_before_act === true ? html`<code>${c.tool_used}</code> used at step ${c.first_step}.` : c.used_before_act === false ? html`Not consulted${c.since_step !== null ? ` after step ${c.since_step}` : ""} (${c.tools.join(", ")}).` : "Not determinable from the trace."}</dd>
<dt>Claimed at the end</dt><dd>${f.claim.finish_status === null ? `No finish (${f.claim.ended})` : f.claim.finish_status === "done" ? "Done" : "Can't be done"}; the referee found the job ${f.claim.referee_passed ? "right" : "not right"}.</dd>
<dt>Fix (${f.fix.category_name})</dt><dd>${f.fix.guardrail}.</dd>
</dl>
<details><summary>Copy for a ticket</summary><pre class="verdict-line">${f.ticket_text}</pre></details></li>`;
}

/** The Findings section of a replay or result page. Empty when nothing was sprung. */
export function findingsSection(fx: FindingsResult, heading = "Findings") {
  if (!fx.findings.length && !fx.withheld) return "";
  return html`<section class="findings" aria-labelledby="h-findings"><h2 id="h-findings">${heading}</h2>
<p class="small muted">Each finding is built by code from the referee's record and the step-by-step trace, from a fixed template per trap: never from what the model wrote, and never by an AI. Where the trace can't show something, it says so. Most severe first (<a href="/arena/methodology#severity">severity scale</a>).</p>
<ol class="findings-list">${fx.findings.map(findingCard)}</ol>
${fx.withheld ? html`<p class="small muted">${fx.withheld} sprung trap${fx.withheld === 1 ? " is" : "s are"} not in the public catalogue, so no finding is shown for ${fx.withheld === 1 ? "it" : "them"}.</p>` : ""}
</section>`;
}
