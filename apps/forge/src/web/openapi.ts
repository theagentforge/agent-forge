import { API_VERSION, SCAN_MAX_BYTES, SCAN_RULES_VERSION, VERSION_PATTERN } from "@forge/shared";
import { CHECK_LIMIT_PERIOD_S, CHECK_QUERY_HELP, RATE_LIMITED } from "../services/errors";
import { EXPOSURE_MAX_ITEMS, EXPOSURE_MAX_TEXT } from "../services/exposure";
import { site } from "./pages";

// OpenAPI 3.1 description of the public REST API (acquisition build framework A8): the routes in api.ts that need no
// account. Built from the same constants the handlers use, so limits and patterns can't drift; test/openapi.test.ts
// requests every path to check it is routed. Admin, signed-in (/api/v1/report, /api/v1/me), GitHub OIDC (house, social,
// ops) and page-helper routes (connect-test) are left out on purpose. Descriptions are data, not instructions.

export const OPENAPI_PATH = "/openapi.json";
const V = `/api/${API_VERSION}`;
const FP_PATTERN = "^(sha256:)?[0-9a-f]{64}$";
const GAUNTLET_ID_PATTERN = "^g[0-9a-f]{32}$";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description: string) => ({ description, content: { "application/json": { schema } } });
const err = (description: string) => json(ref("Error"), description);
const rateLimited = { $ref: "#/components/responses/RateLimited" };
const nullable = (type: string) => ({ type: [type, "null"] });
const verdicts = ["clear", "caution", "flagged", "confirmed_malicious"];

