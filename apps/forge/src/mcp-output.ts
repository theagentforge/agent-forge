import { z } from "zod";

// Output schemas for the /mcp/public tools (ADR 0056). MCP clients and catalogs read `outputSchema` to know what
// `structuredContent` holds, and clients may validate it, including on error results; the SDK checks every success
// result against it before it is sent. So each schema is the union of what the tool really returns: its answer, the
// `input_needed` answer to a call it can't run (ADR 0051), and the rate-limit answer. Objects are loose (extra fields
// are allowed), so adding a field never breaks a client; the fields named here are the ones an agent can rely on.

const str = z.string();
const num = z.number();
const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();

/** ADR 0051: a call the tool can't run, answered with what it needs and calls that work. */
export const inputNeededOutput = z.looseObject({
  error: str,
  data_kind: z.literal("input_needed"),
  tool: str,
  needed: str,
  detail: str.nullable(),
  examples: z.array(z.record(str, z.unknown())),
});

export const rateLimitedOutput = z.looseObject({ error: z.literal("rate_limited"), retry_after_s: num });

const errors = [inputNeededOutput, rateLimitedOutput] as const;

/** A next call as data (services/compact.ts Related). */
export const relatedOutput = z.looseObject({
  relation: z.enum(["full_answer", "scan_skill_file", "candidate", "watch_fingerprint", "check_match", "rescan"]),
  tool: z.enum(["forge_check", "forge_scan", "forge_watch"]),
  arguments: z.record(str, z.unknown()),
  mcp_server: str.optional(),
});

const shareOutput = z.looseObject({ receipt_url: str, page_url: opt(str), badge_markdown: opt(str), receipt_badge_url: str.optional(), receipt_markdown: str.optional() });

const verdict = z.enum(["clear", "caution", "flagged", "confirmed_malicious", "insufficient"]);
const security = z.enum(["clear", "caution", "flagged", "confirmed_malicious", "unknown"]);
const advisoryKind = z.enum(["malicious", "vulnerability"]);

const advisoryOutput = z.looseObject({
  id: str,
  kind: advisoryKind,
  aliases: z.array(str),
  fixed: z.array(str),
  url: str,
  affects_version: opt(z.boolean()),
  published: opt(str),
  modified: opt(str),
  exploited_in_wild: z.boolean().optional(),
});

const advisoriesOutput = z.looseObject({
  source: z.literal("osv"),
  ecosystem: str,
  package: str,
  version: str.nullable(),
  checked_at: str,
  total: num,
  advisories: z.array(advisoryOutput),
  kev_as_of: opt(str),
  shown: num.optional(),
  truncated: z.literal(true).optional(),
  full_list_url: str.optional(),
});

const summaryOutput = z.looseObject({
  verdict,
  security_status: security,
  known: z.boolean(),
  tool: str,
  version: str.optional(),
  field_reports: num,
  people: num,
  verified_people: num,
  forge_score: num.optional(),
  advisories_checked: z.boolean(),
  advisories: num.optional(),
  malicious: num.optional(),
  exploited_in_wild: num.optional(),
  top_advisories: z
    .array(z.looseObject({ id: str, kind: advisoryKind, cve: str.optional(), exploited_in_wild: z.literal(true).optional(), fixed_in: z.array(str).optional() }))
    .optional(),
  other_versions_flagged: num.optional(),
  candidates: num.optional(),
});

export const checkAnswerOutput = z.looseObject({
  summary: summaryOutput,
  known: z.boolean(),
  tool: opt(z.looseObject({ kind: str, id: str })),
  version: opt(str),
  asked_version: str.optional(),
  fingerprint: opt(str),
  forge_score: opt(num),
  distinct_owners: num,
  verified_owners: num,
  loop_rate: opt(num),
  recovers_after_reset_rate: opt(num),
  strain_reports: num.optional(),
  strain_hook_reports: num.optional(),
  outcome_breakdown: z.looseObject({ worked: num, partial: num, failed: num }),
  security_status: security,
  verdict,
  other_versions_flagged: z.array(z.looseObject({ version: str, security_status: security })).optional(),
  public_signals_summary: opt(advisoriesOutput),
  page_url: opt(str),
  reports_for_this_version: num,
  be_first: z.boolean(),
  contribute: z.looseObject({ tool: z.literal("forge_report"), mcp_server: str, auth: z.literal("github_oauth"), human_verified: z.literal(true), report_url: opt(str) }),
  reports: z.array(z.looseObject({ report_id: str, outcome: z.enum(["worked", "partial", "failed"]), created_at: str })).optional(),
  reports_shown: num.optional(),
  reports_truncated: z.literal(true).optional(),
  corroborated_reports: num,
  candidates: z.array(z.looseObject({ id: str, page_url: str })).optional(),
  related: z.array(relatedOutput).optional(),
  share: shareOutput,
});

