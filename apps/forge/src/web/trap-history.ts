import { html } from "hono/html";
import { DISPUTE_SCOPE_NOTE, errorRecord, REFEREE_AUDIT, trapHistory, validityGate } from "../arena/error-record";
import type { Db } from "../services/db";

// The "Dispute and correction history" section of a trap's page (ADR 0136). Like the whole error record, it shows only
// when the referee audit is complete and resolved (validityGate), and always beside that trap's audit line.

export async function trapHistoryOrNull(db: Db, origin: string, publicId: string) {
  if (!validityGate(REFEREE_AUDIT).ok) return null;
  try {
    const { entries } = await errorRecord(db, origin);
    return { ...trapHistory(entries, publicId), dispute_scope: DISPUTE_SCOPE_NOTE, record: `${origin}/benchmark/validity#error-record` };
  } catch {
    return null;
  }
}

const pct = (x: number | null) => (x === null ? "not measured" : `${(x * 100).toFixed(1)}%`);

export function trapHistorySection(h: Awaited<ReturnType<typeof trapHistoryOrNull>>) {
  if (!h) return html``;
  return html`<h2 id="history">Dispute and correction history</h2>
<p class="small" data-trap-audit>${h.audit ? `Referee audit ${h.audit.audit_id.replace("referee-audit-", "")} (${h.audit.date}): an independent checker agreed with the published verdict on ${h.audit.agree} of ${h.audit.verdicts_checked} sampled verdicts for this trap (${pct(h.audit.agreement)}${h.audit.ci_95 ? `, 95% ${pct(h.audit.ci_95[0])}–${pct(h.audit.ci_95[1])}` : ""}).` : "Not in referee audit 1's sample (no ranked public run of its job versions yet)."} Disputes about this trap: ${h.disputes_about_this_trap}. <span class="muted">${h.dispute_scope}</span></p>
${h.entries.length
  ? html`<ol class="runs">${h.entries.map((e) => html`<li><b>${e.date}</b> · ${e.title} <span class="label">${e.status.replace(/_/g, " ")}</span><br><span class="small">${e.what}</span>${e.runs.map((u) => html` <a class="small" href="${u}">${u.split("/").at(-1)!.slice(0, 8)}</a>`)}</li>`)}</ol>`
  : html`<p class="empty">No correction has touched this trap.</p>`}
<p class="small muted"><a href="/benchmark/validity#error-record">The whole error record</a>, with the referee audit.</p>`;
}