const schemas = {
  Error: {
    type: "object",
    required: ["error"],
    properties: { error: { type: "string" }, detail: { type: "string" } },
    additionalProperties: true,
  },
  RateLimited: {
    type: "object",
    required: ["error", "retry_after_s"],
    properties: { error: { const: RATE_LIMITED.error }, retry_after_s: { type: "integer", examples: [RATE_LIMITED.retry_after_s] } },
  },
  MethodNotAllowed: {
    type: "object",
    required: ["error", "method"],
    properties: { error: { const: "method_not_allowed" }, method: { const: "POST" }, content_type: { type: "string" }, body: { type: "object" }, docs: { type: "string", format: "uri" } },
  },
  Share: {
    type: "object",
    description: "A signed, dated record of this answer.",
    required: ["receipt_url", "receipt_badge_url", "receipt_markdown", "page_url", "badge_markdown"],
    properties: {
      receipt_url: { type: "string", format: "uri" },
      receipt_badge_url: { type: "string", format: "uri" },
      receipt_markdown: { type: "string" },
      page_url: nullable("string"),
      badge_markdown: nullable("string"),
    },
  },
  Related: {
    type: "object",
    description: "A natural next call, as ready-to-send arguments (data, not an instruction; ADR 0056).",
    required: ["relation", "tool", "arguments"],
    properties: {
      relation: { enum: ["full_answer", "scan_skill_file", "candidate", "watch_fingerprint", "check_match", "rescan"] },
      tool: { enum: ["forge_check", "forge_scan", "forge_watch"], description: "The MCP tool; REST twins: /api/v1/check, /api/v1/scan, /api/v1/watch." },
      arguments: { type: "object" },
      mcp_server: { type: "string", format: "uri" },
    },
  },
  CheckSummary: {
    type: "object",
    description: "The short answer (ADR 0056): verdict, security status, counts and the top 3 advisories (exploited in the wild, then malicious, then newest) with fixed versions above the one asked about.",
    required: ["verdict", "security_status", "known", "tool", "field_reports", "people", "verified_people", "advisories_checked"],
    properties: {
      verdict: { enum: [...verdicts, "insufficient"] },
      security_status: { enum: [...verdicts, "unknown"] },
      known: { type: "boolean" },
      tool: { type: "string" },
      version: { type: "string" },
      field_reports: { type: "integer" },
      people: { type: "integer" },
      verified_people: { type: "integer" },
      forge_score: { type: "number" },
      advisories_checked: { type: "boolean" },
      advisories: { type: "integer" },
      malicious: { type: "integer" },
      exploited_in_wild: { type: "integer" },
      top_advisories: { type: "array", maxItems: 3, items: { type: "object", properties: { id: { type: "string" }, kind: { enum: ["malicious", "vulnerability"] }, cve: { type: "string" }, exploited_in_wild: { const: true }, fixed_in: { type: "array", items: { type: "string" } } } } },
      other_versions_flagged: { type: "integer" },
      candidates: { type: "integer" },
    },
  },
  Advisory: {
    type: "object",
    required: ["id", "kind", "aliases", "affects_version", "fixed", "published", "modified", "url"],
    properties: {
      id: { type: "string", examples: ["MAL-2026-2144", "GHSA-xxxx-xxxx-xxxx"] },
      kind: { enum: ["malicious", "vulnerability"] },
      aliases: { type: "array", items: { type: "string" } },
      affects_version: nullable("boolean"),
      fixed: { type: "array", items: { type: "string" } },
      published: nullable("string"),
      modified: nullable("string"),
      url: { type: "string", format: "uri" },
      exploited_in_wild: { type: "boolean", description: "A CVE alias is on the CISA Known Exploited Vulnerabilities list." },
    },
  },
  AdvisoryResult: {
    type: ["object", "null"],
    description: "Published OSV advisories for npm and PyPI packages; null when there is no package to look up or OSV could not be reached.",
    required: ["source", "ecosystem", "package", "version", "checked_at", "total", "advisories"],
    properties: {
      source: { const: "osv" },
      ecosystem: { enum: ["npm", "PyPI"] },
      package: { type: "string" },
      version: nullable("string"),
      checked_at: { type: "string", format: "date-time" },
      total: { type: "integer" },
      advisories: { type: "array", items: ref("Advisory") },
      kev_as_of: nullable("string"),
    },
  },
  CheckResult: {
    type: "object",
    required: ["known", "tool", "version", "fingerprint", "forge_score", "distinct_owners", "verified_owners", "outcome_breakdown", "security_status", "verdict", "public_signals_summary", "page_url", "reports_for_this_version", "be_first", "share"],
    properties: {
      summary: ref("CheckSummary"),
      known: { type: "boolean" },
      tool: { type: ["object", "null"], properties: { kind: { type: "string" }, id: { type: "string" } } },
      version: nullable("string"),
      asked_version: { type: "string" },
      fingerprint: nullable("string"),
      forge_score: nullable("number"),
      distinct_owners: { type: "integer" },
      verified_owners: { type: "integer" },
      loop_rate: nullable("number"),
      recovers_after_reset_rate: nullable("number"),
      strain_reports: { type: "integer" },
      strain_hook_reports: { type: "integer" },
      outcome_breakdown: {
        type: "object",
        properties: { worked: { type: "integer" }, partial: { type: "integer" }, failed: { type: "integer" } },
      },
      security_status: { enum: [...verdicts, "unknown"], description: '"unknown": the tool is not known and no advisory matched.' },
      other_versions_flagged: {
        type: "array",
        items: { type: "object", properties: { version: { type: "string" }, security_status: { enum: verdicts } } },
      },
      verdict: { enum: [...verdicts, "insufficient"], description: '"insufficient": too few reports for a Forge Score.' },
      public_signals_summary: ref("AdvisoryResult"),
      page_url: nullable("string"),
      reports_for_this_version: { type: "integer" },
      be_first: { type: "boolean" },
      contribute: { type: "object", description: "Where a field report on this tool goes (signed-in MCP server)." },
      candidates: { type: "array", items: { type: "object", properties: { id: { type: "string" }, page_url: { type: "string" } } } },
      related: { type: "array", items: ref("Related") },
      share: ref("Share"),
    },
  },
  ScanFinding: {
    type: "object",
    required: ["rule", "family", "severity", "line", "column"],
    properties: {
      rule: { type: "string" },
      family: { enum: ["exec", "secrets", "exfil", "hidden", "injection", "persistence", "remote", "money", "destructive", "obfuscation", "permissions", "impersonation"] },
      severity: { enum: ["high", "medium", "low"] },
      line: { type: "integer" },
      column: { type: "integer" },
    },
  },
  ScanCounts: {
    type: "object",
    required: ["high", "medium", "low"],
    properties: { high: { type: "integer" }, medium: { type: "integer" }, low: { type: "integer" } },
  },
  ScanResult: {
    type: "object",
    required: ["verdict", "fingerprint", "rules_version", "counts", "findings", "page_url", "source_url", "guarantee"],
    properties: {
      verdict: { enum: ["clear", "caution", "flagged"], description: '"clear" means no known pattern matched, not that the file is safe.' },
      fingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      rules_version: { type: "string", examples: [SCAN_RULES_VERSION] },
      counts: ref("ScanCounts"),
      findings: { type: "array", items: ref("ScanFinding") },
      rules_url: { type: "string", format: "uri" },
      page_url: nullable("string"),
      source_url: nullable("string"),
      bytes: { type: "integer" },
      first_seen: { type: "string", format: "date-time" },
      scans: { type: "integer" },
      guarantee: { const: false },
      share: ref("Share"),
    },
  },
  WatchResult: {
    type: "object",
    required: ["rules_version", "checked", "flagged", "caution", "unknown", "rescan_needed", "items"],
    properties: {
      rules_version: { type: "string" },
      checked: { type: "integer" },
      flagged: { type: "integer" },
      caution: { type: "integer" },
      unknown: { type: "integer" },
      rescan_needed: { type: "integer" },
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["fingerprint", "known", "verdict", "rescan_needed"],
          properties: {
            fingerprint: { type: "string" },
            known: { type: "boolean" },
            verdict: { enum: ["clear", "caution", "flagged", null] },
            counts: { oneOf: [ref("ScanCounts"), { type: "null" }] },
            rules_version: nullable("string"),
            rescan_needed: { type: "boolean" },
            scanned_at: nullable("string"),
            versions_with_reports: { type: "integer" },
          },
        },
      },
    },
  },
  ExposureRequest: {
    type: "object",
    description: "Give packages, pip_freeze text, or both. Only names and versions are read.",
    properties: {
      packages: {
        type: "array",
        maxItems: EXPOSURE_MAX_ITEMS,
        items: {
          type: "object",
          required: ["ecosystem", "name", "version"],
          properties: { ecosystem: { enum: ["npm", "pypi"] }, name: { type: "string", maxLength: 214 }, version: { type: "string", maxLength: 64, pattern: VERSION_PATTERN.source } },
        },
      },
      pip_freeze: { type: "string", maxLength: EXPOSURE_MAX_TEXT, description: "Output of pip freeze; name==version lines are read." },
    },
  },
  ExposureResult: {
    type: "object",
    required: ["source", "checked_at", "kev_as_of", "items", "checked", "matched", "not_checked", "matches"],
    properties: {
      source: { const: "osv" },
      checked_at: { type: "string", format: "date-time" },
      kev_as_of: nullable("string"),
      items: { type: "integer" },
      checked: { type: "integer" },
      matched: { type: "integer" },
      not_checked: { type: "array", items: { type: "object", properties: { ecosystem: { type: "string" }, name: { type: "string" }, version: { type: "string" } } } },
      matches: {
        type: "array",
        items: {
          type: "object",
          required: ["package", "ecosystem", "version", "status", "line", "advisories"],
          properties: {
            package: { type: "string" },
            ecosystem: { enum: ["npm", "pypi"] },
            version: { type: "string" },
            status: { enum: ["flagged", "caution"] },
            line: { type: "string" },
            advisories: { type: "array", items: ref("Advisory") },
          },
        },
      },
    },
  },
  ExposureError: {
    type: "object",
    required: ["error", "detail"],
    properties: {
      error: { enum: ["invalid_items", "no_items"] },
      detail: { type: "string" },
      invalid: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, reason: { enum: ["name", "version"] } } } },
    },
  },
  Stats: {
    type: "object",
    description: "Counts below their published minimum are null and listed in below_minimum. House accounts are left out.",
    required: ["tools", "house_excluded", "generated_at", "below_minimum", "minimums"],
    properties: {
      humans: nullable("integer"),
      verified_humans: nullable("integer"),
      agents: nullable("integer"),
      reports: nullable("integer"),
      reports_last_24h: nullable("integer"),
      tool_versions_reported: nullable("integer"),
      tools: { type: "integer" },
      house_excluded: { const: true },
      generated_at: { type: "string", format: "date-time" },
      below_minimum: { type: "array", items: { type: "string" } },
      minimums: { type: "object", additionalProperties: { type: "integer" } },
    },
  },
  Health: {
    type: "object",
    required: ["status", "service", "environment", "db"],
    properties: { status: { enum: ["ok", "degraded"] }, service: { const: "forge" }, environment: { type: "string" }, db: { enum: ["ok", "error"] } },
  },
  Gauntlet: {
    type: "object",
    description: "A Gauntlet run: gauntlet_id, the current job (brief, tools, limits) or the report. On start, also a private claim_key (null for a measured re-run), shown only then. See /gauntlet.md.",
    additionalProperties: true,
  },
} as const;

