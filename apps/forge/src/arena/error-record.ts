import { anyTaskById, RULES_HISTORY, rulesAtLeast, TASK_VERSIONS, TRAP_CATALOG, publicTrapId } from "@forge/arena";
import type { AuditResult } from "@forge/arena/audit";
import { and, count, eq, inArray } from "drizzle-orm";
import * as t from "../db/schema";
import AUDIT_1 from "../seed/validity/referee-audit-1.json";
import ADJUDICATIONS_1 from "../seed/validity/referee-audit-1-adjudications.json";
import AUDIT_2 from "../seed/validity/referee-audit-2.json";
import type { Db } from "../services/db";
import { TRAP_SET } from "./benchmark";
import { CORRECTIONS, type Correction } from "./corrections";
import { finishedRuns, modelName, notEmbargoed } from "./views";

// The error record (Q2, ADR 0136): a dated log of every correction to the Arena's published results and traps, kept
// beside the independent referee audit so it reads as a measured error rate, not a self-assessment. Every entry and
// every number is built by code from its source: the rules history, the task versions, the stored re-score notes on
// published runs, the unpublished-correction list, the disputes table and the frozen referee audit. The record is
// never published without the audit: `validityGate` refuses it (and the page shows neither) unless the audit result is
// present, complete and every disagreement in it is resolved.

export const REFEREE_AUDIT: AuditResult = AUDIT_1 as unknown as AuditResult;
/**
 * Referee audit 2 (ADR 0136 Amendment 1): the census, every public ranked replay on 6 Nov 2026, same checker and method.
 * Published on the validity page from 7 Nov (Dinike). Its frame holds public runs only (public seeds, no held event, no
 * embargoed model, no private job). Its 4 disagreements are audit 1's 4, so their status today is read from audit 1's
 * adjudications.
 */
export const REFEREE_AUDIT_2: AuditResult = AUDIT_2 as unknown as AuditResult;

type Outcome = NonNullable<AuditResult["disagreements"][number]["resolution"]>["outcome"];
/**
 * Audit 1's adjudications as they stand today. The frozen audit file carries each disagreement's resolution as it was
 * on the audit's date and never changes; this file is updated when a disagreement's status moves (for example a
 * re-score applied, docs/runbooks/rescore.md step 6), so the current status is read from here.
 */
export const REFEREE_AUDIT_ADJUDICATIONS = ADJUDICATIONS_1 as { run: string; trap: string; outcome: Outcome; note: string }[];

/** "2026-11-05" → "5 Nov 2026". */
export function dayText(iso: string) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

/** The next minor Trap Set version after the newest one (where a pending correction's re-score would land). */
export function nextTrapSetMinor(version: string = TRAP_SET.version) {
  const [major, minor] = version.split(".").map(Number) as [number, number];
  return Number.isFinite(major) && Number.isFinite(minor) ? `${major}.${minor + 1}` : null;
}

export type DisagreementNow = "fixed_and_rescored" | "fixed_in_later_rules" | "open" | "recorded";

/** One audit disagreement: its outcome at the audit (frozen) and its status today (adjudications and corrections). */
export interface DisagreementStatus {
  run: string;
  trap: string;
  outcome_at_audit: Outcome | null;
  note_at_audit: string | null;
  outcome_now: Outcome | null;
  note_now: string | null;
  /** The rules version whose referee reads the run correctly. */
  fixed_by: string | null;
  /** The published, applied correction that re-scored the run's published verdict, if any. */
  rescored: { correction: string; rules: string; date: string } | null;
  status_now: DisagreementNow;
}

/** The rules in force on a day: the newest RULES_HISTORY entry dated on or before it. */
const rulesOn = (iso: string) => [...RULES_HISTORY].filter((r) => r.date <= iso.slice(0, 10)).at(-1)?.version ?? null;

/**
 * Each disagreement's current status. Which rules fixed it: the "Fixed by rules x.y" the adjudication names, else (when
 * the referee in force at the audit already gave the checker's verdict) the rules in force on the audit's date.
 * Re-scored: by the earliest published, applied correction dated on or after the audit whose rules include that fix
 * (a re-score replays the whole referee of its rules, so a rules 0.7 re-score carries the rules 0.6 fixes).
 */
