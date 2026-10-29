import { HARD3_2_TASKS, HARD3_TASKS, HARD_TASKS, RULES_0_6_TASKS, RULES_VERSION, TASKS } from "@forge/arena";
import { eq, inArray } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { ALL_EVENTS, applyJobFor, approveApply, approves, gridRows, RESCORE_APPROVAL_KEY, RESCORE_JOB_KEY, RESCORE_REPORT_KEY, type RescoreApproval, type RescoreJob, type RescoreReport } from "../arena/rescore-job";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site, wantsJson } from "./pages";
import { csrfToken } from "./session";

// /admin/arena-rescore (rules 0.6): which stored, published runs' verdicts the rules in force now would change. One
// button starts a DRY re-score of every event's published (not held-out) runs of the jobs rules 0.6 touched; the
// cron's re-score tick works through it (40 runs every 5 minutes) and writes a report: counts by event and by model,
// and the run ids. B2-01 (ADR 0088): a second dry button covers every public job (the F-04 scope), the report shows a
// full before/after grid per model and job, and apply is two deliberate steps after a finished dry report: "Approve"
// records the admin's approval of exactly that report's scope in KV (`arena:rescore:apply-approved`), then "Start the
// apply re-score" queues it. The cron refuses any apply job without a matching approval. Admins only.

const page = { title: "Re-score report", description: "Which stored runs the current rules would score differently.", path: "/admin/arena-rescore", noindex: true };

/** The dry job this page starts: every event, published runs only, the jobs whose referee rules 0.6 changed. */
export const RULES_0_6_DRY_JOB: RescoreJob = { events: [ALL_EVENTS], mode: "dry", tasks: [...RULES_0_6_TASKS], publicOnly: true };
/** Every public job (Normal, Hard v2, Hard v3.1, Hard v3.2): the F-04 dry run's scope, and the one B2-01 applies. */
export const PUBLIC_TASK_IDS = [...TASKS, ...HARD_TASKS, ...HARD3_TASKS, ...HARD3_2_TASKS].map((x) => x.id);
export const ALL_PUBLIC_DRY_JOB: RescoreJob = { events: [ALL_EVENTS], mode: "dry", tasks: PUBLIC_TASK_IDS, publicOnly: true };

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

