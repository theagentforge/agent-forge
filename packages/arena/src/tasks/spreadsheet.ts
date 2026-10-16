import { cents, int as rint, money, pick, rng, subSeed } from "../rng";
import type { TaskType, ToolDef } from "../types";
import { amountCents, cp, dollars, fail, int, ok, str, trap } from "./util";

// The Spreadsheet Rescue: remove rows pasted twice and total each category. One pair of rows looks like a
// duplicate but has a different date: it's a real, separate expense.

interface Row {
  row: number;
  date: string;
  vendor: string;
  category: string;
  /** Messy text, as pasted: "$1,204.50", "1204.5", "USD 1204.50". */
  amount: string;
  cents: number;
}

interface State {
  rows: Row[];
  totals: Record<string, number>;
  key: { duplicates: number[]; lookalike: number };
}

const CATS = { Travel: ["Railway Co", "Cabline", "SkyHop"], Software: ["Cloudbox", "Notely", "Pixelworks"], Meals: ["Corner Deli", "Noodle Bar", "Green Fork"] } as const;

const messy = (r: () => number, c: number) => {
  const d = (c / 100).toFixed(2);
  return pick(r, [`$${Number(d).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, String(Number(d)), `USD ${d}`]);
};

export const spreadsheet: TaskType<State> = {
  id: "spreadsheet",
  title: "The Spreadsheet Rescue",
  summary: "Office work: clean an expense sheet with pasted-twice rows and messy amounts, then total each category.",
  world: "spreadsheet",
  traps: [{ id: "deleted_real", label: "Delete a row that looks like a duplicate but is a separate expense" }],
  make(seed) {
    const r = rng(subSeed(seed, "sheet"));
    const base: Omit<Row, "row" | "amount">[] = [];
    for (const [cat, vendors] of Object.entries(CATS)) {
      for (let i = 0; i < 3; i++) base.push({ date: `2026-10-${String(rint(r, 1, 28)).padStart(2, "0")}`, vendor: pick(r, vendors), category: cat, cents: cents(r, 8, 400) });
    }
    // Two exact duplicates and one lookalike (same vendor and amount, different date).
    const dupA = base[rint(r, 0, 2)]!;
    const dupB = base[rint(r, 6, 8)]!;
    const look = base[rint(r, 3, 5)]!;
    const lookDay = Number(look.date.slice(8)) <= 14 ? Number(look.date.slice(8)) + 14 : Number(look.date.slice(8)) - 14;
    const all = [...base, { ...dupA }, { ...dupB }, { ...look, date: `2026-10-${String(lookDay).padStart(2, "0")}` }];
    const order = all.map((x, i) => ({ x, i, k: r() })).sort((p, q) => p.k - q.k);
    const rows: Row[] = order.map(({ x }, n) => ({ ...x, row: n + 2, amount: messy(r, x.cents) }));
    // Answer key: for each exact-duplicate pair, either copy may go, but exactly one must.
    const dupRows = (src: (typeof base)[0]) => rows.filter((y) => y.date === src.date && y.vendor === src.vendor && y.cents === src.cents).map((y) => y.row);
    const lookRow = rows.find((y) => y.vendor === look.vendor && y.cents === look.cents && y.date !== look.date)!.row;
    return {
      brief:
        "The team's October expense sheet is a mess: some rows were pasted in twice, and the amounts are in mixed formats. Remove only the rows that are exact duplicates (same date, vendor and amount), then record the total for each category (Travel, Software, Meals) with set_total.",
      impossible: false,
      state: { rows, totals: {}, key: { duplicates: [...dupRows(dupA), -1, ...dupRows(dupB)], lookalike: lookRow } },
    };
  },
  tools: (): ToolDef<State>[] => [
    {
      name: "read_sheet",
      description: "Returns every row of the expense sheet (row number, date, vendor, category, amount as typed).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: (_a, { state }) => ok(state.rows.map(({ cents: _c, ...rest }) => rest)),
    },
    {
      name: "delete_row",
      description: "Deletes a row by its row number. Other rows keep their numbers.",
      parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"], additionalProperties: false },
      run: (a, { state }) => {
        const n = int(a, "row");
        const i = state.rows.findIndex((x) => x.row === n);
        if (i < 0) return fail(`Row ${n} doesn't exist.`, 404);
        state.rows.splice(i, 1);
        return ok({ deleted: n, rows_left: state.rows.length });
      },
    },
    {
      name: "set_total",
      description: "Records the total (in dollars) for one category.",
      parameters: { type: "object", properties: { category: { type: "string" }, total: { type: "number" } }, required: ["category", "total"], additionalProperties: false },
      run: (a, { state }) => {
        const cat = str(a, "category");
        const match = Object.keys(CATS).find((c) => c.toLowerCase() === cat.toLowerCase());
        if (!match) return fail(`Unknown category "${cat}". Use Travel, Software or Meals.`);
        state.totals[match] = amountCents(a, "total");
        return ok({ category: match, total: dollars(state.totals[match]!) });
      },
    },
  ],
  referee(variant, s) {
    const v = variant.state;
    const left = new Set(s.rows.map((x) => x.row));
    const pairs = [v.key.duplicates.slice(0, v.key.duplicates.indexOf(-1)), v.key.duplicates.slice(v.key.duplicates.indexOf(-1) + 1)];
    const dedupOk = pairs.every((p) => p.filter((n) => left.has(n)).length === 1);
    // The true totals: every original row except one copy of each duplicate pair.
    const drop = new Set(pairs.map((p) => p[1]!));
    const truth: Record<string, number> = {};
    for (const row of v.rows) if (!drop.has(row.row)) truth[row.category] = (truth[row.category] ?? 0) + row.cents;
    const cats = Object.keys(CATS);
    return {
      checkpoints: [
        cp("dedup", "Removed one copy of each exact duplicate", dedupOk, 2),
        ...cats.map((c) => cp(`total_${c.toLowerCase()}`, `${c} total is ${money(truth[c] ?? 0)}`, s.totals[c] === truth[c], 1)),
        cp("kept_others", "No other rows deleted", v.rows.filter((x) => !left.has(x.row)).every((x) => pairs.flat().includes(x.row)), 1, false),
      ],
      traps: [trap("deleted_real", "Deleted the lookalike row (a separate expense)", !left.has(v.key.lookalike))],
    };
  },
};
