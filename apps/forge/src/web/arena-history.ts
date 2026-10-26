import { CANARY, LONGITUDINAL, longitudinalPanel, PUBLIC_NAME } from "@forge/arena";
import { html } from "hono/html";
import { GAP_METHOD, heldOutGap, MIN_GAP_ATTEMPTS, weeklyPooledGap, type GapRow, type PooledGapRow } from "../arena/holdout";
import { panelHistory, type PanelPoint } from "../arena/panel";
import { getDb } from "../services/db";
import { send, site } from "./pages";

// /arena/history (ADR 0058): the longitudinal panel (D7), pass rate per model version over time on the same frozen
// held-out job versions, and the public-vs-held-out gap per ranked event (D1). Aggregates only: the held-out seeds,
// briefs and logs are never published. JSON twin: numbers, ids and dates (AGENTS.md rule 7).

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const pp = (x: number) => `${x > 0 ? "+" : ""}${Math.round(x * 100)} pts`;

/** The visible canary line under pages that show Arena data (the head carries it as a comment and meta tag too). */
export const CANARY_LINE = html`<p class="muted small-print canary">${CANARY}</p>`;

const arm = (r: GapRow | PooledGapRow) =>
  r.public_arm === "fresh" ? "public versions new to each event: a check, not a contamination test" : `${r.public_versions_published_before} of ${r.public_versions} public versions published before`;
const cells = (r: GapRow | PooledGapRow) =>
  html`<td class="num" data-label="Public seeds">${pct(r.public.pass_rate)} <span class="muted">(${r.public.passes} of ${r.public.attempts})</span></td><td class="num" data-label="Held-out seeds">${pct(r.held_out.pass_rate)} <span class="muted">(${r.held_out.passes} of ${r.held_out.attempts})</span></td><td class="num" data-label="Gap">${r.gap === null ? html`<span class="muted">not enough bouts yet</span>` : html`${pp(r.gap)} <span class="muted">(${pp(r.gap_ci_95![0])} to ${pp(r.gap_ci_95![1])})</span>`}<br><span class="small muted">${arm(r)}</span></td>`;

/** Weekly headline bouts pooled per model: each has 3 attempts a side, too few alone for a gap. */
function pooledTable(rows: PooledGapRow[]) {
  return html`<h3 id="gap-weekly">Weekly bouts pooled</h3>
<p class="muted">Every weekly headline bout that also ran a private held-out version, added together per model (one bout alone has only a few attempts a side). Same statistics as above.</p>
${rows.length
  ? html`<div class="table-wrap"><table class="table stack"><thead><tr><th scope="col">Model</th><th scope="col" class="num">Weekly bouts</th><th scope="col" class="num">Public seeds</th><th scope="col" class="num">Held-out seeds</th><th scope="col" class="num">Gap</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td data-label="Model">${r.name} <span class="small muted">weekly bouts pooled</span></td><td class="num" data-label="Weekly bouts">${r.events}</td>${cells(r)}</tr>`)}</tbody></table></div>`
  : html`<p class="empty">No weekly bout has run held-out versions yet: not yet measured.</p>`}`;
}

/** The public-vs-held-out table. `standalone`: with its own heading id for /arena/history#gap (and the pooled weekly table). */
export function gapSection(rows: GapRow[], standalone = true, pooled: PooledGapRow[] = []) {
  return html`<section${standalone ? html` id="gap"` : ""}><h2>${standalone ? "Public seeds against held-out seeds" : "Held-out check"}</h2>
<p class="muted">Each model's pass rate on this event's public job versions against fresh private versions of the same jobs that are never published. Only public versions that were published before the event can show training on our data: a model much better on those than on the private ones may have seen them. Versions drawn fresh for the event are unseen too, so there the gap is a check and should be near zero; each row says which. Gap = public minus held-out, with a 95% interval (Newcombe). Under ${MIN_GAP_ATTEMPTS} attempts on either side it says "not enough bouts yet".</p>
${rows.length
  ? html`<div class="table-wrap"><table class="table stack"><thead><tr>${standalone ? html`<th scope="col">Event</th>` : ""}<th scope="col">Model</th><th scope="col" class="num">Public seeds</th><th scope="col" class="num">Held-out seeds</th><th scope="col" class="num">Gap</th></tr></thead>
<tbody>${rows.map(
      (r) => html`<tr>${standalone ? html`<td data-label="Event"><a href="/arena/event/${r.event}">${r.event_name}</a></td>` : ""}<td data-label="Model">${r.name}</td>${cells(r)}</tr>`,
    )}</tbody></table></div>`
  : html`<p class="empty">No ranked event has run held-out seeds yet: not yet measured.</p>`}
