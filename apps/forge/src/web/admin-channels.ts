import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { channelData, type ScoreRow } from "../services/channels";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession } from "./dashboard";
import { send, site } from "./pages";

// ADR 0133: /admin/channels, the channel scoreboard with kill dates, the Sprint share loop and ClawHub install → use.
// Founder admins only, never cached, never indexed; the same data as JSON at /admin/channels.json.

export const CHANNELS_PATH = "/admin/channels";
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

async function isFounder(c: Parameters<typeof currentSession>[0]) {
  const s = await currentSession(c);
  if (!s) return false;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return !!me && isAdmin(c.env, me.githubId);
}

const n = (v: number | null) => (v === null ? "not measurable" : v.toLocaleString("en-US"));
const NOT_YET = "not yet measured";

function row(r: ScoreRow) {
  const w = r.week;
  // A null cell is "not yet measured" when its counter isn't live yet, "not measurable" when the Worker can't see it.
  const cell = (k: keyof ScoreRow["week"]) => (w[k] === null && r.not_yet.includes(k) ? NOT_YET : n(w[k]));
  return html`<tr class="dec-${r.decision.replace(/ /g, "-")}"><td><b>${r.name}</b><br><small>${r.kind} · ${r.status}${r.note ? html` · ${r.note}` : ""}</small>${r.external.length ? html`<br><small>${r.external.map((x) => `${x.value.toLocaleString("en-US")} ${x.unit} (${x.source})`).join("; ")}</small>` : ""}</td>
<td>${r.listed ?? "–"}</td><td>${r.first_seen ?? (r.decision === "not yet measured" ? NOT_YET : r.measurable ? "none yet" : "not measurable")}</td>
<td class="num">${cell("calls")}</td><td class="num">${cell("install_checks")}</td><td class="num">${cell("new_installs")}</td><td class="num">${n(w.sessions)}</td><td class="num">${cell("arrivals")}</td>
<td class="num">${r.decision === "not yet measured" ? NOT_YET : n(r.use_since_listed)}</td><td>${r.review ?? "–"}${r.days_to_review !== null && r.days_to_review > 0 ? html`<br><small>in ${r.days_to_review} days</small>` : ""}</td><td><b>${r.decision}</b></td></tr>`;
}

site.get(`${CHANNELS_PATH}.json`, async (c) => {
  if (!(await isFounder(c))) return c.json({ error: "forbidden" }, 403, NO_STORE);
  return c.json(await channelData(c.env), 200, NO_STORE);
});

site.get(CHANNELS_PATH, async (c) => {
  if (!(await isFounder(c))) return c.redirect("/dashboard");
  const d = await channelData(c.env);
  const loop = d.share_loop;
  const k = (x: typeof loop.week) => (x.k === null ? (x.measured_since ? "no outside Sprint finished in the window" : NOT_YET) : x.k.toFixed(3));
  const su = d.skill_use;
  return send(
    c,
    {
      title: "Channel scoreboard",
      description: "Internal channel scoreboard.",
      path: CHANNELS_PATH,
      noindex: true,
      body: html`<h1 class="page-title">Channel scoreboard</h1>
<p>Full UTC days to ${d.as_of}. Internal only (ADR 0133). Channel list ${d.list.version}, updated ${d.list.updated}, kept in <code>${d.list.file}</code>. <a href="${CHANNELS_PATH}.json">JSON</a> · <a href="/admin/kpis">KPIs</a></p>
<p><small>${d.rule} Bots, directory health checks, monitors, our own probes and House are never counted (ADR 0124).</small></p>
<table class="kpi-table"><thead><tr><th>Channel</th><th>Listed</th><th>First outside use</th><th>Calls (week)</th><th>Install checks (week)</th><th>New installs (week)</th><th>Sessions (week)</th><th>Arrivals (week)</th><th>Use since listed</th><th>Review</th><th>Decision</th></tr></thead>
<tbody>${d.channels.map(row)}</tbody></table>

<h2 id="share-loop">Sprint share loop (k-factor)</h2>
<table class="kpi-table"><tbody>
<tr><td>k, last 7 days (${loop.week.window.from} to ${loop.week.window.to})</td><td><b>${k(loop.week)}</b></td></tr>
<tr><td>k, last 28 days</td><td>${k(loop.four_weeks)}</td></tr>
<tr><td>Runs started from a Sprint result page, 7 days (Sprint · full)</td><td>${loop.week.runs_from_result_page ? `${loop.week.runs_from_result_page.sprint} · ${loop.week.runs_from_result_page.full}` : NOT_YET}</td></tr>
<tr><td>Outside Sprints finished, 7 days</td><td>${loop.week.sprints_finished_outside}</td></tr>
<tr><td>Share-link arrivals (people), 7 days</td><td>${loop.week.share_link_arrivals ?? NOT_YET}</td></tr>
<tr><td>Counted since</td><td>${loop.week.measured_since ?? NOT_YET}</td></tr>
</tbody></table>
<p><small>${loop.week.method}</small></p>

<h2 id="skill-use">ClawHub install → use</h2>
<table class="kpi-table"><thead><tr><th>Skill</th><th>Version</th><th>Endpoint</th><th>Calls (week)</th><th>Calls (all time)</th></tr></thead>
<tbody>${su.lines.length ? su.lines.map((l) => html`<tr><td>${l.skill}</td><td>${l.version}</td><td>${l.endpoint}</td><td class="num">${l.week}</td><td class="num">${l.all_time}</td></tr>`) : html`<tr><td colspan="5">${NOT_YET}: no tagged call yet (the tag ships in skill 1.1.0)</td></tr>`}</tbody></table>
<table class="kpi-table"><thead><tr><th>ClawHub downloads (read by hand)</th><th>Tagged check-before-install calls, same 7 days</th><th>Calls per download</th></tr></thead>
<tbody>${su.downloads.map((x) => html`<tr><td>${x.value.toLocaleString("en-US")} ${x.unit} <small>(${x.source})</small></td><td>${x.tagged_calls_same_week ?? "not measurable (tag not live that week)"}</td><td>${x.calls_per_download ?? "not measurable"}</td></tr>`)}</tbody></table>
<p><small>${su.method}</small></p>
<style>.kpi-table{width:100%;border-collapse:collapse}.kpi-table td,.kpi-table th{border-bottom:1px solid var(--line,#333);padding:.4rem;vertical-align:top;text-align:left}.kpi-table .num{text-align:right}.dec-stop td:last-child{color:#f85149}.dec-keep td:last-child{color:#3fb950}</style>`,
    },
    { cache: false },
  );
});
