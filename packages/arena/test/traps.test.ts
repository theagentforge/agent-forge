import { describe, expect, it } from "vitest";
import { citation, CHANGELOG, HARD3_2_TASKS, HARD3_TASKS, HARD_TASKS, publicTrapId, RULES_HISTORY, RULES_VERSION, rulesVersionAt, TASK_VERSIONS, TASKS, taskVersion, TRAP_CATALOG, TRAP_FAMILIES, TRAP_PUBLIC_IDS, versionLine } from "../src";

const ALL = [...TASKS, ...HARD_TASKS, ...HARD3_TASKS, ...HARD3_2_TASKS];

// The published map. Public trap IDs never change (ADR 0023 §5): if this test fails, you renamed or renumbered a
// published ID. Add a new entry instead, and add its line here.
const PUBLISHED: Record<string, string> = {
  "scam-invoice/wrong_account": "FA-PAY-001",
  "scam-invoice-hard/wrong_account": "FA-PAY-001",
  "scam-invoice-hard3/wrong_account": "FA-PAY-001",
  "scam-invoice-hard/paid_scam": "FA-PAY-002",
  "scam-invoice-hard3/paid_scam": "FA-PAY-002",
  "impossible-hard/paid_unverified_payee": "FA-PAY-003",
  "impossible-hard3/paid_unverified_payee": "FA-PAY-003",
  "scam-invoice/paid_scam": "FA-INJ-001",
  "flaky-supplier/double_order": "FA-DUP-001",
  "flaky-supplier-hard/double_order": "FA-DUP-001",
  "flaky-supplier-hard3/double_order": "FA-DUP-001",
  "scam-invoice-hard/paid_duplicate": "FA-DUP-002",
  "scam-invoice-hard3/paid_duplicate": "FA-DUP-002",
  "refund/out_of_policy": "FA-POL-001",
  "weekend/no_bag": "FA-POL-002",
  "weekend-hard/basic_fare_bag": "FA-POL-002",
  "weekend-hard3/basic_fare_bag": "FA-POL-002",
  "refund-hard/refunded_final_sale": "FA-POL-003",
  "refund-hard3/refunded_final_sale": "FA-POL-003",
  "refund-hard/skipped_approval": "FA-POL-004",
  "refund-hard3/skipped_approval": "FA-POL-004",
  "refund-hard/cash_refund_for_gift": "FA-POL-005",
  "refund-hard3/cash_refund_for_gift": "FA-POL-005",
  "scam-invoice-hard/paid_over_po": "FA-POL-006",
  "scam-invoice-hard3/paid_over_po": "FA-POL-006",
  "flaky-supplier-hard/unapproved_substitute": "FA-POL-007",
  "flaky-supplier-hard3/unapproved_substitute": "FA-POL-007",
  "impossible-hard/moved_locked_funds": "FA-POL-008",
  "impossible-hard3/moved_locked_funds": "FA-POL-008",
  "impossible-hard/overdraft": "FA-POL-009",
  "impossible-hard3/overdraft": "FA-POL-009",
  "impossible-hard/limit_lock": "FA-POL-010",
  "impossible-hard3/limit_lock": "FA-POL-010",
  "impossible-hard/unfunded_debit": "FA-POL-011",
  "impossible-hard3/unfunded_debit": "FA-POL-011",
  "weekend-hard/nonrefundable_hotel": "FA-POL-012",
  "weekend-hard3/nonrefundable_hotel": "FA-POL-012",
  "scam-invoice-hard3/paid_unreceived": "FA-POL-013",
  "scam-invoice-hard3/paid_over_price": "FA-POL-014",
  "weekend-hard3/room_too_small": "FA-POL-015",
  "refund/over_refund": "FA-AMT-001",
  "impossible/partial": "FA-AMT-002",
  "impossible-hard/partial": "FA-AMT-002",
  "impossible-hard3/partial": "FA-AMT-002",
  "refund-hard/wrong_amount": "FA-AMT-003",
  "refund-hard3/wrong_amount": "FA-AMT-003",
  "scam-invoice-hard/wrong_amount": "FA-AMT-004",
  "scam-invoice-hard3/wrong_amount": "FA-AMT-004",
  "flaky-supplier-hard/ignored_partial_fill": "FA-AMT-005",
  "flaky-supplier-hard3/ignored_partial_fill": "FA-AMT-005",
  "weekend-hard/over_budget": "FA-AMT-006",
  "weekend-hard3/over_budget": "FA-AMT-006",
  "weekend-hard/currency_miss": "FA-AMT-007",
  "weekend-hard3/currency_miss": "FA-AMT-007",
  "impossible/false_claim": "FA-CLM-001",
  "impossible-hard/false_claim": "FA-CLM-001",
  "impossible-hard3/false_claim": "FA-CLM-001",
  "flaky-supplier-hard/false_success": "FA-CLM-002",
  "flaky-supplier-hard3/false_success": "FA-CLM-002",
  "refund-hard3/false_refund_claim": "FA-CLM-003",
  "spreadsheet/deleted_real": "FA-DAT-001",
  "spreadsheet-hard/deleted_real_row": "FA-DAT-001",
  "spreadsheet-hard3/deleted_real_row": "FA-DAT-001",
  "spreadsheet-hard/deleted_paid_row": "FA-DAT-002",
  "spreadsheet-hard3/deleted_paid_row": "FA-DAT-002",
  "spreadsheet-hard/modified_legal_hold": "FA-DAT-003",
  "spreadsheet-hard3/modified_legal_hold": "FA-DAT-003",
  "weekend/bad_time": "FA-TIM-001",
  "weekend-hard/missed_window": "FA-TIM-001",
  "weekend-hard3/missed_window": "FA-TIM-001",
  "weekend-hard/dst_miss": "FA-TIM-002",
  "weekend-hard3/dst_miss": "FA-TIM-002",
  "refund-hard3/changed_customer_account": "FA-PRM-001",
  "scam-invoice-hard3/edited_vendor_master": "FA-PRM-002",
  "spreadsheet-hard3/exported_sheet": "FA-PRM-003",
  // Hard v3.2 (ADR 0054): two v3 jobs as new task ids. They report every trap of their v3.1 job under the same public
  // ID, plus one new trap each.
  "refund-hard3-2/refunded_final_sale": "FA-POL-003",
  "refund-hard3-2/skipped_approval": "FA-POL-004",
  "refund-hard3-2/cash_refund_for_gift": "FA-POL-005",
  "refund-hard3-2/wrong_amount": "FA-AMT-003",
  "refund-hard3-2/false_refund_claim": "FA-CLM-003",
  "refund-hard3-2/changed_customer_account": "FA-PRM-001",
  "refund-hard3-2/stale_approval": "FA-POL-016",
  "flaky-supplier-hard3-2/double_order": "FA-DUP-001",
  "flaky-supplier-hard3-2/unapproved_substitute": "FA-POL-007",
  "flaky-supplier-hard3-2/ignored_partial_fill": "FA-AMT-005",
  "flaky-supplier-hard3-2/false_success": "FA-CLM-002",
  "flaky-supplier-hard3-2/accepted_not_done": "FA-CLM-004",
};

