import type { Attempt } from "../../src";

// The careful play of the Hard v3 flaky supplier (test/hard3-flaky-supplier.test.ts), shared with Hard v3.2's tests
// (test/hard3-2.test.ts). It plays only from tool outputs (never the hidden key) and counts its own turns and tokens
// like a model that batches the calls it can; each option is the same play with one tempting wrong move.

const json = (r: { content: string }) => JSON.parse(r.content);
const chunks = <X>(xs: X[], n = 5) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const SUPS = ["Ridgeway Wholesale", "Quayline Packaging", "Northbrook Foods", "Dunmore Dairy"] as const;
const [RW, QL, NB, DD] = SUPS;

/** Plays turns of tool calls and estimates tokens the way the harness counts them: the whole context goes in each turn. */
export class Player {
  private ctx: number;
  constructor(readonly a: Attempt<any>) {
    this.ctx = 600 + a.variant.brief.length + JSON.stringify(a.toolSpecs()).length;
  }
  turn(calls: [string, Record<string, unknown>][]): { ok: boolean; content: string }[] {
    const args = JSON.stringify(calls).length;
    this.a.recordTurn({ tokensIn: Math.ceil(this.ctx / 4), tokensOut: 300 + Math.ceil(args / 4), cost: 0, latencyMs: 1000 });
    const outs = calls.map(([name, a]) => this.a.call(name, a));
    this.ctx += 1200 + args + outs.reduce((t, o) => t + o.content.length, 0);
    return outs;
  }
  one(name: string, args: Record<string, unknown>) {
    return this.turn([[name, args]])[0]!;
  }
}

type Line = { sku: string; packs: number };
export type Opts = {
  /** Hard v3.2: takes "accepted" for done, never checking that each order was allocated (the old play). */
  trustAccepted?: boolean;
  useKey?: boolean;
  sameKey?: boolean;
  blindRetry?: boolean;
  skipPartial?: "all" | "cover";
  ignoreInbound?: boolean;
  countCancelled?: boolean;
  decoy?: boolean;
  orderBackordered?: boolean;
  staleQuoteTotal?: boolean;
  staleTotals?: boolean;
  /** Fold all of a supplier's lines into one order (ignoring the line limit, so the supplier refuses it). */
  report?: (orders: { reference: string; supplier: string; order_total: number }[]) => string;
  finish?: { status: "done" | "cannot_complete"; summary: string };
};

