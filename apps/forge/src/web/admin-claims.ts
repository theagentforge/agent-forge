import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { CLAIMS_JSON_PATH, CLAIMS_PATH, claimsOverview, runClaimChecks } from "../services/claims";
import { PRIVATE_HEADERS } from "../services/data-room";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";

// ADR 0120: /admin/claims (founder admins only, no-store). Every claim in the registry with its latest verdict and the
// exact quote it was read from, a "Check now" button, the append-only log and whether its hash chain holds.
// /admin/claims.json is the same, as data. Nothing here is public, and nothing is sent anywhere.

type Ctx = Parameters<typeof currentSession>[0];

async function adminSession(c: Ctx) {
  const s = await currentSession(c);
  if (!s) return null;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return me && isAdmin(c.env, me.githubId) ? { me, s } : null;
}

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");

site.get(CLAIMS_JSON_PATH, async (c) => {
  const a = await adminSession(c);
  if (!a) return c.json({ error: "forbidden" }, 403, PRIVATE_HEADERS);
  return c.json(await claimsOverview(c.env), 200, { ...PRIVATE_HEADERS, "X-Content-Type-Options": "nosniff" });
});

site.get(CLAIMS_PATH, async (c) => {
  const a = await adminSession(c);
  if (!a) return c.redirect("/dashboard");
  const d = await claimsOverview(c.env);
  const csrf = await csrfToken(c.env.SESSION_SECRET, a.s.token);
  const ran = c.req.query("ran");
  const failing = d.claims.filter((x) => !x.retired_at && x.latest && x.latest.verdict !== "SUPPORTED").length;
  const unchecked = d.claims.filter((x) => !x.retired_at && !x.latest).length;
  const res = await send(
    c,
    {
      title: "Claims",
      description: "Private.",
      path: CLAIMS_PATH,
      noindex: true,
      body: html`<h1 class="page-title">Claims (private)</h1>
<p>Founder admins only. Each claim we make in a brief, on a page or in an ops email, checked against its source. Four verdicts: SUPPORTED, CONTRADICTED, NOT PRESENT, UNREACHABLE. The checker never edits a claim; anything it can't read is UNREACHABLE. Runs nightly (about 01:17 UTC) and when you press the button. Decision record: ADR 0120.</p>
${ran ? html`<p data-k="ran"><b>Checked now</b> (run <code>${ran}</code>).</p>` : ""}
<table class="kpi-table"><tbody>
<tr data-k="failing"><td>Live claims not SUPPORTED at their last check</td><td><b>${failing}</b>${unchecked ? html` · ${unchecked} not yet checked` : ""}</td></tr>
<tr data-k="chain"><td>Log hash chain</td><td>${d.chain.ok ? html`holds · ${d.chain.rows} rows` : html`<b>broken at row ${(d.chain.broken_at ?? 0) + 1}</b>`}</td></tr>
<tr data-k="llm"><td>LLM pass for prose claims</td><td>${d.llm_pass}</td></tr>
</tbody></table>
<form method="post" action="${CLAIMS_PATH}/check"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Check now</button></form>
<h2>Claims</h2>
<table class="table stack"><thead><tr><th scope="col">Claim</th><th scope="col">Verdict</th><th scope="col">Read from the source</th><th scope="col">Checked</th></tr></thead><tbody>
${d.claims.map(
  (x) => html`<tr data-claim="${x.id}"${x.retired_at ? html` class="muted"` : ""}><td><b>${x.id}</b> ${x.text}<br><span class="small muted">${x.appears_in} · ${x.author}${x.author_model ? ` (${x.author_model})` : ""} · <code>${x.url}</code>${x.anchor_path ? html` <code>${x.anchor_path}</code> ${x.comparator} ${x.expected}` : x.expected ? html` phrase` : ""}${x.retired_at ? html` · retired ${when(x.retired_at)}` : ""}</span></td><td data-verdict="${x.latest?.verdict ?? ""}">${x.latest ? html`<b>${x.latest.verdict.replace("_", " ")}</b><br><span class="small">${x.latest.reason}</span>` : "not yet checked"}${x.latest_llm ? html`<br><span class="small">LLM: ${x.latest_llm.verdict.replace("_", " ")} (${x.latest_llm.reason})</span>` : ""}</td><td>${x.latest?.quote ? html`<code>${x.latest.quote}</code>` : ""}${x.latest?.observed_as_of ? html`<br><span class="small muted">as of ${x.latest.observed_as_of}</span>` : ""}</td><td class="small">${when(x.latest?.checked_at)}</td></tr>`,
)}
</tbody></table>
<h2>Log (newest 200)</h2>
<p class="small">Append-only: the database refuses edits and deletes, and each row carries the hash of the one before. JSON: <a href="${CLAIMS_JSON_PATH}">${CLAIMS_JSON_PATH}</a>.</p>
<table class="table stack"><thead><tr><th scope="col">#</th><th scope="col">When</th><th scope="col">Claim</th><th scope="col">Verdict</th><th scope="col">How</th><th scope="col">Response sha256</th></tr></thead><tbody>
${d.log.map((r) => html`<tr><td>${r.seq}</td><td class="small">${when(r.checked_at)} · ${r.trigger}</td><td>${r.claim_id}</td><td>${r.verdict.replace("_", " ")} <span class="small">${r.reason}</span></td><td class="small">${r.checker} · ${r.via}${r.http_status !== null ? ` · ${r.http_status}` : ""}</td><td class="small"><code>${(r.response_sha256 ?? "").slice(0, 16)}</code></td></tr>`)}
</tbody></table>`,
    },
    { cache: false },
  );
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
  return res;
});

site.post(`${CLAIMS_PATH}/check`, async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (!me || !isAdmin(c.env, me.githubId)) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const r = await runClaimChecks(c.env, c.executionCtx as unknown as ExecutionContext, { trigger: "admin" });
  return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, Location: `${CLAIMS_PATH}?ran=${encodeURIComponent(r.run_id)}` } });
});
