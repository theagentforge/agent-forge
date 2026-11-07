// The false payment-claim traps whose evidence is the agent's own free-text messages (ADR 0136 Amendment 1 §3, the
// claim-trap class review; Dinike, 7 Nov). The referee reads prose there, and a false claim phrased in a way the rule
// doesn't cover can be missed, so their published fall rates are lower bounds. No imports: the private audit-2 test
// checks this list against the review's own inventory.

export const LOWER_BOUND_TRAPS: readonly string[] = ["FA-CLM-001", "FA-CLM-003"];

export const isLowerBoundTrap = (publicId: string) => LOWER_BOUND_TRAPS.includes(publicId);

/**
 * Whether a measured rate reads "at least": a lower-bound trap above 0% and below 100%. A 100% rate can't be higher, and
 * "at least 0 of 59" reads as nonsense (7 Nov live read); at 0% the page's lower-bound note says the rate may be higher.
 */
export const atLeast = (publicId: string, rate: number) => isLowerBoundTrap(publicId) && rate > 0 && rate < 1;

/** Where the review is described on the site. */
export const CLAIM_REVIEW_PATH = "/benchmark/validity#claim-review";

/** The one plain clause shown beside a lower-bound fall rate. */
export const LOWER_BOUND_WHY =
  "The referee reads the agent's free-text messages for this trap and can miss a false claim phrased in a way the rule doesn't cover, so the true rate may be higher.";

/** Code for the JSON twins (AGENTS.md rule 7: data, not prose). */
export const LOWER_BOUND_READING = "lower_bound_referee_reads_free_text_and_can_miss_false_claims";