export function disagreementStatuses(audit: AuditResult = REFEREE_AUDIT, adjudications = REFEREE_AUDIT_ADJUDICATIONS, corrections: readonly Correction[] = CORRECTIONS): DisagreementStatus[] {
  const applied = corrections.filter((c) => c.published && c.applied && c.counts && c.date >= audit.date).sort((a, b) => a.date.localeCompare(b.date));
  return audit.disagreements.map((d) => {
    const adj = adjudications.find((a) => a.run === d.run && a.trap === d.trap) ?? null;
    const now = adj?.outcome ?? d.resolution?.outcome ?? null;
    const named = adj ? /Fixed by (rules \d+\.\d+)/.exec(adj.note)?.[1] ?? null : null;
    const fixedBy = now === "referee_wrong_fixed_later" ? named ?? (d.current_referee === d.checker ? rulesOn(audit.date) : null) : null;
    const c = fixedBy ? applied.find((x) => rulesAtLeast(x.rules, fixedBy)) : undefined;
    const rescored = c ? { correction: c.id, rules: c.rules, date: c.date } : null;
    const status: DisagreementNow = now === "referee_wrong_fixed_later" ? (rescored ? "fixed_and_rescored" : "fixed_in_later_rules") : now === "referee_wrong_open" ? "open" : "recorded";
    return { run: d.run, trap: d.trap, outcome_at_audit: d.resolution?.outcome ?? null, note_at_audit: d.resolution?.note ?? null, outcome_now: now, note_now: adj?.note ?? d.resolution?.note ?? null, fixed_by: fixedBy, rescored, status_now: status };
  });
}

/** The status today in one plain clause, for the page and the error record. */
export function disagreementNowText(s: DisagreementStatus) {
  if (s.status_now === "fixed_and_rescored") return `Fixed by ${s.fixed_by}; the published verdict was re-scored from the signed log on ${dayText(s.rescored!.date)} (correction ${s.rescored!.correction}).`;
  if (s.status_now === "fixed_in_later_rules") return `Fixed by ${s.fixed_by ?? "later referee rules"}; the published verdict is not yet re-scored.`;
  if (s.status_now === "open") return "Open: the published verdict is wrong and not yet fixed.";
  return "Recorded.";
}

export type EntryKind = "rules_change" | "rescore_applied" | "rescore_pending" | "task_version" | "audit_disagreement" | "reproduce_difference" | "disputes";

export interface ErrorEntry {
  date: string;
  kind: EntryKind;
  title: string;
  /** What happened, in plain words. */
  what: string;
  status: "applied" | "pending" | "open" | "fixed_in_later_rules" | "fixed_and_rescored" | "recorded";
  /** Public trap ids this entry touches (empty when it touches none in particular). */
  traps: string[];
  /** Replay links, when the entry is about specific runs. */
  runs: string[];
  source: string;
}

/** Which public traps a rules version changed, read from its own change text (certain mentions only). */
const RULES_TRAPS: Record<string, string[]> = {
  "rules 0.4": ["FA-PRM-001", "FA-PRM-002", "FA-PRM-003"],
  "rules 0.5": ["FA-CLM-001", "FA-CLM-003", "FA-DAT-001", "FA-DAT-002"],
  "rules 0.6": ["FA-CLM-001", "FA-CLM-003"],
  "rules 0.7": ["FA-CLM-001"],
};

/** The gate: the record may be shown only with a complete referee audit whose every disagreement is resolved. */
export function validityGate(audit: AuditResult | null | undefined): { ok: true } | { ok: false; why: string } {
  if (!audit || audit.format !== "forge-referee-audit/1") return { ok: false, why: "no_referee_audit" };
  if (!audit.overall?.n || !audit.sample?.runs) return { ok: false, why: "referee_audit_has_no_sample" };
  if (audit.overall.agreement === null || !audit.overall.ci_95) return { ok: false, why: "referee_audit_has_no_agreement_rate" };
  if (audit.disagreements.some((d) => !d.resolution)) return { ok: false, why: "referee_audit_has_unresolved_disagreements" };
  return { ok: true };
}

