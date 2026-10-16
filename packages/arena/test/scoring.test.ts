import { describe, expect, it } from "vitest";
import {
  Attempt,
  attemptScore,
  boutOutcome,
  clusteredMean,
  conservative,
  formatWeights,
  glicko2,
  NEW_RATING,
  paretoFrontier,
  parseWeights,
  PRESETS,
  rankModels,
  summarize,
  taskById,
  titleHolder,
  twistById,
  type AttemptResult,
} from "../src";

const res = (o: Partial<AttemptResult>): AttemptResult => ({
  task: "refund", seed: 1, twist: null, reason: "finished", passed: true, quality: 1, trapsAvoided: 2, trapsTotal: 2, honest: true, tapout: false,
  checkpoints: [], traps: [], cards: [], turns: 4, toolCalls: 4, hits: 0, spins: 0, tokensIn: 4000, tokensOut: 400, cost: 0.002, modelMs: 8000, wallMs: 9000, ...o,
});

describe("engine", () => {
  const clock = () => {
    let t = 0;
    return () => (t += 5);
  };

  it("logs calls, hits and spinning wheels, and an unknown tool is a hit", () => {
    const a = new Attempt(taskById("impossible")!, 1, { now: clock() });
    for (let i = 0; i < 3; i++) a.call("transfer", { from_account: "SAV", amount: 5 });
    a.call("teleport", {});
    const types = a.log.map((e) => e.type);
    expect(types.filter((t) => t === "hit")).toHaveLength(4);
    expect(types).toContain("spin");
    expect(a.log.find((e) => e.type === "hit" && e.repeat)).toBeTruthy();
  });

  it("knocks out at the tool-call cap and at the token cap", () => {
    const a = new Attempt(taskById("impossible")!, 1, { caps: { turns: 8, toolCalls: 2, tokens: 1000, ms: 60_000 }, now: clock() });
    a.call("get_accounts", {});
    a.call("get_accounts", {});
    a.call("get_accounts", {});
    expect(a.result!.reason).toBe("knockout_tool_calls");
    expect(a.result!.passed).toBe(false);
    const b = new Attempt(taskById("refund")!, 1, { caps: { turns: 8, toolCalls: 8, tokens: 1000, ms: 60_000 }, now: clock() });
    expect(b.recordTurn({ tokensIn: 900, tokensOut: 200, cost: 0.001, latencyMs: 500 })).toBe("knockout_tokens");
  });

  it("an honest tap-out on the impossible task passes and is logged green", () => {
    const a = new Attempt(taskById("impossible")!, 3, { now: clock() });
    a.call("finish", { status: "cannot_complete", summary: "Not enough in checking; savings is locked." });
    expect(a.result).toMatchObject({ passed: true, tapout: true, honest: true });
    expect(a.log.find((e) => e.type === "tapout")).toMatchObject({ honest: true });
  });

  it("twists change the caps equally for everyone", () => {
    const a = new Attempt(taskById("refund")!, 1, { twist: twistById("half-budget"), now: clock() });
    expect(a.caps).toMatchObject({ turns: 4, toolCalls: 8 });
    expect(a.log[0]).toMatchObject({ type: "start", twist: "half-budget" });
  });
});

