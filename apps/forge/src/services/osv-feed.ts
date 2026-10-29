import { SCAN_RULES, SECURITY_ISSUES, type ScanFinding } from "@forge/shared";
import { and, eq, inArray } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "./db";
import { LICENCE_ID } from "./provenance";
import stateFile from "../seed/osv-feed-state.json";
import responsesFile from "../seed/maintainer-responses.json";

// AQ-10 (ADR 0097): an OSV-format feed of the Forge's own findings, for security vendors to ingest. Two kinds of record:
//  - "skill-pattern-finding": a public, flagged skill scan of a SKILL.md pinned to a GitHub commit. A rule match means
//    the line is worth reading, not that the skill is malicious, so no record carries an OSV `severity` (CVSS doesn't
//    describe a pattern match) and every record says so in its summary and in `database_specific`.
//  - "field-report-flag": a tool version our field reports flagged (verified owners' security reports, scoring.ts),
//    never one flagged only because it matches someone else's published advisory (that advisory is the record).
// Only what is already public is published: a scan's row must be public, and nothing from a repository held for the
// launch-scan disclosure window appears before it ends (state.held_until), whatever the row says. Records are built per
// request from the database; ids are derived from a stable key, so they never change.

export const OSV_SCHEMA_VERSION = "1.9.2";
export const OSV_SCHEMA_URL = "https://raw.githubusercontent.com/ossf/osv-schema/main/validation/schema.json";
export const OSV_SPEC_URL = "https://ossf.github.io/osv-schema/";
export const OSV_FEED_PATH = "/feeds/osv";
/** OSV's prefix for a database that osv.dev doesn't aggregate (spec, "id, modified fields"). */
export const OSV_ID_PREFIX = "x_FORGE";
export const OSV_MEANING = "A pattern match means the matched lines are worth reading before installing. It is not a confirmed vulnerability and not a finding that the author acted in bad faith.";

export interface OsvFeedState {
  held_until: string;
  held_repos: string[];
  fixtures: string[];
  maintainers: Record<string, { notice: { date: string; url: string; rule_ids: string[] }; opted_out: boolean }>;
}

/** A maintainer's response with a fix (src/seed/maintainer-responses.json, the same record the scan page shows). */
export interface MaintainerResponse {
  repo: string;
  path: string;
  fingerprint: string;
  scanned_commit: string;
  public_from: string;
  response: { date: string; thread_url: string; fix_label: string; fix_url: string; fix_commit: string; fix_date: string; note?: string };
  rescan?: { date: string; commit: string; fingerprint: string; verdict: string; rules_version: string };
}

let state = stateFile as unknown as OsvFeedState;
let responses = (responsesFile as unknown as { entries: MaintainerResponse[] }).entries;
/** Tests only: swap the state and the maintainer responses (null restores the bundled files). */
export function useOsvState(s: OsvFeedState | null, r: MaintainerResponse[] | null = null) {
  state = s ?? (stateFile as unknown as OsvFeedState);
  responses = r ?? (responsesFile as unknown as { entries: MaintainerResponse[] }).entries;
}
export const heldUntil = () => Date.parse(state.held_until);

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

async function osvId(kind: string, key: string, year: number) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}:${key}`)));
  const hex = [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${OSV_ID_PREFIX}-${year}-${hex}`;
}

/** owner/repo, the 40-hex commit and the path of a raw.githubusercontent.com link pinned to a commit; else null. */
export function pinnedGithub(sourceUrl: string | null | undefined): { owner: string; repo: string; commit: string; path: string } | null {
  try {
    const u = new URL(sourceUrl ?? "");
    if (u.protocol !== "https:" || u.hostname !== "raw.githubusercontent.com") return null;
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [owner, repo, commit, ...rest] = parts;
    if (!owner || !repo || !commit || !rest.length || !/^[0-9a-f]{40}$/.test(commit) || ![owner, repo].every((p) => /^[A-Za-z0-9_.-]+$/.test(p))) return null;
    return { owner, repo, commit, path: rest.join("/") };
  } catch {
    return null;
  }
}

/** Whether a repository's launch-scan rows are still held at `now` (the disclosure window, ADR 0026 and 0065). */
export const repoHeld = (repo: string, now: number) => now < heldUntil() && state.held_repos.includes(repo.toLowerCase());

type Rec = Record<string, unknown> & { id: string; modified: string };

