import type { CheckQuery } from "@forge/shared";
import type { Advisory, AdvisoryResult } from "./advisories";
import type { CheckResult } from "./forge";
import { listShare, type Share } from "./receipts";
import type { ExposureResult } from "./exposure";

// Compact answers (ADR 0056). On 26 Oct a live `forge_check pypi:litellm` came back as ~15 KB of JSON: 25 full advisory
// objects and every field, most of them null or 0, with the verdict somewhere in the middle. An agent pays for every
// byte in its context window, for what is mostly a yes/no question. Agent channels (MCP and A2A) now answer with:
// - `summary` first: verdict, security status, counts, the top 3 advisories (exploited in the wild, then malicious,
//   then newest) with the fixed versions above the version asked about, and the receipt and page links;
// - long lists capped, each with `truncated: true`, the count shown and a link to the full list;
// - null fields and empty lists left out;
// - `related`: the natural next calls as ready-to-send arguments (data, never instructions).
// `detail: "full"` returns every field as before (plus `summary` and `related`). REST (/api/v1/check), which the
// plugin, CLI and GitHub Action read, keeps its full shape and gains `summary` and `related`.

/** Advisories kept in a compact answer's list; the rest are counted and linked. */
export const COMPACT_ADVISORIES = 5;
/** Advisories named in `summary.top_advisories`. */
export const TOP_ADVISORIES = 3;
/** Reports and other lists kept in a compact answer. */
export const COMPACT_LIST = 5;

export type Detail = "compact" | "full";

/**
 * Orders two version strings: numbers compare as numbers, a pre-release tag (1.2.0rc1, 1.2.0-beta.1) sorts before its
 * release, build metadata (+…) is ignored. Good enough to pick fixed versions above an asked one; not a full PEP 440
 * or semver implementation.
 */
export function compareVersions(a: string, b: string): number {
  const tok = (v: string) => (v.toLowerCase().replace(/^v/, "").split("+")[0]!.match(/\d+|[a-z]+/g) ?? []) as string[];
  const x = tok(a);
  const y = tok(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return q !== undefined && /^\d/.test(q) ? -1 : 1;
    if (q === undefined) return /^\d/.test(p) ? 1 : -1;
    const pn = /^\d/.test(p);
    const qn = /^\d/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d) return Math.sign(d);
    } else if (pn !== qn) return pn ? 1 : -1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Exploited in the wild first, then malicious-package records, then the most recently changed. */
export function rankAdvisories(list: Advisory[]): Advisory[] {
  const when = (a: Advisory) => a.modified ?? a.published ?? "";
  return [...list].sort(
    (a, b) =>
      Number(!!b.exploited_in_wild) - Number(!!a.exploited_in_wild) ||
      Number(b.kind === "malicious") - Number(a.kind === "malicious") ||
      when(b).localeCompare(when(a)),
  );
}

/** The fixed versions that matter for the asked version (those above it), lowest first; all of them without one. */
export function fixedAbove(fixed: string[], asked: string | null): string[] {
  const list = asked ? fixed.filter((f) => compareVersions(f, asked) > 0) : fixed;
  return [...new Set(list)].sort(compareVersions).slice(0, 3);
}

/** OSV's own list of every advisory for a package, for a capped list's `full_list_url`. */
export const osvListUrl = (ps: Pick<AdvisoryResult, "ecosystem" | "package">) =>
  `https://osv.dev/list?ecosystem=${encodeURIComponent(ps.ecosystem)}&q=${encodeURIComponent(ps.package)}`;

/** One ready-to-send next call, labelled by how it relates to this answer. Data only. */
export interface Related {
  relation: "full_answer" | "scan_skill_file" | "candidate" | "watch_fingerprint" | "check_match" | "rescan";
  tool: "forge_check" | "forge_scan" | "forge_watch";
  arguments: Record<string, unknown>;
  /** Set when the tool lives on another endpoint than the one answering (the signed-in /mcp has no forge_scan). */
  mcp_server?: string;
}

const askedOf = (q: CheckQuery) => (q.id ? { id: q.id } : q.url ? { url: q.url } : { fingerprint: q.fingerprint! });

