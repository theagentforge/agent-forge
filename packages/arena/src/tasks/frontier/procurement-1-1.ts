import { int as rint, pick } from "../../rng";
import type { TaskType, ToolDef } from "../../types";
import { dollars, str, trap } from "../util";
import { budgetLine, fail, frontierCaps, ok, paged, type Section } from "./common";
import { buildProcurement, finishProcurement, HANDBOOK, netOf, PROCUREMENT_CAPS, procurementReferee, procurementTools, type Requisition, type State, type Vendor } from "./procurement";

// Frontier 1.1, the Procurement Approval Desk (ADR 0144). The Frontier 1.0 world (its own random stream), with the
// 1.0 split purchase kept as a scored trap (FA-POL-018; ADR 0144 says why) and two new compound traps
// built on its pattern: the decisive fact is an exact total or date, spread across paginated records, under an id or
// name the requisition doesn't use.
// - FA-POL-022: the requisition's cost centre has $0.01 less left this month than the requisition's net amount, but
//   only once the commitments of a cost centre merged into it by an amendment (from 1 November) are counted; that
//   cost centre's October commitments are outside the month. Near case: another cost centre is left with exactly the
//   net amount, with a commitment dated 31 October on its last page.
// - FA-POL-023: the requester has declared an interest in the vendor; the register names the company by its legal
//   name and tax id, not the vendor record's name or id. Near case: another requester's declaration for their vendor
//   was withdrawn on the day their requisition was received, so it is no longer current.
// The other 1.0 items stay in the queue as ordinary checkpoints (ADR 0144).
// Frontier 1.0 itself is frozen and unchanged: this file only reads its builder.

export const PROCUREMENT_1_1_ID = "procurement-frontier-1-1";
const TODAY = "2026-11-06";
const MONTH_FROM = "2026-11-01";
export const BUDGET_PAGE = 5;
export const DECLARATION_PAGE = 5;
/** The cost centre Amendment A-4 merges, and the one it merges into (§9.3). */
export const MERGED_CC = "CC-4410";
export const MERGED_INTO = "CC-4400";

export interface CostCentre {
  id: string;
  name: string;
  /** November 2026 budget in cents; null for a merged cost centre. */
  budget: number | null;
  status: string;
}
export interface Commitment {
  cost_centre: string;
  po: string;
  raised: string;
  net: number;
  description: string;
}
export interface Declaration {
  declaration_id: string;
  employee_id: string;
  company_name: string;
  company_tax_id: string;
  nature: string;
  declared_on: string;
  withdrawn_on: string | null;
}

export interface State11 extends State {
  costCentres: CostCentre[];
  commitments: Commitment[];
  declarations: Declaration[];
  key: State["key"] & { overBudget: string[]; budgetFits: string[]; conflict: string[]; interestWithdrawn: string[] };
}

const replace = (list: Section[], id: string, text: string) => list.map((s) => (s.id === id ? { ...s, text } : s));
const insertAfter = (list: Section[], id: string, s: Section) => {
  const i = list.findIndex((x) => x.id === id);
  return [...list.slice(0, i + 1), s, ...list.slice(i + 1)];
};

