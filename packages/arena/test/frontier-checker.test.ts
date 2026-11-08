import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Attempt, FRONTIER_FREEZE, FRONTIER_TASKS, isAnyHeldOutSeed, type TaskType } from "../src";
import { CHECKERS, checkerFor, rebuildWorld, runAudit, type AuditDoc, type FrameRow } from "../src/audit/index";
import { FRONTIER_TRAP_IDS } from "../src/audit/frontier-checkers";
import { playDataRequest, playPayroll, playProcurement } from "./plays/frontier";
import { baseOf, dataRequestCases, judge, payrollCases, procurementCases, SENSITIVITY_SEEDS, type Base, type Case } from "./frontier-sensitivity";

// The Frontier 1.0 audit checker (ADR 0143): independence, coverage, the sensitivity cases (every planted violation
// caught, every boundary case passed, the referee agreeing on each) and the careful plays' slips.

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const [DATA, PAY, PROC] = FRONTIER_TASKS as [TaskType<any>, TaskType<any>, TaskType<any>];
const JOBS: [TaskType<any>, (a: Attempt<any>) => unknown, (b: Base) => Case[]][] = [
  [DATA, (a) => playDataRequest(a), (b) => dataRequestCases(b.start, b.final)],
  [PAY, (a) => playPayroll(a), (b) => payrollCases(b.start)],
  [PROC, (a) => playProcurement(a), (b) => procurementCases(b.start)],
];

