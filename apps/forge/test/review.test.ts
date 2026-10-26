import { Attempt, taskById, type AttemptResult, type LogEvent } from "@forge/arena";
import { scanSkill } from "@forge/shared";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import graderSuite from "../../../packages/arena/test/grader-hacking.test.ts?raw";
// @ts-expect-error -- plain JavaScript (run with node by anyone checking the numbers), no type declarations
import * as offline from "../../../lab/006-referee-and-scanner-audit/analyze.mjs";
import * as t from "../src/db/schema";
import { getDb, newId } from "../src/services/db";
import { DATA_CONTROLS } from "../src/services/kpis";
import {
  activeItems,
  allocate,
  blindRun,
  cellSequence,
  drawSample,
  drawStudy,
  jobFamily,
  LAB6,
  labelsOf,
  nextOpen,
  refereeResults,
  replaceItem,
  sampleOf,
  scannerResults,
  seededKey,
  type Item,
  type Label,
} from "../src/services/review";
import { cohenKappa, judge, judgeMet, proportion, recall, stratified } from "../src/services/review-stats";
import { reviewTransport } from "../src/web/admin-review";
import { csrfToken, newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker } from "./helpers";
import "../src/index";

// Lab #6 (ADR 0054): the human review console, its seeded draw and its statistics.

const ADMIN_GITHUB_ID = Number(String(env.ADMIN_GITHUB_IDS).split(",")[0]);

async function person(githubId: number, login: string) {
  const id = newId();
  await getDb(env).insert(t.humans).values({ id, githubId, githubLogin: login, githubCreatedAt: 0, tier: "verified" });
  const token = await newSession(env.SESSION_SECRET, id);
  return { id, cookie: `${SESSION_COOKIE}=${token}`, csrf: await csrfToken(env.SESSION_SECRET, token) };
}

let adminP: Promise<Awaited<ReturnType<typeof person>>> | null = null;
const theAdmin = () => (adminP ??= person(ADMIN_GITHUB_ID, "founder"));

