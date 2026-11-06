import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { calibrationReport, calibrationRun, requeueVoid, type CalRate } from "../arena/frontier-calibration";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site, wantsJson } from "./pages";
import { csrfToken } from "./session";

// /admin/frontier-calibration (ADR 0139 Amendment 1): the frontier tier's calibration read-out. Every frontier-cal-*
// event's runs (with void reasons and a link to each run's full log), and per trap the pooled Opus + Sonnet fall rate
// with its Wilson 95% interval, the per-model rates and the band decision computed by the pre-declared rule. Founder
// admins only (ADMIN_GITHUB_IDS), never cached or indexed. Calibration results are internal: never published.

const PATH = "/admin/frontier-calibration";
const page = { title: "Frontier calibration", description: "Frontier tier calibration runs and band decisions (internal).", path: PATH, noindex: true };
const PRIVATE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } as const;

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const rateCell = (r: CalRate) => (r.n ? html`${r.fell}/${r.n} (${pct(r.rate)})<br><span class="small muted">95% ${pct(r.ci_95![0])}–${pct(r.ci_95![1])}</span>` : html`<span class="muted">not yet measured</span>`);
const noStore = (res: Response) => {
  res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
  res.headers.set("X-Robots-Tag", "noindex");
  return res;
};

site.get(PATH, async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const rep = await calibrationReport(getDb(c.env));
  if (wantsJson(c)) return c.json(rep, 200, PRIVATE);
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const r = c.req.query("r");
  const n = c.req.query("n");
  return noStore(
    await send(
      c,
      {
        ...page,
        body: html`<h1 class="page-title">Frontier calibration</h1>
${r === "requeued" ? html`<p class="notice">Re-queued ${n ?? "0"} void runs.</p>` : r ? html`<p class="notice">Not done: ${r}.</p>` : ""}
<p>Internal (ADR 0139). Held practice events on the published dev seeds; never published as results. Freeze: ${rep.freeze.version}, ${rep.freeze.status}, round ${rep.freeze.round}, <code>${rep.freeze.sha256.slice(0, 16)}</code>. <a href="${PATH}?format=json">JSON</a></p>
<p class="small muted">Rule: pooled ${rep.rule.pool.join(" + ")} fall rate (${rep.rule.rate}) with a Wilson 95% interval; band ${pct(rep.rule.band[0])}–${pct(rep.rule.band[1])}. Below band only when the upper bound is under ${pct(rep.rule.band[0])}; above band only when the lower bound is over ${pct(rep.rule.band[1])}; otherwise no change (Amendment 1, round 1). From round 2 (Amendment 2): at least ${rep.rule.amendment_2.min_n} frontier-pool bouts per trap, else insufficient n; below and above band as before; otherwise in band when the rate itself is inside the band, near band (no change) when it isn't. Reached: ${rep.rule.reached}. ${rep.rule.falls_review_note}</p>
${rep.rounds.length ? "" : html`<p>No frontier-cal-* events yet.</p>`}
${rep.rounds.map(
  (rd) => html`<h2>Round ${rd.round}: traps (rule: ${rd.rule.replace("-", " ")})</h2>
<table><thead><tr><th>Trap</th><th>Frontier pool</th><th>All Claude (record)</th><th>Decision</th><th>By model</th></tr></thead><tbody>${rd.traps.map(
    (x) => html`<tr><td><b>${x.trap}</b><br><code class="small">${x.task}/${x.referee_id}</code></td><td>${rateCell(x.frontier_pool)}</td><td>${rateCell(x.all_claude)}</td><td><b>${x.decision.replace(/_/g, " ")}</b><br><span class="small">${x.action}</span></td><td class="small">${x.by_model.map((m) => html`${m.model_name}${m.in_pool ? "*" : ""}: ${m.n ? `${m.fell}/${m.n} (${pct(m.rate)}, 95% ${pct(m.ci_95![0])}–${pct(m.ci_95![1])})` : "not yet measured"}<br>`)}</td></tr>`,
  )}</tbody></table><p class="small muted">* in the frontier pool.</p>`,
)}
${rep.events.map(
  (e) => html`<h2>${e.name}</h2>
<p><code>${e.slug}</code> · ${e.kind} · ${e.held ? "held" : e.status} · ${e.runs_by_status.done} done, ${e.runs_by_status.queued} queued, ${e.runs_by_status.running} running, ${e.runs_by_status.void} void · cost $${e.cost_usd.toFixed(2)}${e.plan ? html` · planned ${e.plan.planned}, ${e.plan.missing.length} not in the database` : ""}</p>
${e.runs_by_status.void ? html`<form method="post" action="${PATH}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="requeue-void"><input type="hidden" name="slug" value="${e.slug}"><button class="btn chamfer" type="submit">Re-queue ${e.runs_by_status.void} void runs (spends model money; read the void reasons first)</button></form>` : ""}
<table><thead><tr><th>Model</th><th>Job</th><th>Seed</th><th>Try</th><th>Status</th><th>Passed</th><th>Finish</th><th>Traps sprung</th><th>KO</th><th>Cost</th><th>Log</th></tr></thead><tbody>${e.runs.map(
    (x) => html`<tr><td>${x.model_name}</td><td>${x.task}</td><td>${x.seed}</td><td>${x.attempt}</td><td>${x.status}${x.suspended ? " (suspended)" : ""}${x.void_reason ? html`<br><span class="small">${x.void_reason}</span>` : x.last_error ? html`<br><span class="small muted">last error (retry ${x.retries}): ${x.last_error}</span>` : ""}</td><td>${x.passed === null ? "—" : x.passed ? "yes" : "no"}</td><td>${x.finish ? `${x.finish.reason}${x.finish.claim ? ` · ${x.finish.claim}` : ""}` : "—"}</td><td>${x.traps_sprung.join(", ") || "—"}</td><td>${x.knockout === null ? "—" : x.knockout ? "yes" : "no"}</td><td>${x.cost_usd === null ? "—" : `$${x.cost_usd.toFixed(4)}`}</td><td><a href="${x.log}">log</a></td></tr>`,
  )}</tbody></table>`,
)}`,
      },
      { cache: false },
    ),
  );
});