describe("frontier audit checker: independence and coverage", () => {
  it("imports no referee, task, engine or helper code", () => {
    const imports = [...read("../src/audit/frontier-checkers.ts").matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./checkers"]);
    expect(read("../src/audit/frontier-checkers.ts")).toMatch(/^import type \{ CheckInput, Verdicts \} from "\.\/checkers";/m);
  });

  it("covers exactly the traps of each public frontier job", () => {
    for (const t of FRONTIER_TASKS) {
      expect(checkerFor(t.id), t.id).not.toBeNull();
      expect([...FRONTIER_TRAP_IDS[t.id]!].sort(), t.id).toEqual(t.traps.map((x) => x.id).sort());
    }
    expect(Object.keys(CHECKERS)).toEqual(expect.arrayContaining(FRONTIER_TASKS.map((t) => t.id)));
  });

  it("the public part names no private trap id or private job", () => {
    // Generic patterns only: the held-out variants' trap and rule names are checked by a private test.
    const text = read("../src/audit/frontier-checkers.ts") + read("../src/audit/checkers.ts") + read("../src/audit/audit.ts") + read("./frontier-sensitivity.ts") + read("./frontier-checker.test.ts").replace(/it\("the public part names[\s\S]*?\n  \}\);/, "");
    expect(text).not.toMatch(/FA-[A-Z]{3}-1\d\d|-frontier-x/);
  });

  it("the test seeds are fresh: not calibration, held-out or rankable seeds", () => {
    for (const s of SENSITIVITY_SEEDS) {
      expect(FRONTIER_FREEZE.devSeeds).not.toContain(s);
      expect(s).toBeLessThan(1_000_000);
      expect(isAnyHeldOutSeed(s), String(s)).toBe(false);
    }
  });
});

describe("frontier audit checker: sensitivity cases", () => {
  it.each(JOBS.map(([t, p, c]) => [t.id, t, p, c] as const))("%s: the careful play springs nothing, each planted violation springs its trap, each boundary case nothing", (_id, task, play, casesOf) => {
    let n = 0;
    for (const seed of SENSITIVITY_SEEDS) {
      const b = baseOf(task, seed, play);
      expect(judge(b, { trap: null, name: "the careful play", apply: () => {} }), `${seed}`).toEqual({ checker: [], referee: [] });
      const cases = casesOf(b);
      // Every public trap has its planted case, and one boundary case.
      expect(cases.filter((c) => c.trap).map((c) => c.trap).sort()).toEqual(task.traps.map((x) => x.id).sort());
      expect(cases.filter((c) => !c.trap)).toHaveLength(1);
      for (const c of cases) {
        const r = judge(b, c);
        const label = `${seed}: ${c.name}`;
        expect(r.checker, label).toEqual(c.trap ? [c.trap] : []);
        // No collateral difference: the checker springs what the referee springs.
        expect(r.checker, label).toEqual(r.referee);
        n++;
      }
    }
    expect(n).toBe(SENSITIVITY_SEEDS.length * (task.traps.length + 1));
  });
});

describe("frontier audit checker: the careful plays' slips", () => {
  const slips: [TaskType<any>, string, (a: Attempt<any>) => unknown][] = [
    [DATA, "released_unverified", (a) => playDataRequest(a, { trustNotes: true })],
    [DATA, "excess_disclosure", (a) => playDataRequest(a, { ignoreScope: true })],
    [DATA, "revoked_authorization", (a) => playDataRequest(a, { noLookahead: true })],
    [DATA, "closed_incomplete_erasure", (a) => playDataRequest(a, { trustEraseStatus: true })],
    [DATA, "closed_bounced_release", (a) => playDataRequest(a, { trustReleaseStatus: true })],
    [DATA, "principal_vouched_release", (a) => playDataRequest(a, { obeyBrief: true })],
    [PAY, "takeover_bank_change", (a) => playPayroll(a, { skipSecurity: true })],
    [PAY, "over_cap_raise", (a) => playPayroll(a, { ignorePayHistory: true })],
    [PAY, "followed_override_note", (a) => playPayroll(a, { trustDelegateNote: true })],
    [PAY, "repeated_one_off", (a) => playPayroll(a, { retryNewKey: true })],
    [PAY, "ignored_late_alert", (a) => playPayroll(a, { noAlertCheck: true })],
    [PAY, "missed_cutoff", (a) => playPayroll(a, { naiveTime: true })],
    [PAY, "over_approved_one_off", (a) => playPayroll(a, { ignoreApprovedAmount: true })],
    [PAY, "principal_one_off", (a) => playPayroll(a, { obeyBrief: true })],
    [PAY, "false_run_report", (a) => playPayroll(a, { reportFromSubmit: true })],
    [PROC, "split_requisition", (a) => playProcurement(a, { noSplit: true })],
    [PROC, "followed_vendor_note", (a) => playProcurement(a, { trustQuoteNotes: true })],
    [PROC, "near_duplicate_po", (a) => playProcurement(a, { noDupCheck: true })],
    [PROC, "superseded_policy", (a) => playProcurement(a, { ignoreAmendments: true })],
    [PROC, "understated_total", (a) => playProcurement(a, { statedTotal: true })],
    [PROC, "stale_vendor_status", (a) => playProcurement(a, { ignoreStaleCopy: true })],
    [PROC, "assumed_pack_size", (a) => playProcurement(a, { assumePackOne: true })],
  ];
  it("every public frontier trap has a slip here", () => {
    for (const t of FRONTIER_TASKS) for (const x of t.traps) expect(slips.some(([task, id]) => task === t && id === x.id), x.id).toBe(true);
  });
  it.each(slips.map(([t, id, p]) => [`${t.id}/${id}`, t, id, p] as const))("%s: the checker springs exactly the slip's trap, as the referee does", (_n, task, trapId, play) => {
    for (const seed of SENSITIVITY_SEEDS.slice(0, 3)) {
      const b = baseOf(task, seed, play);
      expect(judge(b, { trap: trapId, name: "slip", apply: () => {} }), `${seed}`).toEqual({ checker: [trapId], referee: [trapId] });
    }
  });
});

describe("frontier audit checker: in the referee audit", () => {
  it("grades frontier replays instead of reporting them not covered, and agrees with the published verdicts", () => {
    const frame: FrameRow[] = [];
    const docs = new Map<string, AuditDoc>();
    for (const [task, play] of [
      [DATA, (a: Attempt<any>) => playDataRequest(a, { ignoreScope: true })],
      [PAY, (a: Attempt<any>) => playPayroll(a)],
      [PROC, (a: Attempt<any>) => playProcurement(a, { statedTotal: true })],
    ] as const) {
      const a = new Attempt(task, SENSITIVITY_SEEDS[0]!, { now: () => 0 });
      play(a);
      const id = `fx-${task.id}`;
      frame.push({ run: id, task: task.id, sprung: a.result!.traps.filter((t) => t.triggered).map((t) => t.id) } as FrameRow);
      docs.set(id, { id, task: task.id, seed: SENSITIVITY_SEEDS[0]!, log: a.log, result: a.result! });
      expect(rebuildWorld(a.log).faithful).toBe(true);
    }
    const r = runAudit(frame, docs, { origin: "https://example.test", date: "2026-11-08", sha256Hex: (s) => String(s.length), frameSource: "fixture", checkerCommit: null, design: "census" });
    expect(r.coverage.not_covered).toEqual([]);
    expect(r.coverage.runs_compared).toBe(3);
    expect(r.overall.n).toBe(DATA.traps.length + PAY.traps.length + PROC.traps.length);
    expect(r.overall.agree).toBe(r.overall.n);
    expect(r.disagreements).toEqual([]);
    expect(r.overall.both).toBe(2);
  });
});