/** Live: published ranked runs carrying an applied re-score note, by the rules that re-scored them. */
async function appliedRescores(db: Db) {
  const runs = await finishedRuns(db, { kinds: ["card", "guest"], hard: true });
  const by = new Map<string, { runs: number; changed: number; passToFail: number; failToPass: number; ids: string[]; at: string | null }>();
  for (const r of runs) {
    const note = (r.result as { rescored?: { rules?: unknown; at?: unknown; before?: { passed?: unknown } } } | null)?.rescored;
    if (!note || typeof note.rules !== "string") continue;
    const g = by.get(note.rules) ?? { runs: 0, changed: 0, passToFail: 0, failToPass: 0, ids: [], at: null };
    g.runs++;
    const before = note.before?.passed;
    if (typeof before === "boolean" && before !== r.summary.passed) {
      g.changed++;
      if (before) g.passToFail++;
      else g.failToPass++;
      g.ids.push(r.summary.id);
    }
    if (typeof note.at === "string" && (!g.at || note.at < g.at)) g.at = note.at;
    by.set(note.rules, g);
  }
  return by;
}

async function disputeCounts(db: Db) {
  const rows = await db.select({ state: t.disputes.state, n: count() }).from(t.disputes).groupBy(t.disputes.state);
  const get = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
  const trapLinked = 0; // The disputes table links a dispute to a tool or a field report; none can point at a trap.
  return { open: get("open"), upheld: get("resolved"), rejected: get("rejected"), about_traps_or_arena_verdicts: trapLinked };
}

/**
 * The full re-score behind a published, applied correction, in one plain sentence from its counts (the same counts
 * /results-policy shows). Every published run of the affected jobs was replayed, practice runs included.
 */
export function fullRescoreText(c: Correction, publicUnfaithful: readonly { id: string; model: string; task: string }[] = []) {
  const n = c.counts;
  if (!n) return "";
  const s = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  // Diligence review, 7 Nov: name every one that is a public run (model, job, short id), so the count can be checked.
  const named = publicUnfaithful.map((u) => `${modelName(u.model)} on ${anyTaskById(u.task)?.title ?? u.task} (${u.id.slice(0, 8)})`);
  const unnamed = n.unfaithful - named.length;
  const list = named.length ? `: ${named.join("; ")}${unnamed > 0 ? `; ${unnamed} more ${unnamed === 1 ? "is not a public run" : "are not public runs"}` : ""}. Each keeps the verdict it was played with` : "";
  const unfaithful = n.unfaithful ? ` ${n.unfaithful} more couldn't be replayed exactly (the job changed since they ran) and weren't re-scored${list}.` : "";
  const excluded = n.excluded ? ` ${n.excluded} Hard v3 runs played before rules 0.3 used another harness and weren't re-scored.` : "";
  return `The full re-score (correction ${c.id}, ${dayText(c.date)}) replayed every published run of the affected jobs, practice runs included: ${n.changed} of ${n.checked} changed verdict (${n.passToFail} pass to fail, ${n.failToPass} fail to pass), across ${s(n.events, "event")} and ${s(n.models, "model")}.${unfaithful}${excluded}`;
}

const runUrl = (origin: string, id: string) => `${origin}/arena/run/${id}`;

/** Of a correction's unfaithful runs, those any public surface may show (the same filter as /arena/run/:id). */
export async function publicUnfaithfulRuns(db: Db, c: Correction, now = Date.now()) {
  const list = c.unfaithfulRuns ?? [];
  if (!list.length) return [];
  const rows = await db
    .select({ id: t.arenaRuns.id })
    .from(t.arenaRuns)
    .innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId))
    .where(and(inArray(t.arenaRuns.id, list.map((u) => u.id)), notEmbargoed(now)));
  const ok = new Set(rows.map((r) => r.id));
  return list.filter((u) => ok.has(u.id));
}
const day = (iso: string) => iso.slice(0, 10);

