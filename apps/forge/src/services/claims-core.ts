// ADR 0120: the claim verifier's pure core. No imports, only erasable TypeScript, so the Worker (services/claims.ts)
// and the brief gate (scripts/check-claims.mjs, under Node's type stripping) run the very same rules.
//
// Four verdicts, never more: SUPPORTED, CONTRADICTED, NOT_PRESENT, UNREACHABLE. A reason code says why. The checker
// never edits a claim and fails closed: anything it can't read is UNREACHABLE, anything it can't find is NOT_PRESENT;
// only a value or phrase read from the source makes SUPPORTED.

export type Verdict = "SUPPORTED" | "CONTRADICTED" | "NOT_PRESENT" | "UNREACHABLE";
export const VERDICTS: readonly Verdict[] = ["SUPPORTED", "CONTRADICTED", "NOT_PRESENT", "UNREACHABLE"];
export type Comparator = "eq" | "gte" | "lte" | "approx" | "contains" | "all_eq";
export const COMPARATORS: readonly Comparator[] = ["eq", "gte", "lte", "approx", "contains", "all_eq"];

/** The anchor that proves a claim: a field in JSON, a phrase in a page, or none (prose; only the optional LLM pass). */
export interface Anchor {
  kind: "json" | "text" | "none";
  path?: string | null;
  expected?: string | null;
  comparator?: Comparator | string | null;
  tolerance?: number | null;
  /** A running total that only grows. */
  counter?: boolean | null;
}

export interface Outcome {
  verdict: Verdict;
  reason: string;
  /** The exact text read from the source (at most QUOTE_MAX characters). */
  quote: string | null;
  quote_offset: number | null;
  observed_value: string | null;
}

export const QUOTE_MAX = 300;
/** approx with no tolerance given: 5%. */
export const DEFAULT_APPROX = 0.05;
/** A text page shorter than this (after tags are removed) is treated as empty (fail closed). */
export const MIN_TEXT_CHARS = 200;
/** The first link of every hash chain. */
export const GENESIS = "genesis";

const out = (verdict: Verdict, reason: string, quote: string | null = null, quote_offset: number | null = null, observed_value: string | null = null): Outcome => ({
  verdict,
  reason,
  quote: quote === null ? null : quote.slice(0, QUOTE_MAX),
  quote_offset,
  observed_value: observed_value === null ? null : observed_value.slice(0, QUOTE_MAX),
});

/** "10,633" → 10633, "57k" → 57000, "1.2M" → 1200000, "29.5%" → 29.5, "0.839" → 0.839. Not a number: null. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const m = /^\s*[~≈]?\s*(-?\d{1,3}(?:,\d{3})+|-?\d+(?:\.\d+)?|-?\.\d+)\s*([kKmM])?\s*%?\s*$/.exec(raw);
  if (!m) return null;
  const base = Number(m[1]!.replace(/,/g, ""));
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  const v = base * mult;
  return Number.isFinite(v) ? v : null;
}

type Step = { key: string } | { index: number } | { all: true } | { where: [string, string] };

/** Parses a field path: a.b[0].c, list[*].x, list[key=value].x. Invalid: null. */
export function parsePath(path: string): Step[] | null {
  const steps: Step[] = [];
  const re = /([^.[\]]+)|\[(\*|\d+|[^=\]]+=[^\]]*)\]|(\.)/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(path))) {
    last = re.lastIndex;
    if (m[3]) continue;
    if (m[1] !== undefined) steps.push({ key: m[1] });
    else if (m[2] === "*") steps.push({ all: true });
    else if (/^\d+$/.test(m[2]!)) steps.push({ index: Number(m[2]) });
    else {
      const eq = m[2]!.indexOf("=");
      steps.push({ where: [m[2]!.slice(0, eq), m[2]!.slice(eq + 1)] });
    }
  }
  return last === path.length && steps.length ? steps : null;
}

