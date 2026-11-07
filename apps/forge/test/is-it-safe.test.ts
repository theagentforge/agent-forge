import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { osvPackageFor } from "../src/services/advisories";
import { registryTransport } from "../src/services/registry";
import { canonicalPackageName, isListedPackage, TOP_NPM, TOP_PACKAGE_PATHS, TOP_PYPI } from "../src/services/top-packages";
import { sitemapPaths } from "../src/web/answers";
import { advisoryKind, CLEAR_MEANING, NO_MATCH_STATUS, packageAnswer, type PackageAnswer } from "../src/web/is-it-safe";
import { parseOsvVuln } from "../src/services/advisories";
import eventStreamOsv from "./fixtures/osv/ghsa-event-stream.json";
import { LIMITED_PAGE } from "../src/web/pages";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

// Build list item 14 (ADR 0127): "Is <package> safe to install?" pages for listed npm and PyPI packages, from OSV
// (recorded: test/osv-fake.ts) and the registries (recorded here), with no "is safe" claim anywhere.

const O = env.PUBLIC_ORIGIN;
let ip = 0;
/** A fresh IP and a cache-busting query per request, so neither the edge cache nor the per-IP limiter carries over. */
const get = (path: string, accept = "text/html") => fetchWorker(`${path}${path.includes("?") ? "&" : "?"}v=${Date.now()}-${ip}`, { headers: { Accept: accept, "CF-Connecting-IP": `198.51.100.${(ip++ % 200) + 1}` }, redirect: "manual" });

/** The registries answer `latest` for these packages and nothing else. */
function registry(latest: Record<string, string>) {
  registryTransport.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [id, version] of Object.entries(latest)) {
      const [eco, name] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
      if (eco === "npm" && url === `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`) return Response.json({ name, version, dist: { integrity: `sha512-${name}` } });
      if (eco === "pypi" && url === `https://pypi.org/pypi/${name}/json`) return Response.json({ info: { version }, urls: [{ packagetype: "sdist", filename: `${name}-${version}.tar.gz`, digests: { sha256: "a".repeat(64) } }] });
    }
    return new Response("offline", { status: 503 });
  }) as typeof fetch;
}
const offline = registryTransport.fetch;
afterEach(async () => {
  registryTransport.fetch = offline;
  for (const id of ["npm:express", "npm:event-stream", "npm:lodash", "pypi:litellm", "npm:left-pad", "npm:@modelcontextprotocol/sdk", "pypi:requests"]) await env.KV.delete(`reglatest:${id}`);
});

/** The page without the one sentence that names "safe" in order to deny it. */
const claims = (text: string) => text.split(CLEAR_MEANING).join(" ").split(JSON.stringify(CLEAR_MEANING).slice(1, -1)).join(" ");
const NO_SAFE_CLAIM = /\b(is|are|looks|seems|considered)\s+(totally\s+|completely\s+)?(safe|secure)\b|\bsafe to use\b|\bno risk\b/i;

