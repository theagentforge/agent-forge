// ADR 0133 (build plan 5 Nov, P2 items 10 and 11): the two tags the agent-awareness metrics read. Both are fixed,
// public labels with no ID in them, so nothing about a person, machine or session is carried or stored; they only add
// to daily counter rows (usage_daily), like every other count.
//
// 1. The skill tag. Our Agent Skills (ClawHub, skills.sh and /.well-known/agent-skills serve the same file) add
//    `?client=<skill name>-<version>` to the Forge addresses they call, e.g.
//    `/api/v1/scan?client=forge-check-before-install-1.1.0`. Only our own skill names and a plain x.y.z version are
//    read; anything else is ignored, so an outside value can never make a new counter key.
// 2. The Sprint result tag. A Sprint's share link carries `?from=sprint-share` (counted as a page arrival by the visit
//    counters), and the "Try it on your agent" commands on a Sprint result page carry `?from=sprint-result` on the
//    Gauntlet MCP address and the HTTP start, so a run started from them is counted as arriving from a Sprint result.

/** The skill names that may tag their calls (integrations/skill/*). */
export const TAGGING_SKILLS = ["forge-check-before-install", "forge-run-the-gauntlet"] as const;
export type TaggingSkill = (typeof TAGGING_SKILLS)[number];
const SKILL_TAG = new RegExp(`^(${TAGGING_SKILLS.join("|")})-(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})$`);

/** Where a tagged call landed. */
export type SkillEndpoint = "check" | "scan" | "gauntlet-start";

/** The skill and version a `client` value names, or null when it isn't one of ours. */
export function skillTag(raw: string | null | undefined): { skill: TaggingSkill; version: string } | null {
  const m = SKILL_TAG.exec((raw ?? "").trim().toLowerCase().slice(0, 80));
  return m ? { skill: m[1] as TaggingSkill, version: m[2]! } : null;
}

/** Counter prefix for one skill's tagged calls: `skilltag:<skill>@<version>:<endpoint>`. */
export const SKILL_TAG_PREFIX = "skilltag:";
export const skillTagKey = (skill: TaggingSkill, version: string, endpoint: SkillEndpoint) => `${SKILL_TAG_PREFIX}${skill}@${version}:${endpoint}`;

/**
 * The counter keys one call adds for its skill tag: none for our own tagged callers (`internal`), for bots (the caller
 * passes `bot`, ADR 0124's "api" rule) or when the tag isn't one of ours.
 */
export function skillTagKeys(raw: string | null | undefined, endpoint: SkillEndpoint, opts: { internal?: unknown; bot?: boolean } = {}): string[] {
  if (opts.internal || opts.bot) return [];
  const tag = skillTag(raw);
  return tag ? [skillTagKey(tag.skill, tag.version, endpoint)] : [];
}

/** Item 10: the share link's tag (a page arrival) and the start commands' tag (a run). */
export const SPRINT_SHARE_FROM = "sprint-share";
export const SPRINT_RESULT_FROM = "sprint-result";
/** Runs started from a Sprint result page's commands, by mode: `sprint:started_via:sprint-result` and `gauntlet:…`. */
export const startedViaKey = (mode: "sprint" | "full") => `${mode === "sprint" ? "sprint" : "gauntlet"}:started_via:${SPRINT_RESULT_FROM}`;

/** The keys a successful outside start adds when its address carried `from=sprint-result`. Never House or ours. */
export function startedViaKeys(from: string | null | undefined, mode: "sprint" | "full", opts: { internal?: unknown } = {}): string[] {
  if (opts.internal) return [];
  return (from ?? "").trim().toLowerCase() === SPRINT_RESULT_FROM ? [startedViaKey(mode)] : [];
}

/** The tags on a request's address (the MCP endpoints and the HTTP start read them from the URL). */
export function addressTags(url: string): { client: string | null; from: string | null } {
  try {
    const q = new URL(url).searchParams;
    return { client: q.get("client"), from: q.get("from") };
  } catch {
    return { client: null, from: null };
  }
}
