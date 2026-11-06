import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { backfillProgress, fullHistoryPage, ORIGINS } from "../services/tool-history";
import { currentSession } from "./dashboard";
import { send, site } from "./pages";

// ADR 0134: /admin/tool-history, where the tool-definition backfill stands (servers done, versions done, failed and
// pending), and the buyer-only full download (tool text included). Founder only, never cached, never indexed.

// biome-ignore lint/suspicious/noExplicitAny: any route of the site
async function admin(c: Context<{ Bindings: Env }, any>) {
  const s = await currentSession(c);
  const me = s ? await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : undefined;
  return !!me && isAdmin(c.env, me.githubId);
}

site.get("/admin/tool-history", async (c) => {
  if (!(await admin(c))) return c.redirect("/dashboard");
  const p = await backfillProgress(c.env);
  if (c.req.query("format") === "json") return c.json(p, 200, { "Cache-Control": "no-store" });
  const n = (x: number) => x.toLocaleString("en-US");
  const rows = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => html`<tr><td>${k || "none"}</td><td class="num">${n(v)}</td></tr>`);
  return send(
    c,
    {
      title: "Tool-history backfill",
      description: "Internal: progress of the tool-definition backfill.",
      path: "/admin/tool-history",
      noindex: true,
      body: html`<h1 class="page-title">Tool-definition backfill</h1>
<p>Every stable version published since ${p.since} of the backfill's servers, installed by the House tester (house-backfill.yml on the public mirror), its tools/list stored with origin <code>backfill</code>. Internal only. ${p.last_observed_at ? `Last result ${p.last_observed_at.slice(0, 16).replace("T", " ")} UTC, on ${p.run_days} run days.` : "No results yet."}</p>
<h2>Servers</h2>
<table class="table"><tbody>
<tr><th>In the set</th><td class="num">${n(p.servers.total)} (${n(p.servers.npm)} npm from the nightly top 500, ${n(p.servers.pypi)} PyPI from the weekly sweep)</td></tr>
<tr><th>Version list read</th><td class="num">${n(p.servers.enumerated)}</td></tr>
<tr><th>Not on the registry</th><td class="num">${n(p.servers.not_found)}</td></tr>
<tr><th>Done (no version pending)</th><td class="num">${n(p.servers.complete)}</td></tr>
</tbody></table>
<h2>Versions</h2>
<table class="table"><tbody>
<tr><th>Done</th><td class="num">${n(p.versions.done)}</td></tr>
<tr><th>Failed to start</th><td class="num">${n(p.versions.failed)}</td></tr>
<tr><th>Pending</th><td class="num">${n(p.versions.pending)}</td></tr>
<tr><th>Not tested (excluded)</th><td class="num">${n(p.versions.excluded)}</td></tr>
<tr><th>Runs left at ${n(p.per_run)} a run</th><td class="num">${p.runs_left === null ? "not yet measured (version lists still being read)" : n(p.runs_left)}</td></tr>
</tbody></table>
<h3>Failed, by class (failure-classes/v1)</h3>
${Object.keys(p.versions.failed_by_class).length ? html`<table class="table"><tbody>${rows(p.versions.failed_by_class)}</tbody></table>` : html`<p class="empty">None yet.</p>`}
<h3>Excluded, by reason</h3>
${Object.keys(p.versions.excluded_by_reason).length ? html`<table class="table"><tbody>${rows(p.versions.excluded_by_reason)}</tbody></table>` : html`<p class="empty">None yet.</p>`}
<h2>Rows and drift</h2>
<table class="table"><tbody>
<tr><th>Backfill history rows</th><td class="num">${n(p.history_rows.backfill)} (${n(p.history_rows.tools)} tools)</td></tr>
<tr><th>Consecutive pairs compared</th><td class="num">${n(p.drift.pairs)}</td></tr>
<tr><th>Pairs whose definitions changed</th><td class="num">${n(p.drift.changed)}</td></tr>
<tr><th>Changed within the same major version</th><td class="num">${n(p.drift.changed_without_major_bump)}</td></tr>
<tr><th>Changed text matching a scanner rule it didn't match before</th><td class="num">${n(p.drift.with_new_text_rules)}</td></tr>
</tbody></table>
<p class="small">Buyer-only download, tool text included (JSON lines, a page at a time): <a href="/admin/tool-history/full.jsonl?origin=backfill">backfill rows</a> · <a href="/admin/tool-history/full.jsonl">every row</a>. Public files (hashes and change classes): <a href="/dataset/census">/dataset/census</a>. <a href="/admin/tool-history?format=json">JSON</a></p>`,
    },
    { cache: false },
  );
});

/** The full rows with their tool text, a page at a time (X-Next-After names the next page). Never public. */
site.get("/admin/tool-history/full.jsonl", async (c) => {
  if (!(await admin(c))) return c.redirect("/dashboard");
  const origin = c.req.query("origin") ?? null;
  if (origin !== null && !Object.values(ORIGINS).includes(origin as never)) return c.json({ error: "invalid_origin" }, 400);
  const after = c.req.query("after") ?? "";
  const page = await fullHistoryPage(c.env, origin, after);
  const headers: Record<string, string> = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Rows": String(page.rows) };
  if (page.next) headers["X-Next-After"] = page.next;
  return new Response(page.body, { headers });
});
