import { SCAN_RULES } from "./skill-scan";

// Untrusted text (ADR 0157). Anything a caller or another member typed can reach an agent's context: a tool id echoed
// in a check answer, a signed receipt, a note on a tool page. Two lines of defence live here, both pure functions:
// - a strict grammar for the ids forge_check accepts, so a check id is an identifier and never a sentence;
// - an injection-pattern check (our own forge_scan rules for hidden instructions and prompt injection, plus a few
//   patterns aimed at a model reading the text), used to refuse ids and to hold field-report notes for review.
// Neither is a guarantee: they narrow what free text can say. The other half of the fix is never echoing or signing
// unknown input (services/compact.ts, services/receipts.ts) and never giving third-party text to agents (web/markdown.ts).

/** Whitespace, control, format (zero-width, bidi), and line or paragraph separators: never part of an identifier. */
const UNSAFE_CHAR = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
export const hasUnsafeChars = (s: string) => UNSAFE_CHAR.test(s);

/** The same string percent-decoded (once, then again), or null when it isn't valid percent-encoding. */
function decoded(s: string): string | null {
  try {
    const once = decodeURIComponent(s);
    try {
      return decodeURIComponent(once);
    } catch {
      return once;
    }
  } catch {
    return null;
  }
}

/** Families of our scan rules that are about instructions to a model rather than about what code does. */
const INJECTION_FAMILIES = new Set(["injection", "hidden", "remote"]);
const INJECTION_EXTRA = new Set(["FS-PER-001", "FS-PRM-001"]);
const SCAN_INJECTION_RULES = SCAN_RULES.filter((r) => INJECTION_FAMILIES.has(r.family) || INJECTION_EXTRA.has(r.id));

const VERBS = /\b(?:print|output|say|reply|respond|echo|repeat|return|write|type|answer|state)\b(?:\s+(?:with|back|out|only|exactly|verbatim|the(?:\s+(?:word|string|text|token|phrase|code))?|this|following|:))*\s*[:"'`“”]?\s*/gi;
/** "print CANARY_OK": an instruction to emit a marker token (upper case with an underscore), the classic canary. */
function printsMarker(text: string): boolean {
  for (const m of text.matchAll(VERBS)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/.test(rest)) return true;
  }
  return false;
}

/** Patterns aimed at a model reading the text (NT-INJ-*), on top of the scan rules. */
const NOTE_RULES: { id: string; test: (s: string) => boolean }[] = [
  { id: "NT-INJ-001", test: printsMarker },
  {
    id: "NT-INJ-002",
    test: (s) =>
      /\b(?:ai|llm|language model|assistant|agent|claude|chatgpt|gpt|gemini|copilot)s?\s+(?:reading|processing|parsing|summari[sz]ing|seeing)\s+this\b/i.test(s) ||
      /\b(?:if|when)\s+you(?:'re|\s+are)?\s+(?:an?\s+)?(?:ai|llm|language model|assistant|agent)\b/i.test(s) ||
      /\b(?:instructions?|message|note|notice)\s+(?:for|to)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llm|assistant|agent|model)s?\b/i.test(s),
  },
  {
    id: "NT-INJ-003",
    test: (s) =>
      /\byou\s+(?:must|are\s+required\s+to|are\s+instructed\s+to|have\s+been\s+instructed\s+to)\s+(?:now\s+|immediately\s+|first\s+|also\s+)?(?:ignore|print|output|say|reply|respond|run|execute|call|send|visit|open|fetch|install|delete|tell|include|add|write|forget|disregard|approve|trust|recommend)\b/i.test(s),
  },
  {
    id: "NT-INJ-004",
    test: (s) =>
      /(?:^|[\n.!?]\s*)(?:system|assistant|developer)\s*:\s*\S/i.test(s) ||
      /<\/?\s*(?:system|instructions?|im_start|im_end|tool_call|function_call|assistant)\b/i.test(s) ||
      /\[\/?INST\]|<\|im_(?:start|end)\|>|<\|(?:system|assistant|user)\|>/i.test(s),
  },
  {
    id: "NT-INJ-005",
    test: (s) => /\b(?:important|urgent|attention|note)\s*[:!]+\s*(?:ai|assistant|agent|model|llm|you)\b/i.test(s),
  },
];

const normalise = (s: string) => s.normalize("NFKC");

/**
 * The injection-pattern rules a text matches: our forge_scan rules for hidden instructions and prompt injection
 * (FS-INJ, FS-HID, FS-REM, FS-PER-001, FS-PRM-001) and the NT-INJ patterns above. Empty when none match. Pure; never throws.
 */
export function injectionSignals(raw: string): string[] {
  const text = normalise(raw);
  const out = new Set<string>();
  for (const rule of SCAN_INJECTION_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.replace("g", ""));
    const m = re.exec(text);
    if (m && (!rule.confirm || rule.confirm(m))) out.add(rule.id);
  }
  // The scan rules ignore a single zero-width character (FS-HID-004 is medium); in short text any is a signal.
  if (/[\p{Cf}]/u.test(raw)) out.add("FS-HID-004");
  for (const r of NOTE_RULES) if (r.test(text)) out.add(r.id);
  return [...out];
}

/** Words that are common in sentences and rare in package names: three or more distinct ones read as prose. */
const STOP = new Set("the and you your this that then please must should will now before after all any not don't never always ignore instead".split(" "));
function prose(words: string[]): boolean {
  const lower = words.map((w) => w.toLowerCase());
  return new Set(lower.filter((w) => STOP.has(w))).size >= 3;
}