async function skillRecords(env: Env, origin: string, now: number): Promise<Rec[]> {
  const rows = await getDb(env)
    .select()
    .from(t.skillScans)
    .where(and(eq(t.skillScans.verdict, "flagged"), eq(t.skillScans.public, true)));
  const fixtures = new Set(state.fixtures);
  const out: Rec[] = [];
  for (const r of rows) {
    const gh = pinnedGithub(r.sourceUrl);
    if (!gh || fixtures.has(r.fingerprint)) continue;
    const repo = `${gh.owner}/${gh.repo}`;
    if (repoHeld(repo, now)) continue;
    const findings = ((r.findings as ScanFinding[]) ?? []).filter((f) => f.severity === "high" || f.severity === "medium");
    const rules = [...new Set(findings.map((f) => f.rule))];
    const maint = state.maintainers[repo.toLowerCase()];
    // A fix counts for this record when the response is about this file at this commit, and is public by now.
    const resp = responses.find((x) => x.fingerprint === r.fingerprint && x.repo.toLowerCase() === repo.toLowerCase() && x.path === gh.path && x.scanned_commit === gh.commit && Date.parse(x.public_from) <= now);
    const change = resp && /^[0-9a-f]{40}$/.test(resp.response.fix_commit)
      ? { commit: resp.response.fix_commit, date: resp.response.fix_date, url: resp.response.fix_url, ref: `${repo} ${resp.response.fix_label}`, rescan: resp.rescan }
      : undefined;
    // A change counts as a fix only when our rescan of it (if any) is clear. When the pattern still matches, the record
    // says the file changed and stays open at the rescanned commit (last_affected), with no "fixed" event.
    const fix = change && (!change.rescan || change.rescan.verdict === "clear") ? change : undefined;
    const stillMatches = change && !fix && /^[0-9a-f]{40}$/.test(change.rescan!.commit) ? change : undefined;
    const wasHeld = state.held_repos.includes(repo.toLowerCase());
    const publishedMs = Math.max(r.firstSeen, wasHeld ? heldUntil() : 0);
    const modifiedMs = Math.max(publishedMs, maint ? dayMs(maint.notice.date) : 0, change ? dayMs(change.date) : 0, change?.rescan ? dayMs(change.rescan.date) : 0);
    const hex = r.fingerprint.replace(/^sha256:/, "");
    const titles = rules.map((id) => SCAN_RULES.find((x) => x.id === id)?.title ?? id);
    const summary = `Pattern match, not a confirmed vulnerability: ${titles.join("; ")}`;
    const state_ = fix ? "fixed_by_maintainer" : stillMatches ? "changed_still_matching" : maint?.opted_out ? "maintainer_opted_out" : maint ? "notified" : "no_notice";
    const rightOfReply = `${origin}/disputes?tool=${encodeURIComponent(`github.com/${repo.toLowerCase()}`)}&scan=${hex}&from=maintainer`;
    out.push({
      schema_version: OSV_SCHEMA_VERSION,
      id: await osvId("skill", r.fingerprint, new Date(r.firstSeen).getUTCFullYear()),
      modified: iso(modifiedMs),
      published: iso(publishedMs),
      summary: summary.length > 120 ? `${summary.slice(0, 117)}...` : summary,
      details: [
        `The Agent Forge's skill scanner matched ${findings.length === 1 ? "one line" : `${findings.length} lines`} of \`${gh.path}\` in ${repo} at commit ${gh.commit.slice(0, 12)}: ${findings.map((f) => `${f.rule} (line ${f.line})`).join(", ")}.`,
        "",
        OSV_MEANING,
        "",
        `The range below starts at the commit we scanned; earlier commits were not scanned for this record. ${fix ? `The maintainer changed the file in ${fix.ref} (${fix.date}); the range ends at that commit.${fix.rescan ? ` Our rescan of commit ${fix.rescan.commit.slice(0, 12)} (${fix.rescan.date}): ${fix.rescan.verdict}.` : ""}` : stillMatches ? `The maintainer changed the file in ${stillMatches.ref} (${stillMatches.date}). Our rescan of commit ${stillMatches.rescan!.commit.slice(0, 12)} (${stillMatches.rescan!.date}) still matches (${stillMatches.rescan!.verdict}), so the range runs to that commit; later commits were not scanned for this record.` : "It also ends there: later commits were not scanned for this record."}`,
        "",
        `Maintainers can reply or report a fix: ${rightOfReply}`,
      ].join("\n"),
      affected: [
        {
          ranges: [{ type: "GIT", repo: `https://github.com/${repo}`, events: [{ introduced: gh.commit }, fix ? { fixed: fix.commit } : { last_affected: stillMatches ? stillMatches.rescan!.commit : gh.commit }] }],
          database_specific: { path: gh.path, file_sha256: hex },
        },
      ],
      references: [
        { type: "REPORT", url: `${origin}/scan/${hex}` },
        { type: "PACKAGE", url: `https://github.com/${repo}` },
        ...(maint ? [{ type: "DISCUSSION", url: maint.notice.url }] : []),
        ...(fix ? [{ type: "FIX", url: fix.url }] : []),
        ...(stillMatches ? [{ type: "WEB", url: stillMatches.url }] : []),
      ],
      database_specific: {
        kind: "skill-pattern-finding",
        confirmed_vulnerability: false,
        meaning: OSV_MEANING,
        forge_verdict: r.verdict,
        rules_version: r.rulesVersion,
        rules_url: `${origin}/scan/rules`,
        findings: findings.map((f) => ({ rule: f.rule, family: f.family, forge_level: f.severity, line: f.line, ...(f.context ? { context: f.context } : {}) })),
        maintainer: {
          state: state_,
          ...(maint ? { notified_on: maint.notice.date, notice_url: maint.notice.url } : {}),
          ...(fix ? { fixed_on: fix.date, fix_commit: fix.commit, fix_url: fix.url } : {}),
          ...(stillMatches ? { changed_on: stillMatches.date, change_commit: stillMatches.commit, change_url: stillMatches.url } : {}),
          ...(change?.rescan && (fix || stillMatches) ? { our_rescan: { date: change.rescan.date, commit: change.rescan.commit, verdict: change.rescan.verdict, rules_version: change.rescan.rules_version } } : {}),
        },
        right_of_reply_url: rightOfReply,
        scanned_at: iso(r.firstSeen),
        licence: LICENCE_ID,
      },
    });
  }
  return out;
}

