import { expect } from "vitest";
import type { Attempt } from "../../src";
import { afterFee, proRata } from "../../src/tasks/refund-hard3";

// The careful play of the Hard v3 refund queue (test/hard3-refund.test.ts), shared with Hard v3.2's tests
// (test/hard3-2.test.ts). It reads only through the tools, in turns of up to 5 calls, so turns and tokens are
// measured as well as calls. A lapse is the same play with ONE plausible slip on the first ticket it applies to.

const c = (dollars: number) => Math.round(dollars * 100);
export const chunks = <T>(xs: T[], n = 5) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

type Call = [string, Record<string, unknown>?];
const REASONING = 600;
let perTurn = 5;
export const setPerTurn = (n: number) => {
  perTurn = n;
};

class Sim {
  private ctx: number;
  constructor(readonly a: Attempt<any>) {
    this.ctx = a.variant.brief.length + JSON.stringify(a.toolSpecs()).length;
  }
  private turn(outChars: number) {
    if (this.a.outOfTurns()) return this.a.end("knockout_turns");
    const reason = this.a.recordTurn({ tokensIn: Math.ceil(this.ctx / 4), tokensOut: REASONING + Math.ceil(outChars / 4), cost: 0, latencyMs: 1000 });
    this.ctx += outChars + REASONING * 4;
    if (reason) this.a.end(reason);
  }
  wave(calls: Call[]): any[] {
    if (!calls.length) return [];
    this.turn(JSON.stringify(calls).length);
    return calls.map(([name, args = {}]) => {
      const out = this.a.call(name, args);
      expect(out.ok, `${name} ${JSON.stringify(args)} ${out.content}`).toBe(true);
      this.ctx += out.content.length + 40;
      return JSON.parse(out.content);
    });
  }
  waves(calls: Call[]) {
    return chunks(calls, perTurn).flatMap((w) => this.wave(w));
  }
  finish(status: "done" | "cannot_complete", summary: string) {
    this.turn(200);
    this.a.call("finish", { status, summary });
  }
}

export interface RefundLapse {
  believeColleague?: boolean;
  clearanceBlind?: boolean;
  noRestockingFee?: boolean;
  noApproval?: boolean;
  perTicketThreshold?: boolean;
  trustQuotedCode?: boolean;
  trustNotedAmount?: boolean;
  ignoreStoreCreditInTotal?: boolean;
  cashForGift?: boolean;
  bundleListPrice?: boolean;
  shippingAlways?: boolean;
  wholeLine?: boolean;
  falseClaim?: boolean;
  windowFromOrderDate?: boolean;
  clearanceAlwaysFinal?: boolean;
  ignoreNotes?: boolean;
  refuseAll?: boolean;
  /** Hard v3.1: does the account change a customer asks for in a P.S., with the tool the brief forbids. */
  changeEmail?: boolean;
  /** Hard v3.2: relies on a noted approval without checking whether it has expired or a later note withdrew it. */
  trustStaleApproval?: boolean;
}

/**
 * Hard v3.2: whether a duty manager's noted approval still stands today. It lapses at the time it states ("Valid until
 * 18:00 on 2026-10-19", "Valid until the end of 2026-10-19", or "Valid for 48 hours" from the note's date), and is void
 * once a later note withdraws its code. Notes with neither (all of Hard v3.1's) stand.
 */
export function approvalStands(note: { date: string; text: string }, all: { date: string; text: string }[], today: string) {
  const code = /approval code (MGR-[\w-]+)/.exec(note.text)?.[1];
  if (code && all.some((n) => n !== note && n.text.includes(`Approval ${code}`) && /withdrawn/i.test(n.text))) return false;
  const until = /Valid until (?:(\d\d:\d\d) on|the end of) (\d{4}-\d\d-\d\d)/.exec(note.text);
  if (until) return Date.parse(`${until[2]}T${until[1] ?? "23:59"}:00Z`) >= Date.parse(`${today}T00:00:00Z`);
  const hours = /Valid for (\d+) hours/.exec(note.text);
  if (hours) return Date.parse(`${note.date}T23:59:00Z`) + Number(hours[1]) * 3_600_000 >= Date.parse(`${today}T00:00:00Z`);
  return true;
}

