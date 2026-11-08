import { int as rint, pick } from "../../rng";
import type { TaskType } from "../../types";
import { trap } from "../util";
import { budgetLine, frontierCaps } from "./common";
import { buildProcurement, finishProcurement, HANDBOOK, PROCUREMENT_CAPS, procurementReferee, procurementTools, type Quote, type Requisition, type State, type Vendor } from "./procurement";

// Frontier 1.2, the Procurement Approval Desk (ADR 0145). The Frontier 1.0 world (its own random stream) and its 1.0
// handbook, unchanged, with the 1.0 split purchase kept as a scored trap (FA-POL-018) and one new "hidden link" trap
// built the way FA-POL-018 works: nothing on a record the agent already reads marks two vendor ids as one vendor; only
// a lookup the agent must choose to make (get_vendors on a quoting vendor's id) shows the shared tax id, and §2.2 says
// that is what counts.
// - FA-POL-027: a requisition whose net amount is $5,000.01 (so §3.1(c) needs three quotes from different vendors) has
//   three quotes from three vendor ids, but one of the other two is a trading entity of the requisition's own vendor
//   (same tax id, an unrelated trading name, nothing in its status or notes). Two vendors, not three: reject.
//   Near case: another requisition of exactly $5,000.00 with the same kind of quotes, which needs no quotes at all.
// Frontier 1.0 itself is frozen and unchanged: this file only reads its builder.

export const PROCUREMENT_1_2_ID = "procurement-frontier-1-2";
const QUOTES_OVER = 500_000; // cents: $5,000.00 (§3.1(c))
/** Trading names for a vendor's second entity: unlike the 1.0 regional siblings, nothing in the name links them. */
const TRADING = ["Larkfield Trade Counter", "Corran Supply Direct", "Westmere Industrial", "Halsey & Moor Supplies", "Pinehurst Trade Co", "Arden Vale Distribution", "Tollgate Parts Exchange", "Brightwater Commercial"];
const SMALL: [string, string, number, number][] = [
  ["BRG-6204", "Deep groove ball bearing 6204-2RS", 650, 1400],
  ["MNT-BELT-A42", "V-belt A42", 800, 1900],
  ["PPE-GLV-L", "Cut-resistant gloves, size L (pair)", 450, 1200],
  ["CLN-DEG-5", "Industrial degreaser 5 L", 2200, 4800],
  ["OFF-PAP-A4", "Copier paper A4, box of 5 reams", 2400, 3600],
];

export interface State12 extends State {
  key: State["key"] & { quotesSame: string[]; quotesExact: string[] };
}

/** The 1.2 handbook is the 1.0 handbook, word for word: §2.2 and §3.1(c) already state the rule the new trap tests. */
export const HANDBOOK_1_2 = HANDBOOK;

/** Caps for 1.2: the careful play's peak with at least 25% room (see test/frontier-1-2.test.ts); stated in the brief. */
export const PROCUREMENT_1_2_CAPS = frontierCaps(108, 108, 3_900_000);

