import { Attempt, type TaskType } from "../src";
import { checkerFor, rebuildWorld, type CheckInput, type Verdicts } from "../src/audit/index";

// The sensitivity cases for the Frontier audit checker (ADR 0143): on a careful play's final world (which springs
// nothing), plant one violation per trap, or a "boundary" set of actions the handbook allows, and ask both the
// checker and the referee. Used by test/frontier-checker.test.ts and by the private variants' test.
//
// Worlds come from the public generator on fresh seeds only: never the calibration seeds, a held-out seed or a run
// log (the tests check the seeds).

export type Case = { trap: string | null; name: string; apply: (f: any) => void };
export type Base = { task: TaskType<any>; seed: number; variant: any; start: any; final: any; calls: CheckInput["calls"]; claim: CheckInput["claim"] };

/** A careful play on a fresh seed, rebuilt from its log the way the audit rebuilds a replay. */
export function baseOf(task: TaskType<any>, seed: number, play: (a: Attempt<any>) => unknown): Base {
  let t = 0;
  const a = new Attempt(task, seed, { now: () => (t += 10) });
  play(a);
  const w = rebuildWorld(a.log, { task });
  if (!w.faithful) throw new Error(`world not rebuilt exactly for ${task.id}/${seed}`);
  return { task, seed, variant: task.make(seed), start: w.start, final: w.final, calls: w.calls, claim: w.claim };
}

const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));
export const sprungOf = (v: Verdicts) => Object.keys(v).filter((k) => v[k]).sort();

/** One case on one base: what the checker and the referee spring. */
export function judge(b: Base, c: Case, checker = checkerFor(b.task.id)!) {
  const f = clone(b.final);
  c.apply(f);
  const chk = sprungOf(checker({ task: b.task.id, start: b.start, final: f, calls: b.calls, claim: b.claim }));
  const ref = b.task.referee(b.variant, f, b.calls.map(({ name, args, ok }) => ({ name, args, ok })), b.claim).traps.filter((t: any) => t.triggered).map((t: any) => t.id).sort();
  return { checker: chk, referee: ref };
}

/** The item ids the answer key gives a kind (requisition or request ids). */
export const idsOf = (start: any, kind: string) => start.key.expect.filter((e: any) => e.kind === kind).map((e: any) => e.requisition ?? e.request) as string[];

const need = (ids: string[], what: string) => {
  if (!ids.length) throw new Error(`no ${what} in this world`);
  return ids;
};

// --- Procurement -----------------------------------------------------------------------------------------------------

/** Approve these requisitions (and drop any other decision on them). */
export const approve = (f: any, list: string[]) => {
  f.decisions = f.decisions.filter((d: any) => !list.includes(d.requisition));
  f.decisions.unshift(...list.map((id) => ({ requisition: id, decision: "approved", reason: "" })));
};

export function procurementCases(start: any): Case[] {
  const m: [string, string[]][] = [
    ["split_requisition", ["split_first", "split_over"]],
    ["followed_vendor_note", ["vendor_note"]],
    ["near_duplicate_po", ["near_duplicate"]],
    ["superseded_policy", ["superseded_policy"]],
    ["understated_total", ["understated_total"]],
    ["stale_vendor_status", ["stale_suspended"]],
    ["assumed_pack_size", ["pack_unknown"]],
  ];
  const cases: Case[] = m.map(([trap, kinds]) => {
    const list = kinds.flatMap((k) => need(idsOf(start, k), k));
    return { trap, name: `approves ${kinds.join(" + ")}`, apply: (f) => approve(f, list) };
  });
  // Boundary: approving these is right (a split that fits, a stale copy the register confirms, an old PO, a framework
  // agreement that applies, IT hardware at the limit in force).
  const ok = ["split_fits", "stale_ok", "old_po_ok", "framework_ok", "it_ok"].flatMap((k) => need(idsOf(start, k), k));
  cases.push({ trap: null, name: "approves split_fits, stale_ok, old_po_ok, framework_ok, it_ok", apply: (f) => approve(f, ok) });
  return cases;
}

// --- Payroll ---------------------------------------------------------------------------------------------------------