const FLAG_STATES = ["flagged", "confirmed_malicious"];

function packageOf(canonical: string): { ecosystem: string; name: string; purl: string } | null {
  if (canonical.startsWith("npm:")) {
    const name = canonical.slice(4);
    return { ecosystem: "npm", name, purl: `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}` };
  }
  if (canonical.startsWith("pypi:")) {
    const name = canonical.slice(5);
    return { ecosystem: "PyPI", name, purl: `pkg:pypi/${name}` };
  }
  return null;
}

async function reportRecords(env: Env, origin: string): Promise<Rec[]> {
  const db = getDb(env);
  const events = await db
    .select({ versionId: t.statusEvents.toolVersionId, from: t.statusEvents.fromStatus, to: t.statusEvents.toStatus, at: t.statusEvents.createdAt })
    .from(t.statusEvents)
    .innerJoin(t.toolVersions, eq(t.toolVersions.id, t.statusEvents.toolVersionId))
    .where(eq(t.toolVersions.advisoryMatch, false))
    .orderBy(t.statusEvents.createdAt);
  const flaggedIds = [...new Set(events.filter((e) => FLAG_STATES.includes(e.to)).map((e) => e.versionId))];
  if (!flaggedIds.length) return [];
  const out: Rec[] = [];
  for (let i = 0; i < flaggedIds.length; i += 90) {
    const ids = flaggedIds.slice(i, i + 90);
    const versions = await db
      .select({ id: t.toolVersions.id, version: t.toolVersions.version, fingerprint: t.toolVersions.fingerprint, canonical: t.tools.canonicalId, kind: t.tools.kind, status: t.toolScores.securityStatus })
      .from(t.toolVersions)
      .innerJoin(t.tools, eq(t.tools.id, t.toolVersions.toolId))
      .leftJoin(t.toolScores, eq(t.toolScores.toolVersionId, t.toolVersions.id))
      .where(inArray(t.toolVersions.id, ids));
    const reports = await db
      .select({ versionId: t.reports.toolVersionId, humanId: t.reports.humanId, issues: t.reports.issues })
      .from(t.reports)
      .where(and(inArray(t.reports.toolVersionId, ids), eq(t.reports.held, false), inArray(t.reports.moderationState, ["none", "approved"])));
    for (const v of versions) {
      const evs = events.filter((e) => e.versionId === v.id);
      const first = evs.find((e) => FLAG_STATES.includes(e.to))!;
      const last = evs[evs.length - 1]!;
      const current = v.status ?? "clear";
      // Every record says "not a confirmed vulnerability", which a version marked confirmed malicious contradicts; and
      // publishing that marking to security vendors is a human decision (AGENTS.md escalation: Legal). Left out.
      if (current === "confirmed_malicious") continue;
      const withdrawn = !FLAG_STATES.includes(current) ? last.at : null;
      const mine = reports.filter((r) => r.versionId === v.id);
      const issues: Record<string, number> = {};
      for (const r of mine) for (const x of (r.issues as string[]) ?? []) if (SECURITY_ISSUES.has(x as never)) issues[x] = (issues[x] ?? 0) + 1;
      const owners = new Set(mine.filter((r) => ((r.issues as string[]) ?? []).some((x) => SECURITY_ISSUES.has(x as never))).map((r) => r.humanId)).size;
      const pkg = packageOf(v.canonical);
      const page = `${origin}/t/${encodeURIComponent(v.canonical)}`;
      const summary = `Field reports flag ${v.canonical}@${v.version} (not a confirmed vulnerability)`;
      out.push({
        schema_version: OSV_SCHEMA_VERSION,
        id: await osvId("report", v.id, new Date(first.at).getUTCFullYear()),
        modified: iso(last.at),
        published: iso(first.at),
        ...(withdrawn ? { withdrawn: iso(withdrawn) } : {}),
        summary: summary.length > 120 ? `${summary.slice(0, 117)}...` : summary,
        details: [
          `Verified owners' agents filed security reports on ${v.canonical} version ${v.version} (fingerprint ${v.fingerprint}): ${Object.entries(issues).map(([k, n]) => `${k} ×${n}`).join(", ") || "none on record now"}.`,
          "",
          "These are observations by agents in use, counted by the Forge's published rules. They are not a confirmed vulnerability.",
          ...(withdrawn ? ["", "Withdrawn: the version no longer meets the flag rule."] : []),
        ].join("\n"),
        ...(pkg ? { affected: [{ package: pkg, versions: [v.version], database_specific: { fingerprint: v.fingerprint } }] } : {}),
        references: [{ type: "REPORT", url: page }],
        database_specific: {
          kind: "field-report-flag",
          confirmed_vulnerability: false,
          forge_tool_id: v.canonical,
          forge_tool_kind: v.kind,
          version: v.version,
          fingerprint: v.fingerprint,
          security_status: current,
          verified_reporters: owners,
          security_issues: issues,
          rules_url: `${origin}/methodology`,
          licence: LICENCE_ID,
        },
      });
    }
  }
  return out;
}