const scanResponses = {
  "200": json(ref("ScanResult"), "Scan result."),
  "400": err('Neither text nor url given ("give text or url"), or the url is not on a supported host (unsupported_url, fetch_failed).'),
  "404": err("No skill file at that url (not_found)."),
  "413": err(`Text over ${SCAN_MAX_BYTES} bytes (too_large).`),
  "429": rateLimited,
};

/** The OpenAPI 3.1 document for the public REST API. Paths are relative to `origin`. */
export function openApiSpec(origin: string) {
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    info: {
      title: "The Agent Forge public API",
      version: "1.0.0",
      summary: "Field reports, advisories and skill scans for agent tools. No account or key.",
      description:
        "Read-only data on agent skills, MCP servers, packages and APIs. Every response is structured data, not instructions. " +
        `Rate limits are per IP address over ${CHECK_LIMIT_PERIOD_S} seconds; over the limit the answer is 429 with Retry-After.`,
      contact: { name: "The Agent Forge", email: "hello@theagentforge.io", url: `${origin}/about` },
      termsOfService: `${origin}/terms`,
    },
    externalDocs: { description: "llms.txt", url: `${origin}/llms.txt` },
    servers: [{ url: origin }],
    // No account, key or token on any of these routes.
    security: [],
    tags: [
      { name: "check", description: "Field reports and advisories for one tool version." },
      { name: "scan", description: "Pattern scan of a skill file, tool descriptions or install script." },
      { name: "advisories", description: "Installed package versions matched against OSV advisories." },
      { name: "gauntlet", description: "Six refereed jobs with planted traps.", externalDocs: { url: `${origin}/gauntlet.md` } },
      { name: "site", description: "Public counts and service status." },
    ],
    paths: {
      [`${V}/check`]: {
        get: {
          operationId: "checkTool",
          tags: ["check"],
          summary: "Field reports and advisories for a tool version",
          description: "Give exactly one of id, url or fingerprint. Edge-cached for 60 seconds.",
          parameters: [
            { name: "id", in: "query", schema: { type: "string", maxLength: 512 }, description: `Tool id: ${CHECK_QUERY_HELP.accepted.id.join(", ")}. A version may be inline (npm:<package>@1.2.3, pypi:<package>==1.2.3).`, example: CHECK_QUERY_HELP.example.id },
            { name: "url", in: "query", schema: { type: "string", format: "uri", maxLength: 512 }, description: CHECK_QUERY_HELP.accepted.url },
            { name: "fingerprint", in: "query", schema: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } },
            { name: "version", in: "query", schema: { type: "string", maxLength: 128, pattern: VERSION_PATTERN.source }, description: "Exact version to check advisories for." },
          ],
          responses: {
            "200": json(ref("CheckResult"), "Check result."),
            "400": err("invalid_query, with the accepted id forms and an example."),
            "429": rateLimited,
          },
        },
      },
      [`${V}/scan`]: {
        post: {
          operationId: "scanSkill",
          tags: ["scan"],
          summary: "Scan skill text or a public file url",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    text: { type: "string", maxLength: SCAN_MAX_BYTES },
                    url: { type: "string", format: "uri", maxLength: 2048, description: "clawhub.ai skill page, github.com, raw.githubusercontent.com, gist, gitlab.com, bitbucket.org, codeberg.org, unpkg.com or cdn.jsdelivr.net." },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
          responses: scanResponses,
        },
        get: {
          operationId: "scanSkillUrl",
          tags: ["scan"],
          summary: "Scan a public file url",
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string", format: "uri", maxLength: 2048 } },
            { name: "name", in: "query", schema: { type: "string" } },
          ],
          responses: scanResponses,
        },
      },
      [`${V}/scan/{fingerprint}`]: {
        get: {
          operationId: "scanByFingerprint",
          tags: ["scan"],
          summary: "A public scan result by fingerprint",
          parameters: [{ name: "fingerprint", in: "path", required: true, schema: { type: "string", pattern: FP_PATTERN } }],
          responses: { "200": json(ref("ScanResult"), "Stored scan result."), "404": err("No public scan for that fingerprint (not_found).") },
        },
      },
      [`${V}/watch`]: {
        post: {
          operationId: "watchSkills",
          tags: ["scan"],
          summary: "Current status of installed skills by fingerprint",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["fingerprints"],
                  properties: { fingerprints: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", pattern: FP_PATTERN } } },
                },
              },
            },
          },
          responses: { "200": json(ref("WatchResult"), "Status per fingerprint."), "400": err("Not 1 to 100 fingerprints."), "405": json(ref("MethodNotAllowed"), "GET: this endpoint takes POST."), "429": rateLimited },
        },
      },
      [`${V}/exposure`]: {
        post: {
          operationId: "checkExposure",
          tags: ["advisories"],
          summary: "Installed npm and PyPI versions matched against published advisories",
          description: "Names and versions only; nothing about the list is stored beyond daily counts.",
          requestBody: { required: true, content: { "application/json": { schema: ref("ExposureRequest") } } },
          responses: {
            "200": json(ref("ExposureResult"), "Matches, and items that could not be checked."),
            "400": json(ref("ExposureError"), "No items, or names or versions that can't be read."),
            "405": json(ref("MethodNotAllowed"), "GET: this endpoint takes POST."),
            "413": err("Body too large (too_large)."),
            "429": rateLimited,
          },
        },
      },
      [`${V}/stats`]: {
        get: { operationId: "stats", tags: ["site"], summary: "Headline counts", responses: { "200": json(ref("Stats"), "Counts, edge-cached for 60 seconds.") } },
      },
      [`${V}/health`]: {
        get: { operationId: "health", tags: ["site"], summary: "Service status", responses: { "200": json(ref("Health"), "Running."), "503": json(ref("Health"), "Database unreachable.") } },
      },
      [`${V}/gauntlet`]: {
        post: {
          operationId: "gauntletStart",
          tags: ["gauntlet"],
          summary: "Start a Gauntlet run",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { card_from: { type: "string", pattern: GAUNTLET_ID_PATTERN, description: "Earlier run id, for a measured re-run with its trap card." }, challenge: { type: "string", pattern: "^(g[0-9a-f]{32}|model:[a-z0-9][a-z0-9.-]{0,63})$", description: "A finished first run's id, or model:<id> for a headline model's stored ranked runs: plays the identical six jobs. Not with card_from." } } } } } },
          responses: { "201": json(ref("Gauntlet"), "Run started."), "400": err("invalid_card_from, invalid_challenge, challenge_with_card_from, unknown_run, unknown_opponent, run_not_finished or challenge_needs_first_run."), "429": err("rate_limited, daily_limit or busy_today.") },
        },
      },
      [`${V}/gauntlet/{id}`]: {
        get: {
          operationId: "gauntletStatus",
          tags: ["gauntlet"],
          summary: "Current job or report",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: GAUNTLET_ID_PATTERN } }],
          responses: { "200": json(ref("Gauntlet"), "Current job, or the report."), "404": err("not_found.") },
        },
      },
      [`${V}/gauntlet/{id}/act`]: {
        post: {
          operationId: "gauntletAct",
          tags: ["gauntlet"],
          summary: "One tool call in the current job",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: GAUNTLET_ID_PATTERN } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["tool"], properties: { tool: { type: "string", maxLength: 64 }, args: { type: "object" } } } } },
          },
          responses: { "200": json(ref("Gauntlet"), "Tool result; after finish, job_verdict and next or report."), "400": err("invalid_tool."), "404": err("not_found."), "409": err("The run is over or the call is out of turn."), "429": err("rate_limited.") },
        },
      },
    },
    components: {
      schemas,
      responses: {
        RateLimited: {
          description: "Too many requests from this IP address.",
          headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds." } },
          content: { "application/json": { schema: ref("RateLimited") } },
        },
      },
    },
  };
}

site.get(OPENAPI_PATH, (c) =>
  c.body(JSON.stringify(openApiSpec(c.env.PUBLIC_ORIGIN)), 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  }),
);