site.post(PATH, async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const action = String(g.form.get("action") ?? "");
  const slug = String(g.form.get("slug") ?? "").slice(0, 64);
  const out = action === "requeue-void" ? await requeueVoid(getDb(c.env), slug) : ({ ok: false, reason: "unknown_action" } as const);
  console.log("frontier_calibration_action", JSON.stringify({ action, slug, by: `admin:${g.session.h}`, ...out }));
  return c.redirect(out.ok ? `${PATH}?r=requeued&n=${out.requeued}` : `${PATH}?r=${out.reason}`);
});

site.get(`${PATH}/run/:id{[A-Za-z0-9_-]+}`, async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const id = c.req.param("id");
  const x = await calibrationRun(getDb(c.env), id);
  if (!x) return c.notFound();
  if (wantsJson(c)) return c.json(x, 200, PRIVATE);
  const brief = x.log.find((e) => e.type === "start");
  return noStore(
    await send(
      c,
      {
        ...page,
        title: `Calibration run ${x.run.id.slice(0, 8)}`,
        path: `${PATH}/run/${x.run.id}`,
        body: html`<p><a href="${PATH}">← Frontier calibration</a></p>
<h1 class="page-title">${x.run.model_name} · ${x.run.task}</h1>
<p><code>${x.event.slug}</code> · seed ${x.run.seed} · attempt ${x.run.attempt} · ${x.run.status}${x.run.void_reason ? ` (void: ${x.run.void_reason})` : ""} · passed ${x.run.passed === null ? "—" : x.run.passed ? "yes" : "no"} · ${x.run.finish ? `${x.run.finish.reason}${x.run.finish.claim ? `, ${x.run.finish.claim}` : ""}, ${x.run.finish.turns} turns, ${x.run.finish.tool_calls} tool calls` : "not finished"} · traps sprung: ${x.run.traps_sprung.join(", ") || "none"} · cost ${x.run.cost_usd === null ? "—" : `$${x.run.cost_usd.toFixed(4)}`} · <a href="${PATH}/run/${x.run.id}?format=json">JSON (result and full log)</a></p>
<p class="small muted">Log: ${x.log_source === "final" ? "the finished bout's log" : x.log_source === "checkpoint" ? "the suspended bout's log so far" : "none stored"}, ${x.log.length} events.</p>
${x.result ? html`<h2>Referee</h2><ul>${x.result.checkpoints.map((cp) => html`<li>${cp.passed ? "✓" : "✕"} ${cp.label}${cp.critical ? "" : " (bonus)"}</li>`)}${x.result.traps.map((tr) => html`<li>${tr.triggered ? "⚠ Fell for" : "✓ Avoided"}: ${tr.label} <code>${tr.id}</code></li>`)}</ul>` : ""}
${brief && brief.type === "start" ? html`<h2>Brief</h2><pre class="verdict-line">${brief.brief}</pre>` : ""}
<h2>Log</h2>
<ol class="small">${x.log.map((e) => html`<li><code>${e.type}</code> ${JSON.stringify(e)}</li>`)}</ol>`,
      },
      { cache: false },
    ),
  );
});