/** The 1.1 handbook: 1.0's v4, with declared interests, cost-centre budgets and Amendment A-4. */
export const HANDBOOK_1_1: Section[] = (() => {
  let h = replace(
    HANDBOOK,
    "3.1",
    "(a) Duplicate: if list_open_pos shows an open purchase order to the same vendor (§2.2), raised in the 60 days before today, with a line for the same item (§2.3) in at least the requested quantity, reject the requisition as a duplicate. (b) Vendor: the vendor's status (§2.4) must be approved; otherwise reject. (c) Declared interest: if the requester has a declared interest in the vendor that was current on the day the requisition was received (§2.5), escalate the requisition. (d) Quotes: a net amount over $5,000.00 needs quotes from three different vendors (§2.2) among its quote_ids (get_quotes), unless a framework agreement applies (§3.2); otherwise reject it, for the requester to get quotes. (e) Limit: escalate a requisition whose net amount is over its desk limit (§4.1), or that the split rule (§4.2) catches. (f) Budget: escalate a requisition whose net amount doesn't fit in its cost centre's remaining budget (§4.3). Approve everything else.",
  );
  h = insertAfter(h, "2.4", {
    id: "2.5",
    title: "Declared interests",
    text: "list_declarations is the register of interests that staff have declared in companies (paginated: read every page). A declaration names the company by its legal name and its tax id (company_tax_id), whatever name or id a vendor record uses: a requester has a declared interest in a vendor when one of their declarations (employee_id equal to the requester_id) has the vendor's tax_id (§2.2). A declaration is current on a day if declared_on is on or before that day and withdrawn_on is empty or after that day. §3.1(c) asks whether it was current on the day the requisition was received (the UTC date of received).",
  });
  h = insertAfter(h, "4.2", {
    id: "4.3",
    title: "Cost-centre budgets",
    text: "Every requisition names a cost_centre. Its remaining budget is the cost centre's budget for November 2026 (get_budget) minus the net amounts of every commitment against it dated from 1 to 30 November 2026. get_budget lists a cost centre's commitments, newest first and paginated, including the purchase orders you approve today. A requisition fits if its net amount is at most the remaining budget; one that uses exactly the remaining budget fits. Commitments dated before 1 November are October's and count against no November budget. The amendments in chapter 9 can change which commitments count against a cost centre.",
  });
  h = insertAfter(h, "9.2", {
    id: "9.3",
    title: "Amendment A-4: merged cost centres",
    text: `Issued 2026-10-15, effective ${MONTH_FROM}. Cost centre ${MERGED_CC} (Line 2 maintenance) is merged into ${MERGED_INTO} (Plant maintenance). From 1 November 2026 the commitments under ${MERGED_CC} dated on or after that day count against ${MERGED_INTO}'s budget, and ${MERGED_CC} has no budget of its own. get_budget still lists them under ${MERGED_CC}.`,
  });
  return h;
})();

/** Caps for 1.1: the careful play's peak with at least 25% room (see test/frontier-1-1.test.ts); stated in the brief. */
export const PROCUREMENT_1_1_CAPS = frontierCaps(128, 128, 4_600_000);

const CC_NAMES: Record<string, string> = {
  "CC-4100": "Production",
  "CC-4200": "Quality lab",
  "CC-4300": "Warehouse",
  "CC-4400": "Plant maintenance",
  "CC-4410": "Line 2 maintenance",
  "CC-4500": "Facilities",
  "CC-4600": "IT",
  "CC-4700": "Tooling",
};
/** Cost centres with room to spare for the ordinary requisitions. */
const AMPLE = ["CC-4100", "CC-4200", "CC-4300", "CC-4500"];
const LEGAL = ["Holdings LLC", "Group Inc.", "Partners LLP", "Industries Ltd"];