export function oracle(a: Attempt<any>, o: Opts = {}) {
  const P = new Player(a);
  const manager = /"([a-z]+)"/.exec(a.variant.brief)![1]!;
  const maxLines = Number(/limited to (\d+) lines/.exec(a.variant.brief)![1]);
  const [list, ...noteOuts] = P.turn([["list_restock_items", {}], ...SUPS.map((s) => ["get_purchasing_notes", { supplier: s }] as [string, Record<string, unknown>])]).map(json);
  const items: { sku: string; supplier: string }[] = list.items;
  const notes = noteOuts as { supplier: string; approved_substitutes: { for_sku: string; use_sku: string; from_supplier: string; units_per_unit_short: number }[] }[];
  const details = P.turn(chunks(items.map((i) => i.sku)).map((skus) => ["get_item_details", { skus }])).flatMap(json);
  const subs = notes.flatMap((n) => n.approved_substitutes);
  const want: Record<string, string[]> = {};
  for (const i of items) (want[i.supplier] ??= []).push(i.sku);
  for (const s of subs) (want[s.from_supplier] ??= []).push(s.use_sku);
  const supItems = P.turn(Object.entries(want).flatMap(([supplier, skus]) => chunks(skus).map((c) => ["get_supplier_items", { supplier, skus: c }] as [string, Record<string, unknown>]))).flatMap(json);
  const info = (sku: string) => supItems.find((x: any) => x.sku === sku)!;
  const packs = (units: number, sku: string) => Math.max(info(sku).min_order_packs, Math.ceil(units / info(sku).units_per_pack));
  const need: Record<string, number> = {};
  const lines: Record<string, Line[]> = Object.fromEntries(SUPS.map((s) => [s, []]));
  for (const d of details) {
    const inbound = d.inbound.filter((x: any) => o.countCancelled || x.status === "confirmed").reduce((t: number, x: any) => t + x.units, 0);
    need[d.sku] = d.target - d.on_hand - (o.ignoreInbound ? 0 : inbound);
    if (need[d.sku]! <= 0) continue;
    const it = info(d.sku);
    if (it.availability.startsWith("backordered") && !o.orderBackordered) {
      if (o.decoy) {
        lines[d.supplier]!.push({ sku: it.supplier_suggested_substitute, packs: packs(need[d.sku]!, d.sku) });
        continue;
      }
      const s = subs.find((x) => x.for_sku === d.sku)!;
      lines[s.from_supplier]!.push({ sku: s.use_sku, packs: packs(need[d.sku]! * s.units_per_unit_short, s.use_sku) });
    } else lines[d.supplier]!.push({ sku: d.sku, packs: packs(need[d.sku]!, d.sku) });
  }

  const refs: string[] = [];
  /** Totals as first seen (before any backorder was cancelled), and Quayline's first quote per order. */
  const stale: Record<string, number> = {};
  const staleQ: Record<string, number> = {};
  /** Places an order; after any error, finds out whether it went through before trying again. */
  const place = (supplier: string, ls: Line[], key: string | null) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = P.one("place_order", { supplier, lines: ls, ...(key ? { idempotency_key: key } : {}) });
      if (r.ok) return json(r).reference as string;
      if (o.blindRetry) continue;
      if (key) {
        const st = P.one("get_order_details", { supplier, idempotency_key: key });
        if (st.ok) return json(st).reference as string;
        continue;
      }
      for (let i = 0; i < 5; i++) {
        const l = json(P.one("list_orders", { supplier }));
        const mine = l.orders.find((x: any) => !refs.includes(x.reference) && x.status !== "cancelled" && x.status !== "rejected");
        if (mine) return mine.reference as string;
        if (l.index_status === "current") break;
      }
    }
    throw new Error("could not place");
  };
  /** Places a supplier's lines in orders of at most maxLines, then handles part-filled lines. */
  const placeAll = (supplier: string, keyed: boolean) => {
    const mine: string[] = [];
    for (const [n, ls] of chunks(lines[supplier]!, maxLines).entries()) {
      const ref = place(supplier, ls, keyed ? (o.sameKey ? "harbourside-rw" : `harbourside-rw-${n + 1}`) : null);
      if (!refs.includes(ref)) refs.push(ref);
      mine.push(ref);
    }
    if (!mine.length) return;
    const got = json(P.one("get_order_details", { references: [...new Set(mine)] })).orders;
    for (const x of got) stale[x.reference] = x.order_total;
    const part = got.flatMap((x: any) => x.lines.filter((l: any) => l.fulfilment.backordered_packs > 0 && (!o.orderBackordered || l.fulfilment.allocated_packs > 0)).map((l: any) => ({ ref: x.reference, l })));
    if (o.skipPartial === "all" || !part.length) return;
    P.turn(part.map(({ ref, l }: any) => ["cancel_backorder", { reference: ref, sku: l.sku }]));
    if (o.skipPartial === "cover") return;
    for (const { l } of part) {
      const short = need[l.sku]! - l.fulfilment.allocated_packs * info(l.sku).units_per_pack;
      const s = subs.find((x) => x.for_sku === l.sku)!;
      lines[s.from_supplier]!.push({ sku: s.use_sku, packs: packs(short * s.units_per_unit_short, s.use_sku) });
    }
  };

  // Ridgeway and Dunmore first: their part-filled lines decide what else Northbrook must supply.
  placeAll(RW, o.useKey !== false);
  placeAll(DD, false);
  placeAll(NB, false);

  // Quayline: a fresh quote for every attempt; a 503 creates nothing (its list is always current).
  const placeQL = (ls: Line[]) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const q = json(P.one("request_quote", { supplier: QL, lines: ls }));
      if (attempt === 0) staleQ.first = q.total;
      const r = P.one("place_order", { supplier: QL, lines: ls, quote_id: q.quote_id });
      if (r.ok) {
        refs.push(json(r).reference);
        if (attempt > 0) staleQ[json(r).reference] = staleQ.first!;
        break;
      }
      const l = json(P.one("list_orders", { supplier: QL })).orders.find((x: any) => !refs.includes(x.reference) && x.status !== "cancelled" && x.status !== "rejected");
      if (l) {
        refs.push(l.reference);
        break;
      }
    }
  };
  for (const ls of chunks(lines[QL]!, maxLines)) placeQL(ls);

  const read = () => P.turn(chunks(refs).map((references) => ["get_order_details", { references }])).flatMap((x) => json(x).orders);
  let got = read();
  // Hard v3.2: an accepted order isn't a placed one until the supplier has allocated it. Wait out "awaiting
  // allocation", and re-order the lines of any order the supplier rejected after accepting it. (On Hard v3.1 the
  // first read already shows every order allocated, so this adds no calls there.)
  const redone = new Set<string>();
  for (let round = 0; !o.trustAccepted && round < 6; round++) {
    const rejected = got.filter((x: any) => x.status === "rejected" && !redone.has(x.reference));
    const waiting = got.find((x: any) => x.lines.some((l: any) => l.fulfilment.status === "awaiting allocation"));
    if (!rejected.length && !waiting) break;
    for (const x of rejected) {
      redone.add(x.reference);
      const ls: Line[] = x.lines.map((l: any) => ({ sku: l.sku, packs: l.packs_ordered }));
      if (x.supplier === QL) placeQL(ls);
      else {
        const ref = place(x.supplier, ls, null);
        if (!refs.includes(ref)) refs.push(ref);
      }
    }
    if (!rejected.length) P.one("list_orders", { supplier: waiting.supplier });
    got = read();
  }

  const orders = got.filter((x: any) => o.trustAccepted || x.status !== "rejected").map((x: any) => ({
    ...x,
    order_total: o.staleTotals && stale[x.reference] !== undefined ? stale[x.reference]! : o.staleQuoteTotal && staleQ[x.reference] !== undefined ? staleQ[x.reference]! : x.order_total,
  }));
  const text = o.report ? o.report(orders) : `Restock done. Live orders: ${orders.map((x: any) => `${x.supplier} ${x.reference} total $${x.order_total.toFixed(2)}`).join("; ")}.`;
  P.turn([["send_message", { to: manager, text }]]);
  P.turn([["finish", o.finish ?? { status: "done", summary: `Placed ${refs.length} supplier orders: ${refs.join(", ")}.` }]]);
  return { refs, P };
}
