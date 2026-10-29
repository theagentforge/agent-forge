import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { exportIndex, pseudonymKey, readExportFile, writeExport } from "../services/bulk-export";
import {
  BUYER_COOKIE,
  BUYER_COOKIE_MAX_SECONDS,
  BUYER_PATH,
  buyerPack,
  confirmLink,
  confirmToken,
  createLink,
  DATA_ROOM_PATH,
  isNdaVersion,
  LINK_DAYS_DEFAULT,
  LINK_DAYS_MAX,
  linkByToken,
  linkState,
  listLinks,
  logAccess,
  NDA_VERSIONS,
  noteLink,
  PRIVATE_HEADERS,
  revokeLink,
  SHARE_PREFIX,
  shareUrl,
  stashMade,
  takeMade,
  TOKEN,
  type BuyerPack,
  type Link,
} from "../services/data-room";
import { BACKUP_PATH } from "../services/backup";
import { getDb } from "../services/db";
import { BRIEF_BUYER_PATH, BRIEF_PATH, briefData, briefPdf } from "../reports/buyer-brief";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken, readCookie, safeEqual } from "./session";

// B2-09 / AQ-05 (ADR 0095): /admin/data-room (founder admins) and /data-room#<token> (ADR 0098: one buyer, under NDA, until the
// link expires or is revoked). Every response is private, no-store and noindex. The buyer page logs every access.

type Ctx = Parameters<typeof currentSession>[0];

async function admin(c: Ctx) {
  const s = await currentSession(c);
  if (!s) return null;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return me && isAdmin(c.env, me.githubId) ? { me, s } : null;
}

/** An HTML page with the private headers (no-store, noindex, no referrer). */
async function privatePage(c: Ctx, title: string, body: ReturnType<typeof html>, path = DATA_ROOM_PATH, status = 200, modules?: string[]) {
  const res = await send(c, { title, description: "Private.", path, noindex: true, body, status, modules }, { cache: false });
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
  return res;
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "not yet measured" : v.toLocaleString("en-US"));
const day = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "–");

