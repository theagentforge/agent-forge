import { html } from "hono/html";
import { CENSUS_DIR, CENSUS_STATEMENT, censusFile, latestBundle, manifest, versionManifest } from "../services/census";
import { send, site } from "./pages";

// ADR 0129: the census dataset files at stable URLs. Each is served from the latest published version, frozen once a
// day by the cron (services/census.ts), so a file always matches its sha256 in manifest.json. The page and the
// manifest are registered before the wildcard, which in Hono also matches the bare directory path.

const HEADERS = { "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "X-Robots-Tag": "noindex" };
const typeOf = (path: string) => (path.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
const notYet = (origin: string) => ({ error: "not_published_yet", page: `${origin}${CENSUS_DIR}` });

site.get(`${CENSUS_DIR}/`, (c) => c.redirect(CENSUS_DIR, 301));

site.get(`${CENSUS_DIR}/manifest.json`, async (c) => {
  const bundle = await latestBundle(c.env);
  if (!bundle) return c.json(notYet(c.env.PUBLIC_ORIGIN), 404, { ...HEADERS, "Cache-Control": "no-store" });
  return c.json(await manifest(c.env, bundle), 200, { ...HEADERS, "Cache-Control": "public, max-age=300" });
});

// One published version's file list, kept for good in D1 (review of ADR 0129: manifest.json links to these rather than
// carrying every version's full list, which would grow with the square of the record).
site.get(`${CENSUS_DIR}/manifest/:file{[0-9]{4}-[0-9]{2}-[0-9]{2}\\.json}`, async (c) => {
  const m = await versionManifest(c.env, c.req.param("file").slice(0, 10));
  if (!m) return c.json({ error: "not_found", manifest: `${c.env.PUBLIC_ORIGIN}${CENSUS_DIR}/manifest.json` }, 404, HEADERS);
  return c.json(m, 200, { ...HEADERS, "Cache-Control": "public, max-age=86400" });
});

const MAIN = ["series.csv", "series.json", "schema.json"];

site.get(CENSUS_DIR, async (c) => {
  const bundle = await latestBundle(c.env);
  const rosters = bundle ? bundle.hashes.filter((h) => h.path.startsWith("roster/")) : [];
  const months = bundle ? bundle.hashes.filter((h) => h.path.startsWith("server-history/")) : [];
  const latestRoster = rosters.at(-1);
  const body = html`<h1 class="page-title">Census dataset</h1>
<p class="lead">${CENSUS_STATEMENT}</p>
<p>Daily figures from the House tester's install checks, tool-description scans, skill-file scans and the tools tracked, built from stored data only. A day before a metric was first measured is absent, never a zero. Days are UTC.</p>
${
  bundle
    ? html`<p class="small muted">Version ${bundle.version} (data through the end of that UTC day).</p>
<ul>
${MAIN.map((p) => html`<li><a href="${CENSUS_DIR}/${p}">${p}</a></li>`)}
${months.map((h) => html`<li><a href="${CENSUS_DIR}/${h.path}">${h.path}</a></li>`)}
<li><a href="${CENSUS_DIR}/manifest.json">manifest.json</a>: the sha256 of every file in this version, and every earlier version's manifest</li>
${latestRoster ? html`<li><a href="${CENSUS_DIR}/${latestRoster.path}">${latestRoster.path}</a>: the latest nightly top-500 roster (${rosters.length} nights in the manifest)</li>` : ""}
</ul>`
    : html`<p class="notice">The first version isn't published yet. It is built once a day from stored data.</p>`
}
<p class="small muted">More: <a href="/dataset">the dataset spec</a> · <a href="/reports/house">the House Report</a>.</p>`;
  return send(c, { title: "Census dataset", description: CENSUS_STATEMENT, path: CENSUS_DIR, noindex: true, body }, { cache: !!bundle });
});

site.get(`${CENSUS_DIR}/*`, async (c) => {
  const path = decodeURIComponent(c.req.path.slice(CENSUS_DIR.length + 1));
  const bundle = await latestBundle(c.env);
  if (!bundle) return c.json(notYet(c.env.PUBLIC_ORIGIN), 404, { ...HEADERS, "Cache-Control": "no-store" });
  const file = await censusFile(c.env, bundle, path);
  if (!file) return c.json({ error: "not_found", manifest: `${c.env.PUBLIC_ORIGIN}${CENSUS_DIR}/manifest.json` }, 404, HEADERS);
  const { body, sha256: hash } = file;
  return new Response(body, { headers: { ...HEADERS, "Content-Type": typeOf(path), "Cache-Control": "public, max-age=300", ETag: `"${hash}"`, "X-Content-SHA256": hash, "X-Census-Version": bundle.version } });
});