/** An identifier read as words: separators become spaces (underscores kept in one pass, so marker tokens survive). */
function asWords(id: string): string[] {
  const d = decoded(id) ?? id;
  // "print_SR_MARKER": an underscore between a lower-case word and an upper-case token is read as a space too.
  return [d.replace(/[-./:@=+~%#?&,]+/g, " ").replace(/([a-z])_(?=[A-Z])/g, "$1 "), d.replace(/[-./:@=+~%#?&,_]+/g, " ")];
}

/** True when an identifier, read as words, looks like an instruction or a sentence. */
export function textLike(id: string): boolean {
  return asWords(id).some((w) => injectionSignals(w).length > 0 || prose(w.split(/\s+/).filter(Boolean)));
}

/** Longest check id or URL accepted. */
export const CHECK_ID_MAX = 512;
const VER = "[0-9A-Za-z][0-9A-Za-z.+!_-]{0,63}";
const HOST = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*";

/** The id forms forge_check accepts (MASTER_PLAN §6.5 plus the aliases the seeds write), each with its own limits. */
const ID_FORMS: { form: string; re: RegExp; max: number }[] = [
  { form: "npm", re: new RegExp(`^npm:(?:@[a-z0-9][a-z0-9._~-]{0,213}/)?[a-z0-9][a-z0-9._~-]{0,213}(?:@${VER})?$`, "i"), max: 300 },
  { form: "pypi", re: new RegExp(`^pypi:[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?(?:(?:===?|@)${VER})?$`, "i"), max: 200 },
  { form: "github", re: new RegExp(`^(?:www\\.)?github\\.com/[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9_.-]{1,100}(?:/[a-z0-9_.@%+~-]{1,200}){0,30}/?(?:@${VER})?$`, "i"), max: 400 },
  { form: "mcp-registry", re: /^mcp-registry:[a-z0-9][a-z0-9._/-]{0,199}$/i, max: 214 },
  { form: "smithery", re: /^smithery:@?[a-z0-9][a-z0-9._/-]{0,199}$/i, max: 214 },
  { form: "sha256", re: /^sha256:[0-9a-f]{64}$/, max: 71 },
  { form: "bare", re: new RegExp(`^@?[a-z0-9][a-z0-9._~-]{0,213}(?:/[a-z0-9][a-z0-9._~-]{0,213})?(?:@${VER})?$`, "i"), max: 214 },
];
const URL_FORM = new RegExp(`^https?://${HOST}(?::\\d{1,5})?(?:/[A-Za-z0-9._~%@+:,=-]*)*(?:\\?[A-Za-z0-9._~%@+:,=&/-]*)?(?:#[A-Za-z0-9._~%@+:,=&/-]*)?$`, "i");

export type IdProblem = "empty" | "too_long" | "characters" | "form" | "text_like";

/**
 * Why a web URL can't be used as a tool's URL, or null when it can: an http(s) URL with a plain host, no whitespace,
 * control, zero-width or direction characters (also once percent-decoded), and nothing that reads as an instruction.
 */
export function urlProblem(url: string, max = CHECK_ID_MAX): IdProblem | null {
  if (!url) return "empty";
  if (url.length > max) return "too_long";
  const d = decoded(url);
  if (hasUnsafeChars(url) || d === null || hasUnsafeChars(d)) return "characters";
  if (!URL_FORM.test(url)) return "form";
  return textLike(url) ? "text_like" : null;
}

/** Why a forge_check id is refused, or null when it is one of the accepted forms. Pure; never throws. */
export function checkIdProblem(id: string): IdProblem | null {
  if (!id) return "empty";
  if (id.length > CHECK_ID_MAX) return "too_long";
  if (hasUnsafeChars(id)) return "characters";
  if (/^https?:\/\//i.test(id)) return urlProblem(id);
  const d = decoded(id);
  if (d === null || hasUnsafeChars(d)) return "characters";
  const form = ID_FORMS.find((f) => f.re.test(id));
  if (!form) return "form";
  if (id.length > form.max) return "too_long";
  return textLike(id) ? "text_like" : null;
}

export const isCheckId = (id: string) => checkIdProblem(id) === null;

/** Longest version accepted (the same limit as a version written into an id). */
export const VERSION_MAX = 64;
/**
 * Why a version string is refused, or null: at most 64 characters, the version characters only (checked by the
 * callers' VERSION_PATTERN), and nothing that reads as an instruction once its separators are read as spaces.
 */
export function versionProblem(v: string): IdProblem | null {
  if (!v) return "empty";
  if (v.length > VERSION_MAX) return "too_long";
  if (hasUnsafeChars(v)) return "characters";
  return textLike(v) ? "text_like" : null;
}

/**
 * A tool name from a remote MCP server (third-party text), or null when it isn't a plain name: the MCP tool-name
 * characters, 128 at most, and nothing that reads as an instruction.
 */
export const plainToolName = (name: string): string | null => (/^[A-Za-z0-9_.\-/]{1,128}$/.test(name) && !textLike(name) ? name : null);

/** The fixed message for a refused id: it never repeats the input. */
export const CHECK_ID_MESSAGE =
  "id must be npm:<package>, pypi:<package>, github.com/<owner>/<repo>[/path], mcp-registry:<name>, smithery:<name>, sha256:<64 hex>, an https URL or a package name (no spaces or sentences)";
export const CHECK_URL_MESSAGE = "url must be an http(s) web address of the tool with no spaces or sentences";

/** sha256 of a string as "sha256:<hex>": how an id we don't know goes into a receipt instead of the id itself. */
export async function sha256Of(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return `sha256:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