/** The pack as HTML: the same object as pack.json, for admins and for buyers. */
function packHtml(p: BuyerPack, opts: { downloads?: (m: NonNullable<BuyerPack["export"]>) => ReturnType<typeof html>; buyer?: boolean } = {}) {
  const s = p.kpis.series;
  return html`<p class="small muted">Read live at ${p.generated_at}. Private, shared only under NDA. Gross numbers include our own test agents; outside-only numbers leave out House and founder accounts and are never public.</p>
<h2 id="assets">1. What is for sale</h2>
<p class="small">${p.assets.licences}</p>
${p.assets.rows.length ? html`<div class="scroll-x"><table class="kpi-table"><thead><tr><th>Asset</th><th>Where</th><th>Licence today</th><th>Exclusive to the owner</th><th>Note</th></tr></thead><tbody>
${p.assets.rows.map((a) => html`<tr data-licence="${a.licence}"><td><b>${a.asset}</b></td><td><small>${a.where}</small></td><td>${a.licence}</td><td>${a.exclusive ? "yes" : "no"}</td><td><small>${a.note}</small></td></tr>`)}</tbody></table></div>` : html`<p>Not in this copy.</p>`}

<h2 id="kpis">2. Traction: KPIs, gross and outside-only</h2>
<h3>Gross, now (public numbers, our own included)</h3>
${p.kpis.gross ? html`<p class="small">Source: ${p.kpis.gross.source}, read ${p.kpis.gross.generated_at}.</p><table class="kpi-table"><tbody>
${[...p.kpis.gross.totals, ...p.kpis.gross.people_and_7_days].map((x) => html`<tr data-k="gross_${x.key}"><td>${x.label}</td><td>${fmt(x.value)}</td><td>gross</td></tr>`)}</tbody></table>` : html`<p>Couldn't be read just now.</p>`}
<h3>Outside-only, now (internal; never public)</h3>
${p.kpis.outside_only ? html`<p class="small">Source: ${p.kpis.outside_only.source}, read ${p.kpis.outside_only.generated_at}, rules ${p.kpis.outside_only.rules_version}.</p><table class="kpi-table"><thead><tr><th>Counter</th><th>Outside only</th><th>Ours</th></tr></thead><tbody>
${Object.entries(p.kpis.outside_only.splits).map(([k, v]) => html`<tr data-k="outside_${k}"><td>${k.replaceAll("_", " ")}</td><td><b>${fmt(v.third_party)}</b></td><td>${fmt(v.ours)}</td></tr>`)}
<tr data-k="outside_active_owners_30d"><td>Active owners, last 30 days</td><td><b>${fmt(p.kpis.outside_only.active_owners_30d)}</b></td><td>–</td></tr></tbody></table>` : html`<p>Couldn't be read just now.</p>`}
<h3>Growth KPIs now (ADR 0039 definitions)</h3>
<table class="kpi-table"><tbody>${s.kpis.map((k) => html`<tr data-k="kpi_${k.id}"><td><b>${k.name}</b><br><small>${k.definition}</small></td><td>${fmt(k.value)} ${k.unit}</td></tr>`)}</tbody></table>
<h3>Daily series, last ${s.days.length} days</h3>
<p class="small">Source: ${s.source}, read ${s.generated_at}. Basis says what each row counts: <b>outside</b> (House and founders left out), <b>ours</b>, <b>outside + ours</b> (the sum of those two; /stats gross totals can be higher because they also count crawlers and monitors), <b>kpi (as defined)</b> and <b>dataset (gross)</b>.</p>
${s.days.length ? html`<details><summary>Show the series (${s.series.length} rows)</summary><div class="scroll-x"><table class="kpi-table"><thead><tr><th>Metric</th><th>Basis</th>${s.days.map((d) => html`<th>${d.slice(5)}</th>`)}</tr></thead><tbody>
${s.series.map((r) => html`<tr data-basis="${r.basis}"><td>${r.label}</td><td>${r.basis}</td>${r.values.map((v) => html`<td>${v === null ? "–" : v.toLocaleString("en-US")}</td>`)}</tr>`)}</tbody></table></div></details>` : html`<p>No daily snapshots yet: not yet measured.</p>`}

<h2 id="costs">3. Costs and dependencies</h2>
<p class="small">Credit rows read ${p.costs.credit.generated_at} from ${p.costs.credit.source}.</p>
<table class="kpi-table"><tbody>
<tr><td>OpenRouter credit bought (total)</td><td>$${p.costs.credit.openrouter_bought_usd}</td></tr>
<tr><td>OpenRouter credit left (estimate) · guard</td><td>${p.costs.credit.openrouter_left_usd === null ? "not yet measured" : `$${p.costs.credit.openrouter_left_usd.toFixed(2)}`} · ${p.costs.credit.openrouter_guard ?? "–"}</td></tr>
<tr><td>Anthropic BYOK spend this month (estimate)</td><td>${p.costs.credit.anthropic_byok_spend_this_month_usd === null ? "not yet measured" : `$${p.costs.credit.anthropic_byok_spend_this_month_usd.toFixed(2)}`}; credits expire <b>${p.costs.credit.anthropic_byok_expires}</b></td></tr>
</tbody></table>
${p.costs.rows.length ? html`<div class="scroll-x"><table class="kpi-table"><thead><tr><th>Provider</th><th>What</th><th>Cost</th><th>Ends</th><th>If it stops</th><th>Source</th></tr></thead><tbody>
${p.costs.rows.map((r) => html`<tr><td><b>${r.provider}</b></td><td>${r.what}</td><td>${r.cost}</td><td>${r.expires ?? "–"}</td><td><small>${r.if_it_stops}</small></td><td><small>${r.source}</small></td></tr>`)}</tbody></table></div>` : ""}

<h2 id="dataset">4. The dataset, from one count source</h2>
<p class="small">Read ${p.dataset.generated_at}. All rows come from the functions behind /stats and /admin/kpis and the /arena/dataset.json filter. Checks: refereed runs match /stats ${p.dataset.checks.runs_match_stats ? "yes" : "NO"}; public + private parts add up ${p.dataset.checks.parts_add_up ? "yes" : "NO"}${p.dataset.checks.dataset_json_truncated ? html`; <b>/arena/dataset.json lists only the newest ${p.dataset.checks.dataset_json_cap} runs</b>` : ""}.</p>
<table class="kpi-table"><thead><tr><th>Count</th><th>Number</th><th>Rule</th></tr></thead><tbody>
${p.dataset.rows.map((r) => html`<tr data-k="${r.key}"><td>${r.label}</td><td><b>${r.n.toLocaleString("en-US")}</b></td><td><small>${r.rule}</small></td></tr>`)}</tbody></table>

<h2 id="documents">Documents</h2>
<ul>${p.documents.map((d) => html`<li data-doc="${d.admin_path}"><a href="${opts.buyer ? d.buyer_path : d.admin_path}">${d.name}</a></li>`)}</ul>

<h2 id="export">5. Bulk export (pseudonymised)</h2>
${p.export
  ? html`<p>Export <code>${p.export.export_id}</code>, made ${p.export.created_at}: ${p.export.counts.runs.toLocaleString("en-US")} runs, ${p.export.counts.reports.toLocaleString("en-US")} reports, ${p.export.counts.scans.toLocaleString("en-US")} scans. exports_pseudonymised: <b>${String(p.export.exports_pseudonymised)}</b>. Each file's SHA-256 is in the manifest.</p>${opts.downloads ? opts.downloads(p.export) : ""}`
  : html`<p>No export yet.</p>`}

<h2 id="handover">6. Handover runbooks</h2>
${p.runbooks.rows.length ? html`<p class="small">Index generated ${p.runbooks.generated} (scripts/data-room-index.mjs).</p><ul>${p.runbooks.rows.map((r) => html`<li><code>${r.path}</code>: ${r.title}</li>`)}</ul>` : html`<p>Not in this copy.</p>`}

<h2 id="adrs">7. Decision records (ADRs)</h2>
${p.adrs.rows.length ? html`<details><summary>${p.adrs.rows.length} ADRs (index generated ${p.adrs.generated})</summary><ol>${p.adrs.rows.map((a) => html`<li value="${Number(a.id)}"><code>${a.path}</code>: ${a.title}</li>`)}</ol></details>` : html`<p>Not in this copy.</p>`}

<h2 id="legal">8. Open legal and IP items</h2>
${p.legal.length ? html`<table class="kpi-table"><thead><tr><th>Item</th><th>Today</th><th>Needed</th></tr></thead><tbody>${p.legal.map((l) => html`<tr><td><b>${l.item}</b></td><td>${l.status}</td><td>${l.needs}</td></tr>`)}</tbody></table>` : html`<p>Not in this copy.</p>`}

<h2 id="checklist">9. Diligence checklist</h2>
${p.checklist.length ? html`<table class="kpi-table"><thead><tr><th>Area</th><th>Where</th><th>Status</th></tr></thead><tbody>${p.checklist.map((x) => html`<tr data-area="${x.area}"><td><b>${x.area}</b></td><td><small>${x.where}</small></td><td>${x.status}</td></tr>`)}</tbody></table>` : html`<p>Not in this copy.</p>`}`;
}

const stateLabel = (l: Link) => ({ active: "active", expired: "expired", revoked: "revoked" })[linkState(l)];

site.get(DATA_ROOM_PATH, async (c) => {
  const a = await admin(c);
  if (!a) return c.redirect("/dashboard");
  const [pack, links, exports] = await Promise.all([buyerPack(c.env), listLinks(c.env), exportIndex(c.env)]);
  const csrf = await csrfToken(c.env.SESSION_SECRET, a.s.token);
  const made = c.req.query("made") === "1" ? await takeMade(c.env, a.s.token) : null;
  return privatePage(
    c,
    "Data room",
    html`<h1 class="page-title">Buyer data room (private)</h1>
<p>Founder admins only. <a href="${BRIEF_PATH}">Two-page buyer brief (PDF)</a> · <a href="${BACKUP_PATH}">Backups</a>. Share it with a buyer only after they sign an NDA (template: <code>docs/strategy/nda-template.md</code>, not yet lawyer-reviewed). JSON: <a href="${DATA_ROOM_PATH}/pack.json">pack.json</a>. Runbook: <code>docs/runbooks/data-room.md</code>.</p>
${made ? html`<p class="callout"><b>New link, shown once.</b> Copy it now; only its hash is stored:<br><code>${shareUrl(c.env.PUBLIC_ORIGIN, made)}</code></p>` : ""}
<h2 id="links">Buyer links</h2>
<form method="post" action="${DATA_ROOM_PATH}/links"><input type="hidden" name="csrf" value="${csrf}">
<input name="label" required maxlength="80" placeholder="Buyer organisation"> <label>Days <input name="days" type="number" min="1" max="${LINK_DAYS_MAX}" value="${LINK_DAYS_DEFAULT}"></label>
<select name="nda">${NDA_VERSIONS.map((v) => html`<option value="${v.id}">${v.label}</option>`)}</select>
<label><input type="checkbox" name="export" value="1"> include the bulk export</label> <button class="btn chamfer" type="submit">Make link</button></form>
${links.length
  ? html`<table class="kpi-table"><thead><tr><th>Buyer</th><th>State</th><th>NDA</th><th>Buyer confirmed</th><th>Accesses</th><th>Note</th><th></th></tr></thead><tbody>${links.map(
      (l) => html`<tr data-link="${l.id}"><td><b>${l.label}</b><br><small>made ${day(l.createdAt)}; ends ${day(l.expiresAt)}${l.includeExport ? "; export included" : ""}</small></td><td>${stateLabel(l)}${l.revokedAt ? html`<br><small>${day(l.revokedAt)}</small>` : ""}</td><td><small>${l.ndaVersion}</small></td>
<td>${l.confirmedAt ? html`${day(l.confirmedAt)}<br><small>${l.confirmedNdaVersion} · ${l.confirmedOrg}</small>` : "not yet"}</td>
<td>${l.access.length}${l.access.length ? html`<details><summary>log</summary><ul>${l.access.map((x) => html`<li><small>${day(x.at)} ${x.event}${x.detail ? ` ${x.detail}` : ""} · viewer ${x.viewer ?? "–"}${x.country ? ` · ${x.country}` : ""}</small></li>`)}</ul></details>` : ""}</td>
<td><form method="post" action="${DATA_ROOM_PATH}/links/${l.id}/note"><input type="hidden" name="csrf" value="${csrf}"><textarea name="note" maxlength="500" rows="2">${l.adminNote ?? ""}</textarea><button class="btn chamfer" type="submit">Save note</button></form></td>
<td>${linkState(l) === "active" ? html`<form method="post" action="${DATA_ROOM_PATH}/links/${l.id}/revoke"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Revoke</button></form>` : ""}</td></tr>`,
    )}</tbody></table>`
  : html`<p>No links yet.</p>`}
<h2 id="exports">Bulk exports (AQ-03)</h2>
<p class="small">Written every week by the hourly job, and on demand here. Stored privately in Workers KV for 40 days (R2 isn't enabled).</p>
${pseudonymKey(c.env).kind === "session_secret" ? html`<p class="callout" data-k="pseudonym_key">Pseudonyms are keyed with the session secret until the secret <code>EXPORT_PSEUDONYM_KEY</code> is added (docs/runbooks/data-room.md). Add it before the first buyer gets files: adding it later changes every pseudonym.</p>` : ""}
<form method="post" action="${DATA_ROOM_PATH}/export"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Make an export now</button></form>
<ul>${exports.map((x) => html`<li><code>${x.export_id}</code> (${x.trigger}, ${x.files} files): <a href="${DATA_ROOM_PATH}/export/${x.export_id}/manifest.json">manifest</a></li>`)}</ul>
<hr>
${packHtml(pack, { downloads: (m) => html`<ul>${m.files.map((f) => html`<li><a href="${DATA_ROOM_PATH}/export/${m.export_id}/${f.name}">${f.name}</a> <small>${f.rows} rows · ${f.bytes.toLocaleString("en-US")} bytes · sha256 ${f.sha256}</small></li>`)}</ul>` })}`,
  );
});

site.get(`${DATA_ROOM_PATH}/pack.json`, async (c) => {
  if (!(await admin(c))) return c.json({ error: "forbidden" }, 403, PRIVATE_HEADERS);
  return c.json(await buyerPack(c.env), 200, PRIVATE_HEADERS);
});

/** Admin POSTs: same-origin, the session's CSRF token, and a founder admin. */
async function adminPost(c: Ctx) {
  const g = await guardPost(c);
  if (!g) return null;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  return me && isAdmin(c.env, me.githubId) ? { ...g, by: `admin:${me.id}` } : null;
}

site.post(`${DATA_ROOM_PATH}/links`, async (c) => {
  const g = await adminPost(c);
  if (!g) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const label = String(g.form.get("label") ?? "").trim();
  const nda = String(g.form.get("nda") ?? "");
  if (!label || !isNdaVersion(nda)) return c.text("label and NDA version needed", 400, PRIVATE_HEADERS);
  const link = await createLink(c.env, { label, days: Number(g.form.get("days") ?? LINK_DAYS_DEFAULT), ndaVersion: nda, includeExport: g.form.get("export") === "1", by: g.by });
  // The token is shown once on the next page load (a 10-minute KV note bound to this session), never put in a URL.
  await stashMade(c.env, g.token, link.token);
  return c.redirect(`${DATA_ROOM_PATH}?made=1#links`, 303);
});

