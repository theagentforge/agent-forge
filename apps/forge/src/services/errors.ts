// Errors an agent can act on (Anthropic, "Writing effective tools for agents": errors should say what to change).
// Data only: what the accepted forms are and when to retry, never instructions.

export const CHECK_LIMIT_PERIOD_S = 60; // CHECK_LIMITER's period in wrangler.jsonc

export const RATE_LIMITED = { error: "rate_limited", retry_after_s: CHECK_LIMIT_PERIOD_S } as const;

/** Added to invalid_query errors from a check: the id forms we accept, with one example of each kind. */
export const CHECK_QUERY_HELP = {
  accepted: {
    id: ["npm:<package>", "pypi:<package>", "github.com/<owner>/<repo>[/path]", "mcp-registry:<name>", "a bare name (returns candidates)"],
    url: "https page of the tool, e.g. on github.com or npmjs.com",
    fingerprint: "sha256:<64 hex>",
  },
  example: { id: "npm:@modelcontextprotocol/server-filesystem" },
} as const;
