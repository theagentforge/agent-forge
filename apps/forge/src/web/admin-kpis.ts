import { and, eq, gte, like } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { dataInventory, growthKpis, PARTNER_STAGES, PARTNERS_KV, CITATIONS_KV, type PartnerContact, type PartnerStage, type Citation, type Kpi } from "../services/kpis";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";
import type { OwnerFunnel } from "../services/owner-funnel";

const measured = (n: number | null) => (n === null ? "not yet measured" : n.toLocaleString("en-US"));

/** ADR 0055: the owner funnel (D11), from a finished Gauntlet run to a verified owner. Internal only. */
function ownerFunnelPanel(f: OwnerFunnel | undefined) {
  if (!f) return "";
  const st = f.stages;
  const rows: [string, number | null][] = [
    ["Gauntlet runs finished", st.runs_finished],
    ["Claim link shown (end-of-run result)", st.claim_link_shown],
    ["Claim page opened (views)", st.claim_page_opened],
    ["Runs claimed (verified owners outside the project)", st.claimed],
    ["Verified owners who claimed", st.verified_owners_claimed],
  ];
  return html`<h2>Owner funnel (D11)</h2>
<p><small>Last ${f.window.days} full UTC days (${f.window.from} to ${f.window.to}). Target: 100 verified owners by 31 Dec, agents per owner close to 1.</small></p>
<table class="kpi-table"><tbody>${rows.map(([k, v]) => html`<tr><td>${k}</td><td>${measured(v)}</td></tr>`)}
<tr><td>Verified owners now (all time)</td><td>${f.verified_owners}</td></tr>
<tr><td>Agents per owner</td><td>${f.agents_per_owner ?? "–"} (${f.verified_agents} agents; ${f.web_claim_profiles} profiles made at claim time)</td></tr>
<tr><td>Season 1 entrants (since ${f.season.starts_at})</td><td>${f.season.entrants} owners, ${f.season.entries} runs</td></tr>
<tr><td>Claim page by source</td><td>${Object.entries(f.claim_page_by_source).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}</td></tr>
<tr><td>Claims on a new profile · refused (not verified)</td><td>${measured(f.claims_on_new_profiles)} · ${measured(f.refused_not_verified)}</td></tr>
</tbody></table>
<ul>${f.notes.map((n) => html`<li><small>${n}</small></li>`)}</ul>`;
}

// /admin/kpis: the twelve growth KPIs (ADR 0039) with their targets and
// 30-day trend, plus two hand-kept lists: citations of our results and partner conversations (organisations only, never
// personal names). Admins only, never cached, never indexed. The same numbers go to Forge Scout and the digest.

const page = { title: "Growth KPIs", description: "Internal growth KPIs.", path: "/admin/kpis", noindex: true };

async function admin(c: Parameters<typeof currentSession>[0], humanId: string) {
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, humanId) });
  return me && isAdmin(c.env, me.githubId) ? me : null;
}

const STATUS_LABEL: Record<Kpi["status"], string> = { below: "below target", first: "first target met", second: "second target met", untracked: "parked" };
const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));

/** A tiny inline bar chart of a daily series (no script, no external assets). */
function spark(values: number[]) {
  const max = Math.max(1, ...values);
  return html`<span class="kpi-spark" aria-hidden="true">${values.map((v) => html`<i style="height:${Math.max(2, Math.round((v / max) * 24))}px"></i>`)}</span>`;
}

