import { html } from "hono/html";
import { BENCHMARK_PATH, TRAP_SET } from "../arena/benchmark";
import { BENCHMARK_HELD_OUT_PATH } from "../arena/benchmark-versions";
import { REFEREE_AUDIT, validityGate } from "../arena/error-record";
import { VALIDITY_PATH } from "../arena/validity";
import { DESCRIPTOR } from "./layout";
import { validityReleased } from "./validity-switch";

// The top of the home page (homepage-claim, 12 Nov 2026): one plain claim, then the proof a skeptic can check, each
// item one link. Only links and a version name: no count, rate or other new number. The moat is the refereed test
// (signed replays, held-out seeds, validity evidence), so that is what the top points to; the gross totals sit lower.

/** The claim: BRAND.md's one-line descriptor (AQ-01), word for word. */
export const HOME_CLAIM = DESCRIPTOR;

/** The home page's secondary call to action (the primary one is HEAD_CTA, Run the Gauntlet). */
export const CHECK_CTA_LABEL = "Check a tool before install";

/** The page that explains replay format v2 (hash chain, Ed25519 seal, `forge verify`). */
export const SIGNED_REPLAYS_PATH = "/methodology#replays";

export interface ProofItem {
  key: "signed_replays" | "validity" | "held_out" | "trap_set";
  label: string;
  href: string;
}

/**
 * The proof items, in reading order. The validity item is there only when the validity pack is public (VALIDITY_PUBLIC
 * on) and its referee audit passes the gate, the same rule as the Trap Set page's validity line: otherwise the link
 * would be a 404 (or a 503) for a visitor.
 */
export function homeProof(env: { VALIDITY_PUBLIC?: string }): ProofItem[] {
  const validity = validityReleased(env) && validityGate(REFEREE_AUDIT).ok;
  return [
    { key: "signed_replays", label: "Signed replays", href: SIGNED_REPLAYS_PATH },
    ...(validity ? [{ key: "validity" as const, label: "Referee audits and error record", href: VALIDITY_PATH }] : []),
    { key: "held_out", label: "Held-out seeds", href: BENCHMARK_HELD_OUT_PATH },
    { key: "trap_set", label: `Trap Set ${TRAP_SET.version}`, href: BENCHMARK_PATH },
  ];
}

/** The claim and its proof line, as HTML. A list, so each link is its own tap target on a phone. */
export function claimBlock(items: ProofItem[]) {
  return html`<p class="hero-claim" data-home-claim>${HOME_CLAIM}</p>
<p class="small muted hero-proof-t" id="home-proof-t">Check it yourself:</p><ul class="hero-proof" data-home-proof aria-labelledby="home-proof-t">${items.map((i) => html`<li><a href="${i.href}" data-proof="${i.key}">${i.label}</a></li>`)}</ul>`;
}

/** The same, as structured data for the home page's JSON (absolute URLs). */
export const proofJson = (items: ProofItem[], origin: string) => items.map((i) => ({ key: i.key, label: i.label, url: `${origin}${i.href}` }));