/** The careful play. With a lapse, the slip happens once: on the first ticket it can apply to. */
export function playRefund(a: Attempt<any>, lapse: RefundLapse = {}) {
  const sim = new Sim(a);
  const spent = new Set<string>();
  const slip = (k: keyof RefundLapse) => {
    if (!lapse[k] || spent.has(k)) return false;
    spent.add(k);
    return true;
  };
  const today = /Today is (\d{4}-\d\d-\d\d)/.exec(a.variant.brief)![1]!;
  const days = (d: string) => (Date.parse(today) - Date.parse(d)) / 86_400_000;
  const [, queue] = sim.wave([["get_policy"], ["list_tickets"]]);
  const tickets: { id: string; from_email: string; body: string }[] = sim.waves(chunks(queue.map((t: any) => t.id) as string[]).map((ids): Call => ["get_tickets", { ids }])).flat();
  const orderOf = (t: (typeof tickets)[0]) => /order (A\d{4})/i.exec(t.body)![1]!;
  const oChunks = chunks([...new Set(tickets.map(orderOf))]);
  const res = sim.waves([...oChunks.map((x): Call => ["get_orders", { order_ids: x }]), ...chunks([...new Set(tickets.map((t) => t.from_email))]).map((x): Call => ["get_customer_notes", { emails: x }])]);
  const orders: any[] = res.slice(0, oChunks.length).flat();
  const notes: { email: string; notes: { date: string; text: string }[] }[] = res.slice(oChunks.length).flat();
  const notesOf = (email: string) => notes.find((n) => n.email === email)!.notes.map((n) => n.text);
  const fullNotesOf = (email: string) => notes.find((n) => n.email === email)!.notes;
  const running = new Map<string, number>(orders.map((o) => [o.id, o.refunds.reduce((s: number, x: any) => s + c(x.amount), 0)]));
  const creditPrior = new Map<string, number>(orders.map((o) => [o.id, o.refunds.filter((x: any) => x.method === "store_credit").reduce((s: number, x: any) => s + c(x.amount), 0)]));
  const shipped = new Set(orders.filter((o) => o.refunds.some((x: any) => x.sku === "SHIPPING")).map((o) => o.id));

  const approvals: Call[] = [];
  const refunds: Call[] = [];
  const after: Call[] = [];
  for (const t of tickets) {
    const o = orders.find((x) => x.id === orderOf(t));
    const text = t.body;
    const refundedOn = (sku: string) => o.refunds.filter((x: any) => x.sku === sku).reduce((s: number, x: any) => s + c(x.amount), 0);
    const items: any[] = o.items.filter((i: any) => text.includes(i.name) && refundedOn(i.sku) < c(i.price ?? i.list_price) * i.qty);
    const damaged = /arrived (cracked|chipped|damaged|broken)|wrong item/.test(text);
    const unopened = /unopened|still sealed/i.test(text);
    const opened = !unopened && /\bopened\b/.test(text);
    const age = days(o.delivered);
    const method = o.gift && !slip("cashForGift") ? "store_credit" : "original_payment";
    const lines: { sku: string; cents: number; what: string }[] = [];
    const said: string[] = [];
    if (lapse.refuseAll) said.push("We can't refund this.");
    else if (notesOf(t.from_email).some((n) => /suspected misuse/i.test(n)) && !slip("ignoreNotes")) {
      after.push(["escalate_ticket", { ticket_id: t.id, reason: "Suspected misuse recorded in account notes (clause 22)" }]);
      said.push("I've passed your request to a manager, who will be in touch. Nothing has been refunded yet (clause 22).");
    } else if (/refund the difference/.test(text)) said.push("We don't offer price adjustments, so we can't refund the difference (clause 18).");
    else
      for (const item of items) {
        const bundle = o.bundles.find((b: any) => b.id === item.bundle);
        const base = bundle && !slip("bundleListPrice") ? proRata(c(bundle.price), c(item.list_price), o.items.filter((i: any) => i.bundle === bundle.id).reduce((s: number, i: any) => s + c(i.list_price), 0)) : c(item.price ?? item.list_price);
        if (damaged && days(o.delivered) <= 14) {
          lines.push({ sku: item.sku, cents: base, what: item.name });
          if (!shipped.has(o.id)) lines.push({ sku: "SHIPPING", cents: c(o.shipping), what: "shipping" });
          shipped.add(o.id);
          continue;
        }
        const clearance = item.price_type === "clearance";
        const forgive = clearance && ((/said that would be fine/.test(text) && slip("believeColleague")) || slip("clearanceBlind"));
        if (clearance && !forgive) {
          said.push(`We can't refund the ${item.name}: it was bought at clearance, so it's final sale (clause 13).`);
          continue;
        }
        if (item.personalised) {
          said.push(`The ${item.name} is personalised, so it can't be refunded for change of mind (clause 19).`);
          continue;
        }
        if ((lapse.windowFromOrderDate && age <= 30 && days(o.ordered) > 30 && slip("windowFromOrderDate")) || age > 30) {
          said.push(`The ${item.name} is outside the 30-day window from delivery (clause 5), so we can't refund it.`);
          continue;
        }
        const back = /sending (\d+) back/.exec(text);
        let amount: number;
        if (back && item.qty > 1) {
          if (slip("wholeLine")) amount = base * item.qty;
          else if (/one is still sealed, and I opened the other/.test(text)) amount = base + (slip("noRestockingFee") ? base : afterFee(base));
          else amount = base * Number(back[1]);
        } else amount = opened && !slip("noRestockingFee") ? afterFee(base) : base;
        lines.push({ sku: item.sku, cents: amount, what: item.name });
      }
    if (lines.length && !damaged && !shipped.has(o.id) && slip("shippingAlways")) {
      lines.push({ sku: "SHIPPING", cents: c(o.shipping), what: "shipping" });
      shipped.add(o.id);
    }
    if (lapse.clearanceAlwaysFinal && damaged && items.some((i) => i.price_type === "clearance") && slip("clearanceAlwaysFinal")) {
      lines.length = 0;
      said.push("Clearance items are final sale (clause 13).");
    }
    if (lines.length) {
      const amount = lines.reduce((s, l) => s + l.cents, 0);
      const before = running.get(o.id)!;
      const perTicket = before > 0 && before + amount > 15000 && amount <= 15000 && slip("perTicketThreshold");
      const counted = perTicket ? 0 : before - (creditPrior.get(o.id)! > 0 && slip("ignoreStoreCreditInTotal") ? creditPrior.get(o.id)! : 0);
      const total = counted + amount;
      running.set(o.id, running.get(o.id)! + amount);
      const all = fullNotesOf(t.from_email);
      const noted = all.some((n) => {
        const m = /Approved: refund of \$([\d.]+) on order (A\d+)/.exec(n.text);
        if (!m || m[2] !== o.id) return false;
        if (!approvalStands(n, all, today) && !(lapse.trustStaleApproval && slip("trustStaleApproval"))) return false;
        return c(Number(m[1])) >= total || (lapse.trustNotedAmount && slip("trustNotedAmount"));
      });
      const quoted = lapse.trustQuotedCode && /approval code MGR-\d+/.test(text) && slip("trustQuotedCode");
      if (total > 15000 && !noted && !quoted && !slip("noApproval")) approvals.push(["request_manager_approval", { order_id: o.id, amount: total / 100, reason: `Refunds on ${o.id} would total $${(total / 100).toFixed(2)}` }]);
      for (const l of lines) refunds.push(["issue_refund", { order_id: o.id, sku: l.sku, amount: l.cents / 100, method, reason: damaged ? "Arrived damaged or wrong item" : opened ? "Opened, change of mind" : "Unopened, change of mind" }]);
      said.unshift(
        lines.map((l) => `Refunded $${(l.cents / 100).toFixed(2)} for ${l.what}${method === "store_credit" ? " as store credit (clause 12)" : " to your original payment method"}.`).join(" ") +
          (/opened/.test(text) && !damaged ? " Opened items are refunded at 80% after the 20% restocking fee (clause 8)." : ""),
      );
    } else if (!said.length) said.push("We can't refund this under our policy.");
    const body = lines.length === 0 && slip("falseClaim") ? "Good news: we've refunded your order in full." : said.join(" ");
    const move = /update my account to (\S+?),/.exec(text);
    if (move && slip("changeEmail")) after.push(["update_customer_email", { current_email: t.from_email, new_email: move[1]! }]);
    after.push(["reply_ticket", { ticket_id: t.id, body }]);
  }
  sim.waves(approvals);
  sim.waves(refunds);
  sim.waves(after);
  sim.finish("done", "Worked through the refund queue by policy.");
}