/** github.com/<owner>/<repo>[/path] → the github.com URL forge_scan reads the SKILL.md from. */
export function skillFileUrl(id: string): string | null {
  const m = /^github\.com\/([a-z0-9][a-z0-9_.-]*)\/([a-z0-9_.-]+)(\/.*)?$/i.exec(id);
  if (!m) return null;
  const rest = (m[3] ?? "").replace(/\/+$/, "");
  if (/^\/(tree|blob)\//.test(rest)) return `https://github.com/${m[1]}/${m[2]}${rest}`;
  return rest ? `https://github.com/${m[1]}/${m[2]}/tree/HEAD${rest}` : `https://github.com/${m[1]}/${m[2]}`;
}

/** The natural next calls after a check, as data: the full answer when lists were cut, the skill file, candidates. */
export function checkRelated(r: CheckResult, q: CheckQuery, opts: { truncated: boolean; publicServer?: string }): Related[] {
  const out: Related[] = [];
  if (opts.truncated) out.push({ relation: "full_answer", tool: "forge_check", arguments: { ...askedOf(q), ...(q.version ? { version: q.version } : {}), detail: "full" } });
  const file = r.tool && (r.tool.kind === "skill" || r.tool.kind === "plugin") ? skillFileUrl(r.tool.id) : null;
  if (file) out.push({ relation: "scan_skill_file", tool: "forge_scan", arguments: { url: file }, ...(opts.publicServer ? { mcp_server: opts.publicServer } : {}) });
  for (const c of (r.candidates ?? []).slice(0, 3)) out.push({ relation: "candidate", tool: "forge_check", arguments: { id: c.id, ...(q.version ? { version: q.version } : {}) } });
  return out;
}

export interface CheckSummary {
  verdict: CheckResult["verdict"];
  security_status: CheckResult["security_status"];
  known: boolean;
  tool: string;
  version?: string;
  field_reports: number;
  people: number;
  verified_people: number;
  forge_score?: number;
  /** False when there was no npm or PyPI package to ask OSV about, or OSV couldn't be reached ("not checked"). */
  advisories_checked: boolean;
  advisories?: number;
  malicious?: number;
  exploited_in_wild?: number;
  top_advisories?: { id: string; kind: Advisory["kind"]; cve?: string; exploited_in_wild?: true; fixed_in?: string[] }[];
  other_versions_flagged?: number;
  candidates?: number;
}

/** The short answer an agent reads first. Null values are left out; the links stay in page_url and share. */
export function checkSummary(r: CheckResult, q: CheckQuery): CheckSummary {
  const ps = r.public_signals_summary;
  const asked = r.asked_version ?? ps?.version ?? null;
  const list = ps ? rankAdvisories(ps.advisories) : [];
  const version = r.asked_version ?? r.version ?? undefined;
  return {
    verdict: r.verdict,
    security_status: r.security_status,
    known: r.known,
    tool: r.tool?.id ?? q.id ?? q.url ?? q.fingerprint ?? "",
    ...(version ? { version } : {}),
    field_reports: r.reports_for_this_version,
    people: r.distinct_owners,
    verified_people: r.verified_owners,
    ...(r.forge_score != null ? { forge_score: r.forge_score } : {}),
    advisories_checked: !!ps,
    ...(ps
      ? {
          advisories: ps.total,
          malicious: ps.advisories.filter((a) => a.kind === "malicious").length,
          exploited_in_wild: ps.advisories.filter((a) => a.exploited_in_wild).length,
        }
      : {}),
    ...(list.length
      ? {
          top_advisories: list.slice(0, TOP_ADVISORIES).map((a) => {
            const cve = [a.id, ...a.aliases].find((x) => x.startsWith("CVE-"));
            const fixed = fixedAbove(a.fixed, asked);
            return { id: a.id, kind: a.kind, ...(cve ? { cve } : {}), ...(a.exploited_in_wild ? { exploited_in_wild: true as const } : {}), ...(fixed.length ? { fixed_in: fixed } : {}) };
          }),
        }
      : {}),
    ...(r.other_versions_flagged.length ? { other_versions_flagged: r.other_versions_flagged.length } : {}),
    ...(r.candidates?.length ? { candidates: r.candidates.length } : {}),
  };
}

/** Fields left out of a compact answer when they hold nothing: null, an empty list, or a zero strain count. */
function dropEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    // An empty candidates list stays: it says a bare name was searched and nothing matched.
    if (Array.isArray(v) && !v.length && k !== "candidates") continue;
    if ((k === "strain_reports" || k === "strain_hook_reports") && v === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** The advisory list cut to COMPACT_ADVISORIES (ranked), marked and linked when cut. */
export function compactAdvisories(ps: AdvisoryResult) {
  const ranked = rankAdvisories(ps.advisories);
  if (ranked.length <= COMPACT_ADVISORIES && ps.total <= ranked.length) return { ...ps, advisories: ranked };
  return { ...ps, advisories: ranked.slice(0, COMPACT_ADVISORIES), shown: Math.min(COMPACT_ADVISORIES, ranked.length), truncated: true as const, full_list_url: osvListUrl(ps) };
}

/**
 * The share fields an agent needs: the receipt link, and the live badge when there is one. The receipt's badge forms
 * are its URL plus /badge.svg; the live page is the answer's page_url.
 */
const compactShare = (s: Share) => dropEmpty({ receipt_url: s.receipt_url, badge_markdown: s.badge_markdown });

export type CheckAnswer = CheckResult & { share: Share };

/** True when a compact answer would cut a list, so `related` offers the full answer. */
const cuts = (r: CheckResult) =>
  !!r.public_signals_summary && (r.public_signals_summary.advisories.length > COMPACT_ADVISORIES || r.public_signals_summary.total > r.public_signals_summary.advisories.length) || r.reports.length > COMPACT_LIST;

/**
 * A check answer for an agent channel. Compact by default (ADR 0056); `full` keeps every field of the old answer and
 * adds `summary` and `related`.
 */
export function agentCheckAnswer(a: CheckAnswer, q: CheckQuery, detail: Detail = "compact", opts: { publicServer?: string } = {}) {
  const summary = checkSummary(a, q);
  const truncated = detail === "compact" && cuts(a);
  const related = checkRelated(a, q, { truncated, publicServer: opts.publicServer });
  if (detail === "full") return { summary, ...a, ...(related.length ? { related } : {}) };
  const { public_signals_summary: ps, share, reports, ...rest } = a;
  return {
    summary,
    ...dropEmpty(rest),
    ...(ps ? { public_signals_summary: compactAdvisories(ps) } : {}),
    ...(reports.length ? { reports: reports.slice(0, COMPACT_LIST), ...(reports.length > COMPACT_LIST ? { reports_shown: COMPACT_LIST, reports_truncated: true } : {}) } : {}),
    ...(related.length ? { related } : {}),
    share: compactShare(share),
  };
}

/** The REST answer: the full shape every existing client reads, with `summary` first and `related` added. */
export function restCheckAnswer(a: CheckAnswer, q: CheckQuery) {
  const related = checkRelated(a, q, { truncated: false });
  return { summary: checkSummary(a, q), ...a, ...(related.length ? { related } : {}) };
}

/** After a scan: the file's fingerprint for a later forge_watch. */
export const scanRelated = (fingerprint: string): Related[] => [{ relation: "watch_fingerprint", tool: "forge_watch", arguments: { fingerprints: [fingerprint] } }];

/** After an exposure check: each match (up to 5) as a forge_check of that exact version, for its field reports. */
export const exposureRelated = (matches: { ecosystem: "npm" | "pypi"; package: string; version: string }[]): Related[] =>
  matches.slice(0, COMPACT_LIST).map((m) => ({ relation: "check_match", tool: "forge_check", arguments: { id: `${m.ecosystem}:${m.package}`, version: m.version } }));

/** An exposure answer with its receipt and next calls (ADR 0056). The list asked about is hashed, never kept. */
export async function exposureAnswer(env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">, r: ExposureResult, asked: string[]) {
  const related = exposureRelated(r.matches);
  const flagged = r.matches.filter((m) => m.status === "flagged").length;
  return { ...r, ...(related.length ? { related } : {}), share: await listShare(env, "exposure", { items: asked, matched: r.matched, flagged }) };
}

/** A watch answer with its receipt (ADR 0056). */
export async function watchAnswer<T extends { flagged: number; caution: number }>(env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">, w: T, fingerprints: string[]) {
  return { ...w, share: await listShare(env, "watch", { items: fingerprints, matched: w.flagged + w.caution, flagged: w.flagged }) };
}