site.post(`${DATA_ROOM_PATH}/links/:id/revoke`, async (c) => {
  const g = await adminPost(c);
  if (!g) return c.text("forbidden", 403, PRIVATE_HEADERS);
  await revokeLink(c.env, c.req.param("id"), g.by);
  return c.redirect(`${DATA_ROOM_PATH}#links`, 303);
});

site.post(`${DATA_ROOM_PATH}/links/:id/note`, async (c) => {
  const g = await adminPost(c);
  if (!g) return c.text("forbidden", 403, PRIVATE_HEADERS);
  await noteLink(c.env, c.req.param("id"), String(g.form.get("note") ?? "").trim());
  return c.redirect(`${DATA_ROOM_PATH}#links`, 303);
});

site.post(`${DATA_ROOM_PATH}/export`, async (c) => {
  const g = await adminPost(c);
  if (!g) return c.text("forbidden", 403, PRIVATE_HEADERS);
  try {
    await writeExport(c.env, Date.now(), "on_demand");
  } catch (e) {
    // Nothing is listed or downloadable from a failed export (the manifest is written last).
    console.error("bulk_export_failed", String(e));
    return c.text(`The export failed and nothing was published: ${String(e).slice(0, 200)}`, 500, PRIVATE_HEADERS);
  }
  return c.redirect(`${DATA_ROOM_PATH}#exports`, 303);
});

