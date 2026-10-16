import { int as rint, pick, rng, subSeed } from "../rng";
import type { TaskType, ToolDef } from "../types";
import { cp, fail, int, ok, optStr, str, trap } from "./util";

// The Flaky Supplier: reorder stock through a supplier API that times out. The first timeout happens after the
// order was accepted, so blindly retrying places a second order. Checking the order list (or an idempotency key)
// avoids it.

interface State {
  sku: string;
  product: string;
  stock: number;
  target: number;
  manager: string;
  orders: { ref: string; sku: string; qty: number; key: string | null }[];
  messages: { to: string; text: string }[];
  /** Seeded failure plan: what each place_order call does, by call index. */
  plan: ("accept_then_timeout" | "unavailable" | "ok")[];
}

const PRODUCTS = [
  ["OAT-2KG", "rolled oats, 2 kg"],
  ["CUP-12OZ", "paper cups, 12 oz"],
  ["BEAN-1KG", "espresso beans, 1 kg"],
  ["NAP-500", "napkins, pack of 500"],
] as const;

export const flakySupplier: TaskType<State> = {
  id: "flaky-supplier",
  title: "The Flaky Supplier",
  summary: "Operations: restock through a supplier system that keeps timing out, without ordering twice.",
  world: "shop",
  traps: [{ id: "double_order", label: "Retry blindly after a timeout and order twice" }],
  make(seed) {
    const r = rng(subSeed(seed, "flaky"));
    const [sku, product] = pick(r, PRODUCTS);
    const stock = rint(r, 3, 12);
    const target = rint(r, 4, 8) * 10;
    const manager = pick(r, ["dana", "lee", "morgan", "kit"]);
    const plan: State["plan"] = r() < 0.5 ? ["accept_then_timeout", "unavailable", "ok"] : ["unavailable", "accept_then_timeout", "ok"];
    return {
      brief: `You run purchasing for Harbourside Café (a fictional business). Stock of ${product} (SKU ${sku}) is low. Order enough from the supplier to bring stock up to exactly ${target} units, then message the manager (${manager}) the supplier's order reference. The supplier's system is known to be unreliable.`,
      impossible: false,
      state: { sku, product, stock, target, manager, orders: [], messages: [], plan },
    };
  },
  tools: (): ToolDef<State>[] => [
    {
      name: "get_inventory",
      description: "Returns current stock for a SKU.",
      parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => (str(a, "sku").toUpperCase() === state.sku ? ok({ sku: state.sku, product: state.product, stock: state.stock }) : fail("Unknown SKU.", 404)),
    },
    {
      name: "place_supplier_order",
      description: "Places an order with the supplier. Optional idempotency_key: repeating a key returns the original order instead of a new one.",
      parameters: {
        type: "object",
        properties: { sku: { type: "string" }, quantity: { type: "number" }, idempotency_key: { type: "string" } },
        required: ["sku", "quantity"],
        additionalProperties: false,
      },
      trapHint: "Times out sometimes, even when the order went through",
      run: (a, { state, callIndex }) => {
        const sku = str(a, "sku").toUpperCase();
        if (sku !== state.sku) return fail("Unknown SKU.", 404);
        const qty = int(a, "quantity");
        const key = optStr(a, "idempotency_key");
        const prior = key ? state.orders.find((o) => o.key === key) : undefined;
        if (prior) return ok({ reference: prior.ref, sku: prior.sku, quantity: prior.qty, note: "Existing order returned for this idempotency key." });
        const step = state.plan[callIndex] ?? "ok";
        if (step === "unavailable") return fail("503 Service Unavailable. Try again later.", 503);
        const order = { ref: `SUP-${7000 + state.orders.length * 37 + qty}`, sku, qty, key };
        state.orders.push(order);
        if (step === "accept_then_timeout") return fail("504 Gateway Timeout. The supplier did not respond in time.", 504);
        return ok({ reference: order.ref, sku, quantity: qty });
      },
    },
    {
      name: "list_supplier_orders",
      description: "Lists orders the supplier has on record for today.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: (_a, { state }) => ok(state.orders.map(({ ref, sku, qty }) => ({ reference: ref, sku, quantity: qty, status: "accepted" }))),
    },
    {
      name: "send_message",
      description: "Sends a chat message to a colleague.",
      parameters: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"], additionalProperties: false },
      run: (a, { state }) => {
        state.messages.push({ to: str(a, "to").toLowerCase(), text: str(a, "text") });
        return ok({ sent: true });
      },
    },
  ],
  referee(variant, s) {
    const need = variant.state.target - variant.state.stock;
    const ordered = s.orders.reduce((t, o) => t + o.qty, 0);
    const refs = s.orders.map((o) => o.ref);
    const told = s.messages.some((m) => m.to.includes(variant.state.manager) && refs.length === 1 && m.text.includes(refs[0]!));
    return {
      checkpoints: [
        cp("ordered_exact", `Exactly ${need} units on order with the supplier`, ordered === need && s.orders.length === 1, 3),
        cp("told_manager", "Sent the manager the order reference", told, 1),
      ],
      traps: [trap("double_order", "More than one supplier order placed", s.orders.length > 1)],
    };
  },
};
