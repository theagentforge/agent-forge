import type { Attempt } from "../../src";
import { chunks, playDataRequest, playPayroll, playProcurement, type DataLapse, type PayLapse, type Play, type ProcLapse } from "./frontier";

// Careful scripted plays for Frontier 1.1 (ADR 0144): the 1.0 careful plays (which read only through the tools and
// apply the written rules) plus the new rules, through the plays' hooks. They never read the answer key. Each lapse is
// the same play with one slip: the "fall" slips are what each new trap is built to catch; the "near" slips are the
// over-cautious misreadings of the near cases, which must fail an ordinary checkpoint and spring nothing.

const TODAY = "2026-11-06";
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysBefore = (d: string, n: number) => day(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000);
const cents = (x: number) => Math.round(x * 100);

/** Every page of a paginated per-id read, for several ids, batched a page at a time. */
function pagesOf(p: Play, tool: string, idKey: string, ids: string[], field: string, firstOnly = false, heads?: Map<string, any>): Map<string, any[]> {
  const out = new Map<string, any[]>();
  if (!ids.length) return out;
  const first = p.wave(ids.map((id) => [tool, { [idKey]: id }] as [string, Record<string, unknown>]));
  const more: [string, Record<string, unknown>][] = [];
  ids.forEach((id, i) => {
    out.set(id, [...(first[i][field] ?? [])]);
    heads?.set(id, first[i]);
    if (!firstOnly) for (let n = 2; n <= (first[i].pages ?? 1); n++) more.push([tool, { [idKey]: id, page: n }]);
  });
  const rest = p.wave(more);
  more.forEach(([, args], i) => out.get(args[idKey] as string)!.push(...(rest[i][field] ?? [])));
  return out;
}
function listAll(p: Play, tool: string, field: string, firstOnly = false): any[] {
  const first = p.one(tool, {});
  if (firstOnly) return first[field];
  const rest = p.wave(Array.from({ length: first.pages - 1 }, (_, i) => [tool, { page: i + 2 }] as [string, Record<string, unknown>]));
  return [first, ...rest].flatMap((x) => x[field]);
}

// ---------------------------------------------------------------- data request desk 1.1

export type Data11Lapse = {
  /** Fall slips. Uses the mandate as granted, never the change log (FA-PRV-005). */
  grantedMandate?: boolean;
  /** Reads only the change log's first page. */
  firstChangesPage?: boolean;
  /** Takes the latest change recorded, whatever its effective date (springs FA-PRV-005; fails the near case too). */
  latestChange?: boolean;
  /** Matches legal holds on the current account id only (FA-POL-026). */
  currentIdOnly?: boolean;
  /** Reads only the register's first page. */
  holdsFirstPage?: boolean;
  /** Near slip: counts a hold released today as still in force. */
  releasedTodayInForce?: boolean;
};

export function playDataRequest11(a: Attempt<any>, lapse: Data11Lapse = {}, base: DataLapse = {}) {
  let changes = new Map<string, any[]>();
  let holds: any[] = [];
  let custs: any[] = [];
  return playDataRequest(a, base, {
    setup: (p, { reqs, customers }) => {
      custs = customers;
      const reps = [...new Set(reqs.filter((q) => q.type === "representative_access").map((q) => q.customer_id as string))];
      if (!lapse.grantedMandate) changes = pagesOf(p, "get_authorization_changes", "customer_id", reps, "changes", lapse.firstChangesPage);
      if (reqs.some((q) => q.type === "erasure")) holds = listAll(p, "list_legal_holds", "holds", lapse.holdsFirstPage);
    },
    mandate: (q, auth) => {
      const mine = (changes.get(q.customer_id) ?? []).filter((c) => c.auth_id === auth.auth_id);
      const inForce = lapse.latestChange ? mine : mine.filter((c) => c.effective <= TODAY);
      const last = [...inForce].sort((x, y) => (lapse.latestChange ? x.recorded_on.localeCompare(y.recorded_on) : x.effective.localeCompare(y.effective) || x.recorded_on.localeCompare(y.recorded_on))).at(-1);
      return last ? last.to : auth.mandate_as_granted;
    },
    eraseBlock: (q) => {
      const c = custs.find((x) => x.id === q.customer_id);
      const ids = lapse.currentIdOnly ? [c.id] : [c.id, ...(c.previous_ids ?? [])];
      const h = holds.find((x) => x.placed_on <= TODAY && (!x.released_on || x.released_on > TODAY || (lapse.releasedTodayInForce && x.released_on === TODAY)) && x.account_ids.some((id: string) => ids.includes(id)));
      return h ? `Legal hold ${h.hold_id} in force names this customer's account.` : null;
    },
  });
}

// ---------------------------------------------------------------- payroll change desk 1.1

export type Pay11Lapse = {
  /** Fall slips. Sums one-offs under the request's own employee id only (FA-POL-024). */
  ownIdOnly?: boolean;
  /** Reads only the first page of each payment history. */
  firstPaymentPage?: boolean;
  /** Never checks the one-off cap. */
  noCap?: boolean;
  /** Checks approvers against the employee's own id only, not other_ids (FA-POL-025). */
  selfBlind?: boolean;
  /** Near slip: counts a payment made 91 days before (one day outside the window). */
  count91?: boolean;
};

