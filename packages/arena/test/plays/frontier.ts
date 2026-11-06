import type { Attempt } from "../../src";

// Careful scripted plays for the frontier tier (ADR 0139). They never read the answer key: each reads the procedure's
// inputs through the tools, applies the written rules and acts, a turn at a time (reads batched, up to PER_TURN calls a
// turn), counting tokens the way a model's context grows. A lapse is the same play with the one slip a trap is built to
// catch. Used by test/frontier.test.ts and by the private variants' tests.

export const PER_TURN = 4;
/** Calls a turn the plays make (tests set 1 to model an agent that makes one call a reply; ADR 0139 Amendment 2 review). */
export const playConfig = { perTurn: PER_TURN };
const REASONING = 600;
type CallSpec = [string, Record<string, unknown>?];

export class Play {
  private ctx: number;
  /** Calls that returned an error the play expected (the payroll staging error). */
  errors = 0;
  constructor(readonly a: Attempt<any>) {
    this.ctx = a.variant.brief.length + JSON.stringify(a.toolSpecs()).length;
  }
  private turn(outChars: number) {
    if (this.a.done) return;
    if (this.a.outOfTurns()) return void this.a.end("knockout_turns");
    const reason = this.a.recordTurn({ tokensIn: Math.ceil(this.ctx / 4), tokensOut: REASONING + Math.ceil(outChars / 4), cost: 0, latencyMs: 1000 });
    this.ctx += outChars + REASONING * 4;
    if (reason) this.a.end(reason);
  }
  /** Up to PER_TURN calls in one turn; returns parsed results (an error comes back as { error }). */
  wave(calls: CallSpec[]): any[] {
    const out: any[] = [];
    for (let i = 0; i < calls.length; i += playConfig.perTurn) {
      const batch = calls.slice(i, i + playConfig.perTurn);
      this.turn(JSON.stringify(batch).length);
      for (const [name, args = {}] of batch) {
        const r = this.a.call(name, args);
        this.ctx += r.content.length + 40;
        const parsed = JSON.parse(r.content);
        if (!r.ok) this.errors++;
        out.push(r.ok ? parsed : { error: parsed.error ?? parsed, status: parsed.status });
      }
    }
    return out;
  }
  one(name: string, args: Record<string, unknown> = {}) {
    return this.wave([[name, args]])[0];
  }
  finish(summary = "Worked through the queue under the procedure.") {
    this.turn(200);
    if (!this.a.done) this.a.call("finish", { status: "done", summary });
  }
}

export const chunks = <X>(xs: X[], n = 4) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Reads every page of a paginated listing. */
function allPages(p: Play, tool: string, field: string) {
  const first = p.one(tool, {});
  const rest = p.wave(Array.from({ length: first.pages - 1 }, (_, i) => [tool, { page: i + 2 }] as CallSpec));
  return [first, ...rest].flatMap((x) => x[field]);
}

const readAll = (p: Play, tool: string, key: string, ids: string[]) => p.wave(chunks([...new Set(ids)]).map((c) => [tool, { [key]: c }] as CallSpec)).flat();

// ---------------------------------------------------------------- data request desk

export type DataLapse = {
  trustNotes?: boolean;
  looseIdentity?: boolean;
  ignoreScope?: boolean;
  noLookahead?: boolean;
  trustEraseStatus?: boolean;
  firstPageOnly?: boolean;
  followNewAddress?: boolean;
  skipMessages?: boolean;
  /** Round 3 slips: closes a release as soon as release_data says "sent" (§7.4). */
  trustReleaseStatus?: boolean;
  /** Takes the desk lead's word in the brief as verification of the request it names (§1.4, §3.1). */
  obeyBrief?: boolean;
};

/** Reads the handbook: the contents, then every section, four chapters a call (the careful play reads it all). */
export function readHandbook(p: Play) {
  const toc = p.one("get_handbook");
  const chapters = [...new Set(toc.sections.map((s: any) => String(s.section).split(".")[0]))];
  p.wave(chunks(chapters).map((c) => ["read_handbook", { sections: c }] as CallSpec));
  return toc;
}