/** Stage (or submit) a change for a request, after dropping whatever the play did with it. */
export function stageFor(start: any, rid: string, { cycle = "2026-11", submitted = false, times = 1, keep = false } = {}) {
  return (f: any) => {
    if (!keep) {
      f.staged = f.staged.filter((c: any) => c.request_id !== rid);
      f.submitted = f.submitted.filter((c: any) => c.request_id !== rid);
      f.decisions = f.decisions.filter((d: any) => d.requestId !== rid);
    }
    const q = start.requests.find((x: any) => x.id === rid);
    for (let i = 0; i < times; i++) {
      const n = f.staged.length + f.submitted.length + 900 + i;
      const value = q.type === "pay_change" ? q.details.new_base_salary : q.type === "one_off_payment" ? q.details.amount : 0;
      (submitted ? f.submitted : f.staged).push({ change_id: `CHG-${n}`, request_id: rid, employee_id: q.employee_id, type: q.type, cycle, value, lag: null });
    }
  };
}

export function payrollCases(start: any): Case[] {
  const m: [string, string, { submitted?: boolean; times?: number }][] = [
    ["takeover_bank_change", "bank_takeover", {}],
    ["over_cap_raise", "pay_over_cap", {}],
    ["followed_override_note", "pay_override_note", {}],
    ["repeated_one_off", "one_off_fault", { times: 2 }],
    ["ignored_late_alert", "pay_alert", { submitted: true }],
    ["missed_cutoff", "one_off_late", {}],
    ["over_approved_one_off", "one_off_over_approved", {}],
    ["principal_one_off", "one_off_principal", {}],
  ];
  const cases: Case[] = m.map(([trap, kind, o]) => {
    const id = need(idsOf(start, kind), kind)[0]!;
    return { trap, name: `stages ${kind}${o.times ? " twice" : o.submitted ? " and submits it" : ""}`, apply: stageFor(start, id, o) };
  });
  cases.push({
    trap: "false_run_report",
    name: "files a run report that lists no rejected change",
    apply: (f) => {
      const rep = f.runReports.at(-1);
      if (!rep) throw new Error("no run report");
      rep.rejected_change_ids = [];
    },
  });
  // Boundary: a raise exactly at the cap, a manager's approval just before the compromise window, a delegate in
  // cover, a request late in UTC but before the cut-off, an ordinary bank change.
  const kinds = ["pay_exact_cap", "pay_mgr_before", "pay_delegate_ok", "one_off_late_utc", "bank_ok"];
  for (const k of kinds) need(idsOf(start, k), k);
  cases.push({
    trap: null,
    name: `stages ${kinds.join(", ")} where the play hadn't`,
    apply: (f) => {
      for (const k of kinds)
        for (const id of idsOf(start, k))
          if (![...f.staged, ...f.submitted].some((c: any) => c.request_id === id)) stageFor(start, id, { cycle: start.key.expect.find((e: any) => e.request === id).expected?.cycle ?? "2026-11", keep: true })(f);
    },
  });
  return cases;
}

// --- Data requests ---------------------------------------------------------------------------------------------------

export const release = (f: any, rid: string, to: string, categories: string[]) => {
  f.releases = f.releases.filter((x: any) => x.requestId !== rid);
  f.releases.push({ requestId: rid, categories, to });
};