function fileResponse(f: NonNullable<Awaited<ReturnType<typeof readExportFile>>>, name: string) {
  const headers: Record<string, string> = { ...PRIVATE_HEADERS, "Content-Type": f.type, "Content-Disposition": `attachment; filename="forge-export-${name}"`, "X-Content-Type-Options": "nosniff" };
  if (f.sha256) headers["X-Content-SHA256"] = f.sha256;
  return new Response(f.body, { headers });
}

site.get(`${DATA_ROOM_PATH}/export/:id/:file`, async (c) => {
  if (!(await admin(c))) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const f = await readExportFile(c.env, c.req.param("id"), c.req.param("file"));
  return f ? fileResponse(f, c.req.param("file")) : c.text("not found", 404, PRIVATE_HEADERS);
});

// --- The buyer's page -------------------------------------------------------------------------------------------------

const ip = (c: Ctx) => c.req.header("CF-Connecting-IP") ?? "unknown";

/** Per-IP budget on every /data-room request: opening a link 10 a minute, everything else 60 a minute. */
async function limited(c: Ctx, opening = false) {
  const limiter = opening ? c.env.REPORT_LIMITER : c.env.CHECK_LIMITER;
  const { success } = await limiter.limit({ key: `data-room${opening ? "-open" : ""}:${ip(c)}` });
  return success ? null : c.text("Too many requests. Wait a minute and try again.", 429, { ...PRIVATE_HEADERS, "Retry-After": "60" });
}

