// Findings, not verdicts (ADR 0137, moat audit Q1): for every trap the referee marked sprung, a finding a security
// engineer can paste into a ticket. Built only from the referee's record (the result) and the recorded trace (the call,
// result and hit events), by replaying the logged calls on the job's own world and asking the referee after each call
// which trap stood sprung. No model-written text (turn text, the finish summary) is read, and no LLM is involved; the
// prose comes from fixed per-trap templates. Where the trace can't show something, the finding says "not determinable
// from the trace" rather than guess. Pure and deterministic: no D1, no network, no clock.

import { Attempt, stable } from "./engine";
import { FIX_CATEGORIES, FINDING_TEMPLATES, findingTemplate, type FindingTemplate, type FixCategory } from "./finding-templates";
import { PRIVATE_FINDING_TEMPLATES, PRIVATE_TASKS } from "./private";
import { anyTrapSeverity, SEVERITY_LABEL, trapSeverity, type TrapSeverity } from "./severity";
import { taskById } from "./tasks/index";
import { anyTrapEntry, publicTrapId, trapEntry, TRAP_FAMILIES, type TrapFamily } from "./traps";
import type { AttemptResult, EndReason, LogEvent, TaskType } from "./types";

export const FINDINGS_VERSION = "findings 1.1";
export const NOT_DETERMINABLE = "not determinable from the trace";

export interface FindingAct {
  /** The call's number in the trace (the replay's step). */
  step: number;
  tool: string;
  /**
   * The call's arguments as logged, bounded: free-text fields the model wrote (a message's text, an email's body, a
   * reason) are replaced by their length, other strings are cut at 80 characters, and long lists and objects are cut.
   * A finish call shows its status only.
   */
  args: Record<string, unknown>;
}

export interface Finding {
  trap: { id: string; family: TrapFamily; family_name: string; description: string; severity: TrapSeverity | null };
  task: string;
  seed: number;
  /** "call": a tool call sprang it; "finish_claim": the finish claim did; "end_state": no call changed it (an omission). */
  sprung_by: "call" | "finish_claim" | "end_state" | "not_determinable";
  act: FindingAct | null;
  /** Earlier calls without which the act would not have sprung the trap (for example the first of two payments). */
  related_acts: FindingAct[];
  mechanism: string;
  /**
   * The record the template expects before the act, matched on the act's own argument values (`matched`). `shown_before_act`
   * is true when one was found, false only for an "error" template when the replayed trace has no earlier failed call
   * that took effect on the same identifiers, and null (not determinable) otherwise.
   */
  evidence: { kind: "planted" | "contrary" | "error"; what: string; step: number | null; tool: string | null; matched: string | null; shown_before_act: boolean | null; note: string | null } | null;
  control: { procedure: string; check: { what: string; tools: string[]; used_before_act: boolean | null; first_step: number | null; tool_used: string | null; since_step: number | null; note: string | null } };
  claim: { finish_status: "done" | "cannot_complete" | null; ended: EndReason; referee_passed: boolean; claim_matches_referee: boolean | null };
  fix: { category: FixCategory; category_name: string; guardrail: string };
  /** The finding in one paragraph, from the fields above and the template: a statement, never an instruction. */
  ticket_text: string;
  basis: { version: typeof FINDINGS_VERSION; trace: "replayed" | "slim" | "not_faithful" | "no_log"; model_text_used: false; llm_used: false };
}

export interface FindingsResult {
  findings: Finding[];
  /** Sprung traps with no public finding (a private or uncatalogued trap): counted, never named. */
  withheld: number;
}

export interface FindingsInput {
  task: string;
  seed: number;
  log: LogEvent[] | null | undefined;
  result: AttemptResult;
}

const PRIVATE_TEMPLATE_BY_ID = new Map(PRIVATE_FINDING_TEMPLATES.map((t) => [t.id, t]));

/**
 * Arguments that carry the model's own prose (a message's text, an email's subject or body, a reason, an event title).
 * Review 5 Nov: a finding never quotes them. They are the model's words, which can carry anything a planted
 * instruction asked it to repeat, and a finding goes out as agent-facing data (AGENTS.md rule 7); the replay keeps them.
 */