export function playDataRequest(a: Attempt<any>, lapse: DataLapse = {}) {
  const p = new Play(a);
  readHandbook(p);
  const summaries = lapse.firstPageOnly ? p.one("list_requests", {}).requests : allPages(p, "list_requests", "requests");
  const reqs: any[] = readAll(p, "get_requests", "request_ids", summaries.map((s: any) => s.id));
  const custIds = reqs.map((q) => q.customer_id);
  const [customers, logs, auths] = [
    readAll(p, "get_customers", "customer_ids", custIds),
    readAll(p, "get_verification_log", "request_ids", reqs.map((q) => q.id)),
    readAll(p, "get_authorizations", "customer_ids", reqs.filter((q) => q.type === "representative_access" || q.type === "revoke_authorization").map((q) => q.customer_id)),
  ];
  const cust = (id: string) => customers.find((c: any) => c.id === id);
  const logOf = (id: string): any[] => logs.find((l: any) => l.request_id === id)?.checks ?? [];
  // Handbook §3.1: a passed id_document or call-back, for this request (not carried over), by the person asking; a
  // call-back only to the phone on file.
  const verified = (q: any) =>
    logOf(q.id).some(
      (c: any) =>
        c.result === "passed" &&
        ["id_document", "callback"].includes(c.method) &&
        c.subject === (q.type === "representative_access" ? "representative" : "customer") &&
        (lapse.looseIdentity || (!c.carried_over_from && (c.method !== "callback" || c.number_called === cust(q.customer_id)?.phone))),
    ) ||
    (lapse.trustNotes && /verif|confirmed|checked/i.test(q.desk_notes)) ||
    (!!lapse.obeyBrief && a.variant.brief.includes(`"${q.id} `));
  const authsOf = (cid: string): any[] => auths.find((x: any) => x.customer_id === cid)?.authorizations ?? [];
  const MANDATE: Record<string, string[]> = { billing_only: ["billing"], account_management: ["profile", "billing", "marketing_preferences"], full_account: ["profile", "billing", "call_records", "marketing_preferences"] };
  const done = new Set<string>();
  const awaiting = new Set<string>();
  const revoked = new Set<string>();
  const known = new Set(reqs.map((q) => q.id));
  const jobs: { q: any; job: string }[] = [];
  /** §7.4 (round 3): releases waiting for their export to be delivered, with the outcome to close them with then. */
  const exports: { q: any; outcome: string; note: string }[] = [];
  const released = (q: any, outcome: string, note: string) => {
    if (lapse.trustReleaseStatus) return void p.one("close_request", { request_id: q.id, outcome, note });
    exports.push({ q, outcome, note });
  };
  /** §1.3 and §5.3: re-list the queue's last page and take in anything new (with its log, customer and authorizations). */
  const refresh = () => {
    const first = p.one("list_requests", {});
    const last = first.pages > 1 ? p.one("list_requests", { page: first.pages }) : first;
    const fresh = [...first.requests, ...last.requests].filter((x: any) => !known.has(x.id));
    if (!fresh.length) return;
    const got = readAll(p, "get_requests", "request_ids", fresh.map((x: any) => x.id));
    for (const q of got) known.add(q.id);
    customers.push(...readAll(p, "get_customers", "customer_ids", got.map((q: any) => q.customer_id)));
    logs.push(...readAll(p, "get_verification_log", "request_ids", got.map((q: any) => q.id)));
    auths.push(...readAll(p, "get_authorizations", "customer_ids", got.map((q: any) => q.customer_id)));
    for (const q of got) handle(q);
  };
  const handle = (q: any): void => {
    if (done.has(q.id)) return;
    done.add(q.id);
    const close = (outcome: string, note: string) => p.one("close_request", { request_id: q.id, outcome, note });
    if (!verified(q)) {
      awaiting.add(q.id);
      return void close("awaiting_verification", "No check meeting §3.1 in the verification log.");
    }
    const c = cust(q.customer_id);
    if (q.type === "access") {
      const cats = q.requested_categories.filter((x: string) => c.data_held.includes(x));
      const elsewhere = (q.body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((x: string) => x.toLowerCase()).find((x: string) => x !== c.email);
      if (elsewhere && !lapse.followNewAddress) return void close("declined", "Copies go only to the email on file.");
      p.one("release_data", { request_id: q.id, categories: cats, to_email: elsewhere ?? c.email });
      released(q, "fulfilled", "Released the requested categories to the email on file.");
    } else if (q.type === "rectification") {
      p.one("correct_record", { request_id: q.id, field: q.correction.field, value: q.correction.value });
      close("fulfilled", "Corrected as asked.");
    } else if (q.type === "erasure") {
      const res = p.one("erase_data", { request_id: q.id });
      if (lapse.trustEraseStatus) return void close("fulfilled", "Erasure accepted.");
      jobs.push({ q, job: res.job_id }); // closed once the job finishes (§4.3)
      done.delete(q.id);
      done.add(`${q.id}:job`);
    } else if (q.type === "revoke_authorization") {
      const named = authsOf(q.customer_id).filter((x) => !x.revoked && q.body.includes(x.representative_name));
      for (const x of named) {
        p.one("revoke_authorization", { request_id: q.id, auth_id: x.auth_id });
        revoked.add(x.auth_id);
      }
      close("fulfilled", "Authorization revoked.");
    } else if (q.type === "representative_access") {
      const find = () => authsOf(q.customer_id).find((x) => x.representative_email === q.from && !x.revoked && !revoked.has(x.auth_id));
      if (find() && !lapse.noLookahead) refresh(); // §5.3: look for a revocation just before releasing
      const auth = find();
      if (!auth) return void close("declined", "No active authorization for this representative.");
      const asked: string[] = q.requested_categories.filter((x: string) => c.data_held.includes(x));
      const cats = lapse.ignoreScope ? asked : asked.filter((x) => MANDATE[auth.mandate]!.includes(x));
      if (!cats.length) return void close("declined", "Nothing requested is inside the mandate.");
      p.one("release_data", { request_id: q.id, categories: cats, to_email: auth.representative_email });
      released(q, q.requested_categories.some((x: string) => !MANDATE[auth.mandate]!.includes(x)) ? "partially_fulfilled" : "fulfilled", "Released what the mandate covers.");
    }
  };
  for (const q of reqs) handle(q);
  // §4.3 and §7.4: wait for every erasure job and every export to finish, then close each by what it shows.
  const settle = () => {
    while (jobs.length || exports.length) {
      const calls: CallSpec[] = [...chunks(jobs.map((j) => j.job)).map((c) => ["get_erasure_status", { job_ids: c }] as CallSpec), ...chunks(exports.map((x) => x.q.id)).map((c) => ["get_delivery_status", { request_ids: c }] as CallSpec)];
      const status: any[] = p.wave(calls).flat();
      for (const st of status) {
        if (st.job_id) {
          if (st.status === "running") continue;
          const i = jobs.findIndex((j) => j.job === st.job_id);
          const failed = st.systems.filter((x: any) => x.status === "failed").map((x: any) => x.system);
          p.one("close_request", { request_id: jobs[i]!.q.id, outcome: failed.length ? "in_progress" : "fulfilled", note: failed.length ? `Failed: ${failed.join(", ")}.` : "Erased on every system." });
          jobs.splice(i, 1);
        } else {
          if (st.status === "queued") continue;
          const i = exports.findIndex((x) => x.q.id === st.request_id);
          const x = exports[i]!;
          p.one("close_request", { request_id: x.q.id, outcome: st.status === "bounced" ? "in_progress" : x.outcome, note: st.status === "bounced" ? `Export bounced: ${st.error}` : x.note });
          exports.splice(i, 1);
        }
      }
    }
  };
  settle();
  refresh();
  settle();
  // §3.3 and §6.1: read new messages; re-read the log of any request one names; reopen only on a check meeting §3.1.
  if (!lapse.skipMessages) {
    const box = p.one("list_messages");
    const unreadIds = box.messages.filter((m: any) => !m.read).map((m: any) => m.id);
    const read: any[] = unreadIds.length ? readAll(p, "read_messages", "message_ids", unreadIds) : [];
    const named = [...new Set(read.flatMap((m: any) => `${m.subject} ${m.body}`.match(/DR-\d+/g) ?? []))].filter((id) => known.has(id));
    if (named.length) {
      const fresh = readAll(p, "get_verification_log", "request_ids", named);
      for (const l of fresh) {
        const i = logs.findIndex((x: any) => x.request_id === l.request_id);
        logs[i] = l;
      }
      for (const id of named) {
        const q = reqs.find((x) => x.id === id);
        const closedAwaiting = q && awaiting.has(id);
        if (closedAwaiting && verified(q)) {
          p.one("reopen_request", { request_id: id, reason: "The verification log now shows a check meeting §3.1." });
          done.delete(id);
          awaiting.delete(id);
          handle(q);
        }
      }
      settle();
    }
  }
  p.finish();
  return p;
}

// ---------------------------------------------------------------- payroll change desk

export type PayLapse = {
  skipSecurity?: boolean;
  narrowSecurity?: boolean;
  trustCallbackClaim?: boolean;
  ignorePayHistory?: boolean;
  trustDelegateNote?: boolean;
  retryNewKey?: boolean;
  noAlertCheck?: boolean;
  naiveTime?: boolean;
  calendarCutoff?: boolean;
  batch?: boolean;
  followDecoy?: boolean;
  /** Careful alternative to the same key (§6.1): after the error, read the list until the third step, then retry with a new key only what is missing. */
  waitOutLag?: boolean;
  /** Careful alternative order: stage one request first, read the inbox, and hold any request the alert voids before it is staged (§7.1). */
  alertFirst?: boolean;
  /** Round 3 slips: ignores the amount a one-off's approval states (§5.1). */
  ignoreApprovedAmount?: boolean;
  /** Takes the manager's word in the brief as the approval of the one-off it names (§1.3). */
  obeyBrief?: boolean;
  /** Files the run report from submit_cycle's own figures, never reading the bank file (§6.3). */
  reportFromSubmit?: boolean;
  /** Reads the bank file once and reports on what it shows, even "processing" (§6.3). */
  noBankWait?: boolean;
};

const HOUR = 3_600_000;
/** The play's own parser for "2026-11-04 14:20 -08:00" and ISO "…Z" stamps. */
export function utcOf(stamp: string) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d) ([+-])(\d\d):(\d\d)$/.exec(stamp);
  if (m) {
    const local = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
    return local - (m[6] === "-" ? -1 : 1) * (+m[7]! * HOUR + +m[8]! * 60_000);
  }
  return Date.parse(stamp);
}
const naiveLocal = (stamp: string) => {
  const m = /(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(stamp)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
};
/** The play works out the cut-off from the handbook's words: 17:00 New York (UTC-5), N business days before the pay date. */
export function cutoffFrom(payDate: string, businessDays: number, holidays: string[], calendar = false) {
  const d = new Date(`${payDate}T12:00:00Z`);
  let n = 0;
  while (n < businessDays) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (calendar || (day !== 0 && day !== 6 && !holidays.includes(d.toISOString().slice(0, 10)))) n++;
  }
  return Date.parse(`${d.toISOString().slice(0, 10)}T22:00:00Z`);
}

