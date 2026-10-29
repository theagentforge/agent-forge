import { eq } from "drizzle-orm";
import { html } from "hono/html";
import { unzipStore } from "../services/zip";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { COMMERCIAL_LICENCE_CONTACT, DATASET_LICENCE, LICENCE_PATH } from "../services/provenance";
import {
  COMMERCIAL_LICENCE_LINE,
  countLine,
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
import { copyBlock, disclosure, more, statStrip } from "./components";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { verifyCommand } from "./replay-verify";
import { csrfToken } from "./session";

// B3-07 (ADR 0100): the public sample dataset. The zip and its listing are read from the write-once copy in KV (built
// once by an admin; published 29 Oct 2026). Without that copy the files are 404 and the page says they can't be read
// here. The schema is fixed code.

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

const builtDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Site audit 29 Oct (§3.4; Dinike: the sample is published, 40 records). The page leads with what the file is and the
 * download, then its numbers; files, checksums and what is withheld sit one click down. Without a stored sample (a
 * fresh local or test database) it says the files can't be read here and shows no loader for a file it can't serve.
 */
const sampleBody = (origin: string, meta: Awaited<ReturnType<typeof readSampleMeta>>) => html`<h1 class="page-title">Sample dataset ${meta?.version ?? "v1"}</h1>
<p class="lead">A small, fixed set of records from public Arena bouts. Each is one public trap in one bout: the model's tool calls in order, whether it fell for the trap, and the safe behaviour the referee accepts.</p>
${
  meta
    ? html`<p><a class="btn primary chamfer" href="${SAMPLE_ZIP_PATH}" download>Download the sample</a></p>
<p class="small muted"><code class="mono-break">${meta.zip.name}</code>, ${meta.zip.bytes.toLocaleString("en-US")} bytes · built ${builtDay(meta.built_at)} · evaluation only, not for training. The file never changes: a new sample is a new version with a new name.</p>
${statStrip({
        label: "What the sample holds",
        main: [
          { value: meta.counts.records, label: "records" },
          { value: meta.counts.falls, label: "falls" },
          { value: meta.counts.passes, label: "passes" },
          { value: meta.counts.models, label: meta.counts.models === 1 ? "model" : "models" },
          { value: meta.counts.trap_kinds, label: "trap kinds" },
        ],
        caption: disclosure(
          typeof meta.counts.records_v2 === "number"
            ? countLine(meta.counts.records, meta.counts.records_v2, meta.replays.length)
            : `${meta.counts.records} records and ${meta.replays.length} signed v2 replays.`,
        ),
      })}
<p>Drawn by a seeded random pick within strata (seed <code>${SAMPLE_SEED}</code>) from bouts <a href="/arena/dataset.json">the public dataset</a> already lists. One pair shares the job version, seed and trap${meta.pair.ruleset_version ? `, scored by ${meta.pair.ruleset_version}` : ""}: one pass and one fall on ${meta.pair.trap_id} (<code>${meta.pair.task}</code>).</p>
<h2 id="verify">Verify a replay</h2>
${meta.replays[0] ? html`<p>Every record states its replay format and how it can be checked. The signed v2 replays in the zip verify with one command:</p>${copyBlock("sample-verify", verifyCommand(`replays/${meta.replays[0]}.json`))}` : html`<p>This zip ships no raw replay. A v2 record's <code>replay_url</code> verifies with <code>forge verify</code>; a v1 record's replay has no public signature.</p>`}
<h2 id="load">Load it in Python</h2>
<pre class="verdict-line"><code>${PYTHON_LOADER}</code></pre>
<p class="small">Each line validates against <a href="${SAMPLE_SCHEMA_PATH}">the record schema</a> (JSON Schema 2020-12). Machine-readable listing: <a href="${SAMPLE_INDEX_PATH}">${SAMPLE_INDEX_PATH}</a>.</p>
${more(
        html`<span id="files">Files and checksums</span>`,
        html`<p class="small">SHA-256 of the zip: <code class="mono-break">${meta.zip.sha256}</code></p>
<ul class="small">${meta.files.map((f) => html`<li><a href="${SAMPLE_FILES_PATH}/${f.name}">${f.name}</a>, ${f.bytes.toLocaleString("en-US")} bytes<br><code class="mono-break">${f.sha256}</code></li>`)}</ul>`,
        { hint: `${meta.files.length} files, each with its SHA-256` },
      )}`
    : html`<p class="notice">The sample's files can't be read here right now. Email <a href="mailto:${COMMERCIAL_LICENCE_CONTACT}">${COMMERCIAL_LICENCE_CONTACT}</a> for a copy; its record schema is <a href="${SAMPLE_SCHEMA_PATH}">here</a>.</p>`
}
${more(html`<span id="withheld">What is withheld</span>`, html`<ul>${SAMPLE_WITHHELD.map((w) => html`<li>${w.charAt(0).toUpperCase()}${w.slice(1)}.</li>`)}</ul>`, { hint: "Held-out seeds, private trap families, the generator, embargoed models" })}
<h2 id="licence">Licence</h2>
<p>${DATASET_LICENCE} <a href="${LICENCE_PATH}">Full terms</a>.</p>
<p>${COMMERCIAL_LICENCE_LINE}</p>
<p class="small muted">More: <a href="/dataset">the dataset spec</a> · <a href="/benchmark">the Trap Set</a> · <a href="/security">security overview</a> · <a href="/arena/croissant.json">Croissant for the full public dataset</a>.</p>`;

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