${standalone ? pooledTable(pooled) : ""}
</section>`;
}

/** Pass rate (with its interval) against the date of the last panel bout, one point per model version. Pure SVG. */
function historyChart(points: PanelPoint[]) {
  const pts = points.filter((p) => p.pass_rate !== null && p.last_run);
  if (pts.length < 2) return "";
  const W = 640;
  const H = 300;
  const times = pts.map((p) => Date.parse(`${p.last_run}T00:00:00Z`));
  const lo = Math.min(...times);
  const span = Math.max(86_400_000, Math.max(...times) - lo);
  const x = (ms: number) => 50 + ((ms - lo) / span) * (W - 200);
  const y = (v: number) => H - 30 - v * (H - 50);
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Panel pass rate by model version over time">
<line class="axis" x1="50" y1="${H - 30}" x2="${W - 20}" y2="${H - 30}"/><line class="axis" x1="50" y1="20" x2="50" y2="${H - 30}"/>
<text class="tick" x="4" y="${y(1)}">100%</text><text class="tick" x="4" y="${y(0.5)}">50%</text><text class="tick" x="4" y="${y(0)}">0%</text>
${pts.map((p, i) => {
  const cx = x(times[i]!);
  return html`<g class="pt"><line class="axis" x1="${cx}" y1="${y(p.ci_95![0])}" x2="${cx}" y2="${y(p.ci_95![1])}"/><circle cx="${cx}" cy="${y(p.pass_rate!)}" r="5"/><text x="${cx + 8}" y="${y(p.pass_rate!) + 4}">${p.name}</text></g>`;
})}
</svg><p class="muted">Each point is one model version on the panel, placed at its last bout's date; the line through it is its 95% interval.</p>`;
}

/** The structured twin. */
export async function historyData(env: Env, now = Date.now()) {
  const db = getDb(env);
  const [points, gap, pooled] = await Promise.all([panelHistory(db, now), heldOutGap(db, { now }), weeklyPooledGap(db, { now })]);
  return {
    name: `${PUBLIC_NAME} history`,
    canary: CANARY,
    panel: {
      version: LONGITUDINAL.version,
      tier: "normal",
      job_versions: longitudinalPanel().length,
      attempts_per_job_version: LONGITUDINAL.attempts,
      max_bouts_per_model_version: LONGITUDINAL.maxBoutsPerModel,
      held_out: true,
      runs_published: false,
      interval: "wilson_95_passes_div_attempts",
    },
    status: points.some((p) => p.bouts_done > 0) ? "measured" : "not_yet_measured",
    versions: points,
    held_out_gap: { method: GAP_METHOD, rows: gap, weekly_pooled: { label: "weekly bouts pooled", rows: pooled } },
  };
}

site.get("/arena/history", async (c) => {
  const d = await historyData(c.env);
  if (c.req.query("format") === "json" || (c.req.header("Accept") ?? "").startsWith("application/json"))
    return c.json(d, 200, { "Cache-Control": "public, max-age=300", Vary: "Accept", "X-Content-Type-Options": "nosniff" });
  const points = d.versions;
  return send(c, {
    title: "Arena history: model versions over time",
    description: "Pass rates of each model version on the same frozen, private job versions, and public against held-out seeds per event.",
    path: "/arena/history",
    jsonAlternate: "/arena/history?format=json",
    canary: CANARY,
    nav: "arena",
    body: html`<p class="eyebrow">${PUBLIC_NAME}</p><h1 class="page-title">Model versions over time</h1>
<p class="lead">Every new model version gets the same ${d.panel.job_versions} job versions (${LONGITUDINAL.seedsPerJob} of each Normal job, ${LONGITUDINAL.attempts} attempt each), frozen on 26 Oct 2026 and never published, so a change in pass rate is the model changing, not the test.</p>
<section><h2>The panel</h2>
${points.length
  ? html`${historyChart(points)}<div class="table-wrap"><table class="table stack"><thead><tr><th scope="col">Model version</th><th scope="col">Pinned model · provider</th><th scope="col">Run</th><th scope="col" class="num">Passed</th><th scope="col" class="num">Pass rate (95% interval)</th></tr></thead>
<tbody>${points.map(
      (p) => html`<tr><td data-label="Model version">${p.name}${p.served_versions.length && !p.served_versions.every((v) => v === p.pinned_model) ? html`<br><span class="small muted">served as ${p.served_versions.join(", ")}</span>` : ""}</td><td data-label="Pinned"><code>${p.pinned_model}</code> · ${p.provider}</td><td data-label="Run">${p.last_run ?? html`<span class="muted">queued ${p.queued_at}</span>`}${p.status === "in_progress" ? html` <span class="label">in progress</span>` : ""}</td><td class="num" data-label="Passed">${p.passes} of ${p.bouts_done}<span class="muted"> (${p.bouts_planned} planned)</span></td><td class="num" data-label="Pass rate">${p.pass_rate === null ? html`<span class="muted">not yet measured</span>` : html`${pct(p.pass_rate)} <span class="muted">(${pct(p.ci_95![0])}–${pct(p.ci_95![1])})</span>`}</td></tr>`,
    )}</tbody></table></div>
<p class="small muted">${d.panel.job_versions} bouts is a small sample: the intervals are wide, and attempts on the same job are not fully independent. Read a change as real only when the intervals barely overlap.</p>`
  : html`<p class="empty">No model version has run the panel yet: not yet measured.</p>`}
</section>
${gapSection(d.held_out_gap.rows, true, d.held_out_gap.weekly_pooled.rows)}
<p class="small muted">Why private: once a job version is public, a model can be trained on it and score well without getting better at the job. The seeds here are kept off the site and out of <a href="/arena/dataset.json">the dataset</a>; every published Arena file carries a canary line so a leak into training data can be spotted. <a href="/arena/methodology#contamination">Method</a></p>
${CANARY_LINE}`,
  });
});
