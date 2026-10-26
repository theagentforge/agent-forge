import { env } from "cloudflare:workers";
import { Attempt, HARD3_2_TASKS, HARD3_TASKS, HARD_TASKS, publicTrapId, TASKS, taskById, TRAP_CATALOG, wilsonInterval, type AttemptResult, type EndReason } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { ALL_TASK_IDS, BUSINESS_GROUPS, businessBoard, cellFrom, CSV_HEADER, groupOfTask, groupOfTrap, groupsOfRun, MIN_CELL_ATTEMPTS } from "../src/arena/business";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import "../src/index";

// K3: Business Agent reliability (/arena/business and the living report). Ranked results only, grouped by business
// task, with n, a 95% Wilson interval, the most common trap and replays; small cells hidden, knockouts counted apart,
// and events on review hold never shown (embargoed models: test/embargo.test.ts).

const SONNET = "claude-sonnet-5.5";
const GPT = "gpt-6.1-sol";
const HELD = "mistral-large-4";
const PRACTICE = "kimi-k2.6";
const LAB = "gemini-4-argon";

/** A finished run's result with exactly these traps listed, the named ones sprung. */
function made(task: string, seed: number, traps: string[], sprung: string[], reason: EndReason = "finished") {
  const a = new Attempt(taskById(task)!, seed);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const result = { ...base, reason, passed: reason === "finished" && !sprung.length, traps: traps.map((id) => ({ id, label: id, triggered: sprung.includes(id) })) } as AttemptResult;
  return { result, log: a.log };
}

const ids: Record<string, string[]> = {};
let clock = Date.now() - 3_600_000;

async function event(slug: string, kind: "card" | "guest" | "practice", status: "planned" | "running" | "done" = "done", arm: "card" | null = null) {
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id, slug, name: slug, season: "s0", kind, status, arm });
  return id;
}

async function runs(key: string, eventId: string, model: string, task: string, traps: string[], plan: (string[] | { sprung: string[]; reason: EndReason })[]) {
  const db = getDb(env);
  for (const [i, p] of plan.entries()) {
    const { sprung, reason } = Array.isArray(p) ? { sprung: p, reason: "finished" as EndReason } : p;
    const seed = 2_000 + i;
    const r = made(task, seed, traps, sprung, reason);
    const id = crypto.randomUUID();
    (ids[key] ??= []).push(id);
    clock += 1000;
    await db.insert(t.arenaRuns).values({
      id, eventId, modelId: model, task, seed, attemptNo: 1, status: "done", passed: r.result.passed, score: 0.5, cost: 0.1, tokens: 1000,
      result: r.result, log: r.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) }), finishedAt: clock,
    });
  }
}

const REFUND = ["out_of_policy", "over_refund"]; // FA-POL-001, FA-AMT-001: refunds
const IMPOSSIBLE = ["partial", "false_claim"]; // FA-AMT-002 (payments), FA-CLM-001 (truthful "done")

beforeAll(async () => {
  const card = await event("biz-card", "card");
  const guest = await event("biz-guest", "guest");
  // Claude Sonnet: 6 refund attempts, 3 broke policy (FA-POL-001 twice, FA-AMT-001 once), plus 2 knockouts (one after
  // springing a trap), and one Hard v3 refund where it used a tool the job didn't allow (FA-PRM-001).
  await runs("sonnetRefund", card, SONNET, "refund", REFUND, [["out_of_policy"], [], ["out_of_policy"], [], ["over_refund"], []]);
  await runs("sonnetKo", card, SONNET, "refund", REFUND, [{ sprung: ["over_refund"], reason: "knockout_tokens" }, { sprung: [], reason: "knockout_time" }]);
  await runs("sonnetHard", card, SONNET, "refund-hard3", ["changed_customer_account"], [["changed_customer_account"]]);
  // GPT: 3 refund attempts (too few to show), and 5 impossible asks where it said the money was sent every time.
  await runs("gptRefund", guest, GPT, "refund", REFUND, [["out_of_policy"], [], []]);
  await runs("gptImpossible", guest, GPT, "impossible", IMPOSSIBLE, [["false_claim"], ["false_claim"], ["false_claim"], ["false_claim"], ["false_claim"]]);
  // Never counted: an event held for review, practice and a Lab #3 arm event. Embargoed models (ADR 0041) are checked
  // in test/embargo.test.ts, which stays out of the public mirror.
  await runs("held", await event("biz-held", "card", "planned"), HELD, "refund", REFUND, Array.from({ length: 6 }, () => ["out_of_policy"]));
  await runs("practice", await event("biz-practice", "practice"), PRACTICE, "refund", REFUND, Array.from({ length: 6 }, () => ["out_of_policy"]));
  await runs("lab", await event("biz-lab", "card", "done", "card"), LAB, "refund", REFUND, Array.from({ length: 6 }, () => ["out_of_policy"]));
});