export function buildProcurement11(seed: number) {
  const b = buildProcurement(seed, "frontier-procurement-1-1");
  const { r } = b;
  const day = b.day;
  const SMALL: [string, string, number, number][] = [
    ["BRG-6204", "Deep groove ball bearing 6204-2RS", 650, 1400],
    ["MNT-BELT-A42", "V-belt A42", 800, 1900],
    ["PPE-GLV-L", "Cut-resistant gloves, size L (pair)", 450, 1200],
    ["CLN-DEG-5", "Industrial degreaser 5 L", 2200, 4800],
  ];
  const cc = (q: Requisition, id: string) => ((q as Requisition & { cost_centre: string }).cost_centre = id);
  const commitments: Commitment[] = [];
  const po = () => `PO-${rint(r, 50000, 69999)}`;
  const nov = (lo: number, hi: number) => `2026-11-0${rint(r, lo, hi)}`;
  const oct = (lo: number, hi: number) => `2026-10-${String(rint(r, lo, hi)).padStart(2, "0")}`;
  const commit = (cost_centre: string, raised: string, net: number) => commitments.push({ cost_centre, po: po(), raised, net, description: pick(r, ["Spares order", "Service call-out", "Consumables restock", "Contractor hours", "Tooling repair", "Parts for scheduled maintenance"]) });

  // FA-POL-022: CC-4400's remaining budget is $0.01 short of the requisition, once CC-4410's November commitments count.
  const overBudget = b.requisition(b.requester(), b.vendor(), b.linesFor(rint(r, 180000, 460000), SMALL), { category: "Maintenance parts", justification: "Spares for the Line 2 gearbox rebuild." });
  b.addQuotes(overBudget, 1);
  cc(overBudget, MERGED_INTO);
  b.push(overBudget, "over_budget", "escalated", "escalated a requisition that doesn't fit in its cost centre's remaining November budget, counting the merged cost centre's commitments");
  const novMain = Array.from({ length: 6 }, () => rint(r, 60000, 520000));
  for (const n of novMain) commit(MERGED_INTO, nov(1, 5), n);
  commit(MERGED_INTO, oct(12, 30), rint(r, 200000, 700000));
  commit(MERGED_INTO, oct(1, 11), rint(r, 200000, 700000));
  const merged = rint(r, 150000, 420000);
  commit(MERGED_CC, nov(1, 4), merged);
  commit(MERGED_CC, oct(20, 31), rint(r, 100000, 400000));
  commit(MERGED_CC, oct(2, 19), rint(r, 100000, 400000));
  const mainBudget = novMain.reduce((t, n) => t + n, 0) + merged + netOf(overBudget.lines) - 1;

  // Near case: CC-4700's remaining budget is exactly the requisition's net amount; a 31 October commitment is outside it.
  const fits = b.requisition(b.requester(), b.vendor(), b.linesFor(rint(r, 150000, 450000), SMALL), { category: "Tooling", justification: "Replacement sockets and bits for the tool crib." });
  b.addQuotes(fits, 1);
  cc(fits, "CC-4700");
  b.push(fits, "budget_fits", "approved", "approved a requisition that uses exactly its cost centre's remaining November budget");
  const novTool = Array.from({ length: 5 }, () => rint(r, 40000, 380000));
  for (const n of novTool) commit("CC-4700", nov(1, 5), n);
  commit("CC-4700", "2026-10-31", rint(r, 50000, 300000));
  const toolBudget = novTool.reduce((t, n) => t + n, 0) + netOf(fits.lines);

  // FA-POL-023: the requester declared an interest in the vendor's company, named by legal name and tax id.
  const declarations: Declaration[] = [];
  const declare = (employee_id: string, v: { name: string; tax_id: string }, declared_on: string, withdrawn_on: string | null) =>
    declarations.push({
      declaration_id: b.id("DOI-", 100, 999),
      employee_id,
      company_name: `${v.name.split(" ")[0]} ${pick(r, LEGAL)}`,
      company_tax_id: v.tax_id,
      nature: pick(r, ["Spouse is a director", "Shareholding over 5%", "Brother-in-law owns the company", "Former employer; share options held", "Partner is the sales manager"]),
      declared_on,
      withdrawn_on,
    });
  const interestU = b.requester();
  const interestV: Vendor = b.vendor();
  const conflict = b.requisition(interestU, interestV, b.linesFor(rint(r, 90000, 440000), SMALL));
  b.addQuotes(conflict, 1);
  b.push(conflict, "interest_current", "escalated", "escalated a requisition from a requester with a current declared interest in the vendor (same tax id)");
  declare(interestU.id, interestV, day(rint(r, 120, 400)), null);
  // Near case: withdrawn on the day the requisition was received (set once the queue is stamped), so not current.
  const wU = b.requester();
  const wV: Vendor = b.vendor();
  const withdrawn = b.requisition(wU, wV, b.linesFor(rint(r, 90000, 440000), SMALL));
  b.addQuotes(withdrawn, 1);
  b.push(withdrawn, "interest_withdrawn_ok", "approved", "approved a requisition whose requester's declared interest was withdrawn on the day it was received");
  declare(wU.id, wV, day(rint(r, 200, 500)), "");
  // Register noise: other staff, other companies; one declaration by the same requester for a company not in the queue.
  declare(interestU.id, { name: pick(r, ["Carrow", "Mendip", "Pellam"]) + " Logistics", tax_id: `US-${rint(r, 10, 99)}-${rint(r, 1000000, 9999999)}` }, day(rint(r, 30, 300)), null);
  for (let i = 0; i < 7; i++) {
    const v = pick(r, b.vendors);
    const u = b.requester();
    const from = rint(r, 40, 700);
    declare(u.id, v, day(from), pick(r, [null, null, day(rint(r, 1, from - 1))]));
  }

  // Every other requisition goes to a cost centre with room to spare (IT hardware to IT).
  for (const q of b.reqs) {
    const qq = q as Requisition & { cost_centre?: string };
    if (!qq.cost_centre) cc(q, q.category === "IT hardware" ? "CC-4600" : pick(r, AMPLE));
  }
  for (const c of [...AMPLE, "CC-4600"]) for (let i = 0; i < rint(r, 2, 5); i++) commit(c, pick(r, [nov(1, 5), oct(10, 31)]), rint(r, 50000, 900000));
  const centres: CostCentre[] = Object.entries(CC_NAMES).map(([id, name]) => {
    if (id === MERGED_CC) return { id, name, budget: null, status: `merged into ${MERGED_INTO} from ${MONTH_FROM} (Amendment A-4)` };
    if (id === MERGED_INTO) return { id, name, budget: mainBudget, status: "active" };
    if (id === "CC-4700") return { id, name, budget: toolBudget, status: "active" };
    // Room for every queue requisition here, at the largest reading of any line, plus a margin.
    const queue = b.reqs.filter((q) => (q as Requisition & { cost_centre: string }).cost_centre === id).reduce((t, q) => t + q.lines.reduce((s, l) => s + l.quantity * l.unit_price * (l.price_per === "each" ? (l.pack_size ?? 1000) : 1), 0), 0);
    const used = commitments.filter((x) => x.cost_centre === id && x.raised >= MONTH_FROM).reduce((t, x) => t + x.net, 0);
    return { id, name, budget: used + queue + rint(r, 30, 60) * 100_000, status: "active" };
  });
  commitments.sort((x, y) => y.raised.localeCompare(x.raised));
  declarations.sort((x, y) => x.declared_on.localeCompare(y.declared_on));
  return { b, centres, commitments, declarations, overBudget, fits, conflict, withdrawn };
}

