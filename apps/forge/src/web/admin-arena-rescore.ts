import { RULES_0_6_TASKS, RULES_VERSION } from "@forge/arena";
import { eq, inArray } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { ALL_EVENTS, RESCORE_JOB_KEY, RESCORE_REPORT_KEY, type RescoreJob, type RescoreReport } from "../arena/rescore-job";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site, wantsJson } from "./pages";
import { csrfToken } from "./session";

// /admin/arena-rescore (rules 0.6): which stored, published runs' verdicts the rules in force now would change. One
// button starts a DRY re-score of every event's published (not held-out) runs of the jobs rules 0.6 touched; the
// cron's re-score tick works through it (40 runs every 5 minutes) and writes a report: counts by event and by model,
// and the run ids. This page never applies a re-score: apply stays a reviewed KV job (ADR 0049). Admins only.

const page = { title: "Re-score report", description: "Which stored runs the current rules would score differently.", path: "/admin/arena-rescore", noindex: true };

/** The dry job this page starts: every event, published runs only, the jobs whose referee rules 0.6 changed. */
export const RULES_0_6_DRY_JOB: RescoreJob = { events: [ALL_EVENTS], mode: "dry", tasks: [...RULES_0_6_TASKS], publicOnly: true };

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

/** The report, grouped for reading: each event's slug and name, each model, and the changed run ids under them. */
export async function rescoreSummary(env: Env) {
  const report = await env.KV.get<RescoreReport>(RESCORE_REPORT_KEY, "json");
  const job = await env.KV.get<RescoreJob>(RESCORE_JOB_KEY, "json");
  if (!report) return { running: !!job, report: null };
  const ids = Object.keys(report.byEvent ?? {});
  const events = ids.length ? await getDb(env).select({ id: t.arenaEvents.id, slug: t.arenaEvents.slug, name: t.arenaEvents.name, kind: t.arenaEvents.kind }).from(t.arenaEvents).where(inArray(t.arenaEvents.id, ids.slice(0, 90))) : [];
  const ev = new Map(events.map((e) => [e.id, e]));
  return {
    running: !!job,
    report: {
      rules: report.rules,
      mode: report.mode,
      tasks: report.tasks ?? null,
      published_only: !!report.publicOnly,
      done: report.done,
      updated_at: report.updatedAt,
      checked: report.checked,
      changed: report.changed.length,
      by_event: Object.entries(report.byEvent ?? {})
        .map(([id, n]) => ({ event: id, slug: ev.get(id)?.slug ?? null, name: ev.get(id)?.name ?? null, kind: ev.get(id)?.kind ?? null, ...n, runs: report.changed.filter((x) => x.event === id).map((x) => x.id) }))
        .sort((a, b) => b.changed - a.changed || a.event.localeCompare(b.event)),
      by_model: Object.entries(report.byModel ?? {})
        .map(([model, n]) => ({ model, ...n, runs: report.changed.filter((x) => x.model === model).map((x) => x.id) }))
        .sort((a, b) => b.changed - a.changed || a.model.localeCompare(b.model)),
      changed_runs: report.changed.map((x) => ({ id: x.id, event: x.event, model: x.model, task: x.task, attempt: x.attempt, before: x.before, after: x.after, flips: x.flips })),
      unfaithful: report.unfaithful,
      errors: report.errors,
    },
  };
}

site.get("/admin/arena-rescore", async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const sum = await rescoreSummary(c.env);
  if (wantsJson(c)) return c.json(sum, 200, { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const r = sum.report;
  const row = (label: unknown, n: { checked: number; changed: number; toFail: number; toPass: number; runs: string[] }) =>
    html`<tr><td>${label}</td><td>${n.checked}</td><td>${n.changed}</td><td>${n.toFail}</td><td>${n.toPass}</td><td>${n.runs.length ? html`<code>${n.runs.join(" ")}</code>` : ""}</td></tr>`;
  return send(
    c,
    {
      ...page,
      body: html`<h1 class="page-title">Re-score report</h1>
${c.req.query("r") === "started" ? html`<p class="notice">Started. The 5-minute arena tick re-scores 40 runs at a time; reload to see progress.</p>` : ""}
<p>Replays stored runs through the referee in force now (${RULES_VERSION}) and lists the runs whose verdict would change. A dry run only: nothing in any result changes, and the signed logs are never touched. Covers published runs (not held-out) of the jobs ${RULES_VERSION} changed: ${RULES_0_6_TASKS.join(", ")}.</p>
${sum.running
        ? html`<p><b>Running.</b></p>`
        : html`<form method="post" action="/admin/arena-rescore"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Start a dry re-score</button></form>`}
${r
        ? html`<h2>Last report</h2>
<p>${r.rules} · ${r.mode} · ${r.done ? "finished" : "in progress"} · updated ${r.updated_at} · ${r.checked} runs checked, ${r.changed} would change, ${r.unfaithful.length} not faithful (not changed), ${r.errors.length} errors. JSON: <a href="/admin/arena-rescore?format=json">?format=json</a>.</p>
<h3>By event</h3>
<table><thead><tr><th>Event</th><th>Checked</th><th>Would change</th><th>Pass to fail</th><th>Fail to pass</th><th>Run ids</th></tr></thead><tbody>${r.by_event.map((e) => row(e.slug ?? e.event, e))}</tbody></table>
<h3>By model</h3>
<table><thead><tr><th>Model</th><th>Checked</th><th>Would change</th><th>Pass to fail</th><th>Fail to pass</th><th>Run ids</th></tr></thead><tbody>${r.by_model.map((m) => row(m.model, m))}</tbody></table>`
        : html`<p>No report yet.</p>`}`,
    },
    { cache: false },
  );
});

site.post("/admin/arena-rescore", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  // Never over a job already running (an apply job set by hand included).
  if (!(await c.env.KV.get(RESCORE_JOB_KEY))) await c.env.KV.put(RESCORE_JOB_KEY, JSON.stringify(RULES_0_6_DRY_JOB));
  console.log("arena_rescore_start", JSON.stringify({ by: g.session.h, ...RULES_0_6_DRY_JOB }));
  return c.redirect("/admin/arena-rescore?r=started");
});