/** The values at a path (several for [*]); `found` false when any step is missing. The last key, for the quote. */
export function readPath(data: unknown, path: string): { found: boolean; values: unknown[]; lastKey: string | null } {
  const steps = parsePath(path);
  if (!steps) return { found: false, values: [], lastKey: null };
  let cur: unknown[] = [data];
  let lastKey: string | null = null;
  for (const s of steps) {
    const next: unknown[] = [];
    for (const v of cur) {
      if ("key" in s) {
        lastKey = s.key;
        if (v && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, s.key)) next.push((v as Record<string, unknown>)[s.key]);
      } else if (!Array.isArray(v)) continue;
      else if ("index" in s) {
        if (s.index < v.length) next.push(v[s.index]);
      } else if ("all" in s) next.push(...v);
      else next.push(...v.filter((x) => x && typeof x === "object" && String((x as Record<string, unknown>)[s.where[0]]) === s.where[1]));
    }
    if (!next.length) return { found: false, values: [], lastKey };
    cur = next;
  }
  return { found: true, values: cur, lastKey };
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v) ?? "null");

/** Compares one observed value with the claim, under its comparator and tolerance rule. */
export function compareValue(a: Anchor, observed: unknown): { ok: boolean; reason: string } {
  const cmp = (a.comparator ?? "eq") as Comparator;
  const expected = a.expected ?? "";
  if (cmp === "contains") return typeof observed === "string" && observed.includes(expected) ? { ok: true, reason: "contains" } : { ok: false, reason: "value_mismatch" };
  const e = parseNumber(expected);
  const o = parseNumber(observed);
  if (e === null || o === null) {
    // Not numbers: exact text only.
    if (cmp === "eq" || cmp === "all_eq") return show(observed) === expected ? { ok: true, reason: "exact" } : { ok: false, reason: "value_mismatch" };
    return { ok: false, reason: "not_a_number" };
  }
  if (cmp === "gte") return o >= e ? { ok: true, reason: "at_least" } : { ok: false, reason: "value_mismatch" };
  if (cmp === "lte") return o <= e ? { ok: true, reason: "at_most" } : { ok: false, reason: "value_mismatch" };
  if (cmp === "approx") {
    const tol = a.tolerance ?? DEFAULT_APPROX;
    return Math.abs(o - e) <= Math.abs(e) * tol ? { ok: true, reason: "within_tolerance" } : { ok: false, reason: "value_mismatch" };
  }
  if (o === e) return { ok: true, reason: "exact" };
  if (a.tolerance && Math.abs(o - e) <= Math.abs(e) * a.tolerance) return { ok: true, reason: "within_tolerance" };
  // A running total that has grown past the claim: true when made, stale now (eval 29 Oct §5.2: not a lie).
  if (a.counter && o > e) return { ok: false, reason: "stale_value" };
  return { ok: false, reason: "value_mismatch" };
}

/** Where `"key":value` sits in the body text (compact or pretty JSON), so the quote is the source's own bytes. */
function locate(body: string, key: string | null, value: unknown): { quote: string; offset: number | null } {
  const v = JSON.stringify(value) ?? "null";
  if (key !== null)
    for (const q of [`"${key}":${v}`, `"${key}": ${v}`]) {
      const i = body.indexOf(q);
      if (i >= 0) return { quote: q, offset: i };
    }
  const i = body.indexOf(v);
  return { quote: key === null ? v : `"${key}":${v}`, offset: i >= 0 ? i : null };
}

/** The JSON check: the value at the anchor's path against the claim. `body` is the exact text that was hashed. */
export function checkJson(a: Anchor, body: string): Outcome {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return out("UNREACHABLE", "not_json");
  }
  if (!a.path) return out("NOT_PRESENT", "no_anchor_path");
  const r = readPath(data, a.path);
  if (!r.found) return out("NOT_PRESENT", "path_absent");
  const values = r.values;
  if (values.some((v) => v === null || v === undefined)) return out("NOT_PRESENT", "value_null");
  const cmp = (a.comparator ?? "eq") as Comparator;
  if (!COMPARATORS.includes(cmp)) return out("NOT_PRESENT", "bad_comparator");
  // all_eq: every value must match; any other comparator reads exactly one value.
  if (cmp !== "all_eq" && values.length !== 1) return out("NOT_PRESENT", "path_ambiguous");
  for (const v of values) {
    const c = compareValue(a, v);
    if (!c.ok) {
      const l = locate(body, r.lastKey, v);
      return out(c.reason === "not_a_number" ? "NOT_PRESENT" : "CONTRADICTED", c.reason, l.quote, l.offset, show(v));
    }
  }
  const first = values[0];
  const l = locate(body, r.lastKey, first);
  return out("SUPPORTED", cmp === "all_eq" ? `all_${values.length}_match` : compareValue(a, first).reason, l.quote, l.offset, values.length === 1 ? show(first) : values.map(show).join(", "));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘" };

/** A page's visible text: scripts, styles and tags removed, common entities decoded, whitespace collapsed. */
export function pageText(htmlOrText: string): string {
  return htmlOrText
    .replace(/<(script|style|noscript|template)\b[^]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k]!;
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
      return m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Where a quote sits, word for word, in the page's text (whitespace collapsed on both sides), or -1. Empty: -1. */
export function verbatimOffset(quote: string, text: string): number {
  const q = norm(quote);
  if (!q) return -1;
  return text.indexOf(q);
}

/** The text check: the claim's phrase must appear word for word in the page. */
export function checkText(a: Anchor, raw: string): Outcome {
  const text = pageText(raw);
  if (text.length < MIN_TEXT_CHARS) return out("UNREACHABLE", "empty_page");
  const phrase = a.expected ?? "";
  if (!norm(phrase)) return out("NOT_PRESENT", "no_phrase");
  const i = verbatimOffset(phrase, text);
  return i >= 0 ? out("SUPPORTED", "phrase_found", text.slice(i, i + norm(phrase).length), i, null) : out("NOT_PRESENT", "phrase_absent");
}

/**
 * The fail-closed gate on a fetch: a redirect, an error status, or an empty body is UNREACHABLE, never SUPPORTED and
 * never NOT_PRESENT. Null when the body may be read.
 */
export function fetchGate(status: number, body: string): Outcome | null {
  if (status >= 300 && status < 400) return out("UNREACHABLE", `http_${status}`);
  if (status < 200 || status >= 300) return out("UNREACHABLE", `http_${status}`);
  if (!body.trim()) return out("UNREACHABLE", "empty_page");
  return null;
}

/** The whole deterministic check for one body: JSON or text by the anchor. "none" has nothing to compare. */
export function checkBody(a: Anchor, status: number, body: string): Outcome {
  const gate = fetchGate(status, body);
  if (gate) return gate;
  if (a.kind === "json") return checkJson(a, body);
  if (a.kind === "text") return checkText(a, body);
  return out("NOT_PRESENT", "no_anchor");
}

/**
 * The LLM pass's answer, checked in code: its quote must be in the fetched page word for word, otherwise the verdict is
 * NOT_PRESENT (quote_not_verbatim), whatever the model said. It can say SUPPORTED or CONTRADICTED, never UNREACHABLE.
 */
export function acceptLlmAnswer(answer: unknown, rawPage: string): Outcome {
  const a = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  const said = String(a.verdict ?? "").toLowerCase();
  const quote = typeof a.quote === "string" ? a.quote : "";
  const text = pageText(rawPage);
  if (said !== "supported" && said !== "contradicted") return out("NOT_PRESENT", "llm_not_present");
  // Too short to show anything (a bare number or word can match anywhere).
  if (norm(quote).length < 12) return out("NOT_PRESENT", "quote_not_verbatim");
  const i = verbatimOffset(quote, text);
  if (i < 0) return out("NOT_PRESENT", "quote_not_verbatim");
  return out(said === "supported" ? "SUPPORTED" : "CONTRADICTED", `llm_${said}`, text.slice(i, i + norm(quote).length), i, null);
}

/** Certainty words removed before a claim goes to the LLM (eval §1.2: judges are swayed by confident wording). */
export function plainClaim(text: string): string {
  return norm(text.replace(/\b(clearly|definitely|certainly|undoubtedly|absolutely|obviously|guaranteed|proven)\b/gi, ""));
}

/** JSON with sorted keys at every level: the bytes a row hash is taken over. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A log row's hash: sha256(prev_hash + canonical JSON of the row without its own hash). */
export const rowHash = (prev: string, row: Record<string, unknown>) => sha256Hex(prev + canonicalJson(row));

/** Walks a chain in order; the first row whose link or hash doesn't match, or null when it holds. */
export async function verifyChain<R extends { prev_hash: string; row_hash: string }>(rows: R[]): Promise<{ ok: boolean; broken_at: number | null }> {
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const { row_hash, ...rest } = rows[i]!;
    if (rest.prev_hash !== prev || (await rowHash(prev, rest)) !== row_hash) return { ok: false, broken_at: i };
    prev = row_hash;
  }
  return { ok: true, broken_at: null };
}

