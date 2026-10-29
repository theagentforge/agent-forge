import { feedIndex, modifiedCsv, OSV_FEED_PATH, OSV_SCHEMA_URL, osvRecords } from "../services/osv-feed";
import { zipStore } from "../services/zip";
import { site } from "./pages";

// AQ-10 (ADR 0097): the OSV feed. Structured data only; every response links the OSV schema (describedby) and the
// licence. Cached at the edge for 10 minutes: a record never appears before its date, and may lag it by that much.

const CACHE = "public, max-age=600";
const headers = (c: { env: Env }, type: string) => ({
  "Content-Type": type,
  "Cache-Control": CACHE,
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  Link: `<${OSV_SCHEMA_URL}>; rel="describedby", <${c.env.PUBLIC_ORIGIN}/benchmark/licence>; rel="license"`,
});
const JSON_TYPE = "application/json; charset=utf-8";

const index = async (c: { env: Env }) =>
  new Response(JSON.stringify(feedIndex(c.env.PUBLIC_ORIGIN, await osvRecords(c.env, c.env.PUBLIC_ORIGIN))), { headers: headers(c, JSON_TYPE) });

site.get(OSV_FEED_PATH, (c) => index(c));
site.get(`${OSV_FEED_PATH}/index.json`, (c) => index(c));

site.get(`${OSV_FEED_PATH}/all.json`, async (c) => new Response(JSON.stringify(await osvRecords(c.env, c.env.PUBLIC_ORIGIN)), { headers: headers(c, JSON_TYPE) }));

site.get(`${OSV_FEED_PATH}/modified_id.csv`, async (c) => new Response(modifiedCsv(await osvRecords(c.env, c.env.PUBLIC_ORIGIN)), { headers: headers(c, "text/csv; charset=utf-8") }));

site.get(`${OSV_FEED_PATH}/all.zip`, async (c) => {
  const recs = await osvRecords(c.env, c.env.PUBLIC_ORIGIN);
  const enc = new TextEncoder();
  const zip = zipStore(recs.map((r) => ({ name: `${r.id}.json`, data: enc.encode(JSON.stringify(r, null, 2)), modified: new Date(r.modified) })));
  return new Response(zip, { headers: { ...headers(c, "application/zip"), "Content-Disposition": 'attachment; filename="forge-osv-all.zip"' } });
});

site.get(`${OSV_FEED_PATH}/:file{x_FORGE-[0-9]{4}-[0-9A-F]{12}\\.json}`, async (c) => {
  const id = c.req.param("file").replace(/\.json$/, "");
  const rec = (await osvRecords(c.env, c.env.PUBLIC_ORIGIN)).find((r) => r.id === id);
  // Unknown and not-yet-published ids answer alike.
  if (!rec) return c.json({ error: "not_found" }, 404, { "Cache-Control": CACHE, "Access-Control-Allow-Origin": "*" });
  return new Response(JSON.stringify(rec), { headers: headers(c, JSON_TYPE) });
});