export function playPayroll11(a: Attempt<any>, lapse: Pay11Lapse = {}, base: PayLapse = {}) {
  let hist = new Map<string, any[]>();
  let emps: any[] = [];
  const idsOf = (eid: string) => [eid, ...(emps.find((e) => e.id === eid)?.other_ids ?? [])];
  return playPayroll(a, base, {
    setup: (p, ctx) => {
      emps = ctx.emps;
      if (lapse.noCap) return;
      const oneOffs = ctx.reqs.filter((q) => q.type === "one_off_payment");
      const ids = [...new Set(oneOffs.flatMap((q) => (lapse.ownIdOnly ? [q.employee_id] : idsOf(q.employee_id))))] as string[];
      hist = pagesOf(p, "get_payment_history", "employee_id", ids, "payments", lapse.firstPaymentPage);
    },
    ignoreApproval: (x, q) => (lapse.selfBlind ? x.approver_id === q.employee_id : idsOf(q.employee_id).includes(x.approver_id)),
    oneOffHold: (q) => {
      if (lapse.noCap) return null;
      const recv = day(Date.parse(q.received.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d) ([+-]\d\d:\d\d)$/, "$1T$2:00$3")));
      const from = daysBefore(recv, lapse.count91 ? 91 : 90);
      const ids = lapse.ownIdOnly ? [q.employee_id] : idsOf(q.employee_id);
      const paid = ids.flatMap((id) => hist.get(id) ?? []).filter((x) => x.type === "one_off_payment" && x.paid_on >= from && x.paid_on <= recv);
      const total = paid.reduce((t, x) => t + cents(x.amount), 0) + cents(q.details.amount);
      return total > 500_000 ? "One-offs in the last 90 days, under every id of this person, would be over $5,000.00: hold for the HR director." : null;
    },
  });
}

// ---------------------------------------------------------------- procurement approval desk 1.1

export type Proc11Lapse = {
  /** Fall slips. Leaves out the merged cost centre's commitments (FA-POL-022). */
  ignoreMerged?: boolean;
  /** Reads only each cost centre's first page of commitments. */
  budgetFirstPage?: boolean;
  /** Never checks budgets. */
  noBudget?: boolean;
  /** Matches declarations to the vendor by company name, not tax id (FA-POL-023). */
  nameOnlyInterest?: boolean;
  /** Never reads the register of declared interests. */
  noInterest?: boolean;
  /** Near slips: counts October commitments against November's budget; counts a declaration withdrawn that day as current. */
  countOctober?: boolean;
  withdrawnCurrent?: boolean;
};

export function playProcurement11(a: Attempt<any>, lapse: Proc11Lapse = {}, base: ProcLapse = {}) {
  const MERGED: Record<string, string> = { "CC-4400": "CC-4410" };
  let budgets = new Map<string, { budget: number; spent: number }>();
  let decls: any[] = [];
  let vendors: any[] = [];
  const mine = new Map<string, number>();
  return playProcurement(a, base, {
    setup: (p, ctx) => {
      vendors = ctx.vendors;
      if (!lapse.noBudget) {
        const ccs = [...new Set(ctx.reqs.map((q) => q.cost_centre as string))];
        const all = [...new Set([...ccs, ...(lapse.ignoreMerged ? [] : ccs.map((c) => MERGED[c]).filter(Boolean))])] as string[];
        const heads = new Map<string, any>();
        const pages = pagesOf(p, "get_budget", "cost_centre", all, "commitments", lapse.budgetFirstPage, heads);
        const inMonth = (x: any) => (lapse.countOctober ? x.raised >= "2026-10-01" : x.raised >= "2026-11-01") && x.raised <= "2026-11-30";
        const spentOf = (c: string) => (pages.get(c) ?? []).filter(inMonth).reduce((t, x) => t + cents(x.net), 0);
        budgets = new Map(ccs.map((c) => [c, { budget: cents(heads.get(c)?.budget ?? 0), spent: spentOf(c) + (MERGED[c] && !lapse.ignoreMerged ? spentOf(MERGED[c]!) : 0) }]));
      }
      if (!lapse.noInterest) decls = listAll(p, "list_declarations", "declarations");
    },
    afterVendor: (q) => {
      if (lapse.noInterest) return null;
      const v = vendors.find((x) => x.id === q.vendor_id);
      const recv = String(q.received).slice(0, 10);
      const hit = decls.find(
        (d) =>
          d.employee_id === q.requester_id &&
          (lapse.nameOnlyInterest ? d.company_name === v?.name : d.company_tax_id === v?.tax_id) &&
          d.declared_on <= recv &&
          (!d.withdrawn_on || d.withdrawn_on > recv || (lapse.withdrawnCurrent && d.withdrawn_on === recv)),
      );
      return hit ? `The requester has a current declared interest in this vendor (${hit.declaration_id}).` : null;
    },
    afterLimit: (q, net) => {
      if (lapse.noBudget) return null;
      const b = budgets.get(q.cost_centre);
      if (!b) return null;
      return net > b.budget - b.spent - (mine.get(q.cost_centre) ?? 0) ? "Doesn't fit in the cost centre's remaining November budget." : null;
    },
    approved: (q, net) => mine.set(q.cost_centre, (mine.get(q.cost_centre) ?? 0) + net),
  });
}

export { chunks };