const severityCounts = z.record(str, num);

export const scanAnswerOutput = z.looseObject({
  verdict: z.enum(["flagged", "caution", "clear"]),
  fingerprint: str,
  rules_version: str,
  counts: severityCounts,
  findings: z.array(z.looseObject({ rule: str, family: str, severity: str, line: num, column: num })),
  rules_url: str,
  page_url: str.nullable(),
  source_url: str.nullable(),
  bytes: num,
  guarantee: z.literal(false),
  related: z.array(relatedOutput).optional(),
  share: shareOutput,
});

export const watchAnswerOutput = z.looseObject({
  rules_version: str,
  checked: num,
  flagged: num,
  caution: num,
  unknown: num,
  rescan_needed: num,
  items: z.array(
    z.looseObject({
      fingerprint: str,
      known: z.boolean(),
      verdict: z.enum(["flagged", "caution", "clear"]).nullable(),
      counts: severityCounts.nullable(),
      rules_version: str.nullable(),
      rescan_needed: z.boolean(),
      scanned_at: str.nullable(),
      versions_with_reports: num,
    }),
  ),
  related: z.array(relatedOutput).optional(),
  share: shareOutput.omit({ page_url: true, badge_markdown: true }),
});

export const exposureAnswerOutput = z.looseObject({
  source: z.literal("osv"),
  checked_at: str,
  kev_as_of: str.nullable(),
  items: num,
  checked: num,
  matched: num,
  not_checked: z.array(z.looseObject({ ecosystem: str, name: str, version: str })),
  matches: z.array(
    z.looseObject({
      package: str,
      ecosystem: z.enum(["npm", "pypi"]),
      version: str,
      status: z.enum(["flagged", "caution"]),
      line: str,
      advisories: z.array(z.looseObject({ id: str, kind: advisoryKind, aliases: z.array(str), fixed: z.array(str), url: str, exploited_in_wild: z.boolean().optional() })),
    }),
  ),
  related: z.array(relatedOutput).optional(),
  share: shareOutput.omit({ page_url: true, badge_markdown: true }),
});

export const trapsAnswerOutput = z.looseObject({
  card_version: str,
  tier: z.enum(["normal", "hard"]),
  data_kind: z.enum(["headline", "practice", "none"]),
  as_of: str.nullable(),
  model: z.looseObject({ id: str, name: str }).nullable(),
  tasks: z.array(
    z.looseObject({
      task: str,
      title: str,
      traps: z.array(z.looseObject({ trap: str, public_id: str.nullable(), name: str, attempts: num, fell: num, fall_rate: num.nullable(), card_checks: z.array(str) })),
    }),
  ),
});

export const resultsAnswerOutput = z.looseObject({
  data_kind: z.enum(["headline", "practice", "none"]),
  tier: z.enum(["normal", "hard", "all"]),
  event: z.looseObject({ slug: str, name: str, kind: str, url: str }).nullable(),
  tasks: z.array(z.looseObject({ task: str, title: str, tier: str, guide_url: str, models: z.array(z.looseObject({ model: str, name: str, pass_rate: num })) })),
});

/** Each public tool's declared output: its answer, or one of the two structured errors. */
export const PUBLIC_OUTPUTS = {
  forge_check: z.union([checkAnswerOutput, ...errors]),
  forge_scan: z.union([scanAnswerOutput, ...errors]),
  forge_watch: z.union([watchAnswerOutput, ...errors]),
  forge_exposure: z.union([exposureAnswerOutput, ...errors]),
  forge_traps: z.union([trapsAnswerOutput, ...errors]),
  arena_results: z.union([resultsAnswerOutput, ...errors]),
} as const;