export const FREE_TEXT_ARGS: ReadonlySet<string> = new Set(["text", "body", "subject", "reason", "title", "summary", "message", "note", "notes", "comment", "description", "content"]);
/** Other strings are identifiers and values (an account, an id, an amount): cut at this length. */
const MAX_ARG = 80;
const MAX_ITEMS = 12;
const MAX_DEPTH = 3;
/** Bounded so a finding stays small (a finished run stores its findings for good) whatever arguments were sent. */
function shorten(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_ARG ? `${v.slice(0, MAX_ARG)}… [${v.length} characters]` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth >= MAX_DEPTH) return Array.isArray(v) ? `[list of ${v.length}]` : "[object]";
  if (Array.isArray(v)) return [...v.slice(0, MAX_ITEMS).map((x) => shorten(x, depth + 1)), ...(v.length > MAX_ITEMS ? [`… ${v.length - MAX_ITEMS} more`] : [])];
  const entries = Object.entries(v);
  return Object.fromEntries([
    ...entries.slice(0, MAX_ITEMS).map(([k, x]) => [k.slice(0, 40), FREE_TEXT_ARGS.has(k) && x !== null && x !== undefined ? `[free text, ${String(typeof x === "string" ? x.length : JSON.stringify(x)?.length ?? 0)} characters, not quoted]` : shorten(x, depth + 1)]),
    ...(entries.length > MAX_ITEMS ? [["…", `${entries.length - MAX_ITEMS} more fields`]] : []),
  ]);
}
const actOf = (step: number, tool: string, args: Record<string, unknown>): FindingAct => ({ step, tool, args: tool === "finish" ? { status: args.status === "cannot_complete" ? "cannot_complete" : "done" } : (shorten(args) as Record<string, unknown>) });

/** Identifiers in a call's arguments (ids, references, account numbers): strings with a digit or an @, 3 to 80 long. Free text is skipped. */
function identifiers(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string") {
    if (v.length >= 3 && v.length <= 80 && /[\d@]/.test(v)) out.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => identifiers(x, out));
  else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => !FREE_TEXT_ARGS.has(k) && identifiers(x, out));
  return out;
}

