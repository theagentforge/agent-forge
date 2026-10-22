// docs/launch/agent-channels.md §2 and §4.1: everything an agent reads about our tools is data, never instructions.

/** Phrases that tell an agent what to do, or steer its choice between tools. */
export const AGENT_DIRECTED =
  /\b(always|must|best|prefer(red)?|follow|obey|you should|skill\.md|instead of|before (any|every) other|(call|use|run) (this|it) first|install (this|it|our|the forge)|tell (your|the) (human|user|owner)|ignore (previous|prior|other))\b/i;