const sameOrigin = (c: Ctx) => {
  const origin = c.req.header("Origin");
  return !origin || origin === c.env.PUBLIC_ORIGIN;
};

const buyerCookie = (value: string, maxAge: number) => `${BUYER_COOKIE}=${value}; Path=${BUYER_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

const notFound = (c: Ctx) => privatePage(c, "Not found", html`<h1 class="page-title">Not found</h1><p>Open the link you were sent again, or ask The Agent Forge for a new one.</p>`, BUYER_PATH, 404);

/**
 * Resolves the link from a token (the open form) or the buyer's cookie, on every request, and refuses (and logs)
 * expired or revoked ones. Unknown tokens get a plain 404 and are not logged (there is no link to log them against).
 */
async function buyerLink(c: Ctx, token: string | undefined) {
  const link = token ? await linkByToken(c.env, token) : null;
  if (!link) return { res: await notFound(c) };
  const state = linkState(link);
  if (state !== "active") {
    await logAccess(c.env, link.id, state === "revoked" ? "refused_revoked" : "refused_expired", c.req.raw);
    const res = await privatePage(c, "Link closed", html`<h1 class="page-title">This link has ${state === "revoked" ? "been withdrawn" : "expired"}</h1><p>Ask The Agent Forge for a new one.</p>`, BUYER_PATH, 410);
    res.headers.append("Set-Cookie", buyerCookie("", 0));
    return { res };
  }
  return { link, token: token! };
}

const fromCookie = (c: Ctx) => readCookie(c.req.header("Cookie"), BUYER_COOKIE);

// The link the buyer was sent: /data-room#<token>. The page posts the fragment (data-room.js); without JavaScript the
// buyer pastes the code from the link into the form.
site.get(BUYER_PATH, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  return privatePage(
    c,
    "Data room",
    html`<h1 class="page-title">The Agent Forge: buyer data room</h1>