const post = (path: string, who: { cookie: string; csrf: string }, fields: [string, string][]) =>
  fetchWorker(path, { method: "POST", redirect: "manual", headers: { Cookie: who.cookie, Origin: env.PUBLIC_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams([["csrf", who.csrf], ...fields]) });
const get = (path: string, who: { cookie: string }) => fetchWorker(path, { redirect: "manual", headers: { Cookie: who.cookie, Accept: "text/html" } });

/** A real referee log: one read call, then "done". The stored verdict is set by the test, per cell. */
function playedRun(task = "refund", seed = 3) {
  const tt = taskById(task)!;
  const a = new Attempt(tt, seed);
  const first = tt.tools(a.variant).find((x) => x.readOnly) ?? tt.tools(a.variant)[0]!;
  a.call(first.name, {});
  a.call("finish", { status: "done", summary: "All done, everything is sorted." });
  return { log: a.log as LogEvent[], result: a.result as AttemptResult };
}

describe("the seeded draw", () => {
  it("keys are SHA-256 of seed:text, the same every time", async () => {
    expect(await seededKey("s", "x")).toBe(await seededKey("s", "x"));
    expect(await seededKey("s", "x")).not.toBe(await seededKey("t", "x"));
    expect(await seededKey("s", "x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a short cell is taken whole and its spare places go to the others in listed order", () => {
    expect(allocate({ a: 50, b: 50, c: 50, d: 50 }, { a: 500, b: 10, c: 500, d: 500 })).toEqual({ a: 64, b: 10, c: 63, d: 63 });
    expect(allocate({ a: 5, b: 5 }, { a: 2, b: 3 })).toEqual({ a: 2, b: 3 });
    expect(allocate({ flagged: 80, caution: 60, clear: 60 }, { flagged: 1000, caution: 1000, clear: 1000 })).toEqual({ flagged: 80, caution: 60, clear: 60 });
  });

  it("round-robin: every sub-stratum is in before any has two", async () => {
    const items = [...Array(10)].map((_, i) => ({ id: `a${i}`, sub: "big" })).concat([{ id: "b0", sub: "small" }, { id: "c0", sub: "tiny" }, { id: "c1", sub: "tiny" }]);
    const seq = await cellSequence(items, "seed");
    expect(new Set(seq.slice(0, 3).map((x) => x.sub))).toEqual(new Set(["big", "small", "tiny"]));
    expect(seq).toHaveLength(items.length);
    expect(new Set(seq.map((x) => x.id)).size).toBe(items.length);
  });

  it("is reproducible from the seed, mixes the queue, and keeps 20 reserves per cell", async () => {
    const frame = [...Array(400)].map((_, i) => ({ id: `run-${i}`, cell: ["pass|no-trap", "pass|trap", "fail|no-trap", "fail|trap"][i % 4]!, sub: `m${i % 3}|f${i % 5}`, truth: null }));
    const a = await drawSample(frame, LAB6.referee.seed, LAB6.referee.quotas);
    const b = await drawSample(frame, LAB6.referee.seed, LAB6.referee.quotas);
    const other = await drawSample(frame, "another-seed", LAB6.referee.quotas);
    expect(a).toEqual(b);
    expect(a.items.filter((i) => i.status === "active").map((i) => i.itemId)).not.toEqual(other.items.filter((i) => i.status === "active").map((i) => i.itemId));
    const active = a.items.filter((i) => i.status === "active");
    expect(active).toHaveLength(200);
    expect(active.map((i) => i.position).sort((x, y) => x! - y!)).toEqual([...Array(200)].map((_, i) => i + 1));
    expect(a.items.filter((i) => i.status === "reserve")).toHaveLength(80);
    // The first 10 queue places aren't all one cell.
    expect(new Set(active.sort((x, y) => x.position! - y.position!).slice(0, 10).map((i) => i.cell)).size).toBeGreaterThan(1);
    expect(a.frame.cells["pass|trap"]).toBe(100);
    expect(Object.values(a.frame.strata).reduce((s, n) => s + n, 0)).toBe(400);
  });

  it("small or empty strata: empty cells, a frame smaller than the sample, nothing at all", async () => {
    const q = LAB6.referee.quotas;
    // A pass with a trap sprung can't happen under the referee's rules, so that cell is empty; its places go round.
    expect(allocate(q, { "pass|no-trap": 500, "pass|trap": 0, "fail|no-trap": 500, "fail|trap": 500 })).toEqual({ "pass|no-trap": 67, "pass|trap": 0, "fail|no-trap": 67, "fail|trap": 66 });
    expect(allocate(q, {})).toEqual({ "pass|no-trap": 0, "pass|trap": 0, "fail|no-trap": 0, "fail|trap": 0 });
    expect(allocate(q, { "pass|no-trap": 3, "fail|trap": 1 })).toEqual({ "pass|no-trap": 3, "pass|trap": 0, "fail|no-trap": 0, "fail|trap": 1 });
    expect(await drawSample([], LAB6.referee.seed, q)).toEqual({ items: [], frame: { cells: {}, strata: {} }, allocation: { "pass|no-trap": 0, "pass|trap": 0, "fail|no-trap": 0, "fail|trap": 0 } });
    // 30 items in one cell: all 30 drawn, none left as reserves; queue positions 1..30.
    const frame = [...Array(30)].map((_, i) => ({ id: `r${i}`, cell: "fail|no-trap", sub: `m${i % 7}|f`, truth: null }));
    const d = await drawSample(frame, LAB6.referee.seed, q);
    expect(d.items.filter((i) => i.status === "active")).toHaveLength(30);
    expect(d.items.filter((i) => i.status === "reserve")).toHaveLength(0);
    expect(d.items.map((i) => i.position).sort((a, b) => a! - b!)).toEqual([...Array(30)].map((_, i) => i + 1));
    // The same frame in another order gives the same draw.
    expect(await drawSample([...frame].reverse(), LAB6.referee.seed, q)).toEqual(d);
  });

  it("job families join a job's Normal and Hard versions", () => {
    expect(["refund", "refund-hard", "refund-hard3"].map(jobFamily)).toEqual(["refund", "refund", "refund"]);
  });
});

describe("the statistics", () => {
  it("Wilson, weighting, kappa and the pre-registered reading of a threshold", () => {
    expect(proportion(195, 200).ci![0]).toBeCloseTo(0.9427, 3);
    // Equal weights give the plain proportion.
    const even = stratified([{ stratum: "a", y: true }, { stratum: "a", y: false }, { stratum: "b", y: true }, { stratum: "b", y: false }], { a: 10, b: 10 });
    expect(even.p).toBe(0.5);
    expect(even.nEff).toBe(4);
    // A stratum ten times bigger in the frame counts ten times as much.
    const tilted = stratified([{ stratum: "a", y: true }, { stratum: "b", y: false }], { a: 100, b: 10 });
    expect(tilted.p).toBeCloseTo(100 / 110, 4);
    expect(tilted.nEff).toBeLessThan(2);
    expect(stratified([], { a: 1 }).p).toBeNull();
    expect(cohenKappa([["a", "a"], ["a", "a"], ["b", "b"], ["a", "b"]]).kappa).toBe(0.5);
    expect(cohenKappa([["a", "a"]]).kappa).toBeNull();
    expect(judge(proportion(200, 200), 0.95, true)).toBe("met");
    expect(judge(proportion(193, 200), 0.95, true)).toBe("consistent_not_shown");
    expect(judge(proportion(180, 200), 0.95, true)).toBe("not_met");
    expect(judge(proportion(200, 200), 0.95, false)).toBe("not_yet_measured");
    // Amendment 2, the primary reading: estimate ≥ bar and lower bound ≥ floor. With n = 100, 96 of 100 (lower bound
    // 0.901) is met and 95 of 100 (0.888) isn't; 60 of 60 is met for H1, while the strict reading needs n ≥ 73.
    expect(proportion(96, 100).ci![0]).toBeCloseTo(0.9016, 3);
    expect(judgeMet(proportion(96, 100), 0.95, 0.9, true)).toBe("met");
    expect(judgeMet(proportion(95, 100), 0.95, 0.9, true)).toBe("not_met");
    expect(judgeMet(proportion(59, 60), 0.95, 0.9, true)).toBe("met");
    expect(judge(proportion(60, 60), 0.95, true)).toBe("consistent_not_shown");
    // H2 (bar 0.9, floor 0.8): 72 of 80 is met (lower bound 0.815), 71 of 80 isn't (the estimate is under 0.9).
    expect(judgeMet(proportion(72, 80), 0.9, 0.8, true)).toBe("met");
    expect(judgeMet(proportion(71, 80), 0.9, 0.8, true)).toBe("not_met");
    // A high estimate on too few items isn't met: 10 of 10 has a lower bound of 0.72.
    expect(judgeMet(proportion(10, 10), 0.95, 0.9, true)).toBe("not_met");
    expect(judgeMet(proportion(10, 10), 0.95, 0.9, false)).toBe("not_yet_measured");
  });

  it("by hand: Kish's effective n and Wilson on it, kappa at chance and at perfect agreement", () => {
    // Weights 100 and 10: n_eff = 110² / (100² + 10²) = 1.198; Wilson on (p·n_eff, n_eff).
    const tilted = stratified([{ stratum: "a", y: true }, { stratum: "b", y: false }], { a: 100, b: 10 });
    expect(tilted.nEff).toBe(1.2);
    expect(tilted.ci![0]).toBeCloseTo(0.1969, 3);
    expect(tilted.ci![1]).toBeCloseTo(0.9976, 3);
    // Agreement no better than chance is 0; perfect agreement over two categories is 1.
    expect(cohenKappa([["a", "a"], ["a", "b"], ["b", "a"], ["b", "b"]]).kappa).toBe(0);
    expect(cohenKappa([["a", "a"], ["b", "b"], ["a", "a"]]).kappa).toBe(1);
    // 0.9 observed, 0.5 by chance: (0.9 − 0.5) / (1 − 0.5) = 0.8.
    const ten = [...Array(5)].map(() => ["a", "a"] as [string, string]).concat([...Array(4)].map(() => ["b", "b"] as [string, string]), [["a", "b"]]);
    expect(cohenKappa(ten as [string, string][]).kappa).toBeCloseTo((0.9 - 0.5) / 0.5, 3);
  });

  it("two-level weighting: a cell keeps its frame share even when only some of its strata were drawn", () => {
    // Cell A (frame 100): strata x (10) and y (90); only x was drawn, 2 of 2 agree. Cell B (frame 100): one stratum, 1 of 4.
    // The cells count equally (100 each): (100·1 + 100·0.25) / 200 = 0.625. Pooling strata would give 0.318.
    const items = [
      { stratum: "A|x", cell: "A", y: true },
      { stratum: "A|x", cell: "A", y: true },
      ...[true, false, false, false].map((y) => ({ stratum: "B|z", cell: "B", y })),
    ];
    const frame = { "A|x": 10, "A|y": 90, "B|z": 100 };
    const r = stratified(items, frame);
    expect(r.p).toBe(0.625);
    // Weights: A items (100/10)·(10/2) = 50 each, B items 100/4 = 25 each: n_eff = 200² / (2·50² + 4·25²) = 5.33.
    expect(r.nEff).toBe(5.3);
    expect(r.ci![0]).toBeCloseTo(0.2551, 3);
    expect(r.ci![1]).toBeCloseTo(0.8903, 3);
    expect(r.coverage).toBe(0.55);
    // Without cells, unlabelled strata get no weight (the old, pooled reading).
    expect(stratified(items.map(({ stratum, y }) => ({ stratum, y })), frame).p).toBeCloseTo((10 + 25) / 110, 4);
    // A cell whose name is a prefix of another's isn't mixed up with it ("pass|no-trap" vs "pass|trap").
    const pt = stratified([{ stratum: "pass|trap|m|f", cell: "pass|trap", y: true }, { stratum: "pass|no-trap|m|f", cell: "pass|no-trap", y: false }], { "pass|trap|m|f": 10, "pass|trap|m|g": 30, "pass|no-trap|m|f": 40 });
    expect(pt.p).toBe(0.5);
    // The offline script gives the same numbers.
    expect(offline.stratified(items, frame)).toEqual(r);
  });

  it("recall from the clear sample: seeded, inside its interval, and lower when clear skills hide risk", () => {
    const g = (N: number, p: number, n: number) => ({ N, p, nEff: n });
    const none = recall({ flagged: g(100, 0.9, 80), caution: g(500, 0.3, 60), clear: g(9000, 0, 60) });
    const some = recall({ flagged: g(100, 0.9, 80), caution: g(500, 0.3, 60), clear: g(9000, 0.05, 60) });
    expect(none).toEqual(recall({ flagged: g(100, 0.9, 80), caution: g(500, 0.3, 60), clear: g(9000, 0, 60) }));
    expect(none.flagged!.plugIn).toBeCloseTo(90 / 240, 3);
    // With no risky clear skill seen, the simulation still allows some: the estimate sits below the plug-in value.
    expect(none.flagged!.p).toBeLessThan(none.flagged!.plugIn);
    expect(some.flagged!.p).toBeLessThan(none.flagged!.p);
    for (const r of [none.flagged!, none.flaggedOrCaution!, some.flagged!]) expect(r.ci[0] <= r.p && r.p <= r.ci[1]).toBe(true);
    expect(recall({ flagged: g(1, 0.9, 1), caution: g(1, 0.3, 1), clear: { N: 1, p: null, nEff: 0 } }).flagged).toBeNull();
  });
});

describe("results with two reviewers", () => {
  it("headline numbers use the primary reviewer; kappa compares the reviewers; unclear is left out and counted", () => {
    const truth = (passed: boolean) => ({ passed, sprung: [], reason: "finished", model: "m", task: "refund" });
    const items = [...Array(6)].map((_, i) => ({ sampleId: "s", itemId: `i${i}`, cell: i % 2 ? "fail|no-trap" : "pass|no-trap", sub: "m|refund", rank: i + 1, position: i + 1, status: "active", replacedBy: null, truth: truth(i % 2 === 0) })) as Item[];
    const lab = (reviewerId: string, itemId: string, answer: string, at: number) => ({ sampleId: "s", itemId, reviewerId, answer, traps: [], ruleMarks: null, note: null, sawReplay: false, revealedAt: null, seconds: 60, createdAt: at, updatedAt: at }) as Label;
    const a = items.map((i, n) => lab("A", i.itemId, n === 5 ? "unclear" : (i.truth as { passed: boolean }).passed ? "passed" : "failed", 1));
    const b = items.slice(0, 4).map((i, n) => lab("B", i.itemId, n === 0 ? "failed" : (i.truth as { passed: boolean }).passed ? "passed" : "failed", 2));
    const sample = { config: { quotas: { "pass|no-trap": 3, "fail|no-trap": 3 }, frame: { cells: {}, strata: { "pass|no-trap|m|refund": 30, "fail|no-trap|m|refund": 30 } } } };
    const r = refereeResults(sample, items, [...a, ...b]);
    expect(r.primary).toBe("A");
    expect(r.complete).toBe(true);
    expect(r.unclear).toBe(1);
    expect(r.agreementRaw).toMatchObject({ k: 5, n: 5 });
    expect(r.agreement.p).toBe(1);
    expect(r.kappaReviewers).toHaveLength(1);
    expect(r.kappaReviewers[0]).toMatchObject({ a: "A", b: "B", n: 4 });
    expect(r.reviewers.map((x) => [x.reviewerId, x.done, x.medianSeconds])).toEqual([["A", 6, 60], ["B", 4, 60]]);
    expect(r.confusion.counts.unclear!.fail).toBe(1);
  });
});

describe("the offline analysis (analyze.mjs) matches the console", () => {
  it("referee and scanner, from the exported shape", () => {
    const truth = (passed: boolean, sprung: string[] = []) => ({ passed, sprung, reason: "finished", model: "m", task: "refund" });
    const items = [...Array(8)].map((_, i) => ({ sampleId: "s", itemId: `i${i}`, cell: i % 2 ? "fail|trap" : "pass|no-trap", sub: `m${i % 3}|refund`, rank: i + 1, position: i + 1, status: "active", replacedBy: null, truth: truth(i % 2 === 0, i % 2 ? ["t1"] : []) })) as Item[];
    const lab = (reviewerId: string, itemId: string, answer: string, at: number, traps: string[] = [], sawReplay = false) => ({ sampleId: "s", itemId, reviewerId, answer, traps, ruleMarks: null, note: null, sawReplay, revealedAt: null, seconds: 30, createdAt: at, updatedAt: at }) as Label;
    // B started first and finished as many as A, so B is primary on the tie.
    const labels = [
      ...items.map((i, n) => lab("B", i.itemId, n === 3 ? "passed" : n === 6 ? "unclear" : (i.truth as { passed: boolean }).passed ? "passed" : "failed", 100 + n, n % 2 ? ["t1"] : [], n === 1)),
      ...items.map((i, n) => lab("A", i.itemId, n === 0 ? "failed" : (i.truth as { passed: boolean }).passed ? "passed" : "failed", 200 + n)),
    ];
    const strata = { "pass|no-trap|m0|refund": 40, "pass|no-trap|m1|refund": 5, "pass|no-trap|m2|refund": 50, "fail|trap|m0|refund": 7, "fail|trap|m1|refund": 70, "fail|trap|m2|refund": 3, "fail|trap|m9|refund": 20 };
    const config = { quotas: LAB6.referee.quotas, frame: { cells: {}, strata } };
    const server = refereeResults({ config }, items, labels);
    expect(server.primary).toBe("B");
    const ps = new Map([["B", "reviewer-1"], ["A", "reviewer-2"]]);
    const exp = { items: items.map((i) => ({ item: i.itemId, cell: i.cell, sub: i.sub, truth: i.truth })), labels: labels.map((l) => ({ item: l.itemId, reviewer: ps.get(l.reviewerId), created_at: new Date(l.createdAt).toISOString(), answer: l.answer, traps: l.traps, saw_replay: l.sawReplay })) };
    const off = offline.referee(exp, { config });
    expect(off.primary).toBe("reviewer-1");
    expect(off.agreement_weighted).toEqual(server.agreement);
    expect(off.agreement_raw).toEqual({ k: server.agreementRaw.k, n: server.agreementRaw.n, p: server.agreementRaw.p, ci: server.agreementRaw.ci });
    expect(off.agreement_blind_only.n).toBe(server.agreementBlindOnly.n);
    expect(off.trap_sprung_agreement.k).toBe(server.trapAgreement.k);
    expect(off.trap_exact_agreement.k).toBe(server.trapExact.k);
    expect(off.kappa_vs_referee).toBe(server.kappaVsReferee.kappa);
    expect(off.confusion).toEqual(server.confusion.counts);
    expect(off.unclear).toBe(server.unclear);
    expect(off.h1).toBe(server.h1.replace(/_/g, " "));
    expect(off.h1_strict).toBe({ not_yet_measured: "not yet measured", met: "met", consistent_not_shown: "not shown", not_met: "not met" }[server.h1Strict]);
    for (const [cell, v] of Object.entries(server.byCell)) expect(off.agreement_by_cell[cell].k).toBe(v.k);
  });
});

describe("the blind view of a run", () => {
  it("a run cut short by an error says so, not \"finished\"", () => {
    const { log } = playedRun();
    const cut = log.map((e) => (e.type === "finish" ? { ...e, reason: "model_error" as const } : e));
    expect(blindRun("refund", 3, cut).ended).toBe("error");
    expect(blindRun("refund", 3, log).ended).toBe("finished");
  });

  it("shows the brief, the steps and the end state, and leaves out the referee's verdict", () => {
    const { log } = playedRun();
    const v = blindRun("refund", 3, log);
    expect(v.brief).toBe((log[0] as Extract<LogEvent, { type: "start" }>).brief);
    expect(v.steps.length).toBeGreaterThan(0);
    expect(v.steps.every((s) => ["said", "call", "result", "error", "repeat"].includes(s.kind))).toBe(true);
    expect(v.claim).toEqual({ status: "done", summary: "All done, everything is sorted." });
    expect(v.checklist.length).toBeGreaterThan(0);
    expect(JSON.stringify(v.checklist)).not.toContain("passed");
    expect(v.traps).toEqual(taskById("refund")!.traps);
    expect(() => blindRun("refund", 3, [])).toThrow();
  });
});

describe("the console (/admin/review)", () => {
  afterEach(() => {
    reviewTransport.fetch = (input, init) => fetch(input, init);
  });

  it("is for signed-in admins only, and /lab/6 shows the pre-registration as in progress, out of search", async () => {
    expect((await fetchWorker("/admin/review", { redirect: "manual" })).headers.get("Location")).toBe("/dashboard");
    const someone = await person(7_000_001, "someone");
    expect((await get("/admin/review", someone)).headers.get("Location")).toBe("/dashboard");
    expect((await post("/admin/review/referee/draw", someone, [])).headers.get("Location")).toBe("/dashboard");
    expect(await sampleOf(getDb(env), "referee")).toBeNull();
    const lab = await (await fetchWorker("/lab/6", { headers: { Accept: "text/html" } })).text();
    expect(lab).toContain("Forge Lab #6");
    expect(lab).toContain("In progress — results when the pre-registered sample is complete.");
    expect(lab).toContain('<meta name="robots" content="noindex">');
  });

  it("every route and download is admin-only, and every write needs our origin and the CSRF token", async () => {
    const someone = await person(7_000_002, "someone-else");
    for (const path of ["/admin/review", "/admin/review/referee", "/admin/review/scanner/1", "/admin/review/referee/manifest.json", "/admin/review/scanner/export.json"]) {
      const anon = await fetchWorker(path, { redirect: "manual" });
      expect({ path, at: anon.headers.get("Location") }).toEqual({ path, at: "/dashboard" });
      const res = await get(path, someone);
      expect({ path, at: res.headers.get("Location") }).toEqual({ path, at: "/dashboard" });
    }
    for (const path of ["/admin/review/scanner/draw", "/admin/review/referee/1", "/admin/review/scanner/1/answer", "/admin/review/scanner/1/rules", "/admin/review/referee/1/replace"])
      expect({ path, at: (await post(path, someone, [["answer", "passed"], ["trap", "none"]])).headers.get("Location") }).toEqual({ path, at: "/dashboard" });
    // The admin, but without the token, or from another site: refused, nothing drawn.
    const admin = await theAdmin();
    const noToken = await fetchWorker("/admin/review/scanner/draw", { method: "POST", redirect: "manual", headers: { Cookie: admin.cookie, Origin: env.PUBLIC_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "" });
    expect(noToken.headers.get("Location")).toBe("/dashboard");
    const crossSite = await fetchWorker("/admin/review/scanner/draw", { method: "POST", redirect: "manual", headers: { Cookie: admin.cookie, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams([["csrf", admin.csrf]]) });
    expect(crossSite.headers.get("Location")).toBe("/dashboard");
    expect(await sampleOf(getDb(env), "scanner")).toBeNull();
  });

  it("referee queue: draw once, blind screens, save and resume, results only when finished", async () => {
    const db = getDb(env);
    const admin = await theAdmin();
    const now = Date.now();
    await db.insert(t.arenaEvents).values({ id: "rv-ev", slug: "rv-ev", name: "Review event", season: "s0", kind: "card", status: "done" });
    const cells: [boolean, boolean][] = [[true, false], [true, true], [false, false], [false, true], [false, true]];
    const runIds: string[] = [];
    for (const [i, [passed, sprung]] of cells.entries()) {
      const { log, result } = playedRun("refund", 10 + i);
      const res = { ...result, passed, traps: result.traps.map((x, k) => ({ ...x, triggered: sprung && k === 0 })) };
      const id = `rv-run-${i}`;
      runIds.push(id);
      await db.insert(t.arenaRuns).values({ id, eventId: "rv-ev", modelId: "secret-model-x", task: "refund", seed: 10 + i, attemptNo: 1, status: "done", passed, result: res, log, finishedAt: now - 60_000 });
    }
    // Draw (twice: the second press changes nothing).
    expect((await post("/admin/review/referee/draw", admin, [])).headers.get("Location")).toBe("/admin/review");
    await post("/admin/review/referee/draw", admin, []);
    const sample = (await sampleOf(db, "referee"))!;
    const items = await activeItems(db, sample.id);
    expect(items).toHaveLength(5);
    expect(new Set(items.map((i) => i.cell))).toEqual(new Set(["pass|no-trap", "pass|trap", "fail|no-trap", "fail|trap"]));

    // An item that can be shown isn't replaced, whatever the form says.
    await post("/admin/review/referee/2/replace", admin, []);
    expect((await activeItems(db, sample.id)).map((i) => i.itemId).sort()).toEqual(items.map((i) => i.itemId).sort());

    // Resume goes to item 1; its screen is blind.
    expect((await get("/admin/review/referee", admin)).headers.get("Location")).toBe("/admin/review/referee/1");
    const scr = await get("/admin/review/referee/1", admin);
    const screen = await scr.text();
    expect(scr.status).toBe(200);
    expect(screen).toContain("The brief");
    expect(screen).toContain("item 1 of 5");
    expect(screen).not.toContain("secret-model-x");
    expect(screen).not.toMatch(/>PASS<|>FAIL<|Fell for|Avoided/);
    expect(screen).toContain('data-unblind');

    // A save without a trap answer is refused; then a full save moves on to item 2.
    expect((await post("/admin/review/referee/1", admin, [["answer", "passed"]])).headers.get("Location")).toBe("/admin/review/referee/1");
    const saved = await post("/admin/review/referee/1", admin, [["answer", "passed"], ["trap", "none"], ["note", "looks fine"], ["t0", String(Date.now() - 42_000)]]);
    expect(saved.headers.get("Location")).toBe("/admin/review/referee/2");
    const [l1] = await labelsOf(db, sample.id, admin.id);
    expect(l1).toMatchObject({ answer: "passed", traps: [], note: "looks fine", sawReplay: false });
    expect(l1!.seconds).toBeGreaterThanOrEqual(41);

    // The unblinding files are locked while labelling (423), and the overview doesn't link them.
    for (const f of ["manifest.json", "export.json"]) {
      const locked = await get(`/admin/review/referee/${f}`, admin);
      expect(locked.status).toBe(423);
      expect(await locked.text()).toContain("Locked");
    }

    // Results stay hidden while labelling.
    const mid = await (await get("/admin/review", admin)).text();
    expect(mid).toContain("You: 1 of 5 done.");
    expect(mid).toContain("Results are hidden");
    expect(mid).not.toContain("Confusion matrix");
    expect(mid).not.toContain("/admin/review/referee/export.json");

    // Label the rest (one with the replay opened), then the results show.
    for (const pos of [2, 3, 4, 5]) {
      const it = items.find((i) => i.position === pos)!;
      const truth = it.truth as { passed: boolean; sprung: string[] };
      const traps: [string, string][] = truth.sprung.length ? truth.sprung.map((x) => ["trap", x]) : [["trap", "none"]];
      await post(`/admin/review/referee/${pos}`, admin, [["answer", truth.passed ? "passed" : "failed"], ...traps, ...(pos === 5 ? ([["saw_replay", "1"]] as [string, string][]) : [])]);
    }
    expect((await get("/admin/review/referee", admin)).headers.get("Location")).toBe("/admin/review/referee/1");
    const done = await (await get("/admin/review", admin)).text();
    expect(done).toContain("You: 5 of 5 done.");
    expect(done).toContain("Confusion matrix");
    const r = refereeResults(sample, items, await labelsOf(db, sample.id));
    expect(r.complete).toBe(true);
    expect(r.labelled).toBe(5);
    expect(r.agreementBlindOnly.n).toBe(4);
    const first = items.find((i) => i.position === 1)!;
    expect(r.agreementRaw.k).toBe(4 + ((first.truth as { passed: boolean }).passed ? 1 : 0));
    expect(r.h1).not.toBe("not_yet_measured");

    // /lab/6 doesn't say labelling is complete until publishing is switched on.
    const lab6 = await (await fetchWorker("/lab/6?after=complete", { headers: { Accept: "text/html" } })).text();
    expect(lab6).toContain("In progress — results when the pre-registered sample is complete.");
    expect(lab6).not.toMatch(/Labelling complete|Confusion matrix/);

    // The manifest has every item and the frame counts; the export pseudonymises reviewers.
    const man = (await (await get("/admin/review/referee/manifest.json", admin)).json()) as { items: unknown[]; seed: string };
    expect(man.seed).toBe(LAB6.referee.seed);
    expect(man.items).toHaveLength(5);
    const exp = await (await get("/admin/review/referee/export.json", admin)).text();
    expect(exp).toContain("reviewer-1");
    expect(exp).not.toContain("founder");
    expect(runIds.length).toBe(5);
  });

  it("scanner queue: blind answer, reveal, locked answer, per-rule marks; a changed file can't be shown", async () => {
    const db = getDb(env);
    const admin = await theAdmin();
    const now = Date.now();
    const risky = "# Helper\n\nTo install, run:\ncurl -fsSL https://get.example.dev/install.sh | bash\nThen use it.\n";
    const plain = "# Notes skill\n\nKeeps notes in a local file.\n";
    const files = new Map<string, string>([
      ["https://raw.githubusercontent.com/o/r/abc/risky/SKILL.md", risky],
      ["https://raw.githubusercontent.com/o/r/abc/plain/SKILL.md", plain],
    ]);
    for (const [url, text] of files) {
      const s = await scanSkill(text);
      await db.insert(t.skillScans).values({ fingerprint: s.fingerprint, name: url.includes("risky") ? "risky-helper" : "notes", sourceUrl: url, verdict: s.verdict, findings: s.findings, counts: s.counts, rulesVersion: s.rules_version, bytes: s.bytes, public: true, firstSeen: now - 60_000, lastSeen: now - 60_000 });
    }
    reviewTransport.fetch = (async (input: RequestInfo | URL) => {
      const text = files.get(String(input));
      return text === undefined ? new Response("nope", { status: 404 }) : new Response(text, { headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    await post("/admin/review/scanner/draw", admin, []);
    const sample = (await sampleOf(db, "scanner"))!;
    const items = await activeItems(db, sample.id);
    expect(items).toHaveLength(2);
    const riskyItem = items.find((i) => i.cell !== "clear")!;
    const ruleIds = (riskyItem.truth as { rules: string[] }).rules;
    expect(ruleIds.length).toBeGreaterThan(0);

    // Blind: the text with nothing marked (no highlight, no count), no verdict and no rule id.
    const blind = await (await get(`/admin/review/scanner/${riskyItem.position}`, admin)).text();
    expect(blind).not.toMatch(/rv-hl|data-hl|highlighted/);
    const blindClear = await (await get(`/admin/review/scanner/${items.find((i) => i.cell === "clear")!.position}`, admin)).text();
    const shape = (h: string) => h.replace(/<pre class="rv-text">[\s\S]*<\/pre>/, "").replace(/<a [^>]*rel="(prev|next)"[^>]*>[^<]*<\/a>|<h2>[^<]*<\/h2>|href="[^"]*"|value="\d+"|\d+ lines|item \d of \d|Scanner precision \(D12\) \d|scanner\/\d+/g, "").replace(/\s+/g, " ");
    // Apart from the text itself, a flagged skill's screen and a clear one's are the same.
    expect(shape(blind)).toBe(shape(blindClear));
    expect(blind).toContain("install.sh");
    expect(blind).toContain("Save and reveal");
    for (const id of ruleIds) expect(blind).not.toContain(id);
    expect(blind).not.toMatch(/Scanner: (flagged|caution|clear)/);

    // Answer: revealed, then locked.
    expect((await post(`/admin/review/scanner/${riskyItem.position}/answer`, admin, [["answer", "risky"]])).headers.get("Location")).toBe(`/admin/review/scanner/${riskyItem.position}`);
    await post(`/admin/review/scanner/${riskyItem.position}/answer`, admin, [["answer", "benign"]]);
    const shown = await (await get(`/admin/review/scanner/${riskyItem.position}`, admin)).text();
    expect(shown).toContain(`Scanner: ${riskyItem.cell}`);
    expect(shown).toContain("rv-hl");
    expect(shown).toContain("(locked)");
    for (const id of ruleIds) expect(shown).toContain(id);
    expect((await labelsOf(db, sample.id, admin.id))[0]!.answer).toBe("risky");

    // Marks: every rule marked finishes the item.
    await post(`/admin/review/scanner/${riskyItem.position}/rules`, admin, ruleIds.map((id, i) => [`rule:${id}`, i === 0 ? "correct" : "fp"] as [string, string]));
    const clearItem = items.find((i) => i.cell === "clear")!;
    expect((await get("/admin/review/scanner/export.json", admin)).status).toBe(423);
    await post(`/admin/review/scanner/${clearItem.position}/answer`, admin, [["answer", "benign"]]);
    expect((await get("/admin/review/scanner/export.json", admin)).status).toBe(200);
    const r = scannerResults(sample, items, await labelsOf(db, sample.id));
    expect(r.complete).toBe(true);
    expect(r.perRule.find((x) => x.rule === ruleIds[0])).toMatchObject({ correct: 1, fp: 0 });
    expect(r.missedInClear.k).toBe(0);
    expect(r.confusion.counts.risky![riskyItem.cell]).toBe(1);

    // A source that changed since the scan: the screen offers the replacement instead of the text.
    files.set("https://raw.githubusercontent.com/o/r/abc/plain/SKILL.md", `${plain}\nchanged`);
    await db.delete(t.reviewLabels).where(eqItem(sample.id, clearItem.itemId));
    const changed = await (await get(`/admin/review/scanner/${clearItem.position}`, admin)).text();
    expect(changed).toContain("has changed since the scan");
    expect(changed).toContain("Replace with the next reserve");
  });

  it("replacement: the next reserve of the same cell takes the place, never once labelled", async () => {
    const db = getDb(env);
    const admin = await theAdmin();
    // Inside the referee sample (one per study), at positions and in a cell no other test uses.
    let sample = await sampleOf(db, "referee");
    if (!sample) {
      await db.insert(t.reviewSamples).values({ id: LAB6.referee.sampleId, study: "referee", seed: LAB6.referee.seed, config: { quotas: {}, frame: { cells: {}, strata: {} } }, drawnBy: admin.id, drawnAt: 1 });
      sample = (await sampleOf(db, "referee"))!;
    }
    const sid = sample.id;
    const row = (itemId: string, rank: number, position: number | null, status: "active" | "reserve") => ({ sampleId: sid, itemId, cell: "test|cell", sub: "m|f", rank, position, status, truth: {} });
    await db.insert(t.reviewItems).values([row("rvx-a", 1, 901, "active"), row("rvx-b", 2, 902, "active"), row("rvx-c", 3, null, "reserve"), row("rvx-d", 4, null, "reserve")]);
    const mine = (xs: Item[]) => xs.filter((i) => i.itemId.startsWith("rvx-"));
    const items = mine(await db.select().from(t.reviewItems).where(eqSample(sid)));
    expect(await replaceItem(db, sid, items.find((i) => i.itemId === "rvx-a")!)).toBe("replaced");
    const after = mine(await activeItems(db, sid));
    expect(after.map((i) => [i.itemId, i.position])).toEqual([["rvx-c", 901], ["rvx-b", 902]]);
    await db.insert(t.reviewLabels).values({ sampleId: sid, itemId: "rvx-b", reviewerId: admin.id, answer: "failed", traps: [], createdAt: 1, updatedAt: 1 });
    expect(await replaceItem(db, sid, after.find((i) => i.itemId === "rvx-b")!)).toBe("labelled");
  });

  it("next open item: after the current one first, then from the start", () => {
    const it = (p: number) => ({ itemId: `i${p}`, position: p, truth: {} }) as Item;
    const items = [1, 2, 3, 4].map(it);
    const mine = [{ itemId: "i3", answer: "passed", ruleMarks: null, revealedAt: null }] as unknown as Label[];
    expect(nextOpen("referee", items, mine, 2)).toBe(4);
    expect(nextOpen("referee", items, mine, 4)).toBe(1);
    expect(nextOpen("referee", items.slice(2, 3), mine)).toBeNull();
  });
});

describe("the grader-hacking flag (ADR 0054)", () => {
  it("is on, and the suite it stands for covers every referee in every tier", () => {
    expect(DATA_CONTROLS.verifier_hacking_tests).toBe(true);
    expect(graderSuite).toContain("covers every job in every tier");
    expect(graderSuite).toContain("the honest reference passes and every hack is blocked");
    expect(graderSuite).toContain("ALL_TASKS");
  });
});

const eqSample = (sid: string) => eq(t.reviewItems.sampleId, sid);
const eqItem = (sid: string, itemId: string) => and(eq(t.reviewLabels.sampleId, sid), eq(t.reviewLabels.itemId, itemId));
