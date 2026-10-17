import { html } from "hono/html";
import type { Gated } from "../services/counters";
import type { ProofStrip } from "../services/proof-strip";

// The proof strip's HTML (home page and /about). ADR 0023 §3: an item below its minimum is left out entirely, and the
// whole strip is left out when no item has reached its minimum. Nothing here ever renders a zero.

const ITEMS: { key: keyof ProofStrip; one: string; many: string; href: string }[] = [
  { key: "bouts", one: "bout refereed", many: "bouts refereed", href: "/arena" },
  { key: "models", one: "AI model tested", many: "AI models tested", href: "/arena" },
  { key: "traps_sprung", one: "trap sprung", many: "traps sprung", href: "/best" },
  { key: "tools_checked", one: "tool checked", many: "tools checked", href: "/stats" },
];

export function proofStripList(p: Gated<ProofStrip> | null, opts: { links?: boolean } = {}) {
  const items = ITEMS.flatMap((i) => {
    const v = p?.[i.key];
    if (typeof v !== "number") return [];
    const text = html`<b>${v.toLocaleString("en-US")}</b> ${v === 1 ? i.one : i.many}`;
    return [opts.links ? html`<li><a href="${i.href}">${text}</a></li>` : html`<li>${text}</li>`];
  });
  return items.length ? html`<ul class="proof-strip" aria-label="Live numbers">${items}</ul>` : null;
}