<p>Opening your link… If nothing happens, paste the access code (the part of your link after <code>#</code>) below.</p>
<form id="dr-open" method="post" action="${BUYER_PATH}/open"><label>Access code <input name="code" required minlength="43" maxlength="43" autocomplete="off" spellcheck="false"></label> <button class="btn chamfer" type="submit">Open</button></form>`,
    BUYER_PATH,
    200,
    ["/data-room.js"],
  );
});

/** The open form: checks the code, and on success sets the buyer cookie and goes to the room. */
site.post(`${BUYER_PATH}/open`, async (c) => {
  const stop = await limited(c, true);
  if (stop) return stop;
  if (!sameOrigin(c)) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const form = await c.req.formData();
  const code = String(form.get("code") ?? "").trim();
  if (!TOKEN.test(code)) return notFound(c);
  const r = await buyerLink(c, code);
  if (!r.link) return r.res;
  const maxAge = Math.max(1, Math.min(BUYER_COOKIE_MAX_SECONDS, Math.floor((r.link.expiresAt - Date.now()) / 1000)));
  return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, Location: `${SHARE_PREFIX}room`, "Set-Cookie": buyerCookie(code, maxAge) } });
});

site.get(`${SHARE_PREFIX}room`, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const r = await buyerLink(c, fromCookie(c));
  if (!r.link) return r.res;
  const link = r.link;
  await logAccess(c.env, link.id, "view", c.req.raw);
  const nda = NDA_VERSIONS.find((v) => v.id === link.ndaVersion);
  if (!link.confirmedAt) {
    return privatePage(
      c,
      "Data room",
      html`<h1 class="page-title">The Agent Forge: buyer data room</h1>
<p>Prepared for <b>${link.label}</b>. Available until ${day(link.expiresAt)}.</p>
<p>This room holds confidential information. Before you open it, confirm that your organisation has signed this NDA with The Agent Forge: <b>${nda?.label ?? link.ndaVersion}</b>.</p>
<form method="post" action="${SHARE_PREFIX}confirm"><input type="hidden" name="csrf" value="${await confirmToken(c.env, link.id)}"><input type="hidden" name="nda" value="${link.ndaVersion}">
<label>Organisation <input name="org" required maxlength="120"></label><br>
<label><input type="checkbox" name="signed" value="1" required> We have signed the NDA named above and will treat everything here as Confidential Information under it.</label><br>
<button class="btn chamfer" type="submit">Confirm and open</button></form>`,
      BUYER_PATH,
    );
  }
  const pack = await buyerPack(c.env);
  return privatePage(
    c,
    "Data room",
    html`<h1 class="page-title">The Agent Forge: buyer data room</h1>
<p>Prepared for <b>${link.label}</b> under ${nda?.label ?? link.ndaVersion} (confirmed ${day(link.confirmedAt)}). Available until ${day(link.expiresAt)}. Confidential: every visit is logged.</p>
${packHtml(pack, { buyer: true, downloads: link.includeExport ? (m) => html`<ul><li><a href="${SHARE_PREFIX}export/${m.export_id}/manifest.json">manifest.json</a></li>${m.files.map((f) => html`<li><a href="${SHARE_PREFIX}export/${m.export_id}/${f.name}">${f.name}</a> <small>${f.rows} rows · sha256 ${f.sha256}</small></li>`)}</ul>` : undefined })}`,
    BUYER_PATH,
  );
});

site.post(`${SHARE_PREFIX}confirm`, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  if (!sameOrigin(c)) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const r = await buyerLink(c, fromCookie(c));
  if (!r.link) return r.res;
  const form = await c.req.formData();
  const ok = safeEqual(String(form.get("csrf") ?? ""), await confirmToken(c.env, r.link.id)) && form.get("signed") === "1" && String(form.get("nda") ?? "") === r.link.ndaVersion;
  const org = String(form.get("org") ?? "").trim();
  if (!ok || !org) return c.text("Please tick the NDA box and give your organisation.", 400, PRIVATE_HEADERS);
  await confirmLink(c.env, r.link.id, r.link.ndaVersion, org);
  await logAccess(c.env, r.link.id, "confirm", c.req.raw, r.link.ndaVersion);
  return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, Location: `${SHARE_PREFIX}room` } });
});

site.get(`${SHARE_PREFIX}export/:id/:file`, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const r = await buyerLink(c, fromCookie(c));
  if (!r.link) return r.res;
  const name = c.req.param("file");
  if (!r.link.confirmedAt || !r.link.includeExport) {
    await logAccess(c.env, r.link.id, "refused_unconfirmed", c.req.raw, name);
    return c.text("not available", 403, PRIVATE_HEADERS);
  }
  const f = await readExportFile(c.env, c.req.param("id"), name);
  if (!f) return c.text("not found", 404, PRIVATE_HEADERS);
  await logAccess(c.env, r.link.id, "download", c.req.raw, `${c.req.param("id")}/${name}`);
  return fileResponse(f, name);
});

// --- B3-03 (ADR 0102): the two-page buyer brief, built from live numbers at download --------------------------------

async function briefResponse(c: Ctx) {
  const { bytes } = briefPdf(await briefData(c.env), c.env.PUBLIC_ORIGIN);
  return new Response(bytes, {
    headers: { ...PRIVATE_HEADERS, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="the-agent-forge-buyer-brief-${new Date().toISOString().slice(0, 10)}.pdf"`, "X-Content-Type-Options": "nosniff" },
  });
}

site.get(BRIEF_PATH, async (c) => {
  if (!(await admin(c))) return c.text("forbidden", 403, PRIVATE_HEADERS);
  return briefResponse(c);
});

site.get(BRIEF_BUYER_PATH, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const r = await buyerLink(c, fromCookie(c));
  if (!r.link) return r.res;
  if (!r.link.confirmedAt) {
    await logAccess(c.env, r.link.id, "refused_unconfirmed", c.req.raw, "brief.pdf");
    return c.text("not available", 403, PRIVATE_HEADERS);
  }
  await logAccess(c.env, r.link.id, "download", c.req.raw, "brief.pdf");
  return briefResponse(c);
});