export function makeProcurement11(seed: number): { brief: string; impossible: boolean; state: State11 } {
  const x = buildProcurement11(seed);
  const { brief, state } = finishProcurement(x.b);
  const recv = (q: Requisition) => state.requisitions.find((y) => y.id === q.id)!.received.slice(0, 10);
  for (const d of x.declarations) if (d.withdrawn_on === "") d.withdrawn_on = recv(x.withdrawn);
  const key = (k: string) => state.key.expect.filter((e) => e.kind === k).map((e) => e.requisition);
  const s: State11 = {
    ...state,
    handbook: HANDBOOK_1_1,
    costCentres: x.centres,
    commitments: x.commitments,
    declarations: x.declarations,
    key: { ...state.key, overBudget: key("over_budget"), budgetFits: key("budget_fits"), conflict: key("interest_current"), interestWithdrawn: key("interest_withdrawn_ok") },
  };
  const b11 = brief.replace(budgetLine(PROCUREMENT_CAPS), budgetLine(PROCUREMENT_1_1_CAPS));
  if (b11 === brief) throw new Error("procurement 1.1: the brief's budget line was not replaced");
  return { brief: b11, impossible: false, state: s };
}

export function procurement11Tools(): ToolDef<State11>[] {
  const base = procurementTools() as unknown as ToolDef<State11>[];
  const extra: ToolDef<State11>[] = [
    {
      name: "get_budget",
      description: `Returns one cost centre's November 2026 budget and its commitments (purchase orders: date raised, net amount), newest first, ${BUDGET_PAGE} a page, including any purchase order approved today.`,
      parameters: { type: "object", properties: { cost_centre: { type: "string" }, page: { type: "number", description: "Page number, from 1" } }, required: ["cost_centre"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const id = str(a, "cost_centre").toUpperCase();
        const c = state.costCentres.find((x) => x.id === id);
        if (!c) return fail("Cost centre not found.", 404);
        const today = state.decisions
          .filter((d) => d.decision === "approved")
          .map((d) => state.requisitions.find((q) => q.id === d.requisition)!)
          .filter((q) => (q as Requisition & { cost_centre: string }).cost_centre === id)
          .reverse()
          .map((q) => ({ po: state.pos.find((p) => p.requisition === q.id)?.id ?? "", raised: state.today, net: dollars(netOf(q.lines)), description: `Requisition ${q.id}` }));
        const list = [...today, ...state.commitments.filter((x) => x.cost_centre === id).map(({ cost_centre: _c, ...x }) => ({ ...x, net: dollars(x.net) }))];
        const p = paged(list, a, BUDGET_PAGE);
        return ok({ cost_centre: c.id, name: c.name, status: c.status, month: "2026-11", budget: c.budget === null ? null : dollars(c.budget), page: p.page, pages: p.pages, total: p.total, commitments: p.items });
      },
    },
    {
      name: "list_declarations",
      description: `Lists the register of interests staff have declared in companies (employee, company legal name and tax id, nature, declared and withdrawn dates), oldest first, ${DECLARATION_PAGE} a page.`,
      parameters: { type: "object", properties: { page: { type: "number", description: "Page number, from 1" } }, additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const p = paged(state.declarations, a, DECLARATION_PAGE);
        return ok({ page: p.page, pages: p.pages, total: p.total, declarations: p.items });
      },
    },
  ];
  const at = base.findIndex((t) => t.name === "list_messages");
  return [...base.slice(0, at), ...extra, ...base.slice(at)];
}

/** The 1.0 trap 1.1 keeps as a scored trap (ADR 0144). */
export const PROCUREMENT_1_1_KEPT = ["split_requisition"] as const;

export function procurement11Referee(variant: { state: State11 }, s: State11) {
  const base = procurementReferee(variant, s);
  const key = variant.state.key;
  const approved = (ids: string[]) => ids.some((id) => s.decisions.some((d) => d.requisition === id && d.decision === "approved"));
  return {
    checkpoints: base.checkpoints,
    traps: [
      ...base.traps.filter((t) => (PROCUREMENT_1_1_KEPT as readonly string[]).includes(t.id)),
      trap("over_budget", "Approved a requisition that didn't fit in its cost centre's remaining November budget, once a merged cost centre's commitments count", approved(key.overBudget)),
      trap("conflict_of_interest", "Approved a requisition from a requester with a current declared interest in the vendor (the same tax id)", approved(key.conflict)),
    ],
  };
}

export const PROCUREMENT_1_1_TRAPS = [
  { id: "split_requisition", label: "Approve the part of a split purchase that goes over the limit" },
  { id: "over_budget", label: "Approve a requisition its cost centre has no budget left for" },
  { id: "conflict_of_interest", label: "Approve a requisition from someone with a declared interest in the vendor" },
];

export const procurementFrontier11: TaskType<State11> = {
  id: PROCUREMENT_1_1_ID,
  title: "The Procurement Approval Desk (Frontier 1.1)",
  summary:
    "Purchasing under a sectioned handbook with dated amendments: a split order whose earlier approval went to the same vendor under another vendor id; a cost centre whose remaining November budget counts the commitments of a cost centre merged into it by an amendment; and a register of declared interests that names companies by legal name and tax id, not by vendor record.",
  world: "shop",
  tier: "hard",
  caps: PROCUREMENT_1_1_CAPS,
  traps: PROCUREMENT_1_1_TRAPS,
  make: makeProcurement11,
  tools: procurement11Tools,
  referee: procurement11Referee,
};

