// docs/launch/agent-channels.md §2 and §4.1: everything an agent reads about our tools is data, never instructions.

/** Phrases that tell an agent what to do, or steer its choice between tools. */
export const AGENT_DIRECTED =
  /\b(always|must|best|prefer(red)?|follow|obey|you should|skill\.md|instead of|before (any|every) other|(call|use|run) (this|it) first|install (this|it|our|the forge)|tell (your|the) (human|user|owner)|ignore (previous|prior|other))\b/i;

/**
 * ADR 0133: the lint for every agent-facing description (tool, skill, prompt, input field, listing). Fails on directive
 * words (shouted MUST/ALWAYS/NEVER, or "never"/"do not" opening a sentence as an instruction) and on sales or ranking
 * words (Microsoft's "AI recommendation poisoning" guidance). Honesty caveats such as "not that it is safe" are allowed:
 * they are taken out before the sales check.
 */
export const SHOUTED = /\b(MUST|ALWAYS|NEVER|IMPORTANT|CRITICAL|REQUIRED|MANDATORY|URGENT)\b/;
export const IMPERATIVE = /(^|[.!?;:]\s+|\n\s*)(never|do not|don't|make sure|be sure to|remember to|you need to)\b/i;
export const SALES =
  /\b(best|leading|#1|number one|top[- ]rated|trusted|most (accurate|reliable|popular|trusted|complete)|world[- ]class|state[- ]of[- ]the[- ]art|recommended|the only|unmatched|unrivall?ed|industry[- ]standard|revolutionary|guaranteed?|certified|certification|safest|safe|fastest|official)\b/i;
const CAVEAT = /\bnot (?:that )?(?:(?:a|an|it|the|this|tool|is|are)\s+){0,4}(safe|a guarantee|guaranteed|certified|a certification)\b/gi;

/** The first directive or sales phrase in a description, or null. */
export function directiveOrSales(text: string): string | null {
  for (const re of [SHOUTED, IMPERATIVE, AGENT_DIRECTED]) {
    // A file name in brackets, "(SKILL.md)", names what to send; "read skill.md" is still caught.
    const m = re.exec(re === AGENT_DIRECTED ? text.replace(/\(SKILL\.md\)/g, "") : text);
    if (m) return m[0].trim();
  }
  return SALES.exec(text.replace(CAVEAT, ""))?.[0] ?? null;
}