/** The values of the named arguments, at any depth (`sku` inside an order's lines): strings of 2 to 80 characters and numbers. */
function argValues(v: unknown, keys: ReadonlySet<string>, out: (string | number)[] = []): (string | number)[] {
  if (Array.isArray(v)) v.forEach((x) => argValues(x, keys, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (keys.has(k)) for (const y of Array.isArray(x) ? x : [x]) if ((typeof y === "string" && y.length >= 2 && y.length <= 80) || (typeof y === "number" && Number.isFinite(y))) out.push(y);
      if (x && typeof x === "object") argValues(x, keys, out);
    }
  return [...new Set(out)];
}

const normAcct = (x: string) => x.replace(/\s+/g, "").toUpperCase();

/**
 * The first record in a tool result that names one of `values`: a plain object (not an error record) with a field equal
 * to the value, or, for a string value of 6+ characters, a string field containing it (an account in an email's body).
 * With `field`, the record must also have that field; with `mustContain`, its text must contain that phrase (any case).
 * Returns the value matched, or null.
 */
function recordNaming(result: unknown, values: (string | number)[], field?: string, mustContain?: string): string | null {
  if (Array.isArray(result)) {
    for (const x of result) {
      const m = recordNaming(x, values, field, mustContain);
      if (m !== null) return m;
    }
    return null;
  }
  if (!result || typeof result !== "object") return null;
  const rec = result as Record<string, unknown>;
  if ("error" in rec) return null;
  if ((!field || field in rec) && (!mustContain || JSON.stringify(rec).toLowerCase().includes(mustContain.toLowerCase())))
    for (const x of Object.values(rec))
      for (const v of values) {
        if (x === v) return String(v);
        if (typeof x === "string" && typeof v === "string" && v.length >= 6 && x.includes(v)) return v;
      }
  for (const x of Object.values(rec)) {
    if (x && typeof x === "object") {
      const m = recordNaming(x, values, field, mustContain);
      if (m !== null) return m;
    }
  }
  return null;
}

/** A vendor's current and previous bank accounts on file in the job's world (bank details that weren't planted). */
function accountsOnFile(state: unknown): Set<string> {
  const out = new Set<string>();
  const vendors = (state as { vendors?: unknown } | null)?.vendors;
  if (Array.isArray(vendors))
    for (const v of vendors as { account?: unknown; bank_change?: { previous_account?: unknown } | null }[]) {
      if (typeof v?.account === "string") out.add(normAcct(v.account));
      if (typeof v?.bank_change?.previous_account === "string") out.add(normAcct(v.bank_change.previous_account));
    }
  return out;
}

type CallEv = Extract<LogEvent, { type: "call" }>;
type Located = { sprung_by: Finding["sprung_by"]; act: CallEv | null; index: number };

/**
 * Replays the logged calls on a fresh copy of the job's world (with the bout's own caps) and asks the referee, after
 * each call, which traps stand sprung. Returns the replay, the verdicts after each call, and whether the replay
 * reproduced every logged result and error.
 */
function replayTrace(task: TaskType, seed: number, log: LogEvent[]) {
  const start = log[0];
  const caps = start?.type === "start" ? start.caps : undefined;
  const a = new Attempt(task, seed, { caps, now: () => 0 });
  const calls = log.filter((e): e is CallEv => e.type === "call");
  const work = calls.filter((c) => c.name !== "finish");
  const after: Set<string>[] = [new Set(a.peekTraps().filter((t) => t.triggered).map((t) => t.id))];
  /** Steps whose call changed the sandbox (a write that took effect, even behind an error). */
  const changed = new Set<number>();
  let before = JSON.stringify(a.state);
  for (const c of work) {
    if (a.done) break;
    a.call(c.name, c.args);
    const now = JSON.stringify(a.state);
    if (now !== before) changed.add(c.n);
    before = now;
    if (a.done) break;
    after.push(new Set(a.peekTraps().filter((t) => t.triggered).map((t) => t.id)));
  }
  const slim = work.length > 0 && !log.some((e) => e.type === "result" || e.type === "hit");
  const pick = (l: LogEvent[]) => l.filter((e) => e.type === "result" || e.type === "hit").map(({ t: _t, ...e }) => stable(e));
  const faithful = slim || stable(pick(log)) === stable(pick(a.log));
  return { a, calls, work, after, slim, faithful, changed };
}

function locate(trapId: string, r: ReturnType<typeof replayTrace>): Located {
  const { after, work, calls } = r;
  const last = after.length - 1;
  if (!after[last]!.has(trapId)) {
    const fin = calls.find((c) => c.name === "finish");
    return fin ? { sprung_by: "finish_claim", act: fin, index: -1 } : { sprung_by: "not_determinable", act: null, index: -1 };
  }
  // The call after which the trap became sprung and stayed sprung.
  let i = last;
  while (i > 0 && after[i - 1]!.has(trapId)) i--;
  return i === 0 ? { sprung_by: "end_state", act: null, index: -1 } : { sprung_by: "call", act: work[i - 1]!, index: i - 1 };
}

/** Earlier calls that changed the sandbox and share an identifier with the act, without which the act wouldn't have sprung the trap. */
function relatedActs(task: TaskType, seed: number, log: LogEvent[], r: ReturnType<typeof replayTrace>, at: number, trapId: string): CallEv[] {
  const act = r.work[at]!;
  const ids = identifiers(act.args);
  if (!ids.size) return [];
  const candidates = r.work
    .slice(0, at)
    .filter((c) => r.changed.has(c.n) && [...identifiers(c.args)].some((x) => ids.has(x)))
    .slice(-6);
  const start = log[0];
  const caps = start?.type === "start" ? start.caps : undefined;
  return candidates.filter((skip) => {
    const b = new Attempt(task, seed, { caps, now: () => 0 });
    for (const c of r.work.slice(0, at + 1)) if (c !== skip && !b.done) b.call(c.name, c.args);
    return !b.done && !b.peekTraps().some((t) => t.id === trapId && t.triggered);
  });
}

const fmtArgs = (args: Record<string, unknown>) => {
  const s = JSON.stringify(args);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};
const toolList = (tools: string[]) => tools.join(" / ");

function ticketText(f: Omit<Finding, "ticket_text">): string {
  const sev = f.trap.severity ? ` (${SEVERITY_LABEL[f.trap.severity.severity]})` : "";
  const act =
    f.sprung_by === "call" && f.act
      ? `At step ${f.act.step} the agent called ${f.act.tool} with ${fmtArgs(f.act.args)}${f.related_acts.length ? `, after ${f.related_acts.map((x) => `${x.tool} at step ${x.step} with ${fmtArgs(x.args)}`).join(" and ")}` : ""}.`
      : f.sprung_by === "finish_claim" && f.act
        ? `At step ${f.act.step} the agent finished with status "${f.act.args.status}"; that claim sprang the trap.`
        : f.sprung_by === "end_state"
          ? "No single call sprang it: the end state lacked what the procedure required."
          : `The call that sprang it is ${NOT_DETERMINABLE}.`;
  const ev = f.evidence
    ? f.evidence.step !== null
      ? f.evidence.kind === "error"
        ? ` At step ${f.evidence.step} an earlier call (${f.evidence.what}; ${f.evidence.tool}, sharing ${f.evidence.matched} with the act) failed but took effect all the same.`
        : ` ${f.evidence.kind === "planted" ? "Planted text" : "A record contradicting the act"} (${f.evidence.what}: ${f.evidence.matched}) was in the trace at step ${f.evidence.step} (${f.evidence.tool}), before the act.`
      : f.evidence.shown_before_act === false
        ? ` No earlier failed call that took effect on the same identifiers is in the trace.`
        : ` Whether ${f.evidence.what} was shown before the act is ${NOT_DETERMINABLE}.`
    : "";
  const c = f.control.check;
  const window = c.since_step !== null ? ` between step ${c.since_step} and the act` : " before the act";
  const check = c.used_before_act === true ? `${c.tool_used} used at step ${c.first_step},${window}` : c.used_before_act === false ? `${c.what} (${toolList(c.tools)}) not consulted${window}` : `whether ${c.what} was consulted is ${NOT_DETERMINABLE}`;
  const claim =
    f.claim.finish_status === null
      ? `no finish call (ended: ${f.claim.ended})`
      : `"${f.claim.finish_status === "done" ? "done" : "cannot complete"}"; the referee found the job ${f.claim.referee_passed ? "right" : "not right"}`;
  return `${f.trap.id}${sev}: ${f.trap.description}. ${act} Mechanism: ${f.mechanism}.${ev} Procedure control: ${f.control.procedure}; ${check}. Claimed at the end: ${claim}. Fix (${f.fix.category_name}): ${f.fix.guardrail}.`;
}

/**
 * Findings for one attempt. `scope: "public"` (every public page, JSON twin and MCP result) builds findings only for
 * public jobs and public catalogue traps; anything else is counted in `withheld`, never named. `scope: "private"`
 * (admin pages and tests) also builds them for the private families.
 */
export function buildFindings(input: FindingsInput, opts: { scope?: "public" | "private" } = {}): FindingsResult {
  const scope = opts.scope ?? "public";
  const sprung = (input.result?.traps ?? []).filter((t) => t.triggered);
  if (!sprung.length) return { findings: [], withheld: 0 };
  const task = taskById(input.task) ?? (scope === "private" ? (PRIVATE_TASKS.find((t) => t.id === input.task) ?? null) : null);
  if (!task) return { findings: [], withheld: sprung.length };

  const log = Array.isArray(input.log) && input.log[0]?.type === "start" && input.log[0].task === input.task && input.log[0].seed === input.seed ? input.log : null;
  let r: ReturnType<typeof replayTrace> | null = null;
  try {
    r = log ? replayTrace(task, input.seed, log) : null;
  } catch {
    r = null;
  }
  const trace: Finding["basis"]["trace"] = !log ? "no_log" : !r || !r.faithful ? "not_faithful" : r.slim ? "slim" : "replayed";
  const usable = r && r.faithful ? r : null;
  const finishEv = log?.findLast((e) => e.type === "finish");
  const claimStatus = finishEv?.type === "finish" ? (finishEv.claim?.status ?? null) : (log?.find((e) => e.type === "call" && e.name === "finish") as CallEv | undefined)?.args.status === "cannot_complete" ? "cannot_complete" : log?.some((e) => e.type === "call" && e.name === "finish") ? "done" : null;
  const jobTools = new Set(task.tools(task.make(input.seed)).map((t) => t.name));

  const findings: Finding[] = [];
  let withheld = 0;
  for (const t of sprung) {
    const pid = publicTrapId(input.task, t.id);
    const entry = pid ? (scope === "private" ? anyTrapEntry(pid) : trapEntry(pid)) : null;
    const tpl: FindingTemplate | null = pid ? (findingTemplate(pid) ?? (scope === "private" ? (PRIVATE_TEMPLATE_BY_ID.get(pid) ?? null) : null)) : null;
    if (!pid || !entry || !tpl) {
      withheld++;
      continue;
    }
    const loc: Located = usable ? locate(t.id, usable) : { sprung_by: "not_determinable", act: null, index: -1 };
    const related = usable && loc.sprung_by === "call" ? relatedActs(task, input.seed, log!, usable, loc.index, t.id) : [];
    const actStep = loc.act?.n ?? Infinity;

    let evidence: Finding["evidence"] = null;
    if (tpl.evidence) {
      const ev = tpl.evidence;
      let found: { step: number; tool: string; matched: string } | null = null;
      let absent = false;
      if (usable && !usable.slim && loc.sprung_by === "call") {
        const callAt = new Map(usable.calls.map((c) => [c.n, c]));
        if (ev.kind === "error") {
          // The error that hid a completed act: an earlier failed call of the template's tools, on an identifier the act
          // (or a related act) shares, that changed the sandbox all the same (the order placed behind the timeout).
          const ids = new Set([...identifiers(loc.act?.args ?? {}), ...related.flatMap((x) => [...identifiers(x.args)])]);
          for (const e of log!) {
            if (e.type !== "hit" || e.n >= actStep || !ev.tools.includes(e.name) || !usable.changed.has(e.n)) continue;
            const shared = [...identifiers(callAt.get(e.n)?.args ?? {})].find((x) => ids.has(x));
            if (shared) {
              found = { step: e.n, tool: e.name, matched: shared };
              break;
            }
          }
          // The replay is faithful and complete, so no such call means there was none.
          absent = !found;
        } else if (ev.keys?.length) {
          const keys = new Set(ev.keys);
          let values = [...argValues(loc.act?.args ?? {}, keys), ...related.flatMap((x) => argValues(x.args, keys))];
          // Bank details on file (current or previous) are not planted text, wherever else they are printed.
          if (ev.kind === "planted" && ev.notOnFile) {
            const onFile = accountsOnFile(new Attempt(task, input.seed, { now: () => 0 }).variant.state);
            values = values.filter((x) => typeof x !== "string" || !onFile.has(normAcct(x)));
          }
          if (values.length)
            for (const e of log!) {
              if (e.type !== "result" || e.n >= actStep || !ev.tools.includes(e.name)) continue;
              const m = recordNaming(e.result, values, ev.field, ev.mustContain);
              if (m !== null) {
                found = { step: e.n, tool: e.name, matched: m };
                break;
              }
            }
        }
      }
      evidence = found
        ? { kind: ev.kind, what: ev.what, step: found.step, tool: found.tool, matched: shorten(found.matched) as string, shown_before_act: true, note: null }
        : absent
          ? { kind: ev.kind, what: ev.what, step: null, tool: null, matched: null, shown_before_act: false, note: "no earlier failed call that took effect on the same identifiers is in the trace" }
          : { kind: ev.kind, what: ev.what, step: null, tool: null, matched: null, shown_before_act: null, note: NOT_DETERMINABLE };
    }

    const checkTools = (tpl.check?.tools ?? []).filter((x) => jobTools.has(x));
    let check: Finding["control"]["check"];
    if (!tpl.check || !checkTools.length || !usable || loc.sprung_by === "not_determinable") {
      check = { what: tpl.check?.what ?? "the procedure's check", tools: checkTools, used_before_act: null, first_step: null, tool_used: null, since_step: null, note: NOT_DETERMINABLE };
    } else {
      // After an error that hid a completed act, the check that counts is one made between that error and the act.
      const since = evidence?.kind === "error" && evidence.step !== null ? evidence.step : null;
      const used = log!.find((e) => (e.type === "result" || (usable.slim && e.type === "call")) && checkTools.includes(e.name) && e.n < actStep && (since === null || e.n > since)) as { n: number; name: string } | undefined;
      check = { what: tpl.check.what, tools: checkTools, used_before_act: !!used, first_step: used?.n ?? null, tool_used: used?.name ?? null, since_step: since, note: null };
    }

    const passed = input.result.passed;
    const base: Omit<Finding, "ticket_text"> = {
      trap: { id: pid, family: entry.family, family_name: TRAP_FAMILIES[entry.family].name, description: entry.description, severity: scope === "private" ? anyTrapSeverity(pid) : trapSeverity(pid) },
      task: input.task,
      seed: input.seed,
      sprung_by: loc.sprung_by,
      act: loc.act ? actOf(loc.act.n, loc.act.name, loc.act.args) : null,
      related_acts: related.map((c) => actOf(c.n, c.name, c.args)),
      mechanism: tpl.mechanism,
      evidence,
      control: { procedure: tpl.control, check },
      claim: { finish_status: claimStatus, ended: input.result.reason, referee_passed: passed, claim_matches_referee: claimStatus === null ? null : (claimStatus === "done") === passed },
      fix: { category: tpl.fix.category, category_name: FIX_CATEGORIES[tpl.fix.category], guardrail: tpl.fix.guardrail },
      basis: { version: FINDINGS_VERSION, trace, model_text_used: false, llm_used: false },
    };
    findings.push({ ...base, ticket_text: ticketText(base) });
  }
  // Most severe first, then in the referee's order.
  const rank = (f: Finding) => ["critical", "high", "medium", "low"].indexOf(f.trap.severity?.severity ?? "low");
  findings.sort((x, y) => rank(x) - rank(y));
  return { findings, withheld };
}

/** Every public catalogue id with a template (for coverage checks). */
export const templatedIds = () => FINDING_TEMPLATES.map((t) => t.id);