site.get("/admin/kpis", async (c) => {
  const s = await currentSession(c);
  if (!s || !(await admin(c, s.session.h))) return c.redirect("/dashboard");
  const { as_of, kpis } = await growthKpis(c.env);
  const inv = await dataInventory(c.env);
  const history = await getDb(c.env)
    .select({ date: t.proofSnapshots.date, metric: t.proofSnapshots.metric, v: t.proofSnapshots.externalValue })
    .from(t.proofSnapshots)
    .where(and(like(t.proofSnapshots.metric, "kpi_%"), gte(t.proofSnapshots.date, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))))
    .orderBy(t.proofSnapshots.date);
  const trend = (id: string) => history.filter((h) => h.metric === `kpi_${id}`).map((h) => h.v);
  const citations = (await c.env.KV.get<Citation[]>(CITATIONS_KV, "json")) ?? [];
  const partners = (await c.env.KV.get<PartnerContact[]>(PARTNERS_KV, "json")) ?? [];
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const north = kpis[0]!;
  const daily = ((north.detail?.daily as { day: string; agents: number }[]) ?? []).map((d) => d.agents);
  return send(
    c,
    {
      ...page,
      body: html`<h1 class="page-title">Growth KPIs</h1>
<p>Full UTC days to ${as_of}. Definitions: ADR 0039. Internal only.</p>
<p><b>North star:</b> ${fmt(north.value)} ${north.unit} (${STATUS_LABEL[north.status]}); last 14 days ${spark(daily)}</p>
<table class="kpi-table">
<thead><tr><th>KPI</th><th>Now</th><th>First target</th><th>Second target</th><th>Status</th><th>30-day trend</th></tr></thead>
<tbody>${kpis.map(
        (k) => html`<tr class="kpi-${k.status}"><td><b>${k.name}</b><br><small>${k.definition}</small></td><td>${fmt(k.value)} ${k.unit}</td><td>${fmt(k.first)}</td><td>${fmt(k.second)}</td><td>${STATUS_LABEL[k.status]}</td><td>${spark(trend(k.id))}</td></tr>`,
      )}</tbody></table>
${ownerFunnelPanel(kpis.find((k) => k.id === "verified_owners")?.detail as OwnerFunnel | undefined)}
<details><summary>Detail (JSON)</summary><pre>${JSON.stringify(kpis.map((k) => ({ id: k.id, detail: k.detail ?? null })), null, 2)}</pre></details>

<h2>Dataset inventory</h2>
<p><small>What we hold that's hard to recreate (ADR 0040). Calibrated means a ranked task with 6+ runs and a pass rate between 3% and 97%.</small></p>
<table class="kpi-table"><tbody>
<tr><td>Task environments</td><td>${inv.environments.task_families} job families, ${inv.environments.job_versions} job versions (${inv.environments.tiers.join(", ")}), seeded variants</td></tr>
<tr><td>Refereed runs</td><td>${fmt(inv.refereed_runs.total)} (ranked ${fmt(inv.refereed_runs.ranked)}, ${inv.refereed_runs.models} models, ${fmt(inv.refereed_runs.with_trap_fall)} ranked runs with a trap fall; ${inv.refereed_runs.freshness_pct ?? "–"}% from the last 30 days)</td></tr>
<tr><td>Difficulty calibration</td><td>${inv.calibration.tasks_in_band} of ${inv.calibration.tasks_measured} measured tasks in band${inv.calibration.per_task.length ? html`<br><small>${inv.calibration.per_task.map((x) => `${x.task} ${x.pass_rate}% (n ${x.n})`).join(" · ")}</small>` : ""}</td></tr>
<tr><td>Outside agents' runs</td><td>${fmt(inv.external_runs.gauntlet_finished)} Gauntlet, ${fmt(inv.external_runs.proving_ground_finished)} Proving Ground</td></tr>
<tr><td>Field reports</td><td>${fmt(inv.field_reports.total)} (${fmt(inv.field_reports.external)} from outside; ${fmt(inv.field_reports.tools_covered)} tool versions)</td></tr>
<tr><td>Skill scans</td><td>${fmt(inv.scans.unique_skills)} unique skills (${fmt(inv.scans.public)} public)</td></tr>
<tr><td>Controls</td><td>${Object.entries(inv.controls).map(([k, v]) => html`${v ? "✓" : "✗"} ${k.replaceAll("_", " ")}<br>`)}</td></tr>
</tbody></table>

<h2>Citations (${citations.length})</h2>
<ul>${citations.map((x) => html`<li>${x.date}: <a href="${x.url}" rel="noopener nofollow">${x.title}</a></li>`)}</ul>
<form method="post" action="/admin/kpis/citation"><input type="hidden" name="csrf" value="${csrf}">
<input name="url" type="url" required placeholder="https://…" maxlength="500"> <input name="title" required placeholder="Title" maxlength="200"> <button class="btn chamfer" type="submit">Add citation</button></form>

<h2>Partner conversations (${partners.length})</h2>
<p><small>Organisations only. No personal names here (they belong in your own notes).</small></p>
<ul>${partners.map((b) => html`<li>${b.date}: ${b.org}: ${b.stage}</li>`)}</ul>
<form method="post" action="/admin/kpis/partner"><input type="hidden" name="csrf" value="${csrf}">
<input name="org" required placeholder="Organisation" maxlength="80"> <select name="stage">${PARTNER_STAGES.map((x) => html`<option>${x}</option>`)}</select> <button class="btn chamfer" type="submit">Add</button></form>
<style>.kpi-table{width:100%;border-collapse:collapse}.kpi-table td,.kpi-table th{border-bottom:1px solid var(--line,#333);padding:.4rem;vertical-align:top;text-align:left}.kpi-second td:nth-child(5){color:#3fb950}.kpi-first td:nth-child(5){color:#d29922}.kpi-spark{display:inline-flex;gap:1px;align-items:flex-end;height:24px}.kpi-spark i{display:inline-block;width:4px;background:currentColor;opacity:.7}</style>`,
    },
    { cache: false },
  );
});

site.post("/admin/kpis/citation", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const url = String(g.form.get("url") ?? "").trim().slice(0, 500);
  const title = String(g.form.get("title") ?? "").trim().slice(0, 200);
  if (/^https:\/\/[^\s]+$/.test(url) && title) {
    const list = (await c.env.KV.get<Citation[]>(CITATIONS_KV, "json")) ?? [];
    if (!list.some((x) => x.url === url)) list.push({ url, title, date: new Date().toISOString().slice(0, 10) });
    await c.env.KV.put(CITATIONS_KV, JSON.stringify(list.slice(-500)));
  }
  return c.redirect("/admin/kpis");
});

site.post("/admin/kpis/partner", async (c) => {
  const g = await guardPost(c);
  if (!g || !(await admin(c, g.session.h))) return c.redirect("/dashboard");
  const org = String(g.form.get("org") ?? "").trim().slice(0, 80);
  const stage = String(g.form.get("stage") ?? "") as PartnerStage;
  if (org && PARTNER_STAGES.includes(stage)) {
    const list = (await c.env.KV.get<PartnerContact[]>(PARTNERS_KV, "json")) ?? [];
    list.push({ org, stage, date: new Date().toISOString().slice(0, 10) });
    await c.env.KV.put(PARTNERS_KV, JSON.stringify(list.slice(-500)));
  }
  return c.redirect("/admin/kpis");
});