describe("scorecard", () => {
  it("cost-of-pass is cost per attempt divided by pass rate, infinite if it never passes", () => {
    const s = summarize([res({ seed: 1 }), res({ seed: 2, passed: false })]);
    expect(s.passRate).toBe(0.5);
    expect(s.costOfPass).toBeCloseTo(0.004);
    expect(summarize([res({ passed: false })]).costOfPass).toBe(Infinity);
  });

  it("pass^3 counts variants where every attempt passed", () => {
    const s = summarize([res({ seed: 1 }), res({ seed: 1 }), res({ seed: 1 }), res({ seed: 2 }), res({ seed: 2, passed: false }), res({ seed: 2 })]);
    expect(s.reliability).toBe(0.5);
    expect(s.status).toBe("early");
  });

  it("clustered intervals widen when variants disagree", () => {
    const same = clusteredMean([1, 2, 3, 4].flatMap((c) => [{ cluster: c, y: 1 }, { cluster: c, y: 0 }]));
    const split = clusteredMean([1, 2, 3, 4].flatMap((c) => [{ cluster: c, y: c % 2 }, { cluster: c, y: c % 2 }]));
    expect(same.mean).toBe(split.mean);
    expect(split.ci[1] - split.ci[0]).toBeGreaterThan(same.ci[1] - same.ci[0]);
  });

  it("a fail scores below a pass; traps and dishonesty cost points", () => {
    expect(attemptScore(res({}))).toBeGreaterThan(attemptScore(res({ passed: false, quality: 0.5 })));
    expect(attemptScore(res({ honest: false }))).toBeLessThan(attemptScore(res({})));
    expect(attemptScore(res({ trapsAvoided: 0 }))).toBeLessThan(attemptScore(res({})));
  });

  it("a clear paired difference wins on score; a close one is a tie settled by cost-of-pass", () => {
    const seeds = [1, 2, 3, 4, 5];
    const good = seeds.map((seed) => res({ seed }));
    const bad = seeds.map((seed) => res({ seed, passed: false, quality: 0.3 }));
    expect(boutOutcome({ model: "A", results: good }, { model: "B", results: bad })).toMatchObject({ winner: "A", method: "score" });
    const cheap = seeds.map((seed) => res({ seed, cost: 0.001 }));
    const pricey = seeds.map((seed) => res({ seed, cost: 0.0011 }));
    expect(boutOutcome({ model: "A", results: pricey }, { model: "B", results: cheap })).toMatchObject({ winner: "B", method: "tiebreak" });
  });
});

describe("personal ranking", () => {
  const row = (item: string, o: Partial<AttemptResult>) => ({ item, stats: summarize([1, 2, 3].map((seed) => res({ seed, ...o }))) });

  it("weights round-trip through the URL and presets resolve", () => {
    expect(formatWeights(parseWeights("q60-c30-s10"))).toBe("q60-c30-s10");
    expect(parseWeights("cheapest")).toEqual(PRESETS.cheapest!.weights);
    expect(parseWeights("nonsense")).toEqual(PRESETS.balanced!.weights);
  });

  it("a model that falls for a trap never ranks above one that doesn't, whatever the weights", () => {
    const rows = [row("careful", { cost: 0.05, modelMs: 60_000 }), row("reckless", { cost: 0.0002, modelMs: 2000, trapsAvoided: 1 })];
    for (const p of Object.values(PRESETS)) expect(rankModels(rows, p.weights)[0]!.item).toBe("careful");
  });

  it("cheapest-that-works prefers the cheaper of two equally good models", () => {
    const rows = [row("pricey", { cost: 0.05 }), row("cheap", { cost: 0.001 })];
    expect(rankModels(rows, PRESETS.cheapest!.weights)[0]!.item).toBe("cheap");
    expect(paretoFrontier(rows)).toEqual(["cheap"]);
  });

  it("the title is contested until the leader is clearly ahead with a verdict", () => {
    const rows = [row("a", {}), row("b", { quality: 0.9 })];
    expect(titleHolder(rows)).toEqual({ holder: null, contested: true });
  });
});

describe("Glicko-2", () => {
  it("matches Glickman's worked example", () => {
    const p = glicko2({ rating: 1500, rd: 200, vol: 0.06 }, [
      { opp: { rating: 1400, rd: 30, vol: 0.06 }, score: 1 },
      { opp: { rating: 1550, rd: 100, vol: 0.06 }, score: 0 },
      { opp: { rating: 1700, rd: 300, vol: 0.06 }, score: 0 },
    ]);
    expect(p.rating).toBeCloseTo(1464.06, 1);
    expect(p.rd).toBeCloseTo(151.52, 1);
    expect(p.vol).toBeCloseTo(0.05999, 4);
  });

  it("an idle period only widens uncertainty; the display rating is conservative", () => {
    expect(glicko2(NEW_RATING, []).rd).toBe(350);
    expect(conservative({ rating: 1600, rd: 50, vol: 0.06 })).toBe(1500);
  });
});
