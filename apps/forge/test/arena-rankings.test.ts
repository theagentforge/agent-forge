import { env } from "cloudflare:workers";
import type { AttemptResult } from "@forge/arena";
import { describe, expect, it } from "vitest";
import { CATALOG_KEY, newReleases } from "../src/arena/catalog";
import { computeRankings } from "../src/arena/views";

const res = (seed: number, passed: boolean): AttemptResult => ({
  task: "refund", seed, twist: null, reason: "finished", passed, quality: passed ? 1 : 0.2, trapsAvoided: passed ? 2 : 0, trapsTotal: 2, honest: passed, tapout: false,
  checkpoints: [], traps: [], cards: [], turns: 3, toolCalls: 3, hits: 0, spins: 0, tokensIn: 1000, tokensOut: 100, cost: 0.001, modelMs: 3000, wallMs: 3000,
});

describe("division rankings", () => {
  it("the model that wins its bouts across events rises; the loser falls", () => {
    const event = (winner: string, loser: string) => ({
      results: [1, 2, 3, 4].flatMap((seed) => [
        { model: winner, task: "refund", result: res(seed, true) },
        { model: loser, task: "refund", result: res(seed, false) },
      ]),
    });
    const r = computeRankings([event("alpha", "beta"), event("alpha", "beta")]);
    expect(r.get("alpha")!.rating).toBeGreaterThan(1500);
    expect(r.get("beta")!.rating).toBeLessThan(1500);
    expect(r.get("alpha")!.rd).toBeLessThan(350);
  });
});

describe("release watch", () => {
  it("lists models from the big labs added in the last 8 days", async () => {
    const now = Date.UTC(2026, 9, 20);
    await env.KV.put(CATALOG_KEY, JSON.stringify({ models: [{ id: "openai/new", name: "New", created: now / 1000 - 86400, in: 1, out: 2 }, { id: "google/old", created: now / 1000 - 30 * 86400, in: 1, out: 2 }] }));
    expect(await newReleases(env, now)).toEqual([{ id: "openai/new", name: "New", in: 1, out: 2 }]);
  });
});
