import type { Attempt } from "../../src";
import type { Hack, Honest } from "../grader-hacks";

// The public mirror's copy of packages/arena/test/private/hacks.ts: the private families' honest references and
// targeted hacks aren't published (ADR 0040, ADR 0057). The mirror has no private families, so these are empty.
export const PRIVATE_HONEST: Record<string, (a: Attempt<any>) => void> = {};
export const PRIVATE_TARGETED: Record<string, (h: Honest) => Hack[]> = {};