/** Every record in the feed at `now`, newest change first. */
export async function osvRecords(env: Env, origin: string, now = Date.now()): Promise<Rec[]> {
  const all = [...(await skillRecords(env, origin, now)), ...(await reportRecords(env, origin))];
  return all.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : a.id.localeCompare(b.id)));
}

/** OSV.dev's listing convention: `<modified>,<id>` per line, newest first. */
export const modifiedCsv = (recs: Rec[]) => recs.map((r) => `${r.modified},${r.id}`).join("\n") + (recs.length ? "\n" : "");

export function feedIndex(origin: string, recs: Rec[]) {
  const base = `${origin}${OSV_FEED_PATH}`;
  return {
    name: "The Agent Forge OSV feed",
    format: "OSV",
    schema_version: OSV_SCHEMA_VERSION,
    schema_url: OSV_SCHEMA_URL,
    spec_url: OSV_SPEC_URL,
    id_prefix: OSV_ID_PREFIX,
    meaning: OSV_MEANING,
    kinds: ["skill-pattern-finding", "field-report-flag"],
    severity: "none: these are pattern findings and field observations, not scored vulnerabilities; see database_specific",
    licence: { id: LICENCE_ID, url: `${origin}/benchmark/licence`, product_use: "by agreement: partners@theagentforge.io" },
    decision: `${origin}/security#osv-feed`,
    records: recs.length,
    latest_modified: recs[0]?.modified ?? null,
    all_json: `${base}/all.json`,
    all_zip: `${base}/all.zip`,
    modified_id_csv: `${base}/modified_id.csv`,
    record_url: `${base}/{id}.json`,
  };
}