/** The report, grouped for reading: each event's slug and name, each model, and the changed run ids under them. */
export async function rescoreSummary(env: Env) {
  const report = await env.KV.get<RescoreReport>(RESCORE_REPORT_KEY, "json");
  const job = await env.KV.get<RescoreJob>(RESCORE_JOB_KEY, "json");
  const approval = await env.KV.get<RescoreApproval>(RESCORE_APPROVAL_KEY, "json");
  // The approval stands only for the dry report it was given on, while that report is still the latest.
  const approvalCurrent = !!approval && !!report && report.mode === "dry" && report.done && approval.dry_report_at === report.updatedAt;
  const gate = {
    running_job: job ? job.mode : null,
    // A report from code before B2-01 (no grid, no exclusions) can't be approved: start a new dry run.
    can_approve: !job && !!report && report.mode === "dry" && report.done && !!report.publicOnly && report.rules === RULES_VERSION && !!report.grid && !!report.excluded && !approvalCurrent,
    approval: approval ? { by: approval.by, at: approval.at, dry_report_at: approval.dry_report_at, dry: approval.dry, scope: approval.scope, current: approvalCurrent } : null,
    can_apply: !job && approvalCurrent,
  };
  if (!report) return { running: !!job, gate, report: null };
  const ids = Object.keys(report.byEvent ?? {});
  const events = ids.length ? await getDb(env).select({ id: t.arenaEvents.id, slug: t.arenaEvents.slug, name: t.arenaEvents.name, kind: t.arenaEvents.kind }).from(t.arenaEvents).where(inArray(t.arenaEvents.id, ids.slice(0, 90))) : [];
  const ev = new Map(events.map((e) => [e.id, e]));
  return {
    running: !!job,
    gate,
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
      excluded: report.excluded ?? [],
      relabelled: report.relabelled ?? 0,
      // B2-01: every model × job checked, before and after (falls = attempts with at least one trap sprung).
      grid: gridRows(report),
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
${notice[c.req.query("r") ?? ""] ? html`<p class="notice">${notice[c.req.query("r")!]}</p>` : ""}
${sum.running
        ? html`<p><b>Running</b> (${sum.gate.running_job}).</p>`
        : html`<form method="post" action="/admin/arena-rescore"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="dry"><button class="btn chamfer" type="submit">Start a dry re-score</button> <span class="muted small">the jobs ${RULES_VERSION} changed</span></form>
<form method="post" action="/admin/arena-rescore"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="dry-all"><button class="btn chamfer" type="submit">Start a dry re-score of every public job</button></form>`}
<h2>Apply (changes stored results)</h2>
<p>Applying re-labels every faithful run the dry report covered as "scored under ${RULES_VERSION}, re-scored from the signed log (played under rules 0.x)" and stores the new verdict where it changed. The original rules stamp, the signed log and the replay seal are kept. Re-scored runs are always shown apart from runs played under ${RULES_VERSION}. Hard v3 runs played before rules 0.3, held events, held-out runs and runs that can't be replayed exactly are never changed.</p>
${sum.gate.approval ? html`<p>Approved by ${sum.gate.approval.by} at ${sum.gate.approval.at} for the dry report of ${sum.gate.approval.dry_report_at} (${sum.gate.approval.dry.checked} checked, ${sum.gate.approval.dry.changed} would change, ${sum.gate.approval.dry.errors} errors: never changed)${sum.gate.approval.current ? "" : html` <b>(no longer the latest dry report: approve again)</b>`}.</p>` : html`<p>Not approved.</p>`}
${sum.gate.can_approve ? html`<form method="post" action="/admin/arena-rescore"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="approve"><button class="btn chamfer" type="submit">Approve apply: I have read these dry counts</button></form>` : ""}
${sum.gate.can_apply ? html`<form method="post" action="/admin/arena-rescore"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="apply"><button class="btn chamfer" type="submit">Start the apply re-score</button></form>` : ""}
${r
        ? html`<h2>Last report</h2>
<p>${r.rules} · ${r.mode} · ${r.done ? "finished" : "in progress"} · updated ${r.updated_at} · ${r.checked} runs checked, ${r.changed} would change, ${r.unfaithful.length} not faithful (not changed), ${r.errors.length} errors. JSON: <a href="/admin/arena-rescore?format=json">?format=json</a>.</p>
<h3>By event</h3>
<table><thead><tr><th>Event</th><th>Checked</th><th>Would change</th><th>Pass to fail</th><th>Fail to pass</th><th>Run ids</th></tr></thead><tbody>${r.by_event.map((e) => row(e.slug ?? e.event, e))}</tbody></table>
<h3>By model</h3>
<table><thead><tr><th>Model</th><th>Checked</th><th>Would change</th><th>Pass to fail</th><th>Fail to pass</th><th>Run ids</th></tr></thead><tbody>${r.by_model.map((m) => row(m.model, m))}</tbody></table>
<h3>Before and after, every model and job</h3>
<p class="small muted">Falls: attempts with at least one trap sprung. Runs that can't be replayed exactly, and runs refused (Hard v3 before rules 0.3), keep their stored verdict on both sides. ${r.excluded.length} excluded, ${r.unfaithful.length} not faithful${r.mode === "apply" ? `, ${r.relabelled} re-labelled` : ""}.</p>
<table><thead><tr><th>Model</th><th>Job</th><th>Runs</th><th>Re-scored</th><th>Passes before</th><th>Passes after</th><th>Falls before</th><th>Falls after</th><th>Changed</th><th>Not faithful</th><th>Excluded</th><th>Played under</th></tr></thead><tbody>${r.grid.map((g) => html`<tr><td>${g.model}</td><td>${g.task}</td><td>${g.runs}</td><td>${g.rescored}</td><td>${g.before.passes}</td><td>${g.after.passes}</td><td>${g.before.falls}</td><td>${g.after.falls}</td><td>${g.changed}</td><td>${g.unfaithful}</td><td>${g.excluded}</td><td>${Object.entries(g.played_under).map(([v, n]) => `${v}: ${n}`).join("; ")}</td></tr>`)}</tbody></table>`
        : html`<p>No report yet.</p>`}`,
    },
    { cache: false },
  );
});

const notice: Record<string, string> = {
  approved: "Approved. Press \"Start the apply re-score\" to apply it.",
  not_approved: "Not approved: there is no finished dry report of published runs under the rules in force (or a job is running).",
  applying: "Apply started. The 5-minute arena tick works through it; reload to see progress.",
  no_approval: "Not started: apply needs an approval of the latest finished dry report.",
  busy: "Not started: a re-score job is already running.",
};

site.post("/admin/arena-rescore", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const action = String(g.form.get("action") ?? "dry");
  const busy = !!(await c.env.KV.get(RESCORE_JOB_KEY));
  if (action === "approve") {
    const a = busy ? null : await approveApply(c.env, `admin:${g.session.h}`);
    console.log("arena_rescore_approve", JSON.stringify({ by: g.session.h, ok: !!a }));
    return c.redirect(`/admin/arena-rescore?r=${a ? "approved" : "not_approved"}`);
  }
  if (action === "apply") {
    if (busy) return c.redirect("/admin/arena-rescore?r=busy");
    const sum = await rescoreSummary(c.env);
    const job = await applyJobFor(c.env);
    if (!sum.gate.can_apply || !job || !approves(await c.env.KV.get<RescoreApproval>(RESCORE_APPROVAL_KEY, "json"), job)) return c.redirect("/admin/arena-rescore?r=no_approval");
    await c.env.KV.put(RESCORE_JOB_KEY, JSON.stringify(job));
    console.log("arena_rescore_apply", JSON.stringify({ by: g.session.h, ...job }));
    return c.redirect("/admin/arena-rescore?r=applying");
  }
  // A dry job, never over a job already running (an apply job included).
  const dry = action === "dry-all" ? ALL_PUBLIC_DRY_JOB : RULES_0_6_DRY_JOB;
  if (busy) return c.redirect("/admin/arena-rescore?r=busy");
  // A new dry report replaces the one any approval was given on.
  await c.env.KV.delete(RESCORE_APPROVAL_KEY);
  await c.env.KV.put(RESCORE_JOB_KEY, JSON.stringify(dry));
  console.log("arena_rescore_start", JSON.stringify({ by: g.session.h, ...dry }));
  return c.redirect("/admin/arena-rescore?r=started");
});
