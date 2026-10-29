import { eq } from "drizzle-orm";
import { html } from "hono/html";
import * as t from "../db/schema";
import { BACKUP_PATH, dumpFileName, dumpStream, KEEP_MONTHLY, KEEP_WEEKLY, lastDownload, r2Enabled, r2Last, recordDownloadDone, recordDownloadStart } from "../services/backup";
import { exportIndex } from "../services/bulk-export";
import { DATA_ROOM_PATH, PRIVATE_HEADERS } from "../services/data-room";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";

// B3-08 (ADR 0102): /admin/backup (founder admins). A full SQL dump of D1, streamed through the Worker, to keep in
// iCloud Drive once a month; when it was last downloaded; and the state of the weekly R2 copy (off until R2 is bound).
// The download is a POST with the session's CSRF token: it records "last downloaded", and a cross-site page can't start it.

type Ctx = Parameters<typeof currentSession>[0];

async function adminSession(c: Ctx) {
  const s = await currentSession(c);
  if (!s) return null;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return me && isAdmin(c.env, me.githubId) ? { me, s } : null;
}

const when = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "never");
const daysSince = (iso: string, now = Date.now()) => Math.floor((now - Date.parse(iso)) / 86_400_000);

site.get(BACKUP_PATH, async (c) => {
  const a = await adminSession(c);
  if (!a) return c.redirect("/dashboard");
  const [last, r2, exports] = await Promise.all([lastDownload(c.env), r2Last(c.env), exportIndex(c.env)]);
  const csrf = await csrfToken(c.env.SESSION_SECRET, a.s.token);
  const latest = exports[0];
  const due = !last?.completed_at || daysSince(last.completed_at) >= 30;
  const res = await send(
    c,
    {
      title: "Backups",
      description: "Private.",
      path: BACKUP_PATH,
      noindex: true,
      body: html`<h1 class="page-title">Backups (private)</h1>
<p>Founder admins only. Runbook with restore steps: <code>docs/runbooks/backups.md</code>.</p>
<table class="kpi-table"><tbody>
<tr data-k="last_downloaded"><td>Full backup last downloaded</td><td><b>${last?.completed_at ? when(last.completed_at) : last ? `started ${when(last.started_at)}, not finished` : "never"}</b>${last?.bytes ? html` · ${last.bytes.toLocaleString("en-US")} bytes` : ""}${due ? html` · <b>due now</b>` : ""}</td></tr>
<tr data-k="time_travel"><td>D1 Time Travel (Cloudflare, always on)</td><td>any minute in the last 30 days</td></tr>
<tr data-k="r2"><td>Weekly copy to R2 (bucket <code>forge-backups</code>)</td><td>${r2Enabled(c.env) ? html`on · last copy ${r2 ? `${r2.id} (week ${r2.week})` : "not yet"} · keeps ${KEEP_WEEKLY} weekly and ${KEEP_MONTHLY} monthly` : html`off: R2 is not enabled on the account yet (runbook step "Switch on the weekly R2 copy")`}</td></tr>
<tr data-k="export"><td>Latest bulk export (data room)</td><td>${latest ? html`<a href="${DATA_ROOM_PATH}/export/${latest.export_id}/manifest.json">${latest.export_id} manifest</a>` : "none yet"}</td></tr>
</tbody></table>
<h2>Download a full backup</h2>
<p>One file of SQL with every table and row of the database. It can be large and takes a moment to start.</p>
<form method="post" action="${BACKUP_PATH}/download"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Download full backup</button></form>
<h2>Keep it in iCloud Drive, once a month</h2>
<ol>
<li>Press <b>Download full backup</b> above. Safari saves a file named like <code>forge-d1-20261101-0930.sql</code> to Downloads.</li>
<li>Open the file's last lines (Quick Look: select it in Finder and press the space bar, then scroll to the end). The last line must start with <code>-- forge-d1-dump: complete</code>. If it doesn't, the download was cut off: delete it and download again.</li>
<li>In Finder, open <b>iCloud Drive</b> and the folder <b>Forge backups</b> (make it the first time: File, New Folder).</li>
<li>Drag the file from Downloads into <b>Forge backups</b>.</li>
<li>Keep the last 12 files; delete older ones. The file holds personal data (sign-in names, reports): never share it or put it anywhere public.</li>
</ol>
<p class="small muted">Why both: Time Travel only goes back 30 days and lives in the same Cloudflare account. The monthly file is a copy outside Cloudflare that you hold yourself.</p>`,
    },
    { cache: false },
  );
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
  return res;
});

site.post(`${BACKUP_PATH}/download`, async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (!me || !isAdmin(c.env, me.githubId)) return c.text("forbidden", 403, PRIVATE_HEADERS);
  const now = Date.now();
  const file = dumpFileName(now);
  const started = await recordDownloadStart(c.env, `admin:${me.id}`, file, now);
  const body = dumpStream(c.env.DB, now, (bytes) => recordDownloadDone(c.env, started, bytes));
  return new Response(body, {
    headers: { ...PRIVATE_HEADERS, "Content-Type": "application/sql; charset=utf-8", "Content-Disposition": `attachment; filename="${file}"`, "X-Content-Type-Options": "nosniff" },
  });
});