// --- The brief gate's extraction (scripts/check-claims.mjs) ---------------------------------------------------------

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

export interface ExtractedNumber {
  raw: string;
  value: number;
  index: number;
}
export interface ExtractedClaim {
  sentence: string;
  numbers: ExtractedNumber[];
  urls: string[];
}

/** URLs and bare site paths in a text (trailing punctuation dropped). */
export function extractUrls(text: string): string[] {
  const urls = [...text.matchAll(/https?:\/\/[^\s<>()"'`]+|(?<![\w/.])\/(?:[a-z0-9][\w.-]*)(?:\/[\w.-]+)*(?:\.json)?(?:\?[\w=&.-]+)?/gi)].map((m) => m[0].replace(/[.,;:)\]]+$/, ""));
  return [...new Set(urls)];
}

/**
 * The numbers a sentence states, leaving out what isn't a claim: dates ("29 Oct", 2026-10-29), times, years,
 * versions (0.6.0, v1.0.1), "#4", ADR or migration numbers (0113), and anything inside a URL or hash.
 */
export function extractNumbers(sentence: string): ExtractedNumber[] {
  let masked = sentence;
  const blank = (re: RegExp) => (masked = masked.replace(re, (m) => " ".repeat(m.length)));
  blank(/https?:\/\/\S+|(?<![\w/.])\/[a-z0-9][\w./?=&-]*/gi);
  blank(/\b[0-9a-f]{7,}\b/gi);
  blank(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g);
  blank(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b\\.?`, "gi"));
  blank(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"));
  blank(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g);
  blank(/\bv?\d+\.\d+\.\d+\b|\bv\d+(?:\.\d+)?\b/gi);
  blank(/#\d+/g);
  blank(/\b(?:19|20)\d{2}\b(?!,\d)/g);
  blank(/\b0\d{3}\b/g);
  const nums: ExtractedNumber[] = [];
  for (const m of masked.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s?[kKmM]\b)?(%)?/g)) {
    const raw = `${m[1]}${m[2]?.trim() ?? ""}${m[3] ?? ""}`;
    const value = parseNumber(raw);
    if (value !== null) nums.push({ raw, value, index: m.index ?? 0 });
  }
  return nums;
}

/** Splits a draft into sentences (and list lines) and keeps those that state a number. */
export function extractClaims(text: string): ExtractedClaim[] {
  const pieces = text
    .split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+\.)\s)|(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map((s) => norm(s))
    .filter(Boolean);
  return pieces.map((sentence) => ({ sentence, numbers: extractNumbers(sentence), urls: extractUrls(sentence) })).filter((c) => c.numbers.length > 0);
}

/** The comparator a sentence's wording implies: "at least"/"over" → gte, "about"/"roughly" → approx, else eq. */
export function impliedComparator(sentence: string, at: number): Comparator {
  const before = sentence.slice(Math.max(0, at - 24), at).toLowerCase();
  if (/(at least|over|more than|above|\+)\s*$/.test(before)) return "gte";
  if (/(at most|under|fewer than|less than|below|up to)\s*$/.test(before)) return "lte";
  if (/(about|around|roughly|approximately|nearly|almost|some|~|≈)\s*$/.test(before)) return "approx";
  return "eq";
}

/** Every leaf path in a JSON value whose number equals `value` (for a sentence with a source but no known anchor). */
export function findNumber(data: unknown, value: number, path = "", hits: string[] = [], limit = 5): string[] {
  if (hits.length >= limit) return hits;
  if (typeof data === "number" && data === value) hits.push(path || "(root)");
  else if (Array.isArray(data)) data.forEach((v, i) => findNumber(v, value, `${path}[${i}]`, hits, limit));
  else if (data && typeof data === "object") for (const [k, v] of Object.entries(data)) findNumber(v, value, path ? `${path}.${k}` : k, hits, limit);
  return hits;
}