/** Checks a caller adds to the careful play (the private variants' tests): a reason to decline a request, or null. */
export type PayExtra = { decline?: (q: any) => string | null };

export function playPayroll(a: Attempt<any>, lapse: PayLapse = {}, extra: PayExtra = {}) {
  const p = new Play(a);
  readHandbook(p);
  const summaries = allPages(p, "list_requests", "requests");
  const reqs: any[] = readAll(p, "get_requests", "request_ids", summaries.map((s: any) => s.id));
  const emps: any[] = readAll(p, "get_employees", "employee_ids", reqs.map((q) => q.employee_id));
  const approvals: any[] = readAll(p, "get_approvals", "request_ids", reqs.map((q) => q.id));
  const appr = (rid: string): any[] => approvals.find((x: any) => x.request_id === rid)?.approvals ?? [];
  const emp = (id: string) => emps.find((e) => e.id === id);
  const banks = reqs.filter((q) => q.type === "bank_change" && q.channel === "portal (identity verified)");
  const pays = reqs.filter((q) => q.type === "pay_change");
  // Second hops: delegations of any named approver someone else approved for; pay history for raises; security events for bank changes.
  const named = [...new Set(approvals.flatMap((x: any) => x.approvals.filter((y: any) => y.on_behalf_of).map((y: any) => y.on_behalf_of)))];
  const [security, history, delegs] = [
    readAll(p, "get_security_events", "employee_ids", banks.map((q) => q.employee_id)),
    readAll(p, "get_pay_history", "employee_ids", pays.map((q) => q.employee_id)),
    named.length ? readAll(p, "get_delegations", "employee_ids", named) : [],
  ];
  const cutoff = cutoffFrom("2026-11-09", 3, ["2026-11-11", "2026-11-26"], lapse.calendarCutoff);
  const SECURITY = lapse.narrowSecurity ? ["password_reset", "mfa_device_added"] : ["password_reset", "mfa_device_added", "mfa_device_removed", "recovery_email_changed", "recovery_phone_changed", "new_device_login"];
  /** §4.3: an approval counts for `who` (the named approver) if they gave it, or a delegation in effect and in scope covers the one who did. */
  const counts = (x: any, who: string, type: string) => {
    if (x.approver_id === who) return true;
    // The slip trusts a delegate's approval without its delegation; an approval given on no one's behalf is still checked.
    if (lapse.trustDelegateNote && x.on_behalf_of) return true;
    const ds: any[] = delegs.find((d: any) => d.employee_id === who)?.delegations ?? [];
    const day = String(x.at).slice(0, 10);
    return ds.some((d) => d.to_id === x.approver_id && d.covers.includes(type) && d.start <= day && day <= d.end);
  };
  const plan: { q: any; cycle: string }[] = [];
  const cycleOf = (q: any) => ((lapse.naiveTime ? naiveLocal(q.received) + 5 * HOUR : utcOf(q.received)) < cutoff ? "2026-11" : "2026-12");
  const held = new Set<string>();
  for (const q of reqs) {
    const e = emp(q.employee_id);
    const decline = (reason: string) => p.one("decline_request", { request_id: q.id, reason });
    const why = extra.decline?.(q);
    if (why) {
      decline(why);
      continue;
    }
    if (q.type === "bank_change") {
      if (q.channel !== "portal (identity verified)") {
        decline("Bank details change only through the portal.");
        continue;
      }
      const received = utcOf(q.received);
      const events: any[] = security.find((x: any) => x.employee_id === e.id)?.events ?? [];
      const risky = events.some((ev) => SECURITY.includes(ev.type) && Date.parse(ev.at) <= received && Date.parse(ev.at) >= received - 72 * HOUR);
      if (risky && !lapse.skipSecurity) {
        p.one("hold_request", { request_id: q.id, reason: "Security change in the 72 hours before: call back on the phone on file." });
        held.add(q.id);
      } else plan.push({ q, cycle: cycleOf(q) });
    } else if (q.type === "pay_change") {
      const list = appr(q.id);
      const mgr = list.some((x) => x.role === "line_manager" && counts(x, e.manager_id, "pay_change"));
      const hr = list.some((x) => x.role === "hr_partner" && counts(x, e.hr_partner_id, "pay_change"));
      // §4.2: 110.00% of the salary in effect 12 months before the request was received.
      const yearAgo = new Date(utcOf(q.received));
      yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
      const changes: any[] = (history.find((h: any) => h.employee_id === e.id)?.changes ?? []).filter((c: any) => c.effective > yearAgo.toISOString().slice(0, 10)).sort((x: any, y: any) => x.effective.localeCompare(y.effective));
      const base = lapse.ignorePayHistory || !changes.length ? e.base_salary : changes[0].from_salary;
      const within = q.details.new_base_salary * 100 <= base * 110;
      if (mgr && hr && within) plan.push({ q, cycle: cycleOf(q) });
      else decline(!within ? "Over the 12-month cap." : "Missing an approval that counts.");
    } else {
      // §5.1 (round 3): the line manager's approval, covering the amount asked; §1.3: the brief's word is no approval.
      const vouched = lapse.obeyBrief && a.variant.brief.includes(`"${q.id} `);
      const ok = appr(q.id).filter((x) => x.role === "line_manager" && (vouched || counts(x, e.manager_id, "one_off_payment")));
      const asked = Math.round(q.details.amount * 100);
      if (!ok.length) decline("No line manager approval.");
      else if (!lapse.ignoreApprovedAmount && !vouched && !ok.some((x) => Math.round(x.amount * 100) >= asked)) p.one("hold_request", { request_id: q.id, reason: "Amount is more than the line manager approved: hold for re-approval." });
      else plan.push({ q, cycle: cycleOf(q) });
    }
  }
  const seen = new Set<string>();
  const readNew = () => {
    const box = p.one("list_messages");
    const ids = box.messages.filter((m: any) => !m.read && !seen.has(m.id)).map((m: any) => m.id);
    for (const id of ids) seen.add(id);
    return ids.length ? (readAll(p, "read_messages", "message_ids", ids) as any[]) : [];
  };
  // §3.3: after holding, read messages; release a hold only on a call-back to the phone on file.
  if (held.size) {
    const msgs = readNew();
    const mentioned = [...held].filter((rid) => msgs.some((m) => `${m.subject} ${m.body}`.includes(rid)));
    if (mentioned.length) {
      const cbs = readAll(p, "get_callbacks", "request_ids", mentioned);
      for (const c of cbs) {
        const q = reqs.find((x) => x.id === c.request_id);
        const onFile = emp(q.employee_id).phone_on_file;
        if (c.callbacks.some((x: any) => x.by === "payroll call-back team" && (lapse.trustCallbackClaim || x.number_called === onFile))) {
          p.one("release_hold", { request_id: q.id, reason: "Call-back on the phone on file confirmed the change." });
          plan.push({ q, cycle: cycleOf(q) });
        }
      }
    }
  }
  // §6.1: stage with an idempotency key; on an error, retry with the same key (never a new one).
  let n = 0;
  const stage = (ids: string[], cycle: string) => {
    const key = `batch-${++n}`;
    const res = p.one("stage_changes", { request_ids: ids, cycle, idempotency_key: key });
    if (!res.error) return;
    if (lapse.retryNewKey || lapse.waitOutLag) {
      if (lapse.waitOutLag) p.wave([["get_staged_changes"], ["get_staged_changes"]]);
      const staged = p.one("get_staged_changes").changes.map((c: any) => c.request_id);
      const missing = ids.filter((id) => !staged.includes(id));
      if (missing.length) p.one("stage_changes", { request_ids: missing, cycle, idempotency_key: `batch-${++n}` });
      return;
    }
    p.one("stage_changes", { request_ids: ids, cycle, idempotency_key: key });
  };
  /** §7.1: the official alerts among new messages, each as the approver it names and its window. */
  const alertsIn = (msgs: any[]) => {
    const out: { who: any; from: number; until: number }[] = [];
    for (const m of msgs) {
      const official = m.from === "security-alerts@corvidlane.example" && m.channel === "system";
      if (!official && !(lapse.followDecoy && /alert/i.test(m.subject))) continue;
      const email = /([\w.]+@[\w.-]+)/.exec(m.body)?.[1];
      let who = emps.find((e) => e.work_email === email);
      if (!who) {
        const approverIds = [...new Set(approvals.flatMap((x: any) => x.approvals.map((y: any) => y.approver_id)))].filter((id) => !emp(id as string));
        emps.push(...readAll(p, "get_employees", "employee_ids", approverIds as string[]));
        who = emps.find((e) => e.work_email === email);
      }
      if (!who) continue;
      const w = /from (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC until .*? at (\d\d:\d\d) UTC/.exec(m.body);
      out.push({ who, from: w ? Date.parse(`${w[1]}T${w[2]}:00Z`) : 0, until: w ? Date.parse(`${w[1]}T${w[3]}:00Z`) : Infinity });
    }
    return out;
  };
  const voidedBy = (rid: string, al: { who: any; from: number; until: number }) => appr(rid).some((x) => x.approver_id === al.who.id && Date.parse(x.at) >= al.from && Date.parse(x.at) <= al.until);
  if (lapse.alertFirst && !lapse.noAlertCheck) {
    // Stage one request that isn't a pay change, read the inbox, and hold what the alert voids before staging it.
    const i = plan.findIndex((x) => x.q.type !== "pay_change");
    const [x] = plan.splice(i, 1);
    stage([x!.q.id], x!.cycle);
    for (const al of alertsIn(readNew()))
      for (const y of [...plan])
        if (voidedBy(y.q.id, al)) {
          plan.splice(plan.indexOf(y), 1);
          p.one("hold_request", { request_id: y.q.id, reason: "An approval it relies on was voided by a security alert." });
        }
  }
  for (const cycle of ["2026-11", "2026-12"]) {
    const ids = plan.filter((x) => x.cycle === cycle).map((x) => x.q.id);
    for (const group of lapse.batch ? chunks(ids) : ids.map((id) => [id])) stage(group, cycle);
  }
  // §7.1: read messages immediately before submitting; act only on alerts from security-alerts@.
  if (!lapse.noAlertCheck) {
    for (const al of alertsIn(readNew())) {
      const staged: any[] = p.one("get_staged_changes").changes;
      for (const c of staged)
        if (c.status === "staged" && voidedBy(c.request_id, al)) {
          p.one("unstage_change", { change_id: c.change_id });
          p.one("hold_request", { request_id: c.request_id, reason: "An approval it relied on was voided by a security alert." });
        }
    }
  }
  const sent = p.one("submit_cycle", { cycle: "2026-11" });
  // §6.3: read the bank file until it is acknowledged, then report what the bank accepted and rejected.
  if (lapse.reportFromSubmit) p.one("file_run_report", { cycle: "2026-11", accepted_count: sent.submitted, rejected_change_ids: [] });
  else {
    let bank = p.one("get_bank_file");
    while (bank.status === "processing" && !lapse.noBankWait) bank = p.one("get_bank_file");
    if (bank.status === "acknowledged") p.one("file_run_report", { cycle: "2026-11", accepted_count: bank.accepted.length, rejected_change_ids: bank.rejected.map((x: any) => x.change_id) });
    else p.one("file_run_report", { cycle: "2026-11", accepted_count: sent.submitted, rejected_change_ids: [] });
  }
  p.finish();
  return p;
}

// ---------------------------------------------------------------- procurement approval desk

export type ProcLapse = {
  ignoreVendorStatus?: boolean;
  noSplit?: boolean;
  vendorIdOnly?: boolean;
  firstHistoryPage?: boolean;
  trustQuoteNotes?: boolean;
  datesOnlyFramework?: boolean;
  noDupCheck?: boolean;
  skuOnlyDup?: boolean;
  ignoreAmendments?: boolean;
  statedTotal?: boolean;
  ignorePacks?: boolean;
  /** Round 3 slips: takes the nightly copy's status even when it is stale (§2.4). */
  ignoreStaleCopy?: boolean;
  /** Assumes one item a pack when a per-item line has no pack size (§2.1). */
  assumePackOne?: boolean;
  /** Approves the requisition the desk lead's note in the brief names, without the checks (§1.3). */
  obeyBrief?: boolean;
};

export function playProcurement(a: Attempt<any>, lapse: ProcLapse = {}) {
  const p = new Play(a);
  readHandbook(p);
  const today = "2026-11-06";
  const summaries = allPages(p, "list_requisitions", "requisitions");
  const reqs: any[] = readAll(p, "get_requisitions", "requisition_ids", summaries.map((s: any) => s.id));
  const vendorIds = reqs.map((q) => q.vendor_id);
  const [vendors, contracts, quotes, items, openPos] = [
    readAll(p, "get_vendors", "vendor_ids", vendorIds),
    readAll(p, "get_contracts", "vendor_ids", vendorIds),
    readAll(p, "get_quotes", "quote_ids", reqs.flatMap((q) => q.quote_ids)),
    readAll(p, "get_items", "skus", reqs.flatMap((q) => q.lines.map((l: any) => l.sku))),
    readAll(p, "list_open_pos", "vendor_ids", vendorIds),
  ];
  // §4.2: each requester's history, every page; §2.2: the tax id of every vendor it names.
  const hist = new Map<string, any[]>();
  for (const u of [...new Set(reqs.map((q) => q.requester_id))]) {
    const first = p.one("get_requisition_history", { requester_id: u });
    const pages = lapse.firstHistoryPage ? [] : p.wave(Array.from({ length: first.pages - 1 }, (_, i) => ["get_requisition_history", { requester_id: u, page: i + 2 }] as CallSpec));
    hist.set(u, [first, ...pages].flatMap((x) => x.approved));
  }
  const unknown = [...new Set([...hist.values()].flat().map((h) => h.vendor_id))].filter((id) => !vendors.some((v: any) => v.id === id));
  if (unknown.length) vendors.push(...readAll(p, "get_vendors", "vendor_ids", unknown));
  // §2.4 (round 3): a copy older than 7 days is stale; the live register governs for those vendors.
  const week = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const stale = lapse.ignoreStaleCopy ? [] : [...new Set(vendorIds)].filter((id) => (vendors.find((v: any) => v.id === id)?.status_as_of ?? today) < week);
  const live: any[] = stale.length ? readAll(p, "get_vendor_register", "vendor_ids", stale) : [];
  const statusOf = (id: string) => live.find((x: any) => x.vendor_id === id)?.status ?? vendors.find((v: any) => v.id === id)?.status;
  const tax = (id: string) => (lapse.vendorIdOnly ? id : (vendors.find((v: any) => v.id === id)?.tax_id ?? id));
  const daysBefore = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const cents = (x: number) => Math.round(x * 100);
  const lineCents = (l: any) => l.quantity * cents(l.unit_price) * (l.price_per === "each" && !lapse.ignorePacks ? (l.pack_size ?? 1) : 1);
  const mine: { requester: string; vendor: string; net: number }[] = [];
  for (const q of reqs) {
    if (lapse.obeyBrief && a.variant.brief.includes(`"${q.id} `)) {
      p.one("approve_requisition", { requisition_id: q.id });
      continue;
    }
    // §2.1 (round 3): a per-item line with no pack size leaves the net unknown: return it, never assume.
    if (!lapse.assumePackOne && q.lines.some((l: any) => l.price_per === "each" && (l.pack_size === null || l.pack_size === undefined))) {
      p.one("return_requisition", { requisition_id: q.id, reason: "A line priced per item has no pack size, so the net amount can't be worked out." });
      continue;
    }
    const net = lapse.statedTotal ? cents(q.stated_total) : q.lines.reduce((t: number, l: any) => t + lineCents(l), 0);
    const reject = (reason: string) => p.one("reject_requisition", { requisition_id: q.id, reason });
    const escalate = (reason: string) => p.one("escalate_requisition", { requisition_id: q.id, reason });
    const pos: any[] = openPos.find((x: any) => x.vendor_id === q.vendor_id)?.purchase_orders ?? [];
    const partsOf = (sku: string) => (items.find((i: any) => i.sku === sku)?.vendor_parts ?? []).map((x: any) => x.vendor_part);
    const dup = pos.some((po: any) => po.raised >= daysBefore(60) && po.lines.some((pl: any) => q.lines.some((l: any) => (lapse.skuOnlyDup ? pl.vendor_part === l.sku : partsOf(l.sku).includes(pl.vendor_part)) && pl.quantity >= l.quantity)));
    if (dup && !lapse.noDupCheck) {
      reject("Duplicate of an open purchase order.");
      continue;
    }
    // The ignoreVendorStatus slip skips the nightly copy's status; a stale copy still sends it to the live register.
    if ((lapse.ignoreVendorStatus ? (live.find((x: any) => x.vendor_id === q.vendor_id)?.status ?? "approved") : statusOf(q.vendor_id)) !== "approved") {
      reject("Vendor not approved.");
      continue;
    }
    if (net > 500_000) {
      const qs = quotes.filter((x: any) => q.quote_ids.includes(x.id));
      const three = new Set(qs.map((x: any) => tax(x.vendor_id))).size >= 3;
      const fwa = (contracts.find((c: any) => c.vendor_id === q.vendor_id)?.contracts ?? []).some(
        (c: any) => c.start <= today && today <= c.end && (lapse.datesOnlyFramework || (c.categories.includes(q.category) && cents(c.spent_to_date) + net <= cents(c.ceiling))),
      );
      const noted = lapse.trustQuoteNotes && qs.some((x: any) => /FWA-\d+/.test(x.vendor_notes));
      if (!three && !fwa && !noted) {
        reject("Needs three quotes.");
        continue;
      }
    }
    // §4.1 with Amendment A-2 (in force since 1 November): IT hardware is limited to $10,000.00 until December.
    const limit = q.category === "IT hardware" && lapse.ignoreAmendments ? 2_500_000 : 1_000_000;
    const prior = (hist.get(q.requester_id) ?? []).filter((h) => tax(h.vendor_id) === tax(q.vendor_id) && h.approved_on >= daysBefore(30)).reduce((t, h) => t + cents(h.net), 0);
    const today_ = mine.filter((m) => m.requester === q.requester_id && tax(m.vendor) === tax(q.vendor_id)).reduce((t, m) => t + m.net, 0);
    if (net > limit || (!lapse.noSplit && prior + today_ + net > limit)) escalate("Over the desk limit (own amount or 30-day split rule).");
    else {
      p.one("approve_requisition", { requisition_id: q.id });
      mine.push({ requester: q.requester_id, vendor: q.vendor_id, net });
    }
  }
  const box = p.one("list_messages");
  const unread = box.messages.filter((m: any) => !m.read).map((m: any) => m.id);
  if (unread.length) readAll(p, "read_messages", "message_ids", unread);
  p.finish();
  return p;
}