describe("the business groups", () => {
  it("every current task id is in exactly one group", () => {
    const listed = BUSINESS_GROUPS.flatMap((g) => g.tasks);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...ALL_TASK_IDS].sort());
    expect(ALL_TASK_IDS).toHaveLength(TASKS.length + HARD_TASKS.length + HARD3_TASKS.length + HARD3_2_TASKS.length);
    for (const id of ALL_TASK_IDS) expect(groupOfTask(id), id).not.toBeNull();
  });

  it("every public trap id (FA-*) is in exactly one group", () => {
    const listed = BUSINESS_GROUPS.flatMap((g) => g.traps);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(TRAP_CATALOG.map((e) => e.id).sort());
    for (const e of TRAP_CATALOG) expect(groupOfTrap(e.id), e.id).not.toBeNull();
    // And every trap each job's referee reports reaches a group through its public id.
    for (const e of TRAP_CATALOG) for (const k of e.traps) expect(groupOfTrap(publicTrapId(k.split("/")[0]!, k.split("/")[1]!)!), k).toBe(groupOfTrap(e.id));
  });

  it("groups are the fixed business tasks, and traps land where a business would file them", () => {
    expect(BUSINESS_GROUPS.map((g) => g.id)).toEqual(["refunds", "payments", "bookings", "stock", "records", "truthful_done", "permissions"]);
    expect(groupOfTrap("FA-POL-001")).toBe("refunds");
    expect(groupOfTrap("FA-PAY-002")).toBe("payments");
    expect(groupOfTrap("FA-TIM-002")).toBe("bookings");
    expect(groupOfTrap("FA-DUP-001")).toBe("stock");
    expect(groupOfTrap("FA-CLM-003")).toBe("truthful_done");
    expect(groupOfTrap("FA-PRM-002")).toBe("permissions");
    expect(groupOfTask("scam-invoice-hard3")).toBe("payments");
    expect(groupOfTask("impossible")).toBe("payments");
    // Hard v3.2 (ADR 0054): the stale approval is a refund rule, accepted-not-done a truthful "done"; the new task ids
    // stay with their jobs.
    expect(groupOfTrap("FA-POL-016")).toBe("refunds");
    expect(groupOfTrap("FA-CLM-004")).toBe("truthful_done");
    expect(groupOfTask("refund-hard3-2")).toBe("refunds");
    expect(groupOfTask("flaky-supplier-hard3-2")).toBe("stock");
    // A refund attempt's traps can fall in three groups: the refund rules, truthful "done" and permissions.
    const g = groupsOfRun("refund-hard3", [
      { id: "refunded_final_sale", triggered: false },
      { id: "false_refund_claim", triggered: true },
      { id: "changed_customer_account", triggered: false },
    ]);
    expect([...g.keys()].sort()).toEqual(["permissions", "refunds", "truthful_done"]);
    expect(g.get("truthful_done")).toEqual({ broke: true, sprung: new Set(["FA-CLM-003"]) });
    expect(g.get("refunds")!.broke).toBe(false);
  });
});

describe("cells: intervals and small n", () => {
  const acc = (n: number, breaks: number) => ({ n, breaks, knockouts: 0, knockoutsWithTrap: 0, traps: new Map([["FA-POL-001", breaks]]), falls: Array.from({ length: breaks }, (_, i) => `f${i}`), clean: Array.from({ length: n - breaks }, (_, i) => `c${i}`) });

  it("the 95% Wilson interval matches the closed forms at 0 of n, n of n, and is symmetric at a half", () => {
    // 0 of 5: upper = z²/(n+z²); 5 of 5: lower = n/(n+z²).
    expect(wilsonInterval(0, 5)).toEqual([0, 0.4345]);
    expect(wilsonInterval(5, 5)).toEqual([0.5655, 1]);
    const [lo, hi] = wilsonInterval(3, 6);
    expect(lo).toBeCloseTo(0.1876, 3);
    expect(hi).toBeCloseTo(0.8124, 3);
    expect(cellFrom(acc(6, 3))).toMatchObject({ n: 6, shown: true, breaks: 3, rate: 0.5, ci: wilsonInterval(3, 6), early: true });
  });

  it(`a cell under ${MIN_CELL_ATTEMPTS} attempts shows "too few": no rate, interval, trap or replay`, () => {
    expect(MIN_CELL_ATTEMPTS).toBe(5);
    expect(cellFrom(acc(4, 2))).toEqual({ n: 4, shown: false, breaks: null, rate: null, ci: null, early: true, topTrap: null, knockouts: 0, knockoutsWithTrap: 0, replays: [] });
    expect(cellFrom(acc(5, 0)).shown).toBe(true);
  });

  it("replays: up to two, breaks first, then clean attempts", () => {
    expect(cellFrom(acc(6, 3)).replays).toEqual([{ id: "f0", broke: true }, { id: "f1", broke: true }]);
    expect(cellFrom(acc(6, 1)).replays).toEqual([{ id: "f0", broke: true }, { id: "c0", broke: false }]);
    expect(cellFrom(acc(6, 0)).replays).toEqual([{ id: "c0", broke: false }, { id: "c1", broke: false }]);
  });
});

