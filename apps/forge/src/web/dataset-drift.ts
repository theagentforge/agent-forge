import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { DRIFT_DIR, driftFullPage, driftSample, driftTotals, METHOD, SAMPLE_RULE } from "../services/drift-report";
import { isAdmin } from "../services/identity";
import { currentSession } from "./dashboard";
import { send, site } from "./pages";
import { asPreview } from "./validity-release";

// ADR 0146 (moat audit gate 1): the drift report. Public: /dataset/drift (totals and method) and
// /dataset/drift/sample.json (a fixed-size seeded sample). Internal: /admin/tool-history/drift.jsonl (every changed pair,
// full text; founder only, linked from the data room). The public paths are behind the release switch DRIFT_PUBLIC:
// unset or anything but "on" is 404 for everyone but a signed-in admin, who sees an uncached preview.

export const driftReleased = (env: { DRIFT_PUBLIC?: string }) => (env.DRIFT_PUBLIC ?? "").trim().toLowerCase() === "on";
export const SAMPLE_PATH = `${DRIFT_DIR}/sample.json`;
export const FULL_PATH = "/admin/tool-history/drift.jsonl";

type Ctx = Context<{ Bindings: Env }>;

async function isFounder(c: Ctx) {
  const s = await currentSession(c).catch(() => null);
  if (!s) return false;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return !!me && isAdmin(c.env, me.githubId);
}

async function access(c: Ctx): Promise<"public" | "admin_preview" | null> {
  if (driftReleased(c.env)) return "public";
  return (await isFounder(c)) ? "admin_preview" : null;
}

const HEADERS = { "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "X-Robots-Tag": "noindex" };

site.get(SAMPLE_PATH, async (c) => {
  const a = await access(c);
  if (!a) return c.notFound();
  const res = c.json(await driftSample(c.env, c.env.PUBLIC_ORIGIN), 200, HEADERS);
  return a === "admin_preview" ? asPreview(res) : res;
});

site.get(`${DRIFT_DIR}/`, (c) => c.redirect(DRIFT_DIR, 301));

site.get(DRIFT_DIR, async (c) => {
  const a = await access(c);
  if (!a) return c.notFound();
  const x = await driftTotals(c.env);
  const n = (v: number) => v.toLocaleString("en-US");
  const body = html`<h1 class="page-title">Tool-definition drift</h1>
<p class="lead">MCP servers whose tool text (tool names, descriptions or input schemas) changed between published versions, and how often that happened without a major version change.</p>
${
  x.pairs_compared
    ? html`<table class="kpi-table"><tbody>
<tr data-k="servers_in_set"><td>Servers in the set (npm top 500 and PyPI)</td><td class="num"><b>${n(x.servers_in_set)}</b></td></tr>
<tr data-k="servers_compared"><td>Servers with two or more recorded definition sets</td><td class="num"><b>${n(x.servers_compared)}</b></td></tr>
<tr data-k="pairs_compared"><td>Consecutive pairs compared</td><td class="num"><b>${n(x.pairs_compared)}</b></td></tr>
<tr data-k="pairs_changed"><td>Pairs whose tool text changed</td><td class="num"><b>${n(x.pairs_changed)}</b></td></tr>
<tr data-k="pairs_changed_without_major_bump"><td>Changed without a major version change (of which 0.x)</td><td class="num"><b>${n(x.pairs_changed_without_major_bump)}</b> (${n(x.of_which_zero_major)})</td></tr>
<tr data-k="servers_changed_without_major_bump"><td>Servers with at least one such change</td><td class="num"><b>${n(x.servers_changed_without_major_bump)}</b></td></tr>
</tbody></table>
<p class="small muted">Computed through ${x.computed_through ? x.computed_through.slice(0, 10) : "not yet"}. The history is still being filled in; these totals grow as more versions are recorded.</p>`
    : html`<p class="notice">No pairs compared yet.</p>`
}
<p><a href="${SAMPLE_PATH}">sample.json</a>: a small, seeded sample of changed pairs with the tools named and their text before and after. ${SAMPLE_RULE}</p>
<h2>Method</h2>
<ul>${METHOD.map((m) => html`<li>${m}</li>`)}</ul>
<p class="small muted">The full report (every server and pair, full text) is not public. More: <a href="/dataset/census">the census dataset</a> · <a href="/dataset">the dataset spec</a>.</p>`;
  const res = await send(c, { title: "Tool-definition drift", description: "MCP servers whose tool text changed between versions without a major version change: totals and a sample.", path: DRIFT_DIR, noindex: true, body }, { cache: a === "public", maxAge: 3600 });
  return a === "admin_preview" ? asPreview(res) : res;
});

/** The full report, a page at a time (X-Next-After names the next page). Founder only, never public. */
site.get(FULL_PATH, async (c) => {
  if (!(await isFounder(c))) return c.redirect("/dashboard");
  const page = await driftFullPage(c.env, c.req.query("after") ?? "");
  const headers: Record<string, string> = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Pairs": String(page.pairs), "X-Servers": String(page.servers) };
  if (page.next) headers["X-Next-After"] = page.next;
  return new Response(page.body, { headers });
});