/** Every trap id a task's referee reports, from a fresh world with no actions and no claim, plus its declared traps. */
function refereeTraps(task: (typeof ALL)[number], seed: number) {
  const v = task.make(seed);
  const ids = task.referee(v, structuredClone(v.state), [], null).traps.map((t) => t.id);
  return new Set([...ids, ...task.traps.map((t) => t.id)]);
}

describe("trap catalog (ADR 0023 §5)", () => {
  it("public IDs are stable: the full task-trap → public-ID map matches what was published", () => {
    expect({ ...TRAP_PUBLIC_IDS }).toEqual(PUBLISHED);
  });

  it("every trap every task's referee reports is in the catalog, and the catalog names nothing that doesn't exist", () => {
    const seen = new Set<string>();
    for (const task of ALL)
      for (const seed of [1, 2, 3]) {
        for (const id of refereeTraps(task, seed)) {
          seen.add(`${task.id}/${id}`);
          expect(publicTrapId(task.id, id), `${task.id}/${id}`).not.toBeNull();
        }
      }
    expect([...seen].sort()).toEqual(Object.keys(TRAP_PUBLIC_IDS).sort());
  });

  it("IDs are well formed, unique, numbered in order per family, and each entry is complete", () => {
    const ids = TRAP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fam of Object.keys(TRAP_FAMILIES)) {
      const nums = TRAP_CATALOG.filter((e) => e.family === fam).map((e) => e.id);
      expect(nums).toEqual(nums.map((_, i) => `FA-${fam}-${String(i + 1).padStart(3, "0")}`));
    }
    // Permission overreach (ADR 0023 §4) arrived with Hard v3.1, on three of the six v3 jobs.
    expect(TRAP_CATALOG.filter((e) => e.family === "PRM").map((e) => [e.id, e.since, e.traps])).toEqual([
      ["FA-PRM-001", "Hard v3.1", ["refund-hard3/changed_customer_account", "refund-hard3-2/changed_customer_account"]],
      ["FA-PRM-002", "Hard v3.1", ["scam-invoice-hard3/edited_vendor_master"]],
      ["FA-PRM-003", "Hard v3.1", ["spreadsheet-hard3/exported_sheet"]],
    ]);
    // Hard v3.2 (ADR 0054): a stale approval and an accepted-but-rejected order, each only on its new task id.
    expect(TRAP_CATALOG.filter((e) => e.since === "Hard v3.2").map((e) => [e.id, e.traps])).toEqual([
      ["FA-POL-016", ["refund-hard3-2/stale_approval"]],
      ["FA-CLM-004", ["flaky-supplier-hard3-2/accepted_not_done"]],
    ]);
    for (const e of TRAP_CATALOG) {
      expect(e.id).toMatch(/^FA-[A-Z]{3}-\d{3}$/);
      expect(e.id.slice(3, 6)).toBe(e.family);
      expect(e.description.length).toBeGreaterThan(10);
      expect(e.provenance.pattern.length).toBeGreaterThan(10);
      if (e.provenance.source) expect(e.provenance.source.url).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]+\//);
      // `since` is the earliest version any of its traps appears in (Hard v3.1 added traps to v3's own tasks).
      const first = TASK_VERSIONS.find((v) => e.traps.some((k) => v.tasks.includes(k.split("/")[0]!)))!.version;
      expect(e.since).toBe(e.family === "PRM" ? "Hard v3.1" : first);
    }
  });

  it("descriptions and family names are noun-phrase data, never instructions to an agent", () => {
    for (const s of [...TRAP_CATALOG.flatMap((e) => [e.description, e.provenance.pattern]), ...Object.values(TRAP_FAMILIES).map((f) => f.name)]) {
      expect(s).not.toMatch(/\b(you should|you must|ignore|do not|don't pay|always|never)\b/i);
    }
  });
});

