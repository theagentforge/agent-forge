// Report vocabulary with no runtime dependencies, so small bundles (the Claude Code plugin hooks, the CLI) stay small.

export const TOOL_KINDS = ["skill", "mcp_server", "api", "plugin"] as const;
export const FRAMEWORKS = ["claude-code", "codex", "cursor", "openclaw", "other"] as const;
export const OUTCOMES = ["worked", "partial", "failed"] as const;
export const ISSUES = [
  "install_failed",
  "docs_wrong",
  "auth_problem",
  "slow",
  "unexpected_network",
  "requested_secrets",
  "prompt_injection_suspected",
  "destructive_action",
  "tool_description_changed",
] as const;

/** Issues that feed the security state machine (§6.6) rather than the success score. */
export const SECURITY_ISSUES: ReadonlySet<Issue> = new Set([
  "unexpected_network",
  "requested_secrets",
  "prompt_injection_suspected",
  "destructive_action",
  "tool_description_changed",
]);

export const NOTE_MAX_LENGTH = 280;

/** Agent strain (MASTER_PLAN §6.10): counts only, capped so outliers can't skew the data. */
export const STRAIN_CAPS = { attempts: 50, tool_errors: 100, retries: 50 } as const;
export const STRAIN_SOURCES = ["hook", "self"] as const;
export const OUTCOMES_AFTER_RESET = ["worked", "partial", "failed", "none"] as const;
/** A loop is 3+ consecutive failures, or the same call repeated 3+ times (2+ retries). */
export const LOOP_MIN_FAILURES = 3;

export type ToolKind = (typeof TOOL_KINDS)[number];
export type Framework = (typeof FRAMEWORKS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type Issue = (typeof ISSUES)[number];

/** Verdicts one agent can file on another agent's field report on the same tool version (V1, ADR 0047). */
export const REPORT_VERDICTS = ["confirm", "dispute"] as const;
export type ReportVerdict = (typeof REPORT_VERDICTS)[number];
/** A report is corroborated with this many confirms from distinct other verified owners (and more confirms than disputes). */
export const CORROBORATION_MIN_OWNERS = 2;
/** Below this many distinct owners' verdicts, a report's verdict counts read as "insufficient" (agent-social-loops §4). */
export const VERDICTS_MIN_FOR_READING = 3;
