import { TRAP_CARD_VERSION, trapCardText } from "@forge/shared/light";
import { emit, optionOn } from "./common";

// SessionStart (ADR 0017 §1): adds the person's trap card to the session as context, because hooks are the one
// channel that is guaranteed to load. The same generic card as theagentforge.io/trap-card; off with `trap_card`.

export function sessionContext(): string {
  return `The Agent Forge plugin: the user's trap card (v${TRAP_CARD_VERSION}), checks the user set for this assistant.\n${trapCardText()}`;
}

if (process.env.VITEST === undefined && optionOn("TRAP_CARD")) {
  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext() } });
}