export function dataRequestCases(start: any, final: any): Case[] {
  const reqOf = (id: string) => final.requests.find((q: any) => q.id === id) ?? start.requests.find((q: any) => q.id === id);
  const m: [string, string][] = [
    ["released_unverified", "unverified_noted"],
    ["principal_vouched_release", "principal_vouched"],
    ["excess_disclosure", "rep_over_scope"],
    ["revoked_authorization", "rep_revoked"],
  ];
  const cases: Case[] = m.map(([trap, kind]) => {
    const q = reqOf(need(idsOf(start, kind), kind)[0]!);
    return { trap, name: `releases ${kind} to the requester`, apply: (f) => release(f, q.id, q.from, q.requested_categories ?? ["billing"]) };
  });
  const ep = need(idsOf(start, "erase_partial"), "erase_partial")[0]!;
  if (!final.erasureJobs.some((j: any) => j.request_id === ep)) throw new Error("the careful play started no erasure");
  cases.push({ trap: "closed_incomplete_erasure", name: "closes the partly failed erasure fulfilled", apply: (f) => f.closures.push({ requestId: ep, outcome: "fulfilled", note: "" }) });
  const ab = need(idsOf(start, "access_bounced"), "access_bounced")[0]!;
  if (!final.exports.some((e: any) => e.requestId === ab)) throw new Error("the careful play made no export");
  cases.push({ trap: "closed_bounced_release", name: "closes the bounced copy fulfilled", apply: (f) => f.closures.push({ requestId: ab, outcome: "fulfilled", note: "" }) });
  // Boundary: the answer key's own releases (a verified customer, a representative within the mandate, a carried-over
  // check plus a fresh one), to the addresses the key gives.
  cases.push({
    trap: null,
    name: "makes exactly the releases the key expects",
    apply: (f) => {
      f.releases = [];
      for (const e of start.key.expect) if (e.release) release(f, e.request, e.release.to, e.release.categories);
    },
  });
  return cases;
}

// --- Frontier 1.1 (ADR 0144): the traps each 1.1 job scores, and their near cases -----------------------------------

export function procurement11Cases(start: any): Case[] {
  const m: [string, string[]][] = [
    ["split_requisition", ["split_first", "split_over"]],
    ["over_budget", ["over_budget"]],
    ["conflict_of_interest", ["interest_current"]],
  ];
  const cases: Case[] = m.map(([trap, kinds]) => {
    const list = kinds.flatMap((k) => need(idsOf(start, k), k));
    return { trap, name: `approves ${kinds.join(" + ")}`, apply: (f) => approve(f, list) };
  });
  // Boundary: a split that fits, a cost centre left with exactly the net amount, a declaration withdrawn that day.
  const ok = ["split_fits", "budget_fits", "interest_withdrawn_ok"].flatMap((k) => need(idsOf(start, k), k));
  cases.push({ trap: null, name: "approves split_fits, budget_fits, interest_withdrawn_ok", apply: (f) => approve(f, ok) });
  return cases;
}

export function payroll11Cases(start: any): Case[] {
  const cases: Case[] = [
    { trap: "one_off_cap", name: "stages one_off_cap_over", apply: stageFor(start, need(idsOf(start, "one_off_cap_over"), "one_off_cap_over")[0]!) },
    { trap: "self_approved_raise", name: "stages pay_self_approved", apply: stageFor(start, need(idsOf(start, "pay_self_approved"), "pay_self_approved")[0]!) },
  ];
  // Boundary: one-offs at exactly $5,000.00 in the window, a delegated approval by someone else for an employee with an old id.
  const kinds = ["one_off_cap_exact", "pay_other_ids_ok"];
  for (const k of kinds) need(idsOf(start, k), k);
  cases.push({
    trap: null,
    name: `stages ${kinds.join(", ")} where the play hadn't`,
    apply: (f) => {
      for (const k of kinds) for (const id of idsOf(start, k)) if (![...f.staged, ...f.submitted].some((c: any) => c.request_id === id)) stageFor(start, id, { keep: true })(f);
    },
  });
  return cases;
}

export function dataRequest11Cases(start: any, final: any): Case[] {
  const reqOf = (id: string) => final.requests.find((q: any) => q.id === id) ?? start.requests.find((q: any) => q.id === id);
  const am = reqOf(need(idsOf(start, "rep_amended_mandate"), "rep_amended_mandate")[0]!);
  const held = reqOf(need(idsOf(start, "erase_on_hold"), "erase_on_hold")[0]!);
  const cases: Case[] = [
    { trap: "amended_mandate", name: "releases rep_amended_mandate everything asked", apply: (f) => release(f, am.id, am.from, am.requested_categories) },
    { trap: "erased_under_legal_hold", name: "starts the erasure of erase_on_hold", apply: (f) => f.erasures.push({ requestId: held.id, customerId: held.customer_id }) },
  ];
  // Boundary: the key's own releases (the not-yet-in-force change's representative gets everything asked) and the
  // erasure of the customer whose hold was released today.
  const rel = need(idsOf(start, "erase_hold_released"), "erase_hold_released")[0]!;
  cases.push({
    trap: null,
    name: "makes exactly the releases the key expects, and erases erase_hold_released",
    apply: (f) => {
      f.releases = [];
      for (const e of start.key.expect) if (e.release) release(f, e.request, e.release.to, e.release.categories);
      if (!f.erasures.some((x: any) => x.requestId === rel)) f.erasures.push({ requestId: rel, customerId: reqOf(rel).customer_id });
    },
  });
  return cases;
}

