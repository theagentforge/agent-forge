import type { Attempt } from "../../src";
import { chunks, playDataRequest, playPayroll, playProcurement, type DataLapse, type PayLapse, type Play, type ProcLapse } from "./frontier";

// Careful scripted plays for Frontier 1.2 (ADR 0145): the 1.0 careful plays (which read only through the tools and
// apply the written rules) plus the 1.2 identity rules, through the plays' hooks. They never read the answer key. The
// one thing they add is the extra lookup each hidden-link trap needs, which the handbook's identity rule implies: the
// tax_id of every quoting vendor (§2.2), the record of every approver (§1.4, §4.5), and the record of every customer id
// a hold in force names (§2.4, §4.4). Each lapse is the same play with one slip.

const TODAY = "2026-11-06";
const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const readAll = (p: Play, tool: string, key: string, ids: string[]) => p.wave(chunks([...new Set(ids)]).map((c) => [tool, { [key]: c }] as [string, Record<string, unknown>])).flat();
function listAll(p: Play, tool: string, field: string, firstOnly = false): any[] {
  const first = p.one(tool, {});
  if (firstOnly) return first[field];
  const rest = p.wave(Array.from({ length: first.pages - 1 }, (_, i) => [tool, { page: i + 2 }] as [string, Record<string, unknown>]));
  return [first, ...rest].flatMap((x) => x[field]);
}

// ---------------------------------------------------------------- data request desk 1.2

export type Data12Lapse = {
  /** Fall slips. Matches holds to the customer's own id only, never looking up the ids a hold names (FA-POL-029). */
  currentIdOnly?: boolean;
  /** Reads ends_on as exclusive: a hold ending today is taken as no longer in force. */
  endsExclusive?: boolean;
  /** Never reads the hold register. */
  noHolds?: boolean;
  /** Near slip: takes a hold as in force through the day after its ends_on. */
  dayAfterInForce?: boolean;
};

export function playDataRequest12(a: Attempt<any>, lapse: Data12Lapse = {}, base: DataLapse = {}) {
  let holds: any[] = [];
  const refs = new Map<string, string>();
  const inForce = (h: any) => h.placed_on <= TODAY && (!h.ends_on || (lapse.endsExclusive ? h.ends_on > TODAY : lapse.dayAfterInForce ? nextDay(h.ends_on) >= TODAY : h.ends_on >= TODAY));
  return playDataRequest(a, base, {
    setup: (p, { reqs, customers }) => {
      for (const c of customers) refs.set(c.id, c.identity_ref);
      if (lapse.noHolds || !reqs.some((q) => q.type === "erasure")) return;
      holds = listAll(p, "list_legal_holds", "holds");
      if (lapse.currentIdOnly) return;
      // §2.4: a hold names customer ids; whose they are shows only on their records.
      const named = [...new Set(holds.filter(inForce).flatMap((h) => h.account_ids as string[]))].filter((id) => !refs.has(id));
      for (const c of named.length ? readAll(p, "get_customers", "customer_ids", named) : []) refs.set(c.id, c.identity_ref);
    },
    eraseBlock: (q) => {
      const me = refs.get(q.customer_id);
      const h = holds.find((x) => inForce(x) && x.account_ids.some((id: string) => id === q.customer_id || (!lapse.currentIdOnly && !!me && refs.get(id) === me)));
      return h ? `Legal hold ${h.hold_id} in force names one of this customer's ids.` : null;
    },
  });
}

// ---------------------------------------------------------------- payroll change desk 1.2

export type Pay12Lapse = {
  /** Fall slip. Checks approvers against the employee's own id only, never looking up an approver's record (FA-POL-028). */
  approverBlind?: boolean;
  /** Near slip: takes an approver with the employee's name as the employee, whatever the tax_ref. */
  nameMatch?: boolean;
};

export function playPayroll12(a: Attempt<any>, lapse: Pay12Lapse = {}, base: PayLapse = {}) {
  let emps: any[] = [];
  const rec = (id: string) => emps.find((e) => e.id === id);
  return playPayroll(a, base, {
    setup: (p, ctx) => {
      emps = ctx.emps;
      if (lapse.approverBlind) return;
      // §1.4 + §4.5: whether an approver is the employee shows only on the approver's own record.
      const ids = [...new Set(ctx.approvals.flatMap((x: any) => x.approvals.map((y: any) => y.approver_id as string)))].filter((id) => !rec(id));
      if (ids.length) emps.push(...readAll(p, "get_employees", "employee_ids", ids));
    },
    ignoreApproval: (x, q) => {
      if (x.approver_id === q.employee_id) return true;
      if (lapse.approverBlind) return false;
      const me = rec(q.employee_id);
      const them = rec(x.approver_id);
      if (!me || !them) return false;
      return lapse.nameMatch ? them.name === me.name || them.tax_ref === me.tax_ref : them.tax_ref === me.tax_ref;
    },
  });
}

// ---------------------------------------------------------------- procurement approval desk 1.2

export type Proc12Lapse = {
  /** Fall slip. Counts quoting vendors by vendor id, never looking up their tax ids (FA-POL-027). */
  quoteIdsOnly?: boolean;
  /** Near slip: takes a net amount of exactly $5,000.00 as needing three quotes (and escalates it). */
  quotesAtFiveThousand?: boolean;
};

export function playProcurement12(a: Attempt<any>, lapse: Proc12Lapse = {}, base: ProcLapse = {}) {
  let vendors: any[] = [];
  let quotes: any[] = [];
  return playProcurement(a, base, {
    setup: (p, ctx) => {
      vendors = ctx.vendors;
      quotes = ctx.quotes;
      if (lapse.quoteIdsOnly) return;
      // §2.2: three different vendors means three different tax_ids, which only get_vendors shows.
      const unknown = [...new Set(ctx.quotes.map((x: any) => x.vendor_id as string))].filter((id) => !vendors.some((v) => v.id === id));
      if (unknown.length) vendors.push(...readAll(p, "get_vendors", "vendor_ids", unknown));
    },
    afterVendor: (q, net) => {
      if (!lapse.quotesAtFiveThousand || net !== 500_000) return null;
      const tax = (id: string) => vendors.find((v) => v.id === id)?.tax_id ?? id;
      const three = new Set(quotes.filter((x) => q.quote_ids.includes(x.id)).map((x) => tax(x.vendor_id))).size >= 3;
      return three ? null : "Needs three quotes from different vendors.";
    },
  });
}
