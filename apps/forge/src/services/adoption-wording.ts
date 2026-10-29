// F-02 wording guard (build plan 28 Oct; ADR 0082). Under Dinike's rule every public number is a gross total that
// includes our own test agents, so no public wording may imply outside adoption next to a number ("trusted by 40
// agents", "join 1,000 owners", "a community of 300"). The tests run this over every public page and JSON twin; later
// pages that print counts (the agent index, B2-08) reuse it.

/** Verbs that claim adoption when a number follows them: "trusted by 40 agents", "join 1,200 owners". */
export const ADOPTION_VERBS = ["used by", "trusted by", "relied on by", "loved by", "joined by", "join", "community of"] as const;
/** Nouns that claim someone else's activity when a number sits next to them: "12 outside agents", "real users: 300". */
export const ADOPTION_NOUNS = ["agents warn each other", "independent agents", "outside agents", "third-party agents", "by other agents", "real users", "happy users"] as const;
/** Every phrase the guard knows (for documentation and tests). */
export const ADOPTION_PHRASES = [...ADOPTION_VERBS, ...ADOPTION_NOUNS] as const;

const NUM = String.raw`\d[\d,.]*\s*(?:k|m)?\+?`;
/** Up to three words between the phrase and the number ("trusted by over 40", "12 outside agents"). */
const GAP = String.raw`(?:[^\s\d.!?;:]+\s+){0,3}`;
const esc = (p: string) => p.replace(/[-]/g, "\\-").replace(/ /g, "\\s+");

/**
 * Every adoption claim in `text`: a verb phrase followed by a number, or a noun phrase with a number just before or
 * after it, within three words and the same sentence. Returns the matching excerpts (empty when the text is clean).
 * Case-insensitive; markup should be stripped first.
 */
export function adoptionClaims(text: string): string[] {
  const out: string[] = [];
  for (const v of ADOPTION_VERBS) for (const m of text.matchAll(new RegExp(String.raw`\b${esc(v)}\s+${GAP}${NUM}`, "gi"))) out.push(m[0]);
  for (const v of ADOPTION_NOUNS) {
    for (const m of text.matchAll(new RegExp(String.raw`${NUM}\s+${GAP}${esc(v)}\b`, "gi"))) out.push(m[0]);
    for (const m of text.matchAll(new RegExp(String.raw`\b${esc(v)}\s*[:=]?\s+${GAP}${NUM}`, "gi"))) out.push(m[0]);
  }
  return out;
}

/** Page text without markup, scripts or styles, for the guard. */
export const pageText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");

/** Every string and number in a JSON value, in order (for JSON twins: a label next to its value reads as one). */
export function jsonText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(jsonText).join(" \n ");
  if (v && typeof v === "object") return Object.values(v).map(jsonText).join(" \n ");
  return "";
}
