import { eq } from "drizzle-orm";
import { html } from "hono/html";
import { unzipStore } from "../services/zip";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { DATASET_LICENCE, LICENCE_PATH } from "../services/provenance";
import {
  COMMERCIAL_LICENCE_LINE,
  publishSample,
  PYTHON_LOADER,
  readSampleMeta,
  readSampleZip,
  SAMPLE_ADMIN_PATH,
  SAMPLE_DIR,
  SAMPLE_FILES_PATH,
  SAMPLE_INDEX_PATH,
  SAMPLE_NAME,
  SAMPLE_SCHEMA_PATH,
  SAMPLE_SEED,
  SAMPLE_WITHHELD,
  SAMPLE_ZIP_PATH,
  sampleSchema,
} from "../arena/sample";
import { copyBlock } from "./components";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { verifyCommand } from "./replay-verify";
import { csrfToken } from "./session";

// B3-07 (ADR 0100): the public sample dataset. The zip and its listing are read from the write-once copy in KV; until an
// admin builds it, the page says it isn't published yet and the files are 404. The schema is fixed code.

const FIXED = { "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" };
const TYPES: Record<string, string> = { md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", jsonl: "application/x-ndjson; charset=utf-8", json: "application/json; charset=utf-8" };
const typeOf = (name: string) => (name === "SHA256SUMS" ? TYPES.txt! : name === "croissant.json" ? "application/ld+json; charset=utf-8" : (TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream"));

site.get(SAMPLE_ZIP_PATH, async (c) => {
  const meta = await readSampleMeta(c.env);
  const zip = meta ? await readSampleZip(c.env, meta) : null;
  if (!meta || !zip) return c.json({ error: "not_published_yet", page: `${c.env.PUBLIC_ORIGIN}${SAMPLE_DIR}` }, 404, { "Cache-Control": "no-store" });
  return new Response(zip, {
    headers: { ...FIXED, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${meta.zip.name}"`, ETag: `"${meta.zip.sha256}"`, "X-Content-SHA256": meta.zip.sha256 },
  });
});

site.get(SAMPLE_SCHEMA_PATH, (c) => c.json(sampleSchema(c.env.PUBLIC_ORIGIN), 200, FIXED));

site.get(SAMPLE_INDEX_PATH, async (c) => {
  const meta = await readSampleMeta(c.env);
  return c.json(
    meta
      ? { status: "published", ...meta, files: meta.files.map((f) => ({ ...f, url: `${c.env.PUBLIC_ORIGIN}${SAMPLE_FILES_PATH}/${f.name}` })), schema: `${c.env.PUBLIC_ORIGIN}${SAMPLE_SCHEMA_PATH}` }
      : { status: "not_published_yet", name: SAMPLE_NAME, seed: SAMPLE_SEED, schema: `${c.env.PUBLIC_ORIGIN}${SAMPLE_SCHEMA_PATH}` },
    200,
    // Not cached until published, so the listing appears as soon as the sample is built.
    { "Cache-Control": meta ? "public, max-age=300" : "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" },
  );
});

/** One file of the zip, unzipped (the "listing" view). */
site.get(`${SAMPLE_FILES_PATH}/*`, async (c) => {
  const name = decodeURIComponent(c.req.path.slice(SAMPLE_FILES_PATH.length + 1));
  const meta = await readSampleMeta(c.env);
  if (!meta || !meta.files.some((f) => f.name === name)) return c.notFound();
  const zip = await readSampleZip(c.env, meta);
  const data = zip ? unzipStore(zip).get(name) : undefined;
  if (!data) return c.notFound();
  return new Response(data, { headers: { ...FIXED, "Content-Type": typeOf(name), "X-Content-SHA256": meta.files.find((f) => f.name === name)!.sha256 } });
});

const sampleBody = (origin: string, meta: Awaited<ReturnType<typeof readSampleMeta>>) => html`<h1 class="page-title">Sample dataset ${meta?.version ?? "v1"}</h1>
<p>A small, fixed sample of The Forge's trap data: each record is one public trap in one public Arena bout, with the model's tool calls in order, whether it fell for the trap, the safe behaviour the referee accepts and the sandbox amount at stake. It is drawn by a seeded random pick within strata (seed <code>${SAMPLE_SEED}</code>) from bouts <a href="/arena/dataset.json">the public dataset</a> already lists, and includes two raw signed replays you can verify yourself.</p>
${
  meta
    ? html`<p><a class="btn chamfer" href="${SAMPLE_ZIP_PATH}" download>Download ${meta.zip.name}</a> ${meta.zip.bytes.toLocaleString("en-US")} bytes · built ${meta.built_at.slice(0, 10)}</p>
<p class="small">SHA-256 of the zip: <code>${meta.zip.sha256}</code>. The file never changes: a new sample is a new version with a new name.</p>
<p>${meta.counts.records} records (${meta.counts.falls} falls, ${meta.counts.passes} passes), ${meta.counts.models} models, ${meta.counts.trap_kinds} trap kinds. Same seed, job and trap, one pass and one fall: ${meta.pair.trap_id} on <code>${meta.pair.task}</code>.</p>
<h2 id="files">Files</h2>
<div class="table-wrap"><table class="table"><thead><tr><th>File</th><th>Bytes</th><th>SHA-256</th></tr></thead><tbody>
${meta.files.map((f) => html`<tr><td><a href="${SAMPLE_FILES_PATH}/${f.name}">${f.name}</a></td><td>${f.bytes.toLocaleString("en-US")}</td><td><code class="small">${f.sha256}</code></td></tr>`)}
</tbody></table></div>
<h2 id="verify">Verify a replay</h2>
${copyBlock("sample-verify", verifyCommand(`replays/${meta.replays[0]}.json`))}`
    : html`<p class="notice"><b>Not published yet.</b> The sample is built once from the public bouts and then fixed; this page lists its files and checksums once it is.</p>`
}
<h2 id="load">Load it in Python</h2>
<pre class="verdict-line"><code>${PYTHON_LOADER}</code></pre>
<p class="small">Each line validates against <a href="${SAMPLE_SCHEMA_PATH}">the record schema</a> (JSON Schema 2020-12). Machine-readable listing: <a href="${SAMPLE_INDEX_PATH}">${SAMPLE_INDEX_PATH}</a>.</p>
<h2 id="withheld">What is withheld</h2>
<ul>${SAMPLE_WITHHELD.map((w) => html`<li>${w.charAt(0).toUpperCase()}${w.slice(1)}.</li>`)}</ul>
<h2 id="licence">Licence</h2>
<p>${DATASET_LICENCE} <a href="${LICENCE_PATH}">Full terms</a>.</p>
<p>${COMMERCIAL_LICENCE_LINE}</p>
<p class="small muted">More: <a href="/benchmark">the Trap Set</a> · <a href="/security">security overview</a> · <a href="/arena/croissant.json">Croissant for the full public dataset</a>.</p>`;

site.get(SAMPLE_DIR, async (c) => {
  const meta = await readSampleMeta(c.env);
  return send(c, { title: "Sample dataset", description: "A fixed, checksummed sample of The Forge's trap data with signed replays, for evaluation.", path: SAMPLE_DIR, body: sampleBody(c.env.PUBLIC_ORIGIN, meta) }, { cache: !!meta });
});
site.get(`${SAMPLE_DIR}/`, (c) => c.redirect(SAMPLE_DIR, 301));

// --- Admin: build once ---------------------------------------------------------------------------------------------

type Ctx = Parameters<typeof currentSession>[0];
const PRIVATE = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow, noarchive" };

async function adminOf(c: Ctx) {
  const s = await currentSession(c);
  if (!s) return null;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return me && isAdmin(c.env, me.githubId) ? s : null;
}

site.get(SAMPLE_ADMIN_PATH, async (c) => {
  const s = await adminOf(c);
  if (!s) return c.redirect("/dashboard");
  const meta = await readSampleMeta(c.env);
  const csrf = await csrfToken(c.env.SESSION_SECRET, s.token);
  const note = c.req.query("refused");
  const res = await send(
    c,
    {
      title: "Sample dataset (admin)",
      description: "Internal.",
      path: SAMPLE_ADMIN_PATH,
      noindex: true,
      body: html`<h1 class="page-title">Public sample dataset</h1>
<p>Builds <code>${SAMPLE_NAME}.zip</code> once from the public bouts (seed ${SAMPLE_SEED}) and fixes it: after that it can't be rebuilt or changed. Public page: <a href="${SAMPLE_DIR}">${SAMPLE_DIR}</a>.</p>
${note ? html`<p class="notice warn">Not built: ${note}</p>` : ""}
${
  meta
    ? html`<p><b>Published</b> ${meta.built_at}: ${meta.counts.records} records, zip SHA-256 <code>${meta.zip.sha256}</code>.</p>`
    : html`<form method="post" action="${SAMPLE_ADMIN_PATH}"><input type="hidden" name="csrf" value="${csrf}"><button class="btn chamfer" type="submit">Build sample ${SAMPLE_NAME}</button></form>`
}`,
    },
    { cache: false },
  );
  for (const [k, v] of Object.entries(PRIVATE)) res.headers.set(k, v);
  return res;
});

site.post(SAMPLE_ADMIN_PATH, async (c) => {
  const g = await guardPost(c);
  if (!g) return c.text("forbidden", 403, PRIVATE);
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, g.session.h) });
  if (!me || !isAdmin(c.env, me.githubId)) return c.text("forbidden", 403, PRIVATE);
  const r = await publishSample(c.env, Date.now(), `human:${me.id}`);
  if (r.status === "refused") return c.redirect(`${SAMPLE_ADMIN_PATH}?refused=${encodeURIComponent(r.error)}`, 303);
  return c.redirect(SAMPLE_ADMIN_PATH, 303);
});