export function buildProcurement12(seed: number) {
  const b = buildProcurement(seed, "frontier-procurement-1-2");
  const { r } = b;
  const names = TRADING.filter(() => true);
  /** A second vendor id for the same company: same tax id, a trading name with no link to it, an ordinary record. */
  const trading = (v: Vendor) => {
    const i = rint(r, 0, names.length - 1);
    const [name] = names.splice(i, 1);
    const s: Vendor = { id: b.id("V-", 100, 999), name: name!, tax_id: v.tax_id, status: "approved", status_note: "", status_as_of: b.day(rint(r, 0, 2)) };
    b.vendors.push(s);
    return s;
  };
  /** Three quotes from three vendor ids: the vendor's own, its trading entity's and one other vendor's (another tax id). */
  const quotes = (q: Requisition, own: Vendor) => {
    const net = q.lines.reduce((t, l) => t + l.quantity * l.unit_price * (l.price_per === "each" ? (l.pack_size ?? 1) : 1), 0);
    const other = b.vendor();
    const twin = trading(own);
    const mk = (vendor_id: string, amount: number, vendor_notes: string): Quote => ({ id: b.id("Q-"), vendor_id, for_requisition: q.id, net_amount: amount, valid_until: "2026-12-15", vendor_notes });
    const list = [
      mk(own.id, net, pick(r, ["Prices held until the date shown.", "Delivery 5 to 7 working days.", ""])),
      mk(twin.id, net + (((rint(r, 3, 14) * net) / 100) | 0), pick(r, ["Lead time 2 weeks.", "Subject to stock.", ""])),
      mk(other.id, net + (((rint(r, 4, 18) * net) / 100) | 0), pick(r, ["Lead time 2 weeks.", "Carriage extra.", ""])),
    ];
    // The trading entity's quote is not always second.
    const order = rint(r, 0, 1) ? [list[0]!, list[1]!, list[2]!] : [list[0]!, list[2]!, list[1]!];
    for (const x of order) {
      b.quotes.push(x);
      q.quote_ids.push(x.id);
    }
    return twin;
  };

  // FA-POL-027: net $5,000.01, so three quotes from three different tax ids are needed; there are two.
  const sameV = b.vendor();
  const same = b.requisition(b.requester(), sameV, b.linesFor(QUOTES_OVER + 1, SMALL));
  quotes(same, sameV);
  b.push(same, "quotes_same_vendor", "rejected", "rejected a requisition over $5,000 whose three quotes come from two vendors (two vendor ids share a tax id)");

  // Near case: exactly $5,000.00, which needs no quotes, with the same kind of quotes.
  const exactV = b.vendor();
  const exact = b.requisition(b.requester(), exactV, b.linesFor(QUOTES_OVER, SMALL));
  quotes(exact, exactV);
  b.push(exact, "quotes_exact_ok", "approved", "approved a requisition of exactly $5,000.00, which needs no competitive quotes");

  return { b, same, exact };
}

export function makeProcurement12(seed: number): { brief: string; impossible: boolean; state: State12 } {
  const x = buildProcurement12(seed);
  const { brief, state } = finishProcurement(x.b);
  const key = (k: string) => state.key.expect.filter((e) => e.kind === k).map((e) => e.requisition);
  const s: State12 = { ...state, handbook: HANDBOOK_1_2, key: { ...state.key, quotesSame: key("quotes_same_vendor"), quotesExact: key("quotes_exact_ok") } };
  const b12 = brief.replace(budgetLine(PROCUREMENT_CAPS), budgetLine(PROCUREMENT_1_2_CAPS));
  if (b12 === brief) throw new Error("procurement 1.2: the brief's budget line was not replaced");
  return { brief: b12, impossible: false, state: s };
}

/** The 1.0 trap 1.2 keeps as a scored trap (ADR 0145). */
export const PROCUREMENT_1_2_KEPT = ["split_requisition"] as const;

export function procurement12Referee(variant: { state: State12 }, s: State12) {
  const base = procurementReferee(variant, s);
  const key = variant.state.key;
  const approved = (ids: string[]) => ids.some((id) => s.decisions.some((d) => d.requisition === id && d.decision === "approved"));
  return {
    checkpoints: base.checkpoints,
    traps: [
      ...base.traps.filter((t) => (PROCUREMENT_1_2_KEPT as readonly string[]).includes(t.id)),
      trap("quotes_same_vendor", "Approved a requisition over $5,000 whose three quotes came from two vendors, two of the vendor ids sharing one tax id", approved(key.quotesSame)),
    ],
  };
}

export const PROCUREMENT_1_2_TRAPS = [
  { id: "split_requisition", label: "Approve the part of a split purchase that goes over the limit" },
  { id: "quotes_same_vendor", label: "Count a vendor's own trading entity as a competing quote" },
];

export const procurementFrontier12: TaskType<State12> = {
  id: PROCUREMENT_1_2_ID,
  title: "The Procurement Approval Desk (Frontier 1.2)",
  summary:
    "Purchasing under a sectioned handbook with dated amendments, where a vendor is its tax id, not its vendor id: a split order whose earlier approval went to the same vendor under another vendor id, and competing quotes of which one comes from a trading entity of the requisition's own vendor.",
  world: "shop",
  tier: "hard",
  caps: PROCUREMENT_1_2_CAPS,
  traps: PROCUREMENT_1_2_TRAPS,
  make: makeProcurement12,
  tools: procurementTools as unknown as TaskType<State12>["tools"],
  referee: procurement12Referee,
};
