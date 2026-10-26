// Rejects notes that contain credentials, file paths or links (MASTER_PLAN §6.5, §6.8).
// This is a deterministic first line of defence; Llama Guard moderation runs after it.

export type NoteRejection = "credential" | "file_path" | "link";

const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id (long-lived and temporary)
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\bxapp-[A-Za-z0-9-]{10,}/, // Slack app token
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, // OpenAI-style
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/, // Stripe
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bhf_[A-Za-z0-9]{30,}\b/, // Hugging Face
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email addresses are personal data
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i, // credentials in a URL
  /[?&;](?:password|pwd|passwd|secret|token|key)=[^\s&;]{4,}/i, // credentials in a query or connection string
];

const PATH_PATTERNS: RegExp[] = [
  /(?:^|[\s"'(])(?:~|\.{1,2})?\/(?:home|Users|root|etc|var|tmp|opt|usr)\/\S*/,
  /(?:^|[\s"'(])~\/\S+/,
  /\b[A-Za-z]:\\\S+/,
];

const LINK_PATTERN = /\b(?:https?|ftp|file|data|javascript):\S+|\bwww\.\S+/i;

/**
 * "password: hunter22", "api_key=Xy9…": a value after a secret's name. 26 Oct (ADR 0056): honest notes such as
 * "token: expired after an hour" or "api_key: missing" were refused whole as credentials. Only a known status word
 * after the name passes; any other value of 6+ characters is still treated as a secret, since real passwords can be
 * plain lowercase words ("password: correcthorse").
 */
const NAMED_SECRET = /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(\S{6,})/gi;
const STATUS_WORDS = new Set([
  "expired", "expires", "missing", "required", "invalid", "incorrect", "wrong", "rejected", "revoked", "empty", "undefined",
  "unset", "changed", "denied", "needed", "optional", "redacted", "removed", "rotated", "refused", "ignored", "accepted",
]);
const looksSecret = (v: string) => {
  const s = v.replace(/[.,;:!?)\]}'"]+$/, "");
  return s.length >= 6 && !STATUS_WORDS.has(s.toLowerCase());
};
const hasNamedSecret = (note: string) => [...note.matchAll(NAMED_SECRET)].some((m) => looksSecret(m[1]!));

/**
 * Long unbroken runs of mixed letters and digits look like keys even without a known prefix. A run made of short
 * word-like parts ("context7-mcp-server-for-documentation", a package name) is a name, not a key (ADR 0056).
 */
const wordy = (token: string) => {
  const parts = token.split(/[-_/.]+/).filter(Boolean);
  return parts.length >= 3 && parts.every((p) => p.length <= 20 && /^(?:[a-z]+\d*|\d+)$/i.test(p));
};
function hasHighEntropyToken(text: string): boolean {
  for (const token of text.split(/[\s"'`,;()[\]{}<>]+/)) {
    if (token.length < 32) continue;
    if (/^[A-Za-z0-9+/=_-]+$/.test(token) && /[A-Za-z]/.test(token) && /[0-9]/.test(token) && !wordy(token)) return true;
  }
  return false;
}

/** Zero-width and other invisible characters can split a key so no pattern matches; drop them and fold look-alikes first. */
const normalise = (s: string) => s.normalize("NFKC").replace(/\p{Cf}/gu, "");

export function scanNote(raw: string): NoteRejection | null {
  const note = normalise(raw);
  if (CREDENTIAL_PATTERNS.some((p) => p.test(note)) || hasNamedSecret(note) || hasHighEntropyToken(note)) return "credential";
  if (PATH_PATTERNS.some((p) => p.test(note))) return "file_path";
  if (LINK_PATTERN.test(note)) return "link";
  return null;
}
