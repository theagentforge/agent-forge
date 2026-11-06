import { html } from "hono/html";
import {
  FAMILY_NOTES,
  HISTORY_CACHE_SECONDS,
  HISTORY_CONTRACT,
  HISTORY_CONTRACT_VERSION,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_DOCS_PATH,
  HISTORY_MAX_LIMIT,
  HISTORY_ROUTE,
  HISTORY_SECTIONS,
  ORIGIN_NOTES,
} from "../services/server-history";
import { send, sendJson, site, wantsJson } from "./pages";

// ADR 0141: the short docs page for contract forge.server-history/v1 (GET /api/v1/history/{server}). Wording rules:
// no "safe", no certification, a rule match is a pattern, never "malicious". No counts on this page.

export const CONSUMER_SCRIPT = "scripts/examples/history-consumer.mjs";
const EXAMPLE = "npm:@modelcontextprotocol/server-filesystem";

/** The contract as data (the page's JSON twin). */
export function historyContractData(origin: string) {
  return {
    contract: HISTORY_CONTRACT,
    contract_version: HISTORY_CONTRACT_VERSION,
    endpoint: `${origin}${HISTORY_ROUTE}/{server}`,
    mcp: { endpoint: `${origin}/mcp/requests`, tool: "forge_server_history" },
    openapi: `${origin}/openapi.json`,
    auth: "none",
    rate_limit: { per_address_per_minute: 60 },
    cache: { max_age_s: HISTORY_CACHE_SECONDS, etag: "strong, sha256 of the body; If-None-Match gives 304" },
    sections: HISTORY_SECTIONS,
    paging: { default_limit: HISTORY_DEFAULT_LIMIT, max_limit: HISTORY_MAX_LIMIT, next: "each section's next URL, null on the last page" },
    families: FAMILY_NOTES,
    origins: ORIGIN_NOTES,
    versioning: "minor versions only add fields; removing or renaming a field is a new contract (v2) at a new path",
    public_tier: "hashes, counts, dates and rule ids; no tool text",
    consumer_script: CONSUMER_SCRIPT,
  };
}

site.get(HISTORY_DOCS_PATH, async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  if (wantsJson(c)) return sendJson(c, historyContractData(origin));
  const example = `${origin}${HISTORY_ROUTE}/${encodeURIComponent(EXAMPLE)}`;
  return send(c, {
    title: "Server history API",
    description: "One MCP server's dated record across versions: House install outcomes, tool-definition hashes and change events. No account or key.",
    path: HISTORY_DOCS_PATH,
    jsonAlternate: `${HISTORY_DOCS_PATH}?format=json`,
    body: html`<div class="prose">
<h1 class="page-title">Server history API</h1>
<p class="muted">Contract <code>${HISTORY_CONTRACT}</code> · version ${HISTORY_CONTRACT_VERSION}</p>
<p class="lead">One npm or PyPI MCP server's dated record across its versions: what happened when the House tester installed each version, a hash of the tool definitions each version listed, and what changed between consecutive versions. No account or key.</p>
<h2>Request</h2>
<pre><code>GET ${HISTORY_ROUTE}/{server}?section=all&amp;limit=${HISTORY_DEFAULT_LIMIT}</code></pre>
<p><code>server</code> is <code>npm:name</code>, <code>npm:@scope/name</code> or <code>pypi:name</code>, without a version, URL-encoded. Example: <a href="${example}"><code>${example}</code></a>. Optional: <code>section</code> (all, ${HISTORY_SECTIONS.join(", ")}), <code>limit</code> (1 to ${HISTORY_MAX_LIMIT}) and <code>offset</code> (with one section). Each section has a <code>next</code> URL for its next page.</p>
<p>The same record is the <code>forge_server_history</code> tool on the <code>/mcp/requests</code> MCP endpoint. Machine-readable description: <a href="/openapi.json">/openapi.json</a>.</p>
<h2>Response</h2>
<ul>
<li><b>install_outcomes</b>: one row per test, with its date, version, outcome and failure class (failure-classes/v1). Every row names its <b>family</b>: the nightly top-500 run, the weekly sweep or the backfill of older versions. Counts are per family and never added together.</li>
<li><b>definitions</b>: per version, the sha256 of the tool definitions and how many tools it listed. <code>published_at</code> (the registry's publish date) is kept apart from <code>observed_at</code> (when we read it): a backfilled version is what it lists when installed today.</li>
<li><b>changes</b>: consecutive definition sets compared: tools added or removed, descriptions or input schemas changed, whether the major version moved, and the ids of scanner rules the new text matched that the old text did not. A rule match is a pattern for a person to read, not a finding about the server.</li>
<li><b>data_as_of</b>: the newest timestamp among the rows read. A server with no rows answers <code>status: "not_yet_measured"</code>.</li>
</ul>
<p>The public tier has hashes, counts, dates and rule ids only; the tool text itself is not in it.</p>
<h2>Caching and limits</h2>
<p>Answers are cached for ${HISTORY_CACHE_SECONDS / 60} minutes and carry a strong <code>ETag</code>; send it back in <code>If-None-Match</code> for a 304. 60 calls a minute per address; over that, 429 with <code>Retry-After</code>. The headers <code>X-Forge-Contract</code> and <code>X-Forge-Contract-Version</code> name the contract.</p>
<h2>Versioning</h2>
<p>Minor versions only add fields. Removing or renaming a field is a new contract (v2) at a new path; v1 keeps answering.</p>
<h2>Sample consumer</h2>
<p><code>node ${CONSUMER_SCRIPT} ${EXAMPLE}</code> fetches one server's record, checks the contract version and prints its change events. It is in the public code repository.</p>
</div>`,
  });
});
