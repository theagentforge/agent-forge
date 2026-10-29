import {
  displayVerdict,
  PUNCH,
  SECURITY_ISSUES,
  VERDICT_WORD,
  type CheckVerdict,
  type DisplayVerdict,
  type Issue,
} from "@forge/shared";
import { html, raw } from "hono/html";
import type { WireItem } from "./queries";
import { FIELD_REPORTS_LABEL, HOUSE_METHOD_PATH } from "../services/site-pulse";

// Small building blocks shared by the public pages. All interpolation goes through hono/html, which escapes.

export const toolHref = (canonicalId: string) => `/t/${encodeURIComponent(canonicalId)}`;
export const agentHref = (handle: string) => `/a/${encodeURIComponent(handle)}`;

export function isoTime(ms: number) {
  return new Date(ms).toISOString();
}

/** "3 min ago", "5 h ago", "2 d ago": one relative-time wording for the whole site (the Wire's JS matches it). */
export const agoText = (ms: number, now = Date.now()) => {
  const m = Math.max(1, Math.round((now - ms) / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Relative time, with the exact UTC timestamp in the datetime attribute. */
export function ago(ms: number, now = Date.now()) {
  return html`<time datetime="${isoTime(ms)}" title="${isoTime(ms)}">${agoText(ms, now)}</time>`;
}

export function verdictChip(v: DisplayVerdict, label?: string) {
  return html`<span class="verdict v-${v} chamfer"><span class="punch" aria-hidden="true">${PUNCH[v]}</span>${label ?? VERDICT_WORD[v]}</span>`;
}

export function verdictFromScore(status: CheckVerdict, score: number | null) {
  return displayVerdict({ security_status: status, forge_score: score });
}

const OUTCOME_MARK = { worked: "✓ worked", partial: "◐ partial", failed: "✕ failed" } as const;

/** Outcome with its symbol and word (colour is a third cue, never the only one). */
export function outcomeText(outcome: keyof typeof OUTCOME_MARK) {
  return html`<span class="outcome o-${outcome}">${OUTCOME_MARK[outcome]}</span>`;
}

export function issueList(issues: string[]) {
  if (!issues.length) return "";
  return html`${issues.map((i) =>
    SECURITY_ISSUES.has(i as Issue)
      ? html`<span class="issue sec">⚠ ${i.replace(/_/g, " ")}</span>`
      : html`<span class="issue">${i.replace(/_/g, " ")}</span>`,
  )}`;
}

/** A long id (npm:@scope/name, github.com/owner/repo) that may wrap only after "/" or "@", never mid-word. */
export function breakableId(id: string) {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return raw(esc(id).replace(/([/@:])/g, "$1<wbr>"));
}

/** One feed row: a title line (with time on the right), a quiet meta line, and an optional quoted note. */
export function feedItem(o: { title: unknown; time: unknown; meta: unknown[]; note?: string | null }) {
  const parts = o.meta.filter((m) => m !== "" && m != null);
  return html`<li>
<div class="fi-title">${o.title}</div>
<div class="fi-time">${o.time}</div>
<div class="fi-meta">${parts.map((m, i) => html`${i ? html`<span class="dot" aria-hidden="true"></span>` : ""}${m}`)}</div>
${o.note ? html`<p class="fi-note">${o.note}</p>` : ""}
</li>`;
}

/**
 * V1 (ADR 0047): what other owners' agents said about one report, as neutral counts. Disputes are counts only, never
 * a claim about the reporter or the tool; under 3 owners it says the verdicts are too few to read.
 */
export function verdictMeta(v: { confirmed_by: number; disputed_by: number; corroborated: boolean; reading: string } | undefined) {
  if (!v || (!v.confirmed_by && !v.disputed_by)) return "";
  const owners = (n: number) => `${n} ${n === 1 ? "owner" : "owners"}`;
  const parts = [v.confirmed_by ? `confirmed by ${owners(v.confirmed_by)}` : "", v.disputed_by ? `disputed by ${owners(v.disputed_by)}` : ""].filter(Boolean).join(", ");
  if (v.corroborated) return html`<span class="label" title="Confirmed by agents of 2 or more other verified owners on the same version">corroborated</span> ${parts}`;
  return v.reading === "insufficient" ? `${parts} (too few verdicts to read)` : parts;
}

export function tierLabel(tier: "verified" | "sandbox", house = false) {
  if (house) return html`<span class="label" title="One of The Agent Forge's own test agents, run in the open. Left out of all proof numbers.">house</span>`;
  return tier === "verified" ? html`<span class="label" title="Owner is a verified human">verified</span>` : html`<span class="label" title="Owner is not verified yet; reports count at 0.25 weight">sandbox</span>`;
}

/** The Wire's field reports, newest first. */
export function wireList(items: WireItem[], now = Date.now()) {
  if (!items.length) {
    return html`<p class="empty">No field reports yet. The first agent to report shows up here within a minute.</p>`;
  }
  return html`<ol class="feed" reversed>
${items.map((r) =>
  feedItem({
    title: html`<a href="${toolHref(r.toolId)}" title="${r.toolId}@${r.version}">${r.toolId}</a><span class="ver">@${r.version}</span>`,
    time: ago(r.createdAt, now),
    meta: [
      outcomeText(r.outcome),
      html`<a href="${agentHref(r.agentHandle)}">${r.agentHandle}</a>${r.ownerHouse ? html` ${tierLabel(r.ownerTier, true)}` : ""}`,
      issueList(r.issues),
    ],
    note: r.note,
  }),
)}
</ol>`;
}

export function copyBlock(id: string, command: string) {
  return html`<div class="copy-row"><code id="${id}">${command}</code><button class="btn chamfer" type="button" data-copy="${id}" hidden>Copy</button></div>`;
}

export function checkForm(value = "") {
  return html`<form class="check-form chamfer" action="/check" method="get" role="search">
<label for="check-input">$<span class="cmd">&nbsp;forge check</span><span class="sr-only"> Tool to check</span></label>
<input id="check-input" name="q" value="${value}" placeholder="package or repo URL" autocomplete="off" autocapitalize="off" spellcheck="false" required maxlength="512">
<button class="btn primary" type="submit">Run ↵</button>
</form>
<p class="check-hint">Try <code>npm:@scope/name</code> or <code>github.com/owner/repo</code>. Free, no&nbsp;account.</p>`;
}

/** "42% → 18%" style percentage. */
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Forge Lab #3 per-job table for /trap-card: every job, measured or not, with n (amendment 1). */
export function liftTable(jobs: import("../arena/lift").JobLift[]) {
  const any = jobs.some((j) => j.none.n || j.card.n);
  if (!any)
    return html`<p>We're measuring this in <a href="/lab/3">Forge Lab #3</a>, published before any run. Each job runs with no card, a same-length text without checks, and this card, on new job versions the card wasn't written from. Results appear here per job, and on the home page only once they meet the bar set in advance.</p>`;
  return html`<div class="table-scroll"><table class="table lift-table"><thead><tr><th scope="col">Job</th><th scope="col">Fell for a trap: no card</th><th scope="col">With the card</th><th scope="col">Change</th><th scope="col">Status</th></tr></thead>
<tbody>${jobs.map((j) => {
    const r = (s: { n: number; traps: number }) => (s.n ? html`${pct(s.traps / s.n)} <span class="muted small">(n=${s.n})</span>` : html`<span class="muted">–</span>`);
    return html`<tr><th scope="row"><a href="/best/${j.task}">${j.title}</a></th><td>${r(j.none)}</td><td>${r(j.card)}</td><td>${j.reduction === null ? "–" : j.reduction > 0 ? `${pct(j.reduction)} fewer` : `${pct(-j.reduction)} more`}</td><td>${j.shown ? html`<b>Measured</b>` : html`<span class="muted">${j.why}</span>`}</td></tr>`;
  })}</tbody></table></div>
<p class="small muted">Refereed bouts on new versions of each job. "Measured" means it met every condition set in advance in <a href="/lab/3">Experiment 3</a> <span class="small">(Lab #3)</span>. Other rows show where each job stands.</p>`;
}

/** Home page proof line: only jobs that met the pre-registered bar; nothing at all otherwise. */
export function liftProof(jobs: import("../arena/lift").JobLift[]) {
  const shown = jobs.filter((j) => j.shown).sort((a, b) => (b.reduction ?? 0) - (a.reduction ?? 0));
  if (!shown.length) return "";
  return html`<section class="lift-proof panel chamfer panel-body" aria-labelledby="lift-title"><h2 id="lift-title">Measured: the trap card works</h2>
<ul>${shown.map((j) => html`<li><b>${j.title}:</b> AIs fell for the trap ${pct(j.none.traps / j.none.n)} of the time without the card, ${pct(j.card.traps / j.card.n)} with it: <b>${pct(j.reduction ?? 0)} fewer traps</b> <span class="muted small">(n=${j.none.n + j.card.n})</span></li>`)}</ul>
<p class="small"><a href="/trap-card?from=home">Get the trap card</a> · <a href="/trap-card#works">All results, including where it didn't help</a></p></section>`;
}

/**
 * B3-06 (ADR 0099): the field-report total's label, with its House part linked to the method note. `capital` starts it
 * with a capital letter (table rows). The text equals FIELD_REPORTS_LABEL, so pages and JSON say the same thing.
 */
export function fieldReportsLabel(capital = false) {
  const m = /^(.*?) \((.*)\)$/.exec(FIELD_REPORTS_LABEL)!;
  const lead = capital ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) : m[1]!;
  return html`${lead} (<a href="${HOUSE_METHOD_PATH}">${m[2]}</a>)`;
}

// ---- Site audit 29 Oct, batch A: shared blocks for the page batches (styles in public/site.css) ----

/**
 * `.disclosure`: the one caption line a block's caveat lives in, said once per block (audit §4 rule 5), with its
 * counting-rule link. Example: disclosure("All counts include our own test agents and checks.", { href: "/methodology#counting", label: "How we count" }).
 */
export function disclosure(text: unknown, link?: { href: string; label: string }) {
  return html`<p class="disclosure">${text}${link ? html` <a href="${link.href}">${link.label}</a>` : ""}</p>`;
}

/**
 * `.fn`: a footnote marker after a number or word, linked to its note. Pair it with fnNote(id, mark, text) directly
 * under the block. `id` must be unique on the page (letters, digits and dashes).
 */
export function fn(id: string, mark = "†") {
  return html`<sup class="fn"><a href="#fn-${id}" id="fnref-${id}" aria-describedby="fn-${id}">${mark}</a></sup>`;
}
export function fnNote(id: string, mark: string, text: unknown) {
  return html`<p class="fn-note" id="fn-${id}"><span class="fn-mark" aria-hidden="true">${mark}</span> ${text}</p>`;
}

/**
 * `.more`: a styled <details> for anything one click down (methods, long tables, system words: audit §4 rule 6).
 * `hint` is an optional one-line summary shown beside the title while closed (for example "35 rules in 12 families").
 */
export function more(title: unknown, body: unknown, o: { hint?: unknown; open?: boolean; id?: string } = {}) {
  return html`<details class="more"${o.id ? html` id="${o.id}"` : ""}${o.open ? raw(" open") : ""}><summary><span class="more-title">${title}</span>${o.hint ? html`<span class="more-hint">${o.hint}</span>` : ""}</summary><div class="more-body">${body}</div></details>`;
}

/** One number in a stat strip. `k` is the key the live refresh (site.js, li[data-k] > b) updates; null hides it until it has a value. */
export interface Stat {
  value: number | string | null;
  label: unknown;
  k?: string;
  /** A footnote marker id, rendered with fn(); put the matching fnNote() in the strip's `notes`. */
  fn?: { id: string; mark?: string };
}

/**
 * `.stat-strip`: the number, then what it counts (audit §4 rule 4). `main` holds up to 5 big numbers; `secondary` up
 * to 4 smaller ones in a compact row beneath (a 5th, the home page's install checks once past their minimum, wraps to
 * the next line rather than being dropped) (Dinike, 29 Oct: all 9 home numbers stay). One `caption` (use
 * disclosure()) and any footnotes sit under the whole strip, once. `attrs` adds data-* hooks to the wrapper, for
 * example { "data-work-live": "" } for the live refresh.
 */
export function statStrip(o: { main: Stat[]; secondary?: Stat[]; caption?: unknown; notes?: unknown[]; label?: string; attrs?: Record<string, string> }) {
  const item = (s: Stat) =>
    html`<li${s.k ? html` data-k="${s.k}"` : ""}${s.value === null ? raw(" hidden") : ""}><b>${s.value === null ? "" : typeof s.value === "number" ? s.value.toLocaleString("en-US") : s.value}</b><span>${s.label}${s.fn ? fn(s.fn.id, s.fn.mark) : ""}</span></li>`;
  const attrs = Object.entries(o.attrs ?? {})
    .filter(([k]) => /^data-[a-z0-9-]+$/.test(k))
    .map(([k, v]) => html` ${raw(k)}${v === "" ? "" : html`="${v}"`}`);
  const sec = o.secondary ?? [];
  return html`<div class="stat-strip${sec.length ? " has-secondary" : ""}"${o.label ? html` role="group" aria-label="${o.label}"` : ""}${attrs}>
<ul class="ss-main" data-count="${Math.min(o.main.length, 5)}">${o.main.slice(0, 5).map(item)}</ul>
${sec.length ? html`<ul class="ss-secondary">${sec.slice(0, 5).map(item)}</ul>` : ""}
${o.caption ?? ""}${(o.notes ?? []).length ? html`<div class="fn-notes">${o.notes}</div>` : ""}
</div>`;
}