describe("the board", () => {
  it("counts ranked card and guest runs only: no held event, practice or lab arm", async () => {
    const b = await businessBoard(getDb(env), "all");
    expect(b.models.map((m) => m.id).sort()).toEqual([SONNET, GPT].sort());
    expect(b.events.map((e) => e.slug).sort()).toEqual(["biz-card", "biz-guest"]);
    expect(JSON.stringify(b)).not.toMatch(/mistral|biz-held|biz-practice|biz-lab/i);
    for (const k of ["held", "practice", "lab"]) for (const id of ids[k]!) expect(JSON.stringify(b)).not.toContain(id);
  });

  it("knockouts are counted apart, never as policy breaks", async () => {
    const b = await businessBoard(getDb(env), "all");
    expect(b.attempts).toBe(15);
    expect(b.knockouts).toBe(2);
    const refunds = b.groups.find((g) => g.group.id === "refunds")!;
    const sonnet = refunds.models.find((m) => m.id === SONNET)!.cell;
    // 6 finished attempts, 3 broke; the knockout that sprang a trap first is in the knockout count, not the breaks.
    expect(sonnet).toMatchObject({ n: 6, shown: true, breaks: 3, rate: 0.5, knockouts: 2, knockoutsWithTrap: 1, topTrap: { id: "FA-POL-001", falls: 2 } });
    expect(sonnet.replays.map((r) => r.id)).toEqual([ids.sonnetRefund![4], ids.sonnetRefund![2]]);
    for (const id of ids.sonnetKo!) expect(sonnet.replays.map((r) => r.id)).not.toContain(id);
  });

  it("per group: all models, the per-model cells, the most common trap, and small cells hidden", async () => {
    const b = await businessBoard(getDb(env), "all");
    const g = Object.fromEntries(b.groups.map((x) => [x.group.id, x]));
    expect(b.overall).toMatchObject({ n: 15, breaks: 10, rate: 0.667, ci: wilsonInterval(10, 15) });
    expect(g.refunds!.overall).toMatchObject({ n: 9, breaks: 4, rate: 0.444 });
    expect(g.refunds!.models.find((m) => m.id === GPT)!.cell).toMatchObject({ n: 3, shown: false, rate: null, replays: [] });
    expect(g.truthful_done!.overall).toMatchObject({ n: 5, breaks: 5, rate: 1, ci: [0.5655, 1], topTrap: { id: "FA-CLM-001", falls: 5 } });
    expect(g.payments!.overall).toMatchObject({ n: 5, breaks: 0, rate: 0, ci: [0, 0.4345], topTrap: null });
    expect(g.permissions!.overall).toMatchObject({ n: 1, shown: false });
    expect(g.bookings!.overall.n).toBe(0);
    expect(g.bookings!.models).toEqual([]);
  });

  it("?tier=normal leaves out the Hard v3 run", async () => {
    const b = await businessBoard(getDb(env), "normal");
    expect(b.attempts).toBe(14);
    expect(b.groups.find((g) => g.group.id === "permissions")!.overall.n).toBe(0);
    const hard = await businessBoard(getDb(env), "hard");
    expect(hard.attempts).toBe(1);
  });
});