/** Every entry, newest first. Pass `db` for the live parts (applied re-scores, disputes). */
export async function errorRecord(db: Db, origin: string, audit: AuditResult = REFEREE_AUDIT, corrections: readonly Correction[] = CORRECTIONS): Promise<{ entries: ErrorEntry[]; disputes: Awaited<ReturnType<typeof disputeCounts>> }> {
  const entries: ErrorEntry[] = [];
  for (const r of RULES_HISTORY.filter((x) => Object.hasOwn(RULES_TRAPS, x.version))) {
    entries.push({ date: r.date, kind: "rules_change", title: `Referee rules changed: ${r.version}`, what: r.change, status: "applied", traps: RULES_TRAPS[r.version] ?? [], runs: [], source: `${origin}/benchmark/changelog` });
  }
  const applied = await appliedRescores(db);
  // The published, applied corrections: each carries the counts of the full re-score (every published run of the
  // affected jobs, practice runs included), which the ranked-run notes alone don't show.
  const fullRescores = corrections.filter((c) => c.published && c.applied && c.counts);
  const unfaithfulOf = new Map(await Promise.all(fullRescores.map(async (c) => [c.id, await publicUnfaithfulRuns(db, c).catch(() => [])] as const)));
  for (const [rules, g] of applied) {
    const full = fullRescores.find((c) => c.rules === rules);
    const uf = full ? (unfaithfulOf.get(full.id) ?? []) : [];
    entries.push({
      date: g.at ? day(g.at) : "unknown",
      kind: "rescore_applied",
      title: `Published runs re-scored under ${rules}`,
      what: `${g.runs} published ranked run${g.runs === 1 ? "" : "s"} carry a ${rules} re-score note; ${g.changed} changed verdict (${g.passToFail} pass to fail, ${g.failToPass} fail to pass). The signed logs are unchanged; each re-scored result keeps the verdict it had before in its note.${full ? ` ${fullRescoreText(full, uf)}` : ""}`,
      status: "applied",
      traps: RULES_TRAPS[rules] ?? [],
      runs: [...g.ids, ...uf.map((u) => u.id)].map((id) => runUrl(origin, id)),
      source: full ? `stored re-score notes on published runs (arena_runs.result.rescored); ${origin}/results-policy#${full.id}` : "stored re-score notes on published runs (arena_runs.result.rescored)",
    });
  }
  // A published correction with no ranked-run note still gets its own entry, so the record misses no re-score.
  for (const c of fullRescores.filter((x) => !applied.has(x.rules))) {
    const uf = unfaithfulOf.get(c.id) ?? [];
    entries.push({ date: c.date, kind: "rescore_applied", title: `Published runs re-scored under ${c.rules}`, what: fullRescoreText(c, uf), status: "applied", traps: RULES_TRAPS[c.rules] ?? [], runs: uf.map((u) => runUrl(origin, u.id)), source: `${origin}/results-policy#${c.id}` });
  }
  const next = nextTrapSetMinor();
  for (const c of corrections.filter((x) => !x.published)) {
    const r = RULES_HISTORY.find((x) => x.version === c.rules);
    entries.push({
      date: r?.date ?? c.date,
      kind: "rescore_pending",
      title: `Re-score under ${c.rules} not yet applied`,
      what: `A re-score of published runs under ${c.rules} is prepared; it has not been applied, so the published verdicts it would change still show the old one. It is to be applied with the next Trap Set version${next ? ` (${next})` : ""}, with its counts published then. The fix: ${c.what.split(". ").slice(0, 2).join(". ")}.`,
      status: "pending",
      traps: RULES_TRAPS[c.rules] ?? [],
      runs: [],
      source: `${origin}/benchmark/changelog`,
    });
  }
  for (const v of TASK_VERSIONS.filter((x) => x.version !== "Normal 1.0")) {
    const added = TRAP_CATALOG.filter((e) => e.since === v.version).map((e) => e.id);
    entries.push({ date: v.date, kind: "task_version", title: `Jobs changed: ${v.version}`, what: `${v.change}${added.length ? ` Traps added: ${added.join(", ")}.` : ""} Earlier versions stay as they were played; their results are not moved.`, status: "applied", traps: added, runs: [], source: `${origin}/benchmark/changelog` });
  }
  const statuses = disagreementStatuses(audit);
  for (const d of audit.disagreements) {
    const st = statuses.find((x) => x.run === d.run && x.trap === d.trap)!;
    const before = st.outcome_at_audit && st.outcome_at_audit !== st.outcome_now ? ` At the audit (${dayText(audit.date)}) it was ${st.outcome_at_audit.replace(/_/g, " ")}.` : "";
    entries.push({
      date: audit.date,
      kind: "audit_disagreement",
      title: `Referee audit 1: ${d.public_trap_id ?? `${d.task}/${d.trap}`} marked ${d.published ? "sprung" : "not sprung"}, independent check says ${d.checker ? "sprung" : "not sprung"}`,
      what: st.note_now ? `${st.note_now} ${disagreementNowText(st)}${before}` : "Not yet resolved.",
      status: st.status_now,
      traps: d.public_trap_id ? [d.public_trap_id] : [],
      runs: [d.replay_url],
      source: `${origin}/benchmark/validity/referee-audit-1.json`,
    });
  }
  for (const w of audit.reproduce_check.worlds_not_identical) {
    entries.push({
      date: audit.date,
      kind: "reproduce_difference",
      title: `Reproduce check: the ${w.task} world rebuilt today differs from the replay`,
      what: `Rebuilt from its task version and seed, the job's world differs from the recorded one at world event ${w.at}: the job's code changed after this run was played, so its replay can't be re-checked exactly. Its published verdict stays as played.`,
      status: "recorded",
      traps: [],
      runs: [runUrl(origin, w.run)],
      source: `${origin}/benchmark/validity/referee-audit-1.json`,
    });
  }
  for (const v of audit.reproduce_check.referee_rerun_differs) {
    if (audit.disagreements.some((d) => d.run === v.run)) continue;
    // A run whose world changed is recorded above; its referee difference follows from that.
    if (audit.reproduce_check.worlds_not_identical.some((w) => w.run === v.run)) continue;
    entries.push({
      date: audit.date,
      kind: "reproduce_difference",
      title: `Reproduce check: today's referee scores a ${v.task} run differently in part`,
      what: `Re-run on the recorded trace, the referee in force now differs from the published result: ${v.differences.filter((x) => !x.startsWith("replayed event")).join("; ")}. Pass/fail ${v.differences.some((x) => x.startsWith("pass/fail")) ? "differs" : "is the same"}. Open: not yet explained.`,
      status: "open",
      traps: v.differences.flatMap((x) => {
        const m = /^trap (\S+):/.exec(x);
        return m ? [publicTrapId(v.task, m[1]!) ?? `${v.task}/${m[1]}`] : [];
      }),
      runs: [runUrl(origin, v.run)],
      source: `${origin}/benchmark/validity/referee-audit-1.json`,
    });
  }
  const disputes = await disputeCounts(db);
  entries.push({
    date: audit.date,
    kind: "disputes",
    title: "Disputes",
    what: `Disputes received through the site: ${disputes.upheld} upheld, ${disputes.rejected} rejected, ${disputes.open} open. Disputes can name a tool or a field report; ${disputes.about_traps_or_arena_verdicts} concern an Arena trap or verdict.`,
    status: "recorded",
    traps: [],
    runs: [],
    source: "disputes table",
  });
  entries.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
  return { entries, disputes };
}

/** One trap's history: the entries that name it, and its line in the referee audit. */
export function trapHistory(entries: readonly ErrorEntry[], publicId: string, audit: AuditResult = REFEREE_AUDIT) {
  const row = audit.per_public_trap.find((r) => r.public_trap_id === publicId) ?? null;
  return {
    entries: entries.filter((e) => e.traps.includes(publicId)),
    disputes_about_this_trap: 0,
    audit: row ? { audit_id: audit.audit_id, date: audit.date, verdicts_checked: row.n, agree: row.agree, agreement: row.agreement, ci_95: row.ci_95, referee_sprung: row.both + row.only_referee } : null,
  };
}

/** Disputes scoped to Arena verdicts are not a table of their own yet: the record says so rather than implying any. */
export const DISPUTE_SCOPE_NOTE = "Disputes are filed against tools and field reports. None can be filed against a trap yet, so a trap's dispute count is zero by construction, not by review.";