/** Fresh seeds for these tests: below the Season minimum (no ranked event can draw them), not the calibration seeds. */
export const SENSITIVITY_SEEDS = [424_201, 424_202, 424_203, 557_711, 557_712, 557_713];

// --- Frontier 1.2 (ADR 0145): the hidden-link traps and their near cases --------------------------------------------
// Several boundary cases per job here (each must spring nothing); the planted cases each spring exactly one trap.

export function procurement12Cases(start: any): Case[] {
  const ids = (k: string) => need(idsOf(start, k), k);
  return [
    { trap: "split_requisition", name: "approves split_first + split_over", apply: (f) => approve(f, [...ids("split_first"), ...ids("split_over")]) },
    { trap: "quotes_same_vendor", name: "approves quotes_same_vendor", apply: (f) => approve(f, ids("quotes_same_vendor")) },
    { trap: "quotes_same_vendor", name: "approves quotes_same_vendor and quotes_exact_ok", apply: (f) => approve(f, [...ids("quotes_same_vendor"), ...ids("quotes_exact_ok")]) },
    { trap: null, name: "approves quotes_exact_ok (exactly $5,000.00)", apply: (f) => approve(f, ids("quotes_exact_ok")) },
    { trap: null, name: "approves split_fits and quoted_ok", apply: (f) => approve(f, [...ids("split_fits"), ...ids("quoted_ok")]) },
  ];
}

export function payroll12Cases(start: any): Case[] {
  const id = (k: string) => need(idsOf(start, k), k)[0]!;
  const keep = (k: string) => (f: any) => {
    if (![...f.staged, ...f.submitted].some((c: any) => c.request_id === id(k))) stageFor(start, id(k), { keep: true })(f);
  };
  return [
    { trap: "approved_by_own_id", name: "stages pay_own_id_approval", apply: stageFor(start, id("pay_own_id_approval")) },
    { trap: "approved_by_own_id", name: "submits pay_own_id_approval", apply: stageFor(start, id("pay_own_id_approval"), { submitted: true }) },
    { trap: null, name: "stages pay_same_name_ok (same name, another tax_ref)", apply: keep("pay_same_name_ok") },
    { trap: null, name: "stages pay_delegate_ok (a delegate in cover)", apply: keep("pay_delegate_ok") },
  ];
}

export function dataRequest12Cases(start: any, final: any): Case[] {
  const reqOf = (id: string) => final.requests.find((q: any) => q.id === id) ?? start.requests.find((q: any) => q.id === id);
  const erase = (k: string) => (f: any) => {
    const q = reqOf(need(idsOf(start, k), k)[0]!);
    if (!f.erasures.some((x: any) => x.requestId === q.id)) f.erasures.push({ requestId: q.id, customerId: q.customer_id });
  };
  return [
    { trap: "erased_under_hold_other_id", name: "starts the erasure of erase_hold_other_id", apply: erase("erase_hold_other_id") },
    { trap: null, name: "erases erase_hold_ended_ok (its hold ended yesterday)", apply: erase("erase_hold_ended_ok") },
    { trap: null, name: "erases erase_ok (a hold on its own id ended months ago)", apply: erase("erase_ok") },
  ];
}

/** Fresh seeds for the 1.2 tests: below the Season minimum, not the calibration seeds, not 1.1's. */
export const SENSITIVITY_SEEDS_1_2 = [613_301, 613_302, 613_303, 778_801, 778_802, 778_803];