describe("versions (ADR 0023 §5)", () => {
  it("each task has a version label and the current rules are the newest in the history", () => {
    expect(taskVersion("refund")).toBe("Normal 1.0");
    expect(taskVersion("refund-hard")).toBe("Hard v2");
    expect(taskVersion("refund-hard3")).toBe("Hard v3.1");
    for (const t of [...TASKS, ...HARD_TASKS]) expect(TASK_VERSIONS.filter((v) => v.tasks.includes(t.id))).toHaveLength(1);
    for (const t of HARD3_TASKS) expect(TASK_VERSIONS.filter((v) => v.tasks.includes(t.id)).map((v) => v.version)).toEqual(["Hard v3", "Hard v3.1"]);
    // Hard v3.2 is new task ids only: a v3.1 job's version never changes, whenever its result finished.
    expect(HARD3_2_TASKS.map((t) => t.id)).toEqual(["refund-hard3-2", "flaky-supplier-hard3-2"]);
    for (const t of HARD3_2_TASKS) expect(TASK_VERSIONS.filter((v) => v.tasks.includes(t.id)).map((v) => v.version)).toEqual(["Hard v3.2"]);
    expect(taskVersion("refund-hard3-2")).toBe("Hard v3.2");
    expect(taskVersion("refund-hard3", Date.UTC(2026, 9, 27))).toBe("Hard v3.1");
    expect(taskVersion("flaky-supplier-hard3")).toBe("Hard v3.1");
    expect(RULES_VERSION).toBe("rules 0.5");
    expect(RULES_HISTORY.at(-1)).toMatchObject({ version: "rules 0.5", date: "2026-10-24" });
    expect(rulesVersionAt(Date.parse("2026-10-18T00:00:00Z"))).toBe("rules 0.4");
    expect(rulesVersionAt(Date.parse("2026-10-24T00:00:00Z"))).toBe(RULES_VERSION);
    expect(rulesVersionAt(Date.UTC(2026, 9, 15, 12))).toBe("rules 0.1");
    expect(rulesVersionAt(Date.UTC(2026, 9, 16, 23))).toBe("rules 0.2");
    // Rules 0.3 and 0.4 (and Hard v3 and v3.1) share a day: the exact instant decides, so earlier runs keep their versions.
    expect(versionLine("weekend-hard3", Date.UTC(2026, 9, 17, 6))).toBe("Rules 0.3 · Hard v3");
    expect(versionLine("weekend-hard3", Date.UTC(2026, 9, 17, 7))).toBe("Rules 0.4 · Hard v3.1");
    expect(versionLine("refund-hard", Date.UTC(2026, 9, 18))).toBe("Rules 0.4 · Hard v2");
    expect(taskVersion("refund-hard3", Date.UTC(2026, 9, 17, 6, 59))).toBe("Hard v3");
    expect(taskVersion("refund-hard3", Date.UTC(2026, 9, 16))).toBe("Hard v3"); // never earlier than its first version
  });

  it("the citation has title, version, date and URL, as a plain line and BibTeX", () => {
    const c = citation("https://theagentforge.io/");
    expect(c).toMatchObject({ title: "The Forge Arena", date: "2026-10-26", url: "https://theagentforge.io/arena/methodology", version: "rules 0.5; tasks Normal 1.0, Hard v2, Hard v3, Hard v3.1, Hard v3.2" });
    expect(c.text).toBe("The Agent Forge (2026). The Forge Arena: methodology and trap catalog (rules 0.5; tasks Normal 1.0, Hard v2, Hard v3, Hard v3.1, Hard v3.2). 26 Oct 2026. https://theagentforge.io/arena/methodology");
    expect(c.bibtex).toMatch(/^@misc\{forgearena2026,/);
    expect(c.bibtex).toContain("url          = {https://theagentforge.io/arena/methodology}");
    expect(CHANGELOG.map((x) => x.date)).toEqual([...CHANGELOG.map((x) => x.date)].sort());
    expect(CHANGELOG.map((x) => x.version)).toEqual(expect.arrayContaining(["Normal 1.0", "Hard v2", "Hard v3", "Hard v3.1", "rules 0.3", "rules 0.4", "rules 0.5"]));
    expect(CHANGELOG.filter((x) => x.version.startsWith("rules ")).at(-1)).toMatchObject({ version: "rules 0.5", date: "2026-10-24" });
    expect(CHANGELOG.find((x) => x.version === "Hard v3.1")!.change).toMatch(/^Permission-overreach traps\./);
    // Same-day entries are in the order they took effect.
    const order = CHANGELOG.map((x) => x.version);
    expect(order.indexOf("rules 0.3")).toBeLessThan(order.indexOf("rules 0.4"));
    expect(order.indexOf("Hard v3")).toBeLessThan(order.indexOf("Hard v3.1"));
  });
});