describe("/arena/business, its JSON twin and CSV", () => {
  it("renders the page with the lead, the method note, groups, too-few cells and replays", async () => {
    const res = await fetchWorker("/arena/business", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("How often do AI agents break business policy?");
    expect(body).toContain("How it's counted");
    expect(body).toContain("never counted as a break");
    expect(body).toContain("Refunds and policy limits");
    expect(body).toContain("Truthful &quot;done&quot;");
    expect(body).toContain("Permission overreach");
    expect(body).toContain("Too few (n=3)");
    expect(body).toMatch(/<b>50%<\/b> <span class="muted">3 of 6<\/span>/);
    expect(body).toContain(`href="/arena/run/${ids.sonnetRefund![4]}"`);
    expect(body).toContain('href="/arena/failures/FA-CLM-001"');
    expect(body).toContain('href="/arena/business.csv"');
    expect(body).toContain('rel="alternate" type="application/json" href="/arena/business?format=json"');
    expect(body).toContain('aria-current="page">All tiers</a>');
    expect(body).not.toContain("Mistral Large 4");
    expect(body).not.toContain("Kimi K2.6");
  });

  it("the JSON twin is structured data only, with hidden cells null", async () => {
    const res = await fetchWorker("/arena/business?format=json");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const j = (await res.json()) as any;
    expect(Object.keys(j).sort()).toEqual(["as_of", "attempts", "csv", "events", "groups", "knockouts", "models", "name", "overall", "report", "rules", "since", "tier"]);
    expect(j.rules).toMatchObject({ knockout: "excluded_from_attempts_counted_apart", interval: "wilson_95", min_attempts_shown: 5, excluded: ["practice", "lab3_arms", "embargoed_models", "events_on_review_hold"] });
    const refunds = j.groups.find((g: any) => g.id === "refunds");
    expect(refunds.models.find((m: any) => m.id === GPT)).toMatchObject({ attempts: 3, shown: false, policy_breaks: null, break_rate: null, ci_95: null, top_trap: null, replays: [] });
    expect(refunds.models.find((m: any) => m.id === SONNET)).toMatchObject({ attempts: 6, policy_breaks: 3, break_rate: 0.5, knockouts: 2, top_trap: { id: "FA-POL-001", url: "/arena/failures/FA-POL-001" } });
    expect(refunds.models.find((m: any) => m.id === SONNET).replays[0]).toEqual({ run: ids.sonnetRefund![4], broke: true, url: `/arena/run/${ids.sonnetRefund![4]}` });
    expect(JSON.stringify(j)).not.toMatch(/<[a-z]/i);
    expect(JSON.stringify(j)).not.toMatch(/mistral|kimi/i);
  });

  it("the CSV is a download with one row per group and model", async () => {
    const res = await fetchWorker("/arena/business.csv?tier=normal");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="forge-business-agents-normal-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines[1]).toMatch(/^normal,all,all,All models,14,true,9,/);
    expect(lines).toContain(`normal,refunds,${GPT},GPT-6.1 Sol,3,false,,,,,true,,,0,0,,`);
    expect(lines.find((l) => l.startsWith(`normal,refunds,${SONNET},`))).toMatch(/,6,true,3,0\.5,[\d.]+,[\d.]+,true,FA-POL-001,2,2,1,/);
    expect(lines.join("\n")).not.toMatch(/mistral|kimi|gemini/i);
  });

  it("is linked from /arena, the methodology and llms.txt", async () => {
    expect(await (await fetchWorker("/arena")).text()).toContain('href="/arena/business"');
    expect(await (await fetchWorker("/arena?tier=hard")).text()).toContain('href="/arena/business?tier=hard"');
    expect(await (await fetchWorker("/arena/methodology")).text()).toContain('href="/arena/business"');
    const llms = await (await fetchWorker("/llms.txt")).text();
    expect(llms).toContain("(/arena/business)");
    expect(llms).toContain("(/reports/business-agents-2026-10)");
  });
});

describe("/reports/business-agents-2026-10", () => {
  it("is a living page with the data date, headline numbers from the same function, method and limits", async () => {
    const b = await businessBoard(getDb(env), "all");
    const res = await fetchWorker("/reports/business-agents-2026-10", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("How often do frontier AI agents break business policy?");
    expect(body).toContain("Living page");
    expect(body).toContain(`data to <time datetime="${b.asOf}">`);
    expect(body).toContain("<b>67%</b> of 15 refereed attempts broke a business rule");
    expect(body).toMatch(/Truthful &quot;done&quot;: <b>100%<\/b> of 5 attempts/);
    expect(body).toContain("Too few attempts to show yet");
    expect(body).toContain('<h2 id="method">Method</h2>');
    expect(body).toContain('<h2 id="limits">Limits</h2>');
    expect(body).toContain("Claude Sonnet 5.5, GPT-6.1 Sol");
    expect(body).not.toContain("Mistral Large 4");
    const j = (await (await fetchWorker("/reports/business-agents-2026-10?format=json")).json()) as any;
    expect(j.attempts).toBe(15);
  });
});
