import type { ScanResult } from "@forge/shared";
import type { CheckResult } from "./forge";
import { scanPath } from "./scans";
import { signReport } from "./signing";
import { splitInlineVersion } from "./tools";

// Forge receipts (conversion review, 24 Oct 2026): every check and scan returns a link an agent can paste where its
// work is reviewed (a pull request, a README, a Moltbook post). The link carries what the Forge answered and when,
// signed with the server key, so anyone can open it and see the signature hold. Nothing is stored: the receipt is the
// link. A receipt records an answer at a moment, never that a tool is safe; its page links to the current answer.
// Data only (AGENTS.md rule 7): the share fields are URLs and Markdown, never instructions.

export const RECEIPT_SCHEMA = 1;
export const RECEIPT_KINDS = ["check", "scan", "exposure", "watch"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];
const MAX_TOKEN = 2400;

export interface ReceiptPayload {
  v: typeof RECEIPT_SCHEMA;
  kind: ReceiptKind;
  /**
   * check: the tool id asked about; scan: the file's sha256 fingerprint; exposure and watch: a sha256 of the sorted
   * list asked about (ADR 0056), so the same list gives the same subject and the list itself is never in the link.
   */
  subject: string;
  version: string | null;
  /** check: the display verdict; scan: flagged, caution or clear; exposure: flagged, caution or no_match; watch: flagged, caution or no_flags. */
  verdict: string;
  /** check only: security_status and how many published advisories matched. */
  security?: string;
  advisories?: number;
  /** check only, when above 0: reports on this version confirmed by 2+ distinct other owners (V1, ADR 0047). */
  corroborated?: number;
  /** scan only: the rules version and the public URL scanned, if any. */
  rules?: string;
  source?: string | null;
  /** exposure and watch: how many items were asked about, and how many matched an advisory or were flagged. */
  items?: number;
  matched?: number;
  /** ISO time to the minute. */
  at: string;
}

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));
const sign = async (key: string, body: string) => (await signReport(key, { receipt: body })).replace(/^hmac-sha256:/, "");

export async function receiptToken(key: string, p: ReceiptPayload) {
  const body = JSON.stringify(p);
  return `${b64url(body)}.${await sign(key, body)}`;
}

/** The payload when the token is well formed and its signature is the Forge's; null otherwise. Never throws. */
export async function readReceipt(key: string, token: string): Promise<ReceiptPayload | null> {
  if (token.length > MAX_TOKEN) return null;
  const m = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  try {
    const body = unb64url(m[1]!);
    if ((await sign(key, body)) !== m[2]) return null;
    const p = JSON.parse(body) as ReceiptPayload;
    return p && p.v === RECEIPT_SCHEMA && (RECEIPT_KINDS as readonly string[]).includes(p.kind) && typeof p.subject === "string" ? p : null;
  } catch {
    return null;
  }
}

const minute = (now: number) => new Date(now).toISOString().slice(0, 16) + "Z";
export const receiptPath = (token: string) => `/r/${token}`;

export interface Share {
  /** A signed, permanent link to this answer (what was asked, the verdict, when). */
  receipt_url: string;
  /** A small image of the receipt, for a README or a pull request. */
  receipt_badge_url: string;
  /** Markdown for the badge, linking to the receipt. */
  receipt_markdown: string;
  /** The live page for this tool or file, when it has one. */
  page_url: string | null;
  /** A live README badge, when the tool or file has one. */
  badge_markdown: string | null;
}

function share(origin: string, token: string, label: string, page: string | null, badge: string | null): Share {
  const url = `${origin}${receiptPath(token)}`;
  const img = `${url}/badge.svg`;
  return { receipt_url: url, receipt_badge_url: img, receipt_markdown: `[![${label}](${img})](${url})`, page_url: page, badge_markdown: badge };
}

/** Share fields for a forge_check answer. `asked` is the id as the agent gave it (the tool may be unknown). */
export async function checkShare(env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">, r: CheckResult, asked: string, now = Date.now()): Promise<Share> {
  // A version written into the id (npm:x@1.2.3) goes in `version`, so the subject is the tool and its live link works.
  const subject = r.tool?.id ?? splitInlineVersion(asked).id;
  const token = await receiptToken(env.REPORT_SIGNING_KEY, {
    v: RECEIPT_SCHEMA,
    kind: "check",
    subject,
    version: r.version ?? r.public_signals_summary?.version ?? null,
    verdict: r.verdict,
    security: r.security_status,
    advisories: r.public_signals_summary?.total ?? 0,
    // Only when there is one, so receipts for tools with no confirmed reports stay as they were.
    ...(r.corroborated_reports > 0 ? { corroborated: r.corroborated_reports } : {}),
    at: minute(now),
  });
  const origin = env.PUBLIC_ORIGIN;
  // The live badge exists only for tools with reports (web/badge.ts), so it's offered only then.
  const badge = r.known && r.distinct_owners > 0 && r.page_url ? `[![Forge](${origin}/badge/${encodeURIComponent(subject)}.svg)](${r.page_url})` : null;
  return share(origin, token, "Forge check", r.page_url, badge);
}

/** Share fields for a forge_scan answer. */
export async function scanShare(
  env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">,
  r: Pick<ScanResult, "fingerprint" | "verdict" | "rules_version">,
  opts: { isPublic: boolean; sourceUrl?: string | null },
  now = Date.now(),
): Promise<Share> {
  const token = await receiptToken(env.REPORT_SIGNING_KEY, {
    v: RECEIPT_SCHEMA,
    kind: "scan",
    subject: r.fingerprint,
    version: null,
    verdict: r.verdict,
    rules: r.rules_version,
    source: opts.sourceUrl ?? null,
    at: minute(now),
  });
  const origin = env.PUBLIC_ORIGIN;
  const page = opts.isPublic ? `${origin}${scanPath(r.fingerprint)}` : null;
  // web/scan.ts serves /scan/badge.svg for a public file that has been scanned.
  const badge = opts.isPublic && opts.sourceUrl ? `[![Forge scan](${origin}/scan/badge.svg?url=${encodeURIComponent(opts.sourceUrl)})](${page})` : null;
  return share(origin, token, "Forge scan", page, badge);
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
/** sha256 of the sorted, de-duplicated list: the same list asked twice gives the same receipt subject. */
export async function listSubject(items: string[]) {
  const body = [...new Set(items)].sort().join("\n");
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))}`;
}

/** Share fields for a forge_exposure or forge_watch answer: the receipt only (there is no live page for a list). */
export async function listShare(
  env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">,
  kind: "exposure" | "watch",
  r: { items: string[]; matched: number; flagged: number },
  now = Date.now(),
): Promise<Pick<Share, "receipt_url" | "receipt_badge_url" | "receipt_markdown">> {
  const verdict = r.flagged ? "flagged" : r.matched ? "caution" : kind === "exposure" ? "no_match" : "no_flags";
  const token = await receiptToken(env.REPORT_SIGNING_KEY, { v: RECEIPT_SCHEMA, kind, subject: await listSubject(r.items), version: null, verdict, items: new Set(r.items).size, matched: r.matched, at: minute(now) });
  const { receipt_url, receipt_badge_url, receipt_markdown } = share(env.PUBLIC_ORIGIN, token, kind === "exposure" ? "Forge exposure check" : "Forge watch", null, null);
  return { receipt_url, receipt_badge_url, receipt_markdown };
}