describe("the package list", () => {
  it("has about 100 npm and 50 PyPI packages, canonical, unique, with the agent ecosystem in", () => {
    expect(TOP_NPM.length).toBeGreaterThanOrEqual(100);
    expect(TOP_PYPI.length).toBeGreaterThanOrEqual(50);
    expect(new Set(TOP_NPM).size).toBe(TOP_NPM.length);
    expect(new Set(TOP_PYPI).size).toBe(TOP_PYPI.length);
    for (const name of TOP_NPM) expect(canonicalPackageName("npm", name), name).toBe(name);
    for (const name of TOP_PYPI) expect(canonicalPackageName("pypi", name), name).toBe(name);
    for (const name of ["express", "react", "lodash", "axios", "@modelcontextprotocol/sdk", "@modelcontextprotocol/server-filesystem", "openai", "langchain"]) expect(isListedPackage("npm", name), name).toBe(true);
    for (const name of ["requests", "numpy", "litellm", "langchain", "openai", "anthropic", "mcp"]) expect(isListedPackage("pypi", name), name).toBe(true);
    expect(TOP_PACKAGE_PATHS).toContain("/is-it-safe/npm/@modelcontextprotocol/sdk");
    expect(TOP_PACKAGE_PATHS).toContain("/is-it-safe/pypi/requests");
    for (const p of TOP_PACKAGE_PATHS) expect(osvPackageFor(p.replace(/^\/is-it-safe\/(npm|pypi)\//, "$1:")), p).not.toBeNull();
  });
});

describe("package answers", () => {
  it("no match on the latest release, with an older advisory: the status says so, never a bare clear, with the Forge's wording", async () => {
    registry({ "npm:lodash": "4.17.21" });
    const a = (await packageAnswer(env, "npm", "lodash"))!;
    expect(a).toMatchObject({ listed: true, version: "4.17.21", version_source: "registry_latest", security_status: "clear", status_basis: "no_match_on_version", verdict: "insufficient" });
    expect(a.advisories).toMatchObject({ checked: true, matching_version: 0, other_versions: 1, any_version: 1 });
    expect(a.advisories.list[0]).toMatchObject({ id: "GHSA-35jh-r3h4-6jhm", affects_version: false, fixed: ["4.17.21"] });
    const res = await get("/is-it-safe/npm/lodash");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<title>Is npm:lodash 4.17.21 safe to install?");
    expect(page).toContain("the latest release of lodash on npm is 4.17.21");
    expect(page).toContain("No published advisory (OSV) matches 4.17.21; 1 more affects older versions only");
    expect(page).toContain("No advisory matches this version: 1 published advisory (OSV) for lodash exists, and none matched 4.17.21");
    expect(page).toContain(`Security status: <strong>${NO_MATCH_STATUS}</strong>`);
    expect(page).not.toContain("Security status: <strong>clear</strong>");
    expect(page).toContain(CLEAR_MEANING);
    expect(page).toContain("npx @theagentforge/cli check npm:lodash@4.17.21");
    expect(page).toContain('href="https://osv.dev/list?ecosystem=npm&amp;q=lodash"');
    expect(page).toContain('href="https://www.npmjs.com/package/lodash"');
    expect(page).toContain('href="/methodology"');
    expect(page).not.toContain('name="robots"');
    expect(claims(page)).not.toMatch(NO_SAFE_CLAIM);
  });

  it("advisory: a vulnerability on the latest release is caution; a malicious-package record is flagged, never confirmed", async () => {
    registry({ "npm:lodash": "4.17.20", "pypi:litellm": "1.107.0" });
    const lodash = (await packageAnswer(env, "npm", "lodash"))!;
    expect(lodash).toMatchObject({ security_status: "caution", status_basis: "advisory_on_version", verdict: "caution" });
    expect(lodash.advisories).toMatchObject({ matching_version: 1, other_versions: 0 });
    expect(lodash.advisories.list[0]).toMatchObject({ id: "GHSA-35jh-r3h4-6jhm", affects_version: true });
    const page = await (await get("/is-it-safe/npm/lodash")).text();
    expect(page).toContain("Caution: 1 published advisory (OSV) matches 4.17.20");
    expect(page).toContain('href="https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm"');
    expect(claims(page)).not.toMatch(NO_SAFE_CLAIM);
    const litellm = (await packageAnswer(env, "pypi", "litellm"))!;
    expect(litellm).toMatchObject({ security_status: "flagged", status_basis: "malicious_record_on_version", verdict: "flagged" });
    expect(litellm.advisories.malicious_records).toBe(1);
    const lp = await (await get("/is-it-safe/pypi/litellm")).text();
    expect(lp).toContain("Flagged: a published OSV record of malicious code matches 1.107.0");
    expect(lp).toContain("malicious-package record");
    expect(lp).not.toMatch(/confirmed malicious|Ignore previous/i);
    expect(claims(lp)).not.toMatch(NO_SAFE_CLAIM);
  });

  it("event-stream: OSV's GHSA-mh6f-8j2x-4483 (CWE-506) stays a malicious-code record, never 'vulnerability'; 4.0.1 isn't matched", async () => {
    // The real record (fixtures/osv/README.md): no MAL- id, database_specific.cwe_ids ["CWE-506"], affects 3.3.6 only.
    const rec = parseOsvVuln(eventStreamOsv.vulns[0] as Parameters<typeof parseOsvVuln>[0], { ecosystem: "npm", name: "event-stream" }, "3.3.6")!;
    expect(rec).toMatchObject({ id: "GHSA-mh6f-8j2x-4483", kind: "malicious", malicious_by: "cwe_506", aliases: [], fixed: ["4.0.0"] });
    expect(JSON.stringify(rec)).not.toMatch(/flatmap|considered malicious|downgrade/i);
    expect(advisoryKind(rec)).toBe("malicious-code record (CWE-506: embedded malicious code)");
    registry({ "npm:event-stream": "4.0.1" });
    const a = (await packageAnswer(env, "npm", "event-stream"))!;
    expect(a).toMatchObject({ version: "4.0.1", security_status: "clear", status_basis: "no_match_on_version" });
    expect(a.advisories).toMatchObject({ matching_version: 0, other_versions: 1, any_version: 1, malicious_records: 1 });
    expect(a.advisories.list[0]).toMatchObject({ id: "GHSA-mh6f-8j2x-4483", kind: "malicious", malicious_by: "cwe_506", affects_version: false });
    const page = await (await get("/is-it-safe/npm/event-stream")).text();
    expect(page).toContain("<title>Is npm:event-stream 4.0.1 safe to install?");
    expect(page).toContain('<h1 class="page-title">Is npm:event-stream 4.0.1 safe to install?</h1>');
    expect(page).toContain(`Security status: <strong>${NO_MATCH_STATUS}</strong>`);
    expect(page).toContain("Security status: No advisory matches this version.");
    expect(page).toContain("No advisory matches this version: 1 published advisory (OSV) for event-stream exists, and none matched 4.0.1");
    expect(page).toContain('<td data-label="Kind">malicious-code record (CWE-506: embedded malicious code)</td>');
    expect(page).not.toContain('<td data-label="Kind">vulnerability</td>');
    expect(page).toContain(CLEAR_MEANING);
    expect(page).not.toMatch(/Security status: <strong>clear<\/strong>|confirmed malicious/);
    expect(claims(page)).not.toMatch(NO_SAFE_CLAIM);
  });

  it("express: two vulnerabilities on older versions only are listed as vulnerabilities, under the no-match status", async () => {
    registry({ "npm:express": "5.3.0" });
    const a = (await packageAnswer(env, "npm", "express"))!;
    expect(a).toMatchObject({ version: "5.3.0", security_status: "clear", status_basis: "no_match_on_version" });
    expect(a.advisories).toMatchObject({ matching_version: 0, other_versions: 2, any_version: 2, malicious_records: 0 });
    expect(a.advisories.list.map((x) => [x.id, x.kind, x.affects_version])).toEqual([
      ["GHSA-rv95-896h-c2vc", "vulnerability", false],
      ["GHSA-qw6h-vgh9-j6wx", "vulnerability", false],
    ]);
    expect(a.advisories.list.every((x) => !("malicious_by" in x))).toBe(true);
    const page = await (await get("/is-it-safe/npm/express")).text();
    expect(page).toContain("<title>Is npm:express 5.3.0 safe to install?");
    expect(page).toContain(`Security status: <strong>${NO_MATCH_STATUS}</strong>`);
    expect(page).toContain("No advisory matches this version: 2 published advisories (OSV) for express exist, and none matched 5.3.0");
    expect(page.match(/<td data-label="Kind">vulnerability<\/td>/g)).toHaveLength(2);
    expect(page).toContain(CLEAR_MEANING);
    expect(claims(page)).not.toMatch(NO_SAFE_CLAIM);
  });

  it("a package with no advisory history at all keeps the plain clear status", async () => {
    registry({ "npm:left-pad": "1.3.0" });
    const page = await (await get("/is-it-safe/npm/left-pad")).text();
    expect(page).toContain("Security status: <strong>clear</strong>");
    expect(page).toContain("Clear: no published advisory (OSV) matched 1.3.0");
    expect(page).toContain(CLEAR_MEANING);
  });

  it("unknown: a listed package whose registry doesn't answer still has a page, saying unknown, never clear", async () => {
    const a = (await packageAnswer(env, "npm", "express"))!;
    expect(a).toMatchObject({ listed: true, version: null, version_source: null, security_status: "unknown", status_basis: "version_unavailable", verdict: "insufficient" });
    const res = await get("/is-it-safe/npm/express");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Unknown: the registry didn&#39;t answer");
    expect(page).toContain("Unknown is not clear.");
    expect(page).toContain("npx @theagentforge/cli check npm:express");
    expect(claims(page)).not.toMatch(NO_SAFE_CLAIM);
  });

  it("a scoped npm package and a PyPI package render under one stable address each", async () => {
    registry({ "npm:@modelcontextprotocol/sdk": "1.20.0", "pypi:requests": "2.32.5" });
    const sdk = await get("/is-it-safe/npm/@modelcontextprotocol/sdk");
    expect(sdk.status).toBe(200);
    expect(await sdk.text()).toContain("Is npm:@modelcontextprotocol/sdk 1.20.0 safe to install?");
    const req = await get("/is-it-safe/pypi/requests");
    expect(req.status).toBe(200);
    expect(await req.text()).toContain("the latest release of requests on PyPI is 2.32.5");
    // Other spellings move to the canonical address.
    const upper = await get("/is-it-safe/pypi/Requests");
    expect(upper.status).toBe(301);
    expect(upper.headers.get("Location")).toMatch(/^\/is-it-safe\/pypi\/requests\?v=/);
    expect((await get("/is-it-safe/npm/Express")).headers.get("Location")).toMatch(/^\/is-it-safe\/npm\/express\?/);
  });

  it("404 for junk: an unlisted name that doesn't resolve, a bad name, another ecosystem", async () => {
    for (const path of ["/is-it-safe/npm/zz-no-such-package-xq", "/is-it-safe/pypi/zz-no-such-package-xq", "/is-it-safe/npm/..%2F..%2Fetc", "/is-it-safe/npm/a%20b", "/is-it-safe/cargo/serde", "/is-it-safe/npm", "/is-it-safe/npm/%E0%A4%A"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      await res.body?.cancel();
    }
    expect(await packageAnswer(env, "npm", "zz-no-such-package-xq")).toBeNull();
  });

  it("an unlisted package that resolves gets a page, kept out of search and the sitemap", async () => {
    registry({ "npm:left-pad": "1.3.0" });
    const res = await get("/is-it-safe/npm/left-pad");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('name="robots" content="noindex, follow"');
    expect(page).toContain("Is npm:left-pad 1.3.0 safe to install?");
    expect((await sitemapPaths(getDb(env))).some((r) => r.path === "/is-it-safe/npm/left-pad")).toBe(false);
  });

  it("the JSON twin is structured data with the counts, the status code and the next check", async () => {
    registry({ "npm:lodash": "4.17.21" });
    const res = await get("/is-it-safe/npm/lodash?format=json", "application/json");
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=1800");
    const j = (await res.json()) as PackageAnswer;
    expect(Object.keys(j)).toEqual(["ecosystem", "package", "tool_id", "listed", "list_version", "as_of", "version", "version_source", "security_status", "status_basis", "verdict", "advisories", "field_reports", "skill_scan", "other_versions_flagged", "check", "sources", "page_url", "markdown_url"]);
    expect(j).toMatchObject({
      ecosystem: "npm",
      package: "lodash",
      tool_id: "npm:lodash",
      version: "4.17.21",
      security_status: "clear",
      advisories: { source: "osv", matching_version: 0, other_versions: 1, list_url: "https://osv.dev/list?ecosystem=npm&q=lodash" },
      field_reports: { on_version: 0, all_versions: 0, outcomes: null },
      skill_scan: null,
      check: { tool: "forge_check", mcp_server: `${O}/mcp/public`, arguments: { id: "npm:lodash", version: "4.17.21" }, rest_url: `${O}/api/v1/check?id=npm%3Alodash&version=4.17.21`, cli: "npx @theagentforge/cli check npm:lodash@4.17.21" },
      sources: { osv: "https://osv.dev/list?ecosystem=npm&q=lodash", registry: "https://www.npmjs.com/package/lodash", methodology: `${O}/methodology` },
      page_url: `${O}/is-it-safe/npm/lodash`,
      markdown_url: `${O}/is-it-safe/npm/lodash.md`,
    });
    expect(Number.isFinite(Date.parse(j.as_of))).toBe(true);
    // Data only: no prose sentences for an agent to follow.
    expect(JSON.stringify(j)).not.toMatch(/\b(you should|please|ignore|install it)\b/i);
  });

  it("the Markdown twin and the page's JSON-LD (a plain WebPage, no ratings)", async () => {
    registry({ "npm:lodash": "4.17.21" });
    const md = await get("/is-it-safe/npm/lodash.md", "*/*");
    expect(md.status).toBe(200);
    expect(md.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const text = await md.text();
    expect(text).toContain("# Is npm:lodash 4.17.21 safe to install?");
    expect(text).toContain(`url: ${O}/is-it-safe/npm/lodash.md`);
    expect(claims(text)).not.toMatch(NO_SAFE_CLAIM);
    const page = await (await get("/is-it-safe/npm/lodash")).text();
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    expect(ld).toContain('"@type":"WebPage"');
    expect(ld).not.toMatch(/FAQPage|Review|AggregateRating|ratingValue|QAPage/);
    expect(page).toContain('href="/is-it-safe/npm/lodash.md"');
  });
});

describe("the index, sitemap, llms.txt and rate limit", () => {
  it("the index lists every package, with JSON and Markdown twins", async () => {
    const page = await (await get("/is-it-safe")).text();
    for (const p of ["/is-it-safe/npm/express", "/is-it-safe/npm/@modelcontextprotocol/sdk", "/is-it-safe/pypi/litellm"]) expect(page).toContain(`href="${p}"`);
    expect(page).toContain(CLEAR_MEANING);
    expect(claims(page)).not.toMatch(NO_SAFE_CLAIM);
    const j = (await (await get("/is-it-safe?format=json", "application/json")).json()) as { packages: { tool_id: string; url: string }[]; counts: { npm: number; pypi: number } };
    expect(j.counts).toEqual({ npm: TOP_NPM.length, pypi: TOP_PYPI.length });
    expect(j.packages).toHaveLength(TOP_NPM.length + TOP_PYPI.length);
    expect(j.packages[0]).toEqual({ ecosystem: "npm", package: TOP_NPM[0], tool_id: `npm:${TOP_NPM[0]}`, url: `${O}/is-it-safe/npm/${TOP_NPM[0]}`, markdown: `${O}/is-it-safe/npm/${TOP_NPM[0]}.md` });
    const md = await get("/is-it-safe.md", "*/*");
    expect(md.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await md.text()).toContain("# Is it safe to install?");
  });

  it("the sitemap lists the index and every listed package, and llms.txt links the index", async () => {
    const xml = await (await fetchWorker("/sitemap.xml")).text();
    expect(xml).toContain(`<loc>${O}/is-it-safe</loc>`);
    for (const p of TOP_PACKAGE_PATHS) expect(xml, p).toContain(`<loc>${O}${p}</loc>`);
    // Undated rows of a fixed list: IndexNow sends them after the static and newest pages.
    expect((await sitemapPaths(getDb(env))).find((r) => r.path === "/is-it-safe/npm/express")).toEqual({ path: "/is-it-safe/npm/express", bulk: true });
    const llms = await (await fetchWorker("/llms.txt")).text();
    expect(llms).toContain("[Is it safe to install?](/is-it-safe)");
  });

  it("package pages sit behind the per-IP limiter /check uses; the index costs nothing and doesn't", async () => {
    expect(LIMITED_PAGE.test("/is-it-safe/npm/express")).toBe(true);
    expect(LIMITED_PAGE.test("/is-it-safe/pypi/requests")).toBe(true);
    expect(LIMITED_PAGE.test("/is-it-safe")).toBe(false);
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) {
      const res = await fetchWorker(`/is-it-safe/npm/zz-limit-${i}`, { headers: { Accept: "text/html", "CF-Connecting-IP": "198.51.100.250" } });
      statuses.push(res.status);
      await res.body?.cancel();
    }
    expect(statuses).toContain(429);
  });
});
